/**
 * DOCUMENTOS DEL EXPEDIENTE DE REPARTIDOR.
 *
 * Reglas que no se negocian:
 *   - El archivo se guarda en un directorio PRIVADO (nunca en `public/`), con
 *     nombre generado por el servidor: el cliente no elige ruta ni extensión.
 *   - Se valida el CONTENIDO (bytes de cabecera), no la extensión declarada:
 *     renombrar un `.exe` a `.pdf` no lo convierte en un PDF.
 *   - Se rechaza cualquier ejecutable o archivo comprimido.
 *   - La descarga solo existe por una ruta autenticada (panel) o con el recibo
 *     de la propia solicitud; no hay URL pública ni enlaces firmados eternos.
 *   - Lo que no es necesario para el tipo de vehículo NO se exige: la política
 *     de documentos obligatorios es configurable, no una suposición legal.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DOCUMENT_KINDS = Object.freeze(['IDENTITY', 'DRIVING_LICENSE', 'VEHICLE']);
export const DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Qué documentos pide cada tipo de vehículo.
 *
 * `DRIVING_LICENSE` y `VEHICLE` solo tienen sentido con motor. Queda como
 * política editable: la empresa puede endurecerla, pero no se inventan
 * requisitos legales dominicanos ni se exige lo que no aplica.
 */
export function requiredDocumentsFor(vehicleType) {
  const vehicle = String(vehicleType ?? '').toUpperCase();
  if (vehicle === 'MOTO' || vehicle === 'CARRO') return ['IDENTITY', 'DRIVING_LICENSE', 'VEHICLE'];
  if (vehicle === 'BICICLETA' || vehicle === 'A_PIE') return ['IDENTITY'];
  return ['IDENTITY'];
}

/** Tipo real del archivo por sus primeros bytes. `null` = no aceptado. */
export function sniffDocumentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

/**
 * Valida y decodifica un documento enviado en base64.
 * Devuelve `{ ok: true, buffer, contentType }` o `{ ok: false, error }`.
 */
export function decodeDocument(dataBase64) {
  const raw = String(dataBase64 ?? '');
  if (!raw) return { ok: false, error: 'missing_content' };
  // base64 estricto: nada de data URLs, rutas ni nombres de archivo.
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) return { ok: false, error: 'invalid_encoding' };
  let buffer;
  try {
    buffer = Buffer.from(raw.replace(/\s+/g, ''), 'base64');
  } catch {
    return { ok: false, error: 'invalid_encoding' };
  }
  if (!buffer.length) return { ok: false, error: 'missing_content' };
  if (buffer.length > DOCUMENT_MAX_BYTES) return { ok: false, error: 'too_large' };
  const contentType = sniffDocumentType(buffer);
  if (!contentType) return { ok: false, error: 'unsupported_type' };
  return { ok: true, buffer, contentType };
}

const EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };

/** Directorio privado del expediente. Se crea bajo demanda. */
export function documentsDirectory(dataFile) {
  const base = dataFile ? join(String(dataFile), '..', 'courier-documents') : join(process.cwd(), 'data', 'courier-documents');
  return base;
}

/**
 * Guarda el binario con nombre generado. No usa ningún dato del cliente para
 * la ruta; solo el id de la solicitud (que ya validó el servidor).
 */
export async function saveDocumentFile({ directory, applicationId, buffer, contentType }) {
  const safeApplication = String(applicationId ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!safeApplication) return { ok: false, error: 'invalid_application' };
  const extension = EXTENSION[contentType];
  if (!extension) return { ok: false, error: 'unsupported_type' };
  const id = `doc_${randomUUID().replaceAll('-', '')}`;
  const dir = join(directory, safeApplication);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${id}.${extension}`);
  await writeFile(file, buffer, { mode: 0o600 });
  return { ok: true, id, file, bytes: buffer.length };
}

/** Lee el binario de un documento ya registrado. */
export async function readDocumentFile(file) {
  return readFile(file);
}

/** Borra el binario (reemplazo o retención). Nunca falla por inexistente. */
export async function removeDocumentFile(file) {
  await rm(file, { force: true }).catch(() => {});
}
