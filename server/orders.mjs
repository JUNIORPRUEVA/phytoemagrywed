/**
 * PEDIDOS Y COMPROBANTE — el corazón comercial del CRM (fase S4).
 *
 * QUÉ ES UN PEDIDO AQUÍ
 *   Un pedido es una INTENCIÓN DE VENTA concreta, con sus frascos y su total, que
 *   puede nacer de tres sitios: la web (`order_intent`), el panel a mano, o —lo
 *   nuevo— una conversación de WhatsApp. En los tres casos el precio sale del
 *   catálogo (`src/lib/catalog.js`), nunca se escribe a mano en una pantalla.
 *
 * DÓNDE VIVE
 *   En la misma tabla que ya existía (`phytoemagry_items`), que ahora guarda
 *   además `conversation_id`, `order_number` y `order_json`. La PRIMERA línea del
 *   pedido sigue copiada en las columnas de siempre (`variant_id`, `quantity`,
 *   `unit_price`, `total`): así el CSV, las estadísticas y la venta a Meta siguen
 *   funcionando igual y ningún dato anterior se rompe.
 *
 * COMPROBANTE
 *   «Factura de compra» (NUNCA «factura fiscal»: no hay integración fiscal).
 *   Dos vistas: los datos para pintarlo en el CRM y un HTML ligero e imprimible.
 *   El teléfono se muestra ENMASCARADO. Sin afirmaciones médicas.
 */

import { randomBytes } from 'node:crypto';

import { CATALOG_CURRENCY, CatalogError, computeOrderTotals, findCatalogItem } from '../src/lib/catalog.js';
import { describeLocation, orderLocationSnapshot } from './locations.mjs';

/**
 * Estados del PEDIDO (no de la conversación).
 *
 * No se duplican los equivalentes que ya existían:
 *   - `nuevo`      = recién creado / pendiente de confirmar (equivale a «pendiente»)
 *   - `confirmado` = el cliente confirma (equivale a «confirmado»)
 *   - `entregado`  = venta real (equivale a «entregado»)
 *   - `perdido`    = nunca se cerró (equivale a «perdido»)
 * y se añaden solo los que faltaban de verdad en el proceso de entrega:
 *   - `en_preparacion`, `enviado` y `cancelado`.
 *
 * No se crea «borrador»: un pedido que no existe todavía es un formulario abierto,
 * no un pedido guardado. Y `contactado`/`interesado` son de la CONVERSACIÓN.
 */
export const ORDER_STATUSES = Object.freeze([
  'nuevo',
  'confirmado',
  'en_preparacion',
  'enviado',
  'entregado',
  'cancelado',
  'perdido',
]);

export const ORDER_STATUS_LABELS = Object.freeze({
  nuevo: 'Pendiente',
  contactado: 'Contactado',
  interesado: 'Interesado',
  confirmado: 'Confirmado',
  en_preparacion: 'En preparación',
  enviado: 'Enviado',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
  perdido: 'Perdido',
});

/** Estados de un pedido que ya no pide trabajo. */
export const ORDER_CLOSED_STATUSES = Object.freeze(['entregado', 'cancelado', 'perdido']);

/** Estados del pedido que representan trabajo abierto. */
export const ORDER_OPEN_STATUSES = Object.freeze(
  ORDER_STATUSES.filter((status) => !ORDER_CLOSED_STATUSES.includes(status)),
);

/** Fuente de verdad de negocio: una compra completada es un pedido entregado. */
export const BUSINESS_COMPLETED_PURCHASE_STATUS = 'entregado';

/** ¿Este estado representa una compra completada para clientes, ventas e inventario? */
export function isCompletedPurchaseStatus(value) {
  return String(value ?? '').trim() === BUSINESS_COMPLETED_PURCHASE_STATUS;
}

export const PAYMENT_METHODS = Object.freeze(['CASH', 'TRANSFER']);

export const PAYMENT_METHOD_LABELS = Object.freeze({
  CASH: 'Efectivo',
  TRANSFER: 'Transferencia',
});

/** ¿Es un estado de pedido válido? */
export function isOrderStatus(value) {
  return ORDER_STATUSES.includes(String(value ?? '').trim());
}

export function normalizePaymentMethod(value) {
  const clean = String(value ?? '').trim().toUpperCase();
  return PAYMENT_METHODS.includes(clean) ? clean : null;
}

/** Identificador corto y aleatorio. */
function newId() {
  return randomBytes(16).toString('hex');
}

/** Texto corto sin saltos de línea. */
function short(value, max = 120) {
  if (value === null || value === undefined) return null;
  const clean = String(value).replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

/** Texto largo (notas): conserva los saltos de línea. */
function long(value, max = 2000) {
  if (value === null || value === undefined) return null;
  const clean = String(value).replace(/\r\n/g, '\n').trim();
  return clean ? clean.slice(0, max) : null;
}

/**
 * Número legible y ESTABLE del pedido. Se deriva del id (no se cuenta nada), así
 * que dos servidores nunca pueden generar el mismo y un reinicio no lo cambia.
 * @param {string} id
 */
export function orderNumber(id) {
  const clean = String(id ?? '').replace(/[^0-9a-zA-Z]/g, '');
  return `PE-${clean.slice(-6).toUpperCase() || '000000'}`;
}

/** Teléfono parcialmente enmascarado: se ve el país y los últimos 2 dígitos. */
export function maskPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const tail = digits.slice(-2);
  const head = digits.slice(0, Math.min(4, Math.max(0, digits.length - 4)));
  return `+${head}••• ••${tail}`;
}

/**
 * Construye la fila del pedido (lo que se guarda) y su detalle (`order_json`).
 *
 * @param {object} input
 * @param {Array<{variantId: string, quantity?: number, unitPrice?: number}>} input.items
 * @param {string} [input.id]              id explícito (idempotencia desde el panel)
 * @param {string} [input.customerId]
 * @param {string} [input.conversationId]
 * @param {string} [input.name]            nombre del cliente (si no hay ficha)
 * @param {string} [input.phone]
 * @param {string} [input.location]
 * @param {number} [input.discount]
 * @param {string} [input.notes]
 * @param {{address?: string, city?: string, note?: string, method?: string}} [input.delivery]
 * @param {string} [input.status]          estado inicial (por defecto `nuevo`)
 * @param {string} [input.paymentMethod]   CASH | TRANSFER
 * @param {string} [input.date]            fecha ISO del pedido
 * @param {number} [input.deliveryFee]     costo de delivery en RD$ (opcional, >= 0)
 * @param {any}    [input.gpsLocation]     ubicación GPS de entrega (opcional)
 * @param {string} [input.recordedBy]
 * @param {any}    [input.product]         catálogo alternativo (tests)
 */
export function buildOrder(input = {}) {
  const totals = computeOrderTotals(input.items, {
    discount: input.discount,
    deliveryFee: input.deliveryFee,
    product: input.product,
  });
  const id = short(input.id, 80) ?? newId();
  const createdAt = short(input.date, 40) ?? new Date().toISOString();
  const status = isOrderStatus(input.status) ? String(input.status) : 'nuevo';
  const paymentMethod = normalizePaymentMethod(input.paymentMethod ?? input.payment_method);
  const number = orderNumber(id);
  const first = totals.items[0];
  /*
   * ENTREGA. Dos cosas independientes a propósito (§26):
   *   · `location`  → GPS, OPCIONAL. Se guarda un SNAPSHOT inmutable: si el cliente
   *     manda otra ubicación después, este pedido sigue representando la que se usó.
   *   · `delivery_fee` → costo de delivery, OPCIONAL e independiente del GPS.
   * `city`/`address` siguen existiendo para no destruir lo que ya estaba guardado
   * en pedidos antiguos; el formulario nuevo ya no los pide.
   */
  const delivery = {
    // El costo de envío NO se inventa: si no se indica, es 0 (no se cobra).
    fee: totals.deliveryFee,
    // GPS (opcional). OJO: `input.location` es la CIUDAD heredada, no esto.
    location: input.gpsLocation ? orderLocationSnapshot(input.gpsLocation) : null,
    address: long(input.delivery?.address, 240),
    city: short(input.delivery?.city, 120),
    note: long(input.delivery?.note, 400),
    method: short(input.delivery?.method, 40),
    shipping: null,
  };
  const order = {
    id,
    order_number: number,
    source: 'manual',
    channel: short(input.channel, 40) ?? 'panel',
    customer_id: short(input.customerId, 80),
    conversation_id: short(input.conversationId, 80),
    items: totals.items,
    item_count: totals.itemCount,
    units: totals.units,
    total_capsules: totals.totalCapsules,
    subtotal: totals.subtotal,
    discount: totals.discount,
    delivery_fee: totals.deliveryFee,
    total: totals.total,
    currency: totals.currency,
    shipping: null,
    notes: long(input.notes, 2000),
    delivery,
    payment_method: paymentMethod,
    payment_method_label: paymentMethod ? PAYMENT_METHOD_LABELS[paymentMethod] : null,
    payment_status: status === 'cancelado' ? 'void' : 'paid',
    status,
    recorded_by: short(input.recordedBy, 60) ?? 'panel',
    created_at: createdAt,
  };

  // El payload conserva la forma histórica (una línea) para no romper nada que
  // ya lo lea; el detalle completo va en `order_json`.
  const payload = {
    type: 'order_intent',
    id,
    createdAt,
    source: order.channel === 'whatsapp' ? 'whatsapp' : 'manual',
    channel: order.channel,
    recordedBy: order.recorded_by,
    orderNumber: number,
    customerId: order.customer_id,
    conversationId: order.conversation_id,
    name: short(input.name, 120),
    phone: short(input.phone, 40),
    location: short(input.location, 120),
    variantId: first.variantId,
    variantName: first.variantName,
    capsules: first.capsules,
    quantity: first.quantity,
    unitPrice: first.unitPrice,
    total: order.total,
    subtotal: order.subtotal,
    discount: order.discount,
    currency: order.currency,
    items: order.items,
    notes: order.notes,
    delivery,
    paymentMethod,
    payment_method: paymentMethod,
    meta: { source: 'order', recordedBy: order.recorded_by },
  };

  const row = {
    id,
    type: 'order_intent',
    receivedAt: createdAt,
    name: payload.name,
    phone: payload.phone,
    location: payload.location,
    variantId: first.variantId,
    variantName: first.variantName,
    capsules: first.capsules,
    quantity: first.quantity,
    unitPrice: first.unitPrice,
    total: order.total,
    currency: order.currency,
    source: order.channel,
    sessionId: null,
    customerId: order.customer_id,
    conversationId: order.conversation_id,
    orderNumber: number,
    orderJson: JSON.stringify(order),
    payload: JSON.stringify(payload),
  };
  return { row, order, totals };
}

/**
 * Lee el detalle (`order_json`) de un pedido ya guardado.
 *
 * Si el pedido es ANTIGUO (creado antes de esta fase) no tiene `order_json`:
 * se deriva de sus columnas, con UNA línea. Los pedidos de siempre se ven igual.
 *
 * @param {any} item fila del store (listAdmin)
 */
export function orderOf(item) {
  if (!item) return null;
  const raw = item.order_json ?? item.orderJson;
  if (raw) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed && Array.isArray(parsed.items)) return parsed;
    } catch {
      /* detalle ilegible: se cae a la reconstrucción desde columnas */
    }
  }
  if (item.type !== 'order_intent') return null;
  const quantity = Number(item.quantity) || 1;
  const unitPrice = Number(item.unit_price ?? item.unitPrice) || 0;
  const total = Number(item.total) || unitPrice * quantity;
  const id = String(item.id ?? '');
  const catalogItem = findCatalogItem(item.variant_id ?? item.variantId);
  return {
    id,
    order_number: item.order_number ?? item.orderNumber ?? orderNumber(id),
    source: 'legacy',
    channel: item.source ?? 'panel',
    customer_id: item.customer_id ?? null,
    conversation_id: item.conversation_id ?? null,
    items: [
      {
        variantId: item.variant_id ?? item.variantId ?? null,
        capsules: Number(item.capsules) || catalogItem?.capsules || null,
        variantName: item.variant_name ?? item.variantName ?? null,
        label: item.variant_name ? `Frasco de ${item.variant_name}` : null,
        quantity,
        unitPrice,
        subtotal: unitPrice * quantity,
        totalCapsules: (Number(item.capsules) || 0) * quantity,
        completeBottle: catalogItem?.completeBottle === true,
      },
    ],
    item_count: 1,
    units: quantity,
    total_capsules: (Number(item.capsules) || 0) * quantity,
    subtotal: unitPrice * quantity,
    discount: 0,
    // Pedido anterior a la fase de delivery: no se le inventa un costo.
    delivery_fee: 0,
    total,
    currency: item.currency ?? CATALOG_CURRENCY,
    shipping: null,
    notes: item.notes ?? null,
    delivery: { fee: 0, location: null, address: null, city: item.location ?? null, note: null, method: null, shipping: null },
    payment_method: item.payment_method ?? null,
    payment_method_label: item.payment_method ? PAYMENT_METHOD_LABELS[item.payment_method] ?? item.payment_method : null,
    payment_status: item.status === 'cancelado' ? 'void' : null,
    status: item.status ?? 'nuevo',
    recorded_by: 'histórico',
    created_at: item.received_at ?? null,
  };
}

/**
 * Datos del COMPROBANTE DE COMPRA (no «factura»).
 *
 * @param {{ order: any, customer?: any, businessName?: string, timeZone?: string }} input
 */
export function buildReceipt({ order, customer = null, businessName = 'Phytoemagry' }) {
  if (!order) return null;
  const items = (order.items ?? []).map((line) => ({
    label: line.label ?? `Frasco de ${line.capsules} cápsulas`,
    quantity: Number(line.quantity) || 1,
    unitPrice: Number(line.unitPrice) || 0,
    subtotal: Number(line.subtotal) || 0,
  }));
  return {
    business: businessName,
    document: 'Factura de compra',
    order_number: order.order_number,
    date: order.created_at,
    customer_name: customer?.name ?? null,
    // Enmascarado SIEMPRE: el comprobante se comparte con el cliente.
    phone_masked: maskPhone(customer?.phone_e164 ?? customer?.phone ?? null),
    items,
    subtotal: Number(order.subtotal) || 0,
    discount: Number(order.discount) || 0,
    // DELIVERY: solo aparece si se cobró algo (en el comprobante, un «RD$ 0» es ruido).
    delivery_fee: Number(order.delivery_fee ?? order.delivery?.fee ?? 0) || 0,
    shipping: order.shipping ?? order.delivery?.shipping ?? null,
    total: Number(order.total) || 0,
    currency: order.currency ?? CATALOG_CURRENCY,
    /*
     * UBICACIÓN DE ENTREGA: se dice QUE EXISTE y se puede abrir el mapa, pero el
     * comprobante NO imprime coordenadas: es un documento que se comparte con el
     * cliente (y con quien él quiera).
     */
    has_location: Boolean(order.delivery?.location),
    location_label: order.delivery?.location ? describeLocation(order.delivery.location).title : null,
    location_address: order.delivery?.location ? describeLocation(order.delivery.location).detail : null,
    location: order.delivery?.location ? orderLocationSnapshot(order.delivery.location) : null,
    status: order.status ?? 'nuevo',
    status_label: ORDER_STATUS_LABELS[order.status ?? 'nuevo'] ?? order.status,
    payment_method: order.payment_method ?? null,
    payment_method_label: order.payment_method ? PAYMENT_METHOD_LABELS[order.payment_method] ?? order.payment_method : null,
    payment_status: order.payment_status ?? null,
    cancelled_at: order.cancelled_at ?? null,
    cancel_reason: order.cancel_reason ?? null,
    // Agradecimiento neutro: sin promesas, sin plazos y sin nada médico.
    thanks: 'Gracias por tu compra. Si tienes cualquier duda, escríbenos por WhatsApp.',
    note: 'Documento generado por Phytoemagry para confirmar los detalles de tu compra.',
  };
}

/** Escapa texto para HTML (el comprobante se abre en el navegador). */
function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Dinero en RD$ sin depender del locale del servidor. */
function money(value, currency = 'DOP') {
  const number = Number(value) || 0;
  const formatted = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(number);
  return `${currency === 'DOP' ? 'RD$' : currency} ${formatted}`;
}

/** Fecha legible en la zona del negocio. */
function prettyDate(value, timeZone = 'America/Santo_Domingo') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('es-DO', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date);
}

function pdfText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, (char) => {
      if (char === '×') return 'x';
      if (char === '−' || char === '–' || char === '—') return '-';
      if (char === '•') return '.';
      return '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function pdfEsc(value) {
  return pdfText(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function pdfLine(text, x, y, size = 11, font = 'F1') {
  return `BT /${font} ${size} Tf ${x} ${y} Td (${pdfEsc(text)}) Tj ET\n`;
}

function pdfRule(y) {
  return `0.78 0.84 0.8 RG 50 ${y} m 545 ${y} l S\n`;
}

/**
 * PDF sencillo de la factura para compartir desde el móvil.
 * Se mantiene sin dependencias: el PDF contiene texto vectorial y abre en
 * cualquier visor del navegador.
 *
 * @param {ReturnType<typeof buildReceipt>} receipt
 * @param {{ timeZone?: string }} [options]
 */
export function receiptPdf(receipt, options = {}) {
  const lines = [];
  let y = 790;
  lines.push('0.043 0.42 0.31 rg\n');
  lines.push(pdfLine(receipt.business, 50, y, 22, 'F2'));
  y -= 24;
  lines.push('0.38 0.45 0.42 rg\n');
  lines.push(pdfLine(receipt.document, 50, y, 10, 'F2'));
  y -= 24;
  lines.push(pdfRule(y));
  y -= 22;

  const facts = [
    ['Pedido', receipt.order_number],
    ['Fecha', prettyDate(receipt.date, options.timeZone)],
    receipt.customer_name ? ['Cliente', receipt.customer_name] : null,
    receipt.phone_masked ? ['Telefono', receipt.phone_masked] : null,
    receipt.payment_method_label ? ['Pago', receipt.payment_method_label] : null,
    ['Estado', receipt.status_label],
  ].filter(Boolean);

  for (const [label, value] of facts) {
    lines.push('0.38 0.45 0.42 rg\n');
    lines.push(pdfLine(label, 50, y, 10, 'F1'));
    lines.push('0.09 0.13 0.11 rg\n');
    lines.push(pdfLine(value, 170, y, 10, 'F2'));
    y -= 16;
  }

  y -= 8;
  lines.push(pdfRule(y));
  y -= 20;
  lines.push('0.38 0.45 0.42 rg\n');
  lines.push(pdfLine('Detalle', 50, y, 9, 'F2'));
  lines.push(pdfLine('Cant.', 320, y, 9, 'F2'));
  lines.push(pdfLine('Precio', 380, y, 9, 'F2'));
  lines.push(pdfLine('Importe', 470, y, 9, 'F2'));
  y -= 14;
  lines.push(pdfRule(y));
  y -= 18;

  for (const item of receipt.items ?? []) {
    lines.push('0.09 0.13 0.11 rg\n');
    lines.push(pdfLine(item.label, 50, y, 10, 'F1'));
    lines.push(pdfLine(item.quantity, 330, y, 10, 'F1'));
    lines.push(pdfLine(money(item.unitPrice, receipt.currency), 380, y, 10, 'F1'));
    lines.push(pdfLine(money(item.subtotal, receipt.currency), 470, y, 10, 'F2'));
    y -= 18;
  }

  y -= 8;
  lines.push(pdfRule(y));
  y -= 20;
  const totals = [
    ['Productos', money(receipt.subtotal, receipt.currency)],
    receipt.discount ? ['Descuento', `-${money(receipt.discount, receipt.currency)}`] : null,
    receipt.delivery_fee ? ['Delivery', money(receipt.delivery_fee, receipt.currency)] : null,
    receipt.shipping ? ['Envio', money(receipt.shipping, receipt.currency)] : null,
  ].filter(Boolean);
  for (const [label, value] of totals) {
    lines.push('0.38 0.45 0.42 rg\n');
    lines.push(pdfLine(label, 330, y, 10, 'F1'));
    lines.push('0.09 0.13 0.11 rg\n');
    lines.push(pdfLine(value, 455, y, 10, 'F2'));
    y -= 16;
  }
  y -= 4;
  lines.push('0.043 0.42 0.31 rg\n');
  lines.push(pdfLine('TOTAL', 330, y, 15, 'F2'));
  lines.push(pdfLine(money(receipt.total, receipt.currency), 455, y, 15, 'F2'));

  y -= 34;
  if (receipt.has_location) {
    lines.push('0.38 0.45 0.42 rg\n');
    lines.push(pdfLine(`Ubicacion de entrega registrada${receipt.location_label ? `: ${receipt.location_label}` : ''}.`, 50, y, 9, 'F1'));
    y -= 14;
  }
  lines.push(pdfLine(receipt.thanks, 50, y, 9, 'F1'));
  y -= 14;
  lines.push(pdfLine(receipt.note, 50, y, 9, 'F1'));

  const stream = lines.join('');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * HTML ligero e imprimible de la factura. Es el documento que se comparte o se
 * imprime desde el navegador si el negocio quiere.
 * No lleva dependencias ni imágenes: se abre en cualquier móvil, aunque no haya red.
 *
 * @param {ReturnType<typeof buildReceipt>} receipt
 * @param {{ timeZone?: string }} [options]
 */
export function receiptHtml(receipt, options = {}) {
  if (!receipt) return '<!doctype html><title>Factura</title><p>Sin datos.</p>';
  const pdfUrl = `./factura`;
  const rows = receipt.items
    .map(
      (line) => `<tr>
        <td>${esc(line.label)}</td>
        <td class="num">${esc(line.quantity)}</td>
        <td class="num">${esc(money(line.unitPrice, receipt.currency))}</td>
        <td class="num">${esc(money(line.subtotal, receipt.currency))}</td>
      </tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(receipt.document)} ${esc(receipt.order_number)} · ${esc(receipt.business)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 40px; background: #f2f4f2; color: #16221c;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .toolbar { position: sticky; top: 0; z-index: 2; max-width: 420px; margin: 0 auto 12px;
    display: grid; grid-template-columns: auto 1fr; gap: 8px; }
  .btn { min-height: 42px; display: inline-flex; align-items: center; justify-content: center;
    padding: 9px 12px; border: 1px solid #dce6e1; border-radius: 12px; background: #fff;
    color: #0b6b4f; font: inherit; font-weight: 700; text-decoration: none; }
  .btn--primary { background: #0b6b4f; color: #fff; border-color: #0b6b4f; }
  .sheet { max-width: 420px; margin: 0 auto; background: #fff; border-radius: 16px;
    padding: 24px 20px; box-shadow: 0 10px 30px rgba(16,40,28,.12); }
  .brand { font-size: 22px; font-weight: 800; letter-spacing: .02em; color: #0b6b4f; margin: 0; }
  .doc { margin: 4px 0 18px; font-size: 13px; text-transform: uppercase; letter-spacing: .12em; color: #62736b; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0 0 18px; font-size: 14px; }
  dt { color: #62736b; }
  dd { margin: 0; text-align: right; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 8px 4px; border-bottom: 1px solid #e4e9e5; text-align: left; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #62736b; }
  .num { text-align: right; white-space: nowrap; }
  .totals { margin-top: 14px; display: grid; gap: 6px; }
  .totals div { display: flex; justify-content: space-between; font-size: 14px; }
  .totals .grand { font-size: 20px; font-weight: 800; border-top: 2px solid #0b6b4f; padding-top: 10px; margin-top: 6px; color: #0b6b4f; }
  .footer { margin-top: 22px; font-size: 13px; color: #62736b; }
  @media print { body { background: #fff; padding: 0; } .toolbar { display: none; } .sheet { box-shadow: none; border-radius: 0; max-width: none; } }
</style>
</head>
<body>
  <nav class="toolbar" aria-label="Acciones del comprobante">
    <button class="btn" type="button" onclick="history.length > 1 ? history.back() : location.assign('/admin/')">Volver</button>
    <button class="btn btn--primary" type="button" id="share">Compartir factura</button>
  </nav>
  <main class="sheet">
    <h1 class="brand">${esc(receipt.business)}</h1>
    <p class="doc">${esc(receipt.document)}</p>
    <dl>
      <dt>Pedido</dt><dd>${esc(receipt.order_number)}</dd>
      <dt>Fecha</dt><dd>${esc(prettyDate(receipt.date, options.timeZone))}</dd>
      ${receipt.customer_name ? `<dt>Cliente</dt><dd>${esc(receipt.customer_name)}</dd>` : ''}
      ${receipt.phone_masked ? `<dt>Teléfono</dt><dd>${esc(receipt.phone_masked)}</dd>` : ''}
      ${receipt.payment_method_label ? `<dt>Pago</dt><dd>${esc(receipt.payment_method_label)}</dd>` : ''}
      <dt>Estado</dt><dd>${esc(receipt.status_label)}</dd>
      ${receipt.cancelled_at ? `<dt>Anulada</dt><dd>${esc(prettyDate(receipt.cancelled_at, options.timeZone))}</dd>` : ''}
      ${receipt.cancel_reason ? `<dt>Motivo</dt><dd>${esc(receipt.cancel_reason)}</dd>` : ''}
    </dl>
    <table>
      <thead><tr><th>Detalle</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Importe</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals">
      <div><span>Productos</span><strong>${esc(money(receipt.subtotal, receipt.currency))}</strong></div>
      ${receipt.discount ? `<div><span>Descuento</span><strong>-${esc(money(receipt.discount, receipt.currency))}</strong></div>` : ''}
      ${receipt.delivery_fee ? `<div><span>Delivery</span><strong>${esc(money(receipt.delivery_fee, receipt.currency))}</strong></div>` : ''}
      ${
        receipt.shipping
          ? `<div><span>Envío</span><strong>${esc(money(receipt.shipping, receipt.currency))}</strong></div>`
          : ''
      }
      <div class="grand"><span>TOTAL</span><span>${esc(money(receipt.total, receipt.currency))}</span></div>
    </div>
    ${
      receipt.has_location
        ? `<p class="footer">Ubicación de entrega registrada${receipt.location_label ? `: ${esc(receipt.location_label)}` : ''}. No se imprimen las coordenadas.</p>`
        : ''
    }
    <p class="footer">${esc(receipt.thanks)}</p>
    <p class="footer">${esc(receipt.note)}</p>
  </main>
  <script>
    document.getElementById('share').addEventListener('click', async () => {
      const url = new URL(${JSON.stringify(pdfUrl)}, location.href).href;
      if (navigator.share) {
        try {
          await navigator.share({ title: document.title, url });
          return;
        } catch {}
      }
      location.href = url;
    });
  </script>
</body>
</html>`;
}

export { CatalogError };
