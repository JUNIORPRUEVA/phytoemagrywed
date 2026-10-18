/**
 * GRUPOS DE NEGOCIO — clasificación de clientes y productos por actividad.
 *
 * POR QUÉ EXISTE
 * El CRM nació con una sola actividad (PHYTOEMAGRY). FULLTECH vende además
 * productos generales y sistemas de seguridad, y un mismo cliente puede
 * comprar en varias: por eso el grupo es una LISTA en el cliente y una etiqueta
 * en el producto/categoría, no un campo cerrado.
 *
 * Son datos, no código: la lista de arriba son los grupos INICIALES, pero el
 * cliente puede llevar cualquier nombre guardado (por ejemplo, una actividad
 * nueva). `normalizeGroups` es el único sitio donde se limpia y se valida, para
 * que el panel, el importador y la API escriban siempre igual:
 *   - sin espacios de más, sin vacíos, sin repetidos y sin distinguir mayúsculas
 *     (se conserva la primera forma escrita),
 *   - como mínimo UN grupo: un cliente sin clasificar es un cliente que luego
 *     nadie encuentra en los filtros.
 *
 * Esto NO es multi-empresa: es una etiqueta comercial. Los permisos y la
 * propiedad de los datos siguen siendo los mismos de siempre.
 */

/** Grupos con los que arranca el negocio. */
export const BUSINESS_GROUPS = Object.freeze([
  'PHYTOEMAGRY',
  'FULLTECH — Ventas generales',
  'FULLTECH — Sistemas de seguridad',
]);

/** Grupo de los clientes que ya existían antes de esta clasificación. */
export const DEFAULT_BUSINESS_GROUP = 'PHYTOEMAGRY';

/** Tope defensivo: nadie necesita 40 grupos en un cliente. */
export const MAX_GROUPS = 8;
export const MAX_GROUP_LENGTH = 60;

/**
 * Limpia una lista de grupos.
 *
 * @param {unknown} value Lista (o valor suelto) de grupos.
 * @param {{ fallback?: string | null }} [options] Grupo a usar si queda vacía.
 * @returns {string[]}
 */
export function normalizeGroups(value, options = {}) {
  const fallback = options.fallback === undefined ? DEFAULT_BUSINESS_GROUP : options.fallback;
  const input = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const entry of input) {
    if (typeof entry !== 'string') continue;
    const name = entry.replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_LENGTH);
    if (!name) continue;
    const key = name.toLocaleLowerCase('es');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_GROUPS) break;
  }
  if (!out.length && fallback) out.push(fallback);
  return out;
}

/** ¿Este cliente pertenece al grupo? (comparación sin mayúsculas). */
export function isInGroup(customer, group) {
  if (!group || group === 'todos') return true;
  const key = String(group).toLocaleLowerCase('es');
  return normalizeGroups(customer?.groups).some((name) => name.toLocaleLowerCase('es') === key);
}
