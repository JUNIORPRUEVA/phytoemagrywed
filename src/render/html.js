/**
 * Helpers de generación de HTML (solo build-time).
 *
 * Todo texto que venga de configuración pasa por `escapeHtml()`: la landing
 * nunca inyecta HTML desde datos.
 */

const ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** @param {unknown} value */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => ENTITIES[/** @type {keyof typeof ENTITIES} */ (char)]);
}

/**
 * Atributo HTML. Devuelve '' si el valor es null/false; si es `true`
 * devuelve el atributo booleano.
 * @param {string} name
 * @param {unknown} value
 */
export function attr(name, value) {
  if (value === null || value === undefined || value === false || value === '') return '';
  if (value === true) return ` ${name}`;
  return ` ${name}="${escapeHtml(value)}"`;
}

/** @param {Record<string, unknown>} map */
export function attrs(map) {
  return Object.entries(map)
    .map(([name, value]) => attr(name, value))
    .join('');
}

/** @param {...(string|false|null|undefined)} values */
export function classNames(...values) {
  return values.filter(Boolean).join(' ');
}

/**
 * Une bloques HTML ignorando los vacíos.
 * @param {...(string|false|null|undefined)} parts
 */
export function join(...parts) {
  return parts.filter((part) => typeof part === 'string' && part.trim() !== '').join('\n');
}

/** @param {unknown} value @returns {value is string} */
export function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}
