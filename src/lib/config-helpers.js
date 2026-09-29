/**
 * Utilidades para decidir qué se renderiza.
 *
 * REGLA DEL PROYECTO: si un dato no existe (null, '', [] o marcador pendiente),
 * la sección/campo NO se muestra. Nunca inventamos información del producto.
 */

const PENDING_MARKERS = [/^\s*pendiente\b/i, /^todo\b/i, /^tbd$/i, /^xxx+$/i, /^\{\{.*\}\}$/];

/** @param {unknown} value */
export function isSet(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return false;
    return !PENDING_MARKERS.some((pattern) => pattern.test(trimmed));
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * Devuelve el texto si existe; si no, `null` (el llamador decide ocultar).
 * @param {unknown} value
 * @param {number} [maxLength]
 */
export function textOrNull(value, maxLength = 600) {
  if (!isSet(value)) return null;
  return String(value).trim().slice(0, maxLength);
}

/**
 * Filtra una lista dejando solo entradas válidas según un campo requerido.
 * @template T
 * @param {unknown} list
 * @param {(item: T) => boolean} predicate
 * @returns {T[]}
 */
export function filterList(list, predicate = () => true) {
  if (!Array.isArray(list)) return [];
  return list.filter((item) => item && predicate(/** @type {T} */ (item)));
}

/** ¿La lista tiene entradas mostrables? */
export function hasItems(list) {
  return Array.isArray(list) && list.length > 0;
}

/**
 * ¿Este número de WhatsApp tiene pinta de ser de EJEMPLO?
 * Evita publicar una landing con un teléfono de prueba sin darse cuenta.
 * @param {unknown} value
 */
export function isPlaceholderPhone(value) {
  const raw = String(value ?? '');
  if (/test|ejemplo|demo|xxx/i.test(raw)) return true;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return false;
  if (/^(\d)\1+$/.test(digits)) return true; // 11111111
  if (/0{6,}/.test(digits)) return true; // 56900000000
  if (/^(1234|12345|123456|1234567|12345678|987654321)/.test(digits)) return true;
  if (/^1?555\d{7}$/.test(digits)) return true; // 15551234567 (ficticio, reservado para ejemplos)
  return false;
}

/** ¿Esta URL parece un dominio de ejemplo (no publicable)? */
export function isPlaceholderUrl(value) {
  const url = String(value ?? '').toLowerCase().trim();
  if (!url) return false;
  return (
    /\.(example|test|invalid|localhost)(:\d+)?(\/|$)/.test(url) ||
    url.includes('example.com') ||
    url.includes('localhost') ||
    url.includes('midominio') ||
    url.includes('mydomain') ||
    url.includes('cambiar')
  );
}

/**
 * Recorre un objeto de configuración y devuelve las rutas vacías
 * (usado por `scripts/check-content.mjs`).
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]}
 */
export function findEmptyPaths(value, path = '') {  /** @type {string[]} */
  const out = [];
  if (value === null || value === undefined || value === '') {
    out.push(path);
    return out;
  }
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      if (value.length === 0) out.push(path);
      value.forEach((item, index) => out.push(...findEmptyPaths(item, `${path}[${index}]`)));
      return out;
    }
    for (const [key, child] of Object.entries(value)) {
      out.push(...findEmptyPaths(child, path ? `${path}.${key}` : key));
    }
  }
  return out;
}
