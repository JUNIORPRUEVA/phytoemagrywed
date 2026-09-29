/**
 * Validación y sanitización de entradas del usuario.
 *
 * Los errores se devuelven como CÓDIGOS (no como textos) y el UI los traduce
 * con `content.errors`. Así la lógica se prueba sin depender de copy.
 */

export const FIELD_LIMITS = Object.freeze({
  name: 80,
  phone: 24,
  location: 120,
  comment: 400,
});

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const WHITESPACE = /\s+/g;

/**
 * Limpia texto de entrada: elimina caracteres de control, normaliza espacios,
 * recorta longitud y quita `<`/`>` (defensa en profundidad: aunque el UI use
 * textContent, estos datos viajan después al CRM).
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeText(value, maxLength = 200) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(CONTROL_CHARS, ' ')
    .replace(/[<>]/g, '')
    .replace(WHITESPACE, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

/** @param {unknown} value */
export function sanitizeName(value) {
  return sanitizeText(value, FIELD_LIMITS.name);
}

/**
 * Normaliza teléfono a formato internacional legible (+ dígitos).
 * No adivina el país: usa lo que el usuario escribió.
 * @param {unknown} value
 * @returns {{ ok: true, value: string, digits: string } | { ok: false, code: string, value: string }}
 */
export function normalizePhone(value) {
  const raw = sanitizeText(value, FIELD_LIMITS.phone);
  if (!raw) return { ok: false, code: 'phone_required', value: '' };

  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return { ok: false, code: 'phone_invalid', value: raw };
  if (digits.length < 7) return { ok: false, code: 'phone_too_short', value: raw };
  if (digits.length > 15) return { ok: false, code: 'phone_too_long', value: raw };

  return { ok: true, value: `${hasPlus ? '+' : ''}${digits}`, digits };
}

/**
 * Valida el formulario de "quiero recibir información".
 * @param {object} fields
 * @param {unknown} fields.name
 * @param {unknown} fields.phone
 * @param {unknown} [fields.location]
 * @param {unknown} [fields.consent]
 * @param {object} [options]
 * @param {boolean} [options.requireLocation]
 */
export function validateLead(fields, options = {}) {
  const { requireLocation = false } = options;
  /** @type {Record<string, string>} */
  const errors = {};

  const name = sanitizeName(fields.name);
  if (!name) errors.name = 'name_required';
  else if (name.length < 2) errors.name = 'name_too_short';

  const phone = normalizePhone(fields.phone);
  if (!phone.ok) errors.phone = phone.code;

  const location = sanitizeText(fields.location, FIELD_LIMITS.location);
  if (requireLocation && !location) errors.location = 'location_required';

  const consent = fields.consent === true || fields.consent === 'true' || fields.consent === 'on';
  if (!consent) errors.consent = 'consent_required';

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    values: {
      name,
      phone: phone.ok ? phone.value : '',
      phoneDigits: phone.ok ? phone.digits : '',
      location,
      consent,
    },
  };
}

/**
 * ¿Este valor es un email con forma razonable? (nunca se envía email; solo contacto telefónico).
 * @param {unknown} value
 */
export function isEmailLike(value) {
  const email = sanitizeText(value, 120);
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email);
}
