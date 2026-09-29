/**
 * WhatsApp: ÚNICO lugar del código donde se construye el enlace.
 * El número sale de configuración/env (`PHYTO_WHATSAPP_NUMBER`), nunca duplicado
 * en componentes.
 */

import { attributionRef } from './attribution.js';

const WA_BASE = 'https://wa.me';

/** Etiquetas del mensaje (sobrescribibles desde `content.whatsapp.labels`). */
export const DEFAULT_MESSAGE_LABELS = Object.freeze({
  product: 'Producto',
  presentation: 'Frasco',
  capsules: 'Cápsulas',
  quantity: 'Cantidad',
  units: 'frascos',
  totalCapsules: 'Cápsulas en total',
  unitPrice: 'Precio por frasco',
  total: 'Total',
  name: 'Nombre',
  phone: 'WhatsApp o teléfono',
  location: 'Ubicación',
  ref: 'Ref',
});

/**
 * Normaliza el número a dígitos internacionales.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeWhatsAppNumber(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

/** @param {unknown} raw */
export function isWhatsAppConfigured(raw) {
  return normalizeWhatsAppNumber(raw) !== null;
}

/**
 * Construye el mensaje inicial. Se puede adjuntar el origen (campaña) para
 * poder identificarlo manualmente en WhatsApp mientras no exista backend.
 * @param {object} input
 * @param {string} input.template
 * @param {{ productName?: string|null, quantity?: number|null, unitPriceLabel?: string|null, totalLabel?: string|null, customerName?: string|null, customerPhone?: string|null, location?: string|null, ref?: string|null, includeRef?: boolean, extraLines?: string[] }} [input.data]
 * @returns {string}
 */
export function buildWhatsAppMessage(input) {
  const { template, data = {} } = input;
  const labels = { ...DEFAULT_MESSAGE_LABELS, ...(data.labels ?? {}) };
  const lines = [String(template).trim()];

  const quantity = Number(data.quantity) || null;
  const details = [];
  if (data.productName) details.push(`${labels.product}: ${data.productName}`);
  // La presentación es lo primero que debe ver el negocio en el chat.
  if (data.variantName) details.push(`${labels.presentation}: ${data.variantName}`);
  if (quantity) details.push(`${labels.quantity}: ${quantity}`);
  // Precio unitario y cápsulas totales solo aportan cuando hay más de 1 unidad.
  if (quantity && quantity > 1 && data.unitPriceLabel) details.push(`${labels.unitPrice}: ${data.unitPriceLabel}`);
  if (quantity && quantity > 1 && data.totalCapsules) {
    details.push(`${labels.totalCapsules}: ${data.totalCapsules}`);
  }
  if (data.totalLabel) details.push(`${labels.total}: ${data.totalLabel}`);
  // Datos de contacto: en el formulario el negocio necesita el teléfono para
  // poder devolver la llamada, no solo el nombre.
  if (data.customerName) details.push(`${labels.name}: ${data.customerName}`);
  if (data.customerPhone) details.push(`${labels.phone}: ${data.customerPhone}`);
  if (data.location) details.push(`${labels.location}: ${data.location}`);

  if (details.length > 0) lines.push('', ...details);
  if (Array.isArray(data.extraLines)) {
    const extra = data.extraLines.filter(Boolean);
    if (extra.length > 0) lines.push('', ...extra);
  }
  if (data.ref && data.includeRef !== false) lines.push('', `${labels.ref}: ${data.ref}`);

  return lines.join('\n').slice(0, 900);
}

/**
 * Construye la URL final de WhatsApp.
 * @param {object} input
 * @param {string} input.number
 * @param {string} input.message
 * @returns {string|null}
 */
export function buildWhatsAppUrl(input) {
  const digits = normalizeWhatsAppNumber(input.number);
  if (!digits) return null;
  const message = typeof input.message === 'string' ? input.message : '';
  return `${WA_BASE}/${digits}?text=${encodeURIComponent(message)}`;
}

/**
 * Datos de origen que después se enviarán al CRM junto al evento.
 * @param {object} input
 * @param {string} input.source
 * @param {import('./attribution.js').Attribution|null} [input.attribution]
 */
export function buildWhatsAppContext(input) {
  const ref = attributionRef(input.attribution ?? null);
  return { source: input.source, ref, attribution: input.attribution ?? null };
}
