// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

let app, dir, cookie, conversation, first;
const phone = '18095557891';
const sent = [];
const request = (route, method = 'GET', body, session = cookie) => fetch(app.url + route, {
  method, headers: { cookie: session, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const json = async (route) => (await request(route)).json();
const inbound = (id) => app.customers.recordInbound({ waMessage: {
  waMessageId: id, from: phone, profileName: 'Cliente finalizable', body: 'Una consulta', type: 'text',
  receivedAt: new Date().toISOString(),
} });
beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'conversation-resolution-'));
  app = await startCrmServer({ host: '127.0.0.1', port: 0, dataFile: path.join(dir, 'crm.sqlite'),
    token: 'resolution-test', quiet: true, schedulerEnabled: false,
    whatsapp: { enabled: true, markAsRead: async () => ({ ok: true }), sendText: async (to, body) => { sent.push({ to, body }); return { ok: true, messageId: 'wamid.out-resolution' }; } } });
  const login = await fetch(app.url + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'resolution-test' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
  first = await inbound('wamid.resolve-first'); conversation = first.conversation;
});
afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('finalizar una conversación sin bloquear el contacto', () => {
  it('quita el chat de pendientes y sus contadores, conserva historial y registra auditoría', async () => {
    expect((await json('/api/admin/conversations?filter=pendientes')).conversations).toHaveLength(1);
    const response = await request(`/api/admin/conversations/${conversation.id}/resolve`, 'POST');
    expect(response.status).toBe(200);
    const pending = await json('/api/admin/conversations?filter=pendientes');
    expect(pending.conversations).toHaveLength(0); expect(pending.counts.pendientes).toBe(0);
    const row = (await json('/api/admin/conversations')).conversations[0];
    expect(row.is_resolved).toBe(true); expect(row.archived_at).toBeNull();
    const thread = await json(`/api/admin/conversations/${conversation.id}/messages`);
    expect(thread.messages.some((message) => message.id === first.message.id)).toBe(true);
    expect(thread.canSendFreeText).toBe(true); expect(sent).toHaveLength(0);
    expect((await app.audit.list()).some((row) => row.action === 'conversation.resolved')).toBe(true);
  });

  it('reabrir devuelve el pendiente, y puede finalizarse de nuevo', async () => {
    expect((await request(`/api/admin/conversations/${conversation.id}/reopen`, 'POST')).status).toBe(200);
    expect((await json('/api/admin/conversations?filter=pendientes')).conversations).toHaveLength(1);
    await request(`/api/admin/conversations/${conversation.id}/resolve`, 'POST');
    expect((await json('/api/admin/conversations?filter=pendientes')).counts.pendientes).toBe(0);
  });

  it('un webhook repetido no reabre; un mensaje entrante nuevo sí', async () => {
    expect((await inbound('wamid.resolve-first')).duplicate).toBe(true);
    expect((await json('/api/admin/conversations?filter=pendientes')).counts.pendientes).toBe(0);
    await inbound('wamid.resolve-new');
    const pending = await json('/api/admin/conversations?filter=pendientes');
    expect(pending.conversations).toHaveLength(1); expect(pending.counts.pendientes).toBe(1);
    expect(pending.conversations[0].is_resolved).toBe(false);
  });

  it('permite escribir después de finalizar', async () => {
    await request(`/api/admin/conversations/${conversation.id}/resolve`, 'POST');
    const response = await request(`/api/admin/conversations/${conversation.id}/messages`, 'POST', { body: 'Podemos continuar cuando quieras.', idempotencyKey: 'manual-resolution-send' });
    expect(response.status).toBe(200); expect(sent).toHaveLength(1);
    expect((await json('/api/admin/conversations?filter=pendientes')).counts.pendientes).toBe(0);
  });

  it('un agente sin acceso no puede finalizar conversaciones ajenas', async () => {
    const created = await (await request('/api/admin/users', 'POST', { username: 'resolution-agent@test.local', password: 'Resolution-12345', displayName: 'Agente', role: 'AGENT' })).json();
    expect(created.user.id).toBeTruthy();
    const login = await request('/api/admin/auth/login', 'POST', { username: created.user.username, password: 'Resolution-12345' }, '');
    const agentCookie = login.headers.get('set-cookie').split(';')[0];
    expect((await request(`/api/admin/conversations/${conversation.id}/resolve`, 'POST', undefined, agentCookie)).status).toBe(403);
    expect((await request(`/api/admin/conversations/${conversation.id}/reopen`, 'POST', undefined, agentCookie)).status).toBe(403);
  });
});
