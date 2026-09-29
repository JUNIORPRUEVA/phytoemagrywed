/**
 * Mensaje/enlace de WhatsApp de un pedido.
 *
 * Un solo sitio para construirlo: lo usan el selector, el modal de pedido y el
 * handler de enlaces, así el chat siempre recibe los mismos datos.
 */

import { buildWhatsAppMessage, buildWhatsAppUrl } from '../lib/whatsapp.js';
import { findVariant } from '../lib/variants.js';

/**
 * Selección con la que se construye el pedido.
 *
 * `variantId` permite pedir un frasco concreto (tarjetas del carrusel) sin
 * depender de que antes se haya pulsado la tarjeta: el frasco se resuelve aquí y
 * la cantidad es la que el visitante ya había elegido.
 */
function resolveSelection(ctx, variantId) {
  const current = ctx.selection.get();
  if (!variantId) return current;
  const variant = findVariant(ctx.view.pricing.variants, variantId);
  if (!variant) return current;
  const totals = ctx.view.pricing.forVariant(variant.id, current.quantity);
  return { variant, variantId: variant.id, quantity: totals.quantity, totals };
}

/**
 * @param {object} ctx  contexto de la app (ver `main.js`)
 * @param {object} [options]
 * @param {{ variant: any, quantity: number, totals: any }} [options.selection]
 * @param {string} [options.variantId] frasco concreto (tarjeta del carrusel)
 * @param {{ name?: string|null, location?: string|null }} [options.customer]
 * @param {string} [options.template]
 * @returns {string|null} URL de WhatsApp o null si no hay número configurado
 */
export function buildOrderWhatsAppUrl(ctx, options = {}) {
  const { view } = ctx;
  if (!view.whatsapp.enabled) return null;

  const selection = options.selection ?? resolveSelection(ctx, options.variantId);
  const { variant, quantity, totals } = selection;
  const customer = options.customer ?? {};

  const message = buildWhatsAppMessage({
    template: options.template ?? view.content.whatsapp.checkout,
    data: {
      labels: view.whatsapp.labels,
      productName: view.product.name,
      variantName: variant?.name ?? null,
      capsules: variant?.capsules ?? null,
      quantity,
      unitPriceLabel: totals.hasPrice ? totals.unitPriceLabel : null,
      totalLabel: totals.hasPrice ? totals.totalLabel : null,
      totalCapsules: totals.totalCapsules,
      customerName: customer.name ?? null,
      location: customer.location ?? null,
      ref: ctx.getAttributionRef(),
      includeRef: view.whatsapp.includeRef,
    },
  });

  return buildWhatsAppUrl({ number: view.whatsapp.number, message });
}

/**
 * Mensaje/enlace de WhatsApp de un CONTACTO del formulario.
 *
 * El formulario "quiero que me escriban" no puede quedarse solo en el navegador
 * del visitante: si no hay CRM, ese contacto se perdería. Con esto el lead llega
 * al WhatsApp del negocio con nombre, teléfono y ubicación, y se puede responder.
 *
 * @param {object} ctx  contexto de la app (ver `main.js`)
 * @param {{ name?: string|null, phone?: string|null, location?: string|null }} lead
 * @returns {string|null} URL de WhatsApp o null si no hay número configurado
 */
export function buildLeadWhatsAppUrl(ctx, lead = {}) {
  const { view } = ctx;
  if (!view.whatsapp.enabled) return null;

  const message = buildWhatsAppMessage({
    template: view.content.whatsapp.lead,
    data: {
      labels: view.whatsapp.labels,
      customerName: lead.name ?? null,
      customerPhone: lead.phone ?? null,
      location: lead.location ?? null,
      ref: ctx.getAttributionRef(),
      includeRef: view.whatsapp.includeRef,
    },
  });

  return buildWhatsAppUrl({ number: view.whatsapp.number, message });
}

/** Datos de la presentación para eventos y payloads. */
export function variantEventData(selection) {
  const { variant, quantity, totals } = selection;
  return {
    variantId: variant?.id ?? null,
    variantName: variant?.name ?? null,
    capsules: variant?.capsules ?? null,
    quantity,
    totalCapsules: totals.totalCapsules ?? null,
    unitPrice: totals.hasPrice ? totals.unitPrice : null,
    total: totals.hasPrice ? totals.total : null,
    priceKnown: totals.hasPrice,
  };
}
