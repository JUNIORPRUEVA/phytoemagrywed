/**
 * BUS DE EVENTOS DEL CRM (tiempo real).
 *
 * QUÉ RESUELVE
 * El panel ya tenía dos canales SSE sueltos (chat y mapa de reparto). Los pedidos
 * —lo que más cambia durante el día— solo se veían al recargar. Este módulo crea
 * UN canal único (`GET /api/admin/events`) por el que se publican los cambios
 * CONFIRMADOS: pedidos, entregas, recogidas, cobros, inventario, clientes y
 * supervisor.
 *
 * REGLAS QUE NO SE ROMPEN
 *   - Se publica DESPUÉS de persistir y solo si la respuesta fue 2xx. Un intento
 *     fallido no avisa a nadie (`eventFromMutation` recibe el estado real).
 *   - El evento NO lleva contenido privado: ni teléfonos, ni importes, ni el
 *     hilo de WhatsApp. Lleva QUÉ cambió y QUÉ hay que volver a pedir; el
 *     cliente pide los datos por la ruta normal, que ya aplica permisos.
 *   - Cada cliente recibe solo lo que su rol puede ver (`requires`) y, si el
 *     evento es de una entrega, solo quien la lleva (o administración).
 *   - Hay un búfer con número de secuencia para REANUDAR: si el teléfono se
 *     quedó sin red o iOS suspendió la PWA, al volver pide `?since=<seq>` y
 *     recibe lo perdido en vez de reproducir estados viejos.
 *
 * UNA SOLA INSTANCIA
 * El CRM corre en un único proceso Node (nginx y Node en el mismo contenedor),
 * así que los suscriptores viven en memoria. Si algún día hay varias réplicas,
 * este archivo es el único sitio que cambia: `publish` tendría que entregar los
 * eventos a las demás instancias (Postgres LISTEN/NOTIFY) antes de repartirlos.
 */

/** Versión del formato del evento. Si cambia el contrato, sube aquí. */
export const REALTIME_VERSION = 1;

/** Tipos que existen hoy. Lista cerrada: nada de strings libres. */
export const REALTIME_TYPES = Object.freeze([
  'order.created',
  'order.updated',
  'order.status_changed',
  'order.assigned',
  'order.deleted',
  'delivery.started',
  'delivery.completed',
  'delivery.postponed',
  'delivery.issue',
  'pickup.status_changed',
  'pickup.created',
  'payment.recorded',
  'payment.handover_recorded',
  'inventory.changed',
  'customer.updated',
  'supervisor.changed',
  'whatsapp.message_received',
  /*
   * CENTRO DE OPERACIONES (tickets internos).
   *
   * `message.*` y `task.*` son los nombres canónicos de la Etapa C: son los que
   * podrá consumir un agente futuro (recibir un mensaje, saber que se acusó o que
   * el trabajo se completó). `ticket.message`/`ticket.updated` se mantienen porque
   * la Etapa B los publicaba.
   */
  'ticket.created',
  'ticket.updated',
  'ticket.message',
  'ticket.status_changed',
  'ticket.assigned',
  'ticket.escalated',
  'ticket.resolved',
  'message.created',
  'message.read',
  'task.acknowledged',
  'task.completed',
  /*
   * EJECUCIÓN DE AGENTES (Etapa D). Los publica el motor de agentes; sirven
   * para que la ficha muestre en vivo qué está haciendo un agente y para que
   * un futuro agente sepa que otro terminó sin acoplarse a ningún modelo.
   */
  'agent.execution.started',
  'agent.execution.completed',
  'agent.execution.failed',
  /* COLABORACIÓN (Centro IA): una petición de ayuda cambia el estado del ticket. */
  'agent.delegation.changed',
]);

const ID = '[^/]+';

/** Un id de la ruta, decodificado y corto. */
function idFrom(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  try {
    return decodeURIComponent(text).slice(0, 120);
  } catch {
    return text.slice(0, 120);
  }
}

/** Body JSON ya parseado, solo si es objeto. */
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Traduce una petición HTTP ya respondida a los eventos que hay que publicar.
 *
 * Devuelve `[]` cuando no hay nada que anunciar (lecturas, rutas ajenas, errores).
 * Se apoya en la URL y en el cuerpo de la RESPUESTA (que es lo que se guardó de
 * verdad), no en lo que pidió el cliente.
 *
 * @param {{ method: string, route: string, status: number, body?: any }} input
 */
export function eventFromMutation({ method, route = '', status = 0, body = null }) {
  if (!(status >= 200 && status < 300)) return [];
  const verb = String(method ?? '').toUpperCase();
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(verb)) return [];
  const payload = asObject(body);
  const ok = payload.ok !== false;
  if (!ok) return [];

  const order = asObject(payload.order);
  const item = asObject(payload.item);
  const orderId = idFrom(order.id ?? item.id ?? payload.orderId);
  const orderStatus = order.status ?? item.status ?? payload.status ?? undefined;
  const delivery = asObject(order.delivery);
  /*
   * Quién se queda el pedido.
   *
   * La respuesta de «asignar» trae `deliveryUser` (la persona), pero no siempre
   * repite `order.delivery`: si solo se mirara el pedido, el evento salía sin
   * destinatario y el repartidor nunca se enteraba de su propia asignación.
   */
  const assignee = idFrom(
    delivery.delivery_user_id ??
      payload.deliveryUser?.id ??
      payload.delivery_user?.id ??
      payload.delivery_user_id ??
      payload.deliveryUserId,
  );
  const previousAssignee = idFrom(order.previous_delivery_user_id ?? payload.previous_delivery_user_id);
  const paymentBlock = asObject(payload.payment);

  /** @type {Array<any>} */
  const events = [];
  const push = (type, extra = {}) =>
    events.push({
      type,
      entity: { kind: 'order', id: orderId },
      requires: 'orders.read',
      audience: 'panel',
      data: {
        orderId,
        status: orderStatus === undefined ? null : orderStatus,
        delivery_user_id: assignee,
        ...extra,
      },
    });

  // ------------------------------------------------------------- pedidos
  if (verb === 'POST' && route === '/api/admin/orders' && orderId) {
    push('order.created', { previous_delivery_user_id: previousAssignee });
    return events;
  }
  if (route.endsWith('/status') && route.startsWith('/api/admin/orders/') && orderId) {
    push('order.status_changed');
    return events;
  }
  if (route.endsWith('/delivery/assign') && orderId) {
    events.push({
      type: 'order.assigned',
      entity: { kind: 'order', id: orderId },
      /*
       * SIN PERMISO DE PANEL A PROPÓSITO.
       * El rol DELIVERY no tiene `orders.read` (no puede listar pedidos) pero SÍ
       * tiene que enterarse de que le acaban de asignar uno. El filtro real es
       * la identidad: administración o el repartidor implicado, nadie más.
       */
      requires: null,
      audience: 'assignee',
      data: { orderId, delivery_user_id: assignee, previous_delivery_user_id: previousAssignee, status: orderStatus ?? null },
    });
    return events;
  }
  if (route.endsWith('/courier/assign') && orderId) {
    events.push({
      type: 'order.assigned',
      entity: { kind: 'order', id: orderId },
      requires: 'orders.read',
      audience: 'label',
      data: { orderId, courier: true, courier_name: String(payload.courier?.name ?? '').slice(0, 80) || null },
    });
    return events;
  }
  if (route.endsWith('/delivery/start') && orderId) {
    events.push({
      type: 'delivery.started',
      entity: { kind: 'order', id: orderId },
      requires: null,
      audience: 'assignee',
      data: { orderId, delivery_user_id: assignee ?? idFrom(payload.deliveryUserId ?? payload.delivery_user_id), status: orderStatus ?? null },
    });
    return events;
  }
  if (route.endsWith('/finish') && orderId) {
    push('delivery.completed', { payment_status: order.payment_status ?? null });
    return events;
  }
  if (route.endsWith('/delivery/postpone') && orderId) {
    push('delivery.postponed', { postponed_until: payload.postponedUntil ?? order.postponed_until ?? null });
    return events;
  }
  if (route.endsWith('/delivery/issue') && orderId) {
    push('delivery.issue');
    return events;
  }
  if (route.endsWith('/delivery/complete') && orderId) {
    push('delivery.completed');
    return events;
  }

  // -------------------------------------------- entregas (seguimiento GPS)
  if (/^\/api\/admin\/delivery-tracking\/[^/]+\/(stop|complete)$/.test(route)) {
    const session = asObject(payload.session);
    const sessionOrderId = idFrom(session.order_id ?? payload.order_id);
    if (!sessionOrderId) return [];
    events.push({
      type: route.endsWith('/complete') ? 'delivery.completed' : 'order.updated',
      entity: { kind: 'order', id: sessionOrderId },
      requires: null,
      audience: 'assignee',
      data: { orderId: sessionOrderId, delivery_user_id: idFrom(session.delivery_user_id), tracking_status: session.status ?? null },
    });
    return events;
  }

  // -------------------------------------------------------------- cobros
  if (/^\/api\/admin\/orders\/[^/]+\/payments$/.test(route) && orderId) {
    push('payment.recorded', { payment_status: paymentBlock.status ?? order.payment_status ?? null });
    return events;
  }
  if (/^\/api\/admin\/orders\/[^/]+\/payments\/handover$/.test(route) && orderId) {
    push('payment.handover_recorded');
    return events;
  }

  // ----------------------------------------------------------- recogidas
  if (route === '/api/admin/supplier-invoices' && payload.invoice) {
    const invoice = asObject(payload.invoice);
    events.push({
      type: 'pickup.status_changed',
      entity: { kind: 'pickup', id: idFrom(payload.invoice?.id) },
      requires: 'orders.read',
      audience: 'panel',
      data: { orderId: idFrom(invoice.order_id), supplier_id: idFrom(invoice.supplier_id), invoice_attached: true },
    });
    return events;
  }
  if (/^\/api\/admin\/pickups\/[^/]+$/.test(route)) {
    const pickup = asObject(payload.pickup);
    events.push({
      type: 'pickup.status_changed',
      entity: { kind: 'pickup', id: idFrom(pickup.id) },
      requires: 'orders.read',
      audience: 'panel',
      data: {
        orderId: idFrom(pickup.order_id),
        supplier_id: idFrom(pickup.supplier_id),
        pickup_status: pickup.status ?? null,
        assigned_to: pickup.assigned_to ?? null,
        paid: pickup.paid === true,
      },
    });
    return events;
  }
  if (/^\/api\/admin\/orders\/[^/]+\/pickups$/.test(route) && payload.pickups) {
    const first = Array.isArray(payload.pickups) ? payload.pickups[0] : null;
    events.push({
      type: 'pickup.created',
      entity: { kind: 'order', id: orderId ?? idFrom(first?.order_id) },
      requires: 'orders.read',
      audience: 'panel',
      data: { orderId: orderId ?? idFrom(first?.order_id), created: Number(payload.created ?? 0) || 0 },
    });
    return events;
  }

  // ---------------------------------------------------------- inventario
  if (route.startsWith('/api/admin/inventory/') && verb !== 'GET') {
    events.push({
      type: 'inventory.changed',
      entity: { kind: 'inventory', id: idFrom(payload.product?.id ?? payload.movement?.product_id) },
      requires: 'inventory.read',
      audience: 'panel',
      data: { product_id: idFrom(payload.product?.id ?? payload.movement?.product_id), reason: String(payload.reason ?? '').slice(0, 60) || null },
    });
    return events;
  }

  // ------------------------------------------------------------- clientes
  if (/^\/api\/admin\/customers\/[^/]+$/.test(route) && verb === 'PATCH') {
    const customer = asObject(payload.customer ?? payload.item);
    const customerId = idFrom(customer.id) ?? idFrom(route.split('/')[4]);
    events.push({
      type: 'customer.updated',
      entity: { kind: 'customer', id: customerId },
      requires: 'customers.read',
      audience: 'panel',
      data: { customerId },
    });
    return events;
  }

  // ----------------------------------------------------------- supervisor
  if (route === '/api/admin/delivery-supervisor/run' || route === '/api/admin/delivery-supervisor/settings' || route === '/api/admin/delivery-supervisor/daily') {
    events.push({
      type: 'supervisor.changed',
      entity: { kind: 'supervisor', id: 'delivery' },
      requires: 'delivery.tracking.manage_all',
      audience: 'panel',
      data: { reason: route.split('/').pop() ?? null },
    });
    return events;
  }

  return events;
}

/**
 * ¿Este cliente puede recibir este evento?
 *
 * `requires` es un permiso del CRM; `audience` acota más:
 *   - `panel`    → cualquiera con el permiso.
 *   - `assignee` → administración o el repartidor implicado (nunca el resto).
 *   - `label`    → igual que panel, pero el evento no habla de una persona.
 *   - `ticket`   → SOLO los participantes de ese ticket (o quien puede verlos
 *                  todos). Un ticket es una conversación interna: el resto del
 *                  panel no tiene por qué enterarse de que existe.
 *
 * Además, si el evento está acotado a una empresa (`companyScoped`), solo lo
 * recibe quien puede ver ESA empresa: la superadministración central o el panel
 * de PHYTOEMAGRY. Un evento de otra empresa —o de un registro cuya empresa no
 * se puede demostrar— no se reparte al panel ordinario.
 */
export function clientAccepts(event, { actor = null, can = () => false } = {}) {
  if (event.requires && !can(event.requires)) return false;
  if (event.audience === 'ticket') {
    const role = String(actor?.role ?? '');
    if (role === 'ADMIN' || can('tickets.read_all')) return true;
    const me = String(actor?.id ?? '');
    if (!me) return false;
    const ids = Array.isArray(event.data?.participant_ids) ? event.data.participant_ids : [];
    return ids.includes(me);
  }
  /*
   * Un evento dirigido a una persona concreta (`assignee`) ya está acotado por
   * identidad: quien lo recibe es el implicado. La empresa no añade nada ahí y
   * comprobarla podría dejar sin aviso de su propia entrega a un repartidor
   * autorizado, así que esta rama no cambia.
   */
  if (event.audience === 'assignee') return assigneeAccepts(event, actor);
  return companyAccepts(event, can);
}

/** El repartidor implicado (o administración). Sin tocar la empresa. */
function assigneeAccepts(event, actor) {
  const role = String(actor?.role ?? '');
  if (role === 'ADMIN') return true;
  const me = String(actor?.id ?? '');
  if (!me) return false;
  const data = event.data ?? {};
  return data.delivery_user_id === me || data.previous_delivery_user_id === me;
}

/**
 * La empresa del evento deja verlo a este cliente.
 *
 * `companyScoped: false` = evento global (inventario, supervisor, tickets): no
 * se filtra por empresa. Si está acotado y la empresa no se puede demostrar
 * (`company === null`), solo lo ve la central: cerrar antes que adivinar.
 */
function companyAccepts(event, can) {
  if (!event.companyScoped) return true;
  if (can('admin.full')) return true;
  return event.company === 'phytoemagry';
}

/**
 * HUB EN MEMORIA.
 *
 * - `seq` crece con cada evento publicado: el cliente lo guarda y al reconectar
 *   pide `?since=<seq>`.
 * - `buffer` guarda los últimos eventos para poder reanudar.
 * - Cada suscriptor recibe su propio filtro (permiso + identidad).
 */
export function createRealtimeHub({ bufferSize = 500, heartbeatMs = 25000, now = () => new Date() } = {}) {
  /** @type {Set<any>} */
  const clients = new Set();
  /** @type {Array<any>} */
  const buffer = [];
  let seq = 0;

  function frame(payload) {
    return `id: ${payload.seq}\nevent: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  /** Evento publicado, sin enviarlo a nadie (lo usan las pruebas y el reenvío). */
  function materialize(event) {
    const at = event.at ?? now().toISOString();
    return {
      v: REALTIME_VERSION,
      seq: ++seq,
      at,
      type: event.type,
      entity: event.entity ?? null,
      requires: event.requires ?? null,
      audience: event.audience ?? 'panel',
      /*
       * Empresa del registro que cambió. `null` con `companyScoped: true`
       * significa «no se puede demostrar»: el evento queda para la central.
       * No se envía contenido, solo el identificador, así que no hay PII aquí.
       */
      company: event.company ?? null,
      companyScoped: event.companyScoped === true,
      actor: event.actor ? { id: String(event.actor.id ?? ''), name: String(event.actor.display_name ?? event.actor.name ?? '') } : null,
      origin: event.origin ? String(event.origin).slice(0, 64) : null,
      data: event.data ?? {},
    };
  }

  /**
   * Publica uno o varios eventos. Nunca lanza: avisar no puede tumbar la
   * operación que sí se guardó.
   */
  function publish(input, options = {}) {
    const list = Array.isArray(input) ? input : [input];
    const out = [];
    for (const raw of list) {
      if (!raw?.type || !REALTIME_TYPES.includes(raw.type)) continue;
      const payload = materialize(raw);
      buffer.push(payload);
      while (buffer.length > bufferSize) buffer.shift();
      out.push(payload);
      for (const client of [...clients]) {
        try {
          if (!clientAccepts(payload, client)) continue;
          // El mismo dispositivo que hizo el cambio ya lo aplicó: no se le repite.
          if (payload.origin && payload.origin === client.origin) continue;
          client.send(frame(payload));
        } catch {
          drop(client);
        }
      }
    }
    if (options.after) options.after(out);
    return out;
  }

  /** Eventos posteriores al cursor (para reanudar tras una desconexión). */
  function replay(since) {
    const cursor = Number(since);
    if (!Number.isFinite(cursor) || cursor <= 0) return [];
    return buffer.filter((event) => event.seq > cursor);
  }

  function drop(client) {
    clients.delete(client);
    try {
      client.close?.();
    } catch {
      /* ya estaba cerrado */
    }
  }

  /**
   * Alta de un cliente SSE. `send` escribe un trozo y `close` cierra.
   * Devuelve la función para darse de baja.
   *
   * El objeto que se guarda es EL QUE MANDA el llamador (con sus `get`, si los
   * tiene): así el permiso y la identidad se leen en el momento de cada evento y
   * un cambio de rol o una sesión revocada se notan sin reconectar.
   */
  function subscribe(input = {}) {
    const client = input;
    clients.add(client);
    const missed = replay(input.since);
    for (const event of missed) {
      if (!clientAccepts(event, client)) continue;
      try {
        input.send(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event, replayed: true })}\n\n`);
      } catch {
        drop(client);
        break;
      }
    }
    return () => drop(client);
  }

  function stats() {
    return {
      seq,
      clients: clients.size,
      buffered: buffer.length,
      last: buffer[buffer.length - 1]?.type ?? null,
      // Últimos eventos publicados (para diagnóstico: no llevan datos privados).
      recent: buffer.slice(-8).map((event) => ({ seq: event.seq, type: event.type, at: event.at, entity: event.entity })),
    };
  }

  return { publish, replay, subscribe, stats, get seq() { return seq; }, clients };
}
