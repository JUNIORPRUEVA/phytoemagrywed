/**
 * CENTRO DE OPERACIONES — TICKETS INTERNOS (Etapa B).
 *
 * QUÉ ES ESTO
 * Un ticket es una unidad de trabajo con conversación propia: «este pedido hay
 * que entregarlo», «esta incidencia hay que resolverla», «esta asignación hay que
 * confirmarla». Vive SEPARADO del chat de WhatsApp del cliente (otra colección,
 * otras rutas, otra pantalla) y se puede abrir a mano o desde un pedido.
 *
 * REGLAS QUE NO SE ROMPEN
 *   - Deduplicación: `active_key` es único mientras el ticket está activo. Dos
 *     clics seguidos en «Crear ticket» desde el mismo pedido devuelven EL MISMO
 *     ticket (409 `duplicate_ticket` con el existente), no dos.
 *   - Autorización en el SERVIDOR: ver un ticket exige ser participante o tener
 *     `tickets.read_all`; el cliente web no decide nada.
 *   - Proyección por permisos: lo que la persona no puede ver, no se envía. Hoy
 *     el único dato sensible del ticket es el nombre del cliente (exige
 *     `clients.read`).
 *   - Estados finales (`resolved`, `cancelled`) no se reabren por PATCH: cerrar
 *     un ticket es una decisión explícita, no un efecto colateral.
 */

import { randomBytes } from 'node:crypto';

import {
  notifyAckRequired,
  notifyAssigned,
  notifyEscalation,
  notifyStatus,
  ticketRecipients,
} from './notify.mjs';

/** Tipos de ticket. Lista CERRADA: añadir uno es un cambio deliberado. */
export const OPS_TICKET_TYPES = Object.freeze([
  'order',
  'delivery',
  'incident',
  'assignment',
  'sales_followup',
  'inventory',
  'admin',
  'agent_task',
]);

export const OPS_TICKET_TYPE_LABELS = Object.freeze({
  order: 'Pedido',
  delivery: 'Entrega',
  incident: 'Incidencia',
  assignment: 'Asignación',
  sales_followup: 'Seguimiento comercial',
  inventory: 'Inventario',
  admin: 'Administrativo',
  agent_task: 'Tarea de agente',
});

export const OPS_TICKET_STATUSES = Object.freeze(['open', 'in_progress', 'waiting', 'resolved', 'cancelled']);
export const OPS_FINAL_STATUSES = Object.freeze(['resolved', 'cancelled']);

export const OPS_TICKET_STATUS_LABELS = Object.freeze({
  open: 'Abierto',
  in_progress: 'En curso',
  waiting: 'En espera',
  resolved: 'Resuelto',
  cancelled: 'Cancelado',
});

export const OPS_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);

export const OPS_PRIORITY_LABELS = Object.freeze({
  low: 'Baja',
  normal: 'Normal',
  high: 'Alta',
  urgent: 'Urgente',
});

/** Por quién espera un ticket en estado `waiting`. */
export const OPS_WAITING_ON = Object.freeze(['human', 'agent', 'external']);

const MAX_TITLE = 140;
const MAX_DESCRIPTION = 2000;
const INBOX_LIMIT = 250;

/** Id con el mismo aspecto que el resto del CRM (`tkt_…`). */
function newId() {
  return `tkt_${randomBytes(10).toString('hex')}`;
}

/** Número legible y ÚNICO (`TK-A1B2C3`), como los pedidos (`PE-0A1B2C`). */
function newNumber() {
  return `TK-${randomBytes(3).toString('hex').toUpperCase()}`;
}

function clean(value, max = 240) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\r\n/g, '\n').replace(/\s+$/g, '').trim();
  return text ? text.slice(0, max) : null;
}

function iso(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function nowIso(ctx) {
  const clock = ctx?.clock ?? (() => new Date());
  return clock().toISOString();
}

function isFinal(status) {
  return OPS_FINAL_STATUSES.includes(String(status ?? ''));
}

/**
 * Clave de deduplicación del flujo.
 *
 * Solo hay deduplicación cuando se puede afirmar QUÉ flujo es:
 *   - con un negocio vinculado (un pedido) → un ticket activo por tipo y pedido;
 *   - con una `idempotencyKey` del navegador → el mismo formulario enviado dos
 *     veces (doble toque, red lenta) devuelve el mismo ticket.
 *
 * Un ticket MANUAL sin pedido y sin clave NO se deduplica: dos incidencias
 * distintas pueden llamarse igual («Revisar caja») y son dos trabajos distintos.
 * (Un `active_key` global por tipo las habría fusionado en una sola, que es peor
 * que el problema que intentaba evitar.)
 */
export function activeKeyOf({ type, entityType, entityId, workflowKey, idempotencyKey }) {
  const idem = clean(idempotencyKey, 120);
  if (entityId) {
    const flow = clean(workflowKey, 40) ?? String(type ?? '');
    return `${type}:${entityType ?? 'none'}:${entityId}:${flow}`;
  }
  if (idem) return `idem:${idem}`;
  return null;
}

/** ¿Esta persona puede ver TODOS los tickets (no solo los suyos)? */
function seesAllTickets(can) {
  return Boolean(can?.('tickets.read_all'));
}

/**
 * Proyección del ticket según quién mira.
 *
 * Se construye el objeto permitido; NO se manda el documento entero y se
 * recorta en el navegador (lo que no se envía no se puede leer en la consola).
 */
export function projectTicket(ticket, { can = () => false, myParticipant = null } = {}) {
  if (!ticket) return null;
  const meta = ticket.metadata && typeof ticket.metadata === 'object' ? ticket.metadata : {};
  const canSeeCustomer = Boolean(can('clients.read'));
  const myRead = Number(myParticipant?.last_read_seq ?? 0) || 0;
  const myAck = Number(myParticipant?.last_ack_seq ?? 0) || 0;
  const lastSeq = Number(ticket.last_seq ?? 0) || 0;
  return {
    id: ticket.id,
    number: ticket.number,
    type: ticket.type,
    typeLabel: OPS_TICKET_TYPE_LABELS[ticket.type] ?? ticket.type,
    title: ticket.title,
    description: ticket.description ?? null,
    status: ticket.status,
    statusLabel: OPS_TICKET_STATUS_LABELS[ticket.status] ?? ticket.status,
    waitingOn: ticket.waiting_on ?? null,
    priority: ticket.priority,
    priorityLabel: OPS_PRIORITY_LABELS[ticket.priority] ?? ticket.priority,
    assignedUserId: ticket.assigned_user_id ?? null,
    assignedUserName: ticket.assigned_user_name ?? null,
    assignedAgentId: ticket.assigned_agent_id ?? null,
    assignedAgentName: ticket.assigned_agent_name ?? null,
    dueAt: ticket.due_at ?? null,
    followUpAt: ticket.follow_up_at ?? null,
    entityType: ticket.entity_type ?? null,
    entityId: ticket.entity_id ?? null,
    // Datos del pedido (nunca el teléfono ni la dirección del cliente).
    entityLabel: meta.entity_label ?? null,
    orderNumber: meta.order_number ?? null,
    orderStatus: meta.order_status ?? null,
    orderTotal: meta.order_total ?? null,
    // El NOMBRE del cliente es dato personal: solo con `clients.read`.
    customerName: canSeeCustomer ? meta.customer_name ?? null : null,
    parentTicketId: ticket.parent_ticket_id ?? null,
    createdAt: ticket.created_at,
    updatedAt: ticket.updated_at,
    lastMessageAt: ticket.last_message_at ?? null,
    lastMessagePreview: ticket.last_message_preview ?? null,
    lastMessageKind: ticket.last_message_kind ?? null,
    lastAuthorType: ticket.last_author_type ?? null,
    lastAuthorName: ticket.last_author_name ?? null,
    messageCount: Number(ticket.message_count ?? 0) || 0,
    lastSeq,
    myReadSeq: myRead,
    myAckSeq: myAck,
    /* No leído = hay algo nuevo Y lo último no lo escribí yo (si acabo de
     * escribir, obviamente lo he visto). El CONTADOR sale del servidor. */
    unread: lastSeq > myRead && ticket.last_author_id !== myParticipant?.participant_id,
    unreadCount: Number(myParticipant?.unread_count ?? 0) || 0,
    /* Acuse pendiente: leí pero no confirmé. */
    ackPending: lastSeq > myAck && lastSeq <= myRead,
    requiresAck: ticket.requires_ack === true,
    /* Estado de la TAREA (no del mensaje): acuse, inicio, avance, cierre. */
    task: taskOf(ticket),
    dueNotifiedAt: ticket.due_notified_at ?? null,
    dueState: dueStateOf(ticket.due_at, ctxNow()),
    resolvedAt: ticket.resolved_at ?? null,
    resolution: ticket.resolution ?? null,
    createdByName: ticket.created_by_name ?? null,
  };
}

/** Estado de tarea del ticket, siempre con la misma forma. */
export function taskOf(ticket) {
  const task = ticket?.task && typeof ticket.task === 'object' ? ticket.task : {};
  return {
    acknowledgedAt: task.acknowledged_at ?? null,
    acknowledgedById: task.acknowledged_by_user_id ?? null,
    acknowledgedByName: task.acknowledged_by_name ?? null,
    startedAt: task.started_at ?? null,
    startedByName: task.started_by_name ?? null,
    lastProgressAt: task.last_progress_at ?? null,
    lastProgressByName: task.last_progress_by_name ?? null,
    issueCount: Number(task.issue_count ?? 0) || 0,
    lastIssueAt: task.last_issue_at ?? null,
    helpCount: Number(task.help_count ?? 0) || 0,
    completedAt: task.completed_at ?? null,
    completedById: task.completed_by_user_id ?? null,
    completedByName: task.completed_by_name ?? null,
    escalatedAt: task.escalated_at ?? null,
    escalatedByName: task.escalated_by_name ?? null,
    escalationReason: task.escalation_reason ?? null,
  };
}

/*
 * `dueStateOf` necesita «ahora». En la proyección se usa el reloj real porque es
 * solo para pintar (vencido / hoy / próximo); las reglas de negocio sí usan el
 * reloj inyectado del servidor.
 */
function ctxNow() {
  return new Date().toISOString();
}

function dueStateOf(dueAt, nowIsoValue) {
  const due = Date.parse(String(dueAt ?? ''));
  if (!Number.isFinite(due)) return null;
  const now = Date.parse(String(nowIsoValue ?? ''));
  if (!Number.isFinite(now)) return null;
  if (due < now) return 'overdue';
  if (due - now < 24 * 60 * 60 * 1000) return 'soon';
  return 'later';
}

/** Todos los ids de participantes de un ticket (para el filtro de SSE). */
export async function participantIdsOf(ctx, ticketId) {
  const rows = await ctx.db.list('ops_ticket_participants', { where: { ticket_id: ticketId }, limit: 100 });
  return rows.map((row) => row.participant_id).filter(Boolean);
}

/** La fila de participante de ESTA persona en ESTE ticket (o null). */
export async function participantOf(ctx, ticketId, participantId) {
  if (!ticketId || !participantId) return null;
  const rows = await ctx.db.list('ops_ticket_participants', {
    where: { ticket_id: ticketId },
    limit: 200,
  });
  return rows.find((row) => row.participant_id === participantId) ?? null;
}

/** Añade un participante si no estaba (idempotente por `idempotency_key`). */
export async function addParticipant(ctx, { ticketId, userId, name = null, role = 'watcher', actor = null, participantType = 'user' }) {
  const participantId = clean(userId, 80);
  if (!ticketId || !participantId) return null;
  const key = `opart:${ticketId}:${participantId}`;
  const existing = await ctx.db.findBy('ops_ticket_participants', 'idempotency_key', key);
  if (existing) return existing;
  const at = nowIso(ctx);
  const doc = {
    id: `opart_${randomBytes(8).toString('hex')}`,
    ticket_id: ticketId,
    /* `user` es una persona del CRM; `agent` es un agente autorizado. */
    participant_type: participantType,
    participant_id: participantId,
    participant_name: clean(name, 120),
    role: clean(role, 20) ?? 'watcher',
    last_read_seq: 0,
    last_ack_seq: 0,
    /* Contador de no leídos MANTENIDO en el servidor: la bandeja no tiene que
     * contar mensajes para pintar el badge (y sigue cuadrando tras reiniciar). */
    unread_count: 0,
    last_notified_seq: 0,
    last_notified_at: null,
    /* Sin esta clave el índice único no existe y un doble clic duplicaría la
     * participación (el `findBy` de arriba ya lo evita, pero la clave es la
     * garantía de la BASE). */
    idempotency_key: key,
    added_by_user_id: actor?.id ?? null,
    created_at: at,
    updated_at: at,
  };
  const result = await ctx.db.insert('ops_ticket_participants', doc);
  if (result?.duplicate) return ctx.db.findBy('ops_ticket_participants', 'idempotency_key', key);
  return doc;
}

/** Escribe un hecho en la línea de tiempo del ticket (idempotente). */
export async function recordEvent(ctx, { ticketId, kind, actor = null, summary = null, data = null, idempotencyKey = null }) {
  if (!ticketId || !kind) return null;
  const key = clean(idempotencyKey, 140) ?? `${kind}:${ticketId}:${randomBytes(8).toString('hex')}`;
  const doc = {
    id: `opev_${randomBytes(8).toString('hex')}`,
    ticket_id: ticketId,
    kind: String(kind).slice(0, 40),
    actor_id: actor?.id ?? null,
    actor_type: actor?.actor_type ?? null,
    actor_name: clean(actor?.display_name, 120),
    summary: clean(summary, 240),
    data: data && typeof data === 'object' ? data : null,
    idempotency_key: key,
    created_at: nowIso(ctx),
  };
  const result = await ctx.db.insert('ops_ticket_events', doc);
  return result?.duplicate ? null : doc;
}

/** Publica el cambio en el bus de tiempo real (nunca lanza). */
export function publishTicketEvent(ctx, { type, ticket, participantIds = [], data = {}, actor = null }) {
  try {
    ctx?.realtime?.publish?.({
      type,
      entity: { kind: 'ticket', id: ticket.id },
      requires: 'tickets.read',
      audience: 'ticket',
      actor: actor ? { id: actor.id, display_name: actor.display_name } : null,
      data: { ticketId: ticket.id, number: ticket.number, participant_ids: participantIds, ...data },
    });
  } catch {
    /* avisar no puede tumbar la operación que sí se guardó */
  }
  /*
   * DESPERTAR AGENTES (Etapa D).
   *
   * Un evento relevante marca trabajo pendiente para los agentes autorizados.
   * NO ejecuta nada aquí: solo deja el run «para ahora» y el scheduler lo toma.
   * Si esto falla, el ticket sigue perfectamente: el trabajo del agente es un
   * añadido, nunca un requisito.
   */
  try {
    ctx?.opsAgents?.onTicketEvent?.({ type, ticket });
  } catch {
    /* igual que arriba: el agente no puede tumbar el ticket */
  }
}

/**
 * Datos del pedido que se copian al ticket (sin datos personales sensibles).
 * Se leen del pedido REAL, no de lo que mande el navegador.
 */
function orderSnapshot(row) {
  if (!row) return null;
  let order = null;
  try {
    order = JSON.parse(row.order_json ?? row.orderJson ?? 'null');
  } catch {
    order = null;
  }
  const number = row.order_number ?? order?.order_number ?? order?.number ?? null;
  const status = row.status ?? order?.status ?? null;
  const total = order?.total ?? row.total ?? null;
  const customerName =
    order?.customer?.name ??
    order?.customer_name ??
    row.customer_name ??
    null;
  return {
    order_number: clean(number, 40),
    order_status: clean(status, 30),
    order_total: total === null || total === undefined ? null : Number(total),
    customer_name: clean(customerName, 120),
    entity_label: clean(number ? `Pedido ${number}` : 'Pedido', 60),
  };
}

/* ------------------------------------------------------------------ Lectura */

/**
 * Lista de la bandeja.
 *
 * @param {object} input
 * @param {any} input.ctx
 * @param {any} input.actor
 * @param {(p: string) => boolean} input.can
 * @param {string} [input.filter]  abiertos | esperando | mios | sin-asignar | urgentes | resueltos | todos
 * @param {string} [input.q]       búsqueda por número, título o último mensaje
 * @param {string} [input.type]    filtra por tipo de ticket
 */
export async function listInbox({ ctx, actor, can, filter = 'abiertos', q = '', type = '' }) {
  const all = await ctx.db.list('ops_tickets', { by: 'created_at', order: 'desc', limit: INBOX_LIMIT });
  /*
   * Participaciones de quien mira. Se piden SIEMPRE (también para quien ve
   * todos) porque de ahí salen los estados leído/acuse de cada fila.
   */
  const mine = actor?.id
    ? await ctx.db.list('ops_ticket_participants', { where: { participant_id: actor.id }, limit: 500 })
    : [];
  const mineByTicket = new Map(mine.map((row) => [row.ticket_id, row]));
  const seeAll = seesAllTickets(can);

  let rows = seeAll
    ? all
    : all.filter((ticket) => mineByTicket.has(ticket.id) || ticket.assigned_user_id === actor?.id);

  const wantedType = clean(type, 30);
  if (wantedType) rows = rows.filter((ticket) => ticket.type === wantedType);

  const query = String(q ?? '').trim().toLowerCase();
  if (query) {
    rows = rows.filter((ticket) =>
      [ticket.number, ticket.title, ticket.last_message_preview, ticket.metadata?.order_number]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }

  const isMine = (ticket) => Boolean(actor?.id) && (ticket.assigned_user_id === actor.id || mineByTicket.has(ticket.id));
  const shapes = {
    abiertos: (ticket) => !isFinal(ticket.status),
    esperando: (ticket) => ticket.status === 'waiting',
    mios: (ticket) => !isFinal(ticket.status) && isMine(ticket),
    'sin-asignar': (ticket) => !isFinal(ticket.status) && !ticket.assigned_user_id && !ticket.assigned_agent_id,
    urgentes: (ticket) => !isFinal(ticket.status) && ['urgent', 'high'].includes(ticket.priority),
    resueltos: (ticket) => isFinal(ticket.status),
    todos: () => true,
  };
  const predicate = shapes[String(filter ?? 'abiertos')] ?? shapes.abiertos;
  rows = rows.filter(predicate);

  /* Orden por actividad real: el último mensaje manda sobre la fecha de alta. */
  const activity = (ticket) => Date.parse(ticket.last_message_at ?? ticket.created_at ?? 0) || 0;
  rows.sort((a, b) => activity(b) - activity(a));

  const items = rows.map((ticket) => projectTicket(ticket, { can, myParticipant: mineByTicket.get(ticket.id) ?? null }));
  return { ok: true, filter, items, total: items.length };
}

/** Contadores para el distintivo del menú y las pestañas. */
export async function inboxSummary({ ctx, actor, can }) {
  const { items } = await listInbox({ ctx, actor, can, filter: 'abiertos' });
  let unread = 0;
  let unreadTickets = 0;
  let waiting = 0;
  let urgent = 0;
  let mineOpen = 0;
  let pendingAck = 0;
  for (const item of items) {
    /* El contador viene del servidor (participación), no de adivinar en el cliente. */
    unread += item.unreadCount;
    if (item.unreadCount > 0) unreadTickets += 1;
    if (item.status === 'waiting') waiting += 1;
    if (['urgent', 'high'].includes(item.priority)) urgent += 1;
    if (item.assignedUserId === actor?.id) mineOpen += 1;
    if (item.requiresAck && !item.task?.acknowledgedAt) pendingAck += 1;
  }
  return { ok: true, open: items.length, unread, unreadTickets, waiting, urgent, mine: mineOpen, pendingAck };
}

/** Un ticket con su hilo, sus participantes y su línea de tiempo. */
export async function readTicket({ ctx, actor, can, id, messageLimit = 200, beforeSeq = null }) {
  const ticket = await ctx.db.get('ops_tickets', id);
  if (!ticket) return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ese ticket no existe.' };
  const myParticipant = await participantOf(ctx, id, actor?.id);
  const visible = seesAllTickets(can) || Boolean(myParticipant) || ticket.assigned_user_id === actor?.id;
  if (!visible) {
    return { ok: false, status: 403, error: 'forbidden', message: 'No participas en este ticket.' };
  }
  const limit = Math.min(Math.max(Number(messageLimit) || 200, 1), 500);
  /*
   * PAGINACIÓN: `beforeSeq` pide la página ANTERIOR (hacia atrás). Se cuenta con
   * un mensaje de más para saber si quedan más sin hacer otra consulta.
   */
  const before = Number(beforeSeq);
  const page = await ctx.db.list('ops_ticket_messages', {
    where: { ticket_id: id },
    by: 'seq_key',
    order: 'desc',
    limit: Number.isFinite(before) && before > 0 ? 500 : limit + 1,
  });
  const filtered = Number.isFinite(before) && before > 0 ? page.filter((row) => (Number(row.seq) || 0) < before) : page;
  const hasMore = filtered.length > limit;
  const messages = filtered
    .slice(0, limit)
    .slice()
    .reverse()
    .map((row) => projectMessage(row));
  const events = (
    await ctx.db.list('ops_ticket_events', { where: { ticket_id: id }, by: 'created_at', order: 'desc', limit: 80 })
  )
    .slice()
    .reverse()
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      at: row.created_at,
      actorName: row.actor_name ?? null,
      summary: row.summary ?? null,
    }));
  const users = await ctx.users.listUsers();
  const byId = new Map(users.map((user) => [user.id, user]));
  const participants = (
    await ctx.db.list('ops_ticket_participants', { where: { ticket_id: id }, limit: 100 })
  ).map((row) => {
    const user = byId.get(row.participant_id);
    return {
      id: row.id,
      userId: row.participant_id,
      name: row.participant_name ?? user?.display_name ?? row.participant_id,
      /* `user` = persona del CRM; `agent` = agente de IA autorizado. */
      type: row.participant_type ?? 'user',
      role: row.role,
      active: user ? user.active !== false : false,
      lastReadSeq: Number(row.last_read_seq ?? 0) || 0,
      lastAckSeq: Number(row.last_ack_seq ?? 0) || 0,
      /* «Avisado hasta #N»: hasta qué mensaje se le mandó notificación. */
      lastNotifiedSeq: Number(row.last_notified_seq ?? 0) || 0,
      unreadCount: Number(row.unread_count ?? 0) || 0,
    };
  });
  return {
    ok: true,
    ticket: projectTicket(ticket, { can, myParticipant }),
    messages,
    hasMore,
    oldestSeq: messages[0]?.seq ?? null,
    events,
    participants,
    permissions: {
      reply: Boolean(can('tickets.reply')),
      ack: Boolean(can('tickets.ack')),
      update: Boolean(can('tickets.update')),
      close: Boolean(can('tickets.close')),
      manageParticipants: Boolean(can('tickets.participants.manage')),
      escalate: Boolean(can('tickets.reply')) && (Boolean(myParticipant) || seesAllTickets(can)),
      /*
       * Etapa D: dar de alta agentes y asignarlos es cosa de administración;
       * aprobar una acción con efecto irreversible exige el permiso concreto
       * que declare la herramienta (hoy, `tickets.close`).
       */
      manageAgents: Boolean(can('admin.full')),
      approve: Boolean(can('tickets.close')),
    },
  };
}

/** Proyección de un mensaje (no se envía el documento crudo). */
export function projectMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    seq: Number(row.seq ?? 0) || 0,
    authorType: row.author_type,
    authorId: row.author_id ?? null,
    authorName: row.author_name ?? null,
    kind: row.kind,
    body: row.body ?? '',
    createdAt: row.created_at,
    meta: row.meta && typeof row.meta === 'object' ? row.meta : null,
  };
}

/* ----------------------------------------------------------------- Escritura */

/**
 * Abre un ticket. Es idempotente por `active_key`: si ya hay uno activo del
 * mismo flujo devuelve 409 con EL EXISTENTE (el panel lo abre en vez de crear
 * otro).
 */
export async function createTicket({ ctx, actor, can, input = {}, findOrder = null, deps = null }) {
  if (!can('tickets.create')) {
    return { ok: false, status: 403, error: 'forbidden', message: 'No puedes crear tickets.' };
  }
  const type = String(input.type ?? 'admin');
  if (!OPS_TICKET_TYPES.includes(type)) {
    return { ok: false, status: 422, error: 'invalid_type', message: 'Ese tipo de ticket no existe.' };
  }
  const title = clean(input.title, MAX_TITLE);
  if (!title || title.length < 3) {
    return { ok: false, status: 422, error: 'invalid_title', message: 'Escribe un asunto (al menos 3 letras).' };
  }
  const description = clean(input.description, MAX_DESCRIPTION);
  const priority = OPS_PRIORITIES.includes(String(input.priority)) ? String(input.priority) : 'normal';
  const entityType = clean(input.entityType ?? input.entity_type, 30);
  const entityId = clean(input.entityId ?? input.entity_id, 80);
  const dueAt = iso(input.dueAt ?? input.due_at);
  const followUpAt = iso(input.followUpAt ?? input.follow_up_at);
  const assignedUserId = clean(input.assignedUserId ?? input.assigned_user_id, 80);

  /*
   * VÍNCULO CON EL NEGOCIO (opcional).
   *
   * Un ticket de tipo «entrega» puede existir SIN pedido (una incidencia de
   * reparto, una ruta que hay que organizar). Pero si dice a qué pedido va, ese
   * pedido tiene que EXISTIR: se comprueba aquí y el resumen se copia del pedido
   * real, nunca de lo que mande el navegador.
   */
  let metadata = {};
  const linkedKind = entityType ?? (entityId ? 'order' : null);
  if (linkedKind) {
    if (!entityId) {
      return { ok: false, status: 422, error: 'order_required', message: 'Elige el pedido del ticket.' };
    }
    if (linkedKind === 'order' || linkedKind === 'delivery') {
      if (typeof findOrder !== 'function') {
        return { ok: false, status: 500, error: 'order_lookup_unavailable', message: 'No se pudo comprobar el pedido.' };
      }
      const row = await findOrder(entityId);
      if (!row) return { ok: false, status: 404, error: 'order_not_found', message: 'Ese pedido no existe.' };
      metadata = orderSnapshot(row) ?? {};
    }
  }

  const workflowKey = clean(input.workflowKey ?? input.workflow_key, 40) ?? type;
  const activeKey = activeKeyOf({
    type,
    entityType: entityType ?? (entityId ? 'order' : null),
    entityId,
    workflowKey,
    idempotencyKey: input.idempotencyKey ?? input.idempotency_key ?? null,
  });

  const existingActive = activeKey ? await ctx.db.findBy('ops_tickets', 'active_key', activeKey) : null;
  if (existingActive) {
    const myParticipant = await participantOf(ctx, existingActive.id, actor?.id);
    return {
      ok: false,
      status: 409,
      error: 'duplicate_ticket',
      message: 'Ya hay un ticket activo para este asunto.',
      ticket: projectTicket(existingActive, { can, myParticipant }),
    };
  }

  const at = nowIso(ctx);
  /*
   * ¿ESTE TICKET EXIGE ACUSE EXPLÍCITO?
   *
   * Un trabajo asignado (entrega o asignación) sí: alguien tiene que confirmar
   * que lo vio. Se puede forzar con `requiresAck` y se puede quitar con `false`.
   * Leer el mensaje NUNCA sustituye al acuse (son estados distintos).
   */
  const requiresAck =
    input.requiresAck === undefined && input.requires_ack === undefined
      ? Boolean(assignedUserId) && (type === 'delivery' || type === 'assignment')
      : input.requiresAck === true || input.requires_ack === true;
  let number = newNumber();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const taken = await ctx.db.findBy('ops_tickets', 'number', number);
    if (!taken) break;
    number = newNumber();
  }

  const doc = {
    id: newId(),
    number,
    type,
    title,
    description,
    entity_type: entityType ?? null,
    entity_id: entityId ?? null,
    status: 'open',
    waiting_on: null,
    priority,
    assigned_user_id: assignedUserId,
    assigned_user_name: null,
    assigned_agent_id: null,
    parent_ticket_id: clean(input.parentTicketId ?? input.parent_ticket_id, 80),
    due_at: dueAt,
    follow_up_at: followUpAt,
    last_message_at: null,
    last_message_at_seq: 0,
    last_message_preview: description ? description.slice(0, 120) : null,
    last_message_kind: null,
    last_author_type: null,
    last_author_id: null,
    last_author_name: null,
    last_seq: 0,
    message_count: 0,
    active_key: activeKey,
    requires_ack: requiresAck,
    /* Estado de la TAREA: vacío al nacer, se va llenando con acciones auditables. */
    task: {
      acknowledged_at: null,
      acknowledged_by_user_id: null,
      acknowledged_by_name: null,
      started_at: null,
      started_by_user_id: null,
      started_by_name: null,
      last_progress_at: null,
      last_progress_by_user_id: null,
      last_progress_by_name: null,
      issue_count: 0,
      last_issue_at: null,
      help_count: 0,
      completed_at: null,
      completed_by_user_id: null,
      completed_by_name: null,
      escalated_at: null,
      escalated_by_user_id: null,
      escalated_by_name: null,
      escalation_reason: null,
    },
    due_notified_for: null,
    due_notified_at: null,
    metadata,
    created_by_user_id: actor?.id ?? null,
    created_by_name: clean(actor?.display_name, 120),
    created_at: at,
    updated_at: at,
    resolved_at: null,
    resolved_by_user_id: null,
    resolution: null,
  };

  if (assignedUserId) {
    const users = await ctx.users.listUsers();
    const target = users.find((user) => user.id === assignedUserId);
    if (!target) {
      return { ok: false, status: 422, error: 'invalid_assignee', message: 'Ese usuario no existe.' };
    }
    doc.assigned_user_name = target.display_name ?? target.username ?? null;
  }

  let inserted = await ctx.db.insert('ops_tickets', doc);
  /*
   * Colisión: puede ser la clave de flujo (dos peticiones a la vez) o el número
   * (muy improbable, 16,7 millones de combinaciones). Se distinguen.
   */
  for (let attempt = 0; inserted?.duplicate && attempt < 4; attempt += 1) {
    const winner = activeKey ? await ctx.db.findBy('ops_tickets', 'active_key', activeKey) : null;
    if (winner) {
      return {
        ok: false,
        status: 409,
        error: 'duplicate_ticket',
        message: 'Ya hay un ticket activo para este asunto.',
        ticket: projectTicket(winner, { can }),
      };
    }
    /* El número estaba cogido: se prueba otro sin tocar nada más. */
    let otro = newNumber();
    while (await ctx.db.findBy('ops_tickets', 'number', otro)) otro = newNumber();
    doc.number = otro;
    inserted = await ctx.db.insert('ops_tickets', doc);
  }
  if (inserted?.duplicate) {
    return { ok: false, status: 409, error: 'ticket_conflict', message: 'No se pudo crear el ticket. Reintenta.' };
  }

  await addParticipant(ctx, {
    ticketId: doc.id,
    userId: actor?.id,
    name: actor?.display_name,
    role: 'owner',
    actor,
  });
  if (doc.assigned_user_id && doc.assigned_user_id !== actor?.id) {
    await addParticipant(ctx, {
      ticketId: doc.id,
      userId: doc.assigned_user_id,
      name: doc.assigned_user_name,
      role: 'assignee',
      actor,
    });
  }
  await recordEvent(ctx, {
    ticketId: doc.id,
    kind: 'created',
    actor,
    summary: `Ticket ${doc.number} abierto`,
    data: { type, entity_id: entityId ?? null },
    idempotencyKey: `opticket:created:${doc.id}`,
  });
  await ctx.audit?.record?.({
    entity: 'ticket',
    entityId: doc.id,
    action: 'ticket_created',
    actor: actor?.display_name ?? null,
    summary: `${doc.number} · ${title}`,
    data: { type, priority, entity_id: entityId ?? null },
    idempotencyKey: `audit:ticket_created:${doc.id}`,
  });

  publishTicketEvent(ctx, {
    type: 'ticket.created',
    ticket: doc,
    participantIds: [actor?.id, doc.assigned_user_id].filter(Boolean),
    actor,
    data: { type, priority, requires_ack: requiresAck },
  });

  /*
   * AVISOS (Etapa C). Se emiten DESPUÉS de persistir: si el push falla, el
   * ticket y su aviso ya están en la base.
   */
  if (doc.assigned_user_id && doc.assigned_user_id !== actor?.id) {
    await notifyAssigned({ ctx, deps, ticket: doc, assignee: { id: doc.assigned_user_id, display_name: doc.assigned_user_name }, actor });
  }
  if (requiresAck) {
    const targets = await ticketRecipients(ctx, doc.id, { excludeUserId: actor?.id ?? null });
    await notifyAckRequired({ ctx, deps, ticket: doc, recipients: targets });
  }

  return { ok: true, status: 201, ticket: projectTicket(doc, { can }) };
}

/**
 * Cambios de estado/prioridad/plazo/asignación.
 * Cerrar (`resolved`/`cancelled`) NO pasa por aquí: tiene su ruta, su permiso y
 * su texto de resolución.
 */
export async function updateTicket({ ctx, actor, can, id, patch = {}, deps = null }) {
  if (!can('tickets.update')) {
    return { ok: false, status: 403, error: 'forbidden', message: 'No puedes cambiar este ticket.' };
  }
  const current = await ctx.db.get('ops_tickets', id);
  if (!current) return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ese ticket no existe.' };
  const myParticipant = await participantOf(ctx, id, actor?.id);
  if (!seesAllTickets(can) && !myParticipant && current.assigned_user_id !== actor?.id) {
    return { ok: false, status: 403, error: 'forbidden', message: 'No participas en este ticket.' };
  }
  if (isFinal(current.status)) {
    return { ok: false, status: 409, error: 'ticket_closed', message: 'El ticket ya está cerrado.' };
  }

  const next = { updated_at: nowIso(ctx) };
  const changes = [];

  if (patch.status !== undefined) {
    const status = String(patch.status);
    if (!['open', 'in_progress', 'waiting'].includes(status)) {
      return {
        ok: false,
        status: 422,
        error: 'invalid_status',
        message: 'Para cerrar un ticket usa «Resolver».',
      };
    }
    if (status !== current.status) {
      next.status = status;
      changes.push(`estado → ${OPS_TICKET_STATUS_LABELS[status] ?? status}`);
    }
    if (status === 'waiting') {
      const waitingOn = String(patch.waitingOn ?? patch.waiting_on ?? 'human');
      if (!OPS_WAITING_ON.includes(waitingOn)) {
        return { ok: false, status: 422, error: 'invalid_waiting_on', message: '¿De quién se espera respuesta?' };
      }
      next.waiting_on = waitingOn;
    } else {
      next.waiting_on = null;
    }
  }

  if (patch.priority !== undefined) {
    const priority = String(patch.priority);
    if (!OPS_PRIORITIES.includes(priority)) {
      return { ok: false, status: 422, error: 'invalid_priority', message: 'Esa prioridad no existe.' };
    }
    if (priority !== current.priority) {
      next.priority = priority;
      changes.push(`prioridad → ${OPS_PRIORITY_LABELS[priority] ?? priority}`);
    }
  }

  if (patch.dueAt !== undefined || patch.due_at !== undefined) {
    next.due_at = iso(patch.dueAt ?? patch.due_at);
    changes.push(next.due_at ? 'plazo actualizado' : 'plazo quitado');
  }
  if (patch.followUpAt !== undefined || patch.follow_up_at !== undefined) {
    next.follow_up_at = iso(patch.followUpAt ?? patch.follow_up_at);
    changes.push(next.follow_up_at ? 'seguimiento programado' : 'seguimiento quitado');
  }

  let newAssignee = null;
  if (patch.assignedUserId !== undefined || patch.assigned_user_id !== undefined) {
    const value = patch.assignedUserId ?? patch.assigned_user_id;
    const wanted = value === null || value === '' ? null : clean(value, 80);
    if (wanted) {
      const users = await ctx.users.listUsers();
      const target = users.find((user) => user.id === wanted && user.active !== false);
      if (!target) return { ok: false, status: 422, error: 'invalid_assignee', message: 'Ese usuario no existe.' };
      newAssignee = target;
      next.assigned_user_id = target.id;
      next.assigned_user_name = target.display_name ?? target.username ?? null;
    } else {
      next.assigned_user_id = null;
      next.assigned_user_name = null;
    }
    changes.push(newAssignee ? `asignado a ${newAssignee.display_name ?? newAssignee.id}` : 'sin asignar');
  }

  if (!changes.length && Object.keys(next).length <= 1) {
    return { ok: true, status: 200, ticket: projectTicket(current, { can, myParticipant }), unchanged: true };
  }

  const updated = await ctx.db.update('ops_tickets', id, next);

  if (newAssignee) {
    await addParticipant(ctx, {
      ticketId: id,
      userId: newAssignee.id,
      name: newAssignee.display_name,
      role: 'assignee',
      actor,
    });
    await ctx.audit?.record?.({
      entity: 'ticket',
      entityId: id,
      action: 'ticket_assigned',
      actor: actor?.display_name ?? null,
      summary: `${current.number} asignado a ${newAssignee.display_name ?? newAssignee.id}`,
      data: { to: newAssignee.id },
    });
    publishTicketEvent(ctx, {
      type: 'ticket.assigned',
      ticket: updated,
      participantIds: await participantIdsOf(ctx, id),
      actor,
      data: { assigned_user_id: newAssignee.id },
    });
    /* Aviso directo al asignado (aunque no escriba nadie en el hilo). */
    await notifyAssigned({ ctx, deps, ticket: updated, assignee: newAssignee, actor });
    if (updated.requires_ack === true) {
      await notifyAckRequired({ ctx, deps, ticket: updated, recipients: [{ ...newAssignee, participant: null }] });
    }
  }

  if (changes.length) {
    await recordEvent(ctx, {
      ticketId: id,
      kind: 'status_changed',
      actor,
      summary: changes.join(' · '),
      data: { status: updated.status, priority: updated.priority },
    });
    await ctx.audit?.record?.({
      entity: 'ticket',
      entityId: id,
      action: 'ticket_status_changed',
      actor: actor?.display_name ?? null,
      summary: `${current.number} · ${changes.join(' · ')}`,
      data: { from: current.status, to: updated.status },
    });
    publishTicketEvent(ctx, {
      type: 'ticket.status_changed',
      ticket: updated,
      participantIds: await participantIdsOf(ctx, id),
      actor,
      data: { status: updated.status, priority: updated.priority },
    });
    /* Un cambio de estado que otro tiene que saber (no al que lo provoca). */
    const cambio = `estado → ${OPS_TICKET_STATUS_LABELS[updated.status] ?? updated.status}`;
    await notifyStatus({
      ctx,
      deps,
      ticket: updated,
      recipients: await ticketRecipients(ctx, id, { excludeUserId: actor?.id ?? null }),
      actor,
      summary: cambio,
    });
  }

  return { ok: true, status: 200, ticket: projectTicket(updated, { can, myParticipant: await participantOf(ctx, id, actor?.id) }) };
}

/** Cierra el ticket (libera `active_key`, así se puede abrir otro del mismo flujo). */
export async function resolveTicket({ ctx, actor, can, id, resolution = '', cancelled = false, deps = null }) {
  if (!can('tickets.close')) {
    return { ok: false, status: 403, error: 'forbidden', message: 'No puedes cerrar tickets.' };
  }
  const current = await ctx.db.get('ops_tickets', id);
  if (!current) return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ese ticket no existe.' };
  const myParticipant = await participantOf(ctx, id, actor?.id);
  if (!seesAllTickets(can) && !myParticipant && current.assigned_user_id !== actor?.id) {
    return { ok: false, status: 403, error: 'forbidden', message: 'No participas en este ticket.' };
  }
  if (isFinal(current.status)) {
    return { ok: false, status: 409, error: 'ticket_closed', message: 'El ticket ya está cerrado.' };
  }
  const at = nowIso(ctx);
  const status = cancelled ? 'cancelled' : 'resolved';
  const updated = await ctx.db.update('ops_tickets', id, {
    status,
    waiting_on: null,
    /* Libera la clave: el mismo pedido puede tener otro ticket más adelante. */
    active_key: null,
    resolved_at: at,
    resolved_by_user_id: actor?.id ?? null,
    resolved_by_name: clean(actor?.display_name, 120),
    resolution: clean(resolution, 600),
    updated_at: at,
  });
  await recordEvent(ctx, {
    ticketId: id,
    kind: cancelled ? 'cancelled' : 'resolved',
    actor,
    summary: cancelled ? 'Ticket cancelado' : 'Ticket resuelto',
    data: { resolution: clean(resolution, 600) },
  });
  await ctx.audit?.record?.({
    entity: 'ticket',
    entityId: id,
    action: 'ticket_resolved',
    actor: actor?.display_name ?? null,
    summary: `${current.number} · ${cancelled ? 'cancelado' : 'resuelto'}`,
    data: { resolution: clean(resolution, 240) },
    idempotencyKey: `audit:ticket_resolved:${id}:${status}`,
  });
  publishTicketEvent(ctx, {
    type: 'ticket.resolved',
    ticket: updated,
    participantIds: await participantIdsOf(ctx, id),
    actor,
    data: { status },
  });
  await notifyStatus({
    ctx,
    deps,
    ticket: updated,
    recipients: await ticketRecipients(ctx, id, { excludeUserId: actor?.id ?? null }),
    actor,
    summary: cancelled ? 'ticket cancelado' : 'ticket resuelto',
  });
  return { ok: true, status: 200, ticket: projectTicket(updated, { can, myParticipant }) };
}

/** El ticket ACTIVO de un pedido (para el botón «abrir el ticket» del pedido). */
export async function activeTicketForOrder({ ctx, actor, can, orderId }) {
  const id = clean(orderId, 80);
  if (!id) return { ok: false, status: 422, error: 'order_required', message: 'Falta el pedido.' };
  const rows = await ctx.db.list('ops_tickets', { where: { entity_id: id }, limit: 50 });
  const active = rows.find((ticket) => !isFinal(ticket.status)) ?? null;
  if (!active) return { ok: true, ticket: null };
  const myParticipant = await participantOf(ctx, active.id, actor?.id);
  const visible = seesAllTickets(can) || Boolean(myParticipant) || active.assigned_user_id === actor?.id;
  return { ok: true, ticket: visible ? projectTicket(active, { can, myParticipant }) : null };
}

/**
 * Candidatos de pedido para vincular un ticket («crear desde un pedido»).
 *
 * Se busca por número, por id o por nombre del cliente. Devuelve SOLO lo justo
 * para reconocerlo en pantalla: sin teléfono ni dirección.
 */
export function searchOrderOptions({ rows = [], query = '', limit = 8 } = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle.length < 2) return [];
  const options = [];
  for (const row of rows) {
    if (String(row?.type ?? '') !== 'order_intent') continue;
    const snapshot = orderSnapshot(row) ?? {};
    const haystack = [snapshot.order_number, row.id, snapshot.customer_name].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(needle)) continue;
    options.push({
      id: row.id,
      orderNumber: snapshot.order_number ?? null,
      status: snapshot.order_status ?? row.status ?? null,
      customerName: snapshot.customer_name ?? null,
      total: snapshot.order_total ?? null,
    });
    if (options.length >= Math.min(Math.max(Number(limit) || 8, 1), 20)) break;
  }
  return options;
}

/* ------------------------------------------------- seguimiento de la TAREA */

/**
 * Acciones de seguimiento del trabajo (Etapa C).
 *
 * `acknowledge` es lo que la misión llama «task acknowledged»; NO se puede
 * deducir de haber leído el mensaje (leer es otra cosa y se prueba aparte).
 * `complete` marca el TRABAJO como hecho; el ticket sigue abierto hasta que
 * alguien lo resuelve (dos decisiones distintas, a propósito).
 */
export const OPS_TASK_ACTIONS = Object.freeze({
  acknowledge: { kind: 'ack', label: 'Acuse de recibo', permission: 'tickets.ack' },
  start: { kind: 'started', label: 'Trabajo iniciado', permission: 'tickets.reply' },
  progress: { kind: 'progress', label: 'Avance registrado', permission: 'tickets.reply' },
  issue: { kind: 'issue', label: 'Problema reportado', permission: 'tickets.reply' },
  help: { kind: 'help_requested', label: 'Ayuda solicitada', permission: 'tickets.reply' },
  complete: { kind: 'completed', label: 'Trabajo completado', permission: null },
  escalate: { kind: 'escalated', label: 'Escalado', permission: 'tickets.reply' },
});

/**
 * Ejecuta una acción de seguimiento. Todo queda en `ops_ticket_events` (línea de
 * tiempo, con quién y cuándo), en la auditoría y en el estado del ticket.
 */
export async function taskAction({ ctx, actor, can, id, action, note = '', idempotencyKey = null, deps = null }) {
  const spec = OPS_TASK_ACTIONS[String(action ?? '')];
  if (!spec) {
    return { ok: false, status: 422, error: 'invalid_action', message: 'Esa acción no existe.' };
  }
  const ticket = await ctx.db.get('ops_tickets', id);
  if (!ticket) return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ese ticket no existe.' };
  const myParticipant = await participantOf(ctx, id, actor?.id);
  const seeAll = seesAllTickets(can);
  const isAssignee = ticket.assigned_user_id === actor?.id;
  if (!seeAll && !myParticipant && !isAssignee) {
    return { ok: false, status: 403, error: 'forbidden', message: 'No participas en este ticket.' };
  }
  if (spec.permission && !can(spec.permission)) {
    return { ok: false, status: 403, error: 'forbidden', message: `No puedes ${spec.label.toLowerCase()}.` };
  }
  /*
   * COMPLETAR: lo puede marcar quien tiene permiso para actualizar el ticket o
   * el responsable del trabajo (aunque su rol solo tenga `tickets.ack`, como un
   * repartidor). Nunca el resto de participantes por su cuenta.
   */
  if (action === 'complete' && !(can('tickets.update') || can('tickets.ack')) ) {
    return { ok: false, status: 403, error: 'forbidden', message: 'No puedes dar el trabajo por terminado.' };
  }
  if (isFinal(ticket.status)) {
    return { ok: false, status: 409, error: 'ticket_closed', message: 'El ticket está cerrado.' };
  }

  const at = nowIso(ctx);
  const actorName = clean(actor?.display_name, 120);
  const task = { ...(ticket.task ?? {}) };
  const patch = { updated_at: at };
  const text = clean(note, 400);

  if (action === 'acknowledge') {
    if (task.acknowledged_at) {
      return { ok: true, status: 200, duplicate: true, ticket: projectTicket(ticket, { can, myParticipant }) };
    }
    task.acknowledged_at = at;
    task.acknowledged_by_user_id = actor?.id ?? null;
    task.acknowledged_by_name = actorName;
    /* Acusar implica haber visto el hilo hasta ahora. */
    if (myParticipant) {
      await ctx.db.update('ops_ticket_participants', myParticipant.id, {
        last_ack_seq: Number(ticket.last_seq ?? 0) || 0,
        last_read_seq: Math.max(Number(myParticipant.last_read_seq ?? 0) || 0, Number(ticket.last_seq ?? 0) || 0),
        unread_count: 0,
        acked_at: at,
        updated_at: at,
      });
    }
  } else if (action === 'start') {
    task.started_at = task.started_at ?? at;
    task.started_by_user_id = task.started_by_user_id ?? actor?.id ?? null;
    task.started_by_name = task.started_by_name ?? actorName;
    if (ticket.status === 'open') patch.status = 'in_progress';
    if (ticket.status === 'waiting') {
      patch.status = 'in_progress';
      patch.waiting_on = null;
    }
  } else if (action === 'progress') {
    task.last_progress_at = at;
    task.last_progress_by_user_id = actor?.id ?? null;
    task.last_progress_by_name = actorName;
    if (ticket.status === 'open') patch.status = 'in_progress';
  } else if (action === 'issue') {
    task.issue_count = (Number(task.issue_count ?? 0) || 0) + 1;
    task.last_issue_at = at;
    if (ticket.status === 'open') patch.status = 'in_progress';
  } else if (action === 'help') {
    task.help_count = (Number(task.help_count ?? 0) || 0) + 1;
    patch.status = 'waiting';
    patch.waiting_on = 'human';
  } else if (action === 'complete') {
    if (task.completed_at) {
      return { ok: true, status: 200, duplicate: true, ticket: projectTicket(ticket, { can, myParticipant }) };
    }
    task.completed_at = at;
    task.completed_by_user_id = actor?.id ?? null;
    task.completed_by_name = actorName;
  } else if (action === 'escalate') {
    task.escalated_at = at;
    task.escalated_by_user_id = actor?.id ?? null;
    task.escalated_by_name = actorName;
    task.escalation_reason = text;
    patch.status = 'waiting';
    patch.waiting_on = 'human';
    patch.priority = ticket.priority === 'urgent' ? 'urgent' : 'high';
  }

  patch.task = task;
  const updated = await ctx.db.update('ops_tickets', id, patch);

  await recordEvent(ctx, {
    ticketId: id,
    kind: spec.kind,
    actor,
    summary: text ? `${spec.label}: ${text}` : spec.label,
    data: { action, note: text },
    idempotencyKey: clean(idempotencyKey, 140),
  });
  await ctx.audit?.record?.({
    entity: 'ticket',
    entityId: id,
    action: action === 'escalate' ? 'ticket_escalated' : action === 'complete' ? 'ticket_task_completed' : 'ticket_task_updated',
    actor: actor?.display_name ?? null,
    summary: `${ticket.number} · ${spec.label}${text ? `: ${text.slice(0, 80)}` : ''}`,
    data: { action },
  });

  /* Evento SSE con nombre propio: los agentes futuros se suscriben a estos. */
  const eventType =
    action === 'acknowledge' ? 'task.acknowledged' : action === 'complete' ? 'task.completed' : action === 'escalate' ? 'ticket.escalated' : 'ticket.status_changed';
  publishTicketEvent(ctx, {
    type: eventType,
    ticket: updated,
    participantIds: await participantIdsOf(ctx, id),
    actor,
    data: {
      action,
      status: updated.status,
      task: {
        acknowledged_at: task.acknowledged_at ?? null,
        completed_at: task.completed_at ?? null,
      },
    },
  });

  if (action === 'escalate') {
    await notifyEscalation({ ctx, deps, ticket: updated, actor, reason: text });
  } else if (action === 'help') {
    await notifyEscalation({ ctx, deps, ticket: updated, actor, reason: text || 'Pidió ayuda con la tarea' });
  } else if (action === 'complete') {
    await notifyStatus({
      ctx,
      deps,
      ticket: updated,
      recipients: await ticketRecipients(ctx, id, { excludeUserId: actor?.id ?? null }),
      actor,
      summary: 'trabajo completado',
    });
  }

  return {
    ok: true,
    status: 200,
    duplicate: false,
    ticket: projectTicket(updated, { can, myParticipant: await participantOf(ctx, id, actor?.id) }),
  };
}

/**
 * Quita a alguien del ticket.
 *
 * No se puede quitar al RESPONSABLE (primero se reasigna) ni dejar el ticket sin
 * ninguna persona: siempre queda alguien que puede responder por él.
 */
export async function removeParticipant({ ctx, actor, can, id, userId }) {
  if (!can('tickets.participants.manage')) {
    return { ok: false, status: 403, error: 'forbidden', message: 'No puedes cambiar los participantes.' };
  }
  const ticket = await ctx.db.get('ops_tickets', id);
  if (!ticket) return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ese ticket no existe.' };
  const target = clean(userId, 80);
  if (!target) return { ok: false, status: 422, error: 'user_required', message: 'Elige la persona.' };
  if (ticket.assigned_user_id === target) {
    return {
      ok: false,
      status: 409,
      error: 'assignee_locked',
      message: 'Es el responsable del ticket: reasígnalo antes de quitarlo.',
    };
  }
  const rows = await ctx.db.list('ops_ticket_participants', { where: { ticket_id: id }, limit: 100 });
  const row = rows.find((item) => item.participant_id === target);
  if (!row) return { ok: false, status: 404, error: 'participant_not_found', message: 'Esa persona no participa.' };
  if (rows.length <= 1) {
    return { ok: false, status: 409, error: 'last_participant', message: 'El ticket no puede quedarse sin nadie.' };
  }
  await ctx.db.remove('ops_ticket_participants', row.id);
  await recordEvent(ctx, {
    ticketId: id,
    kind: 'participant_removed',
    actor,
    summary: `Quitado ${row.participant_name ?? target}`,
  });
  await ctx.audit?.record?.({
    entity: 'ticket',
    entityId: id,
    action: 'ticket_participant_removed',
    actor: actor?.display_name ?? null,
    summary: `${ticket.number} · −${row.participant_name ?? target}`,
  });
  publishTicketEvent(ctx, {
    type: 'ticket.updated',
    ticket,
    participantIds: await participantIdsOf(ctx, id),
    actor,
    data: { removed_user_id: target },
  });
  return {
    ok: true,
    status: 200,
    ticket: projectTicket(ticket, { can, myParticipant: await participantOf(ctx, id, actor?.id) }),
  };
}

/** Personas que se pueden añadir a un ticket (para el selector de la ficha). */
export async function participantDirectory({ ctx, can, q = '' }) {
  if (!can('tickets.participants.manage')) {
    return { ok: false, status: 403, error: 'forbidden', message: 'No puedes ver el equipo.' };
  }
  const needle = String(q ?? '').trim().toLowerCase();
  const users = await ctx.users.listUsers();
  return {
    ok: true,
    users: users
      .filter((user) => user.active !== false)
      .filter((user) => !needle || [user.display_name, user.username, user.role].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle)))
      .slice(0, 50)
      .map((user) => ({
        id: user.id,
        name: user.display_name ?? user.username,
        role: user.role,
      })),
  };
}

