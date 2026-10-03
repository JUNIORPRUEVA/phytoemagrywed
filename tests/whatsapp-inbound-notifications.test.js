// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'wa-notifications-token';
const APP_SECRET = 'wa-notifications-secret';
const ADMIN_USER = 'admin-wa@phyto.local';
const ADMIN_PASS = 'AdminWhatsapp-12345';
const AGENT_PASS = 'AgentWhatsapp-12345';

let tmpDir;
let app;
let adminCookie = '';
let mariaCookie = '';
let pedroCookie = '';
let maria;
let pedro;

const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-WA-NOTIFY',
  businessAccountId: 'WABA-WA-NOTIFY',
  async sendText() {
    return { ok: true, status: 200, messageId: 'wamid.OUT-NOTIFY' };
  },
  async sendTemplate() {
    return { ok: true, status: 200, messageId: 'wamid.TPL-NOTIFY' };
  },
  async sendInteractive() {
    return { ok: false, skipped: true };
  },
  async markAsRead() {
    return { ok: true };
  },
};

const json = async (response) => JSON.parse(await response.text());
const request = (route, options = {}, cookie = adminCookie) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {}),
    },
  });

async function login(username, password) {
  const response = await request('/api/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }, '');
  return { response, body: await json(response), cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] };
}

function messageNode({ id, from, name = 'Cliente Push', type = 'text', body = 'Hola' }) {
  const base = { id, from, timestamp: `${Math.floor(Date.now() / 1000)}`, type };
  if (type === 'text') return { ...base, text: { body } };
  if (type === 'image') return { ...base, image: { id: `media-${id}`, mime_type: 'image/jpeg', caption: body } };
  if (type === 'audio') return { ...base, audio: { id: `media-${id}`, mime_type: 'audio/ogg' } };
  if (type === 'location') return { ...base, location: { latitude: 18.48, longitude: -69.9, address: 'Calle privada 123' } };
  return base;
}

async function webhook(payload) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  const response = await request('/api/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': signature },
    body: raw,
  }, '');
  expect(response.status).toBe(200);
}

async function inbound(input) {
  const node = messageNode(input);
  await webhook({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-WA-NOTIFY',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'PN-WA-NOTIFY' },
              contacts: [{ profile: { name: input.name ?? 'Cliente Push' }, wa_id: input.from }],
              messages: [node],
            },
          },
        ],
      },
    ],
  });
}

async function statusWebhook(id, status = 'delivered') {
  await webhook({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA-WA-NOTIFY', changes: [{ field: 'messages', value: { statuses: [{ id, status, timestamp: `${Math.floor(Date.now() / 1000)}` }] } }] }],
  });
}

async function waitFor(check) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > 4000) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function notifications(cookie = adminCookie) {
  return (await json(await request('/api/admin/notifications', {}, cookie))).notifications;
}

async function rawNotifications() {
  return app.collections.list('user_notifications', { limit: 500 });
}

async function conversationForPhone(phone) {
  const data = await json(await request('/api/admin/conversations'));
  return data.conversations.find((row) => row.customer?.phone_e164 === `+${phone}`);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-wa-notify-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phyto.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsappPhoneNumber: '+18095550000',
    whatsapp,
    bootstrapAdminUser: ADMIN_USER,
    bootstrapAdminPassword: ADMIN_PASS,
    bootstrapAdminDisplayName: 'Ana Admin',
    schedulerEnabled: false,
  });
  adminCookie = (await login(ADMIN_USER, ADMIN_PASS)).cookie;
  maria = (await json(await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'maria-wa@phyto.local', password: AGENT_PASS, displayName: 'María Agente', role: 'AGENT' }),
  }))).user;
  pedro = (await json(await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'pedro-wa@phyto.local', password: AGENT_PASS, displayName: 'Pedro Agente', role: 'AGENT' }),
  }))).user;
  mariaCookie = (await login('maria-wa@phyto.local', AGENT_PASS)).cookie;
  pedroCookie = (await login('pedro-wa@phyto.local', AGENT_PASS)).cookie;
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('WhatsApp inbound message notifications', () => {
  it('crea notificación interna y push job para mensajes entrantes sin asignar', async () => {
    await request('/api/admin/push-subscriptions', {
      method: 'POST',
      body: JSON.stringify({ endpoint: 'https://push.example/admin', keys: { p256dh: 'p256dh', auth: 'auth' } }),
    });
    const status = await json(await request('/api/admin/push-status'));
    expect(status.push.activeSubscriptions).toBe(1);
    expect(status.push.subscriptions[0].endpoint).toContain('push.example');
    await inbound({ id: 'wamid.NOTIFY-TXT-1', from: '18095550111', name: 'María Pérez', body: 'Hola, quisiera confirmar si mi pedido sale hoy completo por favor' });
    const rows = await waitFor(async () => {
      const list = await notifications();
      return list.filter((row) => row.type === 'WHATSAPP_MESSAGE_RECEIVED' && row.data?.wa_message_id === 'wamid.NOTIFY-TXT-1');
    });
    /*
     * A una conversación SIN ASIGNAR solo se avisa a ADMINISTRACIÓN: nadie más
     * puede atendería (los agentes ya no se asignan conversaciones solos; las
     * piden), así que avisarles sería mandarles a una pantalla bloqueada.
     */
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({
      title: 'Nuevo mensaje · María Pérez',
      body: 'Hola, quisiera confirmar si mi pedido sale hoy completo por favor',
      entity_type: 'conversation',
      status: 'unread',
    });
    expect(rows[0].deep_link).toContain('/admin/?v=whatsapp&conversation=');
    const raw = (await rawNotifications()).filter((row) => row.data?.wa_message_id === 'wamid.NOTIFY-TXT-1');
    const adminNote = raw.find((row) => row.recipient_user_id !== maria.id && row.recipient_user_id !== pedro.id);
    const jobs = await app.collections.list('push_jobs', { limit: 100 });
    expect(jobs.some((row) => row.notification_id === adminNote?.id)).toBe(true);
  });

  it('permite disparar una prueba push del teléfono registrado', async () => {
    await request('/api/admin/push-subscriptions', {
      method: 'POST',
      body: JSON.stringify({ endpoint: 'https://push.example/admin-test', keys: { p256dh: 'p256dh', auth: 'auth' } }),
    });
    const response = await request('/api/admin/push-subscriptions/test', { method: 'POST', body: '{}' });
    const body = await json(response);
    expect(response.status).toBe(200);
    expect(body.push.subscriptions).toBeGreaterThanOrEqual(1);
    expect(body.status.activeSubscriptions).toBeGreaterThanOrEqual(1);
    const jobs = await app.collections.list('push_jobs', { limit: 100 });
    expect(jobs.some((row) => row.notification_id === body.notification.id)).toBe(true);
  });

  it('con la CLAVE del panel el teléfono también queda registrado (antes el push se perdía)', async () => {
    /*
     * El panel se usa con la clave: esa sesión queda como `Panel legacy` y NO
     * tiene usuario, así que el POST devolvía 403 y el teléfono no se registraba
     * nunca (en producción: `activeSubscriptions: 0` con el panel en uso, o sea
     * cero notificaciones push). Ahora se apunta al admin del panel.
     */
    const legacyLogin = await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) }, '');
    expect(legacyLogin.status).toBe(200);
    const legacyCookie = (legacyLogin.headers.get('set-cookie') ?? '').split(';')[0];

    const saved = await request(
      '/api/admin/push-subscriptions',
      {
        method: 'POST',
        body: JSON.stringify({ endpoint: 'https://push.example/clave', keys: { p256dh: 'p256dh', auth: 'auth' } }),
      },
      legacyCookie,
    );
    expect(saved.status).toBe(200);

    const status = await json(await request('/api/admin/push-status', {}, legacyCookie));
    expect(status.push.activeSubscriptions).toBeGreaterThanOrEqual(1);
    expect(status.push.subscriptions.some((row) => row.endpoint.includes('clave'))).toBe(true);

    // Y el aviso de un mensaje entrante SÍ llega a intentarse en ese teléfono.
    await inbound({ id: 'wamid.NOTIFY-CLAVE', from: '18095550188', name: 'Cliente Clave', body: 'Hola desde la clave del panel' });
    await waitFor(async () => (await rawNotifications()).some((row) => row.data?.wa_message_id === 'wamid.NOTIFY-CLAVE'));
    const jobs = await app.collections.list('push_jobs', { limit: 200 });
    expect(jobs.some((row) => String(row.endpoint).includes('clave'))).toBe(true);
  });

  it('es idempotente por wamid y no notifica callbacks de estado', async () => {
    await inbound({ id: 'wamid.NOTIFY-DUP', from: '18095550112', body: 'Mensaje único' });
    await waitFor(async () => (await notifications()).some((row) => row.data?.wa_message_id === 'wamid.NOTIFY-DUP'));
    await inbound({ id: 'wamid.NOTIFY-DUP', from: '18095550112', body: 'Mensaje único' });
    await statusWebhook('wamid.NOTIFY-DUP', 'read');
    const rows = (await rawNotifications()).filter((row) => row.data?.wa_message_id === 'wamid.NOTIFY-DUP');
    const recipients = new Set(rows.map((row) => row.recipient_user_id));
    expect(rows).toHaveLength(recipients.size);
  });

  it('resume multimedia sin exponer dirección ni payload completo', async () => {
    await inbound({ id: 'wamid.NOTIFY-IMG', from: '18095550113', type: 'image', body: 'caption privado' });
    await inbound({ id: 'wamid.NOTIFY-AUD', from: '18095550114', type: 'audio' });
    await inbound({ id: 'wamid.NOTIFY-LOC', from: '18095550115', type: 'location' });
    await waitFor(async () => (await notifications()).some((row) => row.data?.wa_message_id === 'wamid.NOTIFY-LOC'));
    const rows = await notifications();
    expect(rows.find((row) => row.data?.wa_message_id === 'wamid.NOTIFY-IMG')?.body).toBe('Foto');
    expect(rows.find((row) => row.data?.wa_message_id === 'wamid.NOTIFY-AUD')?.body).toBe('Nota de voz');
    expect(rows.find((row) => row.data?.wa_message_id === 'wamid.NOTIFY-LOC')?.body).toBe('Ubicación');
    expect(rows.find((row) => row.data?.wa_message_id === 'wamid.NOTIFY-LOC')?.body).not.toContain('Calle privada');
  });

  it('si está asignada, notifica al responsable y admins, no a otros agentes', async () => {
    await request('/api/admin/push-subscriptions', {
      method: 'POST',
      body: JSON.stringify({ endpoint: 'https://push.example/admin-assigned', keys: { p256dh: 'p256dh', auth: 'auth' } }),
    });
    await inbound({ id: 'wamid.NOTIFY-ASSIGN-1', from: '18095550116', body: 'Primero asignar' });
    const conversation = await waitFor(() => conversationForPhone('18095550116'));
    const assigned = await request(`/api/admin/conversations/${conversation.id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ userId: maria.id }),
    });
    expect(assigned.status).toBe(200);
    await inbound({ id: 'wamid.NOTIFY-ASSIGN-2', from: '18095550116', body: 'Necesito ayuda con mi compra' });
    await waitFor(async () => (await notifications(mariaCookie)).some((row) => row.data?.wa_message_id === 'wamid.NOTIFY-ASSIGN-2'));
    expect((await notifications(adminCookie)).some((row) => row.data?.wa_message_id === 'wamid.NOTIFY-ASSIGN-2')).toBe(true);
    expect((await notifications(mariaCookie)).some((row) => row.data?.wa_message_id === 'wamid.NOTIFY-ASSIGN-2')).toBe(true);
    expect((await notifications(pedroCookie)).some((row) => row.data?.wa_message_id === 'wamid.NOTIFY-ASSIGN-2')).toBe(false);
    const raw = (await rawNotifications()).filter((row) => row.data?.wa_message_id === 'wamid.NOTIFY-ASSIGN-2');
    const adminNote = raw.find((row) => row.recipient_user_id !== maria.id && row.recipient_user_id !== pedro.id);
    const jobs = await app.collections.list('push_jobs', { limit: 200 });
    expect(jobs.some((row) => row.notification_id === adminNote?.id && row.user_id === adminNote?.recipient_user_id)).toBe(true);
  });

  it('no crea notificación por mensajes outbound propios', async () => {
    await inbound({ id: 'wamid.NOTIFY-OUTBOUND-BASE', from: '18095550117', body: 'Quiero información' });
    const conversation = await waitFor(() => conversationForPhone('18095550117'));
    const before = (await rawNotifications()).filter((row) => row.type === 'WHATSAPP_MESSAGE_RECEIVED').length;
    const sent = await request(`/api/admin/conversations/${conversation.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Respuesta del negocio' }),
    });
    expect(sent.status).toBe(200);
    const after = (await rawNotifications()).filter((row) => row.type === 'WHATSAPP_MESSAGE_RECEIVED').length;
    expect(after).toBe(before);
  });
});

describe('WhatsApp notification frontend wiring', () => {
  it('service worker usa deep link de conversación, foco de ventana existente y vibración discreta', () => {
    const sw = readFileSync(path.join(process.cwd(), 'public/admin/sw.js'), 'utf8');
    expect(sw).toContain('payload.conversationId');
    expect(sw).toContain('/admin/?v=whatsapp&conversation=');
    expect(sw).toContain('admin.focus()');
    expect(sw).toContain('admin.navigate(target.href)');
    expect(sw).toContain('vibrate: Array.isArray(payload.vibrate)');
    expect(sw).toContain('/admin/assets/sounds/message-notification.wav');
  });

  it('la app acepta conversation= en deep links y el chip WhatsApp usa Web Push real', () => {
    const appJs = readFileSync(path.join(process.cwd(), 'public/admin/app.js'), 'utf8');
    expect(appJs).toContain("query?.get('conversation') || query?.get('conv')");
    expect(appJs).toContain('async function enableCrmPush()');
    expect(appJs).toContain('registration.pushManager.getSubscription()');
    expect(appJs).toContain('/api/admin/push-status');
    expect(appJs).toContain('/api/admin/push-subscriptions/test');
    expect(appJs).toContain('data-push-enable');
    expect(appJs).toContain('data-push-test');
    expect(appJs).toContain("event.target.closest('#wa-notify')");
    expect(appJs).toContain('enableCrmPush()');
    expect(appJs).toContain("new Audio('/admin/assets/sounds/message-notification.wav')");
    expect(appJs).not.toContain('new Notification(NEGOCIO');
  });
});
