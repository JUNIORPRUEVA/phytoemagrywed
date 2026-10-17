// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const script = readFileSync('public/admin/composer-mobile.js', 'utf8');
let dom;
afterEach(() => dom?.window.close());

async function setup({ visualViewport = true } = {}) {
  dom = new JSDOM(`<body data-tab="whatsapp" data-wa-view="chat"><div class="app">
    <div id="thread"></div><textarea id="wa-text"></textarea>
    <button id="wa-send"><span>Enviar</span></button><button id="wa-attach">Adjuntar</button>
    </div></body>`, { runScripts: 'outside-only' });
  const win = dom.window;
  win.innerWidth = 390;
  win.innerHeight = 844;
  win.matchMedia = (query) => ({ get matches() { return query === '(pointer: coarse)' || win.innerWidth <= 979; } });
  const viewport = new win.EventTarget();
  Object.assign(viewport, { height: 844, offsetTop: 0, scale: 1 });
  if (visualViewport) Object.defineProperty(win, 'visualViewport', { value: viewport });
  const pending = [];
  win.requestAnimationFrame = (fn) => { pending.push(fn); return pending.length; };
  const tick = async () => { await Promise.resolve(); while (pending.length) pending.shift()(); };
  const thread = win.document.getElementById('thread');
  let top = 960;
  let clientHeight = 640;
  Object.defineProperties(thread, {
    scrollHeight: { get: () => 1600 },
    clientHeight: { get: () => clientHeight },
    scrollTop: { get: () => top, set: (value) => { top = Math.min(value, 1600 - clientHeight); } },
  });
  win.eval(script);
  await tick();
  return { win, viewport, tick, thread, body: win.document.body, area: win.document.getElementById('wa-text'),
    resize: async (height, offsetTop = 0) => {
      viewport.height = height; viewport.offsetTop = offsetTop; clientHeight = height - 204;
      viewport.dispatchEvent(new win.Event('resize')); await tick();
    } };
}

describe('escritura móvil con teclado', () => {
  it('no abre el teclado al entrar; adapta altura y desplazamiento al enfocarse', async () => {
    const ui = await setup();
    expect(ui.win.document.activeElement).not.toBe(ui.area);
    ui.area.focus();
    await ui.resize(450, 24);
    expect(ui.body.style.getPropertyValue('--wa-viewport-height')).toBe('450px');
    expect(ui.body.style.getPropertyValue('--wa-viewport-top')).toBe('24px');
    expect(ui.body.dataset.waKeyboard).toBe('open');
    expect(ui.thread.scrollTop).toBe(1354);
    await ui.resize(844);
    expect(ui.body.dataset.waKeyboard).toBe('closed');
  });

  it('conserva el borrador, selección y foco al abrir/cerrar el teclado', async () => {
    const ui = await setup();
    ui.area.value = 'Hola, ¿cómo estás?'; ui.area.focus(); ui.area.setSelectionRange(6, 11);
    await ui.resize(420); await ui.resize(844);
    expect(ui.area.value).toBe('Hola, ¿cómo estás?');
    expect(ui.area.selectionStart).toBe(6); expect(ui.area.selectionEnd).toBe(11);
    expect(ui.win.document.activeElement).toBe(ui.area);
  });

  it('respeta la lectura de mensajes anteriores durante el cambio de altura', async () => {
    const ui = await setup();
    ui.thread.scrollTop = 100; ui.thread.dispatchEvent(new ui.win.Event('scroll'));
    ui.area.focus(); await ui.resize(450);
    expect(ui.thread.scrollTop).toBe(100);
  });

  it('conserva el teclado al tocar Enviar y permite enfocar los adjuntos', async () => {
    const ui = await setup(); ui.area.focus();
    const pointer = (selector) => {
      const event = new ui.win.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
      ui.win.document.querySelector(selector).dispatchEvent(event); return event;
    };
    expect(pointer('#wa-send span').defaultPrevented).toBe(true);
    expect(pointer('#wa-attach').defaultPrevented).toBe(false);
    ui.win.document.getElementById('wa-send').disabled = true;
    expect(pointer('#wa-send').defaultPrevented).toBe(false);
  });

  it('retira el ajuste al salir del chat y en escritorio', async () => {
    const ui = await setup();
    ui.body.dataset.waView = 'list'; await ui.tick();
    expect(ui.body.dataset.waViewport).toBeUndefined();
    expect(ui.body.style.getPropertyValue('--wa-viewport-height')).toBe('');
    ui.body.dataset.waView = 'chat'; ui.win.innerWidth = 1280; await ui.tick();
    expect(ui.body.dataset.waViewport).toBeUndefined();
  });

  it('no confunde el zoom con el teclado', async () => {
    const ui = await setup(); ui.viewport.scale = 2; await ui.resize(422);
    expect(ui.body.dataset.waViewport).toBeUndefined();
  });

  it('funciona sin VisualViewport cuando el navegador redimensiona la ventana', async () => {
    const ui = await setup({ visualViewport: false }); ui.area.focus(); ui.win.innerHeight = 440;
    ui.win.dispatchEvent(new ui.win.Event('resize')); await ui.tick();
    expect(ui.body.style.getPropertyValue('--wa-viewport-height')).toBe('440px');
    expect(ui.body.dataset.waKeyboard).toBe('open');
  });
});
