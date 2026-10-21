/**
 * CENTRO DE OPERACIONES — MENSAJES INTERNOS (Etapa B).
 *
 * QUÉ RESUELVE
 * El hilo de un ticket: escribir, leer, ordenar y saber hasta dónde ha leído
 * cada persona. Nada de esto toca WhatsApp ni la conversación del cliente.
 *
 * TRES GARANTÍAS
 *   1. IDEMPOTENCIA: `client_key` es única. Un doble toque, un reintento de red
 *      o un reenvío no escriben el mensaje dos veces; el segundo intento devuelve
 *      el mensaje que ya existía.
 *   2. ORDEN: `seq` se asigna DENTRO de un cerrojo por ticket y se guarda con
 *      ceros delante (`seq_key`) para que ordenar por la columna indexada dé el
 *      mismo resultado que ordenar por número.
 *   3. ESTADOS SEPARADOS: leer (`last_read_seq`) no es acusar recibo
 *      (`last_ack_seq`) y ninguna de las dos cosas completa la tarea. Esa
 *      distinción es la que exige la Fase 6 y aquí se cumple desde el modelo.
 */

import { randomBytes } from 'node:crypto';
import {
  OPS_FINAL_STATUSES,
  addParticipant,
  participantIdsOf,
  participantOf,
  projectMessage,
  projectTicket,
  publishTicketEvent,
  taskAction,
} from './tickets.mjs';
import { notifyMessage, ticketRecipients } from './notify.mjs';

const MAX_BODY = 4000;

/**
 * Cerrojo por ticket para repartir los números de secuencia sin carreras.
 *
 * Es un mutex EN MEMORIA: el CRM corre en un solo proceso Node. Si algún día hay
 * varias réplicas, esta asignación pasa a `SELECT … FOR UPDATE` sobre el ticket.
 */
const chains = new Map();

function withTicketLock(ticketId, task) {
  const previous = chains.get(ticketId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tracked = run.then(
    () => {},
    () => {},
  );
  chains.set(ticketId, tracked);
  tracked.then(() => {
    if (chains.get(ticketId) === tracked) chains.delete(ticketId);
  });
  return run;
}

function clean(value, max = 240) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\r\n/g, '\n').trim();
  return text ? text.slice(0, max) : null;
}

function nowIso(ctx) {
  const clock = ctx?.clock ?? (() => new Date());
  return clock().toISOString();
}

function seqKeyOf(seq) {
  return String(Math.max(0, Number(seq) || 0)).padStart(8, '0');
}

function isFinal(status) {
  return OPS_FINAL_STATUSES.includes(String(status ?? ''));
}

/** Vista previa corta para la bandeja (nunca el cuerpo entero). */
function previewOf(kind, body) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return kind === 'text' ? null : `(${kind})`;
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/** Texto sin acentos ni mayúsculas, para comparar nombres al mencionar. */
function foldText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * ¿A quién se mencionó con `@`?
 *
 * Se compara el nombre visible sin acentos ni mayúsculas (en español, un `\b`
 * ASCII no sirve: lo tenemos comprobado). Solo cuentan los PARTICIPANTES del
 * ticket: mencionar a alguien de fuera no avisa a nadie.
 */
export function mentionedUserIds(body, participants = []) {
  const text = foldText(body);
  if (!text.includes('@')) return [];
  const found = [];
  for (const participant of participants) {
    /*
     * OJO: la fila de participación tiene DOS identificadores (`id` de la fila y
     * `participant_id` de la PERSONA). Aquí hace falta el de la persona, que es
     * el que compara con el destinatario del aviso.
     */
    const id = participant?.participant_id ?? participant?.userId ?? participant?.id;
    const name = foldText(participant?.name ?? participant?.display_name ?? participant?.participant_name);
    if (!id || name.length < 3) continue;
    if (text.includes(`@${name}`)) found.push(id);
  }
  return found;
}

/** ¿Esta persona puede leer/escribir en el ticket? */
function accessOf({ can, actor, ticket, myParticipant }) {
  const seeAll = Boolean(can('tickets.read_all'));
  const visible = seeAll || Boolean(myParticipant) || ticket.assigned_user_id === actor?.id;
  return { seeAll, visible };
}

/**
 * Escribe un mensaje humano en el hilo.
 *
 * @param {object} input
 * @param {any} input.ctx
 * @param {any} input.actor
 * @param {(p: string) => boolean} input.can
 * @param {string} input.ticketId
 * @param {string} input.body
 * @param {string} [input.clientKey]  idempotencia del navegador
 */
export async function postMessage({
  ctx,
  actor,
  can,
  ticketId,
  body,
  clientKey = null,
  deps = null,
  /* Etapa D: un AGENTE también escribe, pero con su propia identidad y tipo. */
  authorType = 'user',
  kind = 'text',
  meta = null,
}) {
  if (!can('tickets.reply')) {
    return { ok: false, status: 403, error: 'forbidden', message: 'No puedes escribir en este ticket.' };
  }
  const id = clean(ticketId, 80);
  const text = String(body ?? '').replace(/\r\n/g, '\n').trim();
  if (!id) return { ok: false, status: 422, error: 'ticket_required', message: 'Falta el ticket.' };
  if (!text) return { ok: false, status: 422, error: 'empty_message', message: 'Escribe un mensaje.' };
  if (text.length > MAX_BODY) {
    return { ok: false, status: 422, error: 'message_too_long', message: `El mensaje supera ${MAX_BODY} caracteres.` };
  }
  /* El cliente debe mandar su clave; si no, se genera (ese envío no será idempotente). */
  const key = clean(clientKey, 140) ?? `opm:${id}:${randomBytes(10).toString('hex')}`;

  /*
   * Respuesta repetida: si esta clave ya existe se devuelve el mensaje guardado.
   * Comprobarlo ANTES del cerrojo ahorra trabajo en el caso normal de reintento.
   */
  const already = await ctx.db.findBy('ops_ticket_messages', 'client_key', key);
  if (already) {
    const ticket = await ctx.db.get('ops_tickets', already.ticket_id);
    const myParticipant = await participantOf(ctx, already.ticket_id, actor?.id);
    return {
      ok: true,
      status: 200,
      duplicate: true,
      message: projectMessage(already),
      ticket: projectTicket(ticket, { can, myParticipant }),
    };
  }

  return withTicketLock(id, async () => {
    const ticket = await ctx.db.get('ops_tickets', id);
    if (!ticket) return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ese ticket no existe.' };
    const myParticipant = await participantOf(ctx, id, actor?.id);
    const { seeAll, visible } = accessOf({ can, actor, ticket, myParticipant });
    if (!visible) return { ok: false, status: 403, error: 'forbidden', message: 'No participas en este ticket.' };
    if (isFinal(ticket.status)) {
      return { ok: false, status: 409, error: 'ticket_closed', message: 'El ticket está cerrado: no admite mensajes.' };
    }
    /*
     * Escribir en un ticket en el que solo se mira (administración) crea la
     * participación: a partir de aquí le llegan los avisos del hilo.
     */
    if (!myParticipant && seeAll) {
      await addParticipant(ctx, {
        ticketId: id,
        userId: actor?.id,
        name: actor?.display_name,
        role: 'watcher',
        actor,
      });
    }

    const seq = (Number(ticket.last_seq ?? 0) || 0) + 1;
    const at = nowIso(ctx);
    const doc = {
      id: `opm_${randomBytes(10).toString('hex')}`,
      ticket_id: id,
      seq,
      seq_key: seqKeyOf(seq),
      author_type: authorType,
      author_id: actor?.id ?? null,
      author_name: clean(actor?.display_name, 120),
      kind,
      body: text,
      client_key: key,
      created_at: at,
      meta: meta && typeof meta === 'object' ? meta : null,
    };
    const inserted = await ctx.db.insert('ops_ticket_messages', doc);
    if (inserted?.duplicate) {
      const existing = await ctx.db.findBy('ops_ticket_messages', 'client_key', key);
      const fresh = await ctx.db.get('ops_tickets', id);
      return {
        ok: true,
        status: 200,
        duplicate: true,
        message: projectMessage(existing),
        ticket: projectTicket(fresh, { can, myParticipant: await participantOf(ctx, id, actor?.id) }),
      };
    }

    const patch = {
      last_seq: seq,
      last_message_at: at,
      last_message_preview: previewOf(kind, text),
      last_message_kind: kind,
      last_author_type: authorType,
      last_author_id: actor?.id ?? null,
      last_author_name: clean(actor?.display_name, 120),
      message_count: (Number(ticket.message_count ?? 0) || 0) + 1,
      updated_at: at,
    };
    /*
     * Responder retira el ticket de «esperando persona» SOLO si responde una
     * persona. Un mensaje de un agente no puede dar por atendida una espera
     * humana (sería justo lo contrario de lo que significa).
     */
    if (ticket.status === 'open') patch.status = 'in_progress';
    if (authorType === 'user' && ticket.status === 'waiting' && ticket.waiting_on !== 'agent') {
      patch.status = 'in_progress';
      patch.waiting_on = null;
    }
    const updated = await ctx.db.update('ops_tickets', id, patch);

    /*
     * CONTADOR DE NO LEÍDOS + AVISOS (Etapa C).
     *
     * Se hace DENTRO del cerrojo del ticket: dos mensajes simultáneos no pueden
     * pisarse el contador. El autor no se avisa a sí mismo.
     */
    const participants = await ctx.db.list('ops_ticket_participants', { where: { ticket_id: id }, limit: 100 });
    for (const participant of participants) {
      if (participant.participant_id === actor?.id) continue;
      await ctx.db.update('ops_ticket_participants', participant.id, {
        unread_count: (Number(participant.unread_count ?? 0) || 0) + 1,
        updated_at: at,
      });
    }
    const recipients = await ticketRecipients(ctx, id, { excludeUserId: actor?.id ?? null });
    const mentioned = mentionedUserIds(text, participants);
    await notifyMessage({ ctx, deps, ticket: updated, message: doc, recipients, mentionedIds: mentioned });

    await ctx.audit?.record?.({
      entity: 'ticket',
      entityId: id,
      action: 'ticket_message_sent',
      actor: actor?.display_name ?? null,
      summary: `${ticket.number} · mensaje`,
      idempotencyKey: `audit:ticket_message_sent:${doc.id}`,
    });

    publishTicketEvent(ctx, {
      type: 'message.created',
      ticket: updated,
      participantIds: await participantIdsOf(ctx, id),
      actor,
      data: { seq, author_type: authorType, preview: patch.last_message_preview, message_id: doc.id, mentioned },
    });

    return {
      ok: true,
      status: 201,
      duplicate: false,
      message: projectMessage(doc),
      ticket: projectTicket(updated, { can, myParticipant: await participantOf(ctx, id, actor?.id) }),
    };
  });
}

/**
 * Marca leído hasta `seq`.
 *
 * Leer NO acusa recibo ni completa nada: solo mueve el cursor de lectura de esta
 * persona. `seq` nunca retrocede.
 */
export async function markRead({ ctx, actor, can, ticketId, seq }) {
  const id = clean(ticketId, 80);
  if (!id) return { ok: false, status: 422, error: 'ticket_required', message: 'Falta el ticket.' };
  const ticket = await ctx.db.get('ops_tickets', id);
  if (!ticket) return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ese ticket no existe.' };
  let myParticipant = await participantOf(ctx, id, actor?.id);
  const { seeAll, visible } = accessOf({ can, actor, ticket, myParticipant });
  if (!visible) return { ok: false, status: 403, error: 'forbidden', message: 'No participas en este ticket.' };
  if (!myParticipant && seeAll) {
    await addParticipant(ctx, { ticketId: id, userId: actor?.id, name: actor?.display_name, role: 'watcher', actor });
    myParticipant = await participantOf(ctx, id, actor?.id);
  }
  const current = Number(myParticipant?.last_read_seq ?? 0) || 0;
  const wanted = Number(seq);
  const next = Number.isFinite(wanted) && wanted > current ? Math.min(wanted, Number(ticket.last_seq ?? 0) || 0) : current;
  if (next > current) {
    /*
     * El contador de no leídos se recalcula en el SERVIDOR: si se leyó todo, 0;
     * si se leyó solo una parte, se cuentan los mensajes que quedan por detrás
     * del cursor (una consulta de un solo ticket, barata).
     */
    const lastSeq = Number(ticket.last_seq ?? 0) || 0;
    let restantes = 0;
    if (next < lastSeq) {
      const rows = await ctx.db.list('ops_ticket_messages', { where: { ticket_id: id }, limit: 500 });
      restantes = rows.filter((row) => (Number(row.seq) || 0) > next && row.author_id !== actor?.id).length;
    }
    await ctx.db.update('ops_ticket_participants', myParticipant.id, {
      last_read_seq: next,
      last_read_at: nowIso(ctx),
      unread_count: restantes,
      updated_at: nowIso(ctx),
    });
    /* Los avisos de ESTE ticket ya no tienen sentido en la campana. */
    await markTicketNotificationsRead(ctx, { ticketId: id, userId: actor?.id, at: nowIso(ctx) });
    publishTicketEvent(ctx, {
      type: 'message.read',
      ticket,
      participantIds: await participantIdsOf(ctx, id),
      actor,
      data: { seq: next, user_id: actor?.id ?? null },
    });
  }
  return { ok: true, status: 200, lastReadSeq: next, lastAckSeq: Number(myParticipant?.last_ack_seq ?? 0) || 0 };
}

/**
 * Marca como leídos los avisos del panel de este ticket para esta persona.
 *
 * Si abrió el ticket y lo leyó, la campana no puede seguir diciendo que hay algo
 * nuevo. Es una actualización acotada: `entity_id` está indexado.
 */
export async function markTicketNotificationsRead(ctx, { ticketId, userId, at = null }) {
  if (!ticketId || !userId) return 0;
  const stamp = at ?? nowIso(ctx);
  const rows = await ctx.db.list('user_notifications', { where: { entity_id: ticketId }, limit: 500 });
  let updated = 0;
  for (const row of rows) {
    if (row.recipient_user_id !== userId) continue;
    if (row.status === 'read') continue;
    if (String(row.entity_type ?? '') !== 'ticket') continue;
    await ctx.db.update('user_notifications', row.id, { status: 'read', read_at: stamp, updated_at: stamp });
    updated += 1;
  }
  return updated;
}

/**
 * Acuse explícito de recibo (compatibilidad con la Etapa B).
 *
 * Ahora DELEGA en la acción de tarea `acknowledge`: una sola forma de acusar,
 * un solo sitio donde se guarda el estado y un solo evento. Antes había dos
 * caminos que podían separarse con el tiempo.
 */
export async function acknowledge({ ctx, actor, can, ticketId, seq, note = '', deps = null }) {
  const id = clean(ticketId, 80);
  if (!id) return { ok: false, status: 422, error: 'ticket_required', message: 'Falta el ticket.' };
  const result = await taskAction({ ctx, actor, can, id, action: 'acknowledge', note, deps });
  if (!result.ok) return result;
  const participant = await participantOf(ctx, id, actor?.id);
  return {
    ok: true,
    status: 200,
    lastAckSeq: Number(participant?.last_ack_seq ?? 0) || 0,
    lastReadSeq: Number(participant?.last_read_seq ?? 0) || 0,
    ticket: result.ticket,
  };
}
