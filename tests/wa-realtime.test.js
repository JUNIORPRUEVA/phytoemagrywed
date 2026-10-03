// @vitest-environment node
/**
 * UAT DEL CANAL EN VIVO DEL CHAT (SSE) — «que no haya que esperar».
 *
 * El panel ya no espera al sondeo de 8 segundos para ver un mensaje: el servidor
 * lo EMPUJA por `GET /api/admin/whatsapp/events` en cuanto lo guarda. Aquí se
 * demuestra, contra el servidor de verdad:
 *
 *   - el canal exige sesión (sin cookie no se abre);
 *   - llega un mensaje ENTRANTE (webhook firmado) → aviso `wa.message`;
 *   - se ENVÍA uno desde el panel → aviso `wa.message` con su dirección;
 *   - Meta confirma la entrega → aviso `wa.status`;
 *   - la respuesta viaja SIN BÚFER (`x-accel-buffering: no`): sin eso, nginx
 *     acumula el flujo y los avisos llegarían tarde justo como antes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-realtime-token';
const APP_SECRET = 'uat-realtime-secret';
const PHONE = '18095550777';

let tmpDir;
let app;
let cookie = '';
let controller = null;

const json = async (response) => JSON.parse(await response.text());

/** Webhook firmado de verdad (como el que manda Meta). */
async function webhook(value) {
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA1', changes: [{ field: 'messages', value }] }],
  });
  return fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
    },
    body: raw,
  });
}

const inbound = (id, node) =>
  webhook({
    contacts: [{ profile: { name: 'Ana Tiempo Real' }, wa_id: PHONE }],
    messages: [{ from: PHONE, id, timestamp: String(Math.floor(Date.now() / 1000)), ...node }],
  });

const statusUpdate = (id, status) =>
  webhook({
    statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: PHONE }],
  });

const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT-RT',
  businessAccountId: 'WABA1',
  sent: [],
  async sendText(to, body) {
    whatsapp.sent.push({ to, body });
    return { ok: true, status: 200, messageId: `wamid.RT-OUT${whatsapp.sent.length}` };
  },
  async sendTemplate(to, template) {
    whatsapp.sent.push({ to, template });
    return { ok: true, status: 200, messageId: `wamid.RT-TPL${whatsapp.sent.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-realtime-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsapp,
    schedulerEnabled: false,
  });
  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
});

afterAll(async () => {
  // La conexión en vivo queda abierta: se corta ANTES de apagar el servidor.
  controller?.abort();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('canal en vivo del chat', () => {
  it('sin sesión no se abre', async () => {
    const response = await fetch(`${app.url}/api/admin/whatsapp/events`);
    expect(response.status).toBe(401);
  });

  it('avisa del mensaje entrante, del enviado y del cambio de estado', async () => {
    controller = new AbortController();
    const response = await fetch(`${app.url}/api/admin/whatsapp/events`, {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type') ?? '').toContain('text/event-stream');
    // Sin esta cabecera, nginx guarda el flujo en búfer y los avisos llegan tarde.
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    /** Espera a que el flujo traiga `needle` (los marcos pueden partirse). */
    const esperarMarco = async (needle, label, timeout = 6000) => {
      const limite = Date.now() + timeout;
      for (;;) {
        const corte = buffer.indexOf(needle);
        if (corte !== -1) {
          const fin = buffer.indexOf('\n\n', corte);
          const marco = fin === -1 ? buffer.slice(corte) : buffer.slice(corte, fin + 2);
          if (fin !== -1) buffer = buffer.slice(fin + 2);
          return marco;
        }
        if (Date.now() > limite) throw new Error(`timeout esperando: ${label} · recibido: ${buffer.slice(-200)}`);
        const { value, done } = await reader.read();
        if (done) throw new Error(`el canal se cerró esperando: ${label}`);
        buffer += decoder.decode(value, { stream: true });
      }
    };

    await esperarMarco('event: ready', 'el saludo del canal');

    // 1) MENSAJE ENTRANTE (webhook firmado, como el de Meta).
    await inbound('wamid.RT-IN-1', { type: 'text', text: { body: 'Hola, ¿está disponible?' } });
    const entrante = await esperarMarco('event: wa.message', 'el aviso del mensaje entrante');
    expect(entrante).toContain('"direction":"inbound"');
    // El aviso dice DE QUÉ conversación es, no lo que dijo el cliente: quien
    // escucha pide el hilo (con su permiso) si necesita el contenido.
    expect(entrante).not.toContain('¿está disponible?');

    const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
    const conversation = data.conversations.find((row) => row.customer?.phone_e164 === `+${PHONE}`);
    expect(conversation).toBeTruthy();

    // 2) MENSAJE ENVIADO desde el panel.
    const enviado = await fetch(`${app.url}/api/admin/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Sí, claro que sí' }),
    });
    expect(enviado.status).toBe(200);
    const avisoSaliente = await esperarMarco('event: wa.message', 'el aviso del mensaje enviado');
    expect(avisoSaliente).toContain('"direction":"outbound"');
    expect(avisoSaliente).toContain(`"conversationId":"${conversation.id}"`);

    // 3) META CONFIRMA LA ENTREGA (webhook de estados) → aviso de estado.
    const messageId = (await json(enviado)).message?.wa_message_id ?? whatsapp.sent.at(-1)?.messageId;
    await statusUpdate(messageId, 'delivered');
    const avisoEstado = await esperarMarco('event: wa.status', 'el aviso del cambio de estado');
    expect(avisoEstado).toContain('"status":"delivered"');
    expect(avisoEstado).toContain(`"conversationId":"${conversation.id}"`);
  }, 20000);
});
