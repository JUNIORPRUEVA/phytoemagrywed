// @vitest-environment node
/* Depuración puntual: quién escribe las preferencias al pulsar la tarjeta de pedidos. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'dbg-hoy2';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');

describe('dbg', () => {
  it('imprime', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dbg-hoy2-'));
    const app = await startCrmServer({
      host: '127.0.0.1',
      port: 0,
      dataFile: path.join(tmpDir, 'db.sqlite'),
      token: TOKEN,
      quiet: true,
      schedulerEnabled: false,
      whatsapp: { enabled: false },
    });
    const html = readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');
    const dom = new JSDOM(html, { url: `${app.url}/admin/`, runScripts: 'outside-only' });
    const win = dom.window;
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    win.scrollTo = () => {};
    win.requestAnimationFrame = (cb) => win.setTimeout(cb, 0);
    win.confirm = () => true;
    let cookie = '';
    win.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, `${app.url}/admin/`).toString();
      const headers = { ...(init.headers ?? {}) };
      if (cookie) headers.cookie = cookie;
      const response = await fetch(url, { ...init, headers });
      const sc = response.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      return response;
    };
    win.eval(readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8'));
    win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
    const waitFor = async (check, label) => {
      for (let i = 0; i < 300; i += 1) {
        if (await check()) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('timeout ' + label);
    };
    await waitFor(() => !win.document.querySelector('#login').hidden, 'login');
    win.document.querySelector('#login-token').value = TOKEN;
    win.document.querySelector('#login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => !win.document.querySelector('#app').hidden, 'panel');
    await waitFor(() => win.document.querySelector('#stats')?.textContent?.includes('Sin responder'), 'stats');

    const original = win.Storage.prototype.setItem;
    win.Storage.prototype.setItem = function espia(clave, valor) {
      if (clave === 'pe_prefs') {
        const traza = new Error('escritura').stack.split('\n').slice(1, 7).join('\n');
        console.log('PREFS', valor, '\n', traza);
      }
      return original.call(this, clave, valor);
    };

    const pedidos = win.document.querySelector('#stats [data-goto="pedidos"]');
    console.log('ANTES', pedidos.dataset.count, pedidos.disabled);
    pedidos.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    console.log('DESPUES tab=', win.document.body.dataset.tab, win.localStorage.getItem('pe_prefs'));
    expect(true).toBe(true);
    dom.window.close();
    await app.close();
  }, 30000);
});
