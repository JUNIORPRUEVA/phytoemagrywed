// @vitest-environment jsdom
/**
 * UAT DEL AUDIO ENTRANTE — del webhook al reproductor, sin recargar nada.
 *
 * FALLO REAL QUE CUBRE (2026-10-08): un cliente mandó una nota de voz, el CRM la
 * guardó en 1,7 s… y el panel se quedó diciendo «Descargando audio…» para
 * siempre. No era la descarga: la FIRMA del hilo no miraba el estado del
 * archivo, así que al pasar de «descargando» a «guardado» el hilo no se volvía a
 * pintar.
 *
 * Aquí se comprueba de punta a punta con el CRM de verdad y un Graph/almacén de
 * mentira, y con el CANAL EN VIVO (SSE) REAL: el `EventSource` del panel se
 * sustituye por uno que de verdad lee el stream del servidor, así que el repintado
 * se prueba por el mismo camino que usa el navegador:
 *
 *   1. el audio entrante se GUARDA y el CRM avisa al instante;
 *   2. el panel cambia «Descargando» por el reproductor SIN recargar y sin
 *      esperar al sondeo de 8 s;
 *   3. si la descarga revienta a mitad, la fila NO se queda colgada.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-media-vivo';
const APP_SECRET = 'uat-media-vivo-secret';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const PHONE = '18095559300';

/* Ogg/Opus de mentira pero VÁLIDO por bytes: `sniffMime` mira los primeros. */
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(4096, 7)]);

/** Almacén de mentira (misma forma que el de R2): guarda en memoria. */
const almacen = new Map();
const storageUat = {
  enabled: true,
  provider: 'r2',
  bucket: 'uat-media',
  async put(key, body) {
    almacen.set(key, Buffer.from(body));
    return { ok: true, objectKey: key };
  },
  async get(key) {
    const buffer = almacen.get(key);
    return buffer ? { ok: true, buffer } : { ok: false, error: 'not_found' };
  },
};

/** Graph de mentira: audios buenos, uno que devuelve fallo y otro que revienta. */
const descargas = [];
const whatsappMediaUat = {
  enabled: true,
  async downloadMedia(waMediaId) {
    const id = String(waMediaId).toLowerCase();
    descargas.push(String(waMediaId));
    if (id.includes('boom')) throw new Error('graph_timeout');
    if (id.includes('fail')) return { ok: false, error: { code: 'network', message: 'No se pudo conectar.' } };
    /*
     * LA DESCARGA TARDA: en producción el archivo tardó 1,7 s, y ese hueco es
     * justo el que hacía que la burbuja se quedara en «Descargando…». Sin esta
     * espera, la prueba no reproduce el fallo real (todo llegaría junto).
     */
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return { ok: true, buffer: OGG, mimeType: 'audio/ogg', declaredMimeType: 'audio/ogg' };
  },
};

const whatsappUat = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT-MEDIA',
  businessAccountId: 'WABA1',
  async sendText() {
    return { ok: true, status: 200, messageId: `wamid.UATM${Date.now()}` };
  },
  async sendTemplate() {
    return { ok: true, status: 200, messageId: `wamid.UATMT${Date.now()}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

let tmpDir;
let app;
let dom;
let cookie = '';
let conversationId = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 12000) {
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
  if (!target) throw new Error(`no existe el elemento: ${element}`);
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return true;
};
function setValue(selector, value) {
  const input = typeof selector === 'string' ? $(selector) : selector;
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  return input;
}

/** Mensaje entrante firmado (webhook real del CRM). */
async function inbound(mensaje) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: 'Ana Audio' }, wa_id: PHONE }],
              messages: [{ from: PHONE, timestamp: String(Math.floor(Date.now() / 1000)), ...mensaje }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  await fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
    },
    body: raw,
  });
}

const audioEntrante = (id, mediaId) =>
  inbound({ id, type: 'audio', audio: { id: mediaId, mime_type: 'audio/ogg; codecs=opus', sha256: 'abc', voice: true } });

/** Lectores abiertos del canal en vivo: se cancelan al final para poder cerrar. */
const lectoresSse = [];

/** Los mensajes del hilo tal y como los ve el panel (para comprobar el archivo). */
async function hilo() {
  const respuesta = await fetch(`${app.url}/api/admin/conversations/${encodeURIComponent(conversationId)}/messages`, {
    headers: { cookie },
  });
  return respuesta.json();
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-media-vivo-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsapp: whatsappUat,
    storage: storageUat,
    whatsappMedia: whatsappMediaUat,
    schedulerEnabled: false,
  });

  await inbound({
    id: 'wamid.UATM1',
    type: 'text',
    text: { body: 'Hola, quiero mi pedido' },
  });

  dom = new JSDOM(readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8'), {
    url: `${app.url}/admin/`,
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  /*
   * CANAL EN VIVO DE VERDAD: no un doble pasivo, sino un cliente SSE que lee el
   * stream del servidor y entrega los marcos al panel, igual que el navegador.
   */
  win.EventSource = class EventSourceReal {
    constructor(url) {
      this.url = String(url);
      this.listeners = new Map();
      this.readyState = 1;
      this.cerrado = false;
      fetch(`${app.url}${this.url}`, { headers: cookie ? { cookie } : {} })
        .then(async (res) => {
          const reader = res.body.getReader();
          lectoresSse.push(reader);
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read().catch(() => ({ done: true }));
            if (done || this.cerrado) return;
            buffer += decoder.decode(value, { stream: true });
            const marcos = buffer.split('\n\n');
            buffer = marcos.pop() ?? '';
            for (const marco of marcos) {
              const tipo = /^event:\s*(.+)$/m.exec(marco)?.[1]?.trim() ?? 'message';
              const datos = /^data:\s*(.+)$/m.exec(marco)?.[1]?.trim() ?? '{}';
              try {
                this.listeners.get(tipo)?.({ data: datos });
              } catch {
                /* un oyente que falla no puede tumbar el canal */
              }
            }
          }
        })
        .catch(() => {});
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    close() {
      this.cerrado = true;
      this.readyState = 2;
    }
  };
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
  setValue('#login-token', TOKEN);
  $('#login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !$('#app').hidden, 'el panel abierto');

  // Entrar en WhatsApp POR LA PESTAÑA (no en silencio): es lo que abre el canal
  // en vivo, igual que cuando una persona toca «WhatsApp» abajo.
  click('[data-tab="whatsapp"]');
  const fila = await waitFor(() => $('[data-conv]'), 'la conversación en la bandeja', 15000);
  conversationId = fila.dataset.conv;
  click(fila);
  await waitFor(() => $('#wa-chat-name')?.textContent?.includes('Ana Audio'), 'el chat abierto', 15000);
}, 90000);

afterAll(async () => {
  // El canal en vivo es una conexión abierta: si no se cancela, el servidor no
  // puede cerrar y el hook se queda esperando.
  for (const reader of lectoresSse) await reader.cancel().catch(() => {});
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('audio entrante: se guarda, se avisa y se pinta sin recargar', () => {
  it(
    'de «Descargando» al reproductor, sin recargar y ANTES del sondeo de 8 s',
    async () => {
      await audioEntrante('wamid.UATAUDIO1', 'MID-AUDIO-1');
      /*
       * El tope es 6 s a propósito: el sondeo tarda 8 s, así que si el
       * reproductor sale antes es porque el aviso en vivo del CRM funcionó.
       */
      await waitFor(() => $('[data-audio-play]'), 'el reproductor de audio en el hilo', 6000);
      expect($('#thread').textContent).not.toContain('Descargando');
      expect($('.audio__kind')).toBeTruthy();

      // Y por detrás: el archivo quedó guardado con su binario en el almacén.
      const datos = await hilo();
      const guardado = (datos.messages ?? []).find((row) => row.type === 'audio' && row.media?.status === 'STORED');
      expect(guardado).toBeTruthy();
      expect(guardado.media.mimeType).toBe('audio/ogg');
      expect(guardado.media.sizeBytes).toBe(OGG.length);
      expect(descargas).toContain('MID-AUDIO-1');
      expect(almacen.size).toBeGreaterThan(0);
    },
    40000,
  );

  it(
    'si la descarga revienta a mitad, la fila NO se queda colgada: fallo + reintentar',
    async () => {
      await audioEntrante('wamid.UATAUDIO2', 'MID-BOOM-2');
      await waitFor(() => $('#thread').textContent.includes('No se pudo descargar el audio'), 'el aviso de fallo', 20000);
      expect($('#thread').textContent).not.toContain('Descargando');
      expect($$('[data-media-retry]').length).toBe(1);
      // Y en el servidor la fila quedó en FAILED (no en DOWNLOADING para siempre).
      const datos = await hilo();
      const fallida = (datos.messages ?? []).find((row) => row.media?.status === 'FAILED');
      expect(fallida).toBeTruthy();
      expect(fallida.media.errorCode).toBeTruthy();
    },
    40000,
  );

  it(
    'un fallo «limpio» de Graph también se ve con su reintentar',
    async () => {
      await audioEntrante('wamid.UATAUDIO3', 'MID-FAIL-3');
      await waitFor(() => $$('[data-media-retry]').length >= 2, 'el segundo botón de reintentar', 20000);
      const datos = await hilo();
      const fallidas = (datos.messages ?? []).filter((row) => row.media?.status === 'FAILED');
      expect(fallidas.length).toBe(2);
      expect(fallidas.every((row) => row.media.status !== 'DOWNLOADING')).toBe(true);
    },
    40000,
  );
});
