// @vitest-environment node
/*
 * IA · SUGERIR RESPUESTA (botón flotante ✦ del chat).
 *
 * Estas pruebas fijan el comportamiento que reportó el equipo: el botón fallaba
 * «a veces» sin decir por qué. Cada caso reproduce una causa concreta:
 *   - respuestas válidas descartadas por longitud («Sí.» o una frase de 150 letras)
 *   - errores del proveedor (saldo, límite, caída) contados como «message reading»
 *   - cuota diaria gastada por intentos que fallaron
 *   - proveedor colgado sin plazo propio
 *   - fotos enviadas a un modelo que no las acepta
 *   - idioma del cliente ignorado (respondía siempre en español)
 */
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createProofreadingService } from '../server/proofreading.mjs';
import { handleProofreadingRoute } from '../server/proofreading-routes.mjs';
import { startCrmServer } from '../server/crm-server.mjs';

const API_KEY = 'sk-fake-test-not-a-real-key-123456';
const answer = (text) => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text }) } }] }) });
const httpError = (status, message = 'error') => ({ ok: false, status, json: async () => ({ error: { message } }) });

function fixture(fetchImpl, options = {}) {
  const rows = new Map();
  const settings = {
    read: async (key) => (rows.has(key) ? { value: rows.get(key) } : null),
    write: async (key, value) => { rows.set(key, value); },
  };
  const service = createProofreadingService({ settings, secret: 'server-only-secret', fetchImpl, checker: async () => () => null, ...options });
  return { service, settings, rows, fetchImpl };
}
async function habilitado(f, extra = {}) {
  await f.service.save({ apiKey: API_KEY, enabled: true, dailyLimit: 100, ...extra });
}
const clienteEscribe = (text, extra = {}) => ({ id: `m_${text.slice(0, 6)}`, direction: 'inbound', type: 'text', text, ...extra });
const equipoEscribe = (text) => ({ id: `o_${text.slice(0, 6)}`, direction: 'outbound', type: 'text', text });

describe('IA · sugerir respuesta: respuestas válidas no se tiran', () => {
  it('acepta una respuesta natural algo más larga que el tope y la recorta sin perder sentido', async () => {
    const largo = 'Claro que sí, el pedido sale hoy mismo y llega mañana temprano. Cualquier duda nos escribes por aquí y con gusto te ayudamos, quedamos atentos a tu confirmación.';
    expect(largo.length).toBeGreaterThan(140);
    const f = fixture(vi.fn(async () => answer(largo)));
    await habilitado(f);
    const r = await f.service.suggestReply({ messages: [clienteEscribe('¿Sale hoy el pedido?')], customerName: 'Ana', actorId: 'a' });
    expect(r.ai).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(140);
    expect(r.text.startsWith('Claro que sí')).toBe(true);
    expect(r.text.endsWith('.')).toBe(true);
  });

  it('acepta una respuesta corta y natural («Sí.») en vez de descartarla', async () => {
    const f = fixture(vi.fn(async () => answer('Sí.')));
    await habilitado(f);
    const r = await f.service.suggestReply({ messages: [clienteEscribe('¿Tienen disponible hoy?')], customerName: 'Ana', actorId: 'a' });
    expect(r).toMatchObject({ ai: true, text: 'Sí.' });
  });

  it('rechaza solo lo que de verdad no sirve (vacío o JSON sin texto)', async () => {
    for (const roto of ['', '   ']) {
      const f = fixture(vi.fn(async () => answer(roto)));
      await habilitado(f);
      expect(await f.service.suggestReply({ messages: [clienteEscribe('Hola')], actorId: 'a' })).toMatchObject({ ai: false, reason: 'invalid_response' });
    }
  });
});

describe('IA · sugerir respuesta: el error del proveedor se explica', () => {
  it.each([
    [402, 'provider_balance'],
    [401, 'provider_auth'],
    [429, 'rate_limited'],
    [500, 'provider_unavailable'],
    [503, 'provider_unavailable'],
  ])('HTTP %i se informa como %s (no como error de mensajes)', async (status, reason) => {
    const f = fixture(vi.fn(async () => httpError(status)));
    await habilitado(f);
    const r = await f.service.suggestReply({ messages: [clienteEscribe('¿Me confirman?')], actorId: 'a' });
    expect(r).toMatchObject({ ai: false, reason });
  });

  it('un fallo del proveedor NO gasta la cuota diaria (antes dejaba la IA muda)', async () => {
    const f = fixture(vi.fn(async () => httpError(503)));
    await habilitado(f, { dailyLimit: 3 });
    for (let i = 0; i < 6; i += 1) {
      await f.service.suggestReply({ messages: [clienteEscribe(`Mensaje ${i}`)], actorId: 'a' });
    }
    expect((await f.service.status()).usedToday).toBe(0);
    f.fetchImpl.mockImplementation(async () => answer('Claro, te ayudo.'));
    expect(await f.service.suggestReply({ messages: [clienteEscribe('Otra vez')], actorId: 'a' })).toMatchObject({ ai: true });
  });

  it('un proveedor colgado contesta dentro del plazo propio del servidor', async () => {
    const colgado = vi.fn(async () => new Promise(() => {}));
    const f = fixture(colgado, { suggestTimeoutMs: 60 });
    await habilitado(f);
    const inicio = Date.now();
    const r = await f.service.suggestReply({ messages: [clienteEscribe('¿Hola?')], actorId: 'a' });
    expect(Date.now() - inicio).toBeLessThan(1500);
    expect(r).toMatchObject({ ai: false, reason: 'timeout' });
  }, 6000);
});

describe('IA · sugerir respuesta: fotos y contexto', () => {
  it('si el modelo rechaza las fotos, se reintenta sin fotos en vez de fallar', async () => {
    const cuerpos = [];
    const f = fixture(vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      cuerpos.push(body);
      const traeFoto = JSON.stringify(body.messages).includes('image_url');
      return traeFoto ? httpError(400, 'invalid content: image_url is not supported') : answer('Claro, ya revisé la foto.');
    }));
    await habilitado(f);
    const media = new Map([['m_foto', ['data:image/png;base64,AAAA']]]);
    const r = await f.service.suggestReply({
      messages: [clienteEscribe('foto', { id: 'm_foto', type: 'image', text: 'El cliente envió una imagen.' })],
      customerName: 'Ana',
      actorId: 'a',
      media,
    });
    expect(r.ai).toBe(true);
    expect(cuerpos).toHaveLength(2);
    expect(JSON.stringify(cuerpos[1].messages)).not.toContain('image_url');
    expect(JSON.stringify(cuerpos[1].messages)).toContain('imagen');
  });

  it('arma el contexto en orden, con autor correcto, y descarta mensajes borrados o vacíos', async () => {
    const f = fixture(vi.fn(async () => answer('Claro, te ayudo.')));
    await habilitado(f);
    await f.service.suggestReply({
      messages: [
        clienteEscribe('Hola, buenas'),
        { id: 'x', direction: 'inbound', type: 'text', text: 'borrado', deleted_at: '2026-10-20T00:00:00Z' },
        equipoEscribe('Buenas, ¿en qué te ayudo?'),
        clienteEscribe('¿Tienen el de 60?'),
      ],
      customerName: 'Ana',
      actorId: 'a',
    });
    const dialog = JSON.parse(f.fetchImpl.mock.calls[0][1].body).messages.slice(1, -1);
    expect(dialog).toEqual([
      { role: 'user', content: '[RECIBIDO_DEL_CLIENTE] Hola, buenas' },
      { role: 'assistant', content: '[ENVIADO_POR_NUESTRO_EQUIPO] Buenas, ¿en qué te ayudo?' },
      { role: 'user', content: '[RECIBIDO_DEL_CLIENTE] ¿Tienen el de 60?' },
    ]);
  });

  it('no inventa el contenido de una nota de voz sin transcripción', async () => {
    const f = fixture(vi.fn(async () => answer('Recibido, ahora reviso.')));
    await habilitado(f);
    await f.service.suggestReply({
      messages: [{ id: 'a1', direction: 'inbound', type: 'audio', text: '', media: { durationMs: 8000 } }],
      customerName: 'Ana',
      actorId: 'a',
    });
    const dialog = JSON.parse(f.fetchImpl.mock.calls[0][1].body).messages.slice(1, -1);
    expect(dialog[0].content).toContain('nota de voz de 8 segundos');
    expect(dialog[0].content).not.toMatch(/dijo|preguntó|pidió/i);
  });
});

describe('IA · sugerir respuesta: idioma del cliente', () => {
  it('pide contestar en el idioma del cliente, no siempre en español', async () => {
    const f = fixture(vi.fn(async () => answer('Yes, we have it in stock.')));
    await habilitado(f);
    await f.service.suggestReply({ messages: [clienteEscribe('Do you have the 60 capsules one?')], customerName: 'Ana', actorId: 'a' });
    const system = JSON.parse(f.fetchImpl.mock.calls[0][1].body).messages.at(-1).content;
    expect(system).toMatch(/mismo idioma|idioma del cliente/i);
    expect(system).toMatch(/español/i);
  });
});

describe('IA · sugerir respuesta: el endpoint lee el hilo del servidor', () => {
  const base = (over = {}) => {
    const suggestReply = vi.fn(async () => ({ text: 'Claro, te ayudo.', ai: true }));
    const json = vi.fn();
    const messagesFor = vi.fn(async () => over.messages ?? []);
    const ctx = {
      db: { get: async () => ({ id: 'chat-1', customer_id: 'c1' }) },
      customers: { get: async () => ({ name: 'Ana' }), messagesFor },
      proofreading: { suggestReply },
      ...(over.ctx ?? {}),
    };
    return {
      args: { req: { method: 'POST' }, res: {}, ctx, actor: { id: 'a' }, can: (p) => p === 'chats.reply', canOpen: async () => true, readJson: async () => ({ conversationId: 'chat-1', messages: [{ text: 'inyectado por el navegador' }] }), json },
      suggestReply,
      messagesFor,
      json,
    };
  };

  it('pide los mensajes de ESA conversación y usa los 5 últimos en orden', async () => {
    const largo = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, direction: i % 2 ? 'outbound' : 'inbound', text: `mensaje ${i}` }));
    const h = base({ messages: largo });
    await handleProofreadingRoute({ ...h.args, route: '/api/admin/ai/reply-suggestion' });
    expect(h.messagesFor).toHaveBeenCalledWith('chat-1', { limit: 200 });
    const enviado = h.suggestReply.mock.calls[0][0].messages;
    expect(enviado.map((row) => row.text)).toEqual(['mensaje 4', 'mensaje 5', 'mensaje 6', 'mensaje 7', 'mensaje 8']);
    expect(h.json.mock.calls.at(-1)[2]).toMatchObject({ ok: true, ai: true });
  });

  it('sin permiso o con otra conversación no consulta a la IA', async () => {
    const h = base();
    await handleProofreadingRoute({ ...h.args, route: '/api/admin/ai/reply-suggestion', canOpen: async () => false });
    expect(h.suggestReply).not.toHaveBeenCalled();
    expect(h.json.mock.calls.at(-1)[1]).toBe(403);
  });
});

/* ------------------------------------------------- LECTURA REAL DEL HILO */
describe('IA · lectura del hilo contra la base real (Phase 2)', () => {
  let app, folder;
  beforeAll(async () => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'fulltech-ai-reply-'));
    app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: path.join(folder, 'ia.sqlite'), token: 'ia-reply-token', quiet: true, schedulerEnabled: false });
  });
  afterAll(async () => { await app?.close(); rmSync(folder, { recursive: true, force: true }); });

  it('entrega el hilo del más antiguo al más nuevo y el tramo reciente es el ÚLTIMO', async () => {
    const alta = await app.customers.findOrCreateByPhone({ phone: '+18095550123', name: 'Cliente Prueba IA', source: 'uat' });
    const conversation = await app.customers.conversationFor(alta.customer.id);
    for (let i = 0; i < 7; i += 1) {
      await app.collections.insert('wa_messages', {
        id: `m_prueba_${i}`,
        conversation_id: conversation.id,
        customer_id: alta.customer.id,
        direction: i % 2 ? 'outbound' : 'inbound',
        type: 'text',
        body: `mensaje ${i}`,
        created_at: new Date(Date.UTC(2026, 9, 20, 12, i)).toISOString(),
      });
    }
    const todos = await app.customers.messagesFor(conversation.id, { limit: 200 });
    expect(todos.map((row) => row.body)).toEqual(['mensaje 0', 'mensaje 1', 'mensaje 2', 'mensaje 3', 'mensaje 4', 'mensaje 5', 'mensaje 6']);
    // Lo que recibe la IA son los 5 más NUEVOS, en orden cronológico.
    const recientes = todos.slice(-5);
    expect(recientes.map((row) => row.body)).toEqual(['mensaje 2', 'mensaje 3', 'mensaje 4', 'mensaje 5', 'mensaje 6']);
    expect(recientes.at(-1).direction).toBe('inbound');
    // Y con paginación corta tampoco se pierde el último: el límite recorta por el final.
    const corto = await app.customers.messagesFor(conversation.id, { limit: 2 });
    expect(corto.map((row) => row.body)).toEqual(['mensaje 5', 'mensaje 6']);
  });
});
/* ------------------------------------------------------------------ Navegador */
describe('IA · botón ✦ en el navegador (jsdom)', () => {
  let dom;
  afterEach(() => { dom?.window.close(); vi.useRealTimers(); });
  const ok = (text) => ({ ok: true, status: 200, json: async () => ({ ok: true, ai: true, text }) });
  function setup(fetchImpl) {
    vi.useFakeTimers();
    dom = new JSDOM('<body data-tab="whatsapp" data-wa-view="chat"><button id="wa-actions" data-conversation="chat-1"></button><button id="wa-ai-reply" type="button"></button><div id="wa-composer"><textarea id="wa-text"></textarea><button id="wa-send" type="button">Enviar</button></div></body>', { url: 'https://crm.test/admin/', runScripts: 'outside-only' });
    const win = dom.window;
    win.setTimeout = setTimeout; win.clearTimeout = clearTimeout;
    class Worker { addEventListener() {} postMessage() {} terminate() {} }
    win.Worker = Worker;
    win.fetch = vi.fn(fetchImpl ?? (async () => ok('Claro, te ayudo.')));
    let sends = 0;
    const $ = (selector) => win.document.querySelector(selector);
    $('#wa-send').addEventListener('click', () => { sends += 1; });
    win.eval(readFileSync('public/admin/proofreading.js', 'utf8'));
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    const click = (selector) => $(selector).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const boton = (etiqueta) => [...win.document.querySelectorAll('#wa-ai-reply-result button')].find((b) => b.textContent === etiqueta);
    return { win, $, click, boton, flush: () => vi.advanceTimersByTimeAsync(5), get sends() { return sends; }, chat: (id) => { $('#wa-actions').dataset.conversation = id; } };
  }

  it('varias pulsaciones seguidas hacen UNA sola consulta', async () => {
    const ui = setup(() => new Promise((resolve) => setTimeout(() => resolve(ok('Hola')), 50)));
    ui.click('#wa-ai-reply'); ui.click('#wa-ai-reply'); ui.click('#wa-ai-reply');
    expect(ui.win.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60);
    expect(ui.$('#wa-ai-reply').disabled).toBe(false);
    expect(ui.$('#wa-ai-reply-result').textContent).toContain('Hola');
  });

  it('si se cambia de conversación, la respuesta que llega tarde NO se usa', async () => {
    let resolver;
    const ui = setup(() => new Promise((resolve) => { resolver = resolve; }));
    ui.click('#wa-ai-reply');
    ui.chat('chat-2');
    resolver(ok('Sugerencia del chat 1'));
    await ui.flush();
    expect(ui.$('#wa-text').value).toBe('');
    expect(ui.$('#wa-ai-reply-result')?.textContent ?? '').not.toContain('Sugerencia del chat 1');
  });

  it('un error del proveedor se explica y «Reintentar» recupera la función', async () => {
    let llamadas = 0;
    const ui = setup(async () => (++llamadas === 1
      ? { ok: true, status: 200, json: async () => ({ ok: true, ai: false, reason: 'provider_balance' }) }
      : ok('Claro, te ayudo.')));
    ui.click('#wa-ai-reply');
    await ui.flush();
    expect(ui.$('#wa-ai-reply-result').textContent).toContain('no tiene saldo');
    expect(ui.$('#wa-ai-reply').disabled).toBe(false);
    ui.boton('Reintentar').click();
    await ui.flush();
    expect(ui.$('#wa-ai-reply-result').textContent).toContain('Claro, te ayudo.');
    expect(ui.win.fetch).toHaveBeenCalledTimes(2);
  });

  it('si la IA se cuelga, avisa por plazo y el botón vuelve a quedar usable', async () => {
    const ui = setup((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
    }));
    ui.click('#wa-ai-reply');
    await vi.advanceTimersByTimeAsync(20000);
    expect(ui.$('#wa-ai-reply-result').textContent).toContain('tardó demasiado');
    expect(ui.$('#wa-ai-reply').disabled).toBe(false);
  });

  it('usa la sugerencia solo al pulsarla, sin enviar y sin pisar el borrador', async () => {
    const ui = setup();
    ui.$('#wa-text').value = 'borrador que ya tenía';
    ui.click('#wa-ai-reply');
    await ui.flush();
    expect(ui.$('#wa-text').value).toBe('borrador que ya tenía');
    expect(ui.sends).toBe(0);
    ui.boton('Usar respuesta').click();
    expect(ui.$('#wa-text').value).toBe('Claro, te ayudo.');
    expect(ui.sends).toBe(0);
  });
});
