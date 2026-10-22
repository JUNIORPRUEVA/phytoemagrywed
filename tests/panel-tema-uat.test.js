// @vitest-environment node
/**
 * UAT DEL PANEL — TEMA (claro, oscuro y «como el teléfono»).
 *
 * Panel REAL (`public/admin/index.html` + `app.js`) con un CRM de verdad detrás.
 * Se comprueba lo que pidió el negocio:
 *
 *   1. Se puede ELEGIR el tema, se queda elegido y se ve en el acto.
 *   2. «Como el teléfono» sigue al sistema (y cambia si el móvil cambia).
 *   3. El tema se aplica ANTES de pintar (no hay fogonazo blanco al abrir).
 *   4. El shell (barra superior, navbar y drawer) tiene las piezas nuevas.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-tema-123';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const html = readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');
const css = readFileSync(path.join(ADMIN_DIR, 'shell-v2-tema.css'), 'utf8');

let tmpDir;
let app;
let dom;
let cookie = '';
/** El «teléfono»: aquí se decide si el sistema está en oscuro. */
let sistemaOscuro = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
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
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return true;
};

const raiz = () => dom.window.document.documentElement;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-tema-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
  });

  dom = new JSDOM(html, { url: `${app.url}/admin/`, runScripts: 'outside-only', pretendToBeVisual: false });
  const win = dom.window;
  // El «sistema»: se puede poner en oscuro desde el test.
  win.matchMedia = (query) => ({
    matches: String(query).includes('prefers-color-scheme: dark') ? sistemaOscuro : false,
    addEventListener() {},
    removeEventListener() {},
  });
  win.scrollTo = () => {};
  win.requestAnimationFrame = (callback) => win.setTimeout(callback, 0);
  win.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, `${app.url}/admin/`).toString();
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  // `sourceURL` para que, si algo revienta, la traza diga la línea de app.js.
  win.eval(`${readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8')}\n//# sourceURL=app.js`);
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  await waitFor(() => !$('#login').hidden || !$('#app').hidden, 'la pantalla de acceso');
  const input = $('#login-token');
  input.value = TOKEN;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  $('#login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !$('#app').hidden, 'el panel abierto');
  await waitFor(() => $('#stats')?.textContent?.includes('Sin responder'), 'las tarjetas de HOY');
});

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('el tema se elige y se queda elegido', () => {
  it('el panel abre el selector en Configuración (el perfil ya no lo repite)', () => {
    click('.drawer__brand');
    /*
     * La apariencia vive en el menú lateral y en Configuración. En «Mi perfil» se
     * quitó a propósito para dejarlo compacto: no debe volver a aparecer ahí.
     */
    expect($('#view-perfil [data-tema-picker]')).toBeNull();
    // Y las MISMAS opciones en Configuración, para quien las busque ahí­.
    const enAjustes = $$('#config-tema [data-tema-picker] [data-tema]');
    expect(enAjustes.map((b) => b.dataset.tema)).toEqual(['light', 'dark', 'auto']);
    expect($('#config-tema [data-tema-picker] .tema-card')).toBeTruthy();
    // Las piezas de Configuración siguen enteras (el tema no toca nada más).
    expect($('#view-ajustes')).toBeTruthy();
    expect($('#facts')).toBeTruthy();
    expect($('#metrics')).toBeTruthy();
    expect($('#audit')).toBeTruthy();
  });

  it('al elegir «Oscuro» se pone en el acto, se recuerda y el chip queda marcado', () => {
    const nativeThemes = [];
    dom.window.FulltechAppearance = { postMessage: value => nativeThemes.push(value) };
    click('[data-tema-picker] [data-tema="dark"]');
    expect(raiz().dataset.theme).toBe('dark');
    expect(raiz().dataset.tema).toBe('dark');
    expect(dom.window.localStorage.getItem('pe_tema')).toBe('dark');
    expect($('[data-tema-picker] [data-tema="dark"]').getAttribute('aria-checked')).toBe('true');
    expect($('[data-tema-picker] [data-tema="light"]').getAttribute('aria-checked')).toBe('false');
    // La barra del sistema se avisa al navegador (Android/iPhone).
    expect($('meta[name="theme-color"]').getAttribute('content')).toBe('#0b1424');
    expect($('meta[name="color-scheme"]').content).toBe('dark');
    expect(raiz().style.colorScheme).toBe('dark');
    expect(nativeThemes).toEqual(['dark']);
  });

  it('al elegir «Claro» vuelve al claro', () => {
    click('[data-tema-picker] [data-tema="light"]');
    expect(raiz().dataset.theme).toBe('light');
    expect(dom.window.localStorage.getItem('pe_tema')).toBe('light');
    expect($('meta[name="theme-color"]').getAttribute('content')).toBe('#145bd7');
    expect($('meta[name="color-scheme"]').content).toBe('light');
    expect(raiz().style.colorScheme).toBe('light');
  });

  it('«Como el teléfono» sigue al sistema (y también si el móvil cambia)', () => {
    sistemaOscuro = true;
    click('[data-tema-picker] [data-tema="auto"]');
    expect(raiz().dataset.tema).toBe('auto');
    expect(raiz().dataset.theme).toBe('dark');
    // Y si el teléfono vuelve al claro, el panel lo sigue.
    sistemaOscuro = false;
    click('[data-tema-picker] [data-tema="auto"]');
    expect(raiz().dataset.theme).toBe('light');
  });
});

describe('el tema se aplica antes de pintar', () => {
  it('el fondo raíz coincide con el tema guardado antes de cargar la app', () => {
    for (const [theme, color] of [['dark', 'rgb(11, 20, 36)'], ['light', 'rgb(244, 247, 253)']]) {
      const preview = new JSDOM(html, { url: 'https://fulltech.test/admin/', runScripts: 'outside-only' });
      try {
        preview.window.localStorage.setItem('pe_tema', theme);
        preview.window.matchMedia = () => ({ matches: false });
        preview.window.eval(preview.window.document.querySelector('head script').textContent);
        expect(preview.window.getComputedStyle(preview.window.document.documentElement).backgroundColor).toBe(color);
      } finally { preview.window.close(); }
    }
  });
  it('la identidad instalada conserva una base oscura y el mismo alcance', () => {
    const manifest = JSON.parse(readFileSync(path.join(ADMIN_DIR, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ id: '/admin/', start_url: '/admin/', scope: '/admin/', theme_color: '#0b1424', background_color: '#0b1424' });
  });
  it('el <head> deja el tema puesto antes de la hoja de estilos', () => {
    const guion = html.indexOf("localStorage.getItem('pe_tema')");
    const hoja = html.indexOf('admin.css');
    expect(guion).toBeGreaterThan(-1);
    expect(hoja).toBeGreaterThan(-1);
    expect(guion).toBeLessThan(hoja);
    // Y escribe los dos atributos que usa el CSS.
    expect(html).toContain('document.documentElement.dataset.tema');
    expect(html).toContain("document.documentElement.dataset.theme = oscuro ? 'dark' : 'light'");
  });
});

describe('el shell: barra superior, navbar y drawer', () => {  it('la hoja del shell se carga después de admin.css (es la última palabra)', () => {
    const posAdmin = html.indexOf('admin.css');
    const posShell = html.indexOf('shell-v2-tema.css');
    expect(posShell).toBeGreaterThan(posAdmin);
  });

  it('los iconos de la barra superior no dependen de un fondo translúcido', () => {
    // El fallo real: círculos translúcidos con iconos blancos sobre barra clara.
    expect(css).toMatch(/body\[data-tab='hoy'\]\s*\.dashboard-head__quick\s*\{[^}]*background:\s*var\(--pe-chip-bg\)/s);
    expect(css).not.toMatch(/\.dashboard-head__quick[^{]*\{[^}]*background:\s*rgba\(255,\s*255,\s*255,\s*0\.1[0-9]\)/s);
    // Y el aviso va con anillo del color de la barra.
    expect(css).toMatch(/\.tab__badge\s*\{[^}]*border:\s*2px solid var\(--pe-tabbar-bg\)/s);
  });

  it('la navbar es una barra pegada abajo (diseño de WhatsApp), no una pastilla flotante', () => {
    expect(css).toMatch(/\.tabs\s*\{[^}]*left:\s*0;[^}]*right:\s*0;[^}]*bottom:\s*0;/s);
    /*
     * LA RAYA DE LA BARRA ES UNA RAYA, NO UN BORDE.
     *
     * Estaba diciendo `var(--pe-line)` (un gris OPACO) y encima con un `box-shadow`
     * del mismo color: dos líneas superpuestas que el ojo leía como un borde gris
     * grueso. Ahora la barra usa la raya translúcida del sistema (al 6 %, se
     * intuye) y NO lleva segunda línea. La prueba lo fija para que no vuelva.
     */
    expect(css).toMatch(/\.tabs\s*\{[^}]*border-top:\s*1px solid var\(--pe-hairline\)/s);
    expect(css).toMatch(/--pe-hairline:\s*rgba\([^)]*0\.0[0-9]\)/);
    expect(css).not.toMatch(/\.tabs\s*\{[^}]*box-shadow:[^;}]*var\(--pe-line\)/s);
    expect(css).toMatch(/\.tabs\s*\{[^}]*border-radius:\s*0;/s);
    expect(css).toMatch(/\.tabs\s*\{[^}]*grid-template-columns:\s*repeat\(4,/s);
    // La pastilla del icono activo, con el color de la marca.
    expect(css).toMatch(/\.tab\[aria-current='true'\]::before\s*\{[^}]*background:\s*var\(--pe-brand-soft\)/s);
  });

  it('el icono del menú son tres barras que se convierten en ✕', () => {
    expect(html).toMatch(/<span class="burger"[^>]*><span><\/span><span><\/span><span><\/span><\/span>/);
    expect(css).toContain("body[data-drawer='open'] .burger span:nth-child(1)");
    expect(css).toContain('rotate(45deg)');
    expect(css).toContain('rotate(-45deg)');
    // Y el estado se marca en el <body> para que animen TODOS los botones.
    const app = readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8');
    expect(app).toContain("document.body.dataset.drawer = 'open';");
    expect(app).toContain('delete document.body.dataset.drawer;');
  });

  it('la marca Fulltech comparte la tipografía de la interfaz', () => {
    expect(css).toMatch(/--pe-brand-font:\s*var\(--pe-font\)/);
    expect(css).toMatch(/\.dashboard-head__title strong,[\s\S]*font-family:\s*var\(--pe-brand-font\)/);
  });

  it('el oscuro tiene su propia paleta (y no un negro plano)', () => {
    expect(css).toMatch(/:root\[data-theme='dark'\]\s*\{[^}]*--pe-page-bg:\s*#0b1424;/s);
    expect(css).toMatch(/:root\[data-theme='dark'\]\s*\{[^}]*--pe-brand-text:\s*#8dbbff;/s);
    expect(css).toMatch(/:root\[data-theme='dark'\]\s*\{[^}]*--pe-card-bg:\s*#152339;/s);
    // El oscuro usa superficies azuladas, distintas del negro puro.
    expect(css).not.toMatch(/:root\[data-theme='dark'\]\s*\{[^}]*--pe-page-bg:\s*#000/s);
  });
});

describe('menú lateral accesible y apariencia persistente', () => {
  it('la navegación inferior solo aparece en Hoy y se recupera al volver', async () => {
    click('.tabs [data-tab="hoy"]');
    expect($('.tabs').hidden).toBe(false);
    for (const destination of ['whatsapp','pedidos','clientes']) {
      click(`.tabs [data-tab="${destination}"]`);
      expect(dom.window.document.body.dataset.tab).toBe(destination);
      expect($('.tabs').hidden).toBe(true);
      const back = $('#mobile-header [data-simple-back]');
      expect(back).not.toBeNull();
      click(back);
      expect(dom.window.document.body.dataset.tab).toBe('hoy');
      expect($('.tabs').hidden).toBe(false);
    }
  });
  it('mantiene el foco dentro del menú y lo devuelve al cerrar con Escape', async () => {
    const opener = $('#menu');
    opener.focus();
    click(opener);
    expect($('#drawer').hidden).toBe(false);
    expect($('#drawer').getAttribute('role')).toBe('dialog');
    expect(dom.window.document.activeElement).toBe($('#drawer-close'));
    const first = $('#drawer .drawer__brand');
    const last = $('#logout-drawer');
    last.focus();
    last.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(dom.window.document.activeElement).toBe(first);
    first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(dom.window.document.activeElement).toBe(last);
    last.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => $('#drawer').hidden, 'el menú cerrado');
    expect(dom.window.document.activeElement).toBe(opener);
    expect($('#menu').getAttribute('aria-expanded')).toBe('false');
  });
  it('el selector del drawer responde al teclado sin cerrar ni perder su elección', async () => {
    click('#menu');
    const light = $('#drawer-theme [data-tema="light"]');
    click(light);
    light.focus();
    light.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(raiz().dataset.theme).toBe('dark');
    expect(dom.window.localStorage.getItem('pe_tema')).toBe('dark');
    expect($('#drawer-theme [data-tema="dark"]').getAttribute('aria-checked')).toBe('true');
    expect(dom.window.document.activeElement).toBe($('#drawer-theme [data-tema="dark"]'));
    expect($('#drawer').hidden).toBe(false);
    click('#drawer-close');
    await waitFor(() => $('#drawer').hidden, 'el menú cerrado');
    click('#menu');
    expect($('#drawer-theme [data-tema="dark"]').getAttribute('aria-checked')).toBe('true');
    click('#drawer-close');
    await waitFor(() => $('#drawer').hidden, 'el menú cerrado');
  });
});
