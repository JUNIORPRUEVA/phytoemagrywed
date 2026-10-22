/**
 * CENTRO IA — LECTURA DE LA OFICINA (Fase 1 y 2).
 *
 * Dos vistas, calculadas SIEMPRE con datos que existen:
 *
 *   centroDirectory()  el equipo: quién está, en qué estado, cuánto trabajo
 *                      tiene y cuánto sin leer. Es la pantalla de entrada.
 *   agentOffice()      la oficina de UN agente: tickets asignados, trabajo
 *                      pendiente, actividad real, herramientas autorizadas,
 *                      delegaciones y avisos.
 *
 * NADA se inventa aquí: el estado sale de los runs, los contadores de los runs
 * y de los tickets, y las herramientas del catálogo cerrado. Si un agente no
 * tiene runs, aparece en reposo (no «trabajando»).
 *
 * Los agentes son de la casa: no se listan por usuario del CRM, así que la
 * oficina no expone datos de clientes ni de WhatsApp.
 */

import { toolSpec } from './tools.mjs';
import {
  OPS_FINAL_STATUSES,
  OPS_PRIORITY_LABELS,
  OPS_TICKET_STATUS_LABELS,
  OPS_TICKET_TYPE_LABELS,
} from './tickets.mjs';
import { delegationsForAgent } from './collaboration.mjs';
import { workSnapshot } from './work.mjs';

/** Estados operativos de un agente (derivados, no almacenados). */
export const AGENT_STATES = Object.freeze(['working', 'waiting_human', 'waiting', 'idle', 'paused']);

export const AGENT_STATE_LABELS = Object.freeze({
  working: 'Trabajando',
  waiting_human: 'Esperando aprobación',
  waiting: 'En espera',
  idle: 'En reposo',
  paused: 'Desactivado',
});

const LIVE_RUNS = new Set(['pending', 'running', 'waiting_human', 'waiting_event']);

function nowIso(ctx) {
  const clock = ctx?.clock ?? (() => new Date());
  return clock().toISOString();
}

function clean(value, max = 240) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

/** Estado operativo derivado de los runs vivos del agente. */
export function agentStateOf({ agent, runs = [], now = null }) {
  if (agent?.enabled === false) return 'paused';
  const live = runs.filter((run) => LIVE_RUNS.has(String(run.status)));
  if (!live.length) return 'idle';
  if (live.some((run) => run.status === 'running')) return 'working';
  if (live.some((run) => run.status === 'waiting_human')) return 'waiting_human';
  const at = Date.parse(now ?? new Date().toISOString());
  if (live.some((run) => run.status === 'waiting_event' && Date.parse(run.next_run_at ?? 0) > at)) return 'waiting';
  return 'working';
}

/**
 * Mensajes sin leer PARA EL AGENTE.
 *
 * No es «lo que no ha visto una persona»: se compara el último mensaje del
 * hilo con el último `seq` que el agente procesó. Solo cuenta si el último en
 * escribir fue una persona (lo que el propio agente escribe no es su trabajo).
 */
function unreadForAgent({ ticket, run }) {
  if (!run) return 0;
  const last = Number(ticket?.last_seq ?? 0) || 0;
  const seen = Number(run.state?.lastSeenSeq ?? 0) || 0;
  if (ticket?.last_author_type !== 'user') return 0;
  return Math.max(0, last - seen);
}

function ticketRow({ ticket, run }) {
  return {
    id: ticket.id,
    number: ticket.number ?? null,
    title: ticket.title ?? null,
    type: ticket.type ?? null,
    typeLabel: OPS_TICKET_TYPE_LABELS[ticket.type] ?? ticket.type ?? null,
    status: ticket.status ?? null,
    statusLabel: OPS_TICKET_STATUS_LABELS[ticket.status] ?? ticket.status ?? null,
    priority: ticket.priority ?? null,
    priorityLabel: OPS_PRIORITY_LABELS[ticket.priority] ?? ticket.priority ?? null,
    lastMessageAt: ticket.last_message_at ?? ticket.updated_at ?? ticket.created_at ?? null,
    lastMessagePreview: clean(ticket.last_message_preview, 160),
    requiresAck: ticket.requires_ack === true && !ticket.task?.acknowledged_at,
    unread: unreadForAgent({ ticket, run }),
    runStatus: run?.status ?? null,
    nextRunAt: run?.next_run_at ?? null,
    entityType: ticket.entity_type ?? null,
    entityId: ticket.entity_id ?? null,
  };
}

/* =================================================== EL EQUIPO (entrada) */

/**
 * Directorio del Centro IA.
 *
 * `can` decide los extras (bandeja de aprobaciones, administración), pero el
 * equipo se lista para cualquiera con `tickets.read`: son agentes internos, no
 * datos de clientes.
 */
export async function centroDirectory({ ctx, can }) {
  const at = nowIso(ctx);
  const [agentRows, runRows, ticketRows] = await Promise.all([
    ctx.db.list('ops_agents', { by: 'created_at', order: 'asc', limit: 100 }),
    ctx.db.list('ops_agent_runs', { by: 'created_at', order: 'desc', limit: 400 }),
    ctx.db.list('ops_tickets', { limit: 400 }),
  ]);
  const openTickets = ticketRows.filter((ticket) => !OPS_FINAL_STATUSES.includes(String(ticket.status)));

  const agents = agentRows.map((agent) => {
    const mine = runRows.filter((run) => run.agent_key === agent.key);
    const live = mine.filter((run) => LIVE_RUNS.has(String(run.status)));
    const assigned = openTickets.filter((ticket) => ticket.assigned_agent_id === agent.key);
    const unread = assigned.reduce((sum, ticket) => {
      const run = mine.find((row) => row.ticket_id === ticket.id);
      return sum + unreadForAgent({ ticket, run });
    }, 0);
    const state = agentStateOf({ agent, runs: mine, now: at });
    return {
      key: agent.key,
      name: agent.name ?? agent.key,
      role: clean(agent.role, 120),
      enabled: agent.enabled !== false,
      state,
      stateLabel: AGENT_STATE_LABELS[state] ?? state,
      planner: agent.config?.planner === 'llm' ? 'llm' : 'deterministic',
      workMode: agent.config?.workMode ?? null,
      ticketTypes: agent.ticket_types ?? [],
      toolCount: (agent.tools ?? []).length,
      responsibilities: Array.isArray(agent.responsibilities) ? agent.responsibilities.slice(0, 6) : [],
      assigned: assigned.length,
      pending: live.length,
      unread,
      lastActivityAt: mine[0]?.updated_at ?? null,
    };
  });

  const pendingApprovals = can('tickets.close')
    ? (await ctx.db.list('ops_agent_approvals', { by: 'created_at', order: 'desc', limit: 200 })).filter(
        (row) => row.status === 'pending',
      ).length
    : 0;

  return {
    ok: true,
    at,
    agents,
    totals: {
      agents: agents.length,
      active: agents.filter((agent) => agent.enabled).length,
      working: agents.filter((agent) => agent.state === 'working').length,
      pending: agents.reduce((sum, agent) => sum + agent.pending, 0),
      unread: agents.reduce((sum, agent) => sum + agent.unread, 0),
      assignedTickets: agents.reduce((sum, agent) => sum + agent.assigned, 0),
      pendingApprovals,
    },
    canAdmin: can('admin.full'),
    canApprove: can('tickets.close'),
    /* ¿Está dado de alta el Agente de Seguimiento? (el alta la pide una persona) */
    workAgent: {
      key: 'followup_agent',
      ready: agents.some((agent) => agent.key === 'followup_agent'),
    },
  };
}

/* ================================================== LA OFICINA (detalle) */

/**
 * Oficina de un agente.
 *
 * Devuelve `{ok:false, error:'agent_not_found'}` si la clave no existe: la
 * pantalla no puede inventarse un agente.
 */
export async function agentOffice({ ctx, can, key }) {
  const agent = await ctx.db.findBy('ops_agents', 'key', clean(key, 80) ?? '');
  if (!agent) return { ok: false, error: 'agent_not_found' };

  const at = nowIso(ctx);
  const [runRows, ticketRows, stepRows, delegations] = await Promise.all([
    ctx.db.list('ops_agent_runs', { where: { agent_key: agent.key }, limit: 300 }),
    ctx.db.list('ops_tickets', { limit: 400 }),
    ctx.db.list('ops_agent_steps', { by: 'created_at', order: 'desc', limit: 200 }),
    delegationsForAgent({ ctx, agentKey: agent.key }),
  ]);

  const live = runRows.filter((run) => LIVE_RUNS.has(String(run.status)));
  const byTicket = new Map(ticketRows.map((ticket) => [ticket.id, ticket]));
  const runOfTicket = new Map();
  for (const run of runRows) {
    if (!runOfTicket.has(run.ticket_id)) runOfTicket.set(run.ticket_id, run);
  }

  /* Tickets asignados al agente que siguen abiertos. */
  const assigned = ticketRows
    .filter((ticket) => ticket.assigned_agent_id === agent.key)
    .filter((ticket) => !OPS_FINAL_STATUSES.includes(String(ticket.status)))
    .map((ticket) => ticketRow({ ticket, run: runOfTicket.get(ticket.id) }))
    .sort((a, b) => String(b.lastMessageAt ?? '').localeCompare(String(a.lastMessageAt ?? '')));

  /* Trabajo pendiente = runs vivos, con su ticket resuelto. */
  const pending = live
    .map((run) => {
      const ticket = byTicket.get(run.ticket_id);
      return {
        runId: run.id,
        ticketId: run.ticket_id,
        ticketNumber: ticket?.number ?? null,
        title: ticket?.title ?? null,
        status: run.status,
        step: Number(run.step ?? 0) || 0,
        attempt: Number(run.attempt ?? 0) || 0,
        nextRunAt: run.next_run_at ?? null,
        lastError: run.last_error ?? null,
      };
    })
    .sort((a, b) => String(a.nextRunAt ?? '').localeCompare(String(b.nextRunAt ?? '')));

  /* Actividad: los pasos de SUS runs, con el número de ticket. */
  const myRuns = new Set(runRows.map((run) => run.id));
  const activity = stepRows
    .filter((step) => myRuns.has(step.run_id))
    .slice(0, 18)
    .map((step) => {
      const run = runRows.find((row) => row.id === step.run_id);
      const ticket = run ? byTicket.get(run.ticket_id) : null;
      return {
        at: step.created_at ?? null,
        kind: step.kind ?? null,
        status: step.status ?? null,
        summary: clean(step.summary, 200),
        ticketId: run?.ticket_id ?? null,
        ticketNumber: ticket?.number ?? null,
        planner: step.data?.plan?.planner ?? null,
      };
    });

  const tools = (agent.tools ?? []).map((name) => toolSpec(name)).filter(Boolean);
  const state = agentStateOf({ agent, runs: runRows, now: at });
  const liveDelegations = delegations.filter((row) => ['pending', 'accepted'].includes(row.status));
  /*
   * AGENTE DE SEGUIMIENTO: su oficina no son tickets, sino seguimientos y
   * mensajes programados. Se lee con el MISMO filtro de acceso del usuario.
   */
  const work = agent.config?.workMode === 'followups' ? await workSnapshot({ ctx, can }) : null;

  /* Avisos: solo hechos comprobables. */
  const alerts = [];
  if (agent.enabled === false) {
    alerts.push({ tone: 'warn', text: 'Agente desactivado: no recibe trabajo nuevo.' });
  }
  const failed = runRows.filter((run) => run.status === 'failed');
  if (failed.length) {
    alerts.push({ tone: 'danger', text: `${failed.length} ejecución(es) fallida(s) esperando revisión.` });
  }
  const retrying = live.filter((run) => run.last_error?.retryable === true);
  if (retrying.length) {
    alerts.push({ tone: 'warn', text: `${retrying.length} ejecución(es) reintentando tras un error.` });
  }
  if (agent.config?.planner !== 'llm') {
    alerts.push({ tone: 'info', text: 'Planificador determinista: este agente no usa modelo de lenguaje.' });
  }
  const staleDelegations = liveDelegations.filter(
    (row) => Date.parse(row.requestedAt ?? 0) < Date.parse(at) - 12 * 60 * 60 * 1000,
  );
  if (staleDelegations.length) {
    alerts.push({ tone: 'warn', text: `${staleDelegations.length} colaboración(es) sin respuesta hace más de 12 h.` });
  }

  return {
    ok: true,
    at,
    agent: {
      key: agent.key,
      name: agent.name ?? agent.key,
      role: clean(agent.role, 120),
      enabled: agent.enabled !== false,
      version: Number(agent.version ?? 1) || 1,
      state,
      stateLabel: AGENT_STATE_LABELS[state] ?? state,
      planner: agent.config?.planner === 'llm' ? 'llm' : 'deterministic',
      ticketTypes: agent.ticket_types ?? [],
      permissions: agent.permissions ?? [],
      responsibilities: Array.isArray(agent.responsibilities) ? agent.responsibilities.slice(0, 6) : [],
      config: {
        maxMessagesPerRun: Number(agent.config?.maxMessagesPerRun ?? 0) || null,
        followUpMinutes: Number(agent.config?.followUpMinutes ?? 0) || null,
        autoEnroll: agent.config?.autoEnroll === true,
        collaboration: agent.config?.collaboration !== false,
      },
      tools,
    },
    assigned,
    pending,
    activity,
    delegations: delegations.slice(0, 12),
    alerts,
    work,
    stats: {
      assigned: assigned.length,
      pending: pending.length,
      unread: assigned.reduce((sum, row) => sum + row.unread, 0),
      tools: tools.length,
      delegations: liveDelegations.length,
      failed: failed.length,
      ...(work
        ? {
            followupsToday: work.followups.counts.today,
            followupsOverdue: work.followups.counts.overdue,
            scheduledPending: work.scheduled.pending,
            scheduledFailed: work.scheduled.failed,
            proposals: work.proposals.length,
          }
        : {}),
    },
    canAdmin: can('admin.full'),
  };
}
