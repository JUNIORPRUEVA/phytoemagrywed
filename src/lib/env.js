/**
 * Variables de entorno.
 *
 * Dos contextos de ejecución:
 *  1. Navegador (bundle): esbuild sustituye `__PHYTO_ENV__` por el objeto que
 *     genera `scripts/build.mjs` a partir de `.env`.
 *  2. Node (build/render/tests): no existe `__PHYTO_ENV__`, así que se leen las
 *     mismas claves desde `process.env` (lista blanca: nada más se filtra).
 *
 * SEGURIDAD: todo lo que esté aquí acaba en el bundle público. Nunca poner
 * tokens privados, credenciales, endpoints administrativos ni secretos.
 */

/** Claves públicas permitidas (las únicas que viajan al navegador). */
export const PUBLIC_ENV_KEYS = Object.freeze([
  'PHYTO_WHATSAPP_NUMBER',
  'PHYTO_CRM_ENDPOINT',
  'PHYTO_META_PIXEL_ID',
  'SEO_SITE_URL',
  'CONTACT_EMAIL',
  'APP_ENV',
]);

/** @returns {Record<string, string>} */
function fromProcessEnv() {
  if (typeof process === 'undefined' || !process?.env) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of PUBLIC_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

const injected = typeof __PHYTO_ENV__ === 'undefined' ? fromProcessEnv() : __PHYTO_ENV__;

/** @type {Readonly<Record<string, string>>} */
export const env = Object.freeze({ ...injected });

/**
 * Devuelve un string de entorno o `fallback` si no existe / está vacío.
 * @param {string} key
 * @param {string|null} fallback
 * @returns {string|null}
 */
export function envString(key, fallback = null) {
  const raw = env[key];
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim();
  return value === '' ? fallback : value;
}

/** @returns {boolean} */
export function isDev() {
  return envString('APP_ENV', 'production') === 'development';
}
