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
 *   «Comprobante de compra» (NUNCA «factura fiscal»: no hay integración fiscal).
 *   Dos vistas: los datos para pintarlo en el CRM y un HTML ligero e imprimible.
 *   El teléfono se muestra ENMASCARADO. Sin afirmaciones médicas.
 */

import { randomBytes } from 'node:crypto';

import { CATALOG_CURRENCY, CatalogError, computeOrderTotals, findCatalogItem } from '../src/lib/catalog.js';

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

/** ¿Es un estado de pedido válido? */
export function isOrderStatus(value) {
  return ORDER_STATUSES.includes(String(value ?? '').trim());
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
 * @param {string} [input.date]            fecha ISO del pedido
 * @param {string} [input.recordedBy]
 * @param {any}    [input.product]         catálogo alternativo (tests)
 */
export function buildOrder(input = {}) {
  const totals = computeOrderTotals(input.items, { discount: input.discount, product: input.product });
  const id = short(input.id, 80) ?? newId();
  const createdAt = short(input.date, 40) ?? new Date().toISOString();
  const status = isOrderStatus(input.status) ? String(input.status) : 'nuevo';
  const number = orderNumber(id);
  const first = totals.items[0];
  const delivery = {
    // El costo de envío NO se inventa: queda pendiente hasta que el negocio lo sepa.
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
    total: totals.total,
    currency: totals.currency,
    shipping: null,
    notes: long(input.notes, 2000),
    delivery,
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
    total,
    currency: item.currency ?? CATALOG_CURRENCY,
    shipping: null,
    notes: item.notes ?? null,
    delivery: { address: null, city: item.location ?? null, note: null, method: null, shipping: null },
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
    document: 'Comprobante de compra',
    order_number: order.order_number,
    date: order.created_at,
    customer_name: customer?.name ?? null,
    // Enmascarado SIEMPRE: el comprobante se comparte con el cliente.
    phone_masked: maskPhone(customer?.phone_e164 ?? customer?.phone ?? null),
    items,
    subtotal: Number(order.subtotal) || 0,
    discount: Number(order.discount) || 0,
    shipping: order.shipping ?? order.delivery?.shipping ?? null,
    total: Number(order.total) || 0,
    currency: order.currency ?? CATALOG_CURRENCY,
    status: order.status ?? 'nuevo',
    status_label: ORDER_STATUS_LABELS[order.status ?? 'nuevo'] ?? order.status,
    // Agradecimiento neutro: sin promesas, sin plazos y sin nada médico.
    thanks: 'Gracias por tu compra. Si tienes cualquier duda, escríbenos por WhatsApp.',
    note: 'Este documento es un comprobante de compra, no una factura fiscal.',
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

/**
 * HTML ligero e imprimible del comprobante. Es el documento que se comparte o se
 * imprime (y, desde el navegador, se puede guardar como PDF si el negocio quiere).
 * No lleva dependencias ni imágenes: se abre en cualquier móvil, aunque no haya red.
 *
 * @param {ReturnType<typeof buildReceipt>} receipt
 * @param {{ timeZone?: string }} [options]
 */
export function receiptHtml(receipt, options = {}) {
  if (!receipt) return '<!doctype html><title>Comprobante</title><p>Sin datos.</p>';
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
  @media print { body { background: #fff; padding: 0; } .sheet { box-shadow: none; border-radius: 0; max-width: none; } }
</style>
</head>
<body>
  <main class="sheet">
    <h1 class="brand">${esc(receipt.business)}</h1>
    <p class="doc">${esc(receipt.document)}</p>
    <dl>
      <dt>Pedido</dt><dd>${esc(receipt.order_number)}</dd>
      <dt>Fecha</dt><dd>${esc(prettyDate(receipt.date, options.timeZone))}</dd>
      ${receipt.customer_name ? `<dt>Cliente</dt><dd>${esc(receipt.customer_name)}</dd>` : ''}
      ${receipt.phone_masked ? `<dt>Teléfono</dt><dd>${esc(receipt.phone_masked)}</dd>` : ''}
      <dt>Estado</dt><dd>${esc(receipt.status_label)}</dd>
    </dl>
    <table>
      <thead><tr><th>Detalle</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Importe</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals">
      <div><span>Subtotal</span><strong>${esc(money(receipt.subtotal, receipt.currency))}</strong></div>
      ${receipt.discount ? `<div><span>Descuento</span><strong>-${esc(money(receipt.discount, receipt.currency))}</strong></div>` : ''}
      ${
        receipt.shipping
          ? `<div><span>Envío</span><strong>${esc(money(receipt.shipping, receipt.currency))}</strong></div>`
          : ''
      }
      <div class="grand"><span>TOTAL</span><span>${esc(money(receipt.total, receipt.currency))}</span></div>
    </div>
    <p class="footer">${esc(receipt.thanks)}</p>
    <p class="footer">${esc(receipt.note)}</p>
  </main>
</body>
</html>`;
}

export { CatalogError };
