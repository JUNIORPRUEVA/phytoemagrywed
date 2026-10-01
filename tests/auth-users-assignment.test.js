// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

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
    expect(statuses).toEqual([200, 409]);
    const latest = (await body(await request(`/api/admin/conversations/${conversation.id}/messages`, {}, adminCookie))).conversation;
    expect([maria.id, pedro.id]).toContain(latest.assigned_user_id);
  });

  it('ADMIN reasigna, filtros Míos/Sin asignar responden y auditoría registra actor', async () => {
    const response = await request(`/api/admin/conversations/${conversation.id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ userId: pedro.id }),
    });
    expect(response.status).toBe(200);
    const mine = (await body(await request('/api/admin/conversations?filter=mios', {}, pedroCookie))).conversations;
    expect(mine.map((row) => row.id)).toContain(conversation.id);
    const unassigned = (await body(await request('/api/admin/conversations?filter=sin-asignar', {}, adminCookie))).conversations;
    expect(unassigned.map((row) => row.id)).not.toContain(conversation.id);
    const audit = await body(await request('/api/admin/audit?entity=conversation&limit=20'));
    expect(audit.entries.some((row) => row.action === 'conversation_reassigned' && row.actor === 'Ana Admin')).toBe(true);
  });

  it('mensaje outbound guarda agente y snapshot XSS sin firmar el texto al cliente', async () => {
    const response = await request(`/api/admin/conversations/${conversation.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Hola, confirmado.' }),
    }, mariaCookie);
    expect(response.status).toBe(200);
    const sentBody = await body(response);
    expect(sent.at(-1).body).toBe('Hola, confirmado.');
    const outbound = sentBody.message;
    expect(outbound.sent_by_user_id).toBe(maria.id);
    expect(outbound.sent_by_display_name_snapshot).toBe('María <script>');
    expect(outbound.actor_type).toBe('USER');
  });
});
