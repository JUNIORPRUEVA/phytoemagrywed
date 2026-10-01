// @vitest-environment node
/**
 * S5 — FOLLOW-UP ENGINE: seguimiento manual y automático + COLA PERSISTENTE de
 * mensajes programados.
 *
 * Lo que se demuestra aquí, que es lo que de verdad importa:
 *   - el plan de postventa es configurable desde Ajustes y crear tareas es
 *     IDEMPOTENTE (marcar dos veces «entregado» no duplica nada),
 *   - un mensaje programado SOBREVIVE a un reinicio del servidor,
 *   - no se envía dos veces el mismo mensaje ni aunque el scheduler vuelva a
 *     pasar por él,
 *   - si al llegar la hora ya no se puede enviar (ventana de 24 h, opt-out,
 *     plantilla sin aprobar) NO se fuerza: queda BLOQUEADO y se avisa a una
 *     persona.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';
import { BLOCK_REASONS, FINAL_SCHEDULED_STATUSES, SCHEDULED_STATUSES } from '../server/scheduler.mjs';
import { normalizeFollowupSettings } from '../server/settings.mjs';
import { DEFAULT_TIME_ZONE, dayIn } from '../server/followups.mjs';

const TOKEN = 'clave-s5-123';
const APP_SECRET = 'secreto-s5';
const PHONE = '18095550404';
const PLAN = [
  { key: 'd1', day: 1, type: 'thanks', reason: 'Gracias', template: 'phyto_purchase_thanks' },
  { key: 'd3', day: 3, type: 'checkin', reason: '¿Cómo va?' },
  { key: 'd21', day: 21, type: 'education', reason: 'Información' },
];

/**
 * «Hoy» tal y como lo entiende el NEGOCIO (`America/Santo_Domingo`), que es como
 * lo entiende el servidor — no el día UTC.
 *
 * Por qué: entre las 20:00 y las 24:00 de RD el día UTC ya es el siguiente, así
 * que `new Date().toISOString().slice(0, 10)` manda la tarea al día de MAÑANA y
 * la pantalla HOY (que usa la zona del negocio) no la ve. El helper es el mismo
 * que usa el motor (`dayIn`) para que no haya dos definiciones de «hoy».
 */
const hoyDelNegocio = () => dayIn(new Date(), DEFAULT_TIME_ZONE);

/** Cliente falso de WhatsApp: anota los envíos y permite forzar un fallo. */
const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN123',
  sent: [],
  failWith: null,
  async sendText(to, body, options) {
    if (mockWhatsApp.failWith) return { ok: false, status: 400, error: mockWhatsApp.failWith };
    mockWhatsApp.sent.push({ to, body, options, type: 'text' });
    return { ok: true, status: 200, messageId: `wamid.SCH${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    if (mockWhatsApp.failWith) return { ok: false, status: 400, error: mockWhatsApp.failWith };
    mockWhatsApp.sent.push({ to, template, type: 'template' });
    return { ok: true, status: 200, messageId: `wamid.SCHT${mockWhatsApp.sent.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

let tmpDir;
let dbFile;
let app;
let cookie = '';
let conversationId = '';
let customerId = '';

const call = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
  });

const json = async (response) => JSON.parse(await response.text());

async function startApp(options = {}) {
  const instance = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: dbFile,
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    followupPlan: PLAN,
    whatsapp: mockWhatsApp,
    schedulerEnabled: false,
    ...options,
  });
  const login = await fetch(`${instance.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  return instance;
}

async function inbound(id, body, from = PHONE) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: 'Luis Seguimiento' }, wa_id: from }],
              messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  await fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
}

/** Espera a que el webhook (que se procesa en segundo plano) haya guardado. */
async function waitForConversation() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const data = await json(await call('/api/admin/conversations'));
    const found = data.conversations.find((row) => row.customer?.phone_e164 === `+${PHONE}`);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('la conversación no apareció');
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-s5-'));
  dbFile = path.join(tmpDir, 'phytoemagry.sqlite');
  app = await startApp();
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  mockWhatsApp.sent = [];
  mockWhatsApp.failWith = null;
});

describe('plan de postventa configurable desde Ajustes', () => {
  it('el plan base es el de casa y los interruptores solo lo filtran', async () => {
    const settings = await json(await call('/api/admin/settings'));
    expect(settings.plan.map((entry) => entry.day)).toEqual([1, 3, 21]);
    expect(settings.followup.enabled).toEqual({ d1: true, d3: true, d21: true });

    const saved = await call('/api/admin/settings/followup', {
      method: 'POST',
      body: JSON.stringify({ enabled: { d1: true, d3: false, d21: true } }),
    });
    const body = await json(saved);
    expect(body.followup.enabled).toEqual({ d1: true, d3: false, d21: true });
    expect(body.plan.map((entry) => entry.key)).toEqual(['d1', 'd21']);

    // Normalización: una clave que no existe en el plan se ignora, no se inventa.
    expect(normalizeFollowupSettings({ enabled: { d1: false, inventado: true } }, PLAN)).toEqual({
      enabled: { d1: false, d3: true, d21: true },
    });
  });

  it('las tareas automáticas de una venta entregada son IDEMPOTENTES', async () => {
    const response = await call('/api/admin/purchases', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Luis Seguimiento',
        phone: PHONE,
        variantId: 'capsules_10',
        quantity: 1,
        paymentMethod: 'CASH',
        status: 'entregado',
      }),
    });
    const body = await json(response);
    customerId = body.customer.id;
    const expected = PLAN.filter((entry) => entry.key !== 'd3').length;
    expect(body.delivered.followups.created).toBe(expected);

    // Volver a marcar entregado (o reiniciar) NO duplica ninguna tarea.
    const again = await call(`/api/admin/items/${body.item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'entregado' }),
    });
    expect(again.status).toBe(200);
    const followups = await json(await call(`/api/admin/customers/${customerId}`));
    expect(followups.followups).toHaveLength(expected);
    expect(new Set(followups.followups.map((row) => row.idempotency_key)).size).toBe(expected);
  });
});

describe('seguimiento manual vinculado a la conversación', () => {
  it('se crea desde el chat y aparece en HOY y en la ficha del cliente', async () => {
    await inbound('wamid.S5-1', 'Hola, tengo una duda');
    const conversation = await waitForConversation();
    conversationId = conversation.id;
    customerId = conversation.customer_id;

    const response = await call('/api/admin/followups', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        conversationId,
        reason: 'Responder consulta de uso',
        // Día de NEGOCIO: es lo que hace que la tarea aparezca en HOY.
        scheduledAt: hoyDelNegocio(),
        idempotencyKey: 'fu:test:consulta',
      }),
    });
    const body = await json(response);
    expect(response.status).toBe(201);
    expect(body.followup.conversation_id).toBe(conversationId);
    expect(body.followup.origin).toBe('manual');

    // Idempotente: el mismo seguimiento no se duplica.
    const repeat = await json(
      await call('/api/admin/followups', {
        method: 'POST',
        body: JSON.stringify({
          customerId,
          conversationId,
          reason: 'Responder consulta de uso',
          scheduledAt: hoyDelNegocio(),
          idempotencyKey: 'fu:test:consulta',
        }),
      }),
    );
    expect(repeat.duplicate).toBe(true);
    expect(repeat.followup.id).toBe(body.followup.id);

    const hoy = await json(await call('/api/admin/followups'));
    expect(hoy.today.some((row) => row.id === body.followup.id)).toBe(true);

    const profile = await json(await call(`/api/admin/customers/${customerId}`));
    expect(profile.followups.some((row) => row.conversation_id === conversationId)).toBe(true);
    expect(profile.nextFollowup).toBeTruthy();
  });

  it('completar y posponer dejan traza en la auditoría', async () => {
    const hoy = await json(await call('/api/admin/followups'));
    const target = hoy.today[0];
    const done = await call(`/api/admin/followups/${target.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'complete' }),
    });
    expect((await json(done)).followup.status).toBe('completed');

    const pospuesto = await call(`/api/admin/followups/${target.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'postpone', days: 3 }),
    });
    expect((await json(pospuesto)).followup.status).toBe('pending');

    const audit = await json(await call('/api/admin/audit?entity=followup'));
    const actions = audit.entries.map((row) => row.action);
    expect(actions).toContain('followup.completed');
    expect(actions).toContain('followup.postponed');
  });
});

describe('cola de mensajes programados', () => {
  const soon = () => new Date(Date.now() + 1000).toISOString();

  it('los estados son los del contrato', () => {
    expect(SCHEDULED_STATUSES).toEqual([
      'SCHEDULED',
      'PROCESSING',
      'SENT',
      'DELIVERED',
      'READ',
      'FAILED',
      'CANCELLED',
      'BLOCKED',
    ]);
    expect(FINAL_SCHEDULED_STATUSES).toContain('BLOCKED');
    expect(BLOCK_REASONS.OUTSIDE_WINDOW).toMatch(/24 h/);
  });

  it('programa, envía UNA vez y no repite aunque el scheduler vuelva a pasar', async () => {
    const created = await call('/api/admin/scheduled', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        conversationId,
        scheduledAt: soon(),
        text: 'Hola, ¿te ayudo con algo?',
        idempotencyKey: 'sm:test:uno',
      }),
    });
    const body = await json(created);
    expect(created.status).toBe(201);
    expect(body.message.status).toBe('SCHEDULED');

    // Idempotencia del propio alta: la misma clave no crea otro mensaje.
    const repeat = await json(
      await call('/api/admin/scheduled', {
        method: 'POST',
        body: JSON.stringify({ customerId, conversationId, scheduledAt: soon(), text: 'Hola', idempotencyKey: 'sm:test:uno' }),
      }),
    );
    expect(repeat.duplicate).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const tick = await app.scheduler.tick();
    expect(tick.sent).toBe(1);
    expect(mockWhatsApp.sent).toHaveLength(1);

    // Segunda pasada: ya está en un estado final, no se vuelve a enviar.
    const second = await app.scheduler.tick();
    expect(second.sent).toBe(0);
    expect(mockWhatsApp.sent).toHaveLength(1);

    const list = await json(await call('/api/admin/scheduled'));
    const row = list.scheduled.find((entry) => entry.idempotency_key === 'sm:test:uno');
    expect(row.status).toBe('SENT');
    expect(row.sent_at).toBeTruthy();
    expect(row.wa_message_id).toBeTruthy();
    // Y quedó como mensaje saliente de ESA conversación.
    const thread = await json(await call(`/api/admin/conversations/${conversationId}/messages`));
    expect(thread.messages.some((message) => message.direction === 'outbound' && message.body === 'Hola, ¿te ayudo con algo?')).toBe(true);
  });

  it('un mensaje programado SOBREVIVE a un reinicio del servidor', async () => {
    const created = await json(
      await call('/api/admin/scheduled', {
        method: 'POST',
        body: JSON.stringify({
          customerId,
          conversationId,
          scheduledAt: soon(),
          text: 'Mensaje que debe sobrevivir al reinicio',
          idempotencyKey: 'sm:test:reinicio',
        }),
      }),
    );
    expect(created.message.status).toBe('SCHEDULED');

    // Reinicio de verdad: se cierra el servidor y se levanta otro con la MISMA base.
    await app.close();
    app = await startApp();
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const tick = await app.scheduler.tick();
    expect(tick.sent).toBe(1);
    expect(mockWhatsApp.sent).toHaveLength(1);
    expect(mockWhatsApp.sent[0].body).toBe('Mensaje que debe sobrevivir al reinicio');

    // Y un reinicio más no lo vuelve a enviar.
    await app.close();
    app = await startApp();
    const after = await app.scheduler.tick();
    expect(after.sent).toBe(0);
    expect(mockWhatsApp.sent).toHaveLength(1);
  });

  it('fuera de la ventana de 24 h NO se fuerza: queda BLOQUEADO y avisa', async () => {
    // Se envejece el último mensaje del cliente: la ventana ya está cerrada.
    await app.collections.update('conversations', conversationId, {
      last_inbound_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const created = await json(
      await call('/api/admin/scheduled', {
        method: 'POST',
        body: JSON.stringify({
          customerId,
          conversationId,
          scheduledAt: soon(),
          text: 'Este texto libre ya no es legal',
          idempotencyKey: 'sm:test:ventana',
        }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await app.scheduler.tick();

    expect(mockWhatsApp.sent).toHaveLength(0);
    const list = await json(await call('/api/admin/scheduled'));
    const row = list.scheduled.find((entry) => entry.id === created.message.id);
    expect(row.status).toBe('BLOCKED');
    expect(row.blocked_reason).toBe('OUTSIDE_WINDOW');
    expect(row.blocked_message).toMatch(/24 h/);

    // Y se creó UNA tarea para que una persona lo vea.
    const profile = await json(await call(`/api/admin/customers/${customerId}`));
    const alertas = profile.followups.filter((entry) => entry.type === 'alert');
    expect(alertas).toHaveLength(1);
    expect(alertas[0].reason).toMatch(/bloqueado/i);

    // Reintentar el tick no duplica la alerta ni envía nada.
    await app.scheduler.tick();
    const after = await json(await call(`/api/admin/customers/${customerId}`));
    expect(after.followups.filter((entry) => entry.type === 'alert')).toHaveLength(1);
  });

  it('fuera de ventana SÍ sale con una plantilla APROBADA', async () => {
    // Sin aprobar: se bloquea y lo dice.
    const blocked = await json(
      await call('/api/admin/scheduled', {
        method: 'POST',
        body: JSON.stringify({
          customerId,
          conversationId,
          scheduledAt: soon(),
          type: 'template',
          template: 'phyto_purchase_thanks',
          idempotencyKey: 'sm:test:tpl-1',
        }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await app.scheduler.tick();
    let list = await json(await call('/api/admin/scheduled'));
    expect(list.scheduled.find((entry) => entry.id === blocked.message.id).blocked_reason).toBe('TEMPLATE_NOT_APPROVED');
    expect(mockWhatsApp.sent).toHaveLength(0);

    // El negocio la aprueba en Meta y la marca aprobada en el CRM: ahora sí sale.
    await call('/api/admin/wa-templates', {
      method: 'POST',
      body: JSON.stringify({ name: 'phyto_purchase_thanks', status: 'approved' }),
    });
    const ok = await json(
      await call('/api/admin/scheduled', {
        method: 'POST',
        body: JSON.stringify({
          customerId,
          conversationId,
          scheduledAt: soon(),
          type: 'template',
          template: 'phyto_purchase_thanks',
          idempotencyKey: 'sm:test:tpl-2',
        }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await app.scheduler.tick();
    list = await json(await call('/api/admin/scheduled'));
    expect(list.scheduled.find((entry) => entry.id === ok.message.id).status).toBe('SENT');
    expect(mockWhatsApp.sent).toHaveLength(1);
    expect(mockWhatsApp.sent[0].type).toBe('template');
  });

  it('el opt-out manda: no se contacta a quien pidió no recibir mensajes', async () => {
    await call(`/api/admin/customers/${customerId}/opt-out`, { method: 'POST', body: '{}' });
    const created = await json(
      await call('/api/admin/scheduled', {
        method: 'POST',
        body: JSON.stringify({
          customerId,
          conversationId,
          scheduledAt: soon(),
          text: 'No debería salir',
          idempotencyKey: 'sm:test:optout',
        }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await app.scheduler.tick();

    expect(mockWhatsApp.sent).toHaveLength(0);
    const list = await json(await call('/api/admin/scheduled'));
    expect(list.scheduled.find((entry) => entry.id === created.message.id).blocked_reason).toBe('DO_NOT_CONTACT');

    // Y al volver a permitir mensajes, se puede enviar otra vez.
    await call(`/api/admin/customers/${customerId}/opt-in`, { method: 'POST', body: '{}' });
  });

  it('se puede CANCELAR un mensaje que todavía no ha salido', async () => {
    const created = await json(
      await call('/api/admin/scheduled', {
        method: 'POST',
        body: JSON.stringify({
          customerId,
          conversationId,
          scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
          text: 'Este se cancela',
          idempotencyKey: 'sm:test:cancelar',
        }),
      }),
    );
    const cancelled = await call(`/api/admin/scheduled/${created.message.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'cancel', reason: 'el cliente ya compró' }),
    });
    const body = await json(cancelled);
    expect(body.message.status).toBe('CANCELLED');

    await app.scheduler.tick();
    expect(mockWhatsApp.sent).toHaveLength(0);
  });

  it('un error de WhatsApp deja el mensaje FALLIDO con su motivo', async () => {
    await app.collections.update('conversations', conversationId, {
      last_inbound_at: new Date().toISOString(),
    });
    mockWhatsApp.failWith = { code: 131026, message: 'Message undeliverable' };
    const created = await json(
      await call('/api/admin/scheduled', {
        method: 'POST',
        body: JSON.stringify({
          customerId,
          conversationId,
          scheduledAt: soon(),
          text: 'Va a fallar',
          idempotencyKey: 'sm:test:fallo',
        }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await app.scheduler.tick();

    const list = await json(await call('/api/admin/scheduled'));
    const row = list.scheduled.find((entry) => entry.id === created.message.id);
    expect(row.status).toBe('FAILED');
    expect(row.error_code).toBe(131026);
    expect(row.error_message).toMatch(/undeliverable/i);

    mockWhatsApp.failWith = null;
    const audit = await json(await call('/api/admin/audit?entity=message'));
    expect(audit.entries.map((entry) => entry.action)).toContain('message.failed');
  });

  it('el resumen cuenta pendientes, bloqueados y fallidos para la pantalla HOY', async () => {
    const summary = await json(await call('/api/admin/data'));
    expect(summary.scheduled.blocked).toBeGreaterThanOrEqual(1);
    expect(summary.scheduled.failed).toBeGreaterThanOrEqual(1);
    expect(summary.scheduled.sent).toBeGreaterThanOrEqual(1);
    expect(summary.settings.followup).toBeTruthy();
  });
});

describe('recuperación tras una caída a mitad de envío', () => {
  afterEach(async () => {
    // Deja el servicio como estaba para el resto de la suite.
    const rows = await app.collections.list('scheduled_messages');
    for (const row of rows) {
      if (row.status === 'PROCESSING') {
        await app.collections.update('scheduled_messages', row.id, { status: 'CANCELLED' });
      }
    }
  });

  it('una fila «Processing» huérfana vuelve a la cola (y puede enviarse)', async () => {
    const created = await json(
      await call('/api/admin/scheduled', {
        method: 'POST',
        body: JSON.stringify({
          customerId,
          conversationId,
          scheduledAt: new Date(Date.now() - 60_000).toISOString(),
          text: 'Huérfano',
          idempotencyKey: 'sm:test:huerfano',
        }),
      }),
    );
    // Simula que el proceso murió justo después de reclamar el trabajo.
    await app.collections.update('scheduled_messages', created.message.id, {
      status: 'PROCESSING',
      processing_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      claimed_token: 'token-perdido',
      attempts: 1,
    });
    const recovered = await app.scheduler.recoverStale();
    expect(recovered).toBeGreaterThanOrEqual(1);
    const row = await app.collections.get('scheduled_messages', created.message.id);
    expect(row.status).toBe('SCHEDULED');
  });
});
