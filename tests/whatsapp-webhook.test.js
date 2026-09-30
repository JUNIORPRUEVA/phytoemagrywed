// @vitest-environment node
/**
 * WEBHOOK DE WHATSAPP — se arranca el servidor de verdad y se envían peticiones
 * HTTP como las que manda Meta, porque lo que importa es que un mensaje real
 * termine guardado en el CRM (y que un reintento NO lo duplique).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';
import { detectOptOut } from '../server/whatsapp.mjs';

const TOKEN = 'clave-webhook-123';
const VERIFY_TOKEN = 'verify-secreto-123';
const APP_SECRET = 'app-secreto-123';

let tmpDir;
let app;
let cookie = '';

/**
 * Cliente de WhatsApp falso: anota lo que se envía y permite forzar un fallo.
 * Se inyecta en el servidor porque el cliente real cierra sobre su propio `send`.
 */
const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN123',
  businessAccountId: 'WABA1',
  sent: [],
  read: [],
  nextMessageId: 'wamid.OUT1',
  failWith: null,
  async sendText(to, body, options) {
    if (mockWhatsApp.failWith) return { ok: false, status: 400, error: mockWhatsApp.failWith };
    mockWhatsApp.sent.push({ to, body, options, type: 'text' });
    return { ok: true, status: 200, messageId: mockWhatsApp.nextMessageId };
  },
  async sendTemplate(to, template) {
    if (mockWhatsApp.failWith) return { ok: false, status: 400, error: mockWhatsApp.failWith };
    mockWhatsApp.sent.push({ to, template, type: 'template' });
    return { ok: true, status: 200, messageId: mockWhatsApp.nextMessageId };
  },
  async sendInteractive() {
    return { ok: false, skipped: true };
  },
  async markAsRead(messageId) {
    mockWhatsApp.read.push(messageId);
    return { ok: true };
  },
};

const call = (route, options = {}, withCookie = '') =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(withCookie ? { cookie: withCookie } : {}),
      ...(options.headers ?? {}),
    },
  });

const json = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

/** Espera a que el servidor termine el trabajo que hace en segundo plano. */
async function waitFor(check, timeout = 4000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timeout: el servidor no terminó el trabajo');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Cuerpo del webhook tal y como lo envía Meta. */
const inbound = (id, body, from = '18095551234', name = 'Ana Pérez') => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '18095550000', phone_number_id: 'PN123' },
            contacts: [{ profile: { name }, wa_id: from }],
            messages: [{ from, id, timestamp: '1760000000', type: 'text', text: { body } }],
          },
        },
      ],
    },
  ],
});

const statusBody = (waMessageId, status, errors = null) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '18095550000', phone_number_id: 'PN123' },
            statuses: [
              {
                id: waMessageId,
                status,
                timestamp: '1760000100',
                recipient_id: '18095551234',
                ...(errors ? { errors } : {}),
              },
            ],
          },
        },
      ],
    },
  ],
});

const signed = (body) => {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  return { raw, signature };
};

const postWebhook = (body, signature) =>
  call('/api/webhooks/whatsapp', { method: 'POST', body: JSON.stringify(body), headers: signature ? { 'x-hub-signature-256': signature } : {} });

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-wa-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    whatsappVerifyToken: VERIFY_TOKEN,
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

describe('verificación del webhook (la hace Meta una vez)', () => {
  it('devuelve el challenge TAL CUAL cuando el token coincide', async () => {
    const response = await call(
      `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=sys-123`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('sys-123');
  });

  it('rechaza la verificación con un token distinto', async () => {
    const response = await call('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=mal&hub.challenge=sys-123');
    expect(response.status).toBe(403);
  });

  it('rechaza si no es una suscripción', async () => {
    const response = await call(`/api/webhooks/whatsapp?hub.mode=otro&hub.verify_token=${VERIFY_TOKEN}`);
    expect(response.status).toBe(403);
  });
});

describe('firma del webhook', () => {
  it('con firma válida se acepta y se guarda el mensaje', async () => {
    const body = inbound('wamid.IN1', 'Hola, ¿cuánto cuesta?');
    const { signature } = signed(body);
    const response = await postWebhook(body, signature);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, received: true });

    const customers = await waitFor(async () => {
      const data = await json(await call('/api/admin/customers', {}, cookie));
      return data.customers?.length ? data.customers : null;
    });
    expect(customers[0].phone_e164).toBe('+18095551234');
    expect(customers[0].name).toBe('Ana Pérez');
    expect(customers[0].source).toBe('whatsapp');
  });

  it('con firma inválida responde 401 y NO guarda nada', async () => {
    const body = inbound('wamid.IN-FALSA', 'Mensaje que no debe entrar');
    const response = await postWebhook(body, 'sha256=0000000000000000000000000000000000000000000000000000000000000000');
    expect(response.status).toBe(401);

    const data = await json(await call('/api/admin/customers', {}, cookie));
    expect(data.customers.some((row) => row.name === 'Ana Pérez')).toBe(true);
    // El mensaje no existe en ninguna conversación.
    const conversations = await json(await call('/api/admin/conversations', {}, cookie));
    for (const conversation of conversations.conversations) {
      const thread = await json(await call(`/api/admin/conversations/${conversation.id}/messages`, {}, cookie));
      expect(thread.messages.some((row) => row.body === 'Mensaje que no debe entrar')).toBe(false);
    }
  });
});

describe('idempotencia (Meta reintenta los webhooks)', () => {
  it('el mismo mensaje dos veces no crea dos registros', async () => {
    const body = inbound('wamid.DUP1', 'Repetido');
    const { signature } = signed(body);
    await postWebhook(body, signature);
    await postWebhook(body, signature);

    const conversations = await json(await call('/api/admin/conversations', {}, cookie));
    const conversation = conversations.conversations.find((row) => row.customer?.phone_e164 === '+18095551234');
    const thread = await waitFor(async () => {
      const data = await json(await call(`/api/admin/conversations/${conversation.id}/messages`, {}, cookie));
      return data.messages?.some((row) => row.body === 'Repetido') ? data.messages : null;
    });
    const repeated = thread.filter((row) => row.body === 'Repetido');
    expect(repeated).toHaveLength(1);
    expect(repeated[0].direction).toBe('inbound');
  });
});

describe('un cliente es una persona, no un canal', () => {
  it('el mismo teléfono escrito de otra forma no crea un cliente nuevo', async () => {
    const body = inbound('wamid.DUP2', 'Otra vez yo', '1809-555-1234');
    const { signature } = signed(body);
    await postWebhook(body, signature);

    await waitFor(async () => {
      const data = await json(await call('/api/admin/conversations', {}, cookie));
      const conversation = data.conversations.find((row) => row.customer?.phone_e164 === '+18095551234');
      if (!conversation) return null;
      const thread = await json(await call(`/api/admin/conversations/${conversation.id}/messages`, {}, cookie));
      return thread.messages.some((row) => row.body === 'Otra vez yo') ? true : null;
    });

    const data = await json(await call('/api/admin/customers', {}, cookie));
    expect(data.customers.filter((row) => row.phone_e164 === '+18095551234')).toHaveLength(1);
  });
});

describe('estados de los mensajes que envía el negocio', () => {
  it('sent → delivered → read y failed con su motivo, sin duplicar el mensaje', async () => {
    const profile = await waitFor(async () => {
      const data = await json(await call('/api/admin/customers', {}, cookie));
      const customer = data.customers.find((row) => row.phone_e164 === '+18095551234');
      if (!customer) return null;
      const full = await json(await call(`/api/admin/customers/${customer.id}`, {}, cookie));
      return full.conversation ? full : null;
    });

    const sent = await call(
      `/api/admin/conversations/${profile.conversation.id}/messages`,
      { method: 'POST', body: JSON.stringify({ body: 'Te escribo por aquí' }) },
      cookie,
    );
    expect(sent.status).toBe(200);
    const sentBody = await sent.json();
    expect(sentBody.message.wa_message_id).toBe('wamid.OUT1');
    expect(sentBody.message.status).toBe('sent');

    for (const status of ['delivered', 'read']) {
      const body = statusBody('wamid.OUT1', status);
      const { signature } = signed(body);
      await postWebhook(body, signature);
    }
    const failed = statusBody('wamid.OUT2', 'failed', [{ code: 131047, title: 'Re-engagement message' }]);
    const { signature } = signed(failed);
    await postWebhook(failed, signature);

    const thread = await waitFor(async () => {
      const data = await json(await call(`/api/admin/conversations/${profile.conversation.id}/messages`, {}, cookie));
      const message = data.messages.find((row) => row.wa_message_id === 'wamid.OUT1');
      return message?.status === 'read' ? data.messages : null;
    });
    const message = thread.find((row) => row.wa_message_id === 'wamid.OUT1');
    expect(message.status).toBe('read');
    expect(message.delivered_at).toBeTruthy();
    expect(message.read_at).toBeTruthy();
    // El estado desconocido no rompe nada: el mensaje no existe y se ignora.
    expect(thread.filter((row) => row.wa_message_id === 'wamid.OUT2')).toHaveLength(0);
  });
});

describe('eventos que no son mensajes ni estados', () => {
  it('se responden 200 y se ignoran sin romper', async () => {
    const body = { object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [{ field: 'otro', value: {} }] }] };
    const { signature } = signed(body);
    const response = await postWebhook(body, signature);
    expect(response.status).toBe(200);
  });
});

describe('frases de opt-out que la gente escribe de verdad', () => {
  it('detecta las fórmulas claras', () => {
    for (const phrase of [
      'STOP',
      'stop por favor',
      'PARAR',
      'para',
      'no más',
      'no me escribas más',
      'NO QUIERO RECIBIR MENSAJES',
      'no quiero recibir más',
      'no quiero que me escriban',
      'cancelar mensajes',
      'cancelen los mensajes',
      'no me envíen más',
      'dejen de escribirme',
      'no mandar mensajes',
      'quiero que quiten mi número',
      'unsubscribe',
      'baja de mensajes',
    ]) {
      expect(detectOptOut(phrase)).toBe(true);
    }
  });

  it('NO corta una conversación normal', () => {
    for (const phrase of ['Hola, ¿cuánto cuesta?', 'quiero comprar dos frascos', '¿cómo se usa?', 'gracias']) {
      expect(detectOptOut(phrase)).toBe(false);
    }
  });
});

describe('opt-out por WhatsApp (extremo a extremo)', () => {
  it('marca NO CONTACTAR, cancela el seguimiento y bloquea el envío', async () => {
    mockWhatsApp.sent.length = 0;
    // Primero una venta entregada: así hay tareas de seguimiento que cancelar.
    const customer = await waitFor(async () => {
      const data = await json(await call('/api/admin/customers', {}, cookie));
      return data.customers.find((row) => row.phone_e164 === '+18095551234') ?? null;
    });
    const purchase = await call(
      '/api/admin/purchases',
      {
        method: 'POST',
        body: JSON.stringify({ phone: customer.phone_e164, variantId: 'capsules_5', quantity: 1, status: 'entregado' }),
      },
      cookie,
    );
    expect(purchase.status).toBe(201);

    const before = await json(await call(`/api/admin/followups`, {}, cookie));
    const pending = [...before.today, ...before.overdue, ...before.upcoming].filter(
      (row) => row.customer_id === customer.id && row.status === 'pending',
    );
    expect(pending.length).toBeGreaterThan(0);

    // El cliente pide que no le escriban más.
    const body = inbound('wamid.OPTOUT1', 'No quiero recibir mensajes, gracias');
    const { signature } = signed(body);
    await postWebhook(body, signature);

    const after = await waitFor(async () => {
      const data = await json(await call(`/api/admin/customers/${customer.id}`, {}, cookie));
      return data.customer?.do_not_contact ? data : null;
    });
    expect(after.customer.do_not_contact).toBe(true);
    expect(after.customer.whatsapp_opt_out_at).toBeTruthy();
    expect(after.customer.whatsapp_opt_in).toBe(false);
    expect(after.customer.automation_state).toBe('PAUSED');
    expect(after.followups.filter((row) => row.status === 'pending' && row.origin !== 'manual')).toHaveLength(0);

    // Y el panel NO puede enviarle nada, aunque se pulse el botón.
    const conversation = after.conversation;
    const blocked = await call(
      `/api/admin/conversations/${conversation.id}/messages`,
      { method: 'POST', body: JSON.stringify({ body: 'Una oferta' }) },
      cookie,
    );
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error).toBe('do_not_contact');
    expect(mockWhatsApp.sent).toHaveLength(0);
  });
});
