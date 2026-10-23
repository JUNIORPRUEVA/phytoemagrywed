/**
 * CENTRO DE OPERACIONES — PUENTE CON EL SUPERVISOR DE DELIVERY (Etapa E).
 *
 * QUÉ ES
 * El supervisor de delivery ya sabe, con funciones puras, qué pedido necesita
 * atención (`supervisionEligibility` + `supervisionOf`). Lo que faltaba era que
 * ese aviso llegara **al equipo**, dentro del panel, con conversación y
 * responsable. Este módulo abre (o reutiliza) el ticket interno de ese pedido y
 * le pone encima al agente de IA.
 *
 * REGLAS
 *   - No envía nada al cliente: aquí no hay WhatsApp. El canal externo sigue
 *     siendo el del supervisor y no se toca desde esta etapa.
 *   - Un pedido = UN ticket activo. `createTicket` ya deduplica por
 *     `active_key` (pedido + flujo «supervision»): reintentar no duplica.
 *   - Solo se abre ticket cuando hay algo que hacer (`severity !== 'ok'` o una
 *     etapa que exige persona). Un pedido que va bien no ensucia la bandeja.
 *   - Si algo falla, se anota y se sigue con el siguiente pedido.
 */

import {
  STAGE_NEXT_ACTION,
  SUPERVISOR_STAGES,
  parseOrderRow,
  responsibleOf,
  supervisionEligibility,
  supervisionOf,
  supervisorSettings,
} from '../delivery-supervisor.mjs';
import { assignAgentToTicket } from './agents.mjs';
import { createTicket, taskAction } from './tickets.mjs';
import { postMessage } from './messages.mjs';

/** Agente de IA de reparto que se asigna al ticket (si está dado de alta). */
export const DELIVERY_AGENT_KEY = 'delivery_supervisor';

/** Actor del sistema para las acciones automáticas (queda en la auditoría). */
export const SUPERVISION_ACTOR = Object.freeze({
  id: 'SYSTEM',
  role: 'SYSTEM',
  display_name: 'Supervisor de delivery',
  actor_type: 'SYSTEM',
});

/** Etapas que SIEMPRE piden una persona, aunque acaben de empezar. */
const ALWAYS_NEEDS_PERSON = new Set([
  SUPERVISOR_STAGES.NO_RESPONSIBLE,
  SUPERVISOR_STAGES.SEND_FAILED,
  SUPERVISOR_STAGES.ISSUE,
  SUPERVISOR_STAGES.AWAITING_CONFIRMATION,
  SUPERVISOR_STAGES.NOT_ACCEPTED,
]);

const STAGE_TITLES = Object.freeze({
  no_responsible: 'Pedido sin responsable de reparto',
  not_accepted: 'El repartidor no ha aceptado la entrega',
  not_confirmed: 'El repartidor no ha confirmado el pedido',
  send_failed: 'Falló el envío del pedido al repartidor',
  pending_start: 'El reparto no ha arrancado',
  pickup_pending: 'Recogida pendiente en tienda',
  in_transit: 'Entrega en curso sin confirmar',
  awaiting_confirmation: 'Falta confirmar la entrega',
  issue: 'Incidencia reportada en la entrega',
});

const STAGE_PRIORITY = Object.freeze({
  issue: 'urgent',
  no_responsible: 'urgent',
  not_accepted: 'high',
  send_failed: 'high',
  awaiting_confirmation: 'high',
  not_confirmed: 'high',
});

/** ¿Este pedido merece un ticket interno ahora mismo? */
export function needsDeliveryTicket({ order, settings = {}, now = Date.now() }) {
  const eligibility = supervisionEligibility(order, settings);
  if (!eligibility.eligible) return { needed: false, reason: eligibility.reason };
  const supervision = supervisionOf(order, { settings, now });
  const stage = supervision.stage;
  if (stage === SUPERVISOR_STAGES.CLOSED || stage === SUPERVISOR_STAGES.POSTPONED) {
    return { needed: false, reason: stage };
  }
  if (supervision.severity !== 'ok' || ALWAYS_NEEDS_PERSON.has(stage)) {
    return { needed: true, stage, supervision, eligibility: eligibility.reason };
  }
  return { needed: false, reason: 'al_dia' };
}

/**
 * Abre (o reutiliza) el ticket del pedido y le asigna el agente de IA.
 *
 * No envía nada fuera. No toca el pedido. Solo escribe en el centro de
 * operaciones.
 */
export async function openDeliveryTicketsFromSupervision({
  ctx,
  deps = {},
  orders = [],
  settings = null,
  agentKey = DELIVERY_AGENT_KEY,
  limit = 5,
  now = null,
} = {}) {
  const effectiveSettings = settings ?? (await supervisorSettings(ctx));
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const can = () => true;
  const created = [];
  const existing = [];
  const skipped = [];
  const errors = [];

  for (const row of orders) {
    if (created.length + existing.length >= limit) break;
    let order = null;
    try {
      order = parseOrderRow(row);
    } catch {
      errors.push({ orderId: row?.id ?? null, error: 'invalid_order' });
      continue;
    }
    const decision = needsDeliveryTicket({ order, settings: effectiveSettings, now: nowMs });
    if (!decision.needed) {
      skipped.push({ orderId: order.id, reason: decision.reason });
      continue;
    }

    const responsible = responsibleOf(order);
    const title = `${STAGE_TITLES[decision.stage] ?? 'Seguimiento de la entrega'} · ${order.order_number ?? order.id}`;
    const minutes = Number(decision.supervision.elapsedMinutes ?? 0) || 0;
    const description = [
      `Etapa: ${decision.stage}.`,
      minutes ? `Lleva ${minutes} minuto(s) en ese punto.` : null,
      `Siguiente acción: ${STAGE_NEXT_ACTION[decision.stage] ?? 'Revisar el pedido'}.`,
      responsible?.name ? `Responsable actual: ${responsible.name}.` : 'Sin responsable asignado.',
    ]
      .filter(Boolean)
      .join(' ');

    try {
      const createInput = {
        type: 'delivery',
        title,
        description,
        priority: STAGE_PRIORITY[decision.stage] ?? 'high',
        entityType: 'order',
        entityId: order.id,
        workflowKey: 'supervision',
        /* Solo se asigna a una PERSONA interna; un repartidor externo no tiene usuario. */
        assignedUserId: responsible?.type === 'internal' ? responsible.userId : null,
        requiresAck: true,
      };
      let result = await createTicket({
        ctx,
        actor: SUPERVISION_ACTOR,
        can,
        findOrder: deps.findOrder ?? null,
        deps,
        input: createInput,
      });
      /*
       * Si el responsable ya no existe (usuario borrado), el ticket se abre
       * igual SIN asignar: el aviso tiene que llegar a alguien de todas formas.
       */
      if (!result.ok && result.status === 422 && result.error === 'invalid_assignee') {
        result = await createTicket({
          ctx,
          actor: SUPERVISION_ACTOR,
          can,
          findOrder: deps.findOrder ?? null,
          deps,
          input: { ...createInput, assignedUserId: null },
        });
      }

      if (!result.ok && result.status !== 409) {
        errors.push({ orderId: order.id, error: result.error ?? 'ticket_failed' });
        continue;
      }
      const ticket = result.ticket;
      if (result.status === 409) {
        existing.push({ orderId: order.id, ticketId: ticket?.id ?? null, number: ticket?.number ?? null });
      } else {
        created.push({ orderId: order.id, ticketId: ticket?.id ?? null, number: ticket?.number ?? null, stage: decision.stage });
      }

      /* El agente se pone encima SOLO si está dado de alta y habilitado. */
      if (ticket?.id && agentKey) {
        const assigned = await assignAgentToTicket({
          ctx,
          deps,
          actor: SUPERVISION_ACTOR,
          can,
          ticketId: ticket.id,
          agentKey,
        });
        if (!assigned.ok) errors.push({ orderId: order.id, error: assigned.error ?? 'agent_failed' });
      }
    } catch (error) {
      errors.push({ orderId: order.id, error: 'exception', message: String(error?.message ?? error).slice(0, 200) });
    }
  }

  return { created, existing, skipped, errors, evaluated: orders.length };
}

/**
 * TICKET DEL PEDIDO (el «chat» del Centro IA).
 *
 * Reutiliza el ticket activo del flujo `supervision` y, si todavía no existe
 * (porque la comunicación ocurre antes de que el pedido esté en riesgo), lo abre.
 * Un pedido = UN ticket activo: `createTicket` ya deduplica por `active_key`.
 */
export async function ensureDeliveryTicket({ ctx, deps = {}, order, orderId = null, agentKey = DELIVERY_AGENT_KEY } = {}) {
  const id = String(orderId ?? order?.id ?? '');
  if (!id) return null;
  const tickets = await ctx.db.list('ops_tickets', { where: { entity_id: id }, limit: 50 }).catch(() => []);
  const vivo = tickets.find(
    (row) => String(row.entity_type) === 'order' && !['resolved', 'cancelled'].includes(String(row.status)),
  );
  if (vivo) return vivo;
  const responsible = responsibleOf(order ?? {});
  const created = await createTicket({
    ctx,
    actor: SUPERVISION_ACTOR,
    can: () => true,
    findOrder: deps.findOrder ?? null,
    deps,
    input: {
      type: 'delivery',
      title: `Seguimiento de la entrega · ${order?.order_number ?? id}`,
      description: 'Supervisión de la entrega y comunicaciones con el repartidor.',
      priority: 'high',
      entityType: 'order',
      entityId: id,
      workflowKey: 'supervision',
      assignedUserId: responsible?.type === 'internal' ? responsible.userId : null,
      requiresAck: false,
    },
  }).catch(() => null);
  const ticket = created?.ticket ?? (created?.status === 409 ? created?.ticket : null);
  if (!ticket?.id) return null;
  if (agentKey) {
    await assignAgentToTicket({ ctx, deps, actor: SUPERVISION_ACTOR, can: () => true, ticketId: ticket.id, agentKey }).catch(() => null);
  }
  return ticket;
}

/**
 * UNA COMUNICACIÓN EXTERNA EN EL CHAT DEL PEDIDO.
 *
 * `direction`:
 *   outbound → lo envió el supervisor (WhatsApp real; estado del proveedor).
 *   inbound  → lo escribió el repartidor (respuesta verificada del webhook).
 *   system   → nota de supervisión (escalado, petición de datos).
 *
 * El estado NUNCA se inventa: si el proveedor no confirmó, queda `pending` o
 * `failed` con el motivo. Idempotente por `clientKey`.
 */
export async function recordExternalMessage({
  ctx,
  deps = {},
  orderId,
  order = null,
  orderNumber = null,
  direction = 'outbound',
  channel = 'whatsapp',
  to = null,
  phoneField = null,
  recipientUserId = null,
  recipientName = null,
  status = 'sent',
  providerId = null,
  error = null,
  errorCode = null,
  kind = 'text',
  attempt = null,
  body = '',
  at = null,
  authorName = null,
  clientKey = null,
} = {}) {
  const texto = String(body ?? '').trim();
  if (!orderId || !texto) return null;
  const ticket = await ensureDeliveryTicket({ ctx, deps, order, orderId });
  if (!ticket?.id) return null;
  const quien = direction === 'inbound' ? authorName ?? 'Repartidor' : direction === 'system' ? 'Supervisor IA' : 'Supervisor IA Delivery';
  const key = clientKey ?? `wa:${direction}:${providerId ?? at ?? ctx.clock().toISOString()}:${orderId}:${kind}`;
  const resultado = await postMessage({
    ctx,
    actor: { id: 'SYSTEM', display_name: quien, role: 'SYSTEM', actor_type: 'SYSTEM' },
    can: () => true,
    ticketId: ticket.id,
    body: texto,
    clientKey: key,
    deps,
    authorType: direction === 'inbound' ? 'user' : 'agent',
    kind: direction === 'system' ? 'note' : 'text',
    meta: {
      channel: direction === 'system' ? 'supervisor' : 'whatsapp',
      direction,
      to: to ? `***${String(to).slice(-4)}` : null,
      /* De qué campo salió el número y a quién pertenece: auditoría sin datos personales. */
      phone_field: phoneField ?? null,
      recipient_user_id: recipientUserId ?? null,
      recipient_name: recipientName ?? null,
      status,
      provider_id: providerId ?? null,
      error: error ?? null,
      error_code: Number.isFinite(Number(errorCode)) && Number(errorCode) > 0 ? Number(errorCode) : null,
      attempt,
      order_number: orderNumber ?? order?.order_number ?? null,
      at: at ?? ctx.clock().toISOString(),
      tz: 'America/Santo_Domingo',
    },
  }).catch(() => null);
  return resultado?.ok ? { ticketId: ticket.id, messageId: resultado.message?.id ?? null } : null;
}

/**
 * ACUSE DEL PROVEEDOR EN EL CHAT DEL PEDIDO.
 *
 * Los mensajes que el supervisor envía al repartidor o a administración se
 * guardan con el `provider_id` de Meta. Cuando llega el webhook de estados
 * (`delivered`, `read`, `failed`), el estado REAL tiene que actualizarse también
 * en el chat operativo: antes solo se actualizaba el hilo de cliente y el panel
 * seguía diciendo «Enviado» para siempre.
 *
 * Es idempotente y no inventa: si el estado ya es el mismo, no escribe.
 */
export async function reconcileDeliveryReceipt({ ctx, providerId = null, status = null, at = null, errorCode = null, errorMessage = null } = {}) {
  const id = String(providerId ?? '').trim();
  const nuevo = String(status ?? '').trim().toLowerCase();
  if (!id || !nuevo) return { ok: false, reason: 'missing_data' };
  const filas = await ctx.db.list('ops_ticket_messages', { limit: 5000 }).catch(() => []);
  const fila = filas.find((row) => String(row?.meta?.provider_id ?? '') === id);
  if (!fila) return { ok: false, reason: 'not_tracked' };
  const meta = fila.meta && typeof fila.meta === 'object' ? fila.meta : {};
  /*
   * EL MOTIVO DEL PROVEEDOR SE GUARDA, NO SE PIERDE.
   *
   * Meta manda el código y el título del error en el webhook de estados. Antes
   * solo se copiaba el estado («failed») y el diagnóstico se perdía: en la
   * prueba real del 2026-10-23 el mensaje quedó `failed` sin poder saber por qué
   * sin volver a enviar. Ahora se persisten `error_code` y `error` (título
   * recortado) y el panel los muestra en la misma burbuja.
   */
  const codigo = Number.isFinite(Number(errorCode)) && Number(errorCode) > 0 ? Number(errorCode) : null;
  const titulo = errorMessage ? String(errorMessage).slice(0, 200) : null;
  const mismoEstado = String(meta.status ?? '') === nuevo;
  const mismoError = (meta.error_code ?? null) === codigo && (meta.error ?? null) === titulo;
  if (mismoEstado && mismoError) return { ok: true, reason: 'unchanged', messageId: fila.id };
  const actualizado = await ctx.db
    .update('ops_ticket_messages', fila.id, {
      meta: {
        ...meta,
        status: nuevo,
        provider_status_at: at ?? ctx.clock().toISOString(),
        ...(codigo ? { error_code: codigo } : {}),
        ...(titulo ? { error: titulo } : {}),
      },
    })
    .catch(() => null);
  if (!actualizado) return { ok: false, reason: 'update_failed' };
  /* El hilo se repinta al instante para quien tenga el panel abierto. */
  try {
    ctx.realtime?.emit?.('ops_ticket_messages', 'update', { id: fila.id, ticketId: fila.ticket_id });
  } catch {
    /* sin tiempo real: el panel lo verá al refrescar */
  }
  return { ok: true, reason: 'updated', messageId: fila.id, ticketId: fila.ticket_id, status: nuevo, errorCode: codigo, errorMessage: titulo };
}

/**
 * CIERRE DEL TRABAJO DEL SUPERVISOR.
 *
 * Cuando la entrega termina (entregada o cancelada), el ticket interno se
 * quedaba abierto para siempre: el agente no tenía forma de enterarse y la
 * bandeja se llenaba de tickets de pedidos ya cerrados.
 *
 * Aquí se marca TAN SOLO la TAREA como terminada (no se cierra el ticket: eso
 * sigue siendo una decisión humana con su permiso). Es determinista, idempotente
 * y deja su evento en el hilo.
 */
export async function closeDeliveredTickets({ ctx, deps = {}, orders = [], limit = 20 } = {}) {
  const cerrados = new Set(['entregado', 'cancelado', 'perdido']);
  const porId = new Map();
  for (const row of orders) {
    const order = parseOrderRow(row);
    if (!order) continue;
    if (!cerrados.has(String(order.status ?? row.status ?? ''))) continue;
    porId.set(String(row.id), String(order.status ?? row.status));
  }
  if (!porId.size) return { completed: [] };

  const tickets = await ctx.db.list('ops_tickets', { limit: 500 }).catch(() => []);
  const completed = [];
  for (const ticket of tickets) {
    if (completed.length >= limit) break;
    if (String(ticket.entity_type) !== 'order') continue;
    /*
     * SOLO LOS TICKETS DE REPARTO. Un ticket de otro flujo (una factura, una
     * reclamación) atado al mismo pedido NO se toca: su trabajo no es la entrega.
     */
    if (String(ticket.type) !== 'delivery' && String(ticket.assigned_agent_id ?? '') !== DELIVERY_AGENT_KEY) continue;
    if (['resolved', 'cancelled'].includes(String(ticket.status))) continue;
    if (ticket.task?.completed_at) continue;
    const estado = porId.get(String(ticket.entity_id));
    if (!estado) continue;
    try {
      const result = await taskAction({
        ctx,
        actor: SUPERVISION_ACTOR,
        can: () => true,
        id: ticket.id,
        action: 'complete',
        note: `La entrega quedó ${estado === 'entregado' ? 'entregada' : 'cerrada'}. El supervisor da su trabajo por terminado; el ticket queda para cierre humano.`,
        deps,
      });
      if (result?.ok) completed.push({ ticketId: ticket.id, orderId: ticket.entity_id, estado });
    } catch {
      /* Un ticket que falla no puede parar el resto de la pasada. */
    }
  }
  return { completed };
}

/**
 * Una vuelta del puente, tal y como la llama el scheduler.
 *
 * Separa el tick del centro de operaciones para que un fallo del supervisor no
 * pueda dejar sin trabajo a los agentes (y al revés).
 */
export async function opsDeliveryTicketTick({ ctx, deps = {}, agentKey = DELIVERY_AGENT_KEY } = {}) {
  if (typeof deps.listOrders !== 'function') return { created: [], existing: [], skipped: [], errors: [], skippedAll: true };
  let rows = [];
  try {
    rows = (await deps.listOrders()) ?? [];
  } catch (error) {
    return { created: [], existing: [], skipped: [], errors: [{ error: 'orders_unavailable', message: String(error?.message ?? error).slice(0, 200) }] };
  }
  const abiertos = await openDeliveryTicketsFromSupervision({ ctx, deps, orders: rows, agentKey });
  /*
   * DESPUÉS de abrir: las entregas que ya cerraron sueltan su trabajo. Va en la
   * misma pasada para que un pedido entregado no deje el ticket «en curso».
   */
  const cierre = await closeDeliveredTickets({ ctx, deps, orders: rows }).catch(() => ({ completed: [] }));
  return { ...abiertos, completed: cierre.completed ?? [] };
}
