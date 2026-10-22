/**
 * CENTRO DE OPERACIONES — AGENTES (Etapa D).
 *
 * QUÉ ES
 * El marco universal para que agentes autorizados trabajen en tickets internos:
 * registro de agentes, ejecución DURABLE (sobrevive a reinicios), catálogo de
 * herramientas con permisos, y aprobación humana para lo irreversible.
 *
 * CÓMO FUNCIONA (en una frase)
 * Un evento del ticket marca trabajo pendiente; el scheduler toma el run con un
 * *lease* en base de datos, ejecuta UN paso, lo registra y lo suelta. Si el paso
 * necesita una persona, el run queda esperando y no hay forma de saltárselo.
 *
 * REGLAS DURAS (ver `docs/OPS-CENTER-ETAPA-D-CONTRATO.md`)
 *   - El agente NO recibe `ctx.db`: solo las herramientas del catálogo.
 *   - Los argumentos se validan contra el esquema antes de ejecutar.
 *   - `high_impact` no se ejecuta nunca sin una aprobación con esos parámetros.
 *   - Cada efecto tiene clave de idempotencia: repetir no duplica.
 *   - El planificador es DETERMINISTA (sin proveedor externo). El punto donde
 *     entraría un LLM está aislado en `planStep` y no cambia el resto.
 */

import { randomBytes } from 'node:crypto';

import {
  addParticipant,
  participantIdsOf,
  projectTicket,
  publishTicketEvent,
  taskAction,
  updateTicket,
  resolveTicket,
  recordEvent,
} from './tickets.mjs';
import { postMessage } from './messages.mjs';
import { notifyAckRequired, notifyApprovalRequested, ticketRecipients } from './notify.mjs';
import { AGENT_PERMISSIONS, OPS_TOOLS, assignableTools, toolOf, timeoutOf, validateArgs } from './tools.mjs';
import { planWithLlm } from './llm.mjs';
import { listCollaborators, markAccepted, requestHelp, settleDelegationOfRun } from './collaboration.mjs';

/** Estados de un run. `succeeded/failed/cancelled` son finales. */
export const AGENT_RUN_STATUSES = Object.freeze([
  'pending',
  'running',
  'waiting_human',
  'waiting_event',
  'succeeded',
  'failed',
  'cancelled',
]);
export const FINAL_RUN_STATUSES = Object.freeze(['succeeded', 'failed', 'cancelled']);

/** Estados de una aprobación. */
export const APPROVAL_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'expired', 'consumed']);

const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;
const STEP_TIMEOUT_MS = 20_000;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGES_PER_RUN = 6;
const MAX_RUNS_PER_TICK = 5;

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

function addMinutes(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

/** Identidad del agente como actor del sistema (nunca es un usuario del CRM). */
export function agentActor(agent) {
  return {
    id: `agent:${agent.key}`,
    role: 'AGENT_AI',
    display_name: agent.name ?? agent.key,
    actor_type: 'AGENT',
  };
}

/** Permisos efectivos del agente (derivados de sus herramientas en el registro). */
export function agentCan(agent) {
  const list = Array.isArray(agent?.permissions) ? agent.permissions : [];
  return (permission) => list.includes(permission);
}

/* ============================================================ REGISTRO */

/** Lista de agentes con su versión y estado. */
export async function listAgents({ ctx }) {
  const rows = await ctx.db.list('ops_agents', { by: 'created_at', order: 'asc', limit: 100 });
  const runs = await ctx.db.list('ops_agent_runs', { by: 'created_at', order: 'desc', limit: 300 });
  return rows.map((agent) => {
    const suyos = runs.filter((run) => run.agent_key === agent.key);
    return {
      id: agent.id,
      key: agent.key,
      name: agent.name,
      role: agent.role ?? null,
      enabled: agent.enabled !== false,
      kind: agent.kind ?? 'internal',
      version: Number(agent.version ?? 1) || 1,
      tools: agent.tools ?? [],
      permissions: agent.permissions ?? [],
      ticketTypes: agent.ticket_types ?? [],
      config: agent.config ?? {},
      responsibilities: Array.isArray(agent.responsibilities) ? agent.responsibilities : [],
      planner: agent.config?.planner === 'llm' ? 'llm' : 'deterministic',
      collaboration: agent.config?.collaboration !== false,
      workMode: agent.config?.workMode ?? null,
      activeRuns: suyos.filter((run) => !FINAL_RUN_STATUSES.includes(run.status)).length,
      lastRunAt: suyos[0]?.updated_at ?? null,
      updatedAt: agent.updated_at ?? null,
    };
  });
}

export async function agentByKey(ctx, key) {
  const value = clean(key, 80);
  if (!value) return null;
  return ctx.db.findBy('ops_agents', 'key', value);
}

/**
 * Crea o actualiza un agente.
 *
 * Rechaza herramientas inexistentes, desactivadas o prohibidas, y exige que
 * todo permiso del agente esté en la lista blanca (`AGENT_PERMISSIONS`).
 */
export async function saveAgent({ ctx, actor, input = {} }) {
  const key = clean(input.key, 80);
  const name = clean(input.name, 120);
  if (!key || !/^[a-z0-9_]{3,80}$/.test(key)) {
    return { ok: false, status: 422, error: 'invalid_key', message: 'La clave del agente debe ser minúsculas y guiones bajos.' };
  }
  if (!name) return { ok: false, status: 422, error: 'invalid_name', message: 'Ponle un nombre al agente.' };

  const requested = Array.isArray(input.tools) ? input.tools : [];
  const tools = [];
  for (const raw of requested) {
    const tool = toolOf(raw);
    if (!tool) return { ok: false, status: 422, error: 'unknown_tool', message: `La herramienta «${raw}» no existe.` };
    if (tool.effect === 'forbidden') {
      return { ok: false, status: 422, error: 'tool_forbidden', message: `«${raw}» no es una capacidad del sistema.` };
    }
    if (!tool.enabled) {
      return {
        ok: false,
        status: 422,
        error: 'tool_disabled',
        message: `«${raw}» está registrada pero desactivada: no se puede asignar todavía.`,
      };
    }
    tools.push(raw);
  }
  const unique = [...new Set(tools)];
  /* Los permisos se DERIVAN de las herramientas: no se pueden inventar. */
  const permissions = [
    ...new Set(unique.map((name) => toolOf(name)?.permission).filter(Boolean)),
  ];
  const illegal = permissions.filter((permission) => !AGENT_PERMISSIONS.includes(permission));
  if (illegal.length) {
    return {
      ok: false,
      status: 422,
      error: 'agent_permission_denied',
      message: `Un agente no puede tener: ${illegal.join(', ')}`,
    };
  }

  const ticketTypes = Array.isArray(input.ticketTypes) && input.ticketTypes.length
    ? [...new Set(input.ticketTypes.map((type) => clean(type, 30)).filter(Boolean))]
    : ['delivery'];

  const existing = await agentByKey(ctx, key);
  /*
   * RESPONSABILIDADES (Fase 5): texto para las personas, no lógica. Se recortan
   * a seis y no pueden venir del navegador sin control.
   */
  const responsibilities = Array.isArray(input.responsibilities)
    ? [...new Set(input.responsibilities.map((item) => clean(item, 120)).filter(Boolean))].slice(0, 6)
    : (Array.isArray(existing?.responsibilities) ? existing.responsibilities : []);
  const at = nowIso(ctx);
  const doc = {
    key,
    name,
    role: clean(input.role, 80),
    kind: 'internal',
    enabled: input.enabled === false ? false : true,
    tools: unique,
    permissions,
    ticket_types: ticketTypes,
    responsibilities,
    config: {
      maxMessagesPerRun: Number(input.config?.maxMessagesPerRun) > 0 ? Number(input.config.maxMessagesPerRun) : MAX_MESSAGES_PER_RUN,
      followUpMinutes: Number(input.config?.followUpMinutes) > 0 ? Number(input.config.followUpMinutes) : 30,
      autoEnroll: input.config?.autoEnroll === true,
      /*
       * Etapa E: quién decide el CONTENIDO de los mensajes. `deterministic`
       * (por defecto) = la pauta fija de siempre; `llm` = el modelo, con la
       * pauta como red de seguridad si falla.
       */
      planner: input.config?.planner === 'llm' ? 'llm' : 'deterministic',
      /* Puede negarse a recibir peticiones de ayuda de otros agentes. */
      collaboration: input.config?.collaboration === false ? false : true,
      /*
       * MODO DE TRABAJO: `followups` = el agente de seguimiento (su oficina son
       * seguimientos y mensajes programados, no tickets). Cualquier otro valor
       * se guarda como `null` (agente de tickets).
       */
      workMode: input.config?.workMode === 'followups' ? 'followups' : null,
    },
    updated_at: at,
  };

  if (!existing) {
    const created = {
      id: newId('agn'),
      ...doc,
      version: 1,
      created_at: at,
      created_by_user_id: actor?.id ?? null,
    };
    const result = await ctx.db.insert('ops_agents', created);
    if (result?.duplicate) {
      return { ok: false, status: 409, error: 'agent_exists', message: 'Ya existe un agente con esa clave.' };
    }
    await ctx.audit?.record?.({
      entity: 'agent',
      entityId: created.id,
      action: 'agent_created',
      actor: actor?.display_name ?? null,
      summary: `${name} (${key}) v1`,
      data: { tools: unique, ticket_types: ticketTypes },
    });
    return { ok: true, status: 201, agent: created };
  }

  const updated = await ctx.db.update('ops_agents', existing.id, {
    ...doc,
    version: (Number(existing.version ?? 1) || 1) + 1,
  });
  await ctx.audit?.record?.({
    entity: 'agent',
    entityId: existing.id,
    action: 'agent_updated',
    actor: actor?.display_name ?? null,
    summary: `${name} (${key}) v${updated.version}`,
    data: { tools: unique, enabled: updated.enabled },
  });
  return { ok: true, status: 200, agent: updated };
}

/* ======================================================= EJECUCIÓN */

/** Crea (o despierta) el run de este agente para este ticket. */
export async function ensureRunForEvent({ ctx, ticket, agent, event = 'ticket', workflow: workflowKey = null, state: seed = null }) {
  if (!ticket?.id || !agent?.id) return null;
  const at = nowIso(ctx);
  const workflow = clean(workflowKey, 40) ?? clean(agent.config?.workflowKey, 40) ?? 'assist';
  /* Estado con el que nace (o se completa) el run: p. ej. la colaboración. */
  const extra = seed && typeof seed === 'object' ? seed : {};
  const rows = await ctx.db.list('ops_agent_runs', { where: { ticket_id: ticket.id }, limit: 200 });
  const mine = rows.filter((run) => run.agent_key === agent.key && run.workflow_key === workflow);
  const active = mine.find((run) => !FINAL_RUN_STATUSES.includes(run.status));
  if (active) {
    /*
     * El run ya existe: un evento relevante lo pone «para ahora». No se ejecuta
     * nada aquí (eso lo hace el scheduler); solo se marca el trabajo.
     */
    if (active.status === 'waiting_human') {
      /* Esperando una persona: se anota el evento pero NO se reanuda solo. */
      await ctx.db.update('ops_agent_runs', active.id, {
        state: { ...(active.state ?? {}), ...extra, pendingEvent: event },
        updated_at: at,
      });
      return active;
    }
    return ctx.db.update('ops_agent_runs', active.id, {
      status: active.status === 'running' ? 'running' : 'pending',
      next_run_at: at,
      state: { ...(active.state ?? {}), ...extra, pendingEvent: event, lastEventAt: at },
      updated_at: at,
    });
  }
  const created = {
    id: newId('run'),
    agent_key: agent.key,
    agent_version: Number(agent.version ?? 1) || 1,
    ticket_id: ticket.id,
    workflow_key: workflow,
    status: 'pending',
    attempt: 0,
    step: 0,
    /* Estado del plan: lo único que hace que un reinicio no repita trabajo. */
    state: { ...extra, pendingEvent: event, lastEventAt: at },
    next_run_at: at,
    lease_owner: null,
    lease_until: null,
    last_error: null,
    idempotency_key: `run:${ticket.id}:${agent.key}:${workflow}:${mine.length + 1}`,
    created_at: at,
    updated_at: at,
  };
  const result = await ctx.db.insert('ops_agent_runs', created);
  return result?.duplicate ? ctx.db.findBy('ops_agent_runs', 'idempotency_key', created.idempotency_key) : created;
}

/** Evento del ticket → despierta a los agentes autorizados para ese tipo. */
export async function onTicketEvent({ ctx, type, ticket }) {
  if (!ticket?.id) return [];
  const interesting = new Set([
    'ticket.created',
    'ticket.assigned',
    'message.created',
    'task.acknowledged',
    'task.completed',
    'ticket.escalated',
  ]);
  if (!interesting.has(String(type))) return [];
  const agents = await ctx.db.list('ops_agents', { limit: 100 });
  const activeAgents = agents.filter((agent) => agent.enabled !== false);
  const assignedKey = String(ticket.assigned_agent_id ?? '');
  const woken = [];
  for (const agent of activeAgents) {
    const assigned = assignedKey === agent.key;
    const auto = agent.config?.autoEnroll === true && (agent.ticket_types ?? []).includes(ticket.type);
    if (!assigned && !auto) continue;
    woken.push(await ensureRunForEvent({ ctx, ticket, agent, event: type }));
  }
  return woken;
}

/** Devuelve a la cola los runs cuyo lease venció (caída o reinicio a mitad). */
export async function recoverStaleRuns({ ctx }) {
  const at = nowIso(ctx);
  const runs = await ctx.db.list('ops_agent_runs', { by: 'created_at', order: 'desc', limit: 300 });
  let recovered = 0;
  for (const run of runs) {
    if (run.status !== 'running') continue;
    if (!run.lease_until || Date.parse(run.lease_until) > Date.parse(at)) continue;
    const attempt = (Number(run.attempt ?? 0) || 0) + 1;
    await ctx.db.update('ops_agent_runs', run.id, {
      status: attempt >= MAX_ATTEMPTS ? 'failed' : 'pending',
      attempt,
      lease_owner: null,
      lease_until: null,
      last_error: attempt >= MAX_ATTEMPTS ? { code: 'lease_expired', message: 'Se agotaron los intentos', retryable: false } : run.last_error ?? null,
      next_run_at: at,
      updated_at: at,
    });
    recovered += 1;
  }
  /* Aprobaciones vencidas: dejan de poder aprobarse. */
  const approvals = await ctx.db.list('ops_agent_approvals', { by: 'created_at', order: 'desc', limit: 200 });
  for (const approval of approvals) {
    if (approval.status !== 'pending') continue;
    if (Date.parse(approval.expires_at ?? 0) > Date.parse(at)) continue;
    await ctx.db.update('ops_agent_approvals', approval.id, { status: 'expired', updated_at: at });
  }
  return { recovered };
}

/** Toma un run con lease. Devuelve el run o null si otro lo tiene. */
async function claimRun({ ctx, runId, owner }) {
  const at = nowIso(ctx);
  const current = await ctx.db.get('ops_agent_runs', runId);
  if (!current) return null;
  if (!['pending', 'waiting_event'].includes(current.status)) return null;
  if (current.lease_owner && current.lease_owner !== owner && Date.parse(current.lease_until ?? 0) > Date.parse(at)) {
    return null;
  }
  const updated = await ctx.db.update('ops_agent_runs', runId, {
    status: 'running',
    lease_owner: owner,
    lease_until: new Date(Date.parse(at) + LEASE_MS).toISOString(),
    updated_at: at,
  });
  /* Relectura: si otro lo tomó en el medio, se suelta. */
  const check = await ctx.db.get('ops_agent_runs', runId);
  if (check?.lease_owner !== owner) return null;
  return updated;
}

async function releaseRun({ ctx, runId, patch = {} }) {
  const at = nowIso(ctx);
  return ctx.db.update('ops_agent_runs', runId, {
    ...patch,
    lease_owner: null,
    lease_until: null,
    updated_at: at,
  });
}

/** Registra un paso (idempotente por `step_key`). */
async function recordStep({ ctx, run, kind, status, summary = null, data = null, plan = null }) {
  const step = (Number(run.step ?? 0) || 0) + 1;
  const base = data && typeof data === 'object' ? data : data === null || data === undefined ? {} : { value: data };
  const doc = {
    id: newId('step'),
    run_id: run.id,
    step,
    step_key: `run:${run.id}:${step}`,
    kind,
    status,
    summary: clean(summary, 240),
    /* Junto al resultado va SIEMPRE de dónde salió el paso (modelo o pauta). */
    data: { ...base, ...(plan ? { plan } : {}) },
    created_at: nowIso(ctx),
  };
  const result = await ctx.db.insert('ops_agent_steps', doc);
  return result?.duplicate ? null : doc;
}

/* =============== CONTEXTO AUTORIZADO Y DECISIÓN (determinista o modelo) ==== */

/**
 * Lo único que se le puede enseñar al modelo.
 *
 * Sale de la misma base que ve una persona del equipo: participantes, los diez
 * mensajes más recientes EN ORDEN y el estado del pedido **si lo dio la
 * herramienta**. Nada de teléfonos, direcciones ni importes.
 */
async function buildLlmContext({ ctx, ticket, run }) {
  const participants = await ctx.db.list('ops_ticket_participants', {
    where: { ticket_id: ticket.id },
    limit: 30,
  });
  const recent = await ctx.db.list('ops_ticket_messages', {
    where: { ticket_id: ticket.id },
    by: 'seq_key',
    order: 'desc',
    limit: 10,
  });
  const meta = ticket.metadata && typeof ticket.metadata === 'object' ? ticket.metadata : {};
  return {
    /* `by seq_key desc` trae lo último primero; el modelo lo lee cronológico. */
    messages: recent.slice().reverse(),
    context: {
      participants: participants.map((row) => ({
        nombre: row.participant_name ?? null,
        rol: row.participant_type === 'agent' ? 'asistente' : row.role ?? null,
      })),
      orderStatus: run?.state?.orderStatus ?? null,
      orderNumber: meta.order_number ?? null,
    },
  };
}

/**
 * Decide el siguiente paso.
 *
 * La pauta determinista SIEMPRE se calcula primero: es el plan por defecto y
 * el que se usa si el modelo no está disponible, tarda, responde basura o pide
 * algo que no puede hacer. El modelo solo puede cambiar **el contenido** de un
 * mensaje o **cuándo** volver a mirar; nunca la lectura de contexto, el acuse,
 * el escalado ni la aprobación.
 */
async function decideNextStep({ ctx, deps, agent, ticket, run, now, collaborators = [] }) {
  const deterministic = planStep({ ticket, run, agent, now, collaborators });
  const plan = typeof deps?.llm === 'function' ? deps.llm : null;
  if (!plan || agent?.config?.planner !== 'llm') return { decision: deterministic, source: 'deterministic' };

  const contentStep =
    (deterministic.type === 'tool' && deterministic.tool === 'ticket.post_message') ||
    deterministic.type === 'wait';
  if (!contentStep) return { decision: deterministic, source: 'deterministic' };

  /* «Escribir» solo cuando la pauta dice que toca escribir. */
  const mode = deterministic.type === 'wait' ? 'idle' : 'reply';
  const { messages, context } = await buildLlmContext({ ctx, ticket, run });
  /* Los compañeros disponibles viajan como DATO: el modelo no los inventa. */
  const contextWithPeers = { ...context, collaborators };
  const result = await planWithLlm({ plan, agent, ticket, run, context: contextWithPeers, messages, now, mode });
  if (!result.ok) {
    /* Se deja constancia del motivo: un proveedor caído no puede ser invisible. */
    return { decision: deterministic, source: 'deterministic_fallback', error: result.error, meta: result.meta };
  }
  return { decision: result.decision, source: 'llm', meta: result.meta };
}

/* =================================================== PLANIFICADOR */

/**
 * Decide el SIGUIENTE paso. Determinista y sin red: es el único punto donde se
 * enchufaría un modelo (recibiendo el mismo `{ticket, run, agent}` y devolviendo
 * una de estas mismas decisiones). No puede devolver una herramienta fuera del
 * catálogo del agente: eso se valida al ejecutar.
 */
export function planStep({ ticket, run, agent, now = null, collaborators = [] }) {
  const state = run.state ?? {};
  const nowIsoValue = now ?? new Date().toISOString();
  const maxMessages = Number(agent?.config?.maxMessagesPerRun ?? MAX_MESSAGES_PER_RUN);
  const sent = Number(state.messagesSent ?? 0) || 0;
  /*
   * Solo se planifica lo que el agente TIENE. Sin esto, un agente de solo
   * lectura haría que el plan pidiera un mensaje, la ejecución lo rechazara
   * (`tool_not_allowed`) y el run se quedara reintentando cinco veces.
   */
  const has = (name) => (agent?.tools ?? []).includes(name);

  if (!state.contextLoaded) {
    return { type: 'tool', tool: 'ticket.get_context', args: { ticketId: ticket.id }, note: 'cargar contexto' };
  }
  /*
   * COLABORACIÓN RECIBIDA: este run nace porque otro agente pidió ayuda.
   * No saluda como si fuera suyo el ticket: deja su lectura y cierra. Va antes
   * que cualquier otra regla para no pisar el trabajo de quien pidió ayuda.
   */
  if (state.collabFrom) {
    if (!state.collabAnswered && sent < maxMessages && has('ticket.post_message')) {
      return {
        type: 'tool',
        tool: 'ticket.post_message',
        args: {
          body: `Reviso lo que me pide ${state.collabFromName ?? state.collabFrom}: «${state.collabQuestion ?? 'necesita una revisión'}». Dejo aquí lo que puedo confirmar con los datos de este ticket.`,
          clientKey: `agent:${run.id}:collab`,
        },
        note: 'responder a la colaboración',
      };
    }
    if (state.collabAnswered && !state.workCompleted && has('ticket.complete_work')) {
      return {
        type: 'tool',
        tool: 'ticket.complete_work',
        args: { note: 'Colaboración atendida' },
        note: 'cerrar la colaboración',
      };
    }
    return { type: 'wait', minutes: Number(agent?.config?.followUpMinutes ?? 30), reason: 'colaboración atendida' };
  }
  /*
   * ESTADO DEL PEDIDO VINCULADO (solo lectura, `orders.read`).
   *
   * Se consulta UNA vez, antes de saludar, para que el primer mensaje diga algo
   * útil en vez de una frase genérica. Si el agente no tiene la herramienta, se
   * salta sin más: el plan no depende de ella.
   */
  if (
    !state.orderChecked &&
    ticket.entity_type === 'order' &&
    ticket.entity_id &&
    has('order.get_status')
  ) {
    return {
      type: 'tool',
      tool: 'order.get_status',
      args: { orderId: ticket.entity_id },
      note: 'estado del pedido',
    };
  }
  if (!state.greeted && sent < maxMessages && has('ticket.post_message')) {
    const orderState = state.orderStatus ? ` Ahora mismo el pedido va por «${state.orderStatus}».` : '';
    return {
      type: 'tool',
      tool: 'ticket.post_message',
      args: {
        body: `Me encargo de este ticket (${ticket.number}).${orderState} Os aviso por aquí de cualquier avance y os pido confirmación cuando toque.`,
        clientKey: `agent:${run.id}:greet`,
      },
      note: 'saludo inicial',
    };
  }
  if (ticket.requires_ack === true && !ticket.task?.acknowledged_at && !state.ackRequested && has('ticket.request_ack')) {
    return {
      type: 'tool',
      tool: 'ticket.request_ack',
      args: { note: 'Confirma el acuse cuando lo veas, por favor.' },
      note: 'pedir acuse',
    };
  }
  /* ¿Hay una respuesta humana nueva después de lo último que procesó? */
  if (!state.closureRequested && sent < maxMessages && state.lastSeenSeq !== undefined && has('ticket.post_message')) {
    const lastSeq = Number(ticket.last_seq ?? 0) || 0;
    if (lastSeq > Number(state.lastSeenSeq ?? 0) && ticket.last_author_type === 'user') {
      return {
        type: 'tool',
        tool: 'ticket.post_message',
        args: {
          body: 'Anotado. Sigo con lo que falta y os confirmo en cuanto esté.',
          clientKey: `agent:${run.id}:reply:${lastSeq}`,
        },
        note: 'responder a la persona',
      };
    }
  }
  if (ticket.task?.completed_at && !state.closureRequested && has('ticket.close')) {
    return {
      type: 'approval',
      tool: 'ticket.close',
      args: { resolution: 'Trabajo completado y verificado por el agente.' },
      justification: `El trabajo del ticket ${ticket.number} está completado; pido cerrarlo.`,
      note: 'pedir cierre (aprobación)',
    };
  }
  const due = Date.parse(String(ticket.due_at ?? ''));
  if (
    Number.isFinite(due) &&
    due < Date.parse(nowIsoValue) &&
    !ticket.task?.acknowledged_at &&
    !state.escalated &&
    !state.closureRequested &&
    has('ticket.escalate')
  ) {
    return {
      type: 'tool',
      tool: 'ticket.escalate',
      args: { reason: 'El plazo venció sin acuse de recibo.' },
      note: 'escalar por plazo',
    };
  }
  /*
   * PEDIR AYUDA A OTRO AGENTE (Fase 6).
   *
   * Solo cuando hay una razón comprobable: el ticket ya se escaló o es urgente,
   * y hay un compañero autorizado para este tipo de ticket. Una sola vez por
   * run: si el servidor la rechaza, no se reintenta en bucle.
   */
  if (
    (state.escalated || ticket.priority === 'urgent') &&
    !state.helpRequested &&
    !state.closureRequested &&
    sent < maxMessages &&
    has('agent.request_help') &&
    collaborators.length
  ) {
    const peer = collaborators[0];
    return {
      type: 'tool',
      tool: 'agent.request_help',
      args: {
        agentKey: peer.key,
        question: `Necesito que revises el pedido de este ticket (${ticket.number}) porque con mis herramientas no puedo confirmarlo.`,
      },
      note: `pedir ayuda a ${peer.name}`,
    };
  }
  return {
    type: 'wait',
    minutes: Number(agent?.config?.followUpMinutes ?? 30),
    reason: state.closureRequested ? 'esperando decisión de cierre' : 'sin trabajo pendiente',
  };
}

/* ================================================= EJECUCIÓN DE HERRAMIENTAS */

/** Ejecuta una herramienta ya validada. Devuelve `{ok, result}` o `{ok:false,error}`. */
async function executeTool({ ctx, deps, agent, ticket, run, name, args, actor, approvalId = null, approveCan = null }) {
  const tool = toolOf(name);
  if (!tool) return { ok: false, error: { code: 'unknown_tool', message: 'Herramienta desconocida', retryable: false } };
  if (tool.effect === 'forbidden') {
    return { ok: false, error: { code: 'tool_forbidden', message: 'Herramienta prohibida', retryable: false } };
  }
  /*
   * SOLO POR APROBACIÓN: las herramientas del Agente de Seguimiento se ejecutan
   * únicamente cuando una persona aprueba la propuesta. Sin `approvalId` no hay
   * forma de ejecutarlas desde un plan, aunque alguien lo intentara.
   */
  if (tool.approvalOnly === true && !approvalId) {
    return {
      ok: false,
      error: { code: 'approval_required', message: 'Esta acción necesita aprobación humana', retryable: false },
    };
  }
  /* Doble comprobación de permiso: la herramienta debe estar en la lista del agente. */
  if (!Array.isArray(agent.tools) || !agent.tools.includes(name)) {
    return { ok: false, error: { code: 'tool_not_allowed', message: 'La herramienta no está asignada a este agente', retryable: false } };
  }
  if (tool.effect !== 'high_impact' && tool.permission && !agentCan(agent)(tool.permission)) {
    return { ok: false, error: { code: 'agent_permission_denied', message: `Falta ${tool.permission}`, retryable: false } };
  }

  const agentUser = actor ?? agentActor(agent);
  /*
   * PERMISOS: los del agente para lo normal; los de la PERSONA que aprobó
   * cuando hay aprobación. Así un agente nunca puede cerrar un ticket por su
   * cuenta, ni siquiera intentándolo por esta vía.
   */
  const can = approvalId && typeof approveCan === 'function' ? approveCan : agentCan(agent);

  /*
   * COLABORACIÓN: se delega en el módulo que conoce las reglas (destinatario
   * activo, tipo de ticket, bucles, profundidad y tope). Aquí solo se comprueba
   * el permiso del agente que pide, como con cualquier otra herramienta.
   */
  if (name === 'agent.request_help') {
    if (!can('tickets.update')) {
      return { ok: false, error: { code: 'agent_permission_denied', message: 'Falta tickets.update', retryable: false } };
    }
    return requestHelp({ ctx, deps, agent, ticket, run, args, ensureRun: ensureRunForEvent });
  }

  if (name === 'ticket.get_context') {
    const view = projectTicket(ticket, { can });
    const participants = await ctx.db.list('ops_ticket_participants', { where: { ticket_id: ticket.id }, limit: 50 });
    const messages = await ctx.db.list('ops_ticket_messages', { where: { ticket_id: ticket.id }, by: 'seq_key', order: 'desc', limit: 10 });
    return {
      ok: true,
      result: {
        ticket: view,
        participants: participants.map((row) => ({ id: row.participant_id, name: row.participant_name ?? null, role: row.role })),
        recentMessages: messages
          .slice()
          .reverse()
          .map((row) => ({ seq: row.seq, author: row.author_type, name: row.author_name, body: String(row.body ?? '').slice(0, 300) })),
      },
    };
  }
  if (name === 'order.get_status') {
    if (!can('orders.read')) {
      return { ok: false, error: { code: 'agent_permission_denied', message: 'Falta orders.read', retryable: false } };
    }
    const row = typeof deps?.findOrder === 'function' ? await deps.findOrder(args.orderId) : null;
    if (!row) return { ok: false, error: { code: 'order_not_found', message: 'El pedido no existe', retryable: false } };
    let order = {};
    try {
      order = JSON.parse(row.order_json ?? row.orderJson ?? '{}') ?? {};
    } catch {
      order = {};
    }
    /* Solo estado operativo: ni importes ni datos personales. */
    return { ok: true, result: { orderId: row.id, number: row.order_number ?? order.order_number ?? null, status: row.status ?? order.status ?? null } };
  }
  if (name === 'ticket.post_message') {
    const posted = await postMessage({
      ctx,
      actor: agentUser,
      can,
      ticketId: ticket.id,
      body: args.body,
      clientKey: args.clientKey ?? `agent:${run.id}:msg:${(Number(run.step ?? 0) || 0) + 1}`,
      deps,
      authorType: 'agent',
    });
    if (!posted.ok) return { ok: false, error: { code: posted.error ?? 'message_failed', message: posted.message ?? '', retryable: false } };
    return { ok: true, result: { seq: posted.message?.seq ?? null, messageId: posted.message?.id ?? null } };
  }
  if (name === 'ticket.request_ack') {
    const recipients = await ticketRecipients(ctx, ticket.id, { excludeUserId: agentUser.id });
    const printed = await postMessage({
      ctx,
      actor: agentUser,
      can,
      ticketId: ticket.id,
      body: args.note ?? 'Necesito que alguien confirme el acuse de este ticket.',
      clientKey: `agent:${run.id}:ackreq`,
      deps,
      authorType: 'agent',
    });
    await notifyAckRequired({ ctx, deps, ticket, recipients });
    return { ok: true, result: { asked: recipients.length, seq: printed?.message?.seq ?? null } };
  }
  if (name === 'ticket.set_follow_up') {
    const result = await updateTicket({ ctx, actor: agentUser, can, id: ticket.id, patch: { followUpAt: args.at }, deps });
    if (!result.ok) return { ok: false, error: { code: result.error, message: result.message, retryable: false } };
    return { ok: true, result: { followUpAt: args.at } };
  }
  if (name === 'ticket.escalate') {
    const result = await taskAction({ ctx, actor: agentUser, can, id: ticket.id, action: 'escalate', note: args.reason, deps });
    if (!result.ok) return { ok: false, error: { code: result.error, message: result.message, retryable: false } };
    return { ok: true, result: { escalated: true } };
  }
  if (name === 'ticket.complete_work') {
    const result = await taskAction({ ctx, actor: agentUser, can, id: ticket.id, action: 'complete', note: args.note ?? 'Completado por el agente', deps });
    if (!result.ok) return { ok: false, error: { code: result.error, message: result.message, retryable: false } };
    return { ok: true, result: { completed: true } };
  }
  if (name === 'ticket.close') {
    /*
     * SOLO con aprobación: `approvalId` es obligatorio y lo pone el aprobador
     * humano, no el planificador. El `can` es el del HUMANO que aprobó.
     */
    if (!approvalId) {
      return { ok: false, error: { code: 'approval_required', message: 'Cerrar exige aprobación humana', retryable: false } };
    }
    const result = await resolveTicket({ ctx, actor: agentUser, can, id: ticket.id, resolution: args.resolution, deps });
    if (!result.ok) return { ok: false, error: { code: result.error, message: result.message, retryable: false } };
    return { ok: true, result: { closed: true, status: result.ticket?.status ?? null } };
  }
  return { ok: false, error: { code: 'tool_not_implemented', message: 'Herramienta sin implementación', retryable: false } };
}

/** Invoca una herramienta con idempotencia y registro (una por paso y nombre). */
async function invokeTool({ ctx, deps, agent, ticket, run, name, args, actor = null, approvalId = null, approveCan = null }) {
  const step = (Number(run.step ?? 0) || 0) + 1;
  const key = approvalId
    ? `tool:approval:${approvalId}`
    : `tool:${run.id}:${step}:${name}`;
  const existing = await ctx.db.findBy('ops_tool_calls', 'idempotency_key', key);
  if (existing) return { ok: existing.status === 'ok', result: existing.result ?? null, duplicate: true, error: existing.error ?? null };

  const validation = validateArgs(name, args ?? {});
  if (!validation.ok) {
    const error = { code: validation.error, message: 'Argumentos inválidos', retryable: false };
    await ctx.db.insert('ops_tool_calls', {
      id: newId('call'),
      run_id: run.id,
      ticket_id: ticket.id,
      tool: name,
      status: 'error',
      approval_id: approvalId,
      idempotency_key: key,
      error,
      created_at: nowIso(ctx),
    });
    return { ok: false, error };
  }

  let outcome;
  try {
    outcome = await withTimeout(
      executeTool({ ctx, deps, agent, ticket, run, name, args: validation.args, actor, approvalId, approveCan }),
      /* Cada herramienta declara su plazo; ninguna puede pasar del global. */
      timeoutOf(name),
    );
  } catch (error) {
    outcome = { ok: false, error: { code: 'tool_timeout', message: error?.message ?? 'tiempo agotado', retryable: true } };
  }

  await ctx.db.insert('ops_tool_calls', {
    id: newId('call'),
    run_id: run.id,
    ticket_id: ticket.id,
    tool: name,
    status: outcome.ok ? 'ok' : 'error',
    approval_id: approvalId,
    idempotency_key: key,
    result: outcome.ok ? outcome.result ?? null : null,
    error: outcome.ok ? null : outcome.error ?? null,
    created_at: nowIso(ctx),
  });
  return outcome;
}

/** Plazo para una promesa (un proveedor lento no puede colgar la vuelta). */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout tras ${ms} ms`)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/* ===================================================== APROBACIONES */

/** Crea la solicitud de aprobación y deja el run esperando a una persona. */
async function requestApproval({ ctx, deps, agent, ticket, run, tool, args, justification }) {
  const at = nowIso(ctx);
  const key = `approval:${run.id}:${tool}:${Number(run.step ?? 0) + 1}`;
  const existing = await ctx.db.findBy('ops_agent_approvals', 'idempotency_key', key);
  if (existing) return existing;
  const spec = toolOf(tool);
  const approval = {
    id: newId('apv'),
    ticket_id: ticket.id,
    run_id: run.id,
    agent_key: agent.key,
    agent_name: agent.name,
    tool,
    params: args ?? {},
    justification: clean(justification, 400),
    required_permission: spec?.approverPermission ?? 'tickets.close',
    status: 'pending',
    requested_at: at,
    expires_at: new Date(Date.parse(at) + APPROVAL_TTL_MS).toISOString(),
    decided_by_user_id: null,
    decided_by_name: null,
    decided_at: null,
    decision_note: null,
    executed_at: null,
    execution_result: null,
    idempotency_key: key,
    created_at: at,
    updated_at: at,
  };
  await ctx.db.insert('ops_agent_approvals', approval);

  /*
   * En el HILO va una frase legible: los parámetros ya están en la tarjeta de
   * aprobación, así que repetir el JSON aquí solo aña­ade ruido.
   */
  const agentUser = agentActor(agent);
  await postMessage({
    ctx,
    actor: agentUser,
    can: agentCan(agent),
    ticketId: ticket.id,
    body: `Necesito permiso para «${tool}». ${clean(justification, 200) ?? ''}`.trim(),
    clientKey: `agent:${run.id}:approval:${tool}`,
    deps,
    authorType: 'agent',
    kind: 'approval_request',
    meta: { approvalId: approval.id, tool, params: args ?? {}, requiredPermission: approval.required_permission },
  });
  await recordEvent(ctx, {
    ticketId: ticket.id,
    kind: 'approval_requested',
    actor: agentUser,
    summary: `Aprobación pedida: ${tool}`,
    data: { approval_id: approval.id, tool },
    idempotencyKey: `opapv:requested:${approval.id}`,
  });
  await ctx.audit?.record?.(
    {
      entity: 'agent',
      entityId: agent.key,
      action: 'agent_approval_requested',
      actor: agent.name,
      summary: `${ticket.number} · ${tool}`,
      data: { approval_id: approval.id, tool, params: args ?? {} },
    },
  );
  /* Y en la campana de quien puede decidir (administración). */
  await notifyApprovalRequested({ ctx, deps, ticket, approval });
  return approval;
}

/**
 * Decide una aprobación (solo una persona con el permiso del aprobador).
 *
 * Aprobar EJECUTA la herramienta una vez, con esos parámetros exactos, y
 * registra el resultado. Rechazar no ejecuta nada.
 */
export async function decideApproval({ ctx, deps, actor, can, approvalId, approve, note = '' }) {
  const id = clean(approvalId, 80);
  if (!id) return { ok: false, status: 422, error: 'approval_required', message: 'Falta la aprobación.' };
  const approval = await ctx.db.get('ops_agent_approvals', id);
  if (!approval) return { ok: false, status: 404, error: 'approval_not_found', message: 'Esa aprobación no existe.' };
  if (approval.status === 'consumed') {
    return { ok: false, status: 409, error: 'approval_consumed', message: 'Esa aprobación ya se ejecutó.' };
  }
  if (approval.status !== 'pending') {
    return { ok: false, status: 409, error: 'approval_closed', message: `La aprobación está ${approval.status}.` };
  }
  const at = nowIso(ctx);
  if (Date.parse(approval.expires_at ?? 0) <= Date.parse(at)) {
    await ctx.db.update('ops_agent_approvals', id, { status: 'expired', updated_at: at });
    return { ok: false, status: 409, error: 'approval_expired', message: 'La aprobación caducó.' };
  }
  if (!can(approval.required_permission)) {
    return { ok: false, status: 403, error: 'forbidden', message: `Hace falta ${approval.required_permission}.` };
  }
  const run = await ctx.db.get('ops_agent_runs', approval.run_id);
  const ticket = await ctx.db.get('ops_tickets', approval.ticket_id);
  const agent = await agentByKey(ctx, approval.agent_key);

  if (!approve) {
    await ctx.db.update('ops_agent_approvals', id, {
      status: 'rejected',
      decided_by_user_id: actor?.id ?? null,
      decided_by_name: clean(actor?.display_name, 120),
      decided_at: at,
      decision_note: clean(note, 300),
      updated_at: at,
    });
    await recordEvent(ctx, {
      ticketId: approval.ticket_id,
      kind: 'approval_rejected',
      actor,
      summary: `Aprobación rechazada: ${approval.tool}`,
      data: { approval_id: id, note: clean(note, 300) },
      idempotencyKey: `opapv:rejected:${id}`,
    });
    if (run && ticket) {
      await ctx.db.update('ops_agent_runs', run.id, {
        status: 'pending',
        next_run_at: at,
        state: { ...(run.state ?? {}), approvalId: null, approvalRejected: true, closureRequested: true },
        updated_at: at,
      });
    }
    await ctx.audit?.record?.({
      entity: 'agent',
      entityId: approval.agent_key,
      action: 'agent_approval_decided',
      actor: actor?.display_name ?? null,
      summary: `${ticket?.number ?? approval.ticket_id} · rechazada ${approval.tool}`,
      data: { approval_id: id, approved: false },
    });
    return { ok: true, status: 200, approval: { ...approval, status: 'rejected' } };
  }

  /* Aprobada: se ejecuta UNA vez, con el permiso y la identidad del humano. */
  if (!run || !ticket || !agent) {
    return { ok: false, status: 409, error: 'approval_orphan', message: 'Falta el run, el ticket o el agente.' };
  }
  const approved = await ctx.db.update('ops_agent_approvals', id, {
    status: 'approved',
    decided_by_user_id: actor?.id ?? null,
    decided_by_name: clean(actor?.display_name, 120),
    decided_at: at,
    decision_note: clean(note, 300),
    updated_at: at,
  });
  const outcome = await invokeTool({
    ctx,
    deps,
    agent,
    ticket,
    run,
    name: approval.tool,
    args: approval.params ?? {},
    /* Quien ejecuta es la PERSONA que aprobó (así lo exige el contrato). */
    actor: { ...actor, actor_type: 'USER' },
    approvalId: id,
    approveCan: can,
  });
  const final = await ctx.db.update('ops_agent_approvals', id, {
    status: outcome.ok ? 'consumed' : 'approved',
    executed_at: nowIso(ctx),
    execution_result: outcome.ok ? outcome.result ?? null : { error: outcome.error ?? null },
    updated_at: nowIso(ctx),
  });
  await recordEvent(ctx, {
    ticketId: approval.ticket_id,
    kind: outcome.ok ? 'approval_executed' : 'approval_failed',
    actor,
    summary: outcome.ok ? `Aprobado y ejecutado: ${approval.tool}` : `Aprobado pero falló: ${approval.tool}`,
    data: { approval_id: id, result: outcome.result ?? null, error: outcome.error ?? null },
    idempotencyKey: `opapv:executed:${id}`,
  });
  await ctx.audit?.record?.({
    entity: 'agent',
    entityId: approval.agent_key,
    action: outcome.ok ? 'agent_approval_executed' : 'agent_approval_failed',
    actor: actor?.display_name ?? null,
    summary: `${ticket.number} · ${approval.tool}`,
    data: { approval_id: id, ok: outcome.ok },
  });
  await ctx.db.update('ops_agent_runs', run.id, {
    status: 'pending',
    next_run_at: nowIso(ctx),
    state: {
      ...(run.state ?? {}),
      approvalId: null,
      closureRequested: true,
      approvalRejected: !outcome.ok,
      closed: Boolean(outcome.ok),
    },
    updated_at: nowIso(ctx),
  });
  return { ok: true, status: 200, approval: final, result: outcome.ok ? outcome.result : null };
}

export async function listApprovals({ ctx, status = 'pending', ticketId = null }) {
  const rows = await ctx.db.list('ops_agent_approvals', { by: 'created_at', order: 'desc', limit: 100 });
  const filtered = rows
    .filter((row) => (status === 'all' ? true : row.status === status))
    .filter((row) => (ticketId ? row.ticket_id === ticketId : true));
  /*
   * El número de ticket se resuelve aquí: en la bandeja global la persona
   * necesita saber DE QUÉ ticket le están pidiendo permiso, no un id interno.
   */
  const tickets = new Map();
  for (const row of filtered) {
    if (tickets.has(row.ticket_id)) continue;
    const ticket = await ctx.db.get('ops_tickets', row.ticket_id);
    tickets.set(row.ticket_id, ticket);
  }
  return filtered.map((row) => ({
    id: row.id,
    ticketId: row.ticket_id,
    ticketNumber: tickets.get(row.ticket_id)?.number ?? null,
    ticketTitle: tickets.get(row.ticket_id)?.title ?? null,
    runId: row.run_id,
    agentKey: row.agent_key,
    agentName: row.agent_name,
    tool: row.tool,
    params: row.params ?? {},
    justification: row.justification ?? null,
    requiredPermission: row.required_permission,
    status: row.status,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    decidedByName: row.decided_by_name ?? null,
    decidedAt: row.decided_at ?? null,
    decisionNote: row.decision_note ?? null,
    executionResult: row.execution_result ?? null,
  }));
}

/* ============================================================ VUELTA */

/**
 * Una vuelta del motor de agentes. La llama el scheduler (nunca el navegador).
 * Ejecuta como máximo un paso por run y unos pocos runs por vuelta.
 */
export async function opsAgentTick({ ctx, deps = {} }) {
  const owner = `ops:${process.pid}:${randomBytes(3).toString('hex')}`;
  await recoverStaleRuns({ ctx });
  const at = nowIso(ctx);
  const runs = await ctx.db.list('ops_agent_runs', { by: 'created_at', order: 'asc', limit: 300 });
  const due = runs.filter(
    (run) =>
      ['pending', 'waiting_event'].includes(run.status) &&
      (!run.next_run_at || Date.parse(run.next_run_at) <= Date.parse(at)),
  );
  let executed = 0;
  const errors = [];

  for (const candidate of due.slice(0, MAX_RUNS_PER_TICK)) {
    const run = await claimRun({ ctx, runId: candidate.id, owner });
    if (!run) continue;
    try {
      const agent = await agentByKey(ctx, run.agent_key);
      const ticket = await ctx.db.get('ops_tickets', run.ticket_id);
      if (!agent || agent.enabled === false) {
        await releaseRun({ ctx, runId: run.id, patch: { status: 'failed', last_error: { code: 'agent_unavailable', retryable: false } } });
        continue;
      }
      if (!ticket) {
        await releaseRun({ ctx, runId: run.id, patch: { status: 'failed', last_error: { code: 'ticket_missing', retryable: false } } });
        continue;
      }
      if (['resolved', 'cancelled'].includes(String(ticket.status))) {
        await releaseRun({ ctx, runId: run.id, patch: { status: 'succeeded', next_run_at: null } });
        continue;
      }

      /*
       * Compañeros a los que se les puede pedir ayuda: se calcula solo si el
       * agente tiene la herramienta y no está ya atendiendo una colaboración.
       * Es la MISMA regla que aplica el servidor al delegar.
       */
      const collaborators =
        (agent.tools ?? []).includes('agent.request_help') && !run.state?.collabFrom
          ? await listCollaborators({ ctx, agent, ticket })
          : [];
      const planning = await decideNextStep({ ctx, deps, agent, ticket, run, now: at, collaborators });
      const decision = planning.decision;
      publishTicketEvent(ctx, {
        type: 'agent.execution.started',
        ticket,
        participantIds: await participantIdsOf(ctx, ticket.id),
        actor: agentActor(agent),
        data: {
          agent_key: agent.key,
          run_id: run.id,
          step: (Number(run.step ?? 0) || 0) + 1,
          decision: decision.type,
          planner: planning.source,
        },
      });
      const planMeta = { planner: planning.source, ...(planning.meta ?? {}) };
      if (planning.error) planMeta.plannerError = planning.error;

      let patch = {};
      let kind = decision.type;
      let summary = decision.note ?? decision.type;

      if (decision.type === 'tool') {
        const outcome = await invokeTool({
          ctx,
          deps,
          agent,
          ticket,
          run,
          name: decision.tool,
          args: decision.args ?? {},
        });
        if (!outcome.ok) {
          /*
           * Una LECTURA opcional o una petición de ayuda RECHAZADA no pueden
           * matar el trabajo: se anota el paso como error, se marca como hecha
           * y el plan sigue por donde iba (sin reintentar en bucle).
           */
          if (decision.tool === 'order.get_status' || decision.tool === 'agent.request_help') {
            patch = {
              status: 'pending',
              step: (Number(run.step ?? 0) || 0) + 1,
              attempt: 0,
              next_run_at: at,
              state: {
                ...(run.state ?? {}),
                ...(decision.tool === 'order.get_status'
                  ? { orderChecked: true, orderStatus: null }
                  : { helpRequested: true, helpFailed: outcome.error?.code ?? 'error' }),
              },
              last_error: outcome.error ?? null,
            };
            await recordStep({
              ctx,
              run,
              kind,
              status: 'error',
              summary: outcome.error?.code ?? 'error',
              data: outcome.error ?? null,
              plan: planMeta,
            });
          } else {
            const retryable = outcome.error?.retryable !== false;
            const attempt = (Number(run.attempt ?? 0) || 0) + 1;
            patch = {
              status: retryable && attempt < MAX_ATTEMPTS ? 'pending' : 'failed',
              attempt,
              next_run_at: retryable && attempt < MAX_ATTEMPTS ? addMinutes(at, Math.min(30, 2 ** attempt)) : null,
              last_error: outcome.error ?? { code: 'tool_failed', retryable },
            };
            errors.push({ run: run.id, error: outcome.error });
            await recordStep({ ctx, run, kind, status: 'error', summary: outcome.error?.code ?? 'error', data: outcome.error ?? null, plan: planMeta });
          }
        } else {
          const state = { ...(run.state ?? {}) };
          if (decision.tool === 'ticket.get_context') state.contextLoaded = true;
          if (decision.tool === 'order.get_status') {
            state.orderChecked = true;
            state.orderStatus = outcome.result?.status ?? null;
          }
          if (decision.tool === 'ticket.post_message') {
            state.messagesSent = (Number(state.messagesSent ?? 0) || 0) + 1;
            state.greeted = state.greeted || state.lastSeenSeq === undefined;
            state.lastSeenSeq = Number(ticket.last_seq ?? 0) || 0;
          }
          if (decision.tool === 'ticket.request_ack') state.ackRequested = true;
          if (decision.tool === 'ticket.escalate') state.escalated = true;
          if (decision.tool === 'ticket.complete_work') state.workCompleted = true;
          if (decision.tool === 'agent.request_help') state.helpRequested = true;
          /* Atender una colaboración: queda dicho en el hilo y se cierra. */
          if (decision.tool === 'ticket.post_message' && state.collabFrom) state.collabAnswered = true;
          if (decision.tool === 'ticket.get_context' && state.delegationId) {
            const own = await ctx.db.get('ops_agent_delegations', state.delegationId);
            if (own) await markAccepted({ ctx, delegation: own });
          }
          patch = {
            status: 'pending',
            step: (Number(run.step ?? 0) || 0) + 1,
            attempt: 0,
            next_run_at: at,
            state,
            last_error: null,
          };
          await recordStep({ ctx, run, kind, status: 'ok', summary, data: outcome.result ?? null, plan: planMeta });
        }
      } else if (decision.type === 'approval') {
        const approval = await requestApproval({
          ctx,
          deps,
          agent,
          ticket,
          run,
          tool: decision.tool,
          args: decision.args ?? {},
          justification: decision.justification ?? '',
        });
        patch = {
          status: 'waiting_human',
          step: (Number(run.step ?? 0) || 0) + 1,
          next_run_at: null,
          state: { ...(run.state ?? {}), approvalId: approval?.id ?? null },
        };
        await recordStep({ ctx, run, kind, status: 'waiting', summary: 'aprobación pedida', data: { approval_id: approval?.id ?? null } });
      } else if (decision.type === 'wait') {
        patch = {
          status: 'waiting_event',
          next_run_at: addMinutes(at, Number(decision.minutes ?? 30) || 30),
          state: { ...(run.state ?? {}), waitingReason: decision.reason ?? null },
        };
        await recordStep({ ctx, run, kind, status: 'waiting', summary: decision.reason ?? 'en espera', plan: planMeta });
      } else if (decision.type === 'fail') {
        patch = { status: 'failed', last_error: decision.error ?? { code: 'agent_failed' }, next_run_at: null };
        await recordStep({ ctx, run, kind, status: 'error', summary: decision.error?.code ?? 'fallo' });
      } else {
        patch = { status: 'succeeded', next_run_at: null };
        await recordStep({ ctx, run, kind, status: 'ok', summary: decision.summary ?? 'terminado' });
      }

      const updated = await releaseRun({ ctx, runId: run.id, patch });
      executed += 1;
      /*
       * CIERRE DE LA COLABORACIÓN: el agente que atendió la petición la deja
       * `completed` al terminar su trabajo, o `failed` si su run se cayó.
       */
      if (run.state?.delegationId && updated) {
        const settled = await settleDelegationOfRun({
          ctx,
          run,
          status:
            updated.status === 'failed'
              ? 'failed'
              : decision.type === 'tool' && decision.tool === 'ticket.complete_work'
                ? 'completed'
                : null,
          note:
            decision.args?.note ??
            (updated.status === 'failed' ? updated.last_error?.code ?? null : null),
        }).catch(() => null);
        if (settled) {
          publishTicketEvent(ctx, {
            type: 'agent.delegation.changed',
            ticket,
            participantIds: await participantIdsOf(ctx, ticket.id),
            actor: agentActor(agent),
            data: { agent_key: agent.key, run_id: run.id, delegation_id: run.state.delegationId, status: settled.status },
          });
        }
      }
      const finalType =
        updated?.status === 'failed'
          ? 'agent.execution.failed'
          : ['succeeded', 'waiting_event', 'waiting_human'].includes(updated?.status)
            ? 'agent.execution.completed'
            : null;
      if (finalType) {
        publishTicketEvent(ctx, {
          type: finalType,
          ticket,
          participantIds: await participantIdsOf(ctx, ticket.id),
          actor: agentActor(agent),
          data: { agent_key: agent.key, run_id: run.id, status: updated.status, error: updated.last_error ?? null },
        });
      }
    } catch (error) {
      console.error('[ops] agente:', error);
      errors.push({ run: run.id, error: { code: 'tick_error', message: String(error?.message ?? error) } });
      await releaseRun({
        ctx,
        runId: run.id,
        patch: { status: 'pending', next_run_at: addMinutes(at, 5), last_error: { code: 'tick_error', message: String(error?.message ?? error), retryable: true } },
      }).catch(() => null);
    }
  }
  return { executed, due: due.length, errors };
}

/** Diagnóstico de runs de un ticket (para la ficha). */
export async function runsForTicket({ ctx, ticketId }) {
  const rows = await ctx.db.list('ops_agent_runs', { where: { ticket_id: ticketId }, limit: 50 });
  return rows.map((run) => ({
    id: run.id,
    agentKey: run.agent_key,
    status: run.status,
    step: Number(run.step ?? 0) || 0,
    attempt: Number(run.attempt ?? 0) || 0,
    nextRunAt: run.next_run_at ?? null,
    lastError: run.last_error ?? null,
    updatedAt: run.updated_at ?? null,
  }));
}

/** Asigna un agente al ticket (lo hace una persona; queda como participante). */
export async function assignAgentToTicket({ ctx, deps, actor, can, ticketId, agentKey }) {
  if (!can('tickets.update')) {
    return { ok: false, status: 403, error: 'forbidden', message: 'No puedes asignar agentes.' };
  }
  const ticket = await ctx.db.get('ops_tickets', ticketId);
  if (!ticket) return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ese ticket no existe.' };
  const agent = await agentByKey(ctx, agentKey);
  if (!agent || agent.enabled === false) {
    return { ok: false, status: 422, error: 'agent_unavailable', message: 'Ese agente no existe o está desactivado.' };
  }
  if (!(agent.ticket_types ?? []).includes(ticket.type)) {
    return { ok: false, status: 422, error: 'agent_type_denied', message: 'Ese agente no trabaja en este tipo de ticket.' };
  }
  const updated = await ctx.db.update('ops_tickets', ticket.id, {
    assigned_agent_id: agent.key,
    assigned_agent_name: agent.name,
    updated_at: nowIso(ctx),
  });
  await addParticipant(ctx, {
    ticketId: ticket.id,
    userId: agentActor(agent).id,
    name: agent.name,
    role: 'agent',
    actor,
    participantType: 'agent',
  });
  const run = await ensureRunForEvent({ ctx, ticket: updated, agent, event: 'ticket.assigned' });
  await recordEvent(ctx, {
    ticketId: ticket.id,
    kind: 'agent_assigned',
    actor,
    summary: `Agente asignado: ${agent.name}`,
    data: { agent_key: agent.key },
  });
  await ctx.audit?.record?.({
    entity: 'ticket',
    entityId: ticket.id,
    action: 'ticket_agent_assigned',
    actor: actor?.display_name ?? null,
    summary: `${ticket.number} · ${agent.name}`,
  });
  return { ok: true, status: 200, run, agent };
}
