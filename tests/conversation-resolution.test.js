// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

let app, dir, cookie, conversation, first;
let now = new Date();
const phone = '18095557891';
const sent = [];
const request = (route, method = 'GET', body, session = cookie) => fetch(app.url + route, {
  method, headers: { cookie: session, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const json = async (route) => (await request(route)).json();
const inbound = (id) => app.customers.recordInbound({ waMessage: {
  waMessageId: id, from: phone, profileName: 'Cliente finalizable', body: 'Una consulta', type: 'text',
  receivedAt: now.toISOString(),
} });
beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'conversation-resolution-'));
  app = await startCrmServer({ host: '127.0.0.1', port: 0, dataFile: path.join(dir, 'crm.sqlite'),
    token: 'resolution-test', quiet: true, schedulerEnabled: false, clock: () => now,
    whatsapp: { enabled: true, markAsRead: async () => ({ ok: true }), sendText: async (to, body) => { sent.push({ to, body }); return { ok: true, messageId: 'wamid.out-resolution' }; } } });
  const login = await fetch(app.url + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'resolution-test' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
  first = await inbound('wamid.resolve-first'); conversation = first.conversation;
});
afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('finalizar una conversación sin bloquear el contacto', () => {
  it('quita el chat de pendientes, lo archiva, conserva historial y registra auditoría', async () => {
    expect((await json('/api/admin/conversations?filter=pendientes')).conversations).toHaveLength(1);
    const response = await request(`/api/admin/conversations/${conversation.id}/resolve`, 'POST');
    expect(response.status).toBe(200);
    const pending = await json('/api/admin/conversations?filter=pendientes');
    expect(pending.conversations).toHaveLength(0); expect(pending.counts.pendientes).toBe(0);
    // Finalizar ARCHIVA: sale de la bandeja y queda en «Archivados».
    expect((await json('/api/admin/conversations')).conversations).toHaveLength(0);
    const archivadas = (await json('/api/admin/conversations?filter=archivados')).conversations;
    expect(archivadas).toHaveLength(1);
    expect(archivadas[0].is_resolved).toBe(true);
    expect(archivadas[0].archived_at).toBeTruthy();
    const thread = await json(`/api/admin/conversations/${conversation.id}/messages`);
    expect(thread.messages.some((message) => message.id === first.message.id)).toBe(true);
    expect(thread.canSendFreeText).toBe(true); expect(sent).toHaveLength(0);
    expect((await app.audit.list()).some((row) => row.action === 'conversation.resolved')).toBe(true);
  });

  it('reabrir devuelve el pendiente y lo saca de archivados', async () => {
    expect((await request(`/api/admin/conversations/${conversation.id}/reopen`, 'POST')).status).toBe(200);
    expect((await json('/api/admin/conversations?filter=pendientes')).conversations).toHaveLength(1);
    expect((await json('/api/admin/conversations?filter=archivados')).conversations).toHaveLength(0);
    const reabierta = (await json('/api/admin/conversations')).conversations[0];
    expect(reabierta.archived_at).toBeNull(); expect(reabierta.is_resolved).toBe(false);
    await request(`/api/admin/conversations/${conversation.id}/resolve`, 'POST');
    expect((await json('/api/admin/conversations?filter=pendientes')).counts.pendientes).toBe(0);
  });

  it('un webhook repetido no reabre; un mensaje entrante nuevo sí, y vuelve en la primera fila', async () => {
    expect((await inbound('wamid.resolve-first')).duplicate).toBe(true);
    expect((await json('/api/admin/conversations?filter=pendientes')).counts.pendientes).toBe(0);
    expect((await json('/api/admin/conversations')).conversations).toHaveLength(0);
    /*
     * Otra clienta escribe DESPUÉS de la conversación archivada. Mientras la
     * finalizada siga archivada, la más reciente es la de esta otra clienta.
     */
    const base = now.getTime();
    const otra = await app.customers.recordInbound({ waMessage: {
      waMessageId: 'wamid.resolve-otra', from: '18095557892', profileName: 'Otra clienta', body: 'Buenas',
      type: 'text', receivedAt: new Date(base).toISOString(),
    } });
    let bandeja = (await json('/api/admin/conversations')).conversations;
    expect(bandeja).toHaveLength(1);
    expect(bandeja[0].id).toBe(otra.conversation.id);
    // Ahora vuelve a escribir la clienta finalizada: releva a la otra y sale arriba.
    await app.customers.recordInbound({ waMessage: {
      waMessageId: 'wamid.resolve-new', from: phone, profileName: 'Cliente finalizable', body: 'Otra consulta',
      type: 'text', receivedAt: new Date(base + 5000).toISOString(),
    } });
    now = new Date(base + 5000);
    const pending = await json('/api/admin/conversations?filter=pendientes');
    expect(pending.conversations).toHaveLength(2); expect(pending.counts.pendientes).toBe(2);
    expect(pending.conversations[0].id).toBe(conversation.id);
    expect(pending.conversations[0].is_resolved).toBe(false);
    // Vuelve a la bandeja (no archivada) y arriba del todo.
    bandeja = (await json('/api/admin/conversations')).conversations;
    expect(bandeja).toHaveLength(2);
    expect(bandeja[0].id).toBe(conversation.id);
    expect(bandeja[0].archived_at).toBeNull();
    expect(bandeja[0].is_resolved).toBe(false);
    expect((await json('/api/admin/conversations?filter=archivados')).conversations).toHaveLength(0);
  });

  it('permite escribir después de finalizar', async () => {
    await request(`/api/admin/conversations/${conversation.id}/resolve`, 'POST');
    const response = await request(`/api/admin/conversations/${conversation.id}/messages`, 'POST', { body: 'Podemos continuar cuando quieras.', idempotencyKey: 'manual-resolution-send' });
    expect(response.status).toBe(200); expect(sent).toHaveLength(1);
    // Escribir a un chat archivado no lo reabre ni lo devuelve a la bandeja.
    const pending = await json('/api/admin/conversations?filter=pendientes');
    expect(pending.conversations.some((row) => row.id === conversation.id)).toBe(false);
    const archivadas = await json('/api/admin/conversations?filter=archivados');
    expect(archivadas.conversations.some((row) => row.id === conversation.id)).toBe(true);
  });

  it('finalizar de a varios es la misma acción: archiva todos los elegidos', async () => {
    // Al llegar aquí hay dos conversaciones abiertas (la principal y la otra).
    await request(`/api/admin/conversations/${conversation.id}/reopen`, 'POST');
    const bandeja = (await json('/api/admin/conversations')).conversations;
    expect(bandeja.length).toBeGreaterThanOrEqual(2);
    const ids = bandeja.slice(0, 2).map((row) => row.id);
    const lote = await request('/api/admin/conversations/bulk', 'POST', { action: 'resolve', ids });
    expect(lote.status).toBe(200);
    const cuerpo = await lote.json();
    expect(cuerpo.processed).toBe(2); expect(cuerpo.failed).toBe(0);
    const activas = (await json('/api/admin/conversations')).conversations;
    for (const id of ids) expect(activas.some((row) => row.id === id)).toBe(false);
    const archivadas = (await json('/api/admin/conversations?filter=archivados')).conversations;
    for (const id of ids) {
      const fila = archivadas.find((row) => row.id === id);
      expect(fila?.archived_at).toBeTruthy();
      expect(fila?.is_resolved).toBe(true);
    }
  });

  it('un agente sin acceso no puede finalizar conversaciones ajenas', async () => {
    const created = await (await request('/api/admin/users', 'POST', { username: 'resolution-agent@test.local', password: 'Resolution-12345', displayName: 'Agente', role: 'AGENT' })).json();
    expect(created.user.id).toBeTruthy();
    const login = await request('/api/admin/auth/login', 'POST', { username: created.user.username, password: 'Resolution-12345' }, '');
    const agentCookie = login.headers.get('set-cookie').split(';')[0];

    /*
     * REGLA DEL NEGOCIO: una conversación libre la atiende cualquier agente, pero
     * en cuanto tiene dueño queda exclusiva (solo administración la reasigna).
     * Aquí se le da dueño para comprobar el bloqueo del resto de agentes.
     */
    const dueno = (await (await request('/api/admin/users', 'POST', { username: 'resolution-owner@test.local', password: 'Resolution-12345', displayName: 'Dueña', role: 'AGENT' })).json()).user;
    expect(dueno.id).toBeTruthy();
    expect((await request(`/api/admin/conversations/${conversation.id}/assign`, 'POST', { userId: dueno.id })).status).toBe(200);

    expect((await request(`/api/admin/conversations/${conversation.id}/resolve`, 'POST', undefined, agentCookie)).status).toBe(403);
    expect((await request(`/api/admin/conversations/${conversation.id}/reopen`, 'POST', undefined, agentCookie)).status).toBe(403);
    // El dueño sí puede.
    const loginDueno = await request('/api/admin/auth/login', 'POST', { username: 'resolution-owner@test.local', password: 'Resolution-12345' }, '');
    const duenoCookie = loginDueno.headers.get('set-cookie').split(';')[0];
    expect((await request(`/api/admin/conversations/${conversation.id}/resolve`, 'POST', undefined, duenoCookie)).status).toBe(200);
  });
});
