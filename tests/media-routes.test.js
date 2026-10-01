// @vitest-environment node
/**
 * BACKEND DE MEDIA AISLADO — Graph, R2, pipeline, máquina de estados y rutas HTTP.
 *
 * Todo con dobles: ni se llama a Meta ni se sube nada a R2. Lo que se comprueba
 * aquí es el COMPORTAMIENTO: qué se guarda, en qué ORDEN, qué pasa si el proceso
 * muere a mitad, dónde se exige intervención humana y qué NO se filtra nunca
 * (bucket, `object_key`, tokens, URL de Graph, texto crudo del proveedor).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { createWhatsAppMedia } from '../server/whatsapp-media.mjs';
import { createMediaPipeline, resumeActionFor, validateBinary } from '../server/media-pipeline.mjs';
import { createMediaRoutes } from '../server/media-routes.mjs';
import { MEDIA_STATUS, SEND_STATUS } from '../server/media.mjs';
import { ffmpegInfo } from '../server/audio-normalize.mjs';

/** PNG mínimo válido (cabecera real) y un Ogg de mentira: el sniffing es lo que decide. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 9)]);

/** Texto envenenado: si aparece en cualquier salida, hay una fuga de credenciales. */
const VENENO =
  'access_token=SUPER_SECRET&R2_SECRET_ACCESS_KEY=SUPER_SECRET ' +
  'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1&access_token=SUPER_SECRET';

/** Respuesta HTTP de mentira. */
function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: null,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers ?? {};
    },
    end(body) {
      res.body = body ?? null;
    },
  };
  return res;
}

/** Traduce los nombres del modelo a columnas, igual que el repositorio real. */
const COLUMNAS = Object.freeze({
  status: 'status',
  objectKey: 'object_key',
  bucket: 'bucket',
  storageProvider: 'storage_provider',
  mimeType: 'mime_type',
  sizeBytes: 'size_bytes',
  sha256: 'sha256',
  waMessageId: 'wa_message_id',
  waMediaId: 'wa_media_id',
  errorCode: 'error_code',
  errorMessage: 'error_message',
  durationMs: 'duration_ms',
  idempotencyKey: 'idempotency_key',
  sendStatus: 'send_status',
  sendAttemptedAt: 'send_attempted_at',
  sentAt: 'sent_at',
  provider: 'provider',
  operation: 'operation',
  httpStatus: 'http_status',
  safeCode: 'safe_code',
  errorAt: 'error_at',
});

const limpiar = (value, max = 40) =>
  value === null || value === undefined || value === ''
    ? null
    : String(value).replace(/[^\w.-]/g, '').slice(0, max) || null;

/** Almacén de media en memoria con la forma del real (mismas reglas de unicidad). */
function fakeMediaStore(seed = []) {
  const rows = seed.map((row) => ({ ...row }));
  const store = {
    rows,
    async create(record) {
      const found =
        rows.find((r) => r.message_id === record.messageId && r.media_type === record.mediaType) ??
        (record.idempotencyKey ? rows.find((r) => r.idempotency_key === record.idempotencyKey) ?? null : null);
      if (found) return { ok: true, duplicate: true, media: found };
      const row = {
        id: `mrd_${rows.length + 1}`,
        message_id: record.messageId,
        wa_message_id: null,
        wa_media_id: record.waMediaId ?? null,
        media_type: record.mediaType,
        mime_type: record.mimeType ?? null,
        safe_filename: null,
        original_filename: record.originalFilename ?? null,
        storage_provider: null,
        bucket: null,
        object_key: null,
        size_bytes: null,
        sha256: null,
        width: null,
        height: null,
        duration_ms: record.durationMs ?? null,
        direction: record.direction,
        status: record.status,
        error_code: null,
        error_message: null,
        idempotency_key: record.idempotencyKey ?? null,
        send_status: record.sendStatus ?? null,
        send_attempted_at: null,
        sent_at: null,
        provider: null,
        operation: null,
        http_status: null,
        safe_code: null,
        error_at: null,
      };
      rows.push(row);
      return { ok: true, duplicate: false, media: row };
    },
    async update(id, patch) {
      const row = rows.find((r) => r.id === id);
      if (!row) return { ok: false, media: null };
      for (const [key, column] of Object.entries(COLUMNAS)) {
        if (patch[key] !== undefined) row[column] = patch[key];
      }
      return { ok: true, media: row };
    },
    async get(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async byMessage(messageId, mediaType = null) {
      const found = rows.filter((r) => r.message_id === messageId);
      return mediaType ? found.find((r) => r.media_type === mediaType) ?? null : found;
    },
    async byIdempotencyKey(key) {
      return key ? rows.find((r) => r.idempotency_key === key) ?? null : null;
    },
    async listByStatus(status, limit = 50) {
      return rows.filter((r) => r.status === status).slice(0, limit);
    },
    async listBySendStatus(sendStatus, limit = 50) {
      return rows.filter((r) => r.send_status === sendStatus).slice(0, limit);
    },
    async markFailed(id, { code = null, message = null } = {}) {
      return this.update(id, {
        status: MEDIA_STATUS.FAILED,
        errorCode: code ? String(code).slice(0, 40) : null,
        errorMessage: message ? String(message).slice(0, 200) : null,
      });
    },
    async recordFailure(id, input = {}) {
      return this.update(id, {
        status: input.status ?? MEDIA_STATUS.FAILED,
        sendStatus: input.sendStatus,
        provider: limpiar(input.provider),
        operation: limpiar(input.operation),
        httpStatus: Number.isFinite(Number(input.httpStatus)) && Number(input.httpStatus) > 0 ? Number(input.httpStatus) : null,
        safeCode: limpiar(input.safeCode, 60),
        errorCode: limpiar(input.safeCode ?? input.errorCode),
        errorMessage: null,
        errorAt: '2026-09-30T00:00:00.000Z',
      });
    },
  };
  return store;
}

const fakeStorage = (overrides = {}) => ({
  enabled: true,
  provider: 's3',
  bucket: 'phyto-media',
  calls: [],
  buffers: [],
  async put(key, buffer, contentType) {
    this.calls.push(['put', key, contentType]);
    this.buffers.push({ key, contentType, buffer });
    return { ok: true, objectKey: key, size: buffer.length };
  },
  async get(key) {
    this.calls.push(['get', key]);
    return { ok: true, status: 200, buffer: PNG, contentType: 'image/png', size: PNG.length };
  },
  async exists() {
    return { ok: true, exists: true };
  },
  async remove() {
    return { ok: true };
  },
  ...overrides,
});

/** Servicio de Meta de mentira: cuenta llamadas y deja programar el fallo. */
function fakeGraph({ upload = {}, send = {}, ...rest } = {}) {
  const graph = {
    uploads: 0,
    sends: 0,
    uploadResult: upload,
    sendResult: send,
    ...rest,
    async uploadMedia(input) {
      graph.uploads += 1;
      graph.lastUpload = input ? { mimeType: input.mimeType, buffer: input.buffer, filename: input.filename } : null;
      if (typeof graph.uploadResult === 'function') return graph.uploadResult();
      return { ok: true, mediaId: 'MEDIA_META_1', ...(graph.uploadResult ?? {}) };
    },
    async sendImage() {
      graph.sends += 1;
      if (typeof graph.sendResult === 'function') return graph.sendResult('image');
      return { ok: true, waMessageId: 'wamid.SAL1', ...(graph.sendResult ?? {}) };
    },
    async sendAudio() {
      graph.sends += 1;
      if (typeof graph.sendResult === 'function') return graph.sendResult('audio');
      return { ok: true, waMessageId: 'wamid.SAL2', ...(graph.sendResult ?? {}) };
    },
  };
  return graph;
}

/* ------------------------------------------------------------------ GRAPH */

describe('servicio de media de Meta (Graph)', () => {
  const fetchOk = (payloads) => {
    const calls = [];
    const impl = async (url, init) => {
      calls.push({ url, init });
      const payload = payloads.shift() ?? {};
      if (payload.throw) throw Object.assign(new Error('tardó'), { name: payload.throw });
      if (payload.raw) return new Response(payload.raw, { status: payload.status ?? 200, headers: payload.headers ?? {} });
      return new Response(JSON.stringify(payload.json ?? {}), { status: payload.status ?? 200, headers: { 'content-type': 'application/json' } });
    };
    impl.calls = calls;
    return impl;
  };

  it('lee la metadata del archivo (id, tipo, tamaño, sha) sin filtrar el token', async () => {
    const fetchImpl = fetchOk([{ json: { id: 'MID', url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/jpeg', file_size: 2048, sha256: 'abc' } }]);
    const service = createWhatsAppMedia({ accessToken: 'TOKEN_SECRETO', phoneNumberId: 'PN', fetchImpl });
    const result = await service.getMediaMetadata('MID');
    expect(result.ok).toBe(true);
    expect(result.media).toMatchObject({ id: 'MID', mimeType: 'image/jpeg', fileSize: 2048, sha256: 'abc' });
    expect(fetchImpl.calls[0].init.headers.authorization).toBe('Bearer TOKEN_SECRETO');
    // El token NO aparece en el resultado devuelto al resto del CRM.
    expect(JSON.stringify(result)).not.toContain('TOKEN_SECRETO');
  });

  it('descarga el archivo en dos pasos y devuelve el binario', async () => {
    const fetchImpl = fetchOk([
      { json: { id: 'MID', url: 'https://lookaside.fbsbx.com/x', mime_type: 'audio/ogg' } },
      { raw: OGG, headers: { 'content-type': 'audio/ogg' } },
    ]);
    const service = createWhatsAppMedia({ accessToken: 't', phoneNumberId: 'PN', fetchImpl });
    const result = await service.downloadMedia('MID');
    expect(result.ok).toBe(true);
    expect(result.buffer.equals(OGG)).toBe(true);
    expect(result.declaredMimeType).toBe('audio/ogg');
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('sube un archivo con multipart y devuelve el media_id de Meta', async () => {
    const fetchImpl = fetchOk([{ json: { id: 'MEDIA_NUEVO' } }]);
    const service = createWhatsAppMedia({ accessToken: 't', phoneNumberId: 'PN', fetchImpl });
    const result = await service.uploadMedia({ buffer: PNG, mimeType: 'image/png', filename: 'foto.png' });
    expect(result).toMatchObject({ ok: true, mediaId: 'MEDIA_NUEVO' });
    const call = fetchImpl.calls[0];
    expect(call.url).toContain('/PN/media');
    expect(call.init.headers['content-type']).toContain('multipart/form-data; boundary=');
    expect(call.init.body.includes(Buffer.from('name="messaging_product"'))).toBe(true);
    expect(call.init.body.includes(PNG)).toBe(true);
  });

  it('envía imagen (con caption) y audio, y devuelve el wa_message_id', async () => {
    const fetchImpl = fetchOk([{ json: { messages: [{ id: 'wamid.IMG' }] } }, { json: { messages: [{ id: 'wamid.AUD' }] } }]);
    const service = createWhatsAppMedia({ accessToken: 't', phoneNumberId: 'PN', fetchImpl });
    const img = await service.sendImage('18095551234', { mediaId: 'M1', caption: 'Mira' });
    expect(img).toMatchObject({ ok: true, waMessageId: 'wamid.IMG' });
    const cuerpo = JSON.parse(fetchImpl.calls[0].init.body);
    expect(cuerpo.image).toEqual({ id: 'M1', caption: 'Mira' });

    const aud = await service.sendAudio('18095551234', { mediaId: 'M2' });
    expect(aud).toMatchObject({ ok: true, waMessageId: 'wamid.AUD' });
    expect(JSON.parse(fetchImpl.calls[1].init.body).audio).toEqual({ id: 'M2' });
  });

  it('traduce 401/403/404/500 a un error corto y sin secretos', async () => {
    for (const status of [401, 403, 404, 500]) {
      const fetchImpl = fetchOk([{ status, json: { error: { code: status, message: 'detalle interno de Meta con token t' } } }]);
      const service = createWhatsAppMedia({ accessToken: 't', phoneNumberId: 'PN', fetchImpl });
      const result = await service.getMediaMetadata('MID');
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe(status);
      expect(JSON.stringify(result)).not.toContain('detalle interno de Meta con token');
    }
  });

  it('un timeout no revienta: devuelve código de timeout', async () => {
    const fetchImpl = fetchOk([{ throw: 'TimeoutError' }]);
    const service = createWhatsAppMedia({ accessToken: 't', phoneNumberId: 'PN', fetchImpl });
    expect(await service.getMediaMetadata('MID')).toMatchObject({ ok: false, error: { code: 'timeout' } });
  });

  it('sin configuración queda desactivado en vez de romper', async () => {
    const service = createWhatsAppMedia({});
    expect(service.enabled).toBe(false);
    expect(await service.downloadMedia('MID')).toMatchObject({ ok: false });
  });
});

/* --------------------------------------------------------------- PIPELINE */

describe('pipeline entrante', () => {
  const graphOk = (buffer = PNG, declared = 'image/png') => ({
    async downloadMedia() {
      return { ok: true, buffer, mimeType: declared, declaredMimeType: declared, declaredSha256: null };
    },
  });

  it('imagen entrante: guarda metadata y binario, y deja la fila en STORED', async () => {
    const mediaStore = fakeMediaStore();
    const storage = fakeStorage();
    const pipeline = createMediaPipeline({ mediaStore, storage, whatsappMedia: graphOk() });
    const result = await pipeline.processInbound({ messageId: 'msg_1', conversationId: 'cnv_1', media: { kind: 'image', waMediaId: 'MID1' } });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(MEDIA_STATUS.STORED);
    expect(storage.calls[0][0]).toBe('put');
    expect(result.media.object_key).toMatch(/^phytoemagry\/whatsapp\/\d{4}\/\d{2}\/conversations\/cnv_1\/msg_1\//);
    expect(result.media.sha256).toHaveLength(64);
    expect(result.media.mime_type).toBe('image/png');
  });

  it('audio entrante: mismo patrón', async () => {
    const storage = fakeStorage();
    const pipeline = createMediaPipeline({ mediaStore: fakeMediaStore(), storage, whatsappMedia: graphOk(OGG, 'audio/ogg') });
    const result = await pipeline.processInbound({ messageId: 'msg_2', conversationId: 'cnv_1', media: { kind: 'voice', waMediaId: 'MID2', durationMs: 12000 } });
    expect(result.ok).toBe(true);
    expect(result.media.media_type).toBe('voice');
    expect(result.media.duration_ms).toBe(12000);
  });

  it('si Graph falla, queda FAILED y NO se toca el almacén (el mensaje sigue)', async () => {
    const storage = fakeStorage();
    const pipeline = createMediaPipeline({
      mediaStore: fakeMediaStore(),
      storage,
      whatsappMedia: { async downloadMedia() { return { ok: false, error: { code: 404, message: 'no está' } }; } },
    });
    const result = await pipeline.processInbound({ messageId: 'msg_3', conversationId: 'cnv_1', media: { kind: 'image', waMediaId: 'MID3' } });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(MEDIA_STATUS.FAILED);
    expect(result.media.error_code).toBe('404');
    expect(storage.calls).toHaveLength(0);
  });

  it('si R2 falla, queda FAILED y se conserva la fila (reintentable)', async () => {
    const mediaStore = fakeMediaStore();
    const storage = fakeStorage({ async put() { return { ok: false, error: 'network' }; } });
    const pipeline = createMediaPipeline({ mediaStore, storage, whatsappMedia: graphOk() });
    const result = await pipeline.processInbound({ messageId: 'msg_4', conversationId: 'cnv_1', media: { kind: 'image', waMediaId: 'MID4' } });
    expect(result).toMatchObject({ ok: false, status: MEDIA_STATUS.FAILED });
    expect(mediaStore.rows).toHaveLength(1);
    expect(mediaStore.rows[0].status).toBe(MEDIA_STATUS.FAILED);
  });

  it('reintentar tras FAILED acaba en STORED y no crea una segunda fila', async () => {
    const mediaStore = fakeMediaStore();
    let cae = true;
    const storage = fakeStorage({
      async put(key, buffer, contentType) {
        if (cae) return { ok: false, error: 'network' };
        return { ok: true, objectKey: key, size: buffer.length };
      },
    });
    const pipeline = createMediaPipeline({ mediaStore, storage, whatsappMedia: graphOk() });
    const primero = await pipeline.processInbound({ messageId: 'msg_5', conversationId: 'cnv_1', media: { kind: 'image', waMediaId: 'MID5' } });
    expect(primero.ok).toBe(false);
    cae = false;
    const segundo = await pipeline.processInbound({ messageId: 'msg_5', conversationId: 'cnv_1', media: { kind: 'image', waMediaId: 'MID5' } });
    expect(segundo.ok).toBe(true);
    expect(segundo.status).toBe(MEDIA_STATUS.STORED);
    expect(mediaStore.rows).toHaveLength(1);
  });

  it('es idempotente: si ya está STORED no vuelve a descargar ni a subir', async () => {
    const mediaStore = fakeMediaStore();
    const storage = fakeStorage();
    const pipeline = createMediaPipeline({ mediaStore, storage, whatsappMedia: graphOk() });
    await pipeline.processInbound({ messageId: 'msg_6', conversationId: 'cnv_1', media: { kind: 'image', waMediaId: 'MID6' } });
    const otra = await pipeline.processInbound({ messageId: 'msg_6', conversationId: 'cnv_1', media: { kind: 'image', waMediaId: 'MID6' } });
    expect(otra).toMatchObject({ ok: true, duplicate: true });
    expect(storage.calls).toHaveLength(1);
  });

  it('un contenido que no es imagen ni audio se rechaza sin subirlo', async () => {
    const storage = fakeStorage();
    const pipeline = createMediaPipeline({
      mediaStore: fakeMediaStore(),
      storage,
      whatsappMedia: graphOk(Buffer.from('<html><script>alert(1)</script></html>'), 'image/png'),
    });
    const result = await pipeline.processInbound({ messageId: 'msg_7', conversationId: 'cnv_1', media: { kind: 'image', waMediaId: 'MID7' } });
    expect(result.ok).toBe(false);
    expect(result.media.error_code).toBe('unrecognized_type');
    expect(storage.calls).toHaveLength(0);
  });
});

describe('validación de archivos', () => {
  it('rechaza vacío, SVG/HTML disfrazados y demasiado grande', () => {
    expect(validateBinary(Buffer.alloc(0))).toMatchObject({ ok: false, code: 'empty_file' });
    expect(validateBinary(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toMatchObject({ ok: false });
    expect(validateBinary(PNG)).toMatchObject({ ok: true, mimeType: 'image/png' });
    expect(validateBinary(OGG)).toMatchObject({ ok: true, mimeType: 'audio/ogg' });
    expect(validateBinary(Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]))).toMatchObject({ ok: false, code: 'too_large' });
    expect(validateBinary(PNG, { expect: 'audio' })).toMatchObject({ ok: false, code: 'wrong_kind' });
  });
});

describe('pipeline saliente', () => {
  it('imagen: R2 primero, luego Meta, y devuelve el wa_message_id', async () => {
    const storage = fakeStorage();
    const mediaStore = fakeMediaStore();
    const whatsappMedia = fakeGraph();
    const pipeline = createMediaPipeline({ mediaStore, storage, whatsappMedia });
    const result = await pipeline.processOutbound({ direction: 'image', to: '18095551234', buffer: PNG, conversationId: 'cnv_1', messageId: 'msg_o1', caption: 'Hola' });
    expect(result).toMatchObject({ ok: true, waMessageId: 'wamid.SAL1', mediaType: 'image' });
    expect(storage.calls[0][0]).toBe('put');
    expect(whatsappMedia.uploads).toBe(1);
    expect(whatsappMedia.sends).toBe(1);
    // El archivo está guardado y el mensaje ha salido: dos estados, no uno.
    expect(mediaStore.rows[0].status).toBe(MEDIA_STATUS.STORED);
    expect(mediaStore.rows[0].send_status).toBe(SEND_STATUS.SENT);
    expect(mediaStore.rows[0].wa_message_id).toBe('wamid.SAL1');
    expect(mediaStore.rows[0].sent_at).toBeTruthy();
  });

  it('audio: mismo camino', async () => {
    const pipeline = createMediaPipeline({ mediaStore: fakeMediaStore(), storage: fakeStorage(), whatsappMedia: fakeGraph() });
    const result = await pipeline.processOutbound({ direction: 'audio', to: '18095551234', buffer: OGG, conversationId: 'cnv_1', messageId: 'msg_o2' });
    expect(result).toMatchObject({ ok: true, waMessageId: 'wamid.SAL2', mediaType: 'audio' });
  });

  it('si R2 falla NO se envía nada, no se contacta con Meta y se guarda el fallo estructurado', async () => {
    const whatsappMedia = fakeGraph();
    const mediaStore = fakeMediaStore();
    const pipeline = createMediaPipeline({
      mediaStore,
      storage: fakeStorage({ async put() { return { ok: false, error: 'network' }; } }),
      whatsappMedia,
    });
    const result = await pipeline.processOutbound({ direction: 'image', to: '1', buffer: PNG, conversationId: 'c', messageId: 'msg_o3' });
    expect(result.ok).toBe(false);
    expect(whatsappMedia.uploads).toBe(0);
    expect(whatsappMedia.sends).toBe(0);
    expect(mediaStore.rows[0]).toMatchObject({
      status: MEDIA_STATUS.FAILED,
      send_status: SEND_STATUS.FAILED,
      provider: 'r2',
      operation: 'put',
      safe_code: 'network',
    });
    expect(mediaStore.rows[0].error_message).toBeNull();
  });

  it('si la subida a Meta falla, el ARCHIVO sigue guardado y lo que falla es la entrega', async () => {
    const mediaStore = fakeMediaStore();
    const pipeline = createMediaPipeline({
      mediaStore,
      storage: fakeStorage(),
      whatsappMedia: fakeGraph({ upload: { ok: false, status: 500, error: { code: 'network', httpStatus: 500, ambiguous: true } } }),
    });
    const result = await pipeline.processOutbound({ direction: 'image', to: '1', buffer: PNG, conversationId: 'c', messageId: 'msg_o4' });
    expect(result.ok).toBe(false);
    // El binario SÍ quedó en R2: antes se marcaba FAILED y parecía perdido.
    expect(mediaStore.rows[0].status).toBe(MEDIA_STATUS.STORED);
    expect(mediaStore.rows[0].send_status).toBe(SEND_STATUS.FAILED);
    expect(mediaStore.rows[0]).toMatchObject({ provider: 'graph', operation: 'upload', http_status: 500 });
  });

  it('si Meta RECHAZA el envío (4xx) el reintento queda permitido y el motivo se guarda saneado', async () => {
    const mediaStore = fakeMediaStore();
    const pipeline = createMediaPipeline({
      mediaStore,
      storage: fakeStorage(),
      whatsappMedia: fakeGraph({
        send: { ok: false, status: 400, error: { code: 131047, httpStatus: 400, ambiguous: false, message: VENENO } },
      }),
    });
    const result = await pipeline.processOutbound({ direction: 'image', to: '1', buffer: PNG, conversationId: 'c', messageId: 'msg_o5' });
    expect(result.ok).toBe(false);
    expect(result.requiresReconciliation).toBeUndefined();
    expect(mediaStore.rows[0]).toMatchObject({ send_status: SEND_STATUS.FAILED, safe_code: '131047', http_status: 400 });
    expect(JSON.stringify(mediaStore.rows[0])).not.toContain('SUPER_SECRET');
  });

  it('con clave de idempotencia repetida NO se vuelve a enviar', async () => {
    const whatsappMedia = fakeGraph();
    const pipeline = createMediaPipeline({ mediaStore: fakeMediaStore(), storage: fakeStorage(), whatsappMedia });
    const result = await pipeline.processOutbound({
      direction: 'image', to: '1', buffer: PNG, conversationId: 'c', messageId: 'msg_o6',
      idempotencyKey: 'clave-1',
      findExistingMessage: async () => ({ id: 'msg_ya_enviado' }),
    });
    expect(result).toMatchObject({ ok: true, duplicate: true, message: { id: 'msg_ya_enviado' } });
    expect(whatsappMedia.sends).toBe(0);
    expect(whatsappMedia.uploads).toBe(0);
  });
});

/* ------------------------------- SEGURIDAD ANTE CAÍDAS (el punto crítico) */

describe('estados de entrega y seguridad ante caídas', () => {
  const out = (extra = {}) => ({
    direction: 'image',
    to: '18095551234',
    buffer: PNG,
    conversationId: 'cnv_1',
    messageId: 'msg_crash',
    idempotencyKey: 'clave-crash',
    ...extra,
  });

  it('resumeActionFor: la regla que impide el doble mensaje, en un solo sitio', () => {
    expect(resumeActionFor(null)).toBe('continue');
    expect(resumeActionFor({ send_status: SEND_STATUS.PREPARING })).toBe('continue');
    expect(resumeActionFor({ send_status: SEND_STATUS.READY_TO_SEND })).toBe('continue');
    expect(resumeActionFor({ send_status: SEND_STATUS.FAILED })).toBe('continue');
    expect(resumeActionFor({ send_status: SEND_STATUS.SENT })).toBe('done');
    expect(resumeActionFor({ send_status: null, wa_message_id: 'wamid.X' })).toBe('done');
    expect(resumeActionFor({ send_status: SEND_STATUS.SENDING })).toBe('unknown');
    expect(resumeActionFor({ send_status: SEND_STATUS.SEND_UNKNOWN })).toBe('unknown');
  });

  it('CAÍDA ANTES DE R2: ningún envío a Meta, y al retomar sale UNA sola vez', async () => {
    const mediaStore = fakeMediaStore();
    const whatsappMedia = fakeGraph();
    let cae = true;
    const storage = fakeStorage({
      async put(key, buffer, contentType) {
        this.calls.push(['put', key, contentType]);
        if (cae) throw new Error('el proceso se cayó aquí');
        return { ok: true, objectKey: key, size: buffer.length };
      },
    });
    const pipeline = createMediaPipeline({ mediaStore, storage, whatsappMedia });

    await expect(pipeline.processOutbound(out())).rejects.toThrow('se cayó');
    expect(whatsappMedia.uploads).toBe(0);
    expect(whatsappMedia.sends).toBe(0);
    expect(mediaStore.rows[0].send_status).toBe(SEND_STATUS.PREPARING);
    expect(mediaStore.rows[0].object_key).toBeNull();

    cae = false;
    const segundo = await pipeline.processOutbound(out());
    expect(segundo.ok).toBe(true);
    expect(mediaStore.rows).toHaveLength(1);
    expect(whatsappMedia.uploads).toBe(1);
    expect(whatsappMedia.sends).toBe(1);
  });

  it('CAÍDA DESPUÉS DE R2: no hay objeto duplicado y al retomar sale UNA sola vez', async () => {
    const mediaStore = fakeMediaStore();
    const whatsappMedia = fakeGraph();
    const storage = fakeStorage();
    const pipeline = createMediaPipeline({ mediaStore, storage, whatsappMedia });

    // Se cae justo al guardar el estado posterior a la subida.
    const updateOriginal = mediaStore.update.bind(mediaStore);
    let cae = true;
    mediaStore.update = async (id, patch) => {
      if (cae && patch.objectKey) throw new Error('el proceso se cayó aquí');
      return updateOriginal(id, patch);
    };

    await expect(pipeline.processOutbound(out())).rejects.toThrow('se cayó');
    expect(whatsappMedia.sends).toBe(0);

    cae = false;
    mediaStore.update = updateOriginal;
    const segundo = await pipeline.processOutbound(out());
    expect(segundo.ok).toBe(true);
    expect(mediaStore.rows).toHaveLength(1);
    // Las dos subidas van a la MISMA clave: reintentar no crea objetos nuevos.
    const claves = storage.calls.filter((c) => c[0] === 'put').map((c) => c[1]);
    expect(claves).toHaveLength(2);
    expect(new Set(claves).size).toBe(1);
    expect(whatsappMedia.sends).toBe(1);
  });

  it('CAÍDA DESPUÉS DE LA SUBIDA A META Y ANTES DEL ENVÍO: continúa UNA vez, sin resubir', async () => {
    const mediaStore = fakeMediaStore([
      {
        id: 'mrd_x', message_id: 'msg_crash', media_type: 'image', direction: 'outbound',
        status: MEDIA_STATUS.STORED, send_status: SEND_STATUS.READY_TO_SEND,
        object_key: 'phytoemagry/whatsapp/2026/09/conversations/cnv_1/msg_crash/abc.png',
        wa_media_id: 'MEDIA_META_1', idempotency_key: 'clave-crash',
        mime_type: 'image/png', size_bytes: PNG.length, sha256: 'x',
      },
    ]);
    const storage = fakeStorage();
    const whatsappMedia = fakeGraph();
    const pipeline = createMediaPipeline({ mediaStore, storage, whatsappMedia });

    const resultado = await pipeline.processOutbound(out());
    expect(resultado.ok).toBe(true);
    // El archivo no se resube ni a R2 ni a Meta: ya estaba hecho.
    expect(storage.calls.filter((c) => c[0] === 'put')).toHaveLength(0);
    expect(whatsappMedia.uploads).toBe(0);
    expect(whatsappMedia.sends).toBe(1);
    expect(mediaStore.rows).toHaveLength(1);
    expect(mediaStore.rows[0].send_status).toBe(SEND_STATUS.SENT);
  });

  it('CAÍDA DURANTE EL ENVÍO (sin respuesta fiable): SEND_UNKNOWN y NO se reintenta solo', async () => {
    const mediaStore = fakeMediaStore();
    const storage = fakeStorage();
    let respuesta = { ok: false, status: 0, error: { code: 'timeout', httpStatus: 0, ambiguous: true } };
    const whatsappMedia = fakeGraph({ send: () => respuesta });
    const pipeline = createMediaPipeline({ mediaStore, storage, whatsappMedia });

    const primero = await pipeline.processOutbound(out());
    expect(primero.ok).toBe(false);
    expect(primero.requiresReconciliation).toBe(true);
    expect(primero.error.code).toBe('send_unknown');
    expect(mediaStore.rows[0].send_status).toBe(SEND_STATUS.SEND_UNKNOWN);
    expect(mediaStore.rows[0].send_attempted_at).toBeTruthy();
    expect(mediaStore.rows[0].wa_message_id).toBeNull();
    expect(whatsappMedia.sends).toBe(1);

    // Segunda llamada idéntica (lo que haría un reintento automático): NO reenvía.
    respuesta = { ok: true, waMessageId: 'wamid.NO_DEBERIA' };
    const segundo = await pipeline.processOutbound(out());
    expect(segundo.ok).toBe(false);
    expect(segundo.requiresReconciliation).toBe(true);
    expect(whatsappMedia.sends).toBe(1);
    expect(mediaStore.rows).toHaveLength(1);
  });

  it('CAÍDA JUSTO DESPUÉS DEL SEND (fila en SENDING): se declara ambiguo, no se reenvía', async () => {
    // La fila quedó en SENDING con marca de intento: es lo que deja una caída
    // entre "grabé SENDING" y "grabé el wa_message_id".
    const mediaStore = fakeMediaStore([
      {
        id: 'mrd_y', message_id: 'msg_crash', media_type: 'image', direction: 'outbound',
        status: MEDIA_STATUS.STORED, send_status: SEND_STATUS.SENDING,
        object_key: 'k.png', wa_media_id: 'MEDIA_META_1', idempotency_key: 'clave-crash',
        send_attempted_at: '2026-09-30T10:00:00.000Z',
      },
    ]);
    const whatsappMedia = fakeGraph();
    const pipeline = createMediaPipeline({ mediaStore, storage: fakeStorage(), whatsappMedia });

    const resultado = await pipeline.processOutbound(out());
    expect(resultado.ok).toBe(false);
    expect(resultado.requiresReconciliation).toBe(true);
    expect(mediaStore.rows[0].send_status).toBe(SEND_STATUS.SEND_UNKNOWN);
    expect(whatsappMedia.sends).toBe(0);
    expect(whatsappMedia.uploads).toBe(0);
  });

  it('wa_message_id CONOCIDO: jamás se reenvía, pase lo que pase', async () => {
    const mediaStore = fakeMediaStore([
      {
        id: 'mrd_z', message_id: 'msg_crash', media_type: 'image', direction: 'outbound',
        status: MEDIA_STATUS.STORED, send_status: SEND_STATUS.SENT,
        wa_message_id: 'wamid.CONOCIDO', idempotency_key: 'clave-crash',
      },
    ]);
    const whatsappMedia = fakeGraph();
    const pipeline = createMediaPipeline({ mediaStore, storage: fakeStorage(), whatsappMedia });

    const resultado = await pipeline.processOutbound(out());
    expect(resultado).toMatchObject({ ok: true, duplicate: true, waMessageId: 'wamid.CONOCIDO' });
    expect(whatsappMedia.sends).toBe(0);
    expect(whatsappMedia.uploads).toBe(0);
    expect(mediaStore.rows).toHaveLength(1);
  });

  it('MISMA CLAVE REPETIDA: nunca crea una segunda operación ni un segundo envío', async () => {
    const mediaStore = fakeMediaStore();
    const whatsappMedia = fakeGraph();
    const storage = fakeStorage();
    const pipeline = createMediaPipeline({ mediaStore, storage, whatsappMedia });

    const primera = await pipeline.processOutbound(out());
    expect(primera.ok).toBe(true);
    const segunda = await pipeline.processOutbound(out());
    const tercera = await pipeline.processOutbound(out());

    expect(segunda).toMatchObject({ ok: true, duplicate: true, waMessageId: 'wamid.SAL1' });
    expect(tercera).toMatchObject({ ok: true, duplicate: true });
    expect(mediaStore.rows).toHaveLength(1);
    expect(whatsappMedia.sends).toBe(1);
    expect(whatsappMedia.uploads).toBe(1);
    expect(storage.calls.filter((c) => c[0] === 'put')).toHaveLength(1);
  });

  it('una clave reutilizada para otro TIPO de archivo no se confunde', async () => {
    // La operación no llegó a salir (Meta la rechazó), así que la clave sigue
    // viva: usarla para otro tipo de archivo es un error del llamante.
    const mediaStore = fakeMediaStore([
      {
        id: 'mrd_k', message_id: 'out_clave-crash', media_type: 'image', direction: 'outbound',
        status: MEDIA_STATUS.STORED, send_status: SEND_STATUS.FAILED,
        idempotency_key: 'clave-crash', wa_media_id: 'MEDIA_META_1', object_key: 'k.png', mime_type: 'image/png',
      },
    ]);
    const whatsappMedia = fakeGraph();
    const pipeline = createMediaPipeline({ mediaStore, storage: fakeStorage(), whatsappMedia });
    const otro = await pipeline.processOutbound(out({ direction: 'audio', buffer: OGG }));
    expect(otro.ok).toBe(false);
    expect(otro.error.code).toBe('key_conflict');
    expect(whatsappMedia.sends).toBe(0);
  });

  it('si la clave ya salió, se devuelve lo enviado aunque se pida otro tipo (nunca se reenvía)', async () => {
    const mediaStore = fakeMediaStore();
    const whatsappMedia = fakeGraph();
    const pipeline = createMediaPipeline({ mediaStore, storage: fakeStorage(), whatsappMedia });
    await pipeline.processOutbound(out());
    const otro = await pipeline.processOutbound(out({ direction: 'audio', buffer: OGG }));
    // Gana la garantía importante: no se manda nada más al cliente.
    expect(otro).toMatchObject({ ok: true, duplicate: true, waMessageId: 'wamid.SAL1' });
    expect(whatsappMedia.sends).toBe(1);
  });

  it('RECONCILIACIÓN: si una persona confirma que salió, se marca SENT sin reenviar', async () => {
    const mediaStore = fakeMediaStore([
      {
        id: 'mrd_r', message_id: 'msg_crash', media_type: 'image', direction: 'outbound',
        status: MEDIA_STATUS.STORED, send_status: SEND_STATUS.SEND_UNKNOWN,
        idempotency_key: 'clave-crash', wa_media_id: 'MEDIA_META_1',
      },
    ]);
    const whatsappMedia = fakeGraph();
    const pipeline = createMediaPipeline({ mediaStore, storage: fakeStorage(), whatsappMedia });

    const reconciliado = await pipeline.reconcileOutbound({ mediaId: 'mrd_r', outcome: 'sent', waMessageId: 'wamid.CONFIRMADO' });
    expect(reconciliado.ok).toBe(true);
    expect(mediaStore.rows[0].send_status).toBe(SEND_STATUS.SENT);
    expect(mediaStore.rows[0].wa_message_id).toBe('wamid.CONFIRMADO');
    expect(whatsappMedia.sends).toBe(0);
  });

  it('RECONCILIACIÓN: si confirma que NO salió, vuelve a quedar enviable y sale UNA vez', async () => {
    const mediaStore = fakeMediaStore([
      {
        id: 'mrd_r2', message_id: 'msg_crash', media_type: 'image', direction: 'outbound',
        status: MEDIA_STATUS.STORED, send_status: SEND_STATUS.SEND_UNKNOWN,
        idempotency_key: 'clave-crash', wa_media_id: 'MEDIA_META_1',
        object_key: 'k.png', mime_type: 'image/png',
      },
    ]);
    const whatsappMedia = fakeGraph();
    const pipeline = createMediaPipeline({ mediaStore, storage: fakeStorage(), whatsappMedia });

    const reconciliado = await pipeline.reconcileOutbound({ idempotencyKey: 'clave-crash', outcome: 'not_sent' });
    expect(reconciliado).toMatchObject({ ok: true, retryable: true });
    expect(mediaStore.rows[0].send_status).toBe(SEND_STATUS.READY_TO_SEND);

    const envio = await pipeline.processOutbound(out());
    expect(envio.ok).toBe(true);
    expect(whatsappMedia.sends).toBe(1);
    expect(mediaStore.rows).toHaveLength(1);
  });

  it('RECONCILIACIÓN sin decir el resultado, o sin identificador, no se aplica', async () => {
    const mediaStore = fakeMediaStore([
      { id: 'mrd_r3', message_id: 'm', media_type: 'image', direction: 'outbound', status: MEDIA_STATUS.STORED, send_status: SEND_STATUS.SEND_UNKNOWN },
    ]);
    const pipeline = createMediaPipeline({ mediaStore, storage: fakeStorage(), whatsappMedia: fakeGraph() });
    expect(await pipeline.reconcileOutbound({ mediaId: 'mrd_r3', outcome: 'quizá' })).toMatchObject({ ok: false, error: { code: 'invalid_outcome' } });
    expect(await pipeline.reconcileOutbound({ mediaId: 'mrd_r3', outcome: 'sent' })).toMatchObject({ ok: false, error: { code: 'missing_wamid' } });
    expect(await pipeline.reconcileOutbound({ mediaId: 'no-existe', outcome: 'sent', waMessageId: 'x' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(mediaStore.rows[0].send_status).toBe(SEND_STATUS.SEND_UNKNOWN);
  });
});

/* -------------------------------------------------- SANEADO DE SECRETOS */

describe('saneado de secretos en errores', () => {
  it('un error de Graph con credenciales dentro no sale del servicio', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { code: 190, message: VENENO, error_subcode: 460, error_data: { details: VENENO } } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    const service = createWhatsAppMedia({ accessToken: 'TOKEN_REAL', phoneNumberId: 'PN', fetchImpl });
    const resultado = await service.getMediaMetadata('MID');
    const serializado = JSON.stringify(resultado);
    expect(serializado).not.toContain('SUPER_SECRET');
    expect(serializado).not.toContain('access_token');
    expect(serializado).not.toContain('lookaside');
    expect(resultado.error).toMatchObject({ code: 190, httpStatus: 401, ambiguous: false });
  });

  it('ni la respuesta, ni la fila guardada, ni los logs contienen el texto del proveedor', async () => {
    const logs = [];
    const mediaStore = fakeMediaStore();
    const whatsappMedia = {
      async uploadMedia() {
        return { ok: true, mediaId: 'MEDIA_META_1' };
      },
      async sendImage() {
        return { ok: false, status: 500, error: { code: 'network', httpStatus: 500, ambiguous: true, message: VENENO } };
      },
      async sendAudio() {
        return { ok: false, error: {} };
      },
    };
    const pipeline = createMediaPipeline({ mediaStore, storage: fakeStorage(), whatsappMedia, logger: (m) => logs.push(String(m)) });

    const resultado = await pipeline.processOutbound({
      direction: 'image', to: '1', buffer: PNG, conversationId: 'c', messageId: 'msg_sec', idempotencyKey: 'clave-sec',
    });

    // Se guarda lo útil para diagnosticar...
    expect(mediaStore.rows[0]).toMatchObject({
      provider: 'graph',
      operation: 'send',
      http_status: 500,
      safe_code: 'network',
      send_status: SEND_STATUS.SEND_UNKNOWN,
    });
    expect(mediaStore.rows[0].error_at).toBeTruthy();

    // ...y NADA del texto del proveedor en ninguna salida.
    const todo = JSON.stringify({ resultado, fila: mediaStore.rows[0], logs });
    expect(todo).not.toContain('SUPER_SECRET');
    expect(todo).not.toContain('R2_SECRET_ACCESS_KEY');
    expect(todo).not.toContain('access_token');
    expect(todo).not.toContain('lookaside');
    expect(mediaStore.rows[0].error_message).toBeNull();
  });
});

/* ------------------------------------------------------------------ RUTAS */

describe('rutas de media', () => {
  const build = (overrides = {}) => {
    const mediaStore = overrides.mediaStore ?? fakeMediaStore([
      { id: 'mrd_ok', message_id: 'msg_1', media_type: 'image', mime_type: 'image/png', object_key: 'phytoemagry/a.png', status: MEDIA_STATUS.STORED, direction: 'inbound', wa_media_id: 'MID' },
    ]);
    const storage = overrides.storage ?? fakeStorage();
    const pipeline = overrides.pipeline ?? { async processInbound() { return { ok: true, status: MEDIA_STATUS.STORED }; }, async processOutbound() { return { ok: true, waMessageId: 'wamid.X', mediaType: 'image' }; } };
    const handle = createMediaRoutes({
      mediaStore, storage, pipeline,
      isAuthorized: overrides.isAuthorized ?? (() => true),
      resolveConversation: overrides.resolveConversation,
      persistOutbound: overrides.persistOutbound,
      findMessageByKey: overrides.findMessageByKey,
      logger: () => {},
    });
    return { handle, mediaStore, storage };
  };

  const run = async (handle, { route, method = 'GET', query = '', headers = {} }) => {
    const res = fakeRes();
    const handled = await handle({ route, req: { method, headers }, res, url: new URL(`http://x${route}${query}`) });
    return { res, handled };
  };

  it('exige sesión del CRM: sin autorización no se sirve ni un byte', async () => {
    const { handle, storage } = build({ isAuthorized: () => false });
    const { res } = await run(handle, { route: '/api/admin/media/mrd_ok' });
    expect(res.status).toBe(401);
    expect(storage.calls).toHaveLength(0);
  });

  it('media inexistente → 404', async () => {
    const { handle } = build();
    const { res } = await run(handle, { route: '/api/admin/media/no-existe' });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'not_found' });
  });

  it('media todavía procesándose → 409 con mensaje amable', async () => {
    const mediaStore = fakeMediaStore([{ id: 'mrd_p', message_id: 'm', media_type: 'image', status: MEDIA_STATUS.PENDING, direction: 'inbound', object_key: null }]);
    const { handle } = build({ mediaStore });
    const { res } = await run(handle, { route: '/api/admin/media/mrd_p' });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'media_pending' });
  });

  it('media FAILED → 409 y se puede reintentar', async () => {
    const mediaStore = fakeMediaStore([{ id: 'mrd_f', message_id: 'm', media_type: 'image', status: MEDIA_STATUS.FAILED, direction: 'inbound', wa_media_id: 'MID', object_key: null }]);
    const { handle } = build({ mediaStore });
    const { res } = await run(handle, { route: '/api/admin/media/mrd_f' });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'media_failed' });
  });

  it('media STORED → 200 con cabeceras privadas y sin datos internos', async () => {
    const { handle } = build();
    const { res } = await run(handle, { route: '/api/admin/media/mrd_ok' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-length']).toBe(String(PNG.length));
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.body.equals(PNG)).toBe(true);
    // Ni bucket, ni object_key, ni rutas internas en la respuesta.
    expect(JSON.stringify(res.headers)).not.toContain('phytoemagry/a.png');
    expect(JSON.stringify(res.headers)).not.toContain('phyto-media');
  });

  it('si R2 falla → 502 (no un 404 que parezca inexistente)', async () => {
    const storage = fakeStorage({ async get() { return { ok: false, error: 'network' }; } });
    const { handle } = build({ storage });
    const { res } = await run(handle, { route: '/api/admin/media/mrd_ok' });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'storage_unavailable' });
  });

  it('reintento: si ya está STORED no hace nada', async () => {
    let llamado = 0;
    const { handle } = build({ pipeline: { async processInbound() { llamado += 1; return { ok: true }; }, async processOutbound() { return { ok: true }; } } });
    const { res } = await run(handle, { route: '/api/admin/media/retry/mrd_ok', method: 'POST' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, already: true });
    expect(llamado).toBe(0);
  });

  it('reintento: sin media_id de Meta no se puede y no se destruye nada', async () => {
    const mediaStore = fakeMediaStore([{ id: 'mrd_n', message_id: 'm', media_type: 'image', status: MEDIA_STATUS.FAILED, direction: 'outbound', wa_media_id: null }]);
    const { handle } = build({ mediaStore });
    const { res } = await run(handle, { route: '/api/admin/media/retry/mrd_n', method: 'POST' });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toBe('not_retryable');
    expect(mediaStore.rows[0].status).toBe(MEDIA_STATUS.FAILED);
  });

  it('un envío AMBIGUO no se reintenta desde el reintento: exige reconciliación', async () => {
    const mediaStore = fakeMediaStore([
      { id: 'mrd_su', message_id: 'm', media_type: 'image', status: MEDIA_STATUS.STORED, direction: 'outbound', send_status: SEND_STATUS.SEND_UNKNOWN, idempotency_key: 'k' },
    ]);
    let enviados = 0;
    const { handle } = build({
      mediaStore,
      pipeline: { async processInbound() { return { ok: true }; }, async processOutbound() { enviados += 1; return { ok: true }; } },
    });
    const { res } = await run(handle, { route: '/api/admin/media/retry/mrd_su', method: 'POST' });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'send_unknown', requiresReconciliation: true });
    expect(enviados).toBe(0);
  });

  it('un envío ya entregado no se reintenta', async () => {
    const mediaStore = fakeMediaStore([
      { id: 'mrd_sent', message_id: 'm', media_type: 'image', status: MEDIA_STATUS.STORED, direction: 'outbound', send_status: SEND_STATUS.SENT, wa_message_id: 'wamid.Y' },
    ]);
    const { handle } = build({ mediaStore });
    const { res } = await run(handle, { route: '/api/admin/media/retry/mrd_sent', method: 'POST' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, already: true, sendStatus: SEND_STATUS.SENT });
  });

  it('el mismo endpoint aplica la reconciliación cuando se le dice el resultado', async () => {
    const mediaStore = fakeMediaStore([
      { id: 'mrd_rec', message_id: 'm', media_type: 'image', status: MEDIA_STATUS.STORED, direction: 'outbound', send_status: SEND_STATUS.SEND_UNKNOWN, idempotency_key: 'k' },
    ]);
    const reconciliaciones = [];
    const { handle } = build({
      mediaStore,
      pipeline: {
        async processInbound() { return { ok: true }; },
        async processOutbound() { return { ok: true }; },
        async reconcileOutbound(input) {
          reconciliaciones.push(input);
          return { ok: true, retryable: false };
        },
      },
    });
    const { res } = await run(handle, { route: '/api/admin/media/retry/mrd_rec', method: 'POST', query: '?outcome=sent&wa_message_id=wamid.Z' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, reconciled: 'sent' });
    expect(reconciliaciones[0]).toMatchObject({ mediaId: 'mrd_rec', outcome: 'sent', waMessageId: 'wamid.Z' });
  });

  it('subida: falla si el contenido no es una imagen de verdad', async () => {
    const pipeline = {
      async processOutbound() { return { ok: false, error: { code: 'unrecognized_type', message: 'El contenido del archivo no es una imagen ni un audio válidos.' } }; },
      async processInbound() { return { ok: true }; },
    };
    const { handle } = build({ pipeline, resolveConversation: async () => ({ conversation: { id: 'cnv_1' }, customer: { phone_e164: '+1809' } }) });
    const res = fakeRes();
    const req = Readable.from([Buffer.from('<html>')]);
    req.method = 'POST';
    req.headers = { 'content-type': 'image/png', 'x-phyto-filename': 'vacaciones.png' };
    await handle({ route: '/api/admin/conversations/cnv_1/media', req, res, url: new URL('http://x/api/admin/conversations/cnv_1/media?kind=image') });
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).error).toBe('unrecognized_type');
  });

  it('subida con envío ambiguo → 409 con reconciliación, no un 422 que parezca reintentable', async () => {
    const pipeline = {
      async processOutbound() {
        return { ok: false, requiresReconciliation: true, error: { code: 'send_unknown', message: 'No se puede confirmar si el mensaje llegó.' } };
      },
      async processInbound() { return { ok: true }; },
    };
    const { handle } = build({ pipeline, resolveConversation: async () => ({ conversation: { id: 'cnv_1' }, customer: { phone_e164: '+1809' } }) });
    const res = fakeRes();
    const req = Readable.from([PNG]);
    req.method = 'POST';
    req.headers = { 'content-type': 'image/png' };
    await handle({ route: '/api/admin/conversations/cnv_1/media', req, res, url: new URL('http://x/api/admin/conversations/cnv_1/media?kind=image&key=k9') });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'send_unknown', requiresReconciliation: true });
  });

  it('la respuesta de error no filtra secretos aunque el error venga envenenado', async () => {
    const pipeline = {
      async processOutbound() { return { ok: false, error: { code: 'send_failed', message: VENENO } }; },
      async processInbound() { return { ok: true }; },
    };
    const { handle } = build({ pipeline, resolveConversation: async () => ({ conversation: { id: 'cnv_1' }, customer: { phone_e164: '+1809' } }) });
    const res = fakeRes();
    const req = Readable.from([PNG]);
    req.method = 'POST';
    req.headers = { 'content-type': 'image/png' };
    await handle({ route: '/api/admin/conversations/cnv_1/media', req, res, url: new URL('http://x/api/admin/conversations/cnv_1/media?kind=image') });
    expect(res.body).not.toContain('SUPER_SECRET');
    expect(res.body).not.toContain('lookaside');
  });

  it('subida correcta: persiste el mensaje por el CRM y no filtra nada interno', async () => {
    let persistido = null;
    const { handle } = build({
      resolveConversation: async () => ({ conversation: { id: 'cnv_1' }, customer: { phone_e164: '+18095551234' } }),
      persistOutbound: async (input) => {
        persistido = input;
        return { ok: true, message: { id: 'msg_nuevo' } };
      },
    });
    const res = fakeRes();
    const req = Readable.from([PNG]);
    req.method = 'POST';
    req.headers = { 'content-type': 'image/png' };
    await handle({ route: '/api/admin/conversations/cnv_1/media', req, res, url: new URL('http://x/api/admin/conversations/cnv_1/media?kind=image&caption=Hola&key=k1') });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, message: { id: 'msg_nuevo' } });
    expect(persistido).toMatchObject({ type: 'image', waMessageId: 'wamid.X', caption: 'Hola', idempotencyKey: 'k1' });
    expect(res.body).not.toContain('object_key');
    expect(res.body).not.toContain('wamid.X');
  });

  it('no atiende rutas que no son suyas', async () => {
    const { handle } = build();
    const res = fakeRes();
    const handled = await handle({ route: '/api/admin/data', req: { method: 'GET', headers: {} }, res, url: new URL('http://x/api/admin/data') });
    expect(handled).toBe(false);
    expect(res.status).toBe(0);
  });
});

/* --------------------------------------------------- AUDIO: normalización */

/**
 * Un audio que WhatsApp NO acepta (WebM del navegador, o un Ogg con Vorbis)
 * tiene que convertirse ANTES de guardarlo y de subirlo — no después, y desde
 * luego no se manda como está para que Meta lo rechace.
 *
 * Estos tests necesitan ffmpeg de verdad (es el conversor), así que se saltan si
 * la máquina no lo tiene. Las reglas de decisión están en
 * `tests/audio-normalize.test.js`, que no depende de ffmpeg.
 */
describe.skipIf(!ffmpegInfo().available)('audio no aceptado por WhatsApp: se convierte antes de enviarlo', () => {
  const tmpAudio = mkdtempSync(path.join(os.tmpdir(), 'phyto-media-audio-'));
  const generar = (nombre, args) => {
    const salida = path.join(tmpAudio, nombre);
    const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=0.4', ...args, salida], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`ffmpeg falló: ${run.stderr}`);
    return readFileSync(salida);
  };
  afterAll(() => rmSync(tmpAudio, { recursive: true, force: true }));

  const out = (extra = {}) => ({
    direction: 'audio',
    to: '18095551234',
    conversationId: 'cnv_1',
    messageId: 'msg_audio_1',
    ...extra,
  });

  it('un WebM grabado en el navegador se guarda y se sube como Ogg/Opus', async () => {
    const webm = generar('nota.webm', ['-c:a', 'libopus', '-b:a', '24k', '-f', 'webm']);
    const storage = fakeStorage();
    const graph = fakeGraph();
    const pipeline = createMediaPipeline({ mediaStore: fakeMediaStore(), storage, whatsappMedia: graph });

    const resultado = await pipeline.processOutbound(out({ buffer: webm, declaredMime: 'audio/webm', filename: 'nota.webm' }));

    expect(resultado.ok).toBe(true);
    expect(resultado.mimeType).toBe('audio/ogg');
    expect(resultado.convertedTo).toBe('audio/ogg');
    // Lo que se sube a Meta es Ogg con Opus dentro (no el WebM original).
    expect(graph.lastUpload.mimeType).toBe('audio/ogg');
    expect(graph.lastUpload.filename).toBe('nota.ogg');
    expect(graph.lastUpload.buffer.subarray(0, 4).toString('ascii')).toBe('OggS');
    expect(graph.lastUpload.buffer.includes('OpusHead')).toBe(true);
    // Y lo que queda en R2 es EXACTAMENTE lo que se envió (un mensaje, un archivo).
    const guardado = storage.buffers.at(-1);
    expect(guardado.contentType).toBe('audio/ogg');
    expect(guardado.buffer.equals(graph.lastUpload.buffer)).toBe(true);
    expect(guardado.key.endsWith('.ogg')).toBe(true);
  }, 20000);

  it('un WebM con MIME vacío se identifica por bytes y se sube a Meta con nombre .ogg', async () => {
    const webm = generar('windows-chrome.webm', ['-c:a', 'libopus', '-b:a', '24k', '-f', 'webm']);
    const storage = fakeStorage();
    const graph = fakeGraph({
      upload: () => {
        const { filename, mimeType, buffer } = graph.lastUpload;
        if (mimeType !== 'audio/ogg' || !String(filename ?? '').endsWith('.ogg')) {
          return {
            ok: false,
            status: 400,
            error: {
              code: 100,
              httpStatus: 400,
              ambiguous: false,
              message: 'Param file must be a file with one of the following types: audio/aac, audio/mp4, audio/mpeg, audio/amr, audio/ogg, audio/opus',
            },
          };
        }
        if (!buffer.subarray(0, 4).equals(Buffer.from('OggS')) || !buffer.includes('OpusHead')) {
          return { ok: false, status: 400, error: { code: 131053, httpStatus: 400, ambiguous: false } };
        }
        return { ok: true, mediaId: 'MEDIA_META_AUDIO_OK' };
      },
    });
    const pipeline = createMediaPipeline({ mediaStore: fakeMediaStore(), storage, whatsappMedia: graph });

    const resultado = await pipeline.processOutbound(
      out({ buffer: webm, declaredMime: '', filename: 'nota-de-voz.audio', idempotencyKey: 'audio-empty-mime' }),
    );

    expect(resultado.ok).toBe(true);
    expect(resultado.mimeType).toBe('audio/ogg');
    expect(resultado.convertedTo).toBe('audio/ogg');
    expect(graph.uploads).toBe(1);
    expect(graph.lastUpload.mimeType).toBe('audio/ogg');
    expect(graph.lastUpload.filename).toBe('nota-de-voz.ogg');
    expect(storage.buffers.at(-1).contentType).toBe('audio/ogg');
    expect(storage.buffers.at(-1).buffer.equals(graph.lastUpload.buffer)).toBe(true);
    expect(graph.sends).toBe(1);
  }, 20000);

  it('un Ogg con Vorbis también se convierte (Meta solo admite Opus en Ogg)', async () => {
    const vorbis = generar('voz.ogg', ['-c:a', 'libvorbis', '-b:a', '64k']);
    const graph = fakeGraph();
    const pipeline = createMediaPipeline({ mediaStore: fakeMediaStore(), storage: fakeStorage(), whatsappMedia: graph });

    const resultado = await pipeline.processOutbound(out({ buffer: vorbis, declaredMime: 'audio/ogg', filename: 'voz.ogg' }));

    expect(resultado.ok).toBe(true);
    expect(graph.lastUpload.mimeType).toBe('audio/ogg');
    expect(graph.lastUpload.buffer.includes('OpusHead')).toBe(true);
  }, 20000);

  it('un audio que Meta ya acepta NO se toca (ni se convierte ni se reescribe)', async () => {
    const mp3 = generar('tono.mp3', ['-c:a', 'libmp3lame', '-b:a', '64k']);
    const graph = fakeGraph();
    const pipeline = createMediaPipeline({ mediaStore: fakeMediaStore(), storage: fakeStorage(), whatsappMedia: graph });

    const resultado = await pipeline.processOutbound(out({ buffer: mp3, declaredMime: 'audio/mpeg', filename: 'tono.mp3' }));

    expect(resultado.ok).toBe(true);
    expect(resultado.convertedTo).toBe(null);
    expect(graph.lastUpload.mimeType).toBe('audio/mpeg');
    expect(graph.lastUpload.buffer.equals(mp3)).toBe(true);
  }, 20000);

  it('si la conversión falla, NO se envía nada y se marca el fallo con un código claro', async () => {
    const roto = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 5)]); // WebM con basura
    const graph = fakeGraph();
    const storage = fakeStorage();
    const store = fakeMediaStore();
    const pipeline = createMediaPipeline({ mediaStore: store, storage, whatsappMedia: graph });

    const resultado = await pipeline.processOutbound(out({ buffer: roto, declaredMime: 'audio/webm', filename: 'roto.webm' }));

    expect(resultado.ok).toBe(false);
    expect(['convert_failed', 'convert_timeout', 'convert_empty']).toContain(resultado.error.code);
    expect(graph.uploads).toBe(0);
    expect(graph.sends).toBe(0);
    expect(storage.calls.filter(([accion]) => accion === 'put')).toHaveLength(0);
    // No había operación previa, así que no hay fila que marcar: no se inventa ninguna.
    expect(store.rows).toHaveLength(0);
  }, 20000);

  it('si la operación YA existía (reintento), el fallo de conversión queda escrito', async () => {
    const roto = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 5)]);
    const store = fakeMediaStore([
      {
        id: 'mrd_prev',
        message_id: 'out_k1',
        media_type: 'audio',
        direction: 'outbound',
        idempotency_key: 'k1',
        status: MEDIA_STATUS.UPLOADING,
        send_status: SEND_STATUS.PREPARING,
      },
    ]);
    const graph = fakeGraph();
    const pipeline = createMediaPipeline({ mediaStore: store, storage: fakeStorage(), whatsappMedia: graph });

    const resultado = await pipeline.processOutbound(
      out({ buffer: roto, declaredMime: 'audio/webm', filename: 'roto.webm', idempotencyKey: 'k1' }),
    );

    expect(resultado.ok).toBe(false);
    expect(graph.uploads).toBe(0);
    expect(graph.sends).toBe(0);
    expect(store.rows[0].send_status).toBe(SEND_STATUS.FAILED);
    expect(store.rows[0].safe_code).toContain('convert_');
  }, 20000);
});
