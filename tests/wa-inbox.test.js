// @vitest-environment node
/**
 * BANDEJA DE WHATSAPP — lo que la hace útil de verdad.
 *
 * Aquí se fijan las reglas que hacen que la pantalla sirva para trabajar:
 *   - un cliente que escribe dos veces es UN cliente y UNA conversación;
 *   - la lista va de lo más reciente a lo más antiguo;
 *   - "sin responder" significa que el ÚLTIMO mensaje es del cliente, así que
 *     NO se apaga por abrir o marcar como leída la conversación: solo al contestar.
 * Nada de esto envía mensajes solo: el envío siempre sale de un POST manual.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'clave-bandeja-inbox';
const APP_SECRET = 'app-secreto-inbox';
const WABA = 'WABA1';
const PHONE_A = '18095550001';
const PHONE_B = '18095550002';

let tmpDir;
let app;
let cookie = '';
let conversationA = null;
let conversationB = null;

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN1',
  businessAccountId: WABA,
  sent: [],
  read: [],
  async sendText(to, body, options) {
    mockWhatsApp.sent.push({ to, body, options });
    return { ok: true, status: 200, messageId: `wamid.OUT${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    mockWhatsApp.sent.push({ to, template });
    return { ok: true, status: 200, messageId: `wamid.TPL${mockWhatsApp.sent.length}` };
  },
  async sendInteractive() {
    return { ok: false, skipped: true };
  },
  async markAsRead(messageId) {
    mockWhatsApp.read.push(messageId);
    return { ok: true };
  },
};

const call = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
  });

const json = async (response) => JSON.parse(await response.text());

async function waitFor(check, timeout = 4000) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      /* todavía no está */
    }
    if (Date.now() - start > timeout) throw new Error('timeout: el CRM no terminó el trabajo');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Mensaje entrante firmado como el que manda Meta. */
async function inbound(waId, from, body, name = 'Cliente') {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name }, wa_id: from }],
              messages: [
                { from, id: waId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } },
              ],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  return fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
    },
    body: raw,
  });
}

const listConversations = async () => (await json(await call('/api/admin/conversations'))).conversations;
const adminData = async () => json(await call('/api/admin/data'));

const threadOf = async (id) => json(await call(`/api/admin/conversations/${id}/messages`));

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-inbox-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsappPhoneNumber: '+18095550000',
    whatsapp: mockWhatsApp,
  });
  const login = await call('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('un cliente es un cliente, aunque escriba dos veces', () => {
  it('el primer mensaje crea cliente, conversación y mensaje', async () => {
    expect((await inbound('wamid.A1', PHONE_A, 'Hola')).status).toBe(200);
    conversationA = await waitFor(async () => (await listConversations()).find((row) => row.customer?.phone_e164 === `+${PHONE_A}`));
    expect(conversationA).toBeTruthy();
    expect(conversationA.customer.phone_e164).toBe(`+${PHONE_A}`);
    expect(conversationA.last_message).toMatchObject({ body: 'Hola', direction: 'inbound' });
  });

  it('el segundo mensaje del MISMO teléfono reutiliza el cliente y la conversación', async () => {
    expect((await inbound('wamid.A2', PHONE_A, '¿Cuánto cuesta?')).status).toBe(200);
    await waitFor(async () => (await threadOf(conversationA.id)).messages.length === 2);

    const rows = await listConversations();
    const same = rows.filter((row) => row.customer?.phone_e164 === `+${PHONE_A}`);
    expect(same).toHaveLength(1);
    expect(same[0].id).toBe(conversationA.id);

    const thread = await threadOf(conversationA.id);
    expect(thread.messages.map((message) => message.body)).toEqual(['Hola', '¿Cuánto cuesta?']);
    expect(thread.messages.map((message) => message.direction)).toEqual(['inbound', 'inbound']);
  });

  it('no duplica el mensaje si Meta reintenta el mismo wa_message_id', async () => {
    expect((await inbound('wamid.A2', PHONE_A, '¿Cuánto cuesta?')).status).toBe(200);
    // Señal de que el reintento ya se procesó: llega otro mensaje después.
    await inbound('wamid.A3', PHONE_A, 'Sigo esperando');
    await waitFor(async () => (await threadOf(conversationA.id)).messages.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const thread = await threadOf(conversationA.id);
    expect(thread.messages.filter((message) => message.wa_message_id === 'wamid.A2')).toHaveLength(1);
  });
});

describe('la lista se ordena por lo más reciente', () => {
  it('la conversación con el mensaje más nuevo va primera', async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await inbound('wamid.B1', PHONE_B, 'Hola, otra consulta')).status).toBe(200);
    conversationB = await waitFor(async () => (await listConversations()).find((row) => row.customer?.phone_e164 === `+${PHONE_B}`));

    const rows = await listConversations();
    expect(rows[0].id).toBe(conversationB.id);

    // Y en ningún caso hay una conversación más reciente por debajo de una vieja.
    const times = rows.map((row) => String(row.last_message_at ?? ''));
    expect([...times].sort().reverse()).toEqual(times);
  });
});

describe('"sin responder" es del cliente, no de la insignia de leído', () => {
  it('un mensaje entrante deja la conversación pendiente de respuesta', async () => {
    const rows = await listConversations();
    const row = rows.find((candidate) => candidate.id === conversationB.id);
    expect(row.awaiting_reply).toBe(true);
    expect(row.unread_count).toBe(1);

    // Y aparece en Hoy → sin contestar.
    expect((await adminData()).hoy.sinResponder).toBeGreaterThanOrEqual(1);
  });

  it('abrir y marcar como leída NO la da por contestada', async () => {
    const read = await call(`/api/admin/conversations/${conversationB.id}/read`, { method: 'POST' });
    expect(read.status).toBe(200);

    const rows = await listConversations();
    const row = rows.find((candidate) => candidate.id === conversationB.id);
    expect(row.unread_count).toBe(0); // la insignia se apaga…
    expect(row.awaiting_reply).toBe(true); // …pero sigue pendiente de respuesta

    const data = await adminData();
    const pending = data.conversations.filter((candidate) => candidate.awaiting_reply === true).map((candidate) => candidate.id);
    expect(pending).toContain(conversationB.id);
  });

  it('al responder (envío MANUAL) deja de estar pendiente', async () => {
    mockWhatsApp.sent.length = 0;
    const sent = await call(`/api/admin/conversations/${conversationB.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Claro, te cuento.' }),
    });
    expect(sent.status).toBe(200);
    const body = await json(sent);
    expect(body.message).toMatchObject({ direction: 'outbound', status: 'sent' });
    expect(mockWhatsApp.sent[0]).toMatchObject({ to: `+${PHONE_B}`, body: 'Claro, te cuento.' });

    const rows = await listConversations();
    const row = rows.find((candidate) => candidate.id === conversationB.id);
    expect(row.awaiting_reply).toBe(false);
    expect(row.last_message).toMatchObject({ direction: 'outbound', status: 'sent' });
  });

  it('el hilo queda en orden y con quién escribió cada cosa', async () => {
    const thread = await threadOf(conversationB.id);
    expect(thread.messages.map((message) => message.direction)).toEqual(['inbound', 'outbound']);
    expect(thread.messages[1].status).toBe('sent');
    expect(thread.canSendFreeText).toBe(true);
  });
});
