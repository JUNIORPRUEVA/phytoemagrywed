/**
 * STORAGE SERVICE — la única puerta por la que el CRM guarda y lee archivos.
 *
 * REPARTO DE RESPONSABILIDADES (decidido con el negocio)
 *   PostgreSQL  → metadata, relaciones y estado
 *   S3          → los binarios
 * La tabla guarda el `object_key`; el archivo vive en el bucket. Así el día que
 * haya que mover los binarios de sitio (otro proveedor, otro bucket) no se toca
 * ni la UI ni el modelo de conversaciones: solo este archivo.
 *
 * NO ES SOLO PARA WHATSAPP: el mismo servicio guardará comprobantes de compra
 * (`phytoemagry/receipts/…`), así que las claves se construyen por dominio.
 *
 * PRIVACIDAD
 * El bucket es privado: no hay `public-read` ni URLs públicas permanentes. El
 * navegador pide el archivo a NUESTRO endpoint autenticado, que lo autoriza y lo
 * sirve en streaming. Las credenciales viven solo en el servidor.
 */
import { createS3Client } from './s3.mjs';
import { randomBytes } from 'node:crypto';

/** Prefijo raíz de todo lo de este CRM, para no mezclarse con nada más del bucket. */
export const ROOT_PREFIX = 'phytoemagry';

/**
 * Tipos aceptados, con la extensión que se le pone al objeto.
 * La extensión SIEMPRE sale de aquí, nunca del nombre que envíe el usuario.
 */
export const ALLOWED_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'application/pdf': 'pdf',
});

/** Límites duros (se validan ANTES de subir a S3). */
export const LIMITS = Object.freeze({
  imageMaxBytes: 5 * 1024 * 1024,
  audioMaxBytes: 16 * 1024 * 1024,
  audioMaxSeconds: 300,
});

/** ¿Es un MIME que aceptamos? (nunca SVG, HTML ni ejecutables) */
export const isAllowedMime = (mime) => Object.prototype.hasOwnProperty.call(ALLOWED_MIME, String(mime ?? '').toLowerCase());

/**
 * Firma de cabecera del archivo: comprobar el contenido de verdad, no lo que diga
 * el navegador ni la extensión.
 *
 * @param {Buffer} buffer
 * @returns {string|null} MIME deducido o `null` si no se reconoce
 */
export function sniffMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b.slice(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (b.slice(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (b.slice(0, 4).toString('ascii') === 'fLaC') return null; // FLAC: no lo acepta Meta
  if (b.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = b.slice(8, 12).toString('ascii');
    return brand.startsWith('M4A') || brand.startsWith('mp4') ? 'audio/mp4' : 'audio/mp4';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return null; // webm/matroska
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (b.slice(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}

/** Aleatorio seguro para nombres de objeto (sin guiones raros ni mayúsculas). */
const randomId = (bytes = 12) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((n) => n.toString(16).padStart(2, '0')).join('');

/**
 * Construye la clave del objeto. Nunca usa nada del usuario salvo el tipo.
 *
 *   phytoemagry/whatsapp/2026/09/<conversación>/<mensaje>/<aleatorio>.jpg
 *   phytoemagry/receipts/2026/09/<pedido>/<aleatorio>.pdf
 *
 * `token` es opcional y sirve para que la clave sea DETERMINISTA: con el mismo
 * token, la misma operación produce la misma clave. El envío saliente pasa el
 * hash del contenido, así que un reintento tras una caída SOBRESCRIBE su propio
 * objeto en vez de dejar un archivo huérfano en el almacén.
 *
 * @param {{ domain?: 'whatsapp'|'receipts', at?: Date, conversationId?: string|null, messageId?: string|null,
 *           orderId?: string|null, mime: string, token?: string|null }} input
 */
export function buildObjectKey(input) {
  const domain = input.domain ?? 'whatsapp';
  const at = input.at ?? new Date();
  const ext = ALLOWED_MIME[String(input.mime ?? '').toLowerCase()] ?? 'bin';
  // Los identificadores se limpian: solo letras, números, guion y guion bajo.
  const safe = (value, fallback) => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || fallback;
  const scope =
    domain === 'receipts'
      ? `orders/${safe(input.orderId, 'sin-pedido')}`
      : `conversations/${safe(input.conversationId, 'sin-conversacion')}/${safe(input.messageId, 'sin-mensaje')}`;
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const suffix = input.token
    ? String(input.token).replace(/[^A-Za-z0-9]/g, '').slice(0, 32) || randomId()
    : randomId();
  return [ROOT_PREFIX, domain, String(at.getFullYear()), month, scope, `${suffix}.${ext}`].join('/');
}

/**
 * Crea el StorageService. Si falta configuración queda **desactivado** (el CRM
 * sigue guardando pedidos; simplemente no habrá multimedia).
 *
 * @param {{ endpoint?: string, bucket?: string, accessKeyId?: string, secretAccessKey?: string,
 *           region?: string, fetchImpl?: typeof fetch, client?: any }} options
 */
export function createStorageService(options = {}) {
  const client = options.client ?? createS3Client(options);
  return {
    enabled: client.enabled,
    provider: 's3',
    bucket: client.bucket,
    /** Guarda un binario ya validado y devuelve la referencia persistente. */
    async put(objectKey, buffer, contentType) {
      const result = await client.put(objectKey, buffer, contentType);
      return result.ok ? { ok: true, objectKey, size: buffer.length } : result;
    },
    async get(objectKey) {
      return client.get(objectKey);
    },
    async exists(objectKey) {
      const result = await client.head(objectKey);
      return { ok: result.ok, exists: result.ok, status: result.status };
    },
    async getMetadata(objectKey) {
      return client.head(objectKey);
    },
    /** Borra UN objeto concreto (nunca por prefijo ni con comodines). */
    async remove(objectKey) {
      return client.remove(objectKey);
    },
  };
}
