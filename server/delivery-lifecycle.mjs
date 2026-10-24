/*
 * MOTOR OPERATIVO DE ENTREGAS (Fase 05).
 *
 * Dos conceptos SEPARADOS, como manda el negocio:
 *   · `order.status`            → estado COMERCIAL del pedido (nuevo…entregado).
 *   · `order.delivery.lifecycle` → estado LOGÍSTICO del reparto (esta máquina).
 *
 * El ciclo comercial no se reescribe aquí: cada transición logística deriva el estado
 * comercial que corresponde (`derivedOrderStatus`) y el panel sigue funcionando igual.
 *
 * Todo se calcula en el servidor:
 *   · la máquina de estados es una función pura (sin E/S, sin relojes implícitos),
 *   · el actor y el instante los pone quien llama,
 *   · una transición inválida no muta nada y explica por qué.
 */

export const DELIVERY_STATES = Object.freeze({
  ASSIGNED: 'ASSIGNED',
  OFFERED: 'OFFERED',
  ACCEPTED: 'ACCEPTED',
  PICKUP_PENDING: 'PICKUP_PENDING',
  PICKED_UP: 'PICKED_UP',
  EN_ROUTE: 'EN_ROUTE',
  ARRIVED: 'ARRIVED',
  DELIVERED: 'DELIVERED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  REASSIGNED: 'REASSIGNED',
});

/** Estados en los que el repartidor todavía puede operar. */
export const ACTIVE_STATES = Object.freeze([
  DELIVERY_STATES.ASSIGNED,
  DELIVERY_STATES.OFFERED,
  DELIVERY_STATES.ACCEPTED,
  DELIVERY_STATES.PICKUP_PENDING,
  DELIVERY_STATES.PICKED_UP,
  DELIVERY_STATES.EN_ROUTE,
  DELIVERY_STATES.ARRIVED,
]);

/** Estados finales: no admiten más acciones del repartidor. */
export const TERMINAL_STATES = Object.freeze([
  DELIVERY_STATES.DELIVERED,
  DELIVERY_STATES.REJECTED,
  DELIVERY_STATES.EXPIRED,
  DELIVERY_STATES.CANCELLED,
  DELIVERY_STATES.REASSIGNED,
]);

/**
 * Transiciones permitidas. `evento → estado destino`.
 * El panel puede forzar `CANCELLED` desde cualquier estado activo (lo controla la ruta).
 */
const TRANSITIONS = Object.freeze({
  [DELIVERY_STATES.ASSIGNED]: {
    offer: DELIVERY_STATES.OFFERED,
    accept: DELIVERY_STATES.ACCEPTED,
    reject: DELIVERY_STATES.REJECTED,
    expire: DELIVERY_STATES.EXPIRED,
  },
  [DELIVERY_STATES.OFFERED]: {
    accept: DELIVERY_STATES.ACCEPTED,
    reject: DELIVERY_STATES.REJECTED,
    expire: DELIVERY_STATES.EXPIRED,
  },
  [DELIVERY_STATES.ACCEPTED]: {
    pickup: DELIVERY_STATES.PICKED_UP,
    expire: DELIVERY_STATES.EXPIRED,
  },
  [DELIVERY_STATES.PICKUP_PENDING]: {
    pickup: DELIVERY_STATES.PICKED_UP,
    expire: DELIVERY_STATES.EXPIRED,
  },
  [DELIVERY_STATES.PICKED_UP]: {
    start: DELIVERY_STATES.EN_ROUTE,
  },
  [DELIVERY_STATES.EN_ROUTE]: {
    arrive: DELIVERY_STATES.ARRIVED,
    /* Entrega directa: el repartidor puede cerrar sin marcar llegada (zona rural). */
    deliver: DELIVERY_STATES.DELIVERED,
  },
  [DELIVERY_STATES.ARRIVED]: {
    deliver: DELIVERY_STATES.DELIVERED,
  },
});

/** Qué puede hacer el repartidor en cada estado (la app dibuja los botones con esto). */
export const COURIER_ACTIONS = Object.freeze({
  [DELIVERY_STATES.ASSIGNED]: ['accept', 'reject'],
  [DELIVERY_STATES.OFFERED]: ['accept', 'reject'],
  [DELIVERY_STATES.ACCEPTED]: ['pickup'],
  [DELIVERY_STATES.PICKUP_PENDING]: ['pickup'],
  [DELIVERY_STATES.PICKED_UP]: ['start'],
  [DELIVERY_STATES.EN_ROUTE]: ['arrive', 'deliver'],
  [DELIVERY_STATES.ARRIVED]: ['deliver'],
});

/** Estado logístico de un pedido: el nuevo campo o, si no existe, se deriva del histórico. */
export function lifecycleOf(order) {
  const stored = String(order?.delivery?.lifecycle ?? '').trim().toUpperCase();
  if (DELIVERY_STATES[stored]) return stored;
  return deriveLifecycleFromLegacy(order);
}

/**
 * Pedidos anteriores a la Fase 05 no tienen `lifecycle`.
 * Se derivan de lo que sí está guardado; nunca se inventa «entregado».
 */
export function deriveLifecycleFromLegacy(order) {
  const delivery = order?.delivery ?? {};
  const orderStatus = String(order?.status ?? '').trim().toLowerCase();
  if (orderStatus === 'entregado') return DELIVERY_STATES.DELIVERED;
  if (orderStatus === 'cancelado' || orderStatus === 'perdido') return DELIVERY_STATES.CANCELLED;
  if (delivery.delivery_accepted_at) {
    if (delivery.delivery_started_at) return DELIVERY_STATES.EN_ROUTE;
    return DELIVERY_STATES.ACCEPTED;
  }
  if (delivery.delivery_user_id || delivery.external?.contact_id) return DELIVERY_STATES.OFFERED;
  return DELIVERY_STATES.ASSIGNED;
}

/** Estado comercial que corresponde a un estado logístico. */
export function derivedOrderStatus(lifecycle, currentStatus) {
  const current = String(currentStatus ?? '').trim().toLowerCase();
  switch (lifecycle) {
    case DELIVERY_STATES.DELIVERED:
      return 'entregado';
    case DELIVERY_STATES.CANCELLED:
      return 'cancelado';
    case DELIVERY_STATES.EN_ROUTE:
    case DELIVERY_STATES.ARRIVED:
      return 'en_camino';
    case DELIVERY_STATES.PICKED_UP:
    case DELIVERY_STATES.ACCEPTED:
    case DELIVERY_STATES.PICKUP_PENDING:
      return current === 'en_camino' ? current : 'preparando';
    default:
      /* Rechazada / vencida / reasignada: el pedido sigue vivo y sin repartidor. */
      return current === 'cancelado' || current === 'entregado' ? current : 'confirmado';
  }
}

/** Equivalencia con el `delivery_status` operativo que ya usa el panel. */
export function operationalStatusFor(lifecycle) {
  switch (lifecycle) {
    case DELIVERY_STATES.DELIVERED:
      return 'DELIVERED';
    case DELIVERY_STATES.CANCELLED:
      return 'CANCELLED';
    case DELIVERY_STATES.EN_ROUTE:
    case DELIVERY_STATES.ARRIVED:
      return 'IN_TRANSIT';
    case DELIVERY_STATES.ACCEPTED:
    case DELIVERY_STATES.PICKUP_PENDING:
    case DELIVERY_STATES.PICKED_UP:
      return 'READY_FOR_DELIVERY';
    default:
      return 'PENDING_CONTACT';
  }
}

/**
 * Calcula el siguiente pedido. No escribe nada: devuelve `{ok, order}` o `{ok:false, error}`.
 *
 * Reglas duras:
 *  · estado de origen válido para el evento,
 *  · un pedido cerrado no admite acciones,
 *  · el instante sale del reloj del servidor (`now`), nunca del cliente.
 */
export function applyTransition(order, event, { actor = null, now, extra = {} } = {}) {
  const from = lifecycleOf(order);
  if (TERMINAL_STATES.includes(from)) {
    return {
      ok: false,
      status: 409,
      error: 'already_closed',
      message: `La entrega ya está cerrada (${from}).`,
      currentState: from,
    };
  }
  /*
   * El estado COMERCIAL manda: un pedido cancelado o perdido no se entrega, aunque
   * su ciclo logístico se hubiera quedado atrás (p. ej. cancelado desde el panel).
   */
  const commercial = String(order?.status ?? '').trim().toLowerCase();
  if (commercial === 'cancelado' || commercial === 'perdido') {
    return {
      ok: false,
      status: 409,
      error: 'already_closed',
      message: 'El pedido está cancelado: no admite acciones de reparto.',
      currentState: from,
    };
  }
  const next = TRANSITIONS[from]?.[event];
  if (!next) {
    return {
      ok: false,
      status: 409,
      error: 'invalid_transition',
      message: `No se puede «${event}» desde ${from}.`,
      currentState: from,
      allowed: COURIER_ACTIONS[from] ?? [],
    };
  }
  const at = now ?? new Date().toISOString();
  const delivery = { ...(order.delivery ?? {}) };
  delivery.lifecycle = next;
  delivery.delivery_status = operationalStatusFor(next);
  delivery.lifecycle_updated_at = at;
  delivery.lifecycle_updated_by = actor?.display_name ?? actor?.id ?? 'sistema';

  switch (event) {
    case 'accept':
      delivery.delivery_accepted_at = at;
      delivery.delivery_accepted_by_user_id = actor?.id ?? null;
      delivery.delivery_accepted_by_display_name_snapshot = actor?.display_name ?? null;
      break;
    case 'reject':
      delivery.delivery_rejected_at = at;
      delivery.delivery_rejected_reason = extra.reason ?? null;
      break;
    case 'pickup':
      delivery.delivery_picked_up_at = at;
      break;
    case 'start':
      delivery.delivery_started_at = at;
      break;
    case 'arrive':
      delivery.delivery_arrived_at = at;
      break;
    case 'deliver':
      delivery.delivery_delivered_at = at;
      delivery.delivery_completed_by_user_id = actor?.id ?? null;
      break;
    case 'expire':
      delivery.delivery_expired_at = at;
      break;
    default:
      break;
  }

  const nextStatus = derivedOrderStatus(next, order.status);
  return {
    ok: true,
    from,
    to: next,
    order: {
      ...order,
      status: nextStatus,
      version: (Number(order.version) > 0 ? Number(order.version) : 1) + 1,
      delivery,
      updated_at: at,
    },
  };
}

/** Vida de una oferta. Configurable por entorno; este es el valor por defecto. */
export const DEFAULT_OFFER_TTL_MS = 15 * 60 * 1000;

export function nextOfferExpiry(nowMs = Date.now(), ttlMs = DEFAULT_OFFER_TTL_MS) {
  return new Date(nowMs + ttlMs).toISOString();
}

/** ¿La oferta venció? Se evalúa en el servidor con su reloj. */
export function isOfferExpired(order, now = Date.now()) {
  if (lifecycleOf(order) !== DELIVERY_STATES.OFFERED) return false;
  const raw = order?.delivery?.offer_expires_at;
  if (!raw) return false;
  const expires = Date.parse(raw);
  return Number.isFinite(expires) && expires <= now;
}

/** Estados donde el pedido es trabajo activo del repartidor (lo que cuenta el supervisor). */
export function isActiveLifecycle(lifecycle) {
  return ACTIVE_STATES.includes(lifecycle);
}
