/**
 * PEDIDO AL REPARTIDOR EXTERNO — envío por WhatsApp y respuestas.
 *
 * QUÉ RESUELVE
 * El CRM ya sabe mandar el pedido a un *delivery* interno (usuario del sistema).
 * Cuando quien reparte es un contacto EXTERNO (un mensajero con su teléfono, sin
 * cuenta en el CRM), el pedido se quedaba en «avísale por WhatsApp» a mano. Aquí
 * se hace por la API oficial, con plantilla UTILITY aprobada, y sus respuestas
 * mueven el pedido con una máquina de estados que vive EN EL SERVIDOR.
 *
 * BLINDAJE (lo que este archivo NO permite)
 * -----------------------------------------
 *  1. Solo se escribe a un contacto GUARDADO en `delivery_contacts`. Un número
 *     que no está en esa lista no recibe nada, aunque alguien lo pida.
 *  2. El contacto puede tener el envío de pedidos desactivado (`shareOrders`).
 *  3. Nunca se manda al teléfono del propio cliente (sería un error de rol).
 *  4. Se envía el MÍNIMO dato necesario: número de pedido, cliente y teléfono,
 *     productos, importe a cobrar, dirección y enlace del mapa. Nada de notas
 *     internas del cliente, historial ni datos de salud.
 *  5. No se envía si la plantilla no está aprobada por Meta (`template_not_approved`).
 *  6. No se duplica: si ya se envió y hay `wa_message_id`, un segundo envío se
 *     rechaza salvo que se pida expresamente (`resend`), y queda auditado.
 *  7. Las respuestas solo se aceptan DEL TELÉFONO de un contacto guardado y solo
 *     afectan a pedidos suyos, abiertos y con ese contacto asignado. Si hay más
 *     de uno, no se toca ninguno: se pide el número de pedido.
 *  8. «Entregado» NO cierra el pedido: pide una CONFIRMACIÓN explícita. Solo el
 *     paso de confirmación ejecuta la transición oficial (inventario, venta,
 *     postventa), la misma que usa el panel.
 *  9. Todo lo que pasa queda en la auditoría con clave de idempotencia.
 *
 * La interpretación del texto es determinista (sin IA). Si el texto no encaja en
 * ninguna acción clara, no se ejecuta nada: se responde con las opciones.
 */

import { toE164 } from './whatsapp.mjs';
import { orderDestination } from './delivery-tracking.mjs';
import { DELIVERY_STATES, DEFAULT_OFFER_TTL_MS, nextOfferExpiry } from './delivery-lifecycle.mjs';

const OFFER_TTL_MS = Math.max(
  60_000,
  (Number(process.env.PHYTO_DELIVERY_OFFER_TTL_MINUTES ?? 15) || 15) * 60_000 ||
    DEFAULT_OFFER_TTL_MS,
);

/** Plantilla con la que se manda el pedido (debe estar aprobada por Meta). */
export const COURIER_TEMPLATE = 'phyto_pedido_repartidor_v1';

/** Estados del envío al repartidor (van dentro del pedido). */
export const COURIER_STATUS = Object.freeze({
  ASSIGNED: 'assigned',
  SENT: 'sent',
  FAILED: 'failed',
  IN_PROGRESS: 'in_progress',
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
  DELIVERED: 'delivered',
  ISSUE: 'issue',
});

const CLOSED_STATUSES = Object.freeze(['entregado', 'cancelado', 'perdido']);
const MAX_TEXT = 300;

const clean = (value, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null;

/** Texto comparable: sin acentos, sin mayúsculas. (`\b` de JS es ASCII.) */
const fold = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Un contacto de reparto guardado, ya limpio.
 * `shareOrders` ausente = permitido (los contactos que ya existían no se rompen);
 * `shareOrders: false` bloquea el envío.
 */
export function normalizeCourierContact(input) {
  const phone = toE164(input?.phone);
  if (!phone) return null;
  const name = clean(input?.name, 80) ?? 'Repartidor';
  return {
    id: clean(input?.id, 80) ?? phone,
    name,
    phone,
    concept: clean(input?.concept, 80),
    shareOrders: input?.shareOrders !== false && input?.share_orders !== false,
  };
}

/** Lista de contactos guardados, válidos y sin repetir teléfono. */
export function savedCourierContacts(settingsValue) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(settingsValue) ? settingsValue : []) {
    const contact = normalizeCourierContact(row);
    if (!contact || seen.has(contact.phone)) continue;
    seen.add(contact.phone);
    out.push(contact);
  }
  return out;
}

/** Lo que el pedido guarda del repartidor externo. */
export function courierOf(order) {
  return order?.delivery?.external ?? null;
}

/** Enlace de Google Maps (solo si hay coordenadas reales). */
export function courierMapsLink(destination) {
  if (!destination) return null;
  const lat = Number(destination.latitude);
  const lng = Number(destination.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/** Resumen de productos: «2 × Frasco 30 caps; 1 × ...». */
function productsSummary(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const parts = items
    .map((line) => `${Number(line.quantity ?? 0)} × ${clean(line.name ?? line.label ?? line.variantId, 60) ?? 'Artículo'}`)
    .filter(Boolean);
  const text = parts.join('; ');
  return text ? text.slice(0, MAX_TEXT) : 'Sin detalle de productos';
}

/**
 * Variables de la plantilla, EN ORDEN y con el mínimo dato necesario.
 * Devuelve también `text`, que es lo que se guarda como cuerpo del mensaje en el
 * CRM (así el hilo del repartidor se puede leer aunque Meta no devuelva el texto).
 */
export function buildCourierPayload({ order, customer, contact, destination }) {
  const link = courierMapsLink(destination);
  const address = [destination?.address, destination?.name].filter(Boolean).join(' · ') || 'Sin dirección registrada';
  const total = Number(order?.total ?? 0);
  const currency = order?.currency ?? 'DOP';
  const cobrar = Number.isFinite(total) && total > 0 ? `${currency} ${total.toFixed(2)}` : 'No aplica';
  const instrucciones = clean(order?.notes ?? order?.delivery?.delivery_assignment_note, MAX_TEXT) ?? 'Sin instrucciones adicionales';

  const variables = [
    contact.name, // 1 repartidor
    clean(order?.order_number ?? order?.id, 40) ?? '—', // 2 pedido
    [clean(customer?.name, 60), customer?.phone_e164].filter(Boolean).join(' · ') || 'Cliente', // 3 cliente y teléfono
    productsSummary(order), // 4 productos
    cobrar, // 5 importe
    address.slice(0, MAX_TEXT), // 6 dirección
    link ?? 'Sin coordenadas (usar la dirección)', // 7 mapa
    instrucciones, // 8 instrucciones
  ].map((value) => String(value).slice(0, MAX_TEXT));

  return {
    variables,
    text: [
      `Pedido ${variables[1]} para ${contact.name}`,
      `Cliente: ${variables[2]}`,
      `Productos: ${variables[3]}`,
      `Cobrar: ${variables[4]}`,
      `Dirección: ${variables[5]}`,
      link ? `Mapa: ${link}` : null,
      `Instrucciones: ${variables[7]}`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/**
 * Asigna (o cambia) el repartidor EXTERNO del pedido.
 *
 * Solo acepta un contacto GUARDADO: el panel manda el teléfono elegido de la
 * lista y aquí se comprueba que sigue existiendo y que puede recibir pedidos.
 * Cambiar de repartidor devuelve el estado a «asignado» (hay que reenviar).
 */
export async function assignCourier(input) {
  const { ctx, item, order, contactPhone, actor = null } = input;
  if (!item?.id || !order) return { ok: false, status: 422, error: 'invalid_order', message: 'Pedido no válido.' };
  if (CLOSED_STATUSES.includes(String(order.status ?? item.status ?? ''))) {
    return { ok: false, status: 409, error: 'order_closed', message: 'Este pedido ya está cerrado.' };
  }

  const phone = toE164(contactPhone);
  if (!phone) return { ok: false, status: 422, error: 'invalid_phone', message: 'Escribe un teléfono válido.' };

  const saved = savedCourierContacts((await ctx.settings.read('delivery_contacts'))?.value);
  const contact = saved.find((row) => row.phone === phone) ?? null;
  if (!contact) {
    return {
      ok: false,
      status: 403,
      error: 'contact_not_saved',
      message: 'Ese número no está guardado como contacto de reparto.',
    };
  }
  if (!contact.shareOrders) {
    return { ok: false, status: 403, error: 'contact_sharing_disabled', message: 'Ese contacto no recibe pedidos.' };
  }

  const customer = order.customer_id ? await ctx.customers.get(order.customer_id) : null;
  if (customer?.phone_e164 && customer.phone_e164 === contact.phone) {
    return { ok: false, status: 422, error: 'contact_is_customer', message: 'Ese teléfono es del cliente.' };
  }

  const at = ctx.clock().toISOString();
  const previous = order.delivery?.external ?? {};
  const sameCourier = previous.phone_e164 === contact.phone;
  const nextOrder = {
    ...order,
    delivery: {
      ...(order.delivery ?? {}),
      /*
       * UN PEDIDO TIENE UN SOLO REPARTIDOR VIGENTE.
       * Al pasar a un mensajero externo, el repartidor interno anterior deja de
       * ser el asignado: si se quedara, seguiría viendo el pedido en la app.
       */
      delivery_user_id: null,
      delivery_user_name_snapshot: null,
      delivery_previous_user_id:
        order.delivery?.delivery_user_id ?? order.delivery?.delivery_previous_user_id ?? null,
      delivery_assigned_at: at,
      /* Reasignar a un mensajero externo invalida el código de entrega anterior. */
      proof: null,
      /* Fase 05: el pedido externo también nace como OFERTA con vencimiento. */
      lifecycle: DELIVERY_STATES.OFFERED,
      offer_expires_at: nextOfferExpiry(Date.now(), OFFER_TTL_MS),
      external: {
        ...previous,
        contact_id: contact.id,
        contact_name: contact.name,
        phone_e164: contact.phone,
        // Si es el mismo y ya se envió, se conserva el estado; si cambia, vuelve a «asignado».
        status: sameCourier ? previous.status ?? COURIER_STATUS.ASSIGNED : COURIER_STATUS.ASSIGNED,
        attempts: sameCourier ? previous.attempts ?? 0 : 0,
        assigned_at: at,
        assigned_by_user_id: actor?.id ?? null,
        assigned_by_display_name: actor?.display_name ?? null,
        superseded_at: null,
        superseded_by: null,
      },
    },
    updated_at: at,
  };
  const persisted = await ctx.store.update(item.id, { orderJson: JSON.stringify(nextOrder) });
  await ctx.audit?.record({
    entity: 'order',
    entityId: item.id,
    action: 'order.courier_assigned',
    actor: actor?.display_name ?? null,
    summary: `Repartidor externo: ${contact.name}`,
    data: { phone_e164: contact.phone, previous_phone_e164: previous.phone_e164 ?? null },
    idempotencyKey: `order.courier-assign:${item.id}:${contact.phone}`,
  });
  return { ok: true, status: 200, order: nextOrder, item: persisted ?? null, courier: nextOrder.delivery.external };
}

/**
 * Envía el pedido al repartidor externo asignado.
 *
 * @param {object} input
 * @param {any} input.ctx Contexto del CRM (settings, store, audit, whatsapp, clock).
 * @param {any} input.item Fila del pedido en el almacén (con `id`).
 * @param {any} input.order Pedido ya parseado.
 * @param {any} [input.actor] Quién lo envía.
 * @param {boolean} [input.resend] Permite reenviar aunque ya conste enviado.
 * @param {(name: string) => Promise<{ok: boolean, template?: any, reason?: string}>} input.checkTemplate
 * @param {(name: string) => Promise<any>} [input.refreshTemplate]
 * @param {any} [input.customer] Cliente del pedido (opcional; se busca si falta).
 */
export async function sendOrderToCourier(input) {
  const { ctx, item, order, actor = null, resend = false, checkTemplate, refreshTemplate } = input;
  if (!item?.id || !order) return { ok: false, status: 422, error: 'invalid_order', message: 'Pedido no válido.' };

  const status = String(order.status ?? item.status ?? 'nuevo');
  if (CLOSED_STATUSES.includes(status)) {
    return { ok: false, status: 409, error: 'order_closed', message: 'Este pedido ya está cerrado.' };
  }

  const external = courierOf(order);
  const phone = external?.phone_e164 ?? null;
  if (!phone) {
    return {
      ok: false,
      status: 409,
      error: 'courier_not_assigned',
      message: 'Este pedido no tiene un repartidor externo asignado.',
    };
  }

  // 1) El destinatario TIENE que ser un contacto guardado.
  const saved = savedCourierContacts((await ctx.settings.read('delivery_contacts'))?.value);
  const contact = saved.find((row) => row.phone === phone) ?? null;
  if (!contact) {
    return {
      ok: false,
      status: 403,
      error: 'contact_not_saved',
      message: 'Ese número no está guardado como contacto de reparto. Guárdalo antes de enviarle pedidos.',
    };
  }
  // 2) Permiso del contacto.
  if (!contact.shareOrders) {
    return {
      ok: false,
      status: 403,
      error: 'contact_sharing_disabled',
      message: 'Ese contacto tiene desactivado el envío de pedidos.',
    };
  }

  const customer = input.customer ?? (order.customer_id ? await ctx.customers.get(order.customer_id) : null);
  // 3) Nunca al teléfono del propio cliente.
  if (customer?.phone_e164 && customer.phone_e164 === contact.phone) {
    return {
      ok: false,
      status: 422,
      error: 'contact_is_customer',
      message: 'Ese teléfono es del cliente, no de un repartidor.',
    };
  }
  // 4) Sin dirección no hay entrega que mandar.
  const destination = orderDestination(order);
  if (!destination) {
    return {
      ok: false,
      status: 422,
      error: 'missing_destination',
      message: 'El pedido no tiene ubicación de entrega: no se puede enviar al repartidor.',
    };
  }

  // 5) Sin duplicados.
  if (external.status === COURIER_STATUS.SENT && external.wa_message_id && !resend) {
    return {
      ok: false,
      status: 409,
      error: 'already_sent',
      message: 'Este pedido ya se envió a ese repartidor.',
      courier: external,
    };
  }

  // 6) Meta: plantilla aprobada.
  if (refreshTemplate) await refreshTemplate(COURIER_TEMPLATE).catch(() => null);
  const check = await checkTemplate(COURIER_TEMPLATE);
  if (!check.ok) {
    return {
      ok: false,
      status: 409,
      error: check.reason === 'template_not_approved' ? 'template_not_approved' : 'template_unavailable',
      message:
        'La plantilla «' +
        COURIER_TEMPLATE +
        '» no está aprobada en Meta. Créala y espera la aprobación antes de enviar pedidos.',
      template: check.template ?? null,
    };
  }
  if (!ctx.whatsapp?.enabled) {
    return { ok: false, status: 503, error: 'whatsapp_disabled', message: 'WhatsApp no está configurado en este entorno.' };
  }

  const payload = buildCourierPayload({ order, customer, contact, destination });
  const attempts = Number(external.attempts ?? 0) + 1;
  const attemptAt = ctx.clock().toISOString();

  const sent = await ctx.whatsapp.sendTemplate(contact.phone, {
    name: check.template.name,
    language: check.template.language ?? 'es',
    components: [{ type: 'body', parameters: payload.variables.map((text) => ({ type: 'text', text })) }],
  });

  const base = {
    ...external,
    contact_id: contact.id,
    contact_name: contact.name,
    phone_e164: contact.phone,
    attempts,
    last_attempt_at: attemptAt,
    sent_by_user_id: actor?.id ?? external?.sent_by_user_id ?? null,
    sent_by_display_name: actor?.display_name ?? external?.sent_by_display_name ?? null,
  };

  if (!sent?.ok) {
    const reason = clean(sent?.error?.message ?? sent?.reason ?? 'send_failed', 200);
    const failedOrder = {
      ...order,
      delivery: { ...(order.delivery ?? {}), external: { ...base, status: COURIER_STATUS.FAILED, last_error: reason } },
      updated_at: attemptAt,
    };
    await ctx.store.update(item.id, { orderJson: JSON.stringify(failedOrder) });
    await ctx.audit?.record({
      entity: 'order',
      entityId: item.id,
      action: 'order.courier_send_failed',
      actor: actor?.display_name ?? null,
      summary: `No se pudo enviar el pedido al repartidor: ${reason}`,
      data: { phone_e164: contact.phone, attempts, error: reason },
      idempotencyKey: `order.courier:${item.id}:${attempts}:failed`,
    });
    return { ok: false, status: 502, error: 'send_failed', message: `WhatsApp rechazó el envío: ${reason}` };
  }

  const sentOrder = {
    ...order,
    delivery: {
      ...(order.delivery ?? {}),
      external: {
        ...base,
        status: COURIER_STATUS.SENT,
        sent_at: attemptAt,
        wa_message_id: sent.messageId ?? null,
        last_error: null,
      },
    },
    updated_at: attemptAt,
  };
  const persisted = await ctx.store.update(item.id, { orderJson: JSON.stringify(sentOrder) });

  /*
   * El mensaje queda REGISTRADO en el hilo del repartidor con su estado real.
   * Es best-effort: si el contacto no tiene ficha de cliente o el registro
   * fallara, el envío ya hecho no se convierte en un error para quien lo mandó.
   */
  try {
    const courierCustomer = order.delivery?.external?.contact_id ? await ctx.customers.get(order.delivery.external.contact_id) : null;
    const conversation = courierCustomer ? await ctx.customers.conversationFor(courierCustomer.id) : null;
    if (courierCustomer && conversation) {
      await ctx.customers.recordOutbound({
        customer: courierCustomer,
        conversation,
        body: payload.text,
        template: check.template.name,
        waMessageId: sent.messageId ?? null,
        status: 'sent',
        sentBy: actor?.display_name ?? null,
        sentByUserId: actor?.id ?? null,
        sentByDisplayName: actor?.display_name ?? null,
        idempotencyKey: `courier-order:${item.id}:${attempts}`,
      });
    }
  } catch (error) {
    console.error('[crm] no se pudo registrar el mensaje al repartidor:', error?.message ?? error);
  }

  await ctx.audit?.record({
    entity: 'order',
    entityId: item.id,
    action: 'order.courier_sent',
    actor: actor?.display_name ?? null,
    summary: `Pedido enviado al repartidor ${contact.name}`,
    data: {
      phone_e164: contact.phone,
      wa_message_id: sent.messageId ?? null,
      attempts,
      resend: Boolean(resend),
      template: check.template.name,
    },
    idempotencyKey: `order.courier:${item.id}:${attempts}:sent`,
  });

  return {
    ok: true,
    status: 200,
    courier: sentOrder.delivery.external,
    item: persisted ?? null,
    order: sentOrder,
    messageId: sent.messageId ?? null,
  };
}

/**
 * Qué quiso decir el repartidor. Devuelve una acción o `null`.
 * Se comprueban las NEGACIONES primero: «no entregado» no es «entregado».
 */
export function parseCourierIntent(inbound) {
  /*
   * El botón se reconoce por payload o por su TEXTO: una respuesta rápida de
   * plantilla puede llegar sin payload y entonces «Entregado» tiene que seguir
   * significando entregado (si no, el repartidor pulsa y no pasa nada).
   */
  const buttonId = fold(inbound?.button?.payload ?? inbound?.interactive?.button_reply?.id ?? '');
  const buttonText = fold(inbound?.button?.text ?? inbound?.interactive?.button_reply?.title ?? '');
  const button = `${buttonId} ${buttonText}`.trim();
  if (button) {
    if (button.includes('iniciar')) return 'start';
    if (button.includes('confirmar')) return 'confirm';
    if (button.includes('entregado')) return 'delivered';
    if (button.includes('problema') || button.includes('incidencia')) return 'issue';
  }
  const text = fold(inbound?.text?.body ?? inbound?.body ?? '');
  if (!text) return null;
  const words = ` ${text} `;
  const negated = /(no|aun no|todavia no|sin)\s+(lo\s+)?(entreg|pude|puedo|llego)/.test(words);
  if (/(confirmo|confirmar|confirmado|^ si |^ claro |^ de acuerdo )/.test(words) && !negated) return 'confirm';
  if (/\b(problema|incidencia|no pude|no puedo|direccion|rechazo|rechazo el pedido|no estaba)\b/.test(words)) return 'issue';
  if (/\b(entregado|entregue|entregue el pedido|listo|cobrado)\b/.test(words) && !negated) return 'delivered';
  if (/\b(iniciar|inicio|salgo|voy|en camino|arranco|empezando)\b/.test(words)) return 'start';
  if (text === '1') return 'start';
  if (text === '2') return 'delivered';
  if (text === '3') return 'issue';
  return null;
}

/**
 * Procesa una respuesta del repartidor. SIEMPRE devuelve un resultado; nunca
 * lanza (el webhook no puede caerse por esto).
 *
 * @param {object} input
 * @param {any} input.ctx
 * @param {any} input.inbound Mensaje normalizado del webhook.
 * @param {any} [input.actor] Actor del sistema para la auditoría.
 * @param {(orderId: string, input: any) => Promise<any>} input.completeDelivery
 *        Transición OFICIAL a entregado (la misma del panel).
 */
export async function handleCourierInbound(input) {
  const { ctx, inbound, completeDelivery } = input;
  const from = toE164(inbound?.fromE164 ?? inbound?.from ?? inbound?.waId);
  if (!from) return { handled: false, reason: 'no_phone' };

  const saved = savedCourierContacts((await ctx.settings.read('delivery_contacts'))?.value);
  const contact = saved.find((row) => row.phone === from) ?? null;
  // Un número desconocido NO mueve nada: sigue su curso normal como cliente.
  if (!contact) return { handled: false, reason: 'not_a_courier' };

  const action = parseCourierIntent(inbound);
  if (!action) return { handled: false, reason: 'no_intent' };

  const text = clean(inbound?.text?.body ?? '', 200) ?? '';

  const rows = await ctx.store.listAdmin({ limit: 5000 });
  const open = [];
  for (const row of rows) {
    if (row.type !== 'order_intent') continue;
    const order = parseOrder(row);
    if (!order) continue;
    if (courierOf(order)?.phone_e164 !== from) continue;
    if (CLOSED_STATUSES.includes(String(order.status ?? row.status ?? ''))) continue;
    open.push({ row, order });
  }

  if (!open.length) {
    // Es un repartidor guardado, pero no tiene pedidos abiertos: no se toca nada.
    return { handled: false, reason: 'no_open_order', reply: false };
  }

  // Varios pedidos abiertos: si el mensaje trae el número, se usa ese; si no,
  // NO se adivina. Se pide el número de pedido.
  let target = open[0];
  if (open.length > 1) {
    const numero = open.find(({ order }) => {
      const number = fold(order.order_number ?? order.id ?? '');
      return number && fold(text).includes(number);
    });
    if (!numero) {
      await reply(
        ctx,
        contact,
        `Tienes ${open.length} pedidos abiertos: ${open.map(({ order }) => order.order_number ?? order.id).join(', ')}.\nResponde con el número de pedido para saber de cuál hablamos.`,
        `courier-ambiguous:${inbound.waMessageId ?? from}`,
      );
      return { handled: true, reason: 'ambiguous', replied: true };
    }
    target = numero;
  }

  const { row, order } = target;
  const external = courierOf(order);
  const current = external?.status ?? COURIER_STATUS.ASSIGNED;
  const at = ctx.clock().toISOString();

  const save = async (patch, summary, actionName) => {
    const next = { ...order, delivery: { ...(order.delivery ?? {}), external: { ...external, ...patch } }, updated_at: at };
    await ctx.store.update(row.id, { orderJson: JSON.stringify(next) });
    await ctx.audit?.record({
      entity: 'order',
      entityId: row.id,
      action: `order.courier_${actionName}`,
      actor: `Repartidor ${contact.name}`,
      summary,
      data: { phone_e164: contact.phone, from_status: current, to_status: patch.status ?? current },
      idempotencyKey: `order.courier-in:${inbound.waMessageId ?? at}:${actionName}`,
    });
    return next;
  };

  if (action === 'start') {
    if ([COURIER_STATUS.SENT, COURIER_STATUS.ASSIGNED, COURIER_STATUS.FAILED].includes(current)) {
      await save({ status: COURIER_STATUS.IN_PROGRESS, started_at: at }, 'El repartidor inició la entrega', 'started');
    }
    await reply(ctx, contact, `Anotado: entrega de ${order.order_number ?? row.id} en curso. Cuando termine, responde «Entregado».`, `courier-start:${inbound.waMessageId ?? at}`);
    return { handled: true, reason: 'started', orderId: row.id };
  }

  if (action === 'issue') {
    await save(
      { status: COURIER_STATUS.ISSUE, issue_at: at, issue_note: text || null },
      'El repartidor reportó un problema',
      'issue_reported',
    );
    await reply(
      ctx,
      contact,
      `Anotado el problema con ${order.order_number ?? row.id}. El equipo lo revisa y se pone en contacto.`,
      `courier-issue:${inbound.waMessageId ?? at}`,
    );
    return { handled: true, reason: 'issue', orderId: row.id };
  }

  if (action === 'delivered') {
    // PRIMER PASO: no se cierra nada, se pide confirmación explícita.
    if (current === COURIER_STATUS.DELIVERED) {
      await reply(ctx, contact, 'Ese pedido ya figura entregado. Gracias.', `courier-already:${inbound.waMessageId ?? at}`);
      return { handled: true, reason: 'already_delivered', orderId: row.id };
    }
    await save(
      { status: COURIER_STATUS.AWAITING_CONFIRMATION, delivered_reported_at: at },
      'El repartidor marcó el pedido como entregado (pendiente de confirmar)',
      'delivered_reported',
    );
    await reply(
      ctx,
      contact,
      `¿Confirmas que el pedido ${order.order_number ?? row.id} se entregó? Responde «CONFIRMAR» para cerrarlo.`,
      `courier-confirm-ask:${inbound.waMessageId ?? at}`,
    );
    return { handled: true, reason: 'awaiting_confirmation', orderId: row.id };
  }

  if (action === 'confirm') {
    if (current !== COURIER_STATUS.AWAITING_CONFIRMATION) {
      await reply(
        ctx,
        contact,
        'Para cerrar un pedido primero responde «Entregado» y luego «CONFIRMAR».',
        `courier-confirm-invalid:${inbound.waMessageId ?? at}`,
      );
      return { handled: true, reason: 'confirm_without_report', orderId: row.id };
    }
    // SEGUNDO PASO: aquí sí se ejecuta la transición OFICIAL.
    const result = await completeDelivery(row.id, {
      reason: `Entregado por repartidor externo ${contact.name}`,
      source: 'EXTERNAL_COURIER',
    });
    if (!result?.ok) {
      await reply(
        ctx,
        contact,
        'No se pudo cerrar el pedido en el sistema. Avisa al equipo para que lo revise.',
        `courier-confirm-error:${inbound.waMessageId ?? at}`,
      );
      return { handled: true, reason: 'confirm_failed', orderId: row.id, error: result?.error ?? null };
    }
    await save({ status: COURIER_STATUS.DELIVERED, delivered_at: at }, 'Entrega confirmada por el repartidor', 'delivered_confirmed');
    await reply(ctx, contact, `Listo. Pedido ${order.order_number ?? row.id} cerrado como entregado. ¡Gracias!`, `courier-confirm-ok:${inbound.waMessageId ?? at}`);
    return { handled: true, reason: 'delivered', orderId: row.id };
  }

  return { handled: false, reason: 'unhandled' };
}

/** Respuesta al repartidor: texto libre SOLO dentro de la ventana de 24 h. */
async function reply(ctx, contact, body, idempotencyKey) {
  try {
    if (!ctx.whatsapp?.enabled) return null;
    const courierCustomer = await ctx.customers.get(contact.id).catch(() => null);
    const conversation = courierCustomer ? await ctx.customers.conversationFor(courierCustomer.id) : null;
    if (!conversation || !ctx.customers.canSendFreeText(conversation)) return null;
    return await ctx.whatsapp.sendText(contact.phone, body);
  } catch (error) {
    console.error('[crm] respuesta al repartidor:', error?.message ?? error);
    return null;
  }
}

/** Pedido parseado de una fila del almacén (tolera `orderJson` ausente). */
function parseOrder(row) {
  try {
    if (row.orderJson) return JSON.parse(row.orderJson);
  } catch {
    /* documento corrupto: se ignora ese pedido, no se rompe el webhook */
  }
  return null;
}
