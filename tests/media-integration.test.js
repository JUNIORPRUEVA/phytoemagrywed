// @vitest-environment node
/**
 * INTEGRACIÓN DE MULTIMEDIA CON EL CRM COMERCIAL (S3 + S4/S5/S6).
 *
 * Lo que se demuestra aquí es lo que puede costar dinero si se rompe:
 *   - un archivo entrante se guarda (metadatos en la base, binario en el almacén)
 *     SIN bloquear el ACK a Meta y SIN perder la conversación si algo falla,
 *   - el archivo se sirve SOLO con sesión del panel y sin filtrar nada interno,
 *   - un mensaje saliente con archivo se persiste en el hilo como cualquier otro,
 *   - la MISMA clave de idempotencia no puede provocar un segundo envío,
 *   - un envío ambiguo (sin respuesta fiable de Meta) queda para recuperación
 *     manual y NO se reintenta solo.
 *
 * El almacén de ficheros y Graph van con dobles: nada sale a Internet y no se
 * toca Meta.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';
import { toSqlite } from '../server/sql-query.mjs';
import { MEDIA_STATUS, SEND_STATUS } from '../server/media.mjs';

const TOKEN = 'clave-media-123';
const APP_SECRET = 'secreto-media';
const PHONE = '18095559292';

/** PNG mínimo válido para el validador (mira la firma, no la imagen). */
const png = (extra = 40) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 7)]);

/** OGG mínimo (cabecera `OggS`): es lo que graba el navegador. */
const ogg = (extra = 40) => Buffer.concat([Buffer.from('OggS'), Buffer.alloc(extra, 3)]);

const fakeStorage = {
  enabled: true,
  provider: 's3',
  bucket: 'phyto-uat',
  objects: new Map(),
  broken: false,
  async put(objectKey, buffer) {
    if (fakeStorage.broken) return { ok: false, error: 'storage_unavailable' };
    fakeStorage.objects.set(objectKey, Buffer.from(buffer));
    return { ok: true, objectKey, size: buffer.length };
  },
  async get(objectKey) {
    const found = fakeStorage.objects.get(objectKey);
    return found ? { ok: true, buffer: found } : { ok: false, error: 'not_found' };
  },
};

let graphCounter = 0;
const fakeMedia = {
  enabled: true,
  downloads: 0,
  uploads: 0,
  sends: [],
  failDownload: null,
  /** `null` = respuesta ambigua (timeout / 5xx): Meta pudo recibirlo. */
  ambiguity: false,
  rejectSend: null,
  async downloadMedia(waMediaId) {
    fakeMedia.downloads += 1;
    if (fakeMedia.failDownload) return { ok: false, error: fakeMedia.failDownload };
    return { ok: true, buffer: png(), mimeType: 'image/png', declaredMimeType: 'image/png', waMediaId };
  },
  async uploadMedia({ mimeType }) {
    fakeMedia.uploads += 1;
    graphCounter += 1;
    return { ok: true, mediaId: `meta_${graphCounter}_${mimeType}` };
  },
  async sendImage(to, { mediaId, caption }) {
    if (fakeMedia.rejectSend) return { ok: false, error: fakeMedia.rejectSend };
    if (fakeMedia.ambiguity) return { ok: false, error: {} };
    fakeMedia.sends.push({ to, mediaId, caption, kind: 'image' });
    return { ok: true, waMessageId: `wamid.IMG${fakeMedia.sends.length}` };
  },
  async sendAudio(to, { mediaId }) {
    if (fakeMedia.rejectSend) return { ok: false, error: fakeMedia.rejectSend };
    if (fakeMedia.ambiguity) return { ok: false, error: {} };
    fakeMedia.sends.push({ to, mediaId, kind: 'audio' });
    return { ok: true, waMessageId: `wamid.AUD${fakeMedia.sends.length}` };
  },
};

let tmpDir;
let dbFile;
let app;
let cookie = '';
let conversationId = '';
let customerId = '';

const call = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
  });
const json = async (response) => JSON.parse(await response.text());
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

/** Mensaje entrante de Meta (texto o con archivo). */
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
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  const response = await fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
  return response;
}

/** Sube un archivo como lo hace el compositor del panel: bytes crudos. */
const upload = (kind, buffer, params = {}) => {
  const query = new URLSearchParams({ kind, ...params }).toString();
  return fetch(`${app.url}/api/admin/conversations/${conversationId}/media?${query}`, {
    method: 'POST',
    headers: { cookie, 'content-type': kind === 'audio' ? 'audio/ogg' : 'image/png' },
    body: buffer,
  });
};

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-media-'));
  dbFile = path.join(tmpDir, 'phytoemagry.sqlite');
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: dbFile,
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    storage: fakeStorage,
    whatsappMedia: fakeMedia,
    schedulerEnabled: false,
  });
  const login = await call('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  await inbound('wamid.MEDIA-TXT', { type: 'text', text: { body: 'Hola, te mando una foto' } });
  const conversations = await waitFor(async () => {
    const data = await json(await call('/api/admin/conversations'));
    return data.conversations.length ? data.conversations : null;
  }, 'la conversación');
  const conversation = conversations.find((row) => row.customer?.phone_e164 === `+${PHONE}`);
  conversationId = conversation.id;
  customerId = conversation.customer_id;
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('adaptador SQL (PostgreSQL y SQLite con la MISMA consulta)', () => {
  it('traduce los marcadores y reordena los valores', () => {
    expect(toSqlite('SELECT * FROM t WHERE a = $2 AND b = $1', ['uno', 'dos'])).toEqual({
      sql: 'SELECT * FROM t WHERE a = ? AND b = ?',
      values: ['dos', 'uno'],
    });
    // Un `$1` repetido no puede perder su valor.
    expect(toSqlite('UPDATE t SET a = $1 WHERE b = $1', ['x']).values).toEqual(['x', 'x']);
  });

  it('expande `= ANY($1)` a `IN (?, ?)` para SQLite', () => {
    expect(toSqlite('SELECT * FROM t WHERE id = ANY($1)', [['a', 'b', 'c']])).toEqual({
      sql: 'SELECT * FROM t WHERE id IN (?, ?, ?)',
      values: ['a', 'b', 'c'],
    });
    expect(toSqlite('SELECT * FROM t WHERE id = ANY($1)', [[]]).sql).toBe('SELECT * FROM t WHERE id IN (NULL)');
  });
});

describe('entrante con archivo (imagen y audio)', () => {
  it('guarda la imagen: el mensaje queda y el archivo se sirve con sesión', async () => {
    await inbound('wamid.MEDIA-IMG', {
      type: 'image',
      image: { id: 'MEDIA_IMG_1', mime_type: 'image/png', caption: 'Mira esto' },
    });
    const thread = await waitFor(async () => {
      const data = await json(await call(`/api/admin/conversations/${conversationId}/messages`));
      const found = data.messages.find((message) => message.wa_message_id === 'wamid.MEDIA-IMG');
      return found?.media?.status === MEDIA_STATUS.STORED ? data : null;
    }, 'la imagen descargada y guardada');

    const message = thread.messages.find((row) => row.wa_message_id === 'wamid.MEDIA-IMG');
    expect(message.type).toBe('image');
    expect(message.body).toBe('Mira esto');
    expect(message.media.status).toBe(MEDIA_STATUS.STORED);
    expect(message.media.mimeType).toBe('image/png');
    expect(message.media.sizeBytes).toBeGreaterThan(8);
    // El hilo NUNCA lleva la clave del objeto ni el bucket.
    expect(JSON.stringify(message.media)).not.toMatch(/phytoemagry\/|phyto-uat|object_key/);

    const file = await fetch(`${app.url}/api/admin/media/${message.media.id}`, { headers: { cookie } });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('image/png');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(file.headers.get('cache-control')).toContain('no-store');
    expect(Number(file.headers.get('content-length'))).toBe(message.media.sizeBytes);
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.slice(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('sin sesión no se sirve ni un byte', async () => {
    const data = await json(await call(`/api/admin/conversations/${conversationId}/messages`));
    const mediaId = data.messages.find((row) => row.wa_message_id === 'wamid.MEDIA-IMG').media.id;
    const response = await fetch(`${app.url}/api/admin/media/${mediaId}`);
    expect(response.status).toBe(401);
  });

  it('una nota de voz entrante se guarda como audio', async () => {
    fakeMedia.downloadMedia = async () => ({ ok: true, buffer: ogg(), mimeType: 'audio/ogg' });
    await inbound('wamid.MEDIA-VOZ', { type: 'voice', voice: { id: 'MEDIA_VOZ_1', mime_type: 'audio/ogg' } });
    const thread = await waitFor(async () => {
      const data = await json(await call(`/api/admin/conversations/${conversationId}/messages`));
      const found = data.messages.find((row) => row.wa_message_id === 'wamid.MEDIA-VOZ');
      return found?.media?.status === MEDIA_STATUS.STORED ? data : null;
    }, 'la nota de voz guardada');
    const message = thread.messages.find((row) => row.wa_message_id === 'wamid.MEDIA-VOZ');
    expect(message.type).toBe('voice');
    expect(message.media.mimeType).toBe('audio/ogg');
  });

  it('si el almacén falla, el mensaje SIGUE en la conversación y el archivo queda Failed', async () => {
    fakeStorage.broken = true;
    await inbound('wamid.MEDIA-IMG-FALLO', {
      type: 'image',
      image: { id: 'MEDIA_IMG_2', mime_type: 'image/png' },
    });
    const thread = await waitFor(async () => {
      const data = await json(await call(`/api/admin/conversations/${conversationId}/messages`));
      const found = data.messages.find((row) => row.wa_message_id === 'wamid.MEDIA-IMG-FALLO');
      return found?.media?.status === MEDIA_STATUS.FAILED ? data : null;
    }, 'el fallo de almacén marcado');
    const message = thread.messages.find((row) => row.wa_message_id === 'wamid.MEDIA-IMG-FALLO');
    expect(message.type).toBe('image');
    expect(message.media.errorCode).toBeTruthy();

    // El endpoint lo dice como problema temporal, no como "no existe".
    const file = await fetch(`${app.url}/api/admin/media/${message.media.id}`, { headers: { cookie } });
    expect(file.status).toBe(409);
    expect((await json(file)).error).toBe('media_failed');
    fakeStorage.broken = false;
  });

  it('un archivo que no es imagen ni audio se rechaza sin tocar nada', async () => {
    fakeMedia.downloadMedia = async () => ({
      ok: true,
      buffer: Buffer.from('<html><script>alert(1)</script></html>'),
      mimeType: 'image/png',
    });
    await inbound('wamid.MEDIA-FALSO', { type: 'image', image: { id: 'MEDIA_MALO' } });
    const thread = await waitFor(async () => {
      const data = await json(await call(`/api/admin/conversations/${conversationId}/messages`));
      const found = data.messages.find((row) => row.wa_message_id === 'wamid.MEDIA-FALSO');
      return found?.media?.status === MEDIA_STATUS.FAILED ? data : null;
    }, 'el archivo falso rechazado');
    const message = thread.messages.find((row) => row.wa_message_id === 'wamid.MEDIA-FALSO');
    expect(message.media.errorCode).toBe('unrecognized_type');
    // Y el mensaje sigue ahí, con su texto.
    expect(message.type).toBe('image');
    fakeMedia.downloadMedia = async () => ({ ok: true, buffer: png(), mimeType: 'image/png' });
  });
});

describe('saliente con archivo (lo que manda el vendedor)', () => {
  it('sube una imagen, la envía y queda en el hilo como mensaje del negocio', async () => {
    fakeMedia.sends.length = 0;
    const response = await upload('image', png(), { key: 'out:img:1', caption: 'Te mando el frasco' });
    const body = await json(response);
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fakeMedia.sends).toHaveLength(1);
    expect(fakeMedia.sends[0].caption).toBe('Te mando el frasco');

    const thread = await json(await call(`/api/admin/conversations/${conversationId}/messages`));
    const message = thread.messages.find((row) => row.id === body.message?.id);
    expect(message.type).toBe('image');
    expect(message.direction).toBe('outbound');
    expect(message.body).toBe('Te mando el frasco');
    expect(message.media.sendStatus).toBe(SEND_STATUS.SENT);
    expect(message.media.status).toBe(MEDIA_STATUS.STORED);
  });

  it('la MISMA clave no envía dos veces (aunque se repita la petición)', async () => {
    const antes = fakeMedia.sends.length;
    const second = await upload('image', png(), { key: 'out:img:1', caption: 'Te mando el frasco' });
    const body = await json(second);
    expect(second.status).toBe(200);
    expect(body.duplicate).toBe(true);
    expect(fakeMedia.sends).toHaveLength(antes);
  });

  it('con la misma clave y OTRO tipo gana la seguridad: no se envía nada más', async () => {
    // La operación ya salió con esa clave: lo correcto (y seguro) es devolver el
    // resultado que ya existe, nunca enviar un segundo archivo.
    const antes = fakeMedia.sends.length;
    const response = await upload('audio', ogg(), { key: 'out:img:1' });
    const body = await json(response);
    expect(response.status).toBe(200);
    expect(body.duplicate).toBe(true);
    expect(fakeMedia.sends).toHaveLength(antes);
  });

  it('una operación FALLIDA con la misma clave y otro tipo sí se rechaza', async () => {
    // Antes de enviar (nada salió), mezclar tipos bajo la misma clave es un error
    // del panel y se dice claro.
    fakeMedia.rejectSend = { code: 'invalid_media', httpStatus: 400, message: 'bad media' };
    await upload('image', png(), { key: 'out:img:tipo' });
    fakeMedia.rejectSend = null;
    const response = await upload('audio', ogg(), { key: 'out:img:tipo' });
    expect(response.status).toBe(422);
    expect((await json(response)).error).toBe('key_conflict');
  });

  it('rechaza una imagen disfrazada de HTML y no llama a Meta', async () => {
    const antes = fakeMedia.sends.length;
    const response = await upload('image', Buffer.from('<html><body>no soy una foto</body></html>'), {
      key: 'out:img:html',
    });
    expect(response.status).toBe(422);
    expect((await json(response)).error).toBe('unrecognized_type');
    expect(fakeMedia.sends).toHaveLength(antes);
  });

  it('un audio grabado (OGG) se envía como audio', async () => {
    const response = await upload('audio', ogg(), { key: 'out:aud:1' });
    expect(response.status).toBe(200);
    expect(fakeMedia.sends.at(-1).kind).toBe('audio');
  });

  it('un rechazo claro de Meta (4xx) deja el envío Failed y NO se sirve como enviado', async () => {
    fakeMedia.rejectSend = { code: 'invalid_media', httpStatus: 400, message: 'bad media' };
    const response = await upload('image', png(), { key: 'out:img:rechazo' });
    expect(response.status).toBe(422);
    fakeMedia.rejectSend = null;

    const data = await json(await call('/api/admin/data'));
    const row = data.media.review.find((entry) => entry.send_status === SEND_STATUS.FAILED);
    expect(row).toBeFalsy(); // FAILED no es ambiguo: no va a la cola de recuperación
  });
});

describe('envío ambiguo (SEND_UNKNOWN): nunca se reintenta solo', () => {
  it('queda en revisión y no vuelve a llamar a Meta', async () => {
    const antes = fakeMedia.sends.length;
    fakeMedia.ambiguity = true;
    const response = await upload('image', png(), { key: 'out:img:ambiguo' });
    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.error).toBe('send_unknown');
    expect(body.requiresReconciliation).toBe(true);
    expect(fakeMedia.sends).toHaveLength(antes);
    fakeMedia.ambiguity = false;

    // Segunda petición con la MISMA clave: no se envía, sigue siendo ambiguo.
    const segunda = await upload('image', png(), { key: 'out:img:ambiguo' });
    expect(segunda.status).toBe(409);
    expect((await json(segunda)).error).toBe('send_unknown');
    expect(fakeMedia.sends).toHaveLength(antes);

    // Aparece en la cola de recuperación (administración), saneada.
    const data = await json(await call('/api/admin/data'));
    const row = data.media.review.find((entry) => entry.send_status === SEND_STATUS.SEND_UNKNOWN);
    expect(row).toBeTruthy();
    expect(JSON.stringify(row)).not.toMatch(/object_key|phytoemagry\/|bucket/);

    // Reconciliación: la persona confirma que NO salió → vuelve a ser enviable.
    const reconcile = await call(`/api/admin/media/retry/${row.id}?outcome=not_sent`, { method: 'POST' });
    expect(reconcile.status).toBe(200);
    expect((await json(reconcile)).retryable).toBe(true);

    const tercera = await upload('image', png(), { key: 'out:img:ambiguo' });
    expect(tercera.status).toBe(200);
    expect(fakeMedia.sends).toHaveLength(antes + 1);
  });

  it('reconciliar como enviado exige el identificador del mensaje', async () => {
    const antes = fakeMedia.sends.length;
    fakeMedia.ambiguity = true;
    await upload('image', png(), { key: 'out:img:ambiguo2' });
    fakeMedia.ambiguity = false;
    const data = await json(await call('/api/admin/data'));
    const row = data.media.review.find((entry) => entry.send_status === SEND_STATUS.SEND_UNKNOWN);
    expect(row).toBeTruthy();

    const sinId = await call(`/api/admin/media/retry/${row.id}?outcome=sent`, { method: 'POST' });
    expect(sinId.status).toBe(422);
    const conId = await call(`/api/admin/media/retry/${row.id}?outcome=sent&wa_message_id=wamid.RECON`, { method: 'POST' });
    expect(conId.status).toBe(200);
    expect(fakeMedia.sends).toHaveLength(antes); // reconciliar NO envía nada
  });
});

describe('la multimedia no rompe el flujo comercial', () => {
  it('desde la conversación se sigue creando un pedido con su comprobante', async () => {
    const order = await json(
      await call('/api/admin/orders', {
        method: 'POST',
        body: JSON.stringify({
          customerId,
          conversationId,
          items: [{ variantId: 'capsules_10', quantity: 2 }],
          status: 'entregado',
        }),
      }),
    );
    expect(order.order.total).toBe(5000);
    expect(order.item.conversation_id).toBe(conversationId);
    expect(order.receipt.order_number).toMatch(/^PE-/);

    // El plan de seguimiento se creó igual que sin multimedia.
    const profile = await json(await call(`/api/admin/customers/${customerId}`));
    expect(profile.followups.length).toBeGreaterThan(0);
    expect(profile.totals.total_spent).toBe(5000);
  });

  it('el panel recibe las capacidades de multimedia sin ningún secreto', async () => {
    const data = await json(await call('/api/admin/data'));
    expect(data.media.enabled).toBe(true);
    expect(data.media.storageConfigured).toBe(true);
    expect(data.media.graphConfigured).toBe(true);
    const serialized = JSON.stringify(data.media) + JSON.stringify(data.whatsapp);
    expect(serialized).not.toMatch(/phyto-uat|phytoemagry\/|access_token|SUPER_SECRET|X-Amz/i);
  });
});
