// @vitest-environment jsdom
/**
 * UAT DEL PANEL — MI PERFIL (panel real + CRM real, sin WhatsApp de verdad).
 *
 * Lo que se demuestra aquí, que es lo que se pidió:
 *   - «Perfil» está en el menú lateral, al FINAL de la parte de abajo;
 *   - el bloque del usuario de arriba del menú también lleva al perfil;
 *   - el usuario con sesión cambia su NOMBRE VISIBLE y el CRM lo guarda (es el
 *     nombre que viajará con los mensajes que envíe);
 *   - cambia su CONTRASEÑA desde ahí, con la actual delante;
 *   - una contraseña actual equivocada NO cierra la sesión (avisa y sigue dentro):
 *     confundirlo con «sesión caducada» echaría a la persona a la entrada.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-perfil-panel';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const USER = 'ana@phyto.local';
const PASS = 'AnaPerfil-12345';
const PASS_NUEVA = 'AnaNueva-12345';

let tmpDir;
let app;
let dom;
let cookie = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera a que una condición del DOM se cumpla (o falla con un mensaje claro). */
async function waitFor(check, label, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timeout esperando: ${label}`);
    await sleep(25);
  }
}

const $ = (selector) => dom.window.document.querySelector(selector);
const $$ = (selector) => [...dom.window.document.querySelectorAll(selector)];
const click = (element) => {
  const target = typeof element === 'string' ? $(element) : element;
  if (!target) throw new Error(`no existe el elemento para pulsar: ${element}`);
  if (target.disabled === true) return false;
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return true;
};
const setValue = (selector, value) => {
  const input = typeof selector === 'string' ? $(selector) : selector;
  if (!input) throw new Error(`no existe el campo: ${selector}`);
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};

/** El usuario según el SERVIDOR (la fuente de verdad, no el DOM). */
async function userFromServer() {
  const response = await fetch(`${app.url}/api/admin/users`, { headers: { cookie } });
  const body = await response.json();
  return (body.users ?? []).find((user) => user.username === USER) ?? null;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-perfil-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    bootstrapAdminUser: USER,
    bootstrapAdminPassword: PASS,
    bootstrapAdminDisplayName: 'Ana Perfil',
    schedulerEnabled: false,
  });

  dom = new JSDOM(readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8'), {
    url: `${app.url}/admin/`,
    runScripts: 'outside-only',
    pretendToBeVisual: false,
  });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.confirm = () => true;
  win.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, `${app.url}/admin/`).toString();
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };

  win.eval(readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8'));
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  await waitFor(() => !$('#login').hidden || !$('#app').hidden, 'la pantalla de acceso');
});

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Mi perfil', () => {
  it('entra con usuario y contraseña (no con la clave del panel)', async () => {
    setValue('#login-username', USER);
    setValue('#login-password', PASS);
    $('#login-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    // OJO: `#app` se enseña ANTES de que terminen de llegar los datos, así que
    // hay que esperar a algo pintado (el bloque del usuario), no a la app.
    await waitFor(() => $('#drawer-user-go') !== null, 'el bloque del usuario en el menú');
    expect($('#login-error').hidden).toBe(true);
    expect($('#drawer-user')?.textContent).toContain('Ana Perfil');
  });

  it('«Perfil» está al final de la parte de abajo del menú', () => {
    const items = $$('.drawer__nav--bottom .drawer__item');
    expect(items.length).toBeGreaterThanOrEqual(2);
    const ultimo = items.at(-1);
    expect(ultimo.dataset.tab).toBe('perfil');
    expect(ultimo.textContent).toContain('Perfil');
  });

  it('el bloque del usuario del menú también lleva al perfil', async () => {
    expect($('#drawer-user-go')).not.toBeNull();
    click('#drawer-user-go');
    await waitFor(() => !$('#view-perfil').hidden, 'la vista de perfil');
    expect($('#profile-name').value).toBe('Ana Perfil');
    expect($('#profile-username').value).toBe(USER);
    // El usuario con el que se entra no se edita desde aquí.
    expect($('#profile-username').disabled).toBe(true);
  });

  it('guarda el nombre visible y el CRM lo guarda de verdad', async () => {
    setValue('#profile-name', 'Ana Nueva');
    click('#profile-save');
    await waitFor(() => $('#drawer-user')?.textContent?.includes('Ana Nueva'), 'el nombre nuevo en el menú');
    expect((await userFromServer()).display_name).toBe('Ana Nueva');
  });

  it('una contraseña actual equivocada avisa y NO cierra la sesión', async () => {
    setValue('#profile-current', 'esta-no-es-mi-clave');
    setValue('#profile-new', PASS_NUEVA);
    setValue('#profile-confirm', PASS_NUEVA);
    click('#profile-password');
    await waitFor(
      () => !$('#toast').hidden && $('#toast').textContent.includes('contraseña actual'),
      'el aviso de contraseña actual incorrecta',
    );
    // Lo importante: sigue dentro. Un 401 aquí sería un error de diseño.
    expect($('#app').hidden).toBe(false);
    expect($('#login').hidden).toBe(true);
  });

  it('cambia la contraseña y vuelve a la entrada (la sesión vieja muere)', async () => {
    setValue('#profile-current', PASS);
    setValue('#profile-new', PASS_NUEVA);
    setValue('#profile-confirm', PASS_NUEVA);
    click('#profile-password');
    await waitFor(() => !$('#login').hidden, 'la pantalla de entrada tras cambiar la clave');
    expect($('#app').hidden).toBe(true);
    expect($('#login-error').textContent).toContain('Contraseña cambiada');

    // La clave nueva es la que vale.
    const reLogin = await fetch(`${app.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS_NUEVA }),
    });
    expect(reLogin.status).toBe(200);
  });
});
