// @vitest-environment jsdom
/**
 * UAT DEL PANEL — USUARIOS: crear la cuenta rápido y PODER VER la contraseña.
 *
 * Lo que pidió el negocio y aquí se demuestra:
 *   - la contraseña pide SEIS caracteres (no diez): se crea la cuenta con el
 *     cliente delante y esa cuenta entra de verdad con esa contraseña;
 *   - hay un OJO para ver lo que se está escribiendo, en el formulario de crear
 *     usuario y también al RESETEAR la contraseña de uno que ya existe;
 *   - el rol se elige de verdad: un AGENTE es quien reparte (un pedido se le pasa
 *     a un agente), así que el selector ofrece agente, repartidor, operador y admin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-users-panel';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');

let tmpDir;
let app;
let dom;
let cookie = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timeout esperando: ${label}`);
    await sleep(20);
  }
}

const $ = (selector) => dom.window.document.querySelector(selector);
const $$ = (selector) => [...dom.window.document.querySelectorAll(selector)];

/** Pulsa como un navegador: si el control está deshabilitado, NO hace nada. */
const click = (element) => {
  const target = typeof element === 'string' ? $(element) : element;
  if (!target) throw new Error(`no existe el elemento: ${element}`);
  if (target.disabled === true) return false;
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return true;
};

/** Escribe en un campo como una persona: valor + evento `input`. */
function setValue(selector, value) {
  const input = typeof selector === 'string' ? $(selector) : selector;
  if (!input) throw new Error(`no existe el campo: ${selector}`);
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  return input;
}

/** Entra de verdad por la puerta: devuelve si la contraseña vale. */
async function loginWorks(username, password) {
  const response = await fetch(`${app.url}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return response.status === 200;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-users-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phyto.sqlite'),
    token: TOKEN,
    quiet: true,
    // Un administrador de verdad para que la pantalla tenga lista que enseñar.
    bootstrapAdminUser: 'jefe@phyto.local',
    bootstrapAdminPassword: 'Jefe-12345',
    schedulerEnabled: false,
  });

  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  dom = new JSDOM(readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8'), {
    url: `${app.url}/admin/`,
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.alert = () => {};
  win.confirm = () => true;
  win.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, `${app.url}/admin/`).toString();
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      headers: { get: () => setCookie ?? null },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };

  win.eval(readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8'));
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  await waitFor(() => !$('#login').hidden || !$('#app').hidden, 'la pantalla de acceso');

  // Entrar con la clave del panel (admin) y abrir la pantalla de Usuarios.
  setValue('#login-token', TOKEN);
  $('#login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !$('#app').hidden, 'el panel abierto');
  click('[data-tab="usuarios"]');
  await waitFor(() => !$('#view-usuarios').hidden, 'la vista de Usuarios');
  await waitFor(() => $$('#users-view .item').length > 0, 'la lista de usuarios');
});

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('usuarios: contraseña corta y con ojo para verla', () => {
  it('el formulario pide 6 caracteres y el ojo enseña lo escrito', async () => {
    const campo = $('#user-create input[name="password"]');
    expect(campo.getAttribute('minlength')).toBe('6');
    expect($('#user-create').textContent).toContain('Mínimo 6 caracteres');

    // Los roles que existen de verdad: el agente es quien reparte.
    const opciones = [...$('#user-create select[name="role"]').options].map((option) => option.value);
    expect(opciones).toEqual(['AGENT', 'DELIVERY', 'OPERADOR', 'ADMIN']);

    const ojo = $('#user-create [data-pass-eye]');
    expect(ojo).toBeTruthy();
    // El icono se PINTA (el botón no puede ser un hueco invisible).
    expect(ojo.querySelector('svg')).toBeTruthy();
    expect(campo.type).toBe('password');
    click(ojo);
    expect(campo.type).toBe('text');
    expect(ojo.getAttribute('aria-pressed')).toBe('true');
    click(ojo);
    expect(campo.type).toBe('password');
    expect(ojo.getAttribute('aria-pressed')).toBe('false');
  });

  it('crea un AGENTE con contraseña de 6 caracteres y esa cuenta entra', async () => {
    setValue('#user-create input[name="displayName"]', 'Ana Agente');
    setValue('#user-create input[name="username"]', 'ana.agente@phyto.local');
    setValue('#user-create input[name="password"]', 'ana123');
    setValue('#user-create select[name="role"]', 'AGENT');
    $('#user-create').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    // El usuario aparece en la lista (y el servidor lo guardó como AGENTE).
    const fila = await waitFor(
      () => $$('#users-view .item').find((row) => row.textContent.includes('Ana Agente')) ?? null,
      'el usuario nuevo en la lista',
    );
    expect(fila.textContent).toContain('Agente');
    const usuarios = await (await fetch(`${app.url}/api/admin/users`, { headers: { cookie } })).json();
    expect(usuarios.users.find((user) => user.username === 'ana.agente@phyto.local').role).toBe('AGENT');
    // Seis caracteres de verdad sirven para entrar.
    expect(await loginWorks('ana.agente@phyto.local', 'ana123')).toBe(true);
  });

  it('el reseteo de contraseña es una hoja con ojo (no un prompt a ciegas)', async () => {
    const fila = await waitFor(
      () => $$('#users-view .item').find((row) => row.textContent.includes('Ana Agente')) ?? null,
      'la fila del usuario',
    );
    const boton = [...fila.querySelectorAll('[data-user-password]')][0];
    click(boton);
    const campo = await waitFor(() => $('#user-pass-new'), 'el campo de la contraseña nueva');
    // Y trae su ojo, como el formulario de alta.
    const ojo = $('#user-pass-new')?.closest('.pass')?.querySelector('[data-pass-eye]');
    expect(ojo).toBeTruthy();
    click(ojo);
    expect(campo.type).toBe('text');

    setValue('#user-pass-new', 'nueva1');
    click('#user-pass-save');
    await waitFor(() => $('#sheet').hidden, 'la hoja cerrada');
    // La contraseña nueva (6 caracteres) es la que entra; la vieja ya no.
    expect(await loginWorks('ana.agente@phyto.local', 'nueva1')).toBe(true);
    expect(await loginWorks('ana.agente@phyto.local', 'ana123')).toBe(false);
  });
});
