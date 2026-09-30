// @vitest-environment node
/**
 * ALMACÉN DE ARCHIVOS — lo que tiene que estar MAL hecho para que falle
 * (firma SigV4, codificación, claves de objeto, tipos aceptados).
 *
 * No toca la red: usa un `fetch` de mentira que apunta exactamente lo que se
 * enviaría. El smoke test contra R2 de verdad es otra cosa y se ejecuta aparte.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createS3Client, signRequest } from '../server/s3.mjs';
import { ALLOWED_MIME, buildObjectKey, createStorageService, isAllowedMime, sniffMime } from '../server/storage.mjs';

const CONFIG = {
  endpoint: 'https://cuenta.r2.cloudflarestorage.com',
  bucket: 'phyto-media',
  accessKeyId: 'AKIAPRUEBA',
  secretAccessKey: 'secreto-de-prueba',
  region: 'auto',
};

/** `fetch` de mentira: apunta la petición y responde lo que le digamos. */
function fakeFetch(responder = () => new Response('', { status: 200 })) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  impl.calls = calls;
  return impl;
}

const sha256hex = (value) => createHash('sha256').update(value).digest('hex');

describe('firma SigV4', () => {
  const base = {
    method: 'PUT',
    path: '/phyto-media/phytoemagry/whatsapp/2026/09/conversations/cnv_1/msg_1/abc.jpg',
    headers: { host: 'cuenta.r2.cloudflarestorage.com', 'content-type': 'image/jpeg' },
    payloadHash: sha256hex('hola'),
    accessKeyId: 'AKIAPRUEBA',
    secretAccessKey: 'secreto-de-prueba',
    region: 'auto',
    now: new Date('2026-09-30T12:00:00.000Z'),
  };

  it('produce la cabecera Authorization en el formato que exige S3', () => {
    const signed = signRequest(base);
    expect(signed.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAPRUEBA\/20260930\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
    // Las cabeceras firmadas van en minúsculas y ordenadas.
    const signedHeaders = /SignedHeaders=([^,]+)/.exec(signed.authorization)[1];
    expect(signedHeaders).toBe('content-type;host;x-amz-content-sha256;x-amz-date');
    expect(signed['x-amz-date']).toBe('20260930T120000Z');
    expect(signed['x-amz-content-sha256']).toBe(sha256hex('hola'));
  });

  it('es determinista: los mismos datos dan la misma firma', () => {
    expect(signRequest(base).authorization).toBe(signRequest(base).authorization);
  });

  it('cambia si cambia el cuerpo (el hash del payload entra en la firma)', () => {
    const otro = signRequest({ ...base, payloadHash: sha256hex('otra cosa') });
    expect(otro.authorization).not.toBe(signRequest(base).authorization);
  });

  it('codifica la ruta por segmentos y deja intactos los acentos (UTF-8)', () => {
    const signed = signRequest({ ...base, path: '/b/phytoemagry/receipts/2026/09/pedido ñoño/á é.jpg' });
    // Espacios y acentos se escapan; las barras se conservan.
    expect(signed.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
    expect(signRequest({ ...base, path: '/a b/c' }).authorization).not.toBe(
      signRequest({ ...base, path: '/a%20b/c' }).authorization,
    );
  });
});

describe('cliente S3', () => {
  it('queda desactivado (sin romper el CRM) si falta configuración', async () => {
    const client = createS3Client({ ...CONFIG, secretAccessKey: '' });
    expect(client.enabled).toBe(false);
    const result = await client.put('x/y.txt', Buffer.from('a'));
    expect(result).toMatchObject({ ok: false, error: 'storage_disabled' });
  });

  it('sube con PUT, host correcto y hash del cuerpo', async () => {
    const fetchImpl = fakeFetch(() => new Response('', { status: 200 }));
    const client = createS3Client({ ...CONFIG, fetchImpl });
    const body = Buffer.from('contenido de prueba');
    const result = await client.put('phytoemagry/a/b.txt', body, 'text/plain');
    expect(result.ok).toBe(true);

    const call = fetchImpl.calls[0];
    expect(call.init.method).toBe('PUT');
    expect(call.url).toBe('https://cuenta.r2.cloudflarestorage.com/phyto-media/phytoemagry/a/b.txt');
    expect(call.init.headers.host).toBe('cuenta.r2.cloudflarestorage.com');
    expect(call.init.headers['x-amz-content-sha256']).toBe(sha256hex(body));
    expect(call.init.headers.authorization).toContain('AWS4-HMAC-SHA256');
  });

  it('lee, comprueba existencia y borra (con el hash vacío en GET/DELETE)', async () => {
    const vacio = sha256hex(Buffer.alloc(0));
    const fetchImpl = fakeFetch((url, init) =>
      init.method === 'HEAD'
        ? new Response(null, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '1234' } })
        : init.method === 'GET'
          ? new Response('datos', { status: 200, headers: { 'content-type': 'image/jpeg' } })
          : new Response(null, { status: 204 }),
    );
    const client = createS3Client({ ...CONFIG, fetchImpl });

    const get = await client.get('phytoemagry/a.jpg');
    expect(get).toMatchObject({ ok: true, status: 200, contentType: 'image/jpeg' });
    expect(get.buffer.toString()).toBe('datos');

    const head = await client.head('phytoemagry/a.jpg');
    expect(head).toMatchObject({ ok: true, size: 1234, contentType: 'image/jpeg' });

    const borrado = await client.remove('phytoemagry/a.jpg');
    expect(borrado).toMatchObject({ ok: true, status: 204 });

    for (const call of fetchImpl.calls.filter((c) => c.init.method !== 'PUT')) {
      expect(call.init.headers['x-amz-content-sha256']).toBe(vacio);
    }
  });

  it('traduce los fallos del proveedor sin filtrar detalles internos', async () => {
    const casos = [
      [403, { ok: false, status: 403, error: 'http_403' }],
      [404, { ok: false, status: 404, error: 'http_404' }],
      [500, { ok: false, status: 500, error: 'http_500' }],
    ];
    for (const [status, esperado] of casos) {
      const client = createS3Client({ ...CONFIG, fetchImpl: fakeFetch(() => new Response('', { status })) });
      expect(await client.get('phytoemagry/x.jpg')).toMatchObject(esperado);
    }
  });

  it('un corte de red o un timeout no revientan: devuelven un error legible', async () => {
    const red = createS3Client({
      ...CONFIG,
      fetchImpl: async () => {
        throw new Error('ECONNRESET: detalles internos que no deben salir');
      },
    });
    expect(await red.get('phytoemagry/x.jpg')).toMatchObject({ ok: false, error: 'network' });

    const timeout = createS3Client({
      ...CONFIG,
      fetchImpl: async () => {
        const error = new Error('tardó demasiado');
        error.name = 'TimeoutError';
        throw error;
      },
    });
    expect(await timeout.get('phytoemagry/x.jpg')).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('rechaza claves peligrosas antes de firmar nada', async () => {
    const fetchImpl = fakeFetch();
    const client = createS3Client({ ...CONFIG, fetchImpl });
    for (const key of ['../secreto.txt', '/etc/passwd', 'a/../../b.txt', '']) {
      expect(await client.put(key, Buffer.from('x'))).toMatchObject({ ok: false, error: 'invalid_key' });
    }
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

describe('claves de objeto', () => {
  it('nunca usa el nombre que envía el usuario y respeta la estructura acordada', () => {
    const key = buildObjectKey({
      domain: 'whatsapp',
      at: new Date('2026-09-30T10:00:00Z'),
      conversationId: 'cnv_123',
      messageId: 'msg_456',
      mime: 'image/jpeg',
    });
    expect(key).toMatch(/^phytoemagry\/whatsapp\/2026\/09\/conversations\/cnv_123\/msg_456\/[0-9a-f]{24}\.jpg$/);
    // El nombre del archivo del cliente no aparece por ningún lado.
    expect(key).not.toContain('vacaciones');
  });

  it('limpia identificadores y evita traversal', () => {
    const key = buildObjectKey({
      conversationId: '../../etc',
      messageId: 'msg;rm -rf /',
      mime: 'image/png',
    });
    expect(key).not.toContain('..');
    expect(key).not.toContain(';');
    expect(key).toContain('phytoemagry/whatsapp/');
  });

  it('no colisiona y sirve también para comprobantes (no es solo WhatsApp)', () => {
    const a = buildObjectKey({ conversationId: 'c', messageId: 'm', mime: 'image/jpeg' });
    const b = buildObjectKey({ conversationId: 'c', messageId: 'm', mime: 'image/jpeg' });
    expect(a).not.toBe(b);

    const recibo = buildObjectKey({
      domain: 'receipts',
      at: new Date('2026-09-30T10:00:00Z'),
      orderId: 'ord_99',
      mime: 'application/pdf',
    });
    expect(recibo).toMatch(/^phytoemagry\/receipts\/2026\/09\/orders\/ord_99\/[0-9a-f]{24}\.pdf$/);
  });

  it('un MIME no permitido no inventa extensión ejecutable', () => {
    expect(buildObjectKey({ mime: 'text/html' })).toMatch(/\.bin$/);
    expect(buildObjectKey({ mime: 'image/svg+xml' })).toMatch(/\.bin$/);
  });
});

describe('tipos aceptados y contenido real', () => {
  it('acepta imágenes y audio de WhatsApp y rechaza lo peligroso', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'audio/mpeg', 'audio/ogg', 'audio/mp4']) {
      expect(isAllowedMime(mime)).toBe(true);
    }
    for (const mime of ['image/svg+xml', 'text/html', 'application/javascript', 'application/x-msdownload', '']) {
      expect(isAllowedMime(mime)).toBe(false);
    }
    expect(Object.keys(ALLOWED_MIME)).not.toContain('image/svg+xml');
  });

  it('reconoce el archivo por su contenido, no por lo que diga el navegador', () => {
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe('image/png');
    expect(sniffMime(Buffer.from('RIFF____WEBPVP8 ', 'ascii'))).toBe('image/webp');
    expect(sniffMime(Buffer.from('OggS________', 'ascii'))).toBe('audio/ogg');
    // Un HTML disfrazado de imagen no cuela.
    expect(sniffMime(Buffer.from('<html><script>alert(1)</script>', 'utf8'))).toBe(null);
    // webm (lo que graba Chrome) tampoco es aceptado por Meta: se detecta y se descarta.
    expect(sniffMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(null);
    expect(sniffMime(Buffer.from('cualquier cosa', 'utf8'))).toBe(null);
  });
});

describe('StorageService (la puerta única del CRM)', () => {
  const fakeClient = {
    enabled: true,
    bucket: 'phyto-media',
    calls: [],
    async put(key, body, contentType) {
      this.calls.push(['put', key, contentType, body.length]);
      return { ok: true, status: 200, key };
    },
    async get(key) {
      this.calls.push(['get', key]);
      return { ok: true, status: 200, buffer: Buffer.from('x'), contentType: 'image/jpeg', size: 1 };
    },
    async head(key) {
      this.calls.push(['head', key]);
      return { ok: true, status: 200, size: 1, contentType: 'image/jpeg' };
    },
    async remove(key) {
      this.calls.push(['remove', key]);
      return { ok: true, status: 204 };
    },
  };

  it('expone la interfaz acordada sin filtrar el SDK al resto del CRM', async () => {
    const storage = createStorageService({ client: fakeClient });
    expect(Object.keys(storage).sort()).toEqual(
      ['bucket', 'enabled', 'exists', 'get', 'getMetadata', 'provider', 'put', 'remove'].sort(),
    );
    const put = await storage.put('phytoemagry/a.jpg', Buffer.from('12345'), 'image/jpeg');
    expect(put).toMatchObject({ ok: true, objectKey: 'phytoemagry/a.jpg', size: 5 });
    expect(await storage.exists('phytoemagry/a.jpg')).toMatchObject({ ok: true, exists: true });
    expect(await storage.getMetadata('phytoemagry/a.jpg')).toMatchObject({ ok: true, size: 1 });
    expect(await storage.get('phytoemagry/a.jpg')).toMatchObject({ ok: true });
    expect(await storage.remove('phytoemagry/a.jpg')).toMatchObject({ ok: true });
  });

  it('nunca borra por prefijo ni con comodines: solo la clave que se le da', async () => {
    const storage = createStorageService({ client: fakeClient });
    await storage.remove('phytoemagry/whatsapp/2026/09/x.jpg');
    expect(fakeClient.calls.at(-1)).toEqual(['remove', 'phytoemagry/whatsapp/2026/09/x.jpg']);
  });

  it('sin configuración queda desactivado y no revienta', () => {
    const storage = createStorageService({ endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '' });
    expect(storage.enabled).toBe(false);
  });
});
