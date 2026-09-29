/**
 * PRESENTACIONES (variantes) del producto.
 *
 * Concepto clave del modelo:
 *   - `variant`  = presentación (5, 7, 10, 15, 20, 30 o 60 cápsulas). Tiene su
 *                  propio precio unitario.
 *   - `quantity` = cuántas UNIDADES de esa presentación pide el cliente.
 *
 *   10 cápsulas (RD$2,500) × 2 unidades = RD$5,000
 *
 * Las cápsulas NUNCA se mezclan con la cantidad de unidades del pedido.
 */

import { computeTotals, formatPrice, hasPrice, normalizeQuantity } from './format.js';

/** @typedef {object} Variant
 * @property {string} id            ej: 'capsules_10'
 * @property {number} capsules      ej: 10
 * @property {string} name          ej: '10 cápsulas'
 * @property {number} price         precio unitario de ESA presentación
 * @property {string|null} priceLabel
 * @property {boolean} completeBottle  true solo si es el frasco completo
 * @property {string|null} image    ruta base de la foto real (null si no existe)
 * @property {boolean} available
 * @property {number} order         orden de aparición en el selector
 */

/**
 * Normaliza una presentación de configuración. Devuelve `null` si no es válida
 * (sin precio real, sin cápsulas o duplicada): la web nunca muestra una
 * presentación con datos incompletos.
 * @param {any} raw
 * @param {{ currency?: string, locale?: string, index?: number }} [options]
 * @returns {Variant|null}
 */
export function normalizeVariant(raw, options = {}) {
  const { currency = 'DOP', locale = 'es-DO', index = 0 } = options;
  if (!raw || typeof raw !== 'object') return null;

  const capsules = Number.parseInt(String(raw.capsules ?? ''), 10);
  if (!Number.isFinite(capsules) || capsules <= 0) return null;

  const price = typeof raw.price === 'number' ? raw.price : Number.parseFloat(String(raw.price ?? ''));
  if (!hasPrice(price)) return null;

  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : `capsules_${capsules}`;
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : `${capsules} cápsulas`;

  return {
    id,
    capsules,
    name,
    price,
    priceLabel: formatPrice(price, { currency, locale }),
    completeBottle: raw.completeBottle === true,
    image: typeof raw.image === 'string' && raw.image.trim() !== '' ? raw.image.trim() : null,
    available: raw.available !== false,
    order: Number.isFinite(raw.order) ? Number(raw.order) : index,
  };
}

/**
 * Construye la lista de presentaciones a partir de `productConfig.variants`.
 * Se ordena por `order` (menor primero).
 * @param {any} product
 * @param {{ currency?: string, locale?: string, dedupe?: boolean }} [options]
 *   `dedupe: false` conserva los duplicados para que `validateVariants` pueda
 *   detectarlos (lo usa `check:content`); el render siempre deduplica.
 * @returns {Variant[]}
 */
export function buildVariants(product, options = {}) {
  const { dedupe = true } = options;
  const raw = Array.isArray(product?.variants) ? product.variants : [];
  /** @type {Variant[]} */
  const out = [];
  const seen = new Set();

  raw.forEach((item, index) => {
    const variant = normalizeVariant(item, { ...options, index });
    if (!variant) return;
    if (dedupe && seen.has(variant.id)) return;
    seen.add(variant.id);
    out.push(variant);
  });

  return out.sort((a, b) => a.order - b.order || a.capsules - b.capsules);
}

/** @param {Variant[]} variants @param {unknown} id @returns {Variant|null} */
export function findVariant(variants, id) {
  if (typeof id !== 'string' || !id) return null;
  return variants.find((variant) => variant.id === id) ?? null;
}

/**
 * Presentación más económica disponible (para el "Desde RD$…" del hero).
 * @param {Variant[]} variants
 * @returns {Variant|null}
 */
export function cheapestVariant(variants) {
  const usable = variants.filter((variant) => variant.available);
  if (usable.length === 0) return null;
  return usable.reduce((min, variant) => (variant.price < min.price ? variant : min), usable[0]);
}

/**
 * Totales de una presentación concreta para una cantidad de UNIDADES.
 * @param {Variant|null} variant
 * @param {unknown} quantity
 * @param {{ currency?: string, locale?: string, min?: number, max?: number }} [options]
 */
export function variantTotals(variant, quantity, options = {}) {
  const { currency = 'DOP', locale = 'es-DO', min = 1, max = 10 } = options;
  const totals = computeTotals({
    unitPrice: variant?.price ?? null,
    quantity,
    currency,
    locale,
    bounds: { min, max },
  });
  return {
    ...totals,
    variantId: variant?.id ?? null,
    variantName: variant?.name ?? null,
    capsules: variant?.capsules ?? null,
    /** Total de cápsulas del pedido (unidades × cápsulas de la presentación). */
    totalCapsules: variant ? variant.capsules * totals.quantity : null,
  };
}

/** Lista de precios para textos generados (FAQ, resúmenes). */
export function variantPriceList(variants) {
  return variants.map((variant) => ({ id: variant.id, name: variant.name, priceLabel: variant.priceLabel, capsules: variant.capsules }));
}

/**
 * Comprueba la coherencia de la configuración de presentaciones.
 * Usado por `scripts/check-content.mjs` y por los tests.
 * @param {Variant[]} variants
 * @returns {string[]} lista de problemas (vacía = todo correcto)
 */
export function validateVariants(variants) {
  /** @type {string[]} */
  const problems = [];
  if (variants.length === 0) problems.push('No hay presentaciones configuradas (productConfig.variants).');

  const ids = new Set();
  const capsules = new Set();
  for (const variant of variants) {
    if (ids.has(variant.id)) problems.push(`Presentación duplicada por id: ${variant.id}`);
    if (capsules.has(variant.capsules)) problems.push(`Presentación duplicada por cápsulas: ${variant.capsules}`);
    ids.add(variant.id);
    capsules.add(variant.capsules);
    if (!Number.isInteger(variant.price)) problems.push(`${variant.id}: el precio debería ser un número entero.`);
    if (variant.completeBottle && variant.capsules !== Math.max(...variants.map((v) => v.capsules))) {
      problems.push(`${variant.id}: "frasco completo" debería ser la presentación de más cápsulas.`);
    }
  }

  const completeBottles = variants.filter((variant) => variant.completeBottle);
  if (completeBottles.length > 1) problems.push('Solo una presentación puede estar marcada como frasco completo.');

  const ordered = variants.map((variant) => variant.capsules);
  if (JSON.stringify(ordered) !== JSON.stringify([...ordered].sort((a, b) => a - b))) {
    problems.push('Las presentaciones deberían estar ordenadas de menos a más cápsulas.');
  }
  return problems;
}

export { normalizeQuantity };
