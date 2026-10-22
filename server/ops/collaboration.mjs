/**
 * CENTRO IA — COLABORACIÓN ENTRE AGENTES (Fase 6).
 *
 * QUÉ ES
 * Un agente autorizado puede pedir ayuda a OTRO agente registrado sobre el
 * MISMO ticket. No se abre un ticket nuevo, no se copia la conversación del
 * cliente y **no se transfieren permisos**: el agente que recibe la petición
 * trabaja con su propia lista blanca de herramientas y con sus propios
 * permisos, y deja su respuesta en el hilo compartido.
 *
 * REGLAS (todas comprobadas en el servidor, ninguna en el navegador)
 *   1. Nada de pedirse ayuda a uno mismo (`delegation_self`).
 *   2. El destinatario tiene que existir, estar ACTIVO y trabajar en ese tipo
 *      de ticket (`delegation_target_missing`, `…_disabled`, `…_type_denied`).
 *   3. Un agente puede desactivar la colaboración en su ficha
 *      (`config.collaboration === false`) → `delegation_target_opt_out`.
 *   4. Sin bucles: la cadena de la delegación viaja con el run y no se puede
 *      volver a llamar a quien ya está en ella (`delegation_loop`).
 *   5. Profundidad máxima y tope por ticket: el trabajo no puede encadenarse
 *      sin fin ni llenar el ticket de peticiones.
 *   6. Una sola petición viva por par (ticket, agente): repetirla devuelve la
 *      que ya existe en vez de duplicarla.
 *
 * Cada delegación queda en `ops_agent_delegations` (persistente), con su
 * evento en el ticket y su línea de auditoría.
 */

import { randomBytes } from 'node:crypto';
import { addParticipant, recordEvent } from './tickets.mjs';
import { postMessage } from './messages.mjs';

/** Estados de una delegación. `pending/accepted` son los vivos. */
export const DELEGATION_STATUSES = Object.freeze([
  'pending',
  'accepted',
  'completed',
  'rejected',
  'failed',
  'cancelled',
]);

/** Cadena máxima de favores: A → B → C. Ni un eslabón más. */
export const MAX_DELEGATION_DEPTH = 2;
/** Tope de delegaciones por ticket (evita ruido y bucles indirectos). */
export const MAX_DELEGATIONS_PER_TICKET = 4;
/** Una delegación sin respuesta deja de estar viva a los dos días. */
export const DELEGATION_TTL_MS = 48 * 60 * 60 * 1000;

const LIVE = Object.freeze(['pending', 'accepted']);

function newId(prefix) {
  return `${prefix}_${randomBytes(10).toString('hex')}`;
}

function clean(value, max = 240) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function nowIso(ctx) {
  const clock = ctx?.clock ?? (() => new Date());
  return clock().toISOString();
}

/** Identidad del agente como actor del sistema (nunca es un usuario del CRM). */
function actorOf(agent) {
  return {
    id: `agent:${agent.key}`,
    role: 'AGENT_AI',
    display_name: agent.name ?? agent.key,
    actor_type: 'AGENT',
  };
}

/** Permisos del agente, derivados de su registro. */
function canOf(agent) {
  const list = Array.isArray(agent?.permissions) ? agent.permissions : [];
  return (permission) => list.includes(permission);
}

/* ===================================================== QUIÉN PUEDE AYUDAR */

/**
 * Agentes a los que ESTE agente puede pedir ayuda en ESTE ticket.
 *
 * Es la misma regla que se aplica al delegar, así que lo que se enseña en la
 * oficina y lo que el modelo puede proponer coincide con lo que el servidor
 * aceptará. No incluye al propio agente ni a los desactivados.
 */
export async function listCollaborators({ ctx, agent, ticket }) {
  if (!agent?.key || !ticket?.type) return [];
  const rows = await ctx.db.list('ops_agents', { by: 'created_at', order: 'asc', limit: 100 });
  return rows
    .filter((row) => row.key !== agent.key)
    .filter((row) => row.enabled !== false)
    .filter((row) => row.config?.collaboration !== false)
    .filter((row) => (row.ticket_types ?? []).includes(ticket.type))
    .filter((row) => (row.tools ?? []).length > 0)
    .map((row) => ({
      key: row.key,
      name: row.name ?? row.key,
      role: row.role ?? null,
      tools: (row.tools ?? []).length,
    }));
}

/* ========================================================== DELEGAR */

/**
 * Crea la petición de ayuda. Devuelve `{ok:true, result}` o `{ok:false, error}`.
 *
 * `ensureRun` lo inyecta el motor de agentes (es quien sabe crear runs): así
 * este módulo no depende del motor y no hay importaciones circulares.
 */
export async function requestHelp({ ctx, deps, agent, ticket, run, args = {}, ensureRun }) {
  const targetKey = clean(args.agentKey, 80);
  const question = clean(args.question, 300);
  if (!targetKey) {
    return { ok: false, error: { code: 'delegation_target_required', message: 'Falta el agente al que pedir ayuda', retryable: false } };
  }
  if (!question) {
    return { ok: false, error: { code: 'delegation_question_required', message: 'Falta la pregunta', retryable: false } };
  }
  if (targetKey === agent.key) {
    return { ok: false, error: { code: 'delegation_self', message: 'Un agente no se pide ayuda a sí mismo', retryable: false } };
  }

  const target = await ctx.db.findBy('ops_agents', 'key', targetKey);
  if (!target) {
    return { ok: false, error: { code: 'delegation_target_missing', message: 'Ese agente no existe', retryable: false } };
  }
  if (target.enabled === false) {
    return { ok: false, error: { code: 'delegation_target_disabled', message: 'Ese agente está desactivado', retryable: false } };
  }
  if (target.config?.collaboration === false) {
    return { ok: false, error: { code: 'delegation_target_opt_out', message: 'Ese agente no acepta colaboraciones', retryable: false } };
  }
  /* Autorización explícita por tipo de ticket: no todo agente sirve para todo. */
  if (!(target.ticket_types ?? []).includes(ticket.type)) {
    return {
      ok: false,
      error: { code: 'delegation_type_denied', message: 'Ese agente no trabaja en este tipo de ticket', retryable: false },
    };
  }
  if (!(target.tools ?? []).length) {
    return { ok: false, error: { code: 'delegation_target_empty', message: 'Ese agente no tiene herramientas', retryable: false } };
  }

  const chain = Array.isArray(run.state?.delegationChain) ? run.state.delegationChain : [];
  if (chain.includes(target.key)) {
    return { ok: false, error: { code: 'delegation_loop', message: 'Ese agente ya participó en esta cadena', retryable: false } };
  }
  /*
   * Profundidad: la cadena guarda quién YA pidió ayuda. Con la cadena vacía
   * esto es el primer favor (profundidad 0) y se permite; cuando ya hay dos
   * eslabones, se corta. Así A→B→C vale y C→D no.
   */
  if (chain.length >= MAX_DELEGATION_DEPTH) {
    return {
      ok: false,
      error: { code: 'delegation_depth_exceeded', message: 'Se alcanzó la profundidad máxima de colaboración', retryable: false },
    };
  }

  const existing = await ctx.db.list('ops_agent_delegations', { where: { ticket_id: ticket.id }, limit: 60 });
  if (existing.length >= MAX_DELEGATIONS_PER_TICKET) {
    return { ok: false, error: { code: 'delegation_limit', message: 'Este ticket ya tiene demasiadas peticiones de ayuda', retryable: false } };
  }
  const live = existing.find((row) => row.to_agent_key === target.key && LIVE.includes(row.status));
  if (live) {
    /* Idempotente: la misma petición devuelve la que ya está viva. */
    return { ok: true, result: { delegationId: live.id, to: target.key, toName: target.name ?? target.key, status: live.status, duplicate: true } };
  }

  const at = nowIso(ctx);
  const delegation = {
    id: newId('dlg'),
    ticket_id: ticket.id,
    ticket_number: ticket.number ?? null,
    from_agent_key: agent.key,
    from_agent_name: agent.name ?? agent.key,
    to_agent_key: target.key,
    to_agent_name: target.name ?? target.key,
    question,
    status: 'pending',
    depth: chain.length,
    chain: [...chain, agent.key],
    run_id: null,
    requested_at: at,
    accepted_at: null,
    settled_at: null,
    result_note: null,
    idempotency_key: `dlg:${ticket.id}:${run.id}:${target.key}`,
    created_at: at,
    updated_at: at,
  };
  await ctx.db.insert('ops_agent_delegations', delegation);

  /*
   * AUTORIZACIÓN EXPLÍCITA DE PARTICIPACIÓN: el receptor entra como
   * participante del MISMO ticket (si no, no podría escribir en el hilo). Ser
   * participante no le da permisos nuevos: sigue usando sus herramientas.
   */
  await addParticipant(ctx, {
    ticketId: ticket.id,
    userId: actorOf(target).id,
    name: target.name ?? target.key,
    role: 'agent',
    actor: actorOf(agent),
    participantType: 'agent',
  });

  /* El receptor recibe SU run en el MISMO ticket, con su propia ficha. */
  const targetRun = await ensureRun({
    ctx,
    ticket,
    agent: target,
    event: 'agent.delegation',
    workflow: 'collab',
    state: {
      collabFrom: agent.key,
      collabFromName: agent.name ?? agent.key,
      collabQuestion: question,
      delegationId: delegation.id,
      delegationChain: delegation.chain,
    },
  });
  await ctx.db.update('ops_agent_delegations', delegation.id, {
    run_id: targetRun?.id ?? null,
    updated_at: at,
  });

  const agentUser = actorOf(agent);
  /* En el hilo queda constancia visible para las personas del equipo. */
  await postMessage({
    ctx,
    actor: agentUser,
    can: canOf(agent),
    ticketId: ticket.id,
    body: `Le pido ayuda a ${target.name ?? target.key}: ${question}`,
    clientKey: `agent:${run.id}:delegation:${target.key}`,
    deps,
    authorType: 'agent',
    kind: 'delegation',
    meta: { delegationId: delegation.id, to: target.key, toName: target.name ?? target.key, question },
  });
  await recordEvent(ctx, {
    ticketId: ticket.id,
    kind: 'agent_delegation_requested',
    actor: agentUser,
    summary: `Ayuda pedida a ${target.name ?? target.key}`,
    data: { delegation_id: delegation.id, to: target.key },
    idempotencyKey: `opdlg:requested:${delegation.id}`,
  });
  await ctx.audit?.record?.({
    entity: 'agent',
    entityId: agent.key,
    action: 'agent_delegation_requested',
    actor: agent.name ?? agent.key,
    summary: `${ticket.number ?? ticket.id} · ${agent.key} → ${target.key}`,
    data: { delegation_id: delegation.id, to: target.key, depth: delegation.depth },
  });

  return {
    ok: true,
    result: { delegationId: delegation.id, to: target.key, toName: target.name ?? target.key, status: 'pending' },
  };
}

/* ================================================== ESTADO Y CIERRE */

/** La delegación viva de este run (la que le pidieron atender). */
export async function delegationOfRun({ ctx, run, ticketId }) {
  const id = run?.state?.delegationId;
  if (!id) return null;
  const row = await ctx.db.get('ops_agent_delegations', id);
  if (!row) return null;
  if (ticketId && row.ticket_id !== ticketId) return null;
  return row;
}

/** El receptor empezó a mirarlo: la delegación pasa a `accepted`. */
export async function markAccepted({ ctx, delegation }) {
  if (!delegation || delegation.status !== 'pending') return delegation ?? null;
  return ctx.db.update('ops_agent_delegations', delegation.id, {
    status: 'accepted',
    accepted_at: nowIso(ctx),
    updated_at: nowIso(ctx),
  });
}

/**
 * Cierra la delegación que atendía este run.
 * `status`: `completed` (dejó su respuesta) | `rejected` | `failed` | `cancelled`.
 */
export async function settleDelegationOfRun({ ctx, run, status, note = null }) {
  /* Solo se cierra con un estado válido: nunca se escribe `null` en la fila. */
  if (!status || !['completed', 'rejected', 'failed', 'cancelled'].includes(status)) return null;
  const delegation = await delegationOfRun({ ctx, run });
  if (!delegation || !LIVE.includes(delegation.status)) return null;
  const at = nowIso(ctx);
  const updated = await ctx.db.update('ops_agent_delegations', delegation.id, {
    status,
    settled_at: at,
    result_note: clean(note, 400),
    updated_at: at,
  });
  await recordEvent(ctx, {
    ticketId: delegation.ticket_id,
    kind: `agent_delegation_${status}`,
    actor: actorOf({ key: delegation.to_agent_key, name: delegation.to_agent_name }),
    summary: status === 'completed' ? 'Ayuda entregada' : `Colaboración ${status}`,
    data: { delegation_id: delegation.id, status },
    idempotencyKey: `opdlg:${status}:${delegation.id}`,
  });
  await ctx.audit?.record?.({
    entity: 'agent',
    entityId: delegation.to_agent_key,
    action: status === 'completed' ? 'agent_delegation_completed' : 'agent_delegation_failed',
    actor: delegation.to_agent_name,
    summary: `${delegation.ticket_number ?? delegation.ticket_id} · ${status}`,
    data: { delegation_id: delegation.id, from: delegation.from_agent_key },
  });
  return updated;
}

/** Delegaciones de un ticket (para la ficha y para la oficina). */
export async function delegationsForTicket({ ctx, ticketId, limit = 20 }) {
  const rows = await ctx.db.list('ops_agent_delegations', { where: { ticket_id: ticketId }, limit });
  return rows
    .slice()
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map(publicDelegation);
}

/** Delegaciones en las que participa un agente (pedidas o recibidas). */
export async function delegationsForAgent({ ctx, agentKey, limit = 40 }) {
  const rows = await ctx.db.list('ops_agent_delegations', { by: 'created_at', order: 'desc', limit });
  return rows
    .filter((row) => row.from_agent_key === agentKey || row.to_agent_key === agentKey)
    .map((row) => ({ ...publicDelegation(row), direction: row.from_agent_key === agentKey ? 'out' : 'in' }));
}

/** Delegaciones vivas de un agente (contador de la oficina). */
export async function liveDelegationsCount({ ctx, agentKey }) {
  const rows = await ctx.db.list('ops_agent_delegations', { by: 'created_at', order: 'desc', limit: 100 });
  return rows.filter((row) => row.to_agent_key === agentKey && LIVE.includes(row.status)).length;
}

function publicDelegation(row) {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    ticketNumber: row.ticket_number ?? null,
    fromKey: row.from_agent_key,
    fromName: row.from_agent_name,
    toKey: row.to_agent_key,
    toName: row.to_agent_name,
    question: row.question,
    status: row.status,
    depth: Number(row.depth ?? 0) || 0,
    requestedAt: row.requested_at ?? row.created_at ?? null,
    settledAt: row.settled_at ?? null,
    resultNote: row.result_note ?? null,
  };
}
