/**
 * Captura de atribución (UTM / fbclid) con política first-touch.
 *
 * - FIRST TOUCH: se guarda una sola vez (localStorage) con TTL. Todas las
 *   conversiones posteriores se atribuyen a la campaña que trajo al usuario.
 * - LAST TOUCH: se actualiza en cada visita (sessionStorage de la sesión actual).
 * - Solo se guardan campos publicitarios + URL/Referrer/fecha. NO se recoge
 *   información personal ni identificadores del dispositivo.
 */

import { createStorage } from './storage.js';

export const UTM_KEYS = Object.freeze([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
]);

export const CLICK_IDS = Object.freeze(['fbclid', 'gclid', 'ttclid', 'msclkid']);

export const FIRST_TOUCH_KEY = 'attribution.first';
export const LAST_TOUCH_KEY = 'attribution.last';
export const FIRST_TOUCH_TTL_DAYS = 90;

/**
 * @typedef {object} Attribution
 * @property {string|null} utm_source
 * @property {string|null} utm_medium
 * @property {string|null} utm_campaign
 * @property {string|null} utm_content
 * @property {string|null} utm_term
 * @property {Record<string,string>} clickIds
 * @property {string|null} landingPage
 * @property {string|null} referrer
 * @property {string} capturedAt  ISO 8601
 * @property {'first'|'last'} touch
 */

/** @param {string|null|undefined} value */
function clean(value, maxLength = 200) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

/**
 * Construye un objeto de atribución a partir de una URL.
 * @param {object} input
 * @param {string} input.href
 * @param {Record<string,string>} input.params
 * @param {string|null} input.referrer
 * @param {string} [input.now]
 * @param {'first'|'last'} [input.touch]
 * @returns {Attribution}
 */
export function buildAttribution(input) {
  const { href, params, referrer, now = new Date().toISOString(), touch = 'first' } = input;

  /** @type {Record<string,string|null>} */
  const utm = {};
  for (const key of UTM_KEYS) utm[key] = clean(params[key]);

  /** @type {Record<string,string>} */
  const clickIds = {};
  for (const key of CLICK_IDS) {
    const value = clean(params[key], 400);
    if (value) clickIds[key] = value;
  }

  let landingPage = null;
  let ownHost = null;
  try {
    const url = new URL(href);
    ownHost = url.host || null;
    url.hash = '';
    landingPage = clean(`${url.pathname}${url.search}` || '/', 500);
  } catch {
    landingPage = clean(href, 500);
  }

  // Se ignora el tráfico interno (mismo dominio) y las navegaciones del navegador.
  const externalReferrer =
    referrer && !referrer.startsWith('about:') && !(ownHost && referrer.includes(ownHost))
      ? clean(referrer, 500)
      : null;

  return {
    utm_source: utm.utm_source ?? null,
    utm_medium: utm.utm_medium ?? null,
    utm_campaign: utm.utm_campaign ?? null,
    utm_content: utm.utm_content ?? null,
    utm_term: utm.utm_term ?? null,
    clickIds,
    landingPage,
    referrer: externalReferrer,
    capturedAt: now,
    touch,
  };
}

/** ¿Hay algún dato de campaña en esta atribución? */
export function hasCampaignData(attribution) {
  if (!attribution) return false;
  if (Object.keys(attribution.clickIds ?? {}).length > 0) return true;
  return UTM_KEYS.some((key) => Boolean(attribution[key]));
}

/**
 * Persiste first-touch (si corresponde) y last-touch.
 * @param {object} [deps]
 * @param {Attribution} [deps.attribution]
 * @param {ReturnType<typeof createStorage>} [deps.local]
 * @param {ReturnType<typeof createStorage>} [deps.session]
 * @param {Date} [deps.now]
 * @returns {{ first: Attribution|null, last: Attribution|null, isNewFirstTouch: boolean }}
 */
export function persistAttribution(deps = {}) {
  const now = deps.now ?? new Date();
  const local = deps.local ?? createStorage('pe', 'local');
  const session = deps.session ?? createStorage('pe', 'session');

  const attribution =
    deps.attribution ??
    buildAttribution({
      href: typeof location === 'undefined' ? '/' : location.href,
      params: currentParams(),
      referrer: typeof document === 'undefined' ? null : document.referrer,
      now: now.toISOString(),
    });

  const stored = local.get(FIRST_TOUCH_KEY);
  const expired =
    !stored?.capturedAt ||
    now.getTime() - new Date(stored.capturedAt).getTime() > FIRST_TOUCH_TTL_DAYS * 86400000;

  let isNewFirstTouch = false;
  if (!stored || expired || (hasCampaignData(attribution) && !hasCampaignData(stored))) {
    const first = { ...attribution, touch: 'first' };
    local.set(FIRST_TOUCH_KEY, first);
    isNewFirstTouch = true;
  }

  if (hasCampaignData(attribution) || !session.get(LAST_TOUCH_KEY)) {
    session.set(LAST_TOUCH_KEY, { ...attribution, touch: 'last' });
  }

  return {
    first: /** @type {Attribution|null} */ (local.get(FIRST_TOUCH_KEY)),
    last: /** @type {Attribution|null} */ (session.get(LAST_TOUCH_KEY)),
    isNewFirstTouch,
  };
}

/** Lee los parámetros de campaña de la URL actual. */
export function currentParams() {
  /** @type {Record<string,string>} */
  const params = {};
  if (typeof location === 'undefined') return params;
  const search = location.search || '';
  const raw = new URLSearchParams(search);
  for (const [key, value] of raw.entries()) params[key] = value;
  return params;
}

/**
 * Atribución lista para adjuntar a un lead/pedido:
 * first-touch manda; si no hay campaña, se usa last-touch.
 * @param {object} [deps]
 * @returns {Attribution|null}
 */
export function getAttribution(deps = {}) {
  const local = deps.local ?? createStorage('pe', 'local');
  const session = deps.session ?? createStorage('pe', 'session');
  const first = /** @type {Attribution|null} */ (local.get(FIRST_TOUCH_KEY));
  const last = /** @type {Attribution|null} */ (session.get(LAST_TOUCH_KEY));

  if (first && hasCampaignData(first)) return first;
  if (last && hasCampaignData(last)) return last;
  return first ?? last ?? null;
}

/**
 * Resumen corto de atribución para adjuntar al mensaje de WhatsApp
 * (ej: `fb/instagram/verano-2026`). Sin datos personales.
 * @param {Attribution|null} attribution
 */
export function attributionRef(attribution) {
  if (!attribution) return null;
  const parts = [attribution.utm_source, attribution.utm_medium, attribution.utm_campaign, attribution.utm_content]
    .filter(Boolean)
    .map((part) => String(part).replace(/[^\w.\-]/g, '_').slice(0, 24));
  if (attribution.clickIds?.fbclid && parts.length === 0) parts.push('fbclid');
  return parts.length > 0 ? parts.join('/') : null;
}
