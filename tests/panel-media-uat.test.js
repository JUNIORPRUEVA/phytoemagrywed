// @vitest-environment node
/**
 * UAT DEL PANEL CON MULTIMEDIA (S3 sobre la UI comercial S4/S5/S6).
 *
 * Se carga el panel REAL en un DOM contra un CRM de verdad (con dobles para el
 * almacén y Graph) y se recorre lo que hace el vendedor:
 *
 *   ver imagen → abrir el visor → ver audio → reproducirlo (sin autoplay) →
 *   adjuntar imagen (previsualizar y cancelar) → enviar → grabar una nota de voz
 *   (detener, previsualizar, enviar) → y comprobar que todo el flujo comercial
 *   sigue intacto (menú ⋯, pedido, comprobante).
 *
 * El micrófono y el almacén van dobles: no se toca ni Meta ni R2.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-media-panel';
const APP_SECRET = 'uat-media-secret';
const PHONE = '18095559393';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');

const png = (extra = 40) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 9)]);
const ogg = (extra = 60) => Buffer.concat([Buffer.from('OggS'), Buffer.alloc(extra, 5)]);

function audioFixture(nombre, args) {
  const salida = path.join(tmpDir, nombre);
  const run = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=0.25', ...args, salida],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(`ffmpeg no pudo generar ${nombre}: ${run.stderr}`);
  return readFileSync(salida);
}

const storage = {
  enabled: true,
  provider: 's3',
  bucket: 'uat-bucket',
  objects: new Map(),
  async put(key, buffer) {
    storage.objects.set(key, Buffer.from(buffer));
    return { ok: true, objectKey: key, size: buffer.length };
  },
  async get(key) {
    const found = storage.objects.get(key);
    return found ? { ok: true, buffer: found } : { ok: false, error: 'not_found' };
  },
};

/** Cliente de texto (el CRM lo tiene configurado junto con el de archivos). */
const textClient = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT',
  businessAccountId: 'WABA1',
  sent: [],
  async sendText(to, body) {
    textClient.sent.push({ to, body });
    return { ok: true, status: 200, messageId: `wamid.TXT${textClient.sent.length}` };
  },
  async sendTemplate(to, template) {
    textClient.sent.push({ to, template });
    return { ok: true, status: 200, messageId: `wamid.TPL${textClient.sent.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

let sends = 0;
let uploads = 0;
const graph = {
  enabled: true,
  ambiguity: false,
  async downloadImage() {},
  async downloadMedia() {
    return { ok: true, buffer: png(), mimeType: 'image/png' };
  },
  async uploadMedia() {
    return { ok: true, mediaId: `meta_${(uploads += 1)}` };
  },
  async sendImage() {
    if (graph.ambiguity) return { ok: false, error: {} };
    sends += 1;
    return { ok: true, waMessageId: `wamid.SENT${sends}` };
  },
  async sendAudio() {
    if (graph.ambiguity) return { ok: false, error: {} };
    sends += 1;
    return { ok: true, waMessageId: `wamid.SENT${sends}` };
  },
};

let tmpDir;
let app;
let dom;
let cookie = '';
let conversationId = '';
// ¿El servidor trae conversor de audio (ffmpeg)? El panel decide con este dato.
let audioNormalize = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/*
 * Presupuesto del ARRANQUE. En un CI con pocas CPU el arranque (jsdom + eval del
 * panel + login + abrir la conversación) tarda más que en local: con 3 s de
 * margen el build de Docker se caía por un «timeout esperando: el hilo con
 * archivos» que no era un fallo del producto.
 */
const BOOT_TIMEOUT = Number(process.env.PHYTO_UAT_BOOT_TIMEOUT ?? 20000);
// Menos que el tiempo máximo del propio test: así, cuando algo no llega, el
// error dice QUÉ se estaba esperando en vez de un "test timed out" pelado.
// 8 s (y no 3) porque el CI va con la CPU compartida.
async function waitFor(check, label, timeout = 8000) {
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
/**
 * Pulsa como un NAVEGADOR de verdad: devuelve `false` y no hace NADA si el
 * control está deshabilitado.
 *
 * `dispatchEvent` sí dispara el listener de un botón gris (el atributo
 * `disabled` bloquea la activación REAL del usuario, no un evento fabricado), y
 * eso convertía «comprobar que un botón gris no envía» en un envío de verdad:
 * el mensaje salía por detrás y desbarataba la CUENTA de envíos del test
 * siguiente (que esperaba un envío exacto y veía dos).
 */
const click = (element) => {
  const target = typeof element === 'string' ? $(element) : element;
  if (!target) throw new Error(`no existe el elemento: ${element}`);
  if (target.disabled === true) return false;
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return true;
};

/**
 * Elegir un archivo tal y como lo hace el teléfono: se pulsa la opción de la
 * hoja (eso prepara el selector) y el sistema entrega el archivo elegido.
 */
function pickFile(optionSelector, inputSelector, file) {
  click(optionSelector);
  const input = $(inputSelector);
  if (!input) throw new Error(`no existe el selector de archivos: ${inputSelector}`);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

/**
 * Blob/File de mentira que SÍ conserva sus bytes (el de jsdom no ofrece ni
 * `arrayBuffer()` ni `text()`, y aquí hace falta enviar el archivo de verdad).
 */
class FakeBlob {
  constructor(parts = [], options = {}) {
    this.parts = parts.map((part) => (part instanceof FakeBlob ? part.bytes : Buffer.from(part)));
    this.type = options.type ?? '';
    this.size = this.parts.reduce((total, part) => total + part.length, 0);
  }
  get bytes() {
    return Buffer.concat(this.parts);
  }
  async arrayBuffer() {
    const buffer = this.bytes;
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
}

class FakeFile extends FakeBlob {
  constructor(parts, name, options = {}) {
    super(parts, options);
    this.name = name;
    this.lastModified = options.lastModified ?? Date.now();
  }
}

/** Audio de mentira: el autoplay y el "pausar el anterior" se comprueban aquí. */
class FakeAudio {
  constructor() {
    this.src = '';
    this.currentTime = 0;
    this.duration = 42;
    this.paused = true;
    this.error = null;
    this.listeners = {};
    FakeAudio.instances.push(this);
  }
  addEventListener(type, handler) {
    (this.listeners[type] ??= []).push(handler);
  }
  fire(type) {
    for (const handler of this.listeners[type] ?? []) handler({ type });
  }
  play() {
    if (FakeAudio.failPlay) {
      // Como Chrome con un archivo que no puede decodificar: error + rechazo.
      this.error = { code: 4, message: 'no se puede decodificar' };
      this.fire('error');
      return Promise.reject(new Error('no se pudo decodificar'));
    }
    this.error = null;
    this.paused = false;
    this.fire('play');
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.fire('pause');
  }
}
FakeAudio.instances = [];
FakeAudio.failPlay = false;

/** Grabadora de mentira: dice qué tipo graba y entrega bytes al detener. */
class FakeRecorder {
  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = FakeRecorder.mimeType ?? options.mimeType ?? 'audio/ogg';
    this.state = 'inactive';
  }
  static isTypeSupported(type) {
    return type.includes('ogg') || type.includes('webm') || type.includes('mp4');
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    const blob = new dom.window.Blob([ogg()], { type: this.mimeType });
    this.ondataavailable?.({ data: blob });
    this.onstop?.();
  }
}
FakeRecorder.mimeType = 'audio/ogg;codecs=opus';

async function inbound(id, node) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: 'Ana Media' }, wa_id: PHONE }],
              messages: [{ from: PHONE, id, timestamp: String(Math.floor(Date.now() / 1000)), ...node }],
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

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-media-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    storage,
    whatsappMedia: graph,
    whatsapp: textClient,
    schedulerEnabled: false,
  });
  await inbound('wamid.UAT-TXT', { type: 'text', text: { body: 'Hola, te mando cosas' } });
  await inbound('wamid.UAT-IMG', { type: 'image', image: { id: 'IMG1', mime_type: 'image/png', caption: 'Mira' } });
  graph.downloadMedia = async () => ({ ok: true, buffer: ogg(), mimeType: 'audio/ogg' });
  await inbound('wamid.UAT-VOZ', { type: 'voice', voice: { id: 'VOZ1', mime_type: 'audio/ogg' } });

  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
  conversationId = data.conversations[0].id;
  audioNormalize = data.media?.audioNormalize === true;

  // Panel real en un DOM, apuntando a este CRM.
  dom = new JSDOM(readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8'), {
    url: `${app.url}/admin/`,
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.Audio = FakeAudio;
  win.MediaRecorder = FakeRecorder;
  win.Blob = FakeBlob;
  win.File = FakeFile;
  // jsdom no trae los "object URL": la previsualización los usa de verdad, así
  // que se sustituyen por algo que solo sirve para que el navegador no falle.
  let objectUrls = 0;
  win.URL.createObjectURL = () => `blob:uat/${++objectUrls}`;
  win.URL.revokeObjectURL = () => {};
  win.navigator.mediaDevices = {
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
  };
  win.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, `${app.url}/admin/`).toString();
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    // El cuerpo va en bytes reales (como un navegador de verdad).
    const body = init.body instanceof FakeBlob ? init.body.bytes : init.body;
    const response = await fetch(url, { ...init, body, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  win.eval(readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8'));
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));

  // Entrar y abrir la conversación con los archivos.
  await waitFor(() => !$('#login').hidden || !$('#app').hidden, 'el acceso', BOOT_TIMEOUT);
  $('#login-token').value = TOKEN;
  $('#login-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !$('#app').hidden, 'el panel', BOOT_TIMEOUT);
  click('[data-tab="whatsapp"]');
  const row = await waitFor(() => $$('[data-conv]')[0], 'la conversación', BOOT_TIMEOUT);
  click(row);
  await waitFor(() => $$('#thread .bubble').length >= 3, 'el hilo con archivos', BOOT_TIMEOUT);
}, 90000);

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('UAT del panel con multimedia', () => {
  it('la imagen entrante se ve como miniatura y se abre en el visor', async () => {
    const thumb = await waitFor(() => $('[data-media-view]'), 'la miniatura', BOOT_TIMEOUT);
    const img = thumb.querySelector('img');
    expect(img.src).toContain('/api/admin/media/');
    // Nada de enlaces al almacén: solo el endpoint privado del CRM.
    expect(img.src).not.toMatch(/uat-bucket|amazonaws|r2\.cloudflarestorage/i);

    expect($('#media-viewer').hidden).toBe(true);
    click(thumb);
    expect($('#media-viewer').hidden).toBe(false);
    expect($('#media-viewer-img').src).toContain('/api/admin/media/');
    click('#media-viewer-close');
    expect($('#media-viewer').hidden).toBe(true);
  }, 30000);

  it('el audio entrante tiene reproductor propio y NO suena solo', async () => {
    const player = await waitFor(() => $('[data-audio]'), 'el reproductor', BOOT_TIMEOUT);
    expect(player.querySelector('[data-audio-total]')).toBeTruthy();
    // Sin autoplay: no se ha creado ningún elemento de audio hasta pulsar.
    expect(FakeAudio.instances).toHaveLength(0);

    click(player.querySelector('[data-audio-play]'));
    expect(FakeAudio.instances).toHaveLength(1);
    const audio = FakeAudio.instances[0];
    expect(audio.paused).toBe(false);
    expect(audio.src).toContain('/api/admin/media/');

    // Progreso y búsqueda.
    audio.currentTime = 21;
    audio.fire('timeupdate');
    expect(player.querySelector('[data-audio-current]').textContent).toBe('0:21');
    expect(player.querySelector('[data-audio-total]').textContent).toBe('0:42');
    const seek = player.querySelector('[data-audio-seek]');
    seek.value = '500';
    seek.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(audio.currentTime).toBeCloseTo(21, 0);

    // El mismo botón pausa.
    click(player.querySelector('[data-audio-play]'));
    expect(audio.paused).toBe(true);

    // Si el audio no se puede decodificar (descarga cortada, formato raro) el
    // botón NO se queda en «pausar» fingiendo que suena.
    FakeAudio.failPlay = true;
    click(player.querySelector('[data-audio-play]'));
    await sleep(30);
    expect(audio.paused).toBe(true);
    expect(player.querySelector('[data-audio-play]').textContent).toBe('▶');
    expect(player.querySelector('[data-audio-play]').getAttribute('aria-label')).toBe('Reproducir');
    expect($('#toast').textContent).toBe('No se pudo reproducir el audio');
    FakeAudio.failPlay = false;
  }, 30000);

  it('adjuntar una imagen: previsualiza, se puede cancelar y NO se envía al elegir', async () => {
    const antes = sends;
    // El + del compositor está activo porque la multimedia lo está.
    const attach = $('[data-view="chat"] #wa-attach') ?? $('#wa-attach');
    expect(attach.disabled).toBe(false);
    click(attach);
    await waitFor(() => $('#attach-image'), 'la hoja de adjuntar');
    expect($('#attach-audio')).toBeTruthy();

    // Elegir un archivo (como el selector del teléfono).
    const file = new dom.window.File([png()], 'frasco.png', { type: 'image/png' });
    pickFile('#attach-image', '#attach-image-input', file);

    await waitFor(() => $('#attach-send'), 'la previsualización');
    expect($('.attach-preview img')).toBeTruthy();
    expect($('#attach-send').textContent).toContain('Enviar');
    expect(sends).toBe(antes); // elegir NO envía

    // Cancelar: no se envía nada.
    click('#attach-cancel');
    expect($('#sheet').hidden).toBe(true);
    expect(sends).toBe(antes);

    // Volver a elegir y ENVIAR de verdad.
    click(attach);
    await waitFor(() => $('#attach-image'), 'la hoja otra vez');
    pickFile('#attach-image', '#attach-image-input', file);
    await waitFor(() => $('#attach-caption'), 'el pie de foto');
    $('#attach-caption').value = 'Te mando el frasco';
    click('#attach-send');

    await waitFor(() => sends === antes + 1, 'la imagen enviada');
    await waitFor(() => $$('#thread .bubble--out').some((b) => b.textContent.includes('Te mando el frasco')), 'el mensaje en el hilo');
    const saliente = $$('#thread .bubble--out').find((b) => b.textContent.includes('Te mando el frasco'));
    expect(saliente.querySelector('[data-media-view]')).toBeTruthy();
  }, 30000);

  it('grabar una nota de voz: detener NO envía, y se puede previsualizar antes', async () => {
    const antes = sends;
    click($('#wa-mic') ?? $('#wa-mic'));
    await waitFor(() => $('#rec-start'), 'la hoja de grabación', 8000);
    click('#rec-start');
    await waitFor(() => !$('#rec-stop').hidden, 'grabando', 8000);
    expect($('#rec-time').textContent).toMatch(/^\d+:\d\d$/);

    click('#rec-stop');
    const preview = await waitFor(() => {
      const box = $('#rec-preview');
      return !box.hidden && box.querySelector('audio') ? box : null;
    }, 'la previsualización del audio', 8000);
    expect(preview.innerHTML).toContain('Nota de voz');
    expect($('#rec-send').hidden).toBe(false);
    expect($('#rec-reset').hidden).toBe(false);
    expect(sends).toBe(antes); // DETENER nunca envía

    // Borrar y regrabar: vuelve al principio sin enviar nada.
    click('#rec-reset');
    expect($('#rec-start').hidden).toBe(false);
    expect($('#rec-send').hidden).toBe(true);
    expect(sends).toBe(antes);

    // Grabar otra vez y enviar.
    click('#rec-start');
    await waitFor(() => !$('#rec-stop').hidden, 'grabando de nuevo', 8000);
    click('#rec-stop');
    await waitFor(() => !$('#rec-send').hidden && !$('#rec-send').disabled, 'listo para enviar', 8000);
    click('#rec-send');
    await waitFor(() => sends === antes + 1, 'la nota de voz enviada', 8000);
    // El envío llega al servidor antes de que el panel cierre la hoja: se espera.
    await waitFor(() => $('#sheet').hidden === true, 'la hoja cerrada tras enviar', 8000);
  }, 30000);

  it('si el navegador graba en webm, se envía convertido (y sin conversor, NO se finge compatibilidad)', async () => {
    FakeRecorder.mimeType = 'audio/webm;codecs=opus';
    const antes = sends;
    click($('#wa-mic'));
    await waitFor(() => $('#rec-start'), 'la hoja de grabación', 8000);
    click('#rec-start');
    await waitFor(() => !$('#rec-stop').hidden, 'grabando', 8000);
    click('#rec-stop');
    await waitFor(() => !$('#rec-send').hidden, 'la previsualización', 8000);
    // En ambos casos se avisa de que es WebM (el usuario no tiene que adivinar).
    const aviso = $('#rec-preview').textContent;
    expect(aviso).toMatch(/webm/i);

    if (audioNormalize) {
      // El CRM convierte a OGG/Opus al enviar: se puede enviar y se explica.
      expect($('#rec-send').disabled).toBe(false);
      expect(aviso).toMatch(/ogg\/opus/i);
      click('#rec-send');
      await waitFor(() => sends === antes + 1, 'la nota webm enviada convertida', 8000);
      await waitFor(() => $('#sheet').hidden === true, 'la hoja cerrada tras enviar', 8000);
    } else {
      // Sin conversor: se puede oír, pero no enviar. Y se dice la causa real.
      expect($('#rec-send').disabled).toBe(true);
      expect(aviso).toMatch(/ffmpeg|no acepta/i);
      // Un botón gris NO se puede pulsar (como en el navegador): aunque el
      // vendedor insista, no sale nada — ni ahora ni un momento después.
      expect(click('#rec-send')).toBe(false);
      await sleep(250);
      expect(sends).toBe(antes);
      click('#rec-reset');
    }
    FakeRecorder.mimeType = 'audio/ogg;codecs=opus';
  }, 30000);

  it('adjuntar un audio cuando el navegador NO dice el tipo (Windows): se envía igual', async () => {
    // El caso que dejaba al vendedor sin poder mandar nada: en Windows un .m4a o
    // un .amr llegan con `type` VACÍO, y el panel deshabilitaba «Enviar» por eso
    // — aunque el servidor sí lo acepta (él mira los BYTES, no la etiqueta).
    const antes = sends;
    click($('#wa-attach'));
    await waitFor(() => $('#attach-audio'), 'la hoja de adjuntar');
    const m4a = audioFixture('sin-tipo.m4a', ['-c:a', 'aac', '-b:a', '64k']);
    const file = new FakeFile([m4a], 'nota-de-voz.m4a', { type: '' });
    pickFile('#attach-audio', '#attach-audio-input', file);

    const enviar = await waitFor(() => $('#attach-send'), 'la previsualización del audio');
    // Se puede enviar: decide el servidor, no el navegador.
    expect(enviar.disabled).toBe(false);
    expect($('#sheet').textContent).toMatch(/comprobará el servidor/i);
    expect(sends).toBe(antes); // elegir NO envía

    click('#attach-send');
    await waitFor(() => sends === antes + 1, 'el audio adjunto enviado');
    await waitFor(() => $('#sheet').hidden === true, 'la hoja cerrada tras enviar');
  }, 30000);

  it('adjuntar un M4A (Chrome lo llama «audio/x-m4a»): se envía igual', async () => {
    // Comprobado en un navegador REAL: Chrome reporta `audio/x-m4a` para un .m4a.
    // Ese tipo no está en la lista de WhatsApp y no hay que convertir nada (por
    // dentro es audio/mp4), así que el que decide es el SERVIDOR, que mira los
    // bytes. Antes el panel se fiaba de la etiqueta y dejaba el botón muerto.
    const antes = sends;
    click($('#wa-attach'));
    await waitFor(() => $('#attach-audio'), 'la hoja de adjuntar');
    const m4a = audioFixture('chrome-x-m4a.m4a', ['-c:a', 'aac', '-b:a', '64k']);
    const file = new FakeFile([m4a], 'nota.m4a', { type: 'audio/x-m4a' });
    pickFile('#attach-audio', '#attach-audio-input', file);

    const enviar = await waitFor(() => $('#attach-send'), 'la previsualización del M4A');
    expect(enviar.disabled).toBe(false);
    click('#attach-send');
    await waitFor(() => sends === antes + 1, 'el M4A adjunto enviado');
    await waitFor(() => $('#sheet').hidden === true, 'la hoja cerrada tras enviar');
  }, 30000);

  it('adjuntar una imagen cuando el navegador NO dice el tipo: se envía igual', async () => {
    const antes = sends;
    click($('#wa-attach'));
    await waitFor(() => $('#attach-image'), 'la hoja de adjuntar');
    const file = new FakeFile([png()], 'frasco.webp', { type: '' });
    pickFile('#attach-image', '#attach-image-input', file);

    const enviar = await waitFor(() => $('#attach-send'), 'la previsualización de la imagen');
    expect(enviar.disabled).toBe(false);
    click('#attach-send');
    await waitFor(() => sends === antes + 1, 'la imagen adjunta enviada');
    await waitFor(() => $('#sheet').hidden === true, 'la hoja cerrada tras enviar');
  }, 30000);

  it('un envío ambiguo no se reintenta desde el chat y aparece en Ajustes', async () => {
    graph.ambiguity = true;
    const antes = sends;
    click($('#wa-attach'));
    await waitFor(() => $('#attach-image'), 'la hoja de adjuntar');
    const file = new dom.window.File([png()], 'ambiguo.png', { type: 'image/png' });
    pickFile('#attach-image', '#attach-image-input', file);
    await waitFor(() => $('#attach-send'), 'la previsualización');
    click('#attach-send');
    await waitFor(() => $('#sheet').hidden, 'la hoja cerrada tras el aviso');
    expect(sends).toBe(antes); // no salió nada
    graph.ambiguity = false;

    // En el chat NO aparece ningún botón de reintentar el envío ambiguo.
    expect($$('#thread [data-media-retry]').length).toBe(0);

    // En Ajustes sí, como recuperación de administración.
    click('[data-tab="ajustes"]');
    const review = await waitFor(() => {
      const box = $('#media-review');
      return box.innerHTML.includes('SEND_UNKNOWN') ? box : null;
    }, 'la cola de revisión');
    expect($('#media-review-card').hidden).toBe(false);
    expect(review.innerHTML).toContain('No salió: reintentar');
    expect(review.innerHTML).toContain('Sí salió');

    // Y la decisión queda en la auditoría.
    const audit = await (await fetch(`${app.url}/api/admin/audit?entity=message`, { headers: { cookie } })).json();
    const row = review.querySelector('[data-review-wamid]');
    row.value = 'wamid.RECONCILIADO';
    click(review.querySelector('[data-review="sent"]'));
    await waitFor(async () => {
      const after = await (await fetch(`${app.url}/api/admin/audit?entity=message`, { headers: { cookie } })).json();
      return after.entries.some((entry) => entry.action === 'message.reconciled');
    }, 'la auditoría de la reconciliación');
    expect(audit.entries.length).toBeGreaterThan(0);
  });

  it('el flujo comercial sigue intacto: menú ⋯, pedido y comprobante', async () => {
    click('[data-tab="whatsapp"]');
    const row = await waitFor(() => $$('[data-conv]')[0], 'la conversación');
    click(row);
    await waitFor(() => $('#wa-actions')?.dataset?.customer, 'el chat abierto');
    // El botón «⋯» no basta con que conserve el atributo del render anterior:
    // mientras la conversación carga, el panel lo deja DESHABILITADO (para no
    // pedir acciones sin datos) y un botón gris no se puede pulsar. Se espera a
    // que esté listo de verdad — que es lo que necesita el vendedor.
    await waitFor(() => $('#wa-actions')?.disabled === false, 'el menú ⋯ habilitado');
    click('#wa-actions');
    const menu = $('#sheet-body').innerHTML;
    for (const accion of ['Crear pedido', 'Programar seguimiento', 'Programar mensaje', 'Ver cliente']) {
      expect(menu).toContain(accion);
    }

    click('[data-order-new]');
    await waitFor(() => $('#order-lines select'), 'el formulario de pedido');
    click('#order-save');
    const title = await waitFor(() => {
      const value = $('#sheet-title').textContent;
      return value.includes('PE-') ? value : null;
    }, 'el comprobante');
    expect(title).toMatch(/PE-/);
    expect($('#sheet-body').innerHTML).toContain('Comprobante');
  }, 30000);
});
