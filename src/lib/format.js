/**
 * Formateo y cálculo de precios. Isomorfo (build + cliente comparten la misma lógica,
 * así el HTML estático y el modal nunca muestran cifras distintas).
 */

/** @param {unknown} value */
export function hasPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Formatea un importe. Devuelve `null` si no hay precio válido
 * (nunca inventamos ni mostramos "0").
 *
 * Los importes enteros se muestran sin decimales: RD$1,250 (no RD$1,250.00).
 * @param {unknown} amount
 * @param {{ currency?: string, locale?: string }} [options]
 * @returns {string|null}
 */
export function formatPrice(amount, options = {}) {
  if (!hasPrice(amount)) return null;
  const { currency = 'DOP', locale = 'es-DO' } = options;
  const value = Number(amount);
  const decimals = Number.isInteger(value) ? 0 : 2;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      // 'symbol' (no 'narrowSymbol'): en es-DO, DOP => "RD$1,250"
      currencyDisplay: 'symbol',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    // Fallback si el entorno no soporta Intl completo.
    return `${currency} ${value.toFixed(decimals)}`;
  }
}

/**
 * Normaliza una cantidad a entero dentro de [min, max].
 * @param {unknown} value
 * @param {{ min?: number, max?: number }} [bounds]
 */
export function normalizeQuantity(value, bounds = {}) {
  const { min = 1, max = 10 } = bounds;
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(Math.max(parsed, min), Math.max(min, max));
}

/**
 * Totales de un pedido. Si no hay precio configurado devuelve `hasPrice: false`
 * y el UI muestra "precio a confirmar" en vez de una cifra.
 * @param {object} input
 * @param {unknown} input.unitPrice
 * @param {unknown} input.quantity
 * @param {string} [input.currency]
 * @param {string} [input.locale]
 * @param {{ min?: number, max?: number }} [input.bounds]
 */
export function computeTotals(input) {
  const { unitPrice, quantity, currency = 'DOP', locale = 'es-DO', bounds } = input;
  const qty = normalizeQuantity(quantity, bounds);
  const priced = hasPrice(unitPrice);

  return {
    quantity: qty,
    hasPrice: priced,
    unitPrice: priced ? /** @type {number} */ (unitPrice) : null,
    unitPriceLabel: priced ? formatPrice(unitPrice, { currency, locale }) : null,
    /** @type {number|null} */
    total: priced ? Math.round(/** @type {number} */ (unitPrice) * qty * 100) / 100 : null,
    totalLabel: priced
      ? formatPrice(/** @type {number} */ (unitPrice) * qty, { currency, locale })
      : null,
  };
}

/**
 * Formatea fecha/hora corta en la zona del usuario (solo para uso interno/logs).
 * @param {Date} [date]
 * @param {string} [locale]
 */
export function formatDateTime(date = new Date(), locale = 'es-DO') {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString();
  }
}
