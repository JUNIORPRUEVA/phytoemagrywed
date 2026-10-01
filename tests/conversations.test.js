// @vitest-environment node
/**
 * BANDEJA DE WHATSAPP — conversaciones, hilo y ENVÍO MANUAL.
 *
 * Se comprueba lo que protege al negocio: nada se envía solo, no se escribe a
 * quien pidió no recibir mensajes, fuera de la ventana de 24 h solo salen
 * plantillas aprobadas y un fallo queda registrado con su motivo (sin secretos).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'clave-bandeja-123';
const APP_SECRET = 'app-secreto-bandeja';
const PHONE = '18095557777';

let tmpDir;
let app;
let cookie = '';
let customerId = '';
let conversationId = '';

/** Cliente falso de WhatsApp: anota los envíos y permite forzar un fallo. */
const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN123',
  businessAccountId: 'WABA1',
  sent: [],
  read: [],
  failWith: null,
  async sendText(to, body, options) {
    if (mockWhatsApp.failWith) return { ok: false, status: 400, error: mockWhatsApp.failWith };
    mockWhatsApp.sent.push({ to, body, options, type: 'text' });
    return { ok: true, status: 200, messageId: `wamid.TXT${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    if (mockWhatsApp.failWith) return { ok: false, status: 400, error: mockWhatsApp.failWith };
    mockWhatsApp.sent.push({ to, template, type: 'template' });
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
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timeout: el servidor no terminó el trabajo');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Mensaje entrante como el que manda Meta. */
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
              contacts: [{ profile: { name: 'Ana WhatsApp' }, wa_id: from }],
              messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  return fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-cnv-'));
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

  await inbound('wamid.CNV1', 'Hola, quiero información');
  const conversation = await waitFor(async () => {
    const data = await json(await call('/api/admin/conversations'));
    return data.conversations.find((row) => row.customer?.phone_e164 === '+18095557777') ?? null;
  });
  conversationId = conversation.id;
  customerId = conversation.customer_id;
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('bandeja de entrada', () => {
  it('muestra el cliente, el último mensaje y lo que no se ha leído', async () => {
    const data = await json(await call('/api/admin/conversations'));
    const conversation = data.conversations.find((row) => row.id === conversationId);
    expect(conversation.customer.name).toBe('Ana WhatsApp');
    expect(conversation.customer.phone_e164).toBe('+18095557777');
    expect(conversation.last_message).toMatchObject({ body: 'Hola, quiero información', direction: 'inbound' });
    expect(conversation.unread_count).toBe(1);
  });

  it('el hilo trae los mensajes en orden, distinguiendo quién escribió', async () => {
    const data = await json(await call(`/api/admin/conversations/${conversationId}/messages`));
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]).toMatchObject({ direction: 'inbound', body: 'Hola, quiero información' });
    expect(data.canSendFreeText).toBe(true);
  });

  it('marcar como leída apaga la insignia', async () => {
    const read = await call(`/api/admin/conversations/${conversationId}/read`, { method: 'POST' });
    expect(read.status).toBe(200);
    const data = await json(await call(`/api/admin/conversations/${conversationId}/messages`));
    expect(data.conversation.unread_count).toBe(0);
  });
});

describe('envío manual (con una persona delante)', () => {
  it('envía el texto cuando la conversación está abierta y queda registrado', async () => {
    mockWhatsApp.failWith = null;
    mockWhatsApp.sent.length = 0;
    const response = await call(
      `/api/admin/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify({ body: 'Claro, te cuento: 1 cápsula al día.' }) },
      cookie,
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.message).toMatchObject({ direction: 'outbound', status: 'sent', type: 'text' });
    expect(body.message.wa_message_id).toBe('wamid.TXT1');
    expect(mockWhatsApp.sent[0]).toMatchObject({ to: '+18095557777', type: 'text' });

    // Dos ticks azules para el cliente (no es un mensaje: no cuenta como envío).
    expect(mockWhatsApp.read).toContain('wamid.CNV1');

    // La conversación pasa a manos humanas: ya no es una máquina la que contesta.
    const customer = await json(await call(`/api/admin/customers/${customerId}`));
    expect(customer.customer.automation_state).toBe('HUMAN_ACTIVE');
    expect(customer.conversation.unread_count).toBe(0);
  });

  it('no deja escribir texto libre fuera de la ventana de 24 h', async () => {
    const old = new Date(Date.now() - 3 * 86400000).toISOString();
    await app.collections.update('conversations', conversationId, { last_inbound_at: old });

    const response = await call(
      `/api/admin/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify({ body: '¿Sigues por ahí?' }) },
      cookie,
    );
    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.error).toBe('outside_window');
    expect(mockWhatsApp.sent).toHaveLength(1); // no salió nada nuevo

    // La ventana se reabre sola cuando el cliente escribe otra vez.
    await inbound('wamid.CNV2', 'Sigo aquí');
    await waitFor(async () => {
      const data = await json(await call(`/api/admin/conversations/${conversationId}/messages`));
      return data.canSendFreeText ? true : null;
    });
  });

  it('no envía a un cliente que pidió no recibir mensajes', async () => {
    await call(`/api/admin/customers/${customerId}/opt-out`, { method: 'POST' });
    const response = await call(
      `/api/admin/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify({ body: 'Oferta especial' }) },
      cookie,
    );
    expect(response.status).toBe(409);
    expect((await json(response)).error).toBe('do_not_contact');
    expect(mockWhatsApp.sent).toHaveLength(1);

    await call(`/api/admin/customers/${customerId}/opt-in`, { method: 'POST' });
  });

  it('registra el fallo de WhatsApp con su motivo y sin secretos', async () => {
    mockWhatsApp.failWith = { status: 400, code: 131047, message: 'Re-engagement message' };
    const response = await call(
      `/api/admin/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify({ body: 'Prueba que falla' }) },
      cookie,
    );
    expect(response.status).toBe(502);
    const body = await json(response);
    expect(body.error).toBe('send_failed');
    expect(body.detail.code).toBe(131047);
    expect(JSON.stringify(body)).not.toContain(APP_SECRET);
    expect(JSON.stringify(body)).not.toContain('Bearer');

    const thread = await json(await call(`/api/admin/conversations/${conversationId}/messages`));
    const failed = thread.messages.filter((row) => row.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].error_code).toBe(131047);
    mockWhatsApp.failWith = null;
  });
});

describe('plantillas oficiales', () => {
  it('ninguna plantilla nace aprobada y sin aprobar no se puede enviar', async () => {
    const data = await json(await call('/api/admin/wa-templates'));
    expect(data.templates.length).toBeGreaterThan(0);
    expect(data.templates.every((row) => row.status === 'pending_approval')).toBe(true);
    expect(data.templates.every((row) => row.sendable === false)).toBe(true);

    const blocked = await call(
      `/api/admin/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify({ template: 'phyto_followup_checkin' }) },
      cookie,
    );
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error).toBe('template_not_approved');
  });

  it('cuando el negocio la marca aprobada (tras aprobarla en Meta) sí se envía', async () => {
    const approved = await call('/api/admin/wa-templates', {
      method: 'POST',
      body: JSON.stringify({ name: 'phyto_followup_checkin', status: 'approved', body: 'Hola {{1}}, ¿cómo va todo?' }),
    });
    expect(approved.status).toBe(200);
    expect((await json(approved)).template.sendable).toBe(true);

    mockWhatsApp.sent.length = 0;
    const sent = await call(
      `/api/admin/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify({ template: 'phyto_followup_checkin' }) },
      cookie,
    );
    expect(sent.status).toBe(200);
    const body = await json(sent);
    expect(body.message.type).toBe('template');
    expect(body.message.template_name).toBe('phyto_followup_checkin');
    expect(mockWhatsApp.sent[0]).toMatchObject({ type: 'template' });
  });

  it('una plantilla aprobada sí sale fuera de la ventana de 24 h', async () => {
    const old = new Date(Date.now() - 8 * 86400000).toISOString();
    await app.collections.update('conversations', conversationId, { last_inbound_at: old });
    const response = await call(
      `/api/admin/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify({ template: 'phyto_followup_checkin' }) },
      cookie,
    );
    expect(response.status).toBe(200);
    await app.collections.update('conversations', conversationId, { last_inbound_at: new Date().toISOString() });
  });
});

describe('enviar un seguimiento lo marca como hecho', () => {
  it('al enviar con followupId, la tarea queda completada con su mensaje', async () => {
    const created = await json(
      await call('/api/admin/followups', {
        method: 'POST',
        body: JSON.stringify({ customerId, reason: 'Escribir hoy', scheduledAt: app.followups.today() }),
      }),
    );
    const response = await call(
      `/api/admin/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify({ body: 'Te escribo como quedamos', followupId: created.followup.id }) },
      cookie,
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.followup.status).toBe('completed');
    expect(body.followup.message_id).toBe(body.message.id);
  });
});

describe('ficha completa de una plantilla', () => {
  it('trae los campos que necesita Meta, sin inventarse ninguno', async () => {
    const data = await json(await call('/api/admin/wa-templates'));
    const template = data.templates[0];
    for (const field of ['name', 'language', 'category', 'status', 'body', 'variables', 'buttons']) {
      expect(template).toHaveProperty(field);
    }
    // Estos dos SOLO pueden venir de Meta: nacen vacíos y no se inventan.
    expect(template).toHaveProperty('meta_template_id', null);
    expect(template).toHaveProperty('last_synced_at', null);
    expect(template.sendable).toBe(false);

    // El negocio puede rellenarlos cuando registre la plantilla en Meta.
    const saved = await json(
      await call('/api/admin/wa-templates', {
        method: 'POST',
        body: JSON.stringify({
          name: template.name,
          status: 'approved',
          metaTemplateId: '123456789',
          lastSyncedAt: '2026-09-29T10:00:00.000Z',
          buttons: [{ type: 'QUICK_REPLY', text: 'Sí, ayúdame' }],
        }),
      }),
    );
    expect(saved.template.meta_template_id).toBe('123456789');
    expect(saved.template.last_synced_at).toBe('2026-09-29T10:00:00.000Z');
    expect(saved.template.buttons).toHaveLength(1);
    expect(saved.template.sendable).toBe(true);
  });
});

describe('sin WhatsApp configurado el CRM no se rompe', () => {
  let otherDir;
  let other;

  beforeAll(async () => {
    otherDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-cnv-sin-'));
    other = await startCrmServer({
      port: 0,
      host: '127.0.0.1',
      dataFile: path.join(otherDir, 'phytoemagry.sqlite'),
      token: TOKEN,
      quiet: true,
      whatsappAccessToken: '',
      whatsappPhoneNumberId: '',
    });
  });

  afterAll(async () => {
    await other?.close();
    rmSync(otherDir, { recursive: true, force: true });
  });

  it('el panel lo dice claro y no inventa que envió', async () => {
    const login = await fetch(`${other.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    const otherCookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const withCookie = (route, options = {}) =>
      fetch(`${other.url}${route}`, {
        ...options,
        headers: { 'content-type': 'application/json', cookie: otherCookie, ...(options.headers ?? {}) },
      });

    // Se registra una compra a mano: eso funciona siempre, sin depender de Meta.
    const purchase = await fetch(`${other.url}/api/admin/purchases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: otherCookie },
      body: JSON.stringify({
        phone: '8095558888',
        variantId: 'capsules_5',
        quantity: 1,
        paymentMethod: 'CASH',
        status: 'entregado',
      }),
    });
    expect(purchase.status).toBe(201);

    const data = await (await fetch(`${other.url}/api/admin/data`, { headers: { cookie: otherCookie } })).json();
    expect(data.whatsapp.configured).toBe(false);
    expect(data.customers).toHaveLength(1);

    const conversations = await (await fetch(`${other.url}/api/admin/conversations`, { headers: { cookie: otherCookie } })).json();
    expect(conversations.ok).toBe(true);
  });
});
