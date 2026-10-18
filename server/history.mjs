/**
 * HISTORIAL 360° DEL CLIENTE — una sola línea de tiempo, sin duplicar datos.
 *
 * POR QUÉ ASÍ
 * Los mensajes ya están en `wa_messages`, las cotizaciones y facturas en
 * `pos_documents`, los pedidos en `items`, los seguimientos en `followups` y las
 * entregas en `delivery_tracking_sessions`. Copiar todo eso a una tabla nueva
 * sería tener dos verdades que se desincronizan.
 *
 * Aquí se LEE de cada módulo y se devuelve una lista de eventos ordenada. Cada
 * evento apunta a su registro original (`ref`), que es lo que abre la pantalla.
 *
 * Lo que NO se hace:
 *   · inventar eventos que no ocurrieron,
 *   · mostrar notas internas a quien no tiene permiso,
 *   · alterar nada: esta función es de solo lectura.
 */

const MAX_EVENTS = 400;

const text = (value, max = 220) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** Un evento con la misma forma para todas las fuentes. */
function event({ id, at, type, title, detail = '', status = null, actor = null, ref = null, internal = false, links = [] }) {
  return {
    id,
    at: at || null,
    type,
    title,
    detail,
    status,
    actor: actor ?? null,
    ref,
    internal,
    links,
  };
}

/**
 * Construye el historial del cliente.
 *
 * @param {object} options
 * @param {object} options.db        almacén de documentos del CRM
 * @param {string} options.customerId
 * @param {boolean} [options.includeInternal] notas internas (solo con permiso)
 * @param {number} [options.limit]
 */
export async function buildCustomerHistory({ db, customerId, orders = [], includeInternal = false, limit = MAX_EVENTS }) {
  if (!customerId) return [];
  const events = [];
  /** Una fuente que falla no puede tumbar la ficha entera. */
  const safeList = async (name, options) => {
    try {
      return await db.list(name, options);
    } catch {
      return [];
    }
  };

  // ------------------------------------------------------------- mensajes
  const messages = (await safeList('wa_messages', { limit: 5000 })).filter((row) => row.customer_id === customerId);
  for (const message of messages) {
    const inbound = message.direction === 'inbound';
    events.push(
      event({
        id: `wa:${message.id}`,
        at: message.created_at,
        type: inbound ? 'message_in' : 'message_out',
        title: inbound ? 'Mensaje recibido' : 'Mensaje enviado',
        detail: text(message.body ?? message.text ?? (message.media_type ? `[${message.media_type}]` : ''), 160),
        status: message.status ?? null,
        actor: inbound ? null : message.sent_by_user_id ?? null,
        ref: { kind: 'conversation', id: message.conversation_id ?? null, messageId: message.id },
      }),
    );
  }

  // ------------------------------------------- cotizaciones y facturas (POS)
  const documents = (await safeList('pos_documents', { limit: 5000 })).filter((row) => row.customer_id === customerId);
  for (const document of documents) {
    const kind = document.kind === 'invoice' ? 'Factura emitida' : 'Cotización';
    events.push(
      event({
        id: `pos:${document.id}`,
        at: document.created_at ?? document.issued_at,
        type: document.kind === 'invoice' ? 'invoice' : 'quote',
        title: `${kind}${document.number ? ` ${document.number}` : ''}`,
        detail: document.total_cents != null ? `Total RD$${(Number(document.total_cents) / 100).toFixed(2)}` : '',
        status: document.status ?? null,
        actor: document.created_by ?? null,
        ref: { kind: 'document', id: document.id, documentKind: document.kind ?? null },
      }),
    );
  }

  // --------------------------------------------------------------- pedidos
  /*
   * Los pedidos NO viven en el almacén de documentos: los pasa la ficha, que ya
   * los tiene cargados (`profile.purchases`). Así se leen de su única fuente.
   */
  for (const order of orders.filter((row) => !row.customer_id || row.customer_id === customerId)) {
    const items = Array.isArray(order.items) ? order.items : [];
    const resumen = items
      .slice(0, 4)
      .map((line) => `${line.name ?? line.variantName ?? 'Artículo'} ×${line.quantity ?? 1}`)
      .join(' · ');
    events.push(
      event({
        id: `order:${order.id}`,
        at: order.updated_at ?? order.created_at ?? order.delivered_at,
        type: 'order',
        title: `Pedido${order.number ? ` ${order.number}` : ''} · ${order.status ?? ''}`.trim(),
        detail: resumen,
        status: order.status ?? null,
        actor: order.updated_by ?? order.created_by ?? null,
        ref: { kind: 'order', id: order.id },
        links: [
          ...(order.assigned_to_delivery || order.delivery?.delivery_user_id
            ? [{ kind: 'delivery', label: 'Entrega' }]
            : []),
        ],
      }),
    );
  }

  // ----------------------------------------------------------- seguimientos
  const followups = (await safeList('followups', { limit: 5000 })).filter((row) => row.customer_id === customerId);
  for (const followup of followups) {
    events.push(
      event({
        id: `followup:${followup.id}`,
        at: followup.completed_at ?? followup.scheduled_at ?? followup.created_at,
        type: 'followup',
        title: followup.status === 'completed' ? 'Seguimiento completado' : 'Seguimiento programado',
        detail: text(followup.title ?? followup.reason ?? followup.note ?? followup.kind ?? ''),
        status: followup.status ?? null,
        actor: followup.done_by ?? null,
        ref: { kind: 'followup', id: followup.id },
        internal: true,
      }),
    );
  }

  // -------------------------------------------------------------- entregas
  const sessions = (await safeList('delivery_tracking_sessions', { limit: 5000 })).filter(
    (row) => row.customer_id === customerId,
  );
  for (const session of sessions) {
    events.push(
      event({
        id: `delivery:${session.id}`,
        at: session.ended_at ?? session.started_at ?? session.created_at,
        type: 'delivery',
        title: `Entrega ${session.status === 'ended' ? 'finalizada' : 'en curso'}`,
        detail: session.delivery_display_name ?? session.delivery_user_id ?? '',
        status: session.status ?? null,
        actor: session.delivery_user_id ?? null,
        ref: { kind: 'delivery', id: session.id, orderId: session.order_id ?? null },
      }),
    );
  }

  // ---------------------------------------------------------- recogidas
  const pickups = (await safeList('order_pickups', { limit: 5000 })).filter((row) => row.customer_id === customerId);
  for (const pickup of pickups) {
    events.push(
      event({
        id: `pickup:${pickup.id}`,
        at: pickup.updated_at ?? pickup.created_at,
        type: 'pickup',
        title: `Recogida en ${pickup.supplier_name ?? 'tienda'}`,
        detail: `${pickup.quantity ?? 0} artículo(s)`,
        status: pickup.status ?? null,
        actor: pickup.assigned_to ?? null,
        ref: { kind: 'pickup', id: pickup.id, orderId: pickup.order_id ?? null },
        internal: true,
      }),
    );
  }

  // ------------------------------------------------- facturas de proveedor
  const supplierInvoices = (await safeList('supplier_invoices', { limit: 5000 })).filter(
    (row) => row.customer_id === customerId,
  );
  for (const invoice of supplierInvoices) {
    events.push(
      event({
        id: `supplier-invoice:${invoice.id}`,
        at: invoice.purchased_at ?? invoice.created_at,
        type: 'supplier_invoice',
        title: `Factura de proveedor${invoice.invoice_number ? ` ${invoice.invoice_number}` : ''}`,
        detail: text(invoice.supplier_name ?? ''),
        status: invoice.attached ? 'attached' : 'pending',
        actor: invoice.uploaded_by ?? null,
        ref: { kind: 'supplier_invoice', id: invoice.id, orderId: invoice.order_id ?? null },
        internal: true,
      }),
    );
  }

  // ------------------------------------------------------------- garantías
  const claims = (await safeList('warranty_claims', { limit: 5000 })).filter((row) => row.customer_id === customerId);
  for (const claim of claims) {
    events.push(
      event({
        id: `warranty:${claim.id}`,
        at: claim.updated_at ?? claim.created_at,
        type: 'warranty',
        title: `Garantía · ${claim.status ?? 'abierta'}`,
        detail: text(claim.product_name ?? claim.description ?? ''),
        status: claim.status ?? null,
        actor: claim.handled_by ?? null,
        ref: { kind: 'warranty', id: claim.id, orderId: claim.order_id ?? null },
        internal: true,
      }),
    );
  }

  return events
    .filter((row) => includeInternal || !row.internal)
    .filter((row) => row.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, Math.max(1, Math.min(Number(limit) || MAX_EVENTS, 1000)));
}
