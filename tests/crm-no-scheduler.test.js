// @vitest-environment node
/**
 * TRABAJAR EN LOCAL CONTRA LA BASE DE PRODUCCIÓN SIN DUPLICAR ENVÍOS.
 *
 * Con `PHYTO_CRM_NO_SCHEDULER=1` (que es lo que usa el desarrollo contra la base
 * real) el CRM NO arranca el bucle de mensajes programados: los mensajes se
 * guardan igual, pero los envía el CRM de producción. Sin esto, dos instancias
 * sobre la misma base podrían mandar el mismo mensaje dos veces.
 *
 * Lo que se demuestra:
 *   - con el interruptor puesto, por mucho que pase el tiempo NO se envía nada
 *     solo (el bucle no existe);
 *   - y el mensaje programado es válido: un `tick()` a mano SÍ lo envía, así que
 *     lo único que falta es el automatismo, no es que estuviera roto.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PHYTO_CRM_NO_SCHEDULER = '1';
const { startCrmServer } = await import('../server/crm-server.mjs');

const TOKEN = 'uat-sin-scheduler';
const APP_SECRET = 'secreto-sin-scheduler';
const PHONE = '18095550610';

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-SIN-SCH',
  sent: [],
  async sendText(to, body) {
    mockWhatsApp.sent.push({ to, body, type: 'text' });
    return { ok: true, status: 200, messageId: `wamid.NOSCH${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    mockWhatsApp.sent.push({ to, template, type: 'template' });
    return { ok: true, status: 200, messageId: `wamid.NOSCHT${mockWhatsApp.sent.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

let tmpDir;
let app;
let cookie = '';
let conversationId = '';
let customerId = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
  });
const json = async (response) => JSON.parse(await response.text());

async function inbound(id, body) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: 'Cliente Sin Scheduler' }, wa_id: PHONE }],
              messages: [{ from: PHONE, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  await fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
    },
    body: raw,
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-sin-scheduler-'));
  /*
   * `schedulerIntervalMs` a 1,2 s: si el interruptor no funcionara, el bucle
   * correría y el test lo cazaría enseguida (en vez de esperar 30 s).
   */
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsapp: mockWhatsApp,
    schedulerIntervalMs: 1200,
  });

  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  await inbound('wamid.NOSCH-1', 'Hola, quiero información');
  for (let intento = 0; intento < 80; intento += 1) {
    const data = await json(await call('/api/admin/conversations'));
    const found = data.conversations.find((row) => row.customer?.phone_e164 === `+${PHONE}`);
    if (found) {
      conversationId = found.id;
      customerId = found.customer_id;
      return;
    }
    await sleep(25);
  }
  throw new Error('no se creó la conversación');
}, 30000);

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.PHYTO_CRM_NO_SCHEDULER;
});

describe('PHYTO_CRM_NO_SCHEDULER=1 (local contra la base de producción)', () => {
  it('NO arranca el bucle: un mensaje vencido se queda esperando, no se envía solo', async () => {
    const created = await call('/api/admin/scheduled', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        conversationId,
        scheduledAt: new Date(Date.now() - 5_000).toISOString(),
        text: 'Este mensaje NO debe salir solo desde local',
        idempotencyKey: 'sm:sin-scheduler:uno',
      }),
    });
    const alta = await json(created);
    expect(created.status).toBe(201);
    expect(alta.message.status).toBe('SCHEDULED');

    // Se le da tiempo de sobra a un bucle que, a propósito, no existe.
    await sleep(1800);
    expect(mockWhatsApp.sent).toHaveLength(0);

    const list = await json(await call('/api/admin/scheduled'));
    const row = list.scheduled.find((entry) => entry.id === alta.message.id);
    expect(row.status).toBe('SCHEDULED');
    expect(row.sent_at ?? null).toBe(null);
  }, 20000);

  it('el mensaje es válido: un tick a mano SÍ lo envía (solo faltaba el automatismo)', async () => {
    const tick = await app.scheduler.tick();
    expect(tick.sent).toBe(1);
    expect(mockWhatsApp.sent).toHaveLength(1);
    expect(mockWhatsApp.sent[0].body).toBe('Este mensaje NO debe salir solo desde local');

    const list = await json(await call('/api/admin/scheduled'));
    expect(list.scheduled.find((entry) => entry.idempotency_key === 'sm:sin-scheduler:uno').status).toBe('SENT');
  }, 20000);
});
