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
import { createTicket } from './tickets.mjs';

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
]);

const STAGE_TITLES = Object.freeze({
  no_responsible: 'Pedido sin responsable de reparto',
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
  return openDeliveryTicketsFromSupervision({ ctx, deps, orders: rows, agentKey });
}
