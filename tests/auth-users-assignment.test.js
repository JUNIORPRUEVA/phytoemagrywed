// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';
import { dayIn } from '../server/followups.mjs';

const TOKEN = 'clave-auth-multiuser';
const APP_SECRET = 'secreto-auth-multiuser';
const ADMIN_USER = 'ana@phyto.local';
const ADMIN_PASS = 'AnaAdmin-12345';
const AGENT_PASS = 'MariaAgent-12345';
const PEDRO_PASS = 'PedroAgent-12345';
const PHONE = '18095551234';

let tmpDir;
let app;
let adminCookie = '';
let mariaCookie = '';
let pedroCookie = '';
let maria = null;
let pedro = null;
let delivery = null;
let conversation = null;

const sent = [];
const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-AUTH',
  businessAccountId: 'WABA-AUTH',
  async sendText(to, body) {
    sent.push({ to, body });
    return { ok: true, status: 200, messageId: `wamid.AUTH${sent.length}` };
  },
  async sendTemplate(to, template) {
    sent.push({ to, template });
    return { ok: true, status: 200, messageId: `wamid.TPL${sent.length}` };
  },
  async sendLocation(to, location) {
    sent.push({ to, location });
    return { ok: true, status: 200, messageId: `wamid.LOC${sent.length}` };
  },
  async sendInteractive() {
    return { ok: false, skipped: true };
  },
  async markAsRead() {
    return { ok: true };
  },
};

const request = (route, options = {}, cookie = adminCookie) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
  });

const body = async (response) => JSON.parse(await response.text());

async function login(username, password) {
  const response = await request('/api/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }, '');
  return { response, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0], body: await body(response) };
}

async function inbound(id, from, text) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-AUTH',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: 'Cliente Auth' }, wa_id: from }],
              messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
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

async function waitFor(check) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > 4000) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-auth-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsapp,
    bootstrapAdminUser: ADMIN_USER,
    bootstrapAdminPassword: ADMIN_PASS,
    bootstrapAdminDisplayName: 'Ana Admin',
  });
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('multiusuario, auth y asignación', () => {
  it('sincroniza el admin bootstrap aunque el usuario ya exista con otra contraseña', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'phyto-bootstrap-sync-'));
    const dataFile = path.join(dir, 'phytoemagry.sqlite');
    let first = null;
    let second = null;
    try {
      first = await startCrmServer({
        port: 0,
        host: '127.0.0.1',
        dataFile,
        token: TOKEN,
        quiet: true,
        bootstrapAdminUser: 'junior@phyto.local',
        bootstrapAdminPassword: 'Clave-Vieja-12345',
        bootstrapAdminDisplayName: 'Junior Viejo',
      });
      await first.close();

      second = await startCrmServer({
        port: 0,
        host: '127.0.0.1',
        dataFile,
        token: TOKEN,
        quiet: true,
        bootstrapAdminUser: 'junior@phyto.local',
        bootstrapAdminPassword: 'Clave-Nueva-12345',
        bootstrapAdminDisplayName: 'Junior Nuevo',
      });

      const response = await fetch(`${second.url}/api/admin/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'junior@phyto.local', password: 'Clave-Nueva-12345' }),
      });
      const data = await body(response);
      expect(response.status).toBe(200);
      expect(data.user).toMatchObject({ username: 'junior@phyto.local', display_name: 'Junior Nuevo', role: 'ADMIN' });
    } finally {
      await first?.close?.();
      await second?.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('si falta la contraseña bootstrap usa la clave del panel para ese usuario', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'phyto-bootstrap-token-'));
    let local = null;
    try {
      local = await startCrmServer({
        port: 0,
        host: '127.0.0.1',
        dataFile: path.join(dir, 'phytoemagry.sqlite'),
        token: TOKEN,
        quiet: true,
        bootstrapAdminUser: 'junior@phyto.local',
        bootstrapAdminDisplayName: 'Junior Token',
      });
      const response = await fetch(`${local.url}/api/admin/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'junior@phyto.local', password: TOKEN }),
      });
      const data = await body(response);
      expect(response.status).toBe(200);
      expect(data.user).toMatchObject({ username: 'junior@phyto.local', display_name: 'Junior Token', role: 'ADMIN' });
    } finally {
      await local?.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rechaza ruta privada sin sesión y login incorrecto sin enumerar usuarios', async () => {
    expect((await request('/api/admin/data', {}, '')).status).toBe(401);
    const wrong = await login('nadie@phyto.local', 'contraseña-mala');
    expect(wrong.response.status).toBe(401);
    expect(wrong.body.error).toBe('invalid_credentials');
  });

  it('ADMIN inicia sesión, crea agentes y nunca expone password_hash', async () => {
    const admin = await login(ADMIN_USER, ADMIN_PASS);
    expect(admin.response.status).toBe(200);
    adminCookie = admin.cookie;
    expect(admin.body.user).toMatchObject({ username: ADMIN_USER, role: 'ADMIN' });
    expect(JSON.stringify(admin.body)).not.toContain('password_hash');

    const createdMaria = await body(await request('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'maria@phyto.local',
        password: AGENT_PASS,
        displayName: 'María <script>',
        role: 'AGENT',
      }),
    }));
    maria = createdMaria.user;
    expect(maria.role).toBe('AGENT');
    expect(JSON.stringify(createdMaria)).not.toContain('password_hash');

    const createdPedro = await body(await request('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'pedro@phyto.local',
        password: PEDRO_PASS,
        displayName: 'Pedro',
        role: 'AGENT',
      }),
    }));
    pedro = createdPedro.user;

    const createdDelivery = await body(await request('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'delivery@phyto.local',
        password: 'Delivery-12345',
        displayName: 'Delivery',
        role: 'DELIVERY',
      }),
    }));
    delivery = createdDelivery.user;
    expect(delivery.role).toBe('DELIVERY');
  });

  it('AGENT no administra usuarios y el último ADMIN queda protegido', async () => {
    const loginMaria = await login('maria@phyto.local', AGENT_PASS);
    mariaCookie = loginMaria.cookie;
    expect(loginMaria.body.user.role).toBe('AGENT');

    const forbidden = await request('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'otro@phyto.local', password: 'OtroAgent-12345', displayName: 'Otro', role: 'AGENT' }),
    }, mariaCookie);
    expect(forbidden.status).toBe(403);

    const users = (await body(await request('/api/admin/users'))).users;
    const ana = users.find((user) => user.username === ADMIN_USER);
    const demote = await request(`/api/admin/users/${ana.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'AGENT' }),
    });
    expect(demote.status).toBe(409);
    expect((await body(demote)).error).toBe('last_admin');
  });

  it('logout invalida sesión', async () => {
    const pedroLogin = await login('pedro@phyto.local', PEDRO_PASS);
    pedroCookie = pedroLogin.cookie;
    expect((await request('/api/admin/auth/logout', { method: 'POST' }, pedroCookie)).status).toBe(200);
    expect((await request('/api/admin/data', {}, pedroCookie)).status).toBe(401);
    pedroCookie = (await login('pedro@phyto.local', PEDRO_PASS)).cookie;
  });

  it('tomar conversación es atómico: un agente gana y el otro recibe conflicto', async () => {
    expect((await inbound('wamid.AUTH1', PHONE, 'Hola')).status).toBe(200);
    conversation = await waitFor(async () => {
      const rows = (await body(await request('/api/admin/conversations'))).conversations;
      return rows.find((row) => row.customer?.phone_e164 === `+${PHONE}`);
    });
    const [a, b] = await Promise.all([
      request(`/api/admin/conversations/${conversation.id}/take`, { method: 'POST', body: '{}' }, mariaCookie),
      request(`/api/admin/conversations/${conversation.id}/take`, { method: 'POST', body: '{}' }, pedroCookie),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 403]);
    const latest = (await body(await request(`/api/admin/conversations/${conversation.id}/messages`, {}, adminCookie))).conversation;
    expect([maria.id, pedro.id]).toContain(latest.assigned_user_id);
  });

  it('NO ADMIN queda bloqueado en datos sensibles, eliminación y ajustes', async () => {
    const customerId = conversation.customer.id;

    expect((await request('/api/admin/settings', {}, mariaCookie)).status).toBe(403);
    expect((await request('/api/admin/reports/sales?period=hoy', {}, mariaCookie)).status).toBe(403);

    const inventoryResponse = await request('/api/admin/inventory', {}, mariaCookie);
    const inventory = await body(inventoryResponse);
    expect(inventoryResponse.status).toBe(200);
    expect(JSON.stringify(inventory)).not.toMatch(/cost|profit|margin/i);

    const dataResponse = await request('/api/admin/data', {}, mariaCookie);
    const data = await body(dataResponse);
    expect(dataResponse.status).toBe(200);
    expect(JSON.stringify(data.items)).not.toMatch(/cost|profit|margin/i);
    expect(data.auth.permissions).toContain('chats.take_unassigned');
    expect(data.auth.permissions).not.toContain('users.manage');

    const deleteCustomer = await request(`/api/admin/customers/${customerId}`, { method: 'DELETE' }, mariaCookie);
    expect(deleteCustomer.status).toBe(403);

    const createdFollowup = await request('/api/admin/followups', {
      method: 'POST',
      body: JSON.stringify({ customerId, reason: 'Llamar mañana', scheduledAt: '2026-10-02' }),
    }, mariaCookie);
    expect(createdFollowup.status).toBe(201);
    const followup = (await body(createdFollowup)).followup;

    const cancelFollowup = await request(`/api/admin/followups/${followup.id}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'cancel' }),
    }, mariaCookie);
    expect(cancelFollowup.status).toBe(403);

    const deleteFollowup = await request(`/api/admin/followups/${followup.id}`, { method: 'DELETE' }, mariaCookie);
    expect(deleteFollowup.status).toBe(403);

    const completeFollowup = await request(`/api/admin/followups/${followup.id}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'complete' }),
    }, mariaCookie);
    expect(completeFollowup.status).toBe(200);
  });

  it('solo ADMIN puede anular una venta y deja auditoría de caja e inventario', async () => {
    const deliveryLogin = await login('delivery@phyto.local', 'Delivery-12345');
    const sale = await body(
      await request('/api/admin/orders', {
        method: 'POST',
        body: JSON.stringify({
          customerId: conversation.customer.id,
          items: [{ variantId: 'capsules_5', quantity: 1 }],
          paymentMethod: 'TRANSFER',
          status: 'entregado',
        }),
      }),
    );

    const denied = await request(
      `/api/admin/orders/${sale.item.id}/cancel`,
      { method: 'POST', body: JSON.stringify({ reason: 'No autorizado' }) },
      deliveryLogin.cookie,
    );
    expect(denied.status).toBe(403);

    const cancelled = await request(`/api/admin/orders/${sale.item.id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Cliente pidió anulación' }),
    });
    const cancelledBody = await body(cancelled);
    expect(cancelled.status).toBe(200);
    expect(cancelledBody.order.status).toBe('cancelado');
    expect(cancelledBody.order.payment_status).toBe('void');
    expect(cancelledBody.order.cancel_reason).toBe('Cliente pidió anulación');

    const audit = await body(await request('/api/admin/audit?entity=sale&limit=10'));
    expect(audit.entries.some((row) => row.action === 'sale.cancelled' && row.actor === 'Ana Admin')).toBe(true);
  });

  it('RBAC de etapas y etiquetas separa operación de administración', async () => {
    const customerId = conversation.customer.id;

    const interested = await request(`/api/admin/customers/${customerId}/stage`, {
      method: 'POST',
      body: JSON.stringify({ stage: 'INTERESTED', reason: 'Lo pidió en chat' }),
    }, mariaCookie);
    expect(interested.status).toBe(200);
    expect((await body(interested)).to).toBe('INTERESTED');

    const inactive = await request(`/api/admin/customers/${customerId}/stage`, {
      method: 'POST',
      body: JSON.stringify({ stage: 'INACTIVE', reason: 'No corresponde' }),
    }, mariaCookie);
    expect(inactive.status).toBe(403);

    const createTagDenied = await request('/api/admin/customer-tags', {
      method: 'POST',
      body: JSON.stringify({ label: 'Solo admin', color: '#111111' }),
    }, mariaCookie);
    expect(createTagDenied.status).toBe(403);

    const tags = await body(await request('/api/admin/customer-tags'));
    const first = tags.tags[0];
    const assigned = await request(`/api/admin/customers/${customerId}/tags`, {
      method: 'POST',
      body: JSON.stringify({ tagId: first.id }),
    }, mariaCookie);
    expect(assigned.status).toBe(200);
  });

  it('ADMIN reasigna, filtros Míos/Sin asignar responden y auditoría registra actor', async () => {
    const response = await request(`/api/admin/conversations/${conversation.id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ userId: pedro.id }),
    });
    expect(response.status).toBe(200);
    const today = dayIn(new Date(), 'America/Santo_Domingo');
    await app.collections.update('conversations', conversation.id, { last_message_at: `${today}T16:00:00.000Z` });
    const mine = (await body(await request('/api/admin/conversations?filter=mios', {}, pedroCookie))).conversations;
    expect(mine.map((row) => row.id)).toContain(conversation.id);
    const mineToday = (await body(await request(`/api/admin/conversations?filter=mios&from=${today}&to=${today}`, {}, pedroCookie))).conversations;
    expect(mineToday.map((row) => row.id)).toContain(conversation.id);
    const unassigned = (await body(await request('/api/admin/conversations?filter=sin-asignar', {}, adminCookie))).conversations;
    expect(unassigned.map((row) => row.id)).not.toContain(conversation.id);
    const audit = await body(await request('/api/admin/audit?entity=conversation&limit=20'));
    expect(audit.entries.some((row) => row.action === 'conversation_reassigned' && row.actor === 'Ana Admin')).toBe(true);
  });

  it('un agente no roba un chat asignado y el agente asignado puede responder', async () => {
    const stolen = await request(`/api/admin/conversations/${conversation.id}/take`, { method: 'POST', body: '{}' }, mariaCookie);
    expect(stolen.status).toBe(403);

    const response = await request(`/api/admin/conversations/${conversation.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Hola, confirmado.' }),
    }, pedroCookie);
    expect(response.status).toBe(200);
    const sentBody = await body(response);
    expect(sent.at(-1).body).toBe('Hola, confirmado.');
    const outbound = sentBody.message;
    expect(outbound.sent_by_user_id).toBe(pedro.id);
    expect(outbound.sent_by_display_name_snapshot).toBe('Pedro');
    expect(outbound.actor_type).toBe('USER');
  });

  it('ADMIN responde un chat ajeno sin cambiar automáticamente la asignación', async () => {
    const assigned = await request(`/api/admin/conversations/${conversation.id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ userId: pedro.id }),
    });
    expect(assigned.status).toBe(200);

    const response = await request(`/api/admin/conversations/${conversation.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Ana responde sin reasignar.' }),
    }, adminCookie);
    expect(response.status).toBe(200);
    const sentBody = await body(response);
    expect(sentBody.message.sent_by_user_id).toBeTruthy();
    expect(sentBody.message.sent_by_display_name_snapshot).toBe('Ana Admin');

    const data = await body(await request('/api/admin/data', {}, adminCookie));
    const latest = data.conversations.find((row) => row.id === conversation.id);
    expect(latest.assigned_user_id).toBe(pedro.id);
    expect(latest.assigned_display_name_snapshot).toBe('Pedro');
  });

  /*
   * MI PERFIL. Dos promesas del producto que se prueban aquí:
   *   1. el nombre visible es el que viaja con cada mensaje (el que se ve en el
   *      chat como autor), así que cambiarlo se nota en el mensaje siguiente;
   *   2. un AGENTE puede cambiar SUS datos y su clave, y solo los suyos.
   */
  it('un agente cambia su propio nombre visible y el chat lo usa como autor', async () => {
    const renamed = await request('/api/admin/users/me', {
      method: 'PATCH',
      // `role` viaja a propósito: la ruta debe ignorarlo (nadie se asciende solo).
      body: JSON.stringify({ displayName: 'Pedro Nuevo', firstName: 'Pedro', lastName: 'Nuevo', role: 'ADMIN' }),
    }, pedroCookie);
    expect(renamed.status).toBe(200);
    const renamedBody = await body(renamed);
    expect(renamedBody.user.display_name).toBe('Pedro Nuevo');
    expect(renamedBody.user.first_name).toBe('Pedro');
    expect(JSON.stringify(renamedBody)).not.toContain('password_hash');

    const users = (await body(await request('/api/admin/users'))).users;
    expect(users.find((user) => user.id === pedro.id).role).toBe('AGENT');

    const sentMessage = await request(`/api/admin/conversations/${conversation.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Te escribo desde mi nombre nuevo.' }),
    }, pedroCookie);
    expect(sentMessage.status).toBe(200);
    expect((await body(sentMessage)).message.sent_by_display_name_snapshot).toBe('Pedro Nuevo');
  });

  it('el perfil propio rechaza un nombre vacío y no toca a otros usuarios', async () => {
    const empty = await request('/api/admin/users/me', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: '   ' }),
    }, pedroCookie);
    expect(empty.status).toBe(422);
    expect((await body(empty)).error).toBe('invalid_user');

    const other = await request(`/api/admin/users/${maria.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Secuestrado' }),
    }, pedroCookie);
    expect(other.status).toBe(403);
  });

  it('cambiar la contraseña exige la actual y revoca las sesiones', async () => {
    const wrong = await request('/api/admin/users/me/password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: 'no-es-mi-clave',
        newPassword: 'PedroNueva-12345',
        confirmPassword: 'PedroNueva-12345',
      }),
    }, pedroCookie);
    // 422, NO 401: si el panel lo tomara por 401 echaría a la persona a la entrada.
    expect(wrong.status).toBe(422);
    expect((await body(wrong)).error).toBe('invalid_password');
    expect((await request('/api/admin/data', {}, pedroCookie)).status).toBe(200);

    const mismatch = await request('/api/admin/users/me/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: PEDRO_PASS, newPassword: 'PedroNueva-12345', confirmPassword: 'Otra-12345' }),
    }, pedroCookie);
    expect(mismatch.status).toBe(422);
    expect((await body(mismatch)).error).toBe('password_mismatch');

    const changed = await request('/api/admin/users/me/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: PEDRO_PASS, newPassword: 'PedroNueva-12345', confirmPassword: 'PedroNueva-12345' }),
    }, pedroCookie);
    expect(changed.status).toBe(200);

    // La sesión vieja murió: solo se entra con la clave nueva.
    expect((await request('/api/admin/data', {}, pedroCookie)).status).toBe(401);
    expect((await login('pedro@phyto.local', PEDRO_PASS)).response.status).toBe(401);
    expect((await login('pedro@phyto.local', 'PedroNueva-12345')).response.status).toBe(200);
  });

  it('la sesión con la clave del panel no tiene perfil que editar', async () => {
    const legacy = await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) }, '');
    const cookie = (legacy.headers.get('set-cookie') ?? '').split(';')[0];
    expect(cookie).not.toBe('');

    const attempt = await request('/api/admin/users/me', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Panel legacy' }),
    }, cookie);
    expect(attempt.status).toBe(409);
    expect((await body(attempt)).error).toBe('legacy_session');
  });
});
