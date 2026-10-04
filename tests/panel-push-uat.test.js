// @vitest-environment jsdom
/**
 * UAT DEL PANEL — NOTIFICACIONES DEL TELÉFONO (panel real + CRM real, sin push real).
 *
 * Lo que se pidió: que al pulsar «Probar» o «Revisar» PASE algo, que se pueda
 * probar de verdad desde Configuración, y que la lista de notificaciones sea
 * COMPACTA (tarjetas pequeñas y botones pequeños en vez de bloques enormes).
 *
 * Aquí se comprueba, con el servidor de verdad y un service worker de mentira:
 *   - la campana lista notificaciones, pero la prueba vive en Configuración;
 *   - «Probar notificación» está SIEMPRE disponible (antes quedaba deshabilitado y el clic no
 *     hacía nada), registra este teléfono si hacía falta, pide la prueba al
 *     servidor y deja el RESULTADO escrito en Configuración;
 *   - la prueba también se muestra en el propio teléfono (aviso local), para
 *     distinguir «no salió del servidor» de «el teléfono no muestra avisos»;
 *   - «Revisar» también deja resultado visible.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

/*
 * La clave PÚBLICA se define ANTES de cargar el servidor (se lee al importar el
 * módulo): con ella el panel se cree capaz de registrar el teléfono. La privada
 * NO se pone a propósito: así la prueba del servidor no intenta ninguna llamada
 * real a un servicio de push y el resultado es determinista.
 */
process.env.PHYTO_WEB_PUSH_PUBLIC_KEY = 'BAUatSoloPublica';
const { startCrmServer } = await import('../server/crm-server.mjs');

const TOKEN = 'uat-push-panel';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const USER = 'junior@phyto.local';
const PASS = 'JuniorPush-12345';

let tmpDir;
let app;
let dom;
let cookie = '';
let suscripcionesCreadas = 0;
let suscripcionActiva = null;
const avisosLocales = [];

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
const click = (element) => {
  const target = typeof element === 'string' ? $(element) : element;
  if (!target) throw new Error(`no existe el elemento para pulsar: ${element}`);
  if (target.disabled === true) return false;
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return true;
};
const setValue = (selector, value) => {
  const input = $(selector);
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};

async function pushStatusFromServer() {
  const response = await fetch(`${app.url}/api/admin/push-status`, { headers: { cookie } });
  return (await response.json()).push;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-push-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    bootstrapAdminUser: USER,
    bootstrapAdminPassword: PASS,
    bootstrapAdminDisplayName: 'Junior Push',
    schedulerEnabled: false,
  });

  dom = new JSDOM(readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8'), {
    url: `${app.url}/admin/`,
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.confirm = () => true;
  win.alert = () => {};

  // --- Dobles del navegador: notificaciones y service worker -----------------
  const suscripcionFake = {
    endpoint: 'https://push.example/uat-telefono',
    keys: { p256dh: 'clave-publica-fake', auth: 'secreto-fake' },
    options: { applicationServerKey: null },
    async unsubscribe() {
      suscripcionActiva = null;
      return true;
    },
    toJSON() {
      return { endpoint: this.endpoint, keys: this.keys };
    },
  };
  const registroFake = {
    scope: `${app.url}/admin/`,
    pushManager: {
      async getSubscription() {
        return suscripcionActiva;
      },
      async subscribe() {
        suscripcionesCreadas += 1;
        suscripcionActiva = suscripcionFake;
        return suscripcionFake;
      },
    },
    async showNotification(title, options) {
      avisosLocales.push({ title, options });
      return true;
    },
  };
  win.Notification = function Notification() {};
  win.Notification.permission = 'granted';
  win.Notification.requestPermission = async () => 'granted';
  win.PushManager = function PushManager() {};
  Object.defineProperty(win.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve(registroFake),
      register: () => Promise.resolve(registroFake),
      addEventListener() {},
      controller: null,
    },
  });

  win.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, `${app.url}/admin/`).toString();
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
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

  setValue('#login-username', USER);
  setValue('#login-password', PASS);
  $('#login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => $('.drawer__brand')?.textContent?.includes('Junior Push'), 'el panel cargado con la sesión');
}, 60000);

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('la hoja de notificaciones', () => {
  it('abre sin controles de prueba; esos viven en Configuración', async () => {
    click('[data-dashboard-notifications]');
    await waitFor(() => $('#sheet').hidden === false, 'la hoja abierta');
    // Ya no son las tarjetas grandes de delivery.
    expect($$('#sheet-body .delivery-order')).toHaveLength(0);
    expect($('#sheet-body [data-push-test]')).toBeNull();
    expect($('#sheet-body [data-push-enable]')).toBeNull();
  });

  it('el CSS las sostiene pequeñas (dos líneas de texto y botón de 32 px)', () => {
    const css = readFileSync(path.join(ADMIN_DIR, 'admin.css'), 'utf8');
    expect(css).toMatch(/\.notice__main p\s*\{[^}]*-webkit-line-clamp:\s*2;/s);
    expect(css).toMatch(/\.btn--xs\s*\{[^}]*min-height:\s*32px;/s);
    expect(css).toMatch(/\.notice\s*\{[^}]*padding:\s*7px 9px;/s);
  });
});

describe('«Probar» y «Revisar» no se quedan sin respuesta', () => {
  it('«Probar» registra el teléfono, pide la prueba al servidor y lo deja escrito', async () => {
    click('[data-tab="ajustes"]');
    await waitFor(() => !$('#view-ajustes').hidden, 'Configuración abierta');
    expect($('.config-menu')?.textContent).toContain('Notificaciones');
    expect($('#push-config [data-push-test]')?.textContent).toContain('Probar notificación');
    expect($('#push-config [data-push-enable]')?.classList.contains('btn--xs')).toBe(true);
    expect($('#push-config [data-push-result]')?.textContent ?? '').toMatch(/Sin pruebas recientes|Último envío|Servidor/);

    const antes = await pushStatusFromServer();
    expect(antes.activeSubscriptions).toBeGreaterThanOrEqual(0);

    expect(click('#push-config [data-push-test]')).toBe(true);
    /*
     * OJO: el texto de la línea existe ANTES de la prueba («Sin pruebas recientes»),
     * así que hay que esperar al RESULTADO, no a que haya una línea.
     */
    const resultado = await waitFor(() => {
      const texto = $('#push-config [data-push-result]')?.textContent ?? '';
      return texto.includes('Servidor:') ? texto : null;
    }, 'el resultado de la prueba en Configuración', 20000);

    // El teléfono quedó registrado en el CRM (el servidor es la fuente de verdad).
    const despues = await waitFor(async () => {
      const status = await pushStatusFromServer();
      return status.activeSubscriptions > 0 ? status : null;
    }, 'el teléfono registrado en el servidor');
    expect(despues.subscriptions.some((row) => row.endpoint.includes('push.example'))).toBe(true);
    expect(suscripcionesCreadas).toBeGreaterThanOrEqual(1);

    // La prueba se muestra TAMBIÉN en este dispositivo, y se dice en Configuración.
    await waitFor(() => avisosLocales.length >= 1, 'el aviso local de prueba');
    expect(avisosLocales[0].title).toContain('Prueba');
    expect(avisosLocales[0].options.tag).toBe('phyto-push-test-local');
    expect(resultado).toContain('aviso mostrado aquí');
    // Sin llave privada en este entorno, el servidor NO dice «enviado»: lo dice claro.
    expect(resultado).toContain('El servidor no tiene llaves push');
  }, 30000);

  it('la notificación de prueba aparece en la lista y se puede abrir', async () => {
    click('[data-tab="hoy"]');
    await waitFor(() => !$('#view-hoy').hidden, 'Hoy abierto');
    click('[data-dashboard-notifications]');
    await waitFor(() => $('#sheet').hidden === false, 'la hoja abierta');
    const filas = await waitFor(
      () => $$('#sheet-body .notice').find((row) => row.textContent.includes('Prueba de notificaciones')),
      'la notificación de prueba en la lista',
    );
    expect(filas.querySelector('.btn--xs')).not.toBeNull();
  }, 20000);

  it('«Revisar» deja su resultado en la hoja (sin silencios)', async () => {
    click('[data-tab="ajustes"]');
    await waitFor(() => !$('#view-ajustes').hidden, 'Configuración abierta');
    expect(click('#push-config [data-push-enable]')).toBe(true);
    const resultado = await waitFor(() => {
      const texto = $('#push-config [data-push-result]')?.textContent ?? '';
      return /Teléfono registrado|no quedó registrado/.test(texto) ? texto : null;
    }, 'el resultado de Revisar');
    expect(resultado).toMatch(/Teléfono registrado|no quedó registrado/);
    expect($('#push-config .notice-hint')).not.toBeNull();
  }, 20000);
});
