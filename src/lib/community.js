/**
 * COMUNIDAD (grupos de WhatsApp).
 *
 * La landing NUNCA muestra los cinco enlaces: se elige automáticamente el
 * primer grupo `active` con estado `available` según `priority`.
 * Si ninguno está disponible, el CTA de comunidad se oculta.
 *
 * Así se puede cambiar de grupo (o marcarlo como lleno) solo editando la
 * configuración, sin tocar componentes.
 */

export const GROUP_STATUS = Object.freeze({
  AVAILABLE: 'available',
  ALMOST_FULL: 'almost_full',
  FULL: 'full',
  DISABLED: 'disabled',
});

const VALID_STATUSES = new Set(Object.values(GROUP_STATUS));

/** Dominios aceptados para un enlace de invitación a grupo. */
const ALLOWED_HOSTS = new Set(['chat.whatsapp.com', 'www.chat.whatsapp.com']);

/** @param {unknown} value */
function isJoinUrl(value) {
  if (typeof value !== 'string') return false;
  const url = value.trim();
  if (!/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+/.test(url)) return false;
  // Se eliminan parámetros de tracking propios de WhatsApp web (?mode=, ?s=, ...)
  return true;
}

/**
 * Limpia la URL del grupo dejando solo el identificador de invitación.
 * Evita arrastrar parámetros de sesión de la persona que copió el enlace y
 * RECHAZA cualquier dominio que no sea de WhatsApp (una URL inventada nunca
 * debe acabar publicada).
 * @param {string} url
 */
export function cleanGroupUrl(url) {
  try {
    const parsed = new URL(String(url).trim());
    if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    const code = parsed.pathname.replace(/^\/+/, '').split('/')[0];
    if (!code || !/^[A-Za-z0-9]+$/.test(code)) return null;
    return `https://chat.whatsapp.com/${code}`;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, name: string, url: string, active: boolean, priority: number, status: string }|null}
 */
export function normalizeGroup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = cleanGroupUrl(String(raw.url ?? ''));
  if (!url || !isJoinUrl(url)) return null;
  const status = VALID_STATUSES.has(raw.status) ? raw.status : GROUP_STATUS.AVAILABLE;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : url.split('/').pop(),
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : 'Grupo de WhatsApp',
    url,
    active: raw.active !== false,
    priority: Number.isFinite(raw.priority) ? Number(raw.priority) : 999,
    status,
  };
}

/** @param {unknown} list @returns {ReturnType<typeof normalizeGroup>[]} */
export function buildGroups(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => normalizeGroup(item))
    .filter((group) => group !== null)
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Grupo que debe usar la landing: primer `active` + `available` por prioridad.
 * @param {ReturnType<typeof buildGroups>} groups
 */
export function resolveGroup(groups) {
  return (
    groups.find((group) => group.active && group.status === GROUP_STATUS.AVAILABLE) ?? null
  );
}

/**
 * Resumen del estado de los grupos (para `check:content` y logs, nunca visible).
 * @param {ReturnType<typeof buildGroups>} groups
 */
export function groupSummary(groups) {
  return {
    total: groups.length,
    active: groups.filter((group) => group.active).length,
    available: groups.filter((group) => group.active && group.status === GROUP_STATUS.AVAILABLE).length,
    hasUsableGroup: resolveGroup(groups) !== null,
  };
}
