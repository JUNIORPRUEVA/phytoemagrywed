// @vitest-environment node
import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JSDOM } from 'jsdom';
import { startCrmServer } from '../server/crm-server.mjs';

let app, dir, admin, other, agent;
const views = [];
const password = 'NotifyTests-12345';
const username = 'notifications-admin@test.local';
const waitFor = async (check) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('No se confirmó el estado esperado de las notificaciones');
};
const request = (user, route, method = 'GET', body) => fetch(app.url + route, {
  method, headers: { cookie: user.cookie, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const data = async (user) => (await request(user, '/api/admin/data')).json();
const list = async (user) => (await (await request(user, '/api/admin/notifications')).json()).notifications;
async function login(name) {
  const response = await fetch(app.url + '/api/admin/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password }) });
  const body = await response.json();
  return { ...body.user, cookie: response.headers.get('set-cookie').split(';')[0] };
}
async function insert(user, id, createdAt = '2026-01-01T00:00:00.000Z', key = id) {
  await app.collections.insert('user_notifications', { id, recipient_user_id: user.id, title: id,
    body: 'Aviso de prueba', type: 'PUSH_TEST', status: 'unread', created_at: createdAt, idempotency_key: key });
}
async function clear(user) { return request(user, '/api/admin/notifications', 'DELETE'); }

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'notifications-personal-'));
  app = await startCrmServer({ host: '127.0.0.1', port: 0, dataFile: path.join(dir, 'crm.sqlite'),
    token: 'notifications-local-token', quiet: true, schedulerEnabled: false,
    bootstrapAdminUser: username, bootstrapAdminPassword: password });
  admin = await login(username);
  for (const [name, role] of [['second-admin@test.local', 'ADMIN'], ['agent@test.local', 'AGENT']]) {
    const response = await request(admin, '/api/admin/users', 'POST', { username: name, password, displayName: name, role });
    expect(response.status).toBe(201);
  }
  other = await login('second-admin@test.local'); agent = await login('agent@test.local');
});
afterEach(() => { for (const view of views.splice(0)) view.window.close(); });
afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

async function panel(user, storage = new Map()) {
  const dom = new JSDOM(readFileSync('public/admin/index.html', 'utf8'), { url: app.url + '/admin/', runScripts: 'outside-only' });
  views.push(dom);
  const win = dom.window;
  let offline = false;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {}; win.confirm = () => true;
  Object.defineProperty(win, 'localStorage', { value: {
    getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  } });
  Object.defineProperty(win.navigator, 'onLine', { get: () => !offline });
  win.fetch = async (input, init = {}) => {
    if (offline) throw new TypeError('Offline');
    return fetch(new URL(typeof input === 'string' ? input : input.url, app.url), {
      ...init, headers: { ...init.headers, cookie: user.cookie },
    });
  };
  win.eval(readFileSync('public/admin/app.js', 'utf8'));
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  const $ = (selector) => win.document.querySelector(selector);
  await waitFor(() => !$('#app').hidden && $('[data-dashboard-notifications]'));
  return { dom, win, $, storage, setOffline: (value) => { offline = value; },
    open: () => $('[data-dashboard-notifications]').click() };
}

describe('bandeja personal y borrados permanentes', () => {
  it('cada usuario ve su bandeja; ni un administrador borra o marca avisos ajenos', async () => {
    await insert(admin, 'own-admin'); await insert(other, 'own-other'); await insert(agent, 'own-agent');
    expect((await list(admin)).map((row) => row.id)).toEqual(['own-admin']);
    expect((await list(other)).map((row) => row.id)).toEqual(['own-other']);
    expect((await request(admin, '/api/admin/notifications/own-other', 'DELETE')).status).toBe(403);
    expect((await request(admin, '/api/admin/notifications/own-agent/read', 'POST', {})).status).toBe(403);
    await clear(admin);
    expect(await list(admin)).toHaveLength(0);
    expect(await list(other)).toHaveLength(1); expect(await list(agent)).toHaveLength(1);
  });

  it('borrar una persiste con otra sesión y bloquea el mismo evento recreado', async () => {
    await insert(admin, 'deleted-one', undefined, 'event-one');
    expect((await request(admin, '/api/admin/notifications/deleted-one', 'DELETE')).status).toBe(200);
    await insert(admin, 'deleted-one', undefined, 'event-one');
    expect(await list(admin)).toHaveLength(0);
    await app.collections.remove('user_notifications', 'deleted-one');
    // Mismo suceso bajo otro identificador, sin perder la marca del borrado.
    await insert(admin, 'recreated-one', undefined, 'event-one');
    const reopened = await login(username);
    expect(await list(reopened)).toHaveLength(0);
    await insert(admin, 'brand-new-event');
    expect((await list(reopened)).map((row) => row.id)).toEqual(['brand-new-event']);
    await clear(admin);
  });

  it('el volumen de otros usuarios no oculta avisos propios ni limita Eliminar todas', async () => {
    for (let index = 0; index < 605; index++) {
      await insert(other, `other-bulk-${index}`, '2026-02-02T00:00:00.000Z');
      await insert(admin, `admin-bulk-${index}`);
    }
    expect(await list(admin)).toHaveLength(100);
    const result = await (await clear(admin)).json();
    expect(result.deleted).toBeGreaterThanOrEqual(605);
    expect(await list(admin)).toHaveLength(0);
    expect(await list(other)).toHaveLength(100);
    await clear(other); await clear(agent);
  }, 30000);

  it('los descartes no caducan al superar las antiguas 5000 marcas globales', async () => {
    await insert(admin, 'very-old-deleted');
    await request(admin, '/api/admin/notifications/very-old-deleted', 'DELETE');
    await insert(admin, 'very-old-deleted');
    for (let index = 0; index < 5005; index++) await app.collections.insert('notification_deletions', {
      id: `many-marks-${index}`, user_id: other.id, notification_id: `other-old-${index}`, created_at: '2099-01-01T00:00:00.000Z',
    });
    expect(await list(admin)).toHaveLength(0);
  }, 30000);

  it('un borrado en bloque pendiente conserva los avisos posteriores', async () => {
    await insert(admin, 'before-offline-clear', '2026-03-01T00:00:00.000Z');
    await insert(admin, 'after-offline-clear', '2026-03-02T00:00:00.000Z');
    await request(admin, '/api/admin/notifications', 'DELETE', { before: '2026-03-01T12:00:00.000Z' });
    expect((await list(admin)).map((row) => row.id)).toEqual(['after-offline-clear']);
    await clear(admin);
  });

  it('los avisos locales se descartan por usuario, también en otro dispositivo', async () => {
    const response = await request(admin, '/api/admin/notification-dismissals', 'POST', {
      dismissed: { 'wa-failed': 4, 'scheduled-problem:scheduled_1': 'FAILED' }, user_id: other.id,
    });
    expect(response.status).toBe(200);
    expect((await data(admin)).notificationDismissals).toEqual({ 'wa-failed': 4, 'scheduled-problem:scheduled_1': true });
    expect((await data(other)).notificationDismissals).toEqual({});
    await request(admin, '/api/admin/notification-dismissals', 'POST', { dismissed: { 'wa-failed': 2 } });
    expect((await data(await login(username))).notificationDismissals['wa-failed']).toBe(4);
  });

  it('cerrar/reabrir y cambiar de cuenta conserva cada borrado; las nuevas aparecen', async () => {
    await insert(admin, 'ui-admin-old'); await insert(other, 'ui-other-old');
    const ui = await panel(admin); ui.open();
    await waitFor(() => ui.$('[data-notification-delete="ui-admin-old"]'));
    ui.$('[data-notification-delete="ui-admin-old"]').click();
    await waitFor(async () => (await list(admin)).length === 0);
    ui.dom.window.close();
    const another = await panel(other, ui.storage); another.open();
    expect(another.$('[data-notification-delete="ui-other-old"]')).not.toBeNull();
    another.dom.window.close();
    const reopened = await panel(admin, ui.storage); reopened.open();
    expect(reopened.$('[data-notification-delete="ui-admin-old"]')).toBeNull();
    reopened.dom.window.close();
    await insert(admin, 'ui-admin-new');
    const fresh = await panel(admin); fresh.open();
    expect(fresh.$('[data-notification-delete="ui-admin-new"]')).not.toBeNull();
    expect(fresh.$('[data-notification-delete="ui-admin-old"]')).toBeNull();
    fresh.dom.window.close(); await clear(admin); await clear(other);
  });

  it('Eliminar todas sin conexión se recuerda al reabrir y sincroniza todos los avisos', async () => {
    for (let index = 0; index < 110; index++) await insert(admin, `ui-offline-${index}`);
    const ui = await panel(admin); ui.open(); ui.setOffline(true);
    ui.$('[data-notifications-delete-all]').click();
    await waitFor(() => ui.$('#sheet-body').textContent.includes('No hay notificaciones'));
    // Permite terminar el intento sin conexión antes de cerrar la ventana.
    await new Promise((resolve) => setTimeout(resolve, 60)); ui.dom.window.close();
    expect((await list(admin)).length).toBeGreaterThan(0);
    const pending = JSON.parse(ui.storage.get(`pe_notif_clear:${admin.id}`));
    await insert(admin, 'ui-after-offline', new Date(Date.parse(pending.before) + 1000).toISOString());
    await insert(other, 'other-during-offline');
    const switched = await panel(other, ui.storage); switched.open();
    expect(switched.$('[data-notification-delete="other-during-offline"]')).not.toBeNull();
    expect((await list(admin)).length).toBeGreaterThan(1);
    switched.dom.window.close();
    const reopened = await panel(admin, ui.storage); reopened.open();
    expect(reopened.$('#sheet-body').textContent).not.toContain('ui-offline-');
    await waitFor(async () => (await list(admin)).map((row) => row.id).join() === 'ui-after-offline');
    expect(reopened.$('[data-notification-delete="ui-after-offline"]')).not.toBeNull();
  }, 15000);

  it('mantiene los borrados incluso después de reiniciar el servidor', async () => {
    await insert(admin, 'survive-server-restart');
    await request(admin, '/api/admin/notifications/survive-server-restart', 'DELETE');
    for (const view of views.splice(0)) view.window.close();
    await app.close();
    app = await startCrmServer({ host: '127.0.0.1', port: 0, dataFile: path.join(dir, 'crm.sqlite'),
      token: 'notifications-local-token', quiet: true, schedulerEnabled: false,
      bootstrapAdminUser: username, bootstrapAdminPassword: password });
    admin = await login(username);
    await insert(admin, 'survive-server-restart');
    expect((await list(admin)).some((row) => row.id === 'survive-server-restart')).toBe(false);
    expect((await data(admin)).notificationDismissals['wa-failed']).toBe(4);
    await insert(admin, 'new-after-server-restart');
    expect((await list(admin)).some((row) => row.id === 'new-after-server-restart')).toBe(true);
  });
});
