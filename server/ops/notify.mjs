/**
 * CENTRO DE OPERACIONES — AVISOS INTERNOS (Etapa C).
 *
 * QUÉ RESUELVE
 * Decirle a la persona correcta que hay algo que hacer, aunque NO tenga el ticket
 * abierto. Reutiliza la infraestructura que ya funciona en el CRM:
 *   - `user_notifications` (con `idempotency_key` única → no hay duplicados),
 *   - Web Push (`push_jobs`, que guarda el estado real de cada envío),
 *   - el bus SSE (`ticket.*` / `message.*` / `task.*`), que solo llega a los
 *     participantes del ticket.
 *
 * REGLAS QUE NO SE ROMPEN
 *   1. El ticket es la fuente de verdad. Un aviso NUNCA sustituye al hilo: si el
 *      push falla o el teléfono está apagado, el mensaje sigue en su sitio.
 *   2. Un aviso por persona y por suceso: la clave de idempotencia lleva el
 *      suceso; reintentar no crea otro.
 *   3. El aviso no lleva datos que la persona no pueda ver: número, asunto y un
 *      recorte corto del texto. Nada de teléfonos ni direcciones.
 *   4. Avisar no puede tumbar la operación: todos los envíos van en try/catch.
 */

/** Tipos de aviso del centro (lista cerrada; se guardan en `user_notifications.type`). */
export const OPS_NOTIFICATION_TYPES = Object.freeze({
  ASSIGNED: 'OPS_TICKET_ASSIGNED',
  MESSAGE: 'OPS_TICKET_MESSAGE',
  MENTION: 'OPS_TICKET_MENTION',
  ACK_REQUIRED: 'OPS_TICKET_ACK_REQUIRED',
  DUE: 'OPS_TICKET_DUE',
  ESCALATED: 'OPS_TICKET_ESCALATED',
  STATUS: 'OPS_TICKET_STATUS',
  /* Etapa D: un agente pide permiso para algo irreversible. */
  APPROVAL: 'OPS_TICKET_APPROVAL',
});

/** Enlace directo que abre el ticket en el panel. */
export function ticketDeepLink(ticketId) {
  return `/admin/?v=ops&ticket=${encodeURIComponent(String(ticketId ?? ''))}`;
}

function clean(value, max = 160) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function preview(text, max = 110) {
  const value = clean(text, 400);
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Crea el aviso y, si es nuevo, intenta el push.
 *
 * `deps.notify` lo inyecta `crm-server` y hace las dos cosas en el orden
 * correcto: primero se PERSISTE el aviso, después se intenta el push. Si el
 * push falla, la fila queda con su estado (`push_jobs.status`) y el aviso sigue
 * visible en el panel.
 */
async function emit(ctx, deps, input) {
  try {
    if (typeof deps?.notify !== 'function') return null;
    const result = await deps.notify(input);
    return result?.notification ?? null;
  } catch (error) {
    console.error('[ops] no se pudo avisar:', error?.message ?? error);
    return null;
  }
}

/** Nombre visible de una persona (nunca el id crudo si hay nombre). */
function nameOf(user) {
  return clean(user?.display_name ?? user?.username, 80) ?? 'Alguien';
}

/**
 * Destinatarios de un ticket: sus participantes que existen y están activos.
 * Se excluye a quien provocó el suceso (no se avisa a sí mismo).
 */
export async function ticketRecipients(ctx, ticketId, { excludeUserId = null } = {}) {
  const participants = await ctx.db.list('ops_ticket_participants', { where: { ticket_id: ticketId }, limit: 100 });
  const users = await ctx.users.listUsers();
  const byId = new Map(users.filter((user) => user.active !== false).map((user) => [user.id, user]));
  const rows = [];
  for (const participant of participants) {
    const user = byId.get(participant.participant_id);
    if (!user) continue;
    if (excludeUserId && user.id === excludeUserId) continue;
    rows.push({ ...user, participant });
  }
  return rows;
}

/** Administración activa: quien puede ver todos los tickets. */
async function adminRecipients(ctx) {
  const users = await ctx.users.listUsers();
  return users.filter((user) => user.active !== false && user.role === 'ADMIN');
}

/* ------------------------------------------------------------ avisos */

/** El ticket se asignó a alguien. */
export async function notifyAssigned({ ctx, deps, ticket, assignee, actor }) {
  if (!assignee?.id) return null;
  const created = await emit(ctx, deps, {
    recipientUserId: assignee.id,
    type: OPS_NOTIFICATION_TYPES.ASSIGNED,
    title: `${ticket.number} · te toca`,
    body: `${nameOf(actor)} te asignó «${clean(ticket.title, 90)}»`,
    entityType: 'ticket',
    entityId: ticket.id,
    deepLink: ticketDeepLink(ticket.id),
    data: { ticket_id: ticket.id, ticket_number: ticket.number, assigned_by: actor?.id ?? null, vibrate: [120, 60, 120] },
    /* La versión del ticket entra en la clave: reasignar al MISMO no re-avisa. */
    idempotencyKey: `ops-assign:${ticket.id}:${assignee.id}:${ticket.updated_at ?? ticket.created_at}`,
  });
  return created;
}

/**
 * Mensaje nuevo en el hilo.
 *
 * @param {object} input
 * @param {any[]} input.recipients  filas de `ticketRecipients` (sin el autor)
 * @param {string[]} [input.mentionedIds]  a quién se mencionó con `@`
 */
export async function notifyMessage({ ctx, deps, ticket, message, recipients = [], mentionedIds = [] }) {
  const created = [];
  for (const recipient of recipients) {
    const mentioned = mentionedIds.includes(recipient.id);
    const note = await emit(ctx, deps, {
      recipientUserId: recipient.id,
      type: mentioned ? OPS_NOTIFICATION_TYPES.MENTION : OPS_NOTIFICATION_TYPES.MESSAGE,
      title: mentioned ? `${ticket.number} · te mencionaron` : `${ticket.number} · ${clean(ticket.title, 60)}`,
      body: `${clean(message.author_name, 60) ?? 'Alguien'}: ${preview(message.body)}`,
      entityType: 'ticket',
      entityId: ticket.id,
      deepLink: ticketDeepLink(ticket.id),
      data: {
        ticket_id: ticket.id,
        ticket_number: ticket.number,
        message_id: message.id,
        seq: message.seq,
        mentioned,
        vibrate: mentioned ? [200, 80, 200] : null,
      },
      /* Un aviso por mensaje y persona: reintentar el envío no repite. */
      idempotencyKey: `ops-msg:${message.id}:${recipient.id}`,
    });
    if (note && recipient.participant?.id) {
      /* «Avisado hasta #seq» se guarda en la participación (para la ficha). */
      await ctx.db
        .update('ops_ticket_participants', recipient.participant.id, {
          last_notified_seq: Number(message.seq) || 0,
          last_notified_at: ctx.clock?.()?.toISOString?.() ?? new Date().toISOString(),
        })
        .catch(() => null);
    }
    if (note) created.push(note);
  }
  return created;
}

/** El ticket pide acuse explícito a quien lo tiene asignado. */
export async function notifyAckRequired({ ctx, deps, ticket, recipients = [] }) {
  const created = [];
  for (const recipient of recipients) {
    const note = await emit(ctx, deps, {
      recipientUserId: recipient.id,
      type: OPS_NOTIFICATION_TYPES.ACK_REQUIRED,
      title: `${ticket.number} · confirma que lo viste`,
      body: `«${clean(ticket.title, 90)}» necesita acuse de recibo`,
      entityType: 'ticket',
      entityId: ticket.id,
      deepLink: ticketDeepLink(ticket.id),
      data: { ticket_id: ticket.id, ticket_number: ticket.number, requires_ack: true },
      idempotencyKey: `ops-ack-req:${ticket.id}:${recipient.id}`,
    });
    if (note) created.push(note);
  }
  return created;
}

/**
 * Un agente pide aprobación humana para una acción con efecto irreversible.
 *
 * Se avisa SOLO a quien puede decidirla (`requiredPermission`), que por
 * contrato es administración. El aviso no incluye el payload completo de la
 * herramienta: dice cuál es y en qué ticket, y la decisión se toma en el panel,
 * donde se ven los parámetros exactos.
 */
export async function notifyApprovalRequested({ ctx, deps, ticket, approval }) {
  const admins = await adminRecipients(ctx);
  const created = [];
  for (const recipient of admins) {
    const note = await emit(ctx, deps, {
      recipientUserId: recipient.id,
      type: OPS_NOTIFICATION_TYPES.APPROVAL,
      title: `${ticket.number} · una IA pide permiso`,
      body: `«${clean(approval.tool, 60)}» espera tu aprobación en «${clean(ticket.title, 60)}»`,
      entityType: 'ticket',
      entityId: ticket.id,
      deepLink: ticketDeepLink(ticket.id),
      data: {
        ticket_id: ticket.id,
        ticket_number: ticket.number,
        approval_id: approval.id,
        tool: approval.tool,
        vibrate: [140, 60, 140],
      },
      idempotencyKey: `ops-approval:${approval.id}:${recipient.id}`,
    });
    if (note) created.push(note);
  }
  return created;
}

/** Cambio de estado relevante que otro debe saber. */export async function notifyStatus({ ctx, deps, ticket, recipients = [], actor, summary }) {
  const created = [];
  for (const recipient of recipients) {
    const note = await emit(ctx, deps, {
      recipientUserId: recipient.id,
      type: OPS_NOTIFICATION_TYPES.STATUS,
      title: `${ticket.number} · ${clean(summary, 60) ?? 'cambió de estado'}`,
      body: `${nameOf(actor)}: ${clean(ticket.title, 80)}`,
      entityType: 'ticket',
      entityId: ticket.id,
      deepLink: ticketDeepLink(ticket.id),
      data: { ticket_id: ticket.id, ticket_number: ticket.number, status: ticket.status },
      idempotencyKey: `ops-status:${ticket.id}:${ticket.status}:${ticket.updated_at}`,
    });
    if (note) created.push(note);
  }
  return created;
}

/** Escalamiento: a los participantes y a administración (nadie más). */
export async function notifyEscalation({ ctx, deps, ticket, actor, reason }) {
  const participants = await ticketRecipients(ctx, ticket.id, { excludeUserId: actor?.id ?? null });
  const admins = await adminRecipients(ctx);
  const seen = new Set();
  const targets = [];
  for (const row of [...participants, ...admins]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    targets.push(row);
  }
  const created = [];
  for (const recipient of targets) {
    const note = await emit(ctx, deps, {
      recipientUserId: recipient.id,
      type: OPS_NOTIFICATION_TYPES.ESCALATED,
      title: `${ticket.number} · escalado`,
      body: `${nameOf(actor)} pidió ayuda: ${preview(reason, 90) || 'sin detalle'}`,
      entityType: 'ticket',
      entityId: ticket.id,
      deepLink: ticketDeepLink(ticket.id),
      data: { ticket_id: ticket.id, ticket_number: ticket.number, reason: clean(reason, 160), vibrate: [250, 100, 250] },
      idempotencyKey: `ops-escalate:${ticket.id}:${recipient.id}:${ticket.task?.escalated_at ?? ticket.updated_at}`,
    });
    if (note) created.push(note);
  }
  return created;
}

/**
 * PASADA DE PLAZOS (la llama el scheduler, no el navegador).
 *
 * Avisa UNA vez por cada `due_at` de cada ticket vencido y pendiente. Repetir la
 * pasada no repite el aviso (la clave lleva el propio plazo). No hace nada si no
 * hay tickets con plazo: es barato llamarla en cada vuelta del scheduler.
 */
export async function opsDeadlineTick({ ctx, deps, now = null } = {}) {
  const clock = ctx.clock ?? (() => new Date());
  const at = now instanceof Date ? now : clock();
  const nowMs = at.getTime();
  const rows = await ctx.db.list('ops_tickets', { by: 'created_at', order: 'desc', limit: 400 });
  const pending = rows.filter(
    (ticket) => ticket.due_at && !['resolved', 'cancelled'].includes(String(ticket.status)),
  );
  let notified = 0;
  for (const ticket of pending) {
    const due = Date.parse(String(ticket.due_at));
    if (!Number.isFinite(due) || due > nowMs) continue;
    /* Ya se avisó de ESTE plazo: no se repite. */
    if (ticket.due_notified_for && ticket.due_notified_for === ticket.due_at) continue;
    const recipients = await ticketRecipients(ctx, ticket.id);
    if (!recipients.length) continue;
    const created = [];
    for (const recipient of recipients) {
      const note = await emit(ctx, deps, {
        recipientUserId: recipient.id,
        type: OPS_NOTIFICATION_TYPES.DUE,
        title: `${ticket.number} · plazo vencido`,
        body: `«${clean(ticket.title, 90)}» venció a las ${new Date(due).toISOString().slice(11, 16)} UTC`,
        entityType: 'ticket',
        entityId: ticket.id,
        deepLink: ticketDeepLink(ticket.id),
        data: { ticket_id: ticket.id, ticket_number: ticket.number, due_at: ticket.due_at },
        idempotencyKey: `ops-due:${ticket.id}:${ticket.due_at}:${recipient.id}`,
      });
      if (note) created.push(note);
    }
    await ctx.db.update('ops_tickets', ticket.id, {
      due_notified_for: ticket.due_at,
      due_notified_at: at.toISOString(),
    });
    notified += created.length;
  }
  return { checked: pending.length, notified };
}
