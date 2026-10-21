// @vitest-environment node
/**
 * CORRECTOR — ESTABILIDAD (regresión de los bloqueos reales de la IA)
 *
 * Reproduce con el script REAL (`public/admin/proofreading.js`) los fallos que
 * apagaban la ayuda mientras se escribe en el panel:
 *
 *   A) `compositionstart` sin `compositionend` (teclado que no avisa) dejaba el
 *      corrector mudo hasta recargar.
 *   B) escribir seguido no producía ninguna consulta: el temporizador se
 *      reiniciaba y cerraba sobre un texto ya viejo.
 *   C) cientos de pulsaciones seguidas acababan en una sola petición.
 *   D) una respuesta que llega después de cambiar de chat no debe aplicarse.
 *   E) un Worker que nunca contesta no puede bloquear el campo ni la ayuda.
 *
 * Criterio de aceptación: escribir, detenerse, seguir, borrar, cambiar de chat y
 * repetirlo no puede dejar la ayuda desactivada ni tocar el texto.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import nspell from 'nspell';
import dictionary from 'dictionary-es-do';
import { createProofreader } from '../src/admin/proofreading-core.mjs';

const check = createProofreader(nspell(dictionary));
const script = readFileSync('public/admin/proofreading.js', 'utf8');
const CORREGIDO = 'TEXTO CORREGIDO';

let dom;
afterEach(() => { dom?.window.close(); vi.useRealTimers(); });

function setup({ fetchImpl, sinAcciones = false } = {}) {
  vi.useFakeTimers();
  const cuerpo = sinAcciones
    ? '<body data-tab="whatsapp" data-wa-view="chat"><div id="wa-conversations"><button class="conv conv--active" data-conv="chat-9">Ana</button></div><p id="wa-chat-name">Ana Ruiz</p><div id="wa-composer"><textarea id="wa-text"></textarea><button id="wa-send" type="button">Enviar</button></div></body>'
    : '<body data-tab="whatsapp" data-wa-view="chat"><button id="wa-actions" data-conversation="chat-1"></button><p id="wa-chat-name">Ana Ruiz</p><div id="wa-composer"><textarea id="wa-text"></textarea><button id="wa-send" type="button">Enviar</button></div></body>';
  dom = new JSDOM(cuerpo, { url: 'https://crm.test/admin/', runScripts: 'outside-only' });
  const win = dom.window;
  win.setTimeout = setTimeout; win.clearTimeout = clearTimeout;
  const jobs = [];
  let instance;
  class Worker {
    handlers = new Map();
    constructor() { instance = this; }
    addEventListener(type, cb) { this.handlers.set(type, cb); }
    postMessage(job) { if (job.type !== 'warmup') jobs.push(job); }
    terminate = vi.fn();
  }
  win.Worker = Worker;
  win.fetch = vi.fn(fetchImpl ?? (async () => ({ ok: true, json: async () => ({ suggestion: null }) })));
  let sends = 0;
  const $ = (s) => win.document.querySelector(s);
  $('#wa-send').addEventListener('click', () => sends++);
  win.eval(script);
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  const type = (text, composing = false) => {
    $('#wa-text').value = text;
    const event = new win.Event('input', { bubbles: true });
    Object.defineProperty(event, 'isComposing', { value: composing });
    $('#wa-text').dispatchEvent(event);
  };
  const reply = (index = jobs.length - 1, override) => {
    const job = jobs[index];
    if (!job) return;
    instance.handlers.get('message')({
      data: override || { id: job.id, review: check(job.text, { names: job.names }), suggestion: check(job.text, { ignored: job.ignored, names: job.names }) },
    });
  };
  const text = () => $('#wa-text').value;
  return { win, $, type, reply, jobs, text, get worker() { return instance; }, get sends() { return sends; } };
}

/** La IA "corrige" siempre: devuelve una edición que cubre el texto recibido. */
const iaCorrige = async (url, options) => {
  const { text } = JSON.parse(options.body);
  return { ok: true, json: async () => ({ suggestion: { start: 0, end: text.length, word: text, replacement: CORREGIDO, edits: [{ start: 0, end: text.length, word: text, replacement: CORREGIDO }] } }) };
};

describe('Corrector: estabilidad de la ayuda de IA', () => {
  it('A) un compositionstart sin compositionend no deja mudo al corrector', async () => {
    const ui = setup({ fetchImpl: iaCorrige });
    ui.$('#wa-text').dispatchEvent(new ui.win.Event('compositionstart', { bubbles: true }));
    // La persona sigue escribiendo: cada `input` dice `isComposing:false`.
    ui.type('hoas coo esta');
    await vi.advanceTimersByTimeAsync(4000);
    expect(ui.jobs.length).toBeGreaterThan(0);
    expect(ui.win.fetch).toHaveBeenCalled();
    expect(ui.$('.wa-proofreading__text').textContent).toBe(CORREGIDO);
  });

  it('A2) mientras el teclado compone no se consulta; al terminar, sí', async () => {
    const ui = setup({ fetchImpl: iaCorrige });
    ui.type('hoas coo', true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ui.jobs).toHaveLength(0);
    expect(ui.win.fetch).not.toHaveBeenCalled();
    ui.type('hoas coo esta');
    await vi.advanceTimersByTimeAsync(3000);
    expect(ui.jobs.length).toBeGreaterThan(0);
    expect(ui.win.fetch).toHaveBeenCalled();
  });

  it('B) escribir seguido durante 12 s no deja la ayuda sin respuesta', async () => {
    const ui = setup({ fetchImpl: iaCorrige });
    for (let i = 0; i < 12; i += 1) {
      ui.type(`hoas coo esta mi amigo${'o'.repeat(i)}`);
      await vi.advanceTimersByTimeAsync(800);
      ui.reply();
    }
    await vi.advanceTimersByTimeAsync(3000);
    expect(ui.win.fetch.mock.calls.length).toBeGreaterThan(2);
    // La última respuesta corresponde al último borrador y sí se muestra.
    const ultimo = JSON.parse(ui.win.fetch.mock.calls.at(-1)[1].body).text;
    expect(ultimo).toBe(ui.text());
    expect(ui.$('.wa-proofreading__text').textContent).toBe(CORREGIDO);
  });

  it('C) 100 pulsaciones seguidas: se consulta el texto final y no se toca el borrador', async () => {
    const ui = setup({ fetchImpl: iaCorrige });
    for (let i = 0; i < 100; i += 1) {
      ui.type(`hoas coo esta${'.'.repeat(i % 5)}`);
      await vi.advanceTimersByTimeAsync(30);
    }
    ui.type('hoas coo esta amigo');
    await vi.advanceTimersByTimeAsync(4000);
    expect(ui.jobs.length).toBeGreaterThan(0);
    // Una o dos consultas, y la última SIEMPRE con el texto final.
    expect(ui.win.fetch.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(ui.win.fetch.mock.calls.length).toBeLessThanOrEqual(3);
    expect(JSON.parse(ui.win.fetch.mock.calls.at(-1)[1].body).text).toBe('hoas coo esta amigo');
    expect(ui.$('.wa-proofreading__text').textContent).toBe(CORREGIDO);
    expect(ui.text()).toBe('hoas coo esta amigo');
    expect(ui.sends).toBe(0);
  });

  it('D) una respuesta que llega tras cambiar de conversación no se aplica y la ayuda sigue viva', async () => {
    let resolver;
    const ui = setup({ fetchImpl: () => new Promise((done) => { resolver = done; }) });
    ui.type('hoas coo esta');
    await vi.advanceTimersByTimeAsync(200);
    ui.reply();
    await vi.advanceTimersByTimeAsync(1400);
    expect(ui.win.fetch).toHaveBeenCalledTimes(1);
    ui.$('#wa-actions').dataset.conversation = 'chat-2';
    await vi.advanceTimersByTimeAsync(50);
    resolver({ ok: true, json: async () => ({ suggestion: { edits: [{ start: 0, end: 13, word: 'hoas coo esta', replacement: CORREGIDO }] } }) });
    await vi.advanceTimersByTimeAsync(200);
    expect(ui.$('#wa-proofreading')?.hidden ?? true).toBe(true);
    expect(ui.text()).toBe('hoas coo esta');
    ui.type('hoas coo esta otra vez');
    await vi.advanceTimersByTimeAsync(2000);
    expect(ui.jobs.length).toBeGreaterThan(1);
  });

  it('E) un Worker que nunca contesta no bloquea el campo y la ayuda se recupera', async () => {
    const ui = setup({ fetchImpl: iaCorrige });
    ui.type('hoas coo esta');
    await vi.advanceTimersByTimeAsync(8600); // watchdog de 8 s
    expect(ui.worker.terminate).toHaveBeenCalled();
    expect(ui.$('#wa-text').disabled).toBe(false);
    expect(ui.win.fetch).toHaveBeenCalled();
    ui.type('hoas coo esta amigo');
    await vi.advanceTimersByTimeAsync(3000);
    expect(ui.text()).toBe('hoas coo esta amigo');
  });

  it('F) una respuesta de 3 s se aplica igual', async () => {
    const ui = setup({
      fetchImpl: () => new Promise((done) => setTimeout(() => done({ ok: true, json: async () => ({ suggestion: { edits: [{ start: 0, end: 13, word: 'hoas coo esta', replacement: CORREGIDO }] } }) }), 3000)),
    });
    ui.type('hoas coo esta');
    await vi.advanceTimersByTimeAsync(200);
    ui.reply();
    await vi.advanceTimersByTimeAsync(6000);
    expect(ui.$('.wa-proofreading__text').textContent).toBe(CORREGIDO);
    expect(ui.text()).toBe('hoas coo esta');
  });

  it('un fallo del servidor no se cachea: el mismo texto se vuelve a consultar', async () => {
    const ui = setup({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    ui.type('hoas coo esta');
    await vi.advanceTimersByTimeAsync(200);
    ui.reply();
    await vi.advanceTimersByTimeAsync(2500);
    expect(ui.win.fetch).toHaveBeenCalledTimes(1);
    expect(ui.$('.wa-proofreading__text')?.textContent).not.toBe(CORREGIDO);
    ui.type('hoas coo esta ');
    ui.type('hoas coo esta');
    await vi.advanceTimersByTimeAsync(2500);
    expect(ui.win.fetch).toHaveBeenCalledTimes(2);
    expect(ui.text()).toBe('hoas coo esta');
  });

  it('un corte de red no se cachea: el mismo borrador se vuelve a consultar', async () => {
    let intentos = 0;
    const ui = setup({ fetchImpl: async (url, options) => { intentos += 1; if (intentos === 1) throw new Error('sin red'); return iaCorrige(url, options); } });
    ui.type('hoas coo esta');
    await vi.advanceTimersByTimeAsync(200);
    ui.reply();
    await vi.advanceTimersByTimeAsync(2500);
    expect(intentos).toBe(1);
    expect(ui.$('.wa-proofreading__text')?.textContent).not.toBe(CORREGIDO);
    ui.type('hoas coo esta ');
    ui.type('hoas coo esta');
    await vi.advanceTimersByTimeAsync(3000);
    expect(intentos).toBe(2);
    expect(ui.$('.wa-proofreading__text').textContent).toBe(CORREGIDO);
  });

  it('un 429 (límite de uso) es silencioso y no desactiva el corrector', async () => {
    let llamadas = 0;
    const ui = setup({ fetchImpl: async (url, options) => { llamadas += 1; return llamadas === 1 ? { ok: false, status: 429, json: async () => ({ ok: false, reason: 'rate_limited' }) } : iaCorrige(url, options); } });
    ui.type('hoas coo esta');
    await vi.advanceTimersByTimeAsync(200);
    ui.reply();
    await vi.advanceTimersByTimeAsync(2500);
    expect(ui.$('.wa-proofreading__text')?.textContent).not.toBe(CORREGIDO);
    expect(ui.$('#wa-text').disabled).toBe(false);
    ui.type('hoas coo esta amigo');
    await vi.advanceTimersByTimeAsync(3000);
    expect(llamadas).toBe(2);
    expect(ui.$('.wa-proofreading__text').textContent).toBe(CORREGIDO);
  });

  it('sin #wa-actions toma la conversación de la fila activa y no envía un id vacío', async () => {
    /*
     * En el panel real `#wa-actions` puede no existir. Leyendo solo de ahí el
     * corrector enviaba `conversationId: ""`, el servidor contestaba 403 y la IA
     * nunca respondía (medido en la UAT con Chromium).
     */
    const ui = setup({ fetchImpl: iaCorrige, sinAcciones: true });
    ui.type('hoas coo esta');
    await vi.advanceTimersByTimeAsync(200);
    ui.reply();
    await vi.advanceTimersByTimeAsync(3000);
    expect(ui.win.fetch).toHaveBeenCalled();
    expect(JSON.parse(ui.win.fetch.mock.calls[0][1].body)).toMatchObject({ conversationId: 'chat-9' });
    expect(ui.$('.wa-proofreading__text').textContent).toBe(CORREGIDO);
  });

  it('el diagnóstico expone estado y contadores, nunca textos ni claves', async () => {
    const ui = setup({ fetchImpl: iaCorrige });
    ui.type('hoas coo esta');
    await vi.advanceTimersByTimeAsync(3000);
    const estado = ui.win.__phytoProofreading.state();
    expect(estado).toMatchObject({ composing: false, unavailable: false, aiRunning: false });
    expect(estado.requests).toBeGreaterThan(0);
    expect(Object.keys(estado)).not.toContain('text');
    expect(JSON.stringify(estado)).not.toContain('hoas coo esta');
  });
});
