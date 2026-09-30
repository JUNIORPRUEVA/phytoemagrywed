/**
 * CATÁLOGO COMERCIAL — la ÚNICA fuente de verdad de precios.
 *
 * Deriva de `src/config/product.config.js` (los frascos y sus precios reales) y
 * añade la aritmética del pedido. Lo usan el servidor (`server/orders.mjs`) y el
 * panel (`GET /api/admin/catalog`): ninguna pantalla repite un precio.
 *
 * Regla del modelo (no se puede romper):
 *   - `variantId` → el FRASCO (5, 7, 10, 15, 20, 30 o 60 cápsulas).
 *   - `quantity`  → cuántos FRASCOS de ese tamaño.
 *   - `subtotal`  → `unitPrice × quantity`. El total del pedido es la suma.
 *
 * El precio unitario SIEMPRE sale del catálogo; si el negocio necesita un importe
 * distinto para un pedido concreto, puede indicarlo explícitamente (`unitPrice`)
 * y se respeta, pero el valor por defecto nunca se inventa.
 *
 * Este módulo es puro (no toca la red ni la base de datos): se puede probar solo.
 */

import { productConfig } from '../config/product.config.js';

/** Moneda del negocio (los precios del catálogo están en RD$). */
export const CATALOG_CURRENCY = 'DOP';

/** Error de validación del pedido, con un código estable para el API. */
export class CatalogError extends Error {
  /** @param {string} code @param {string} [message] */
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

/**
 * Catálogo publicado (sin campos internos y sin `image`).
 * @param {any} [product]
 */
export function catalogItems(product = productConfig) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  return variants
    .filter((variant) => Number(variant?.capsules) > 0 && Number.isFinite(Number(variant?.price)))
    .map((variant) => ({
      id: variant.id,
      capsules: Number(variant.capsules),
      price: Number(variant.price),
      currency: CATALOG_CURRENCY,
      completeBottle: variant.completeBottle === true,
      available: variant.available !== false,
      label: `Frasco de ${variant.capsules} cápsulas`,
    }));
}

/**
 * Un ítem del catálogo por id (o `null`). El id es lo único que viaja en un pedido.
 * @param {unknown} id
 * @param {any} [product]
 */
export function findCatalogItem(id, product = productConfig) {
  const key = String(id ?? '').trim();
  if (!key) return null;
  return catalogItems(product).find((item) => item.id === key) ?? null;
}

/** Cantidad entera positiva (por defecto 1). */
function normalizeQuantity(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 1;
  return Math.max(1, Math.trunc(number));
}

/**
 * Calcula un pedido a partir de sus líneas.
 *
 * @param {Array<{ variantId: string, quantity?: number, unitPrice?: number }>} [lines]
 * @param {{ discount?: number, product?: any, currency?: string }} [options]
 * @returns {{
 *   items: Array<{ variantId: string, capsules: number, variantName: string, label: string,
 *                  quantity: number, unitPrice: number, subtotal: number, totalCapsules: number,
 *                  completeBottle: boolean }>,
 *   itemCount: number,
 *   units: number,
 *   totalCapsules: number,
 *   subtotal: number,
 *   discount: number,
 *   total: number,
 *   currency: string
 * }}
 */
export function computeOrderTotals(lines = [], options = {}) {
  const product = options.product ?? productConfig;
  const currency = options.currency ?? CATALOG_CURRENCY;
  const rawLines = Array.isArray(lines) ? lines : [];
  const items = rawLines.map((line) => {
    const catalogItem = findCatalogItem(line?.variantId, product);
    if (!catalogItem) throw new CatalogError('invalid_variant', `Frasco desconocido: ${line?.variantId}`);
    const quantity = normalizeQuantity(line?.quantity);
    const explicit = Number(line?.unitPrice);
    const unitPrice =
      Number.isFinite(explicit) && explicit >= 0 && line?.unitPrice !== undefined && line?.unitPrice !== null
        ? Math.trunc(explicit)
        : catalogItem.price;
    const subtotal = unitPrice * quantity;
    return {
      variantId: catalogItem.id,
      capsules: catalogItem.capsules,
      variantName: `${catalogItem.capsules} cápsulas`,
      label: catalogItem.label,
      quantity,
      unitPrice,
      subtotal,
      totalCapsules: catalogItem.capsules * quantity,
      completeBottle: catalogItem.completeBottle,
    };
  });
  if (items.length === 0) throw new CatalogError('empty_order', 'El pedido no tiene frascos.');

  const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
  const requestedDiscount = Number(options.discount);
  // El descuento nunca puede superar el subtotal: no se regala dinero por error.
  const discount =
    Number.isFinite(requestedDiscount) && requestedDiscount > 0
      ? Math.min(Math.trunc(requestedDiscount), subtotal)
      : 0;

  return {
    items,
    itemCount: items.length,
    units: items.reduce((sum, item) => sum + item.quantity, 0),
    totalCapsules: items.reduce((sum, item) => sum + item.totalCapsules, 0),
    subtotal,
    discount,
    total: subtotal - discount,
    currency,
  };
}
