// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { startCrmServer } from '../server/crm-server.mjs';

let app, directory;
const windows = [];
const html = readFileSync('public/admin/index.html', 'utf8');
const script = readFileSync('public/admin/app.js', 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { if (await check()) return; await sleep(20); }
  throw new Error('No se completó la operación esperada');
}

beforeAll(async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'phyto-settings-'));
  app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: path.join(directory, 'test.sqlite'), token: 'settings-test', quiet: true, schedulerEnabled: false, bootstrapAdminUser: 'admin@settings.local', bootstrapAdminPassword: 'Settings-12345' });
});
afterAll(async () => { windows.forEach((win) => win.close()); await app.close(); rmSync(directory, { recursive: true, force: true }); });

async function panel({ role = 'ADMIN', permissions = { geolocation: 'prompt', microphone: 'prompt', camera: 'prompt' }, storage = {}, hash = '#config', notification = 'default' } = {}) {
  const dom = new JSDOM(html, { url: app.url + '/admin/' + hash, runScripts: 'outside-only' });
  const win = dom.window;
  windows.push(win);
  win.matchMedia = () => ({ matches: false, addEventListener() {} });
  win.scrollTo = () => {};
  win.confirm = () => true;
  Object.entries(storage).forEach(([key, value]) => win.localStorage.setItem(key, value));
  const statuses = Object.fromEntries(Object.entries(permissions).map(([key, state]) => [key, { state, onchange: null }]));
  Object.defineProperty(win.navigator, 'permissions', { value: { query: async ({ name }) => statuses[name] || { state: 'prompt' } } });
  const stop = vi.fn();
  const getUserMedia = vi.fn(async (constraints) => {
    const key = constraints.audio ? 'microphone' : 'camera';
    statuses[key].state = 'granted';
    return { getTracks: () => [{ stop }] };
  });
  Object.defineProperty(win.navigator, 'mediaDevices', { value: { getUserMedia } });
  win.Notification = { permission: notification, requestPermission: vi.fn(async () => { win.Notification.permission = 'granted'; return 'granted'; }) };
  let cookie = '';
  win.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, app.url);
    const headers = { ...(init.headers || {}), ...(cookie ? { cookie } : {}) };
    const response = await fetch(url, { ...init, headers });
    const received = response.headers.get('set-cookie');
    if (received) cookie = received.split(';')[0];
    if (url.pathname === '/api/admin/data' && response.ok && role !== 'ADMIN') {
      const body = await response.json();
      body.auth = { ...body.auth, legacy: false, user: { ...body.auth?.user, role, display_name: 'Persona de prueba' } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return response;
  };
  const login = await win.fetch('/api/admin/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin@settings.local', password: 'Settings-12345' }) });
  expect(login.ok).toBe(true);
  win.eval(script);
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  const $ = (selector) => win.document.querySelector(selector);
  const click = (selector) => { const node = $(selector); if (!node) throw new Error('No existe ' + selector); node.click(); };
  await waitFor(() => !$('#app').hidden && $('#settings-menu a') && (role === 'ADMIN' || $('#settings-name')?.textContent === 'Persona de prueba'));
  return { win, $, click, statuses, getUserMedia, stop };
}

describe('Configuración con una pantalla por opción', () => {
  it('la portada solo muestra la lista; cada opción abre únicamente su contenido', async () => {
    const p = await panel();
    expect(p.$('#settings-home').hidden).toBe(false);
    const links = [...p.win.document.querySelectorAll('[data-settings-open]')];
    expect(links.length).toBe(13);
    expect([...p.win.document.querySelectorAll('#view-ajustes > .card')].every((node) => node.hidden)).toBe(true);
    for (const link of links) {
      const key = link.dataset.settingsOpen;
      p.click(`[data-settings-open="${key}"]`);
      expect(p.win.location.hash).toBe('#config/' + key);
      expect(p.$('#settings-home').hidden).toBe(true);
      expect(p.$('#settings-title').textContent).toBe(link.querySelector('strong').textContent);
      const shown = [...p.win.document.querySelectorAll('#view-ajustes > .card')].filter((node) => !node.hidden);
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.length).toBeLessThanOrEqual(2);
      p.click('#view-ajustes [data-settings-back]');
      expect(p.$('#settings-home').hidden).toBe(false);
    }
  });
  it('atrás/adelante del navegador y la recarga respetan la pantalla elegida', async () => {
    const p = await panel();
    p.click('[data-settings-open="permisos"]');
    p.win.history.back();
    await waitFor(() => !p.$('#settings-home').hidden);
    p.win.history.forward();
    await waitFor(() => !p.$('#config-permisos').hidden);
    const reopened = await panel({ hash: p.win.location.hash });
    expect(reopened.$('#config-permisos').hidden).toBe(false);
    expect(reopened.$('#settings-title').textContent).toBe('Permisos');
  });
  it('un agente tiene permisos, notificaciones, apariencia y aplicación, sin administración', async () => {
    const p = await panel({ role: 'AGENT', hash: '#config/exportar' });
    expect([...p.win.document.querySelectorAll('[data-settings-open]')].map((node) => node.dataset.settingsOpen)).toEqual(['permisos', 'notificaciones', 'apariencia', 'aplicacion']);
    expect(p.$('#config-exportar').hidden).toBe(true);
    expect(p.$('#settings-home').hidden).toBe(false);
    p.click('[data-settings-open="permisos"]');
    expect(p.$('#config-permisos').hidden).toBe(false);
  });
});

describe('Permisos reales y persistencia al reabrir', () => {
  it('los permisos concedidos siguen activos sin pedirlos otra vez; la revocación se refleja', async () => {
    const p = await panel({ hash: '#config/permisos', notification: 'granted', permissions: { geolocation: 'granted', microphone: 'granted', camera: 'granted' } });
    await waitFor(() => p.$('[data-settings-permission="camera"] [data-status="granted"]'));
    expect([...p.win.document.querySelectorAll('[data-settings-permission-enable]')].every((node) => node.disabled)).toBe(true);
    expect(p.getUserMedia).not.toHaveBeenCalled();
    expect(p.win.Notification.requestPermission).not.toHaveBeenCalled();
    p.statuses.microphone.state = 'denied';
    p.statuses.microphone.onchange();
    await waitFor(() => p.$('[data-settings-permission="microphone"] [data-status="denied"]'));
    expect(p.$('[data-settings-permission-enable="microphone"]').textContent).toBe('Revisar');
  });
  it('activar micrófono detiene la captura y reabrir no vuelve a solicitarlo', async () => {
    const p = await panel({ hash: '#config/permisos' });
    await waitFor(() => p.$('[data-settings-permission="microphone"] [data-status="prompt"]'));
    p.click('[data-settings-permission-enable="microphone"]');
    await waitFor(() => p.$('[data-settings-permission="microphone"] [data-status="granted"]'));
    expect(p.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(p.stop).toHaveBeenCalledOnce();
    const memory = p.win.localStorage.getItem('pe_permisos');
    const reopened = await panel({ hash: '#config/permisos', permissions: { microphone: 'granted', camera: 'prompt', geolocation: 'prompt' }, storage: { pe_permisos: memory } });
    await waitFor(() => reopened.$('[data-settings-permission="microphone"] [data-status="granted"]'));
    expect(reopened.getUserMedia).not.toHaveBeenCalled();
    // El recuerdo local nunca se usa para fingir un permiso que el sistema quitó.
    const revoked = await panel({ hash: '#config/permisos', storage: { pe_permisos: memory } });
    await waitFor(() => revoked.$('[data-settings-permission="microphone"] [data-status="prompt"]'));
    expect(revoked.$('[data-settings-permission-enable="microphone"]').disabled).toBe(false);
  });
  it('un fallo de cámara permite reintentar y no se marca como concedida', async () => {
    const p = await panel({ hash: '#config/permisos' });
    p.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('busy'), { name: 'NotReadableError' }));
    p.click('[data-settings-permission-enable="camera"]');
    await waitFor(() => p.$('#settings-permission-feedback').textContent.includes('otra aplicación'));
    expect(p.$('[data-settings-permission-enable="camera"]').disabled).toBe(false);
    p.click('[data-settings-permission-enable="camera"]');
    await waitFor(() => p.$('[data-settings-permission="camera"] [data-status="granted"]'));
    expect(p.stop).toHaveBeenCalledOnce();
  });
  it('el servidor permite solicitar cámara solo en el panel', async () => {
    const response = await fetch(app.url + '/admin/');
    expect(response.headers.get('permissions-policy')).toContain('camera=(self)');
  });
});
