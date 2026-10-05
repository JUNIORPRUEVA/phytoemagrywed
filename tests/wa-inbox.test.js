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
import { addDays, dayIn } from '../server/followups.mjs';

const TOKEN = 'clave-bandeja-inbox';
const APP_SECRET = 'app-secreto-inbox';
const WABA = 'WABA1';
const PHONE_A = '18095550001';
const PHONE_B = '18095550002';
const PHONE_C = '18095550003';

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
async function inbound(waId, from, body, name = 'Cliente', timestamp = Math.floor(Date.now() / 1000)) {
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
                { from, id: waId, timestamp: String(timestamp), type: 'text', text: { body } },
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
const listConversationsResponse = async (query) => json(await call(`/api/admin/conversations?${query}`));
const listConversationsQuery = async (query) => (await listConversationsResponse(query)).conversations;
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

  it('filtra por fecha de último mensaje y combina con filtros existentes', async () => {
    const today = dayIn(new Date(), 'America/Santo_Domingo');
    const yesterday = addDays(today, -1);
    await app.collections.update('conversations', conversationA.id, { last_message_at: `${today}T16:00:00.000Z` });
    await app.collections.update('conversations', conversationB.id, { last_message_at: `${yesterday}T16:00:00.000Z` });

    expect((await listConversationsQuery('date=today')).map((row) => row.id)).toEqual([conversationA.id]);
    expect((await listConversationsQuery('date=yesterday')).map((row) => row.id)).toEqual([conversationB.id]);
    expect((await listConversationsQuery('date=7d')).map((row) => row.id)).toEqual([conversationA.id, conversationB.id]);
    const monthIds = (await listConversationsQuery('date=month')).map((row) => row.id);
    expect(monthIds).toContain(conversationA.id);
    if (yesterday.slice(0, 7) === today.slice(0, 7)) expect(monthIds).toContain(conversationB.id);
    else expect(monthIds).not.toContain(conversationB.id);
    expect((await listConversationsQuery(`from=${today}&to=${today}`)).map((row) => row.id)).toEqual([conversationA.id]);
    expect((await listConversationsQuery(`filter=sin-asignar&from=${today}&to=${today}`)).map((row) => row.id)).toEqual([
      conversationA.id,
    ]);

    const invalid = await call(`/api/admin/conversations?from=${today}&to=${yesterday}`);
    expect(invalid.status).toBe(422);
    expect((await call('/api/admin/conversations?date=foobar')).status).toBe(422);
    expect((await call('/api/admin/conversations?from=2026-02-31')).status).toBe(422);
    expect((await call('/api/admin/conversations?to=nope')).status).toBe(422);
  });

  it('usa el timestamp real de Meta y no retrocede con webhooks fuera de orden', async () => {
    const newer = Date.UTC(2026, 8, 30, 18, 30, 1) / 1000;
    const older = Date.UTC(2026, 8, 30, 18, 29, 59) / 1000;
    expect((await inbound('wamid.C-newer', PHONE_C, 'Mensaje nuevo', 'Cliente C', newer)).status).toBe(200);
    const conversationC = await waitFor(async () => (await listConversations()).find((row) => row.customer?.phone_e164 === `+${PHONE_C}`));
    expect(conversationC.last_message_at).toBe('2026-09-30T18:30:01.000Z');

    expect((await inbound('wamid.C-older', PHONE_C, 'Mensaje antiguo retrasado', 'Cliente C', older)).status).toBe(200);
    await waitFor(async () => (await threadOf(conversationC.id)).messages.length === 2);

    const rows = await listConversations();
    const row = rows.find((candidate) => candidate.id === conversationC.id);
    expect(row.last_message_at).toBe('2026-09-30T18:30:01.000Z');
    expect(row.last_message).toMatchObject({ body: 'Mensaje nuevo', at: '2026-09-30T18:30:01.000Z' });
  });

  it('respeta los bordes de hoy y ayer en America/Santo_Domingo', async () => {
    const today = dayIn(new Date(), 'America/Santo_Domingo');
    const yesterday = addDays(today, -1);
    const tomorrow = addDays(today, 1);
    await app.collections.update('conversations', conversationA.id, { last_message_at: `${today}T03:59:59.000Z` });
    await app.collections.update('conversations', conversationB.id, { last_message_at: `${today}T04:00:00.000Z` });

    expect((await listConversationsQuery('date=yesterday')).map((row) => row.id)).toContain(conversationA.id);
    expect((await listConversationsQuery('date=today')).map((row) => row.id)).toContain(conversationB.id);
    expect((await listConversationsQuery('date=today')).map((row) => row.id)).not.toContain(conversationA.id);

    await app.collections.update('conversations', conversationA.id, { last_message_at: `${tomorrow}T03:59:59.000Z` });
    expect((await listConversationsQuery('date=today')).map((row) => row.id)).toContain(conversationA.id);
    expect((await listConversationsQuery(`from=${yesterday}&to=${yesterday}`)).map((row) => row.id)).not.toContain(conversationA.id);
  });

  it('ordena de forma determinista con timestamps iguales y null al final', async () => {
    const now = new Date().toISOString();
    const same = '2026-09-29T12:00:00.000Z';
    const ids = [];
    for (let index = 0; index < 10; index += 1) {
      const customer = {
        id: `cus_sort_${index}`,
        name: `Orden ${index}`,
        phone: `18095559${String(index).padStart(3, '0')}`,
        phone_e164: `+18095559${String(index).padStart(3, '0')}`,
        source: 'test',
        created_at: now,
        updated_at: now,
      };
      const conversation = {
        id: `cnv_sort_${index}`,
        customer_id: customer.id,
        channel: 'whatsapp',
        status: 'AUTOMATIC',
        assigned_user_id: null,
        last_message_at: index < 3 ? null : index < 7 ? same : `2026-09-29T12:00:0${index}.000Z`,
        unread_count: 0,
        created_at: `2026-09-29T10:00:0${index}.000Z`,
        updated_at: `2026-09-29T11:00:0${index}.000Z`,
      };
      ids.push(conversation.id);
      await app.collections.insert('customers', customer);
      await app.collections.insert('conversations', conversation);
    }

    const rows = (await listConversations()).filter((row) => ids.includes(row.id));
    expect(rows.at(-1).last_message_at).toBeNull();
    expect(rows.filter((row) => row.last_message_at === same).map((row) => row.id)).toEqual([
      'cnv_sort_6',
      'cnv_sort_5',
      'cnv_sort_4',
      'cnv_sort_3',
    ]);
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

describe('archivado y acciones masivas de la bandeja', () => {
  it('Clientes/Compraron usa compra entregada, no cualquier intención', async () => {
    await call('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        customerId: conversationB.customer_id,
        items: [{ variantId: 'capsules_5', quantity: 1 }],
        paymentMethod: 'CASH',
        status: 'nuevo',
      }),
    });
    let clients = await json(await call('/api/admin/conversations?filter=clientes'));
    expect(clients.conversations.map((row) => row.id)).not.toContain(conversationB.id);

    await call('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        customerId: conversationB.customer_id,
        items: [{ variantId: 'capsules_10', quantity: 1 }],
        paymentMethod: 'TRANSFER',
        status: 'entregado',
      }),
    });
    clients = await json(await call('/api/admin/conversations?filter=clientes'));
    expect(clients.conversations.map((row) => row.id)).toContain(conversationB.id);
  });

  it('archivar saca la conversación de activos y aparece en Archivados', async () => {
    const archived = await call(`/api/admin/conversations/${conversationA.id}/archive`, { method: 'POST' });
    expect(archived.status).toBe(200);

    const active = await json(await call('/api/admin/conversations'));
    expect(active.conversations.map((row) => row.id)).not.toContain(conversationA.id);
    expect(active.counts.archivados).toBeGreaterThanOrEqual(1);

    const archivedList = await json(await call('/api/admin/conversations?filter=archivados'));
    expect(archivedList.conversations.map((row) => row.id)).toContain(conversationA.id);
  });

  it('un inbound nuevo en archivado lo desarchiva y lo sube con no leído', async () => {
    await inbound('wamid.A4', PHONE_A, 'Volví por aquí');
    await waitFor(async () => {
      const rows = await listConversations();
      const row = rows.find((candidate) => candidate.id === conversationA.id);
      return row && !row.archived_at && Number(row.unread_count) > 0 ? row : null;
    });
    const rows = await listConversations();
    expect(rows[0].id).toBe(conversationA.id);
  });

  it('la acción masiva marca leído y reporta fallos parciales', async () => {
    const result = await json(
      await call('/api/admin/conversations/bulk', {
        method: 'POST',
        body: JSON.stringify({ action: 'mark_read', ids: [conversationA.id, 'cnv_inexistente'] }),
      }),
    );
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);

    const rows = await listConversations();
    expect(rows.find((row) => row.id === conversationA.id).unread_count).toBe(0);
  });

  it('elimina una conversación individual y sus mensajes desde el menú del chat', async () => {
    await inbound('wamid.C1', PHONE_C, 'Quiero limpiar este chat', 'Cliente C');
    const rows = await listConversations();
    const conversationC = rows.find((row) => row.last_message?.body === 'Quiero limpiar este chat');
    expect(conversationC?.id).toBeTruthy();
    expect((await threadOf(conversationC.id)).messages.length).toBeGreaterThan(0);

    const deleted = await call(`/api/admin/conversations/${conversationC.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ ok: true, deleted: true });

    const after = await listConversations();
    expect(after.map((row) => row.id)).not.toContain(conversationC.id);
    const thread = await call(`/api/admin/conversations/${conversationC.id}/messages`);
    expect(thread.status).toBe(404);
  });

  it('mensaje a varios solo valida: excluye opt-out y no envía nada', async () => {
    await call(`/api/admin/customers/${conversationA.customer_id}/opt-out`, { method: 'POST' });
    mockWhatsApp.sent.length = 0;
    const result = await json(
      await call('/api/admin/conversations/bulk', {
        method: 'POST',
        body: JSON.stringify({ action: 'message_preview', ids: [conversationA.id, conversationB.id] }),
      }),
    );
    expect(result.results.find((row) => row.id === conversationA.id).reason).toBe('do_not_contact');
    expect(result.results.find((row) => row.id === conversationB.id).reason).toMatch(/free_text_24h|template_required/);
    expect(mockWhatsApp.sent).toHaveLength(0);
  });
});
