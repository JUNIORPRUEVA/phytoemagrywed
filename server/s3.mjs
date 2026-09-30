/**
 * CLIENTE S3 MÍNIMO — compatible con Cloudflare R2 y con cualquier almacenamiento
 * que hable el protocolo S3 (AWS, MinIO, Backblaze, Wasabi…).
 *
 * POR QUÉ A MANO (y no un SDK)
 * Este proyecto no arrastra frameworks: el panel no tiene dependencias y el API
 * solo necesita `pg`. Para cuatro operaciones —PUT, GET, HEAD y DELETE— un SDK de
 * AWS añade decenas de MB a la imagen y decenas de paquetes al lockfile sin
 * aportar nada que no quepa aquí. La única pieza delicada es la firma
 * AWS Signature v4, y queda cubierta por tests y por el smoke test contra el
 * bucket real.
 *
 * QUÉ NO HACE
 * No lee credenciales por su cuenta (se las pasa `storage.mjs`) y no conoce nada
 * del CRM ni de WhatsApp. Nada de esto sale nunca al navegador.
 */
import { createHash, createHmac } from 'node:crypto';

const sha256hex = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

/**
 * Codifica la ruta por segmentos: los `/` se conservan y cada segmento se escapa.
 * Es lo que exige SigV4 para S3 (nada de normalizar la ruta).
 */
function encodePath(path) {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

/**
 * Firma una petición con AWS Signature v4.
 *
 * @param {{ method: string, path: string, query?: string, headers: Record<string, string>, payloadHash: string,
 *           accessKeyId: string, secretAccessKey: string, region: string, service?: string, now?: Date }} input
 * @returns {Record<string, string>} cabeceras listas para enviar (incluye `authorization`)
 */
export function signRequest(input) {
  const service = input.service ?? 's3';
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const shortDate = amzDate.slice(0, 8);
  const headers = {
    ...input.headers,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method,
    encodePath(input.path),
    input.query ?? '',
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const scope = `${shortDate}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, shortDate), input.region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Crea el cliente. Si falta cualquier dato queda **desactivado** en vez de
 * reventar: el CRM tiene que seguir guardando pedidos aunque el almacén no esté.
 *
 * @param {{ endpoint: string, bucket: string, accessKeyId: string, secretAccessKey: string,
 *           region?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 */
export function createS3Client(options = {}) {
  const endpoint = String(options.endpoint ?? '').trim().replace(/\/+$/, '');
  const bucket = String(options.bucket ?? '').trim();
  const accessKeyId = String(options.accessKeyId ?? '').trim();
  const secretAccessKey = String(options.secretAccessKey ?? '').trim();
  const region = String(options.region ?? '').trim() || 'auto';
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Number(options.timeoutMs ?? 15000);
  const enabled = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

  const urlOf = (key) => {
    const base = endpoint.replace(/\/+$/, '');
    return `${base}/${bucket}/${encodePath(key)}`;
  };

  async function request(method, key, { body = null, contentType = null } = {}) {
    if (!enabled) return { ok: false, status: 0, error: 'storage_disabled' };
    if (!key || key.startsWith('/') || key.includes('..')) {
      return { ok: false, status: 0, error: 'invalid_key' };
    }
    const url = urlOf(key);
    const payloadHash = sha256hex(body ?? '');
    const headers = { host: new URL(url).host };
    if (contentType) headers['content-type'] = contentType;
    const signed = signRequest({
      method,
      path: new URL(url).pathname,
      headers,
      payloadHash,
      accessKeyId,
      secretAccessKey,
      region,
    });
    const signal =
      typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
    try {
      const response = await fetchImpl(url, { method, headers: signed, body, signal });
      return { ok: response.ok, status: response.status, response };
    } catch (error) {
      // Ni mensaje ni pila del proveedor: solo la clase de fallo.
      return { ok: false, status: 0, error: error?.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
  }

  return {
    enabled,
    bucket,
    region,
    /** Sube un objeto (binario o texto). */
    async put(key, body, contentType = 'application/octet-stream') {
      const result = await request('PUT', key, {
        body: Buffer.isBuffer(body) ? body : Buffer.from(body),
        contentType,
      });
      return result.ok
        ? { ok: true, status: result.status, key }
        : { ok: false, status: result.status, error: result.error ?? `http_${result.status}` };
    },
    /** Lee un objeto completo. */
    async get(key) {
      const result = await request('GET', key);
      if (!result.ok) {
        return { ok: false, status: result.status, error: result.error ?? `http_${result.status}` };
      }
      const buffer = Buffer.from(await result.response.arrayBuffer());
      return {
        ok: true,
        status: result.status,
        buffer,
        contentType: result.response.headers.get('content-type') ?? null,
        size: buffer.length,
      };
    },
    /** Metadatos sin descargar el cuerpo (y la comprobación de existencia). */
    async head(key) {
      const result = await request('HEAD', key);
      if (!result.ok) {
        return { ok: false, status: result.status, error: result.error ?? `http_${result.status}` };
      }
      return {
        ok: true,
        status: result.status,
        contentType: result.response.headers.get('content-type') ?? null,
        size: Number(result.response.headers.get('content-length') ?? 0),
        etag: result.response.headers.get('etag') ?? null,
      };
    },
    /** Borra UN objeto concreto. Nunca hay borrados masivos ni comodines. */
    async remove(key) {
      const result = await request('DELETE', key);
      return result.ok
        ? { ok: true, status: result.status }
        : { ok: false, status: result.status, error: result.error ?? `http_${result.status}` };
    },
  };
}
