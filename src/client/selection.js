/**
 * ESTADO DE LA SELECCIÓN (presentación + cantidad de unidades).
 *
 * Fuente única de verdad para el selector, el resumen, el modal de pedido y el
 * mensaje de WhatsApp. Se guarda en `sessionStorage` para que el usuario no
 * pierda su elección al recargar o al volver desde un enlace.
 *
 * Recordatorio del modelo: `variant` = presentación (cápsulas);
 * `quantity` = unidades de esa presentación.
 */

import { createStorage } from '../lib/storage.js';
import { findVariant } from '../lib/variants.js';

export const SELECTION_KEY = 'selection';

/**
 * @param {object} input
 * @param {ReturnType<import('../render/view.js').buildView>} input.view
 * @param {ReturnType<typeof createStorage>} [input.storage]
 */
export function createSelectionStore(input) {
  const { view } = input;
  const storage = input.storage ?? createStorage('pe', 'session');
  const variants = view.pricing.variants;
  const { min, max } = view.pricing.bounds;

  let variantId = view.pricing.defaultVariantId;
  let quantity = min;

  // Restaura la elección previa solo si sigue siendo válida.
  const saved = storage.get(SELECTION_KEY);
  if (saved && typeof saved === 'object') {
    if (findVariant(variants, saved.variantId)) variantId = saved.variantId;
    const savedQty = Number.parseInt(String(saved.quantity ?? ''), 10);
    if (Number.isFinite(savedQty)) quantity = Math.min(Math.max(savedQty, min), max);
  }

  /** @type {Set<(state: any, reason: string) => void>} */
  const listeners = new Set();

  function clampQuantity(value) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return min;
    return Math.min(Math.max(parsed, min), max);
  }

  function persist() {
    storage.set(SELECTION_KEY, { variantId, quantity });
  }

  /** Estado actual con totales ya calculados. */
  function get() {
    const variant = findVariant(variants, variantId) ?? variants[0] ?? null;
    const totals = view.pricing.forVariant(variant?.id ?? null, quantity);
    return { variant, variantId: variant?.id ?? null, quantity: totals.quantity, totals };
  }

  function emit(reason) {
    const state = get();
    for (const listener of listeners) {
      try {
        listener(state, reason);
      } catch (error) {
        if (view.site.tracking.debug) console.warn('[selection] listener falló:', error);
      }
    }
    return state;
  }

  return {
    /** @param {string} id */
    setVariant(id) {
      if (!findVariant(variants, id)) return get();
      variantId = id;
      persist();
      return emit('variant');
    },
    /** @param {unknown} value */
    setQuantity(value) {
      const next = clampQuantity(value);
      const changed = next !== quantity;
      quantity = next;
      persist();
      return changed ? emit('quantity') : get();
    },
    increase() {
      return this.setQuantity(quantity + 1);
    },
    decrease() {
      return this.setQuantity(quantity - 1);
    },
    get,
    /** @param {(state: any, reason: string) => void} listener */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset() {
      variantId = view.pricing.defaultVariantId;
      quantity = min;
      persist();
      return emit('reset');
    },
  };
}
