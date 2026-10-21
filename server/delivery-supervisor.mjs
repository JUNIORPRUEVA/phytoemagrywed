/**
 * SUPERVISOR INTELIGENTE DE DELIVERY (FULLTECH / PHYTOEMAGRY)
 *
 * QUÉ ES
 * Un motor DETERMINISTA que vigila cada pedido con responsable asignado —interno
 * (usuario AGENT/DELIVERY) o externo (contacto de reparto guardado)— y hace que
 * ninguno se quede olvidado: avisa al repartidor, interpreta su respuesta,
 * pospone con fecha real, escala a administración y deja todo registrado.
 *
 * REGLAS QUE ESTE ARCHIVO RESPETA (y hace cumplir)
 * -----------------------------------------------
 *  1. El repartidor NUNCA mueve el pedido por lo que diga una IA: primero se
 *     valida identidad (teléfono guardado), asignación, estado actual y
 *     transición permitida. La IA (DeepSeek) solo PROPONE una intención.
 *  2. «Entregado» no cierra nada: pide confirmación explícita. Solo la
 *     confirmación ejecuta la transición oficial (inventario, venta, avisos).
 *  3. No se simula un envío: si WhatsApp no puede (ventana cerrada y plantilla
 *     sin aprobar), el recordatorio queda como `pending`/`failed` y se dice.
 *  4. No se insiste sin fin: máximo de intentos, horario de contacto, pausa si
 *     el repartidor responde y escalamiento a administración. Después se para
 *     de escribir y la incidencia sigue abierta en el panel.
 *  5. Idempotencia por clave única: reintentos del webhook o dos pasadas del
 *     scheduler no duplican avisos ni eventos.
 *  6. Datos mínimos: al repartidor se le manda pedido, acción y enlace interno.
 *     Nunca costos, márgenes ni información de otros clientes.
 *  7. Si hay varios pedidos abiertos NO se adivina a cuál se refiere.
 */

import { randomUUID } from 'node:crypto';
import { toE164 } from './whatsapp.mjs';
import { COURIER_STATUS, courierOf, savedCourierContacts } from './delivery-courier.mjs';

/** Ajustes del supervisor (un documento en la colección `settings`). */
export const SUPERVISOR_SETTINGS_KEY = 'delivery_supervisor';
/**
 * LATIDO DE LA ÚLTIMA PASADA.
 *
 * Un solo documento que se sobrescribe: permite responder «¿cuándo corrió el
 * supervisor?» con un dato real del backend, sin llenar la bitácora de ruido
 * (una pasada cada 30 s son miles de filas al día). El panel lo muestra tal cual.
 */
export const SUPERVISOR_HEARTBEAT_KEY = 'delivery_supervisor_heartbeat';
/** Bitácora persistente del supervisor (sobrevive reinicios). */
export const SUPERVISOR_EVENTS = 'delivery_supervision_events';
/** Plantilla del recordatorio al repartidor (crear en Meta; si no, queda pendiente). */
export const SUPERVISOR_REMINDER_TEMPLATE = 'phyto_supervisor_recordatorio_v1';
/** Plantilla de escalamiento a administración (ya existe en el catálogo). */
export const SUPERVISOR_ESCALATION_TEMPLATE = 'phyto_delivery_sin_atender_admin_v1';

const CLOSED_STATUSES = Object.freeze(['entregado', 'cancelado', 'perdido']);
const ACTIVE_PICKUP_STATUSES = Object.freeze(['pending_purchase', 'assigned', 'on_the_way']);
const DEFAULT_TIME_ZONE = 'America/Santo_Domingo';
const MAX_TEXT = 300;
/**
 * Tope de administradores avisados por WhatsApp en UN escalamiento. Es un freno
 * de frecuencia: una incidencia no puede convertirse en una ráfaga de mensajes.
 */
const MAX_ESCALATION_RECIPIENTS = 4;

export const SUPERVISOR_STAGES = Object.freeze({
  CLOSED: 'closed',
  NO_RESPONSIBLE: 'no_responsible',
  NOT_CONFIRMED: 'not_confirmed',
  SEND_FAILED: 'send_failed',
  PENDING_START: 'pending_start',
  PICKUP_PENDING: 'pickup_pending',
  IN_TRANSIT: 'in_transit',
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
  ISSUE: 'issue',
  POSTPONED: 'postponed',
});

/** Texto de la SIGUIENTE ACCIÓN. Es lo único que se le pide al repartidor. */
export const STAGE_NEXT_ACTION = Object.freeze({
  no_responsible: 'Asignar un responsable',
  not_confirmed: 'Enviar el pedido al repartidor',
  send_failed: 'Reenviar el pedido (falló el envío)',
  pending_start: 'Iniciar la entrega',
  pickup_pending: 'Recoger los productos en la tienda',
  in_transit: 'Entregar y confirmar',
  awaiting_confirmation: 'Confirmar la entrega',
  issue: 'Resolver la incidencia',
  postponed: 'Retomar la entrega en la fecha acordada',
  closed: 'Sin acción',
});

export const DEFAULT_SUPERVISOR_SETTINGS = Object.freeze({
  enabled: true,
  firstReminderMinutes: 10,
  followUpMinutes: 30,
  maxAttempts: 3,
  lateAfterMinutes: 90,
  escalateAfterMinutes: 120,
  contactFromHour: 8,
  contactToHour: 20,
  internalNotifications: true,
  whatsAppReminders: true,
  useDeepSeek: true,
  postponeMaxDays: 7,
  postponeMaxCount: 3,
  dailySummaryHour: 18,
  /*
   * ACTIVACIÓN CONTROLADA.
   *
   * `activationMode: 'new'` (por defecto) solo supervisa pedidos asignados a
   * partir de `activatedAt`; los antiguos no se tocan salvo autorización expresa
   * (`includeOldOrders`) o allowlist. `maxRemindersPerTick` evita que el primer
   * arranque dispare cientos de mensajes de golpe.
   */
  activationMode: 'new',
  activatedAt: null,
  includeOldOrders: false,
  includeOrderIds: [],
  maxRemindersPerTick: 8,
  maxEscalationsPerTick: 10,
});

const clean = (value, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null;
const longText = (value, max = 600) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null;

/** Texto comparable: sin acentos, sin mayúsculas. (`\b` de JS es ASCII.) */
const fold = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

function bounded(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function flag(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return ['1', 'true', 'si', 'sí', 'yes', 'on'].includes(value.trim().toLowerCase());
  return value === true;
}

/** Ajustes normalizados. Un valor ausente NO inventa nada: usa el de fábrica. */
export function normalizeSupervisorSettings(raw = null) {
  const source = raw && typeof raw === 'object' && raw.settings && typeof raw.settings === 'object' ? raw.settings : raw ?? {};
  const read = (camel, snake, fallback) => source[camel] ?? source[snake] ?? fallback;
  return {
    enabled: flag(source.enabled, DEFAULT_SUPERVISOR_SETTINGS.enabled),
    firstReminderMinutes: bounded(read('firstReminderMinutes', 'first_reminder_minutes', DEFAULT_SUPERVISOR_SETTINGS.firstReminderMinutes), DEFAULT_SUPERVISOR_SETTINGS.firstReminderMinutes, 1, 24 * 60),
    followUpMinutes: bounded(read('followUpMinutes', 'follow_up_minutes', DEFAULT_SUPERVISOR_SETTINGS.followUpMinutes), DEFAULT_SUPERVISOR_SETTINGS.followUpMinutes, 5, 24 * 60),
    maxAttempts: bounded(read('maxAttempts', 'max_attempts', DEFAULT_SUPERVISOR_SETTINGS.maxAttempts), DEFAULT_SUPERVISOR_SETTINGS.maxAttempts, 1, 10),
    lateAfterMinutes: bounded(read('lateAfterMinutes', 'late_after_minutes', DEFAULT_SUPERVISOR_SETTINGS.lateAfterMinutes), DEFAULT_SUPERVISOR_SETTINGS.lateAfterMinutes, 15, 7 * 24 * 60),
    escalateAfterMinutes: bounded(read('escalateAfterMinutes', 'escalate_after_minutes', DEFAULT_SUPERVISOR_SETTINGS.escalateAfterMinutes), DEFAULT_SUPERVISOR_SETTINGS.escalateAfterMinutes, 15, 30 * 24 * 60),
    contactFromHour: bounded(read('contactFromHour', 'contact_from_hour', DEFAULT_SUPERVISOR_SETTINGS.contactFromHour), DEFAULT_SUPERVISOR_SETTINGS.contactFromHour, 0, 23),
    contactToHour: bounded(read('contactToHour', 'contact_to_hour', DEFAULT_SUPERVISOR_SETTINGS.contactToHour), DEFAULT_SUPERVISOR_SETTINGS.contactToHour, 0, 23),
    internalNotifications: flag(read('internalNotifications', 'internal_notifications', DEFAULT_SUPERVISOR_SETTINGS.internalNotifications), DEFAULT_SUPERVISOR_SETTINGS.internalNotifications),
    whatsAppReminders: flag(read('whatsAppReminders', 'whatsapp_reminders', DEFAULT_SUPERVISOR_SETTINGS.whatsAppReminders), DEFAULT_SUPERVISOR_SETTINGS.whatsAppReminders),
    useDeepSeek: flag(read('useDeepSeek', 'use_deepseek', DEFAULT_SUPERVISOR_SETTINGS.useDeepSeek), DEFAULT_SUPERVISOR_SETTINGS.useDeepSeek),
    postponeMaxDays: bounded(read('postponeMaxDays', 'postpone_max_days', DEFAULT_SUPERVISOR_SETTINGS.postponeMaxDays), DEFAULT_SUPERVISOR_SETTINGS.postponeMaxDays, 1, 60),
    postponeMaxCount: bounded(read('postponeMaxCount', 'postpone_max_count', DEFAULT_SUPERVISOR_SETTINGS.postponeMaxCount), DEFAULT_SUPERVISOR_SETTINGS.postponeMaxCount, 1, 10),
    dailySummaryHour: bounded(read('dailySummaryHour', 'daily_summary_hour', DEFAULT_SUPERVISOR_SETTINGS.dailySummaryHour), DEFAULT_SUPERVISOR_SETTINGS.dailySummaryHour, 0, 23),
    activationMode: ['new', 'all'].includes(String(read('activationMode', 'activation_mode', DEFAULT_SUPERVISOR_SETTINGS.activationMode)))
      ? String(read('activationMode', 'activation_mode', DEFAULT_SUPERVISOR_SETTINGS.activationMode))
      : DEFAULT_SUPERVISOR_SETTINGS.activationMode,
    activatedAt: (() => {
      const raw = read('activatedAt', 'activated_at', DEFAULT_SUPERVISOR_SETTINGS.activatedAt);
      if (!raw) return null;
      const at = Date.parse(raw);
      return Number.isFinite(at) ? new Date(at).toISOString() : null;
    })(),
    includeOldOrders: flag(read('includeOldOrders', 'include_old_orders', DEFAULT_SUPERVISOR_SETTINGS.includeOldOrders), DEFAULT_SUPERVISOR_SETTINGS.includeOldOrders),
    includeOrderIds: Array.isArray(read('includeOrderIds', 'include_order_ids', DEFAULT_SUPERVISOR_SETTINGS.includeOrderIds))
      ? [...new Set((read('includeOrderIds', 'include_order_ids', []) ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))].slice(0, 500)
      : [],
    maxRemindersPerTick: bounded(read('maxRemindersPerTick', 'max_reminders_per_tick', DEFAULT_SUPERVISOR_SETTINGS.maxRemindersPerTick), DEFAULT_SUPERVISOR_SETTINGS.maxRemindersPerTick, 1, 100),
    maxEscalationsPerTick: bounded(read('maxEscalationsPerTick', 'max_escalations_per_tick', DEFAULT_SUPERVISOR_SETTINGS.maxEscalationsPerTick), DEFAULT_SUPERVISOR_SETTINGS.maxEscalationsPerTick, 1, 100),
  };
}

/** Lee los ajustes guardados (con los valores de fábrica de respaldo). */
export async function supervisorSettings(ctx) {
  const doc = await ctx.settings.read(SUPERVISOR_SETTINGS_KEY).catch(() => null);
  const settings = normalizeSupervisorSettings(doc?.value);
  /*
   * MIGRACIÓN DE INSTALACIONES ANTIGUAS: antes de `activatedAt`, algunas
   * instalaciones ya tenían el supervisor habilitado pero ninguna fecha de
   * corte. En ese estado el panel decía «activo» mientras la elegibilidad
   * rechazaba todos los pedidos. Sellar el corte ahora habilita pedidos nuevos
   * y conserva los anteriores en Revisión pendiente; no envía ningún aviso.
   */
  if (settings.enabled && !settings.activatedAt && settings.activationMode === 'new' && !settings.includeOldOrders) {
    settings.activatedAt = ctx.clock().toISOString();
    await ctx.settings.write(SUPERVISOR_SETTINGS_KEY, settings);
  }
  return settings;
}

/** Guarda los ajustes normalizados. */
export async function saveSupervisorSettings(ctx, input) {
  const previous = await ctx.settings.read(SUPERVISOR_SETTINGS_KEY).catch(() => null);
  const normalized = normalizeSupervisorSettings(input);
  /*
   * AL ENCENDERSE POR PRIMERA VEZ se sella la fecha de activación: desde ahí se
   * supervisan las asignaciones nuevas. Sin esto, activar el supervisor en un
   * negocio con meses de pedidos abiertos dispararía avisos a medio mundo.
   *
   * OJO: guardar otros ajustes (p. ej. cambiar los minutos) NO puede borrar esa
   * fecha. Si el cambio no la trae, se conserva la que ya había.
   */
  const teniaActivacion = previous?.value?.activatedAt ?? null;
  if (!normalized.activatedAt) {
    normalized.activatedAt = teniaActivacion ?? (normalized.enabled ? ctx.clock().toISOString() : null);
  }
  await ctx.settings.write(SUPERVISOR_SETTINGS_KEY, normalized);
  return normalized;
}

// ----------------------------------------------------------------- utilidades

/** Pedido parseado de una fila del almacén (tolera documentos viejos). */
export function parseOrderRow(row) {
  if (!row) return null;
  try {
    if (row.orderJson) return JSON.parse(row.orderJson);
    if (row.order_json) return typeof row.order_json === 'string' ? JSON.parse(row.order_json) : row.order_json;
  } catch {
    /* documento corrupto: se ignora ese pedido, no se rompe el motor */
  }
  return null;
}

const orderNumberOf = (order, item) => clean(order?.order_number ?? item?.order_number ?? order?.id ?? item?.id, 40) ?? String(item?.id ?? '');

/** Quién lleva el pedido, sea interno o externo. */
export function responsibleOf(order) {
  const external = courierOf(order);
  if (external?.phone_e164) {
    return {
      type: 'external',
      name: clean(external.contact_name, 80) ?? 'Repartidor',
      phone: toE164(external.phone_e164),
      contactId: external.contact_id ?? null,
      userId: null,
      state: external.status ?? COURIER_STATUS.ASSIGNED,
    };
  }
  const delivery = order?.delivery ?? {};
  if (delivery.delivery_user_id) {
    return {
      type: 'internal',
      name: clean(delivery.delivery_user_name_snapshot, 80) ?? 'Delivery',
      phone: null,
      contactId: null,
      userId: delivery.delivery_user_id,
      state: delivery.delivery_status ?? 'PENDING_CONTACT',
    };
  }
  return null;
}

/**
 * Primera fecha válida de la lista.
 *
 * OJO (corregido en la Etapa E): acepta también **números**. Antes solo pasaba
 * cadenas a `Date.parse`, y `supervisionOf` le pasa `assignedAt` ya convertido a
 * milisegundos; `Date.parse(<número>)` devuelve NaN, así que `startedAt` salía 0
 * y **la etapa `in_transit` nunca se marcaba como atrasada** (el supervisor no
 * avisaba nunca de una entrega en curso que se estaba pasando de tiempo).
 */
const firstTime = (...values) => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    const parsed = Date.parse(value ?? '');
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

/**
 * ¿ESTE PEDIDO ENTRA EN LA SUPERVISIÓN AUTOMÁTICA?
 *
 * Determinista y sin efectos: se usa en la pasada, en la foto del panel y en la
 * vista previa. Motivos de exclusión (se informan, no se esconden):
 *   - `closed`            pedido entregado, cancelado o perdido
 *   - `unassigned`         sin repartidor interno ni externo
 *   - `delivery_cancelled` la entrega se canceló (el pedido puede seguir abierto)
 *   - `not_activated`      el supervisor aún no se activó (no hay `activatedAt`)
 *   - `before_activation`  asignado ANTES de la fecha de activación
 *   - `no_assignment_date` no hay fecha de asignación para decidir
 *
 * Un pedido antiguo solo entra con autorización: `includeOldOrders` o su id en
 * `includeOrderIds` (lista blanca administrativa).
 *
 * @param {any} order
 * @param {any} settings
 * @param {string} [itemId]
 */
export function supervisionEligibility(order, settings = {}, itemId = '') {
  const s = normalizeSupervisorSettings(settings);
  if (!order) return { eligible: false, reason: 'invalid' };
  if (CLOSED_STATUSES.includes(String(order.status ?? ''))) return { eligible: false, reason: 'closed' };
  const responsible = responsibleOf(order);
  if (!responsible) return { eligible: false, reason: 'unassigned' };
  if (String(order.delivery?.delivery_status ?? '').toUpperCase() === 'CANCELLED') {
    return { eligible: false, reason: 'delivery_cancelled' };
  }
  const id = String(order.id ?? itemId ?? '');
  if (id && s.includeOrderIds.includes(id)) return { eligible: true, reason: 'authorized_old' };
  if (s.activationMode === 'all' || s.includeOldOrders) return { eligible: true, reason: 'all' };
  const since = Date.parse(s.activatedAt ?? '') || 0;
  if (!since) return { eligible: false, reason: 'not_activated' };
  const assignedAt = firstTime(
    order.delivery?.supervisor?.assigned_at,
    order.delivery?.delivery_assigned_at,
    order.delivery?.external?.assigned_at,
  );
  if (!assignedAt) return { eligible: false, reason: 'no_assignment_date' };
  return assignedAt >= since
    ? { eligible: true, reason: 'after_activation' }
    : { eligible: false, reason: 'before_activation' };
}

/**
 * Estado de supervisión de UN pedido. Determinista y sin efectos secundarios.
 *
 * @param {any} order Pedido ya parseado.
 * @param {{settings?: any, now?: number, pendingPickups?: number}} [options]
 */
export function supervisionOf(order, options = {}) {
  const settings = normalizeSupervisorSettings(options.settings ?? {});
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const pendingPickups = Math.max(0, Number(options.pendingPickups ?? 0) || 0);
  const status = String(order?.status ?? '');
  if (!order || CLOSED_STATUSES.includes(status)) {
    return { stage: SUPERVISOR_STAGES.CLOSED, severity: 'ok', nextAction: STAGE_NEXT_ACTION.closed, closed: true, responsible: null };
  }
  const supervisor = order.delivery?.supervisor ?? {};
  const postponedUntilMs = firstTime(supervisor.postponed_until);
  if (postponedUntilMs && postponedUntilMs > now) {
    return {
      stage: SUPERVISOR_STAGES.POSTPONED,
      severity: 'ok',
      nextAction: STAGE_NEXT_ACTION.postponed,
      responsible: responsibleOf(order),
      postponedUntil: new Date(postponedUntilMs).toISOString(),
      postponeReason: clean(supervisor.postpone_reason, 200),
      anchorAt: postponedUntilMs,
      elapsedMinutes: 0,
      pendingPickups,
    };
  }

  const responsible = responsibleOf(order);
  if (!responsible) {
    return {
      stage: SUPERVISOR_STAGES.NO_RESPONSIBLE,
      severity: 'critical',
      nextAction: STAGE_NEXT_ACTION.no_responsible,
      responsible: null,
      anchorAt: firstTime(order.created_at),
      elapsedMinutes: Math.max(0, Math.round((now - firstTime(order.created_at)) / 60000)),
      pendingPickups,
    };
  }

  let stage = SUPERVISOR_STAGES.PENDING_START;
  if (responsible.type === 'external') {
    const state = String(responsible.state ?? '').toLowerCase();
    if (state === COURIER_STATUS.ASSIGNED) stage = SUPERVISOR_STAGES.NOT_CONFIRMED;
    else if (state === COURIER_STATUS.FAILED) stage = SUPERVISOR_STAGES.SEND_FAILED;
    else if (state === COURIER_STATUS.SENT) stage = pendingPickups ? SUPERVISOR_STAGES.PICKUP_PENDING : SUPERVISOR_STAGES.PENDING_START;
    else if (state === COURIER_STATUS.IN_PROGRESS) stage = SUPERVISOR_STAGES.IN_TRANSIT;
    else if (state === COURIER_STATUS.AWAITING_CONFIRMATION) stage = SUPERVISOR_STAGES.AWAITING_CONFIRMATION;
    else if (state === COURIER_STATUS.ISSUE) stage = SUPERVISOR_STAGES.ISSUE;
  } else {
    const state = String(responsible.state ?? '').toUpperCase();
    /*
     * UN AGENTE INTERNO TAMBIÉN ESPERA CONFIRMACIÓN.
     * Antes «ya lo entregué» por WhatsApp solo se recordaba en `pending_action`,
     * pero la etapa seguía siendo `in_transit` y el siguiente «CONFIRMAR» se
     * rechazaba pidiendo primero «Entregado». La etapa manda el aviso pendiente.
     */
    const pendingType = order.delivery?.supervisor?.pending_action?.type ?? null;
    if (state === 'ISSUE_REPORTED') stage = SUPERVISOR_STAGES.ISSUE;
    else if (pendingType === 'confirm_delivery') stage = SUPERVISOR_STAGES.AWAITING_CONFIRMATION;
    else if (state === 'IN_TRANSIT' || status === 'enviado') stage = SUPERVISOR_STAGES.IN_TRANSIT;
    else if (pendingPickups) stage = SUPERVISOR_STAGES.PICKUP_PENDING;
    else stage = SUPERVISOR_STAGES.PENDING_START;
  }

  const assignedAt = firstTime(supervisor.assigned_at, order.delivery?.delivery_assigned_at, order.delivery?.external?.assigned_at, order.created_at);
  const startedAt = firstTime(supervisor.started_at, order.delivery?.external?.started_at, order.delivery?.delivery_started_at, assignedAt);
  const reportedAt = firstTime(order.delivery?.external?.delivered_reported_at, supervisor.delivered_reported_at, now);
  const anchorAt =
    stage === SUPERVISOR_STAGES.IN_TRANSIT
      ? startedAt
      : stage === SUPERVISOR_STAGES.AWAITING_CONFIRMATION
        ? reportedAt
        : assignedAt;
  const elapsedMinutes = anchorAt ? Math.max(0, Math.round((now - anchorAt) / 60000)) : 0;
  const severity =
    elapsedMinutes >= settings.lateAfterMinutes
      ? 'late'
      : elapsedMinutes >= settings.firstReminderMinutes
        ? 'attention'
        : 'ok';

  return {
    stage,
    severity,
    nextAction: STAGE_NEXT_ACTION[stage] ?? STAGE_NEXT_ACTION.pending_start,
    responsible,
    anchorAt: anchorAt || now,
    elapsedMinutes,
    pendingPickups,
    postponeCount: Number(supervisor.postpone_count ?? 0) || 0,
    postponedUntil: postponedUntilMs ? new Date(postponedUntilMs).toISOString() : null,
  };
}

// ------------------------------------------------------------- bitácora

/** Registra un evento del supervisor. Idempotente por `idempotencyKey`. */
export async function supervisorEvent(ctx, input) {
  const at = ctx.clock().toISOString();
  const doc = {
    id: `dse_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    order_id: input.orderId ?? null,
    kind: input.kind ?? 'event',
    stage: input.stage ?? null,
    status: input.status ?? null,
    detail: longText(input.detail, 600),
    actor: clean(input.actor, 120),
    data: input.data ?? null,
    idempotency_key: clean(input.idempotencyKey, 200),
    created_at: at,
  };
  const result = await ctx.db.insert(SUPERVISOR_EVENTS, doc);
  return result.duplicate ? { duplicate: true, event: await ctx.db.findBy(SUPERVISOR_EVENTS, 'idempotency_key', doc.idempotency_key) } : result;
}

/**
 * RESERVA UN TRABAJO ANTES DE HACERLO (claim).
 *
 * El índice ÚNICO de `idempotency_key` es el árbitro: el primer proceso que
 * inserta gana y cualquier otro recibe `duplicate`. Así, dos pasadas solapadas
 * (un tick que tarda más de 30 s, un reinicio a mitad, dos instancias con la
 * misma base) NO pueden enviar dos veces el mismo aviso.
 *
 * Antes el evento se escribía DESPUÉS de enviar: una caída entre el envío y el
 * registro dejaba el aviso sin constancia y el tick siguiente lo repetía.
 *
 * @returns {Promise<{claimed: boolean, id?: string}>}
 */
async function claimSupervisorEvent(ctx, input) {
  const at = ctx.clock().toISOString();
  const doc = {
    id: `dse_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    order_id: input.orderId ?? null,
    kind: input.kind ?? 'event',
    stage: input.stage ?? null,
    status: input.status ?? 'claimed',
    detail: longText(input.detail, 600),
    actor: clean(input.actor, 120),
    data: input.data ?? null,
    idempotency_key: clean(input.idempotencyKey, 200),
    created_at: at,
  };
  const result = await ctx.db.insert(SUPERVISOR_EVENTS, doc);
  return result?.duplicate ? { claimed: false } : { claimed: true, id: doc.id };
}

/** Cierra una reserva con el resultado real del intento. */
async function settleSupervisorEvent(ctx, id, patch) {
  if (!id) return null;
  return ctx.db.update(SUPERVISOR_EVENTS, id, { ...patch, detail: longText(patch.detail, 600) }).catch(() => null);
}

function groupEvents(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row?.order_id) continue;
    if (!map.has(row.order_id)) map.set(row.order_id, []);
    map.get(row.order_id).push(row);
  }
  return map;
}

const remindersOf = (events, stage) => events.filter((row) => row.kind === 'reminder' && (!stage || row.stage === stage));

/** Estado que guarda el pedido sobre el supervisor (se escribe con store.update). */
async function patchSupervisor(ctx, item, order, patch) {
  const at = ctx.clock().toISOString();
  const next = {
    ...order,
    delivery: { ...(order.delivery ?? {}), supervisor: { ...(order.delivery?.supervisor ?? {}), ...patch } },
    updated_at: at,
  };
  await ctx.store.update(item.id, { orderJson: JSON.stringify(next) });
  return next;
}

// --------------------------------------------------- posposición (Posponer)

/**
 * Fecha objetivo de una posposición: `YYYY-MM-DD` (mediodía UTC de ese día) o
 * una fecha ISO completa. Devuelve milisegundos o `null`.
 */
export function parsePostponeDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const at = Date.parse(`${raw}T12:00:00Z`);
    return Number.isFinite(at) ? at : null;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
}

/** Hora local (0-23) en la zona del negocio. */
export function hourIn(timeZone, date = new Date()) {
  const value = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(date);
  return Number(value) % 24;
}

/**
 * POSPONER un pedido: motivo + fecha nueva + comentario + responsable.
 *
 * Conserva el estado comercial y el pago; solo suspende los recordatorios hasta
 * la fecha indicada. Respeta los límites configurados (días y número de veces).
 */
export async function postponeDelivery(input) {
  const { ctx, item, order, actor = null } = input;
  if (!item?.id || !order) return { ok: false, status: 422, error: 'invalid_order', message: 'Pedido no válido.' };
  if (CLOSED_STATUSES.includes(String(order.status ?? item.status ?? ''))) {
    return { ok: false, status: 409, error: 'order_closed', message: 'Este pedido ya está cerrado.' };
  }
  const settings = input.settings ?? (await supervisorSettings(ctx));
  const reason = clean(input.reason, 200);
  if (!reason || reason.length < 3) {
    return { ok: false, status: 422, error: 'reason_required', message: 'Escribe el motivo de la posposición.' };
  }
  const untilMs = parsePostponeDate(input.until ?? input.until_date);
  if (!untilMs) {
    return { ok: false, status: 422, error: 'invalid_date', message: 'Indica una fecha válida (AAAA-MM-DD).' };
  }
  const now = ctx.clock().getTime();
  if (untilMs <= now) {
    return { ok: false, status: 422, error: 'date_in_past', message: 'La fecha de la posposición tiene que ser futura.' };
  }
  if (untilMs - now > settings.postponeMaxDays * 24 * 60 * 60 * 1000) {
    return {
      ok: false,
      status: 422,
      error: 'date_too_far',
      message: `No se puede posponer más de ${settings.postponeMaxDays} día(s).`,
    };
  }
  const current = order.delivery?.supervisor ?? {};
  const count = Number(current.postpone_count ?? 0) || 0;
  if (count >= settings.postponeMaxCount) {
    return {
      ok: false,
      status: 409,
      error: 'postpone_limit',
      message: `Este pedido ya se pospuso ${count} vez/veces. Administración debe resolverlo.`,
    };
  }
  const at = ctx.clock().toISOString();
  const next = await patchSupervisor(ctx, item, order, {
    postponed_until: new Date(untilMs).toISOString(),
    postpone_reason: reason,
    postpone_note: longText(input.note, 400),
    postponed_by: clean(actor?.display_name ?? input.by, 120) ?? 'Sistema',
    postponed_by_user_id: actor?.id ?? null,
    postponed_at: at,
    postpone_count: count + 1,
    pending_action: null,
    postpone_due_notified_at: null,
  });
  await ctx.audit?.record({
    entity: 'order',
    entityId: item.id,
    action: 'order.delivery_postponed',
    actor: actor?.display_name ?? clean(input.by, 120) ?? 'Sistema',
    summary: `Entrega pospuesta hasta ${new Date(untilMs).toISOString().slice(0, 10)}: ${reason}`,
    data: {
      order_id: item.id,
      postponed_until: new Date(untilMs).toISOString(),
      postpone_count: count + 1,
      reason,
      source: input.source ?? 'PANEL',
    },
    idempotencyKey: `order.postpone:${item.id}:${at}`,
  });
  await supervisorEvent(ctx, {
    orderId: item.id,
    kind: 'postponed',
    stage: SUPERVISOR_STAGES.POSTPONED,
    status: 'ok',
    detail: `Pospuesto hasta ${new Date(untilMs).toISOString().slice(0, 10)}: ${reason}`,
    actor: actor?.display_name ?? null,
    data: { postponed_until: new Date(untilMs).toISOString(), reason, note: longText(input.note, 400) },
    idempotencyKey: `supervisor-postponed:${item.id}:${at}`,
  });
  // Si lo pidió el repartidor por WhatsApp, administración se entera.
  const source = String(input.source ?? 'PANEL');
  if (source !== 'PANEL' && typeof input.deps?.notifyUser === 'function') {
    await notifySupervisorAdmins(ctx, input.deps, {
      type: 'DELIVERY_SUPERVISOR_POSTPONED',
      title: 'Entrega pospuesta',
      body: `Pedido ${orderNumberOf(order, item)} · ${reason} · hasta ${new Date(untilMs).toISOString().slice(0, 10)}`,
      orderId: item.id,
      idempotencyKey: `supervisor-postponed-notif:${item.id}:${at}`,
      data: { order_id: item.id, postponed_until: new Date(untilMs).toISOString(), reason, source },
    });
  }
  return { ok: true, status: 200, order: next, postponedUntil: new Date(untilMs).toISOString(), count: count + 1 };
}

// ------------------------------------------------------------- recordatorios

const recipientPhoneOf = async (ctx, responsible, users) => {
  if (responsible?.type === 'external') return responsible.phone ?? null;
  if (responsible?.type === 'internal') {
    const user = (users ?? []).find((row) => row.id === responsible.userId) ?? (await ctx.users.get(responsible.userId).catch(() => null));
    return toE164(user?.personal_phone) ?? toE164(user?.fleet_phone) ?? null;
  }
  return null;
};

async function notifySupervisorAdmins(ctx, deps, input) {
  const users = deps.users ?? (await ctx.users.listUsers().catch(() => []));
  const admins = users.filter((user) => user.role === 'ADMIN' && user.active !== false);
  let created = 0;
  for (const admin of admins) {
    if (typeof deps.notifyUser !== 'function') break;
    const result = await deps
      .notifyUser({
        recipientUserId: admin.id,
        type: input.type,
        title: input.title,
        body: input.body,
        entityType: 'order',
        entityId: input.orderId,
        deepLink: `/admin/?v=supervisor&order=${encodeURIComponent(input.orderId)}`,
        data: input.data ?? null,
        idempotencyKey: input.idempotencyKey,
      })
      .catch(() => null);
    if (result?.notification && !result.duplicate) {
      created += 1;
      if (typeof deps.push === 'function') await deps.push(result.notification).catch(() => null);
    }
  }
  return created;
}

/**
 * Un intento de recordatorio. Devuelve `sent | pending | failed | skipped`.
 * NUNCA finge: si no hay plantilla aprobada o WhatsApp no está configurado, se
 * registra el motivo real.
 */
async function sendReminder(ctx, deps, { item, order, state, settings, attempt }) {
  const number = orderNumberOf(order, item);
  const phone = await recipientPhoneOf(ctx, state.responsible, deps.users);
  let status = 'skipped';
  let error = null;
  let messageId = null;

  /*
   * RESERVA PRIMERO. Si otro proceso (o una pasada anterior interrumpida) ya
   * reservó este mismo intento, aquí no se envía nada: evita el doble aviso.
   */
  const claim = await claimSupervisorEvent(ctx, {
    orderId: item.id,
    kind: 'reminder',
    stage: state.stage,
    status: 'sending',
    detail: `${state.nextAction} · enviando`,
    actor: 'Supervisor IA',
    idempotencyKey: `supervisor-reminder:${item.id}:${state.stage}:${attempt}`,
  });
  if (!claim.claimed) return 'duplicate';

  if (settings.whatsAppReminders && state.responsible?.type === 'external' && phone) {
    if (!ctx.whatsapp?.enabled) {
      status = 'failed';
      error = 'whatsapp_not_configured';
    } else {
      if (typeof deps.refreshTemplate === 'function') await deps.refreshTemplate(SUPERVISOR_REMINDER_TEMPLATE).catch(() => null);
      const check = typeof deps.checkTemplate === 'function' ? await deps.checkTemplate(SUPERVISOR_REMINDER_TEMPLATE) : { ok: false, reason: 'template_check_unavailable' };
      if (!check?.ok) {
        status = 'pending';
        error = check?.reason ?? 'template_not_approved';
      } else {
        const sent = await ctx.whatsapp
          .sendTemplate(phone, {
            name: check.template.name,
            language: check.template.language ?? 'es',
            components: [
              {
                type: 'body',
                parameters: [state.responsible.name, number, state.nextAction].map((text) => ({ type: 'text', text: String(text).slice(0, MAX_TEXT) })),
              },
            ],
          })
          .catch((failure) => ({ ok: false, error: { message: failure?.message ?? 'send_failed' } }));
        if (sent?.ok) {
          status = 'sent';
          messageId = sent.messageId ?? null;
        } else {
          status = 'failed';
          error = clean(sent?.error?.message ?? sent?.reason ?? 'send_failed', 200);
        }
      }
    }
  }

  // Aviso INTERNO (campana/push) para el repartidor con cuenta en el CRM.
  if (settings.internalNotifications && state.responsible?.type === 'internal' && state.responsible.userId && typeof deps.notifyUser === 'function') {
    const result = await deps
      .notifyUser({
        recipientUserId: state.responsible.userId,
        type: 'DELIVERY_SUPERVISOR_REMINDER',
        title: 'Pedido pendiente',
        body: `Pedido ${number} · ${state.nextAction}`,
        entityType: 'order',
        entityId: item.id,
        deepLink: `/admin/?v=delivery&order=${encodeURIComponent(item.id)}`,
        data: { order_id: item.id, stage: state.stage, attempt },
        idempotencyKey: `supervisor-reminder:${item.id}:${state.stage}:${attempt}`,
      })
      .catch(() => null);
    if (result?.notification && !result.duplicate && typeof deps.push === 'function') await deps.push(result.notification).catch(() => null);
    if (status === 'skipped') status = 'notified';
  }

  await settleSupervisorEvent(ctx, claim.id, {
    status,
    detail: `${state.nextAction}${status === 'sent' ? ' · enviado' : status === 'notified' ? ' · aviso interno' : error ? ` · ${error}` : ''}`,
    data: { attempt, phone_masked: phone ? `***${phone.slice(-4)}` : null, error, message_id: messageId, responsible: state.responsible?.type ?? null },
  });
  await ctx.audit?.record({
    entity: 'order',
    entityId: item.id,
    action: status === 'sent' || status === 'notified' ? 'delivery.supervisor_reminder_sent' : 'delivery.supervisor_reminder_failed',
    actor: 'Sistema',
    summary: `Recordatorio ${attempt}/${settings.maxAttempts} · ${state.nextAction}`,
    data: { order_id: item.id, stage: state.stage, status, error, responsible: state.responsible?.name ?? null },
    idempotencyKey: `delivery.supervisor_reminder:${item.id}:${state.stage}:${attempt}:${status}`,
  });
  return status;
}

/**
 * Escala la incidencia a administración. Una vez por pedido y etapa.
 *
 * Dos canales, UN solo escalamiento:
 *   1. la campana/push interno (siempre, cuantas cuentas ADMIN haya);
 *   2. WhatsApp a los contactos de `delivery_control.deliveryAdminEscalationContacts`
 *      con la plantilla aprobada, para que el aviso llegue aunque nadie tenga el
 *      panel abierto.
 *
 * La clave de idempotencia del EVENTO es la que impide repetir: si ya existe, no
 * se vuelve a enviar ni por campana ni por WhatsApp (los reintentos del webhook y
 * las pasadas siguientes del scheduler no duplican nada).
 */
async function escalate(ctx, deps, { item, order, state, settings, reason }) {
  const key = `supervisor-escalation:${item.id}:${state.stage}:${reason}`;
  /* Reserva atómica: dos pasadas solapadas no escalan (ni escriben) dos veces. */
  const claim = await claimSupervisorEvent(ctx, {
    orderId: item.id,
    kind: 'escalation',
    stage: state.stage,
    status: 'claiming',
    detail: `Escalando a administración · ${state.nextAction}`,
    actor: 'Supervisor IA',
    idempotencyKey: key,
  });
  if (!claim.claimed) return 0;
  const number = orderNumberOf(order, item);
  const alerts = await notifySupervisorAdmins(ctx, deps, {
    type: 'DELIVERY_SUPERVISOR_ESCALATION',
    title: 'Delivery sin resolver',
    body: `Pedido ${number} · ${state.responsible?.name ?? 'sin responsable'} · ${state.nextAction}`,
    orderId: item.id,
    idempotencyKey: `supervisor-escalation-notif:${item.id}:${state.stage}:${reason}`,
    data: {
      order_id: item.id,
      stage: state.stage,
      responsible_type: state.responsible?.type ?? null,
      responsible_name: state.responsible?.name ?? null,
      elapsed_minutes: state.elapsedMinutes,
    },
  });
  const whatsapp = await sendEscalationWhatsApp(ctx, deps, { item, order, state, reason });
  await settleSupervisorEvent(ctx, claim.id, {
    status: alerts > 0 || whatsapp.sent > 0 ? 'notified' : 'recorded',
    detail: `Escalado a administración · ${state.nextAction}`,
    data: {
      reason,
      admins: alerts,
      elapsed_minutes: state.elapsedMinutes,
      whatsapp: whatsapp.results,
    },
  });
  await ctx.audit?.record({
    entity: 'order',
    entityId: item.id,
    action: 'delivery.supervisor_escalated',
    actor: 'Sistema',
    summary: `Incidencia escalada (${reason}) · ${state.nextAction}`,
    data: {
      order_id: item.id,
      stage: state.stage,
      admins_notified: alerts,
      elapsed_minutes: state.elapsedMinutes,
      whatsapp_sent: whatsapp.sent,
      whatsapp_pending: whatsapp.pending,
      whatsapp_failed: whatsapp.failed,
    },
    idempotencyKey: `delivery.supervisor_escalated:${item.id}:${state.stage}:${reason}`,
  });
  /*
   * Se cuenta como escalamiento aunque ningún administrador tenga cuenta con
   * avisos (el evento queda registrado y el panel lo muestra): lo que no puede
   * pasar es que la incidencia desaparezca sin dejar rastro.
   */
  return 1;
}

/**
 * ESCALADO POR WHATSAPP A ADMINISTRACIÓN.
 *
 * Reutiliza lo que ya existe: la plantilla `phyto_delivery_sin_atender_admin_v1`
 * y los contactos de administración de `delivery_control`. No inventa números ni
 * categorías, y NUNCA finge: si la plantilla no está aprobada o WhatsApp no está
 * configurado, el resultado queda como `pending`/`failed` con el motivo real.
 *
 * Minimización de datos: al administrador solo van el número de pedido, quién lo
 * lleva y el enlace al panel. Nunca teléfono ni dirección del cliente.
 *
 * @returns {Promise<{sent: number, pending: number, failed: number, results: any[]}>}
 */
async function sendEscalationWhatsApp(ctx, deps, { item, order, state, reason }) {
  const recipients = await escalationRecipients(ctx);
  const results = [];
  const empty = { sent: 0, pending: 0, failed: 0, results };
  if (!recipients.length) return empty;

  const link = typeof deps.orderDeepLink === 'function' ? deps.orderDeepLink(item.id) : null;
  if (!link) {
    for (const row of recipients) results.push({ admin: row.name, status: 'skipped', error: 'no_deep_link' });
    return { ...empty, results };
  }
  if (!ctx.whatsapp?.enabled) {
    for (const row of recipients) results.push({ admin: row.name, phone_masked: `***${row.phone.slice(-4)}`, status: 'pending', error: 'whatsapp_not_configured' });
    return { ...empty, pending: recipients.length, results };
  }

  let check = { ok: false, reason: 'template_check_unavailable' };
  if (typeof deps.refreshTemplate === 'function') await deps.refreshTemplate(SUPERVISOR_ESCALATION_TEMPLATE).catch(() => null);
  if (typeof deps.checkTemplate === 'function') check = await deps.checkTemplate(SUPERVISOR_ESCALATION_TEMPLATE).catch(() => ({ ok: false, reason: 'template_check_failed' }));
  if (!check?.ok) {
    const error = check?.reason ?? 'template_not_approved';
    for (const row of recipients) results.push({ admin: row.name, phone_masked: `***${row.phone.slice(-4)}`, status: 'pending', error });
    // Queda registrado el motivo real: no se da por avisado a nadie.
    await ctx.audit?.record({
      entity: 'order',
      entityId: item.id,
      action: 'delivery.supervisor_escalation_unavailable',
      actor: 'Sistema',
      summary: `Escalado por WhatsApp no disponible (${error})`,
      data: { order_id: item.id, stage: state.stage, reason, template: SUPERVISOR_ESCALATION_TEMPLATE, error },
      idempotencyKey: `delivery.supervisor_escalation_unavailable:${item.id}:${state.stage}:${reason}`,
    });
    return { ...empty, pending: recipients.length, results };
  }

  const parameters = [
    String(orderNumberOf(order, item)).slice(0, MAX_TEXT),
    String(state.responsible?.name ?? 'Sin responsable').slice(0, MAX_TEXT),
    String(link).slice(0, MAX_TEXT),
  ];
  let sent = 0;
  let failed = 0;
  for (const row of recipients) {
    /* Reserva por administrador: un reintento no vuelve a escribirle. */
    const waClaim = await claimSupervisorEvent(ctx, {
      orderId: item.id,
      kind: 'escalation_whatsapp',
      stage: state.stage,
      status: 'sending',
      actor: 'Supervisor IA',
      idempotencyKey: `delivery.supervisor_escalation_wa:${item.id}:${state.stage}:${reason}:${row.phone}`,
    });
    if (!waClaim.claimed) {
      results.push({ admin: row.name, phone_masked: `***${row.phone.slice(-4)}`, status: 'duplicate', error: null });
      continue;
    }
    const message = await ctx.whatsapp
      .sendTemplate(row.phone, {
        name: check.template?.name ?? SUPERVISOR_ESCALATION_TEMPLATE,
        language: check.template?.language ?? 'es',
        components: [{ type: 'body', parameters: parameters.map((text) => ({ type: 'text', text })) }],
      })
      .catch((failure) => ({ ok: false, error: { message: failure?.message ?? 'send_failed' } }));
    const status = message?.ok ? 'sent' : 'failed';
    if (status === 'sent') sent += 1;
    else failed += 1;
    const entry = {
      admin: row.name,
      phone_masked: `***${row.phone.slice(-4)}`,
      status,
      error: message?.ok ? null : clean(message?.error?.message ?? message?.reason ?? 'send_failed', 200),
      message_id: message?.messageId ?? null,
    };
    results.push(entry);
    await settleSupervisorEvent(ctx, waClaim.id, {
      status,
      detail: `Escalado por WhatsApp a ${row.name}`,
      data: { ...entry, template: SUPERVISOR_ESCALATION_TEMPLATE },
    });
    await ctx.audit?.record({
      entity: 'order',
      entityId: item.id,
      action: status === 'sent' ? 'delivery.supervisor_escalation_sent' : 'delivery.supervisor_escalation_failed',
      actor: 'Sistema',
      summary: status === 'sent' ? `Escalado por WhatsApp a ${row.name}` : `Escalado por WhatsApp falló (${row.name})`,
      data: { order_id: item.id, stage: state.stage, reason, template: SUPERVISOR_ESCALATION_TEMPLATE, ...entry },
      idempotencyKey: `delivery.supervisor_escalation_wa:${item.id}:${state.stage}:${reason}:${row.phone}`,
    });
  }
  return { sent, pending: 0, failed, results };
}

/**
 * Contactos de administración para el escalado, desde `delivery_control`.
 * Se eliminan duplicados y se corta el lote: una incidencia no puede disparar
 * una lista enorme de mensajes.
 */
async function escalationRecipients(ctx) {
  const doc = await ctx.settings.read('delivery_control').catch(() => null);
  const rows = Array.isArray(doc?.value?.deliveryAdminEscalationContacts) ? doc.value.deliveryAdminEscalationContacts : [];
  const out = [];
  for (const row of rows) {
    const phone = toE164(row?.phone ?? row);
    if (!phone || out.some((entry) => entry.phone === phone)) continue;
    out.push({ phone, name: clean(row?.name, 80) ?? 'Administración' });
    if (out.length >= MAX_ESCALATION_RECIPIENTS) break;
  }
  return out;
}

/** Pedidos con recogida pendiente, contados de una sola pasada. */
async function pendingPickupsByOrder(ctx) {
  const map = new Map();
  const rows = await ctx.db.list('order_pickups', { limit: 5000 }).catch(() => []);
  for (const row of rows) {
    if (!row?.order_id) continue;
    if (!ACTIVE_PICKUP_STATUSES.includes(String(row.status ?? ''))) continue;
    map.set(row.order_id, (map.get(row.order_id) ?? 0) + 1);
  }
  return map;
}

/**
 * UNA PASADA del supervisor. La llama el scheduler (sobrevive al navegador
 * cerrado) o el botón «Ejecutar ahora» del panel.
 */
export async function supervisorTick(ctx, deps = {}) {
  const settings = await supervisorSettings(ctx);
  if (!settings.enabled) return { enabled: false, reminders: 0, escalations: 0, paused: 0, deferred: 0 };
  const now = ctx.clock().getTime();
  const timeZone = deps.timeZone ?? DEFAULT_TIME_ZONE;
  const users = deps.users ?? (await ctx.users.listUsers().catch(() => []));
  const todasLasFilas = await ctx.store.listAdmin({ limit: 5000 });
  const rows = todasLasFilas.filter((row) => row.type === 'order_intent');
  /*
   * TOPE DE LECTURA VISIBLE. Con más de 5000 registros el almacén devuelve solo
   * los primeros y un pedido fuera de ese corte NO se supervisa. Antes pasaba
   * en silencio; ahora la pasada lo informa para que se pueda dimensionar.
   */
  const capped = todasLasFilas.length >= 5000;  const events = await ctx.db.list(SUPERVISOR_EVENTS, { limit: 20000 }).catch(() => []);
  const byOrder = groupEvents(events);
  const pickups = deps.pickups ?? (await pendingPickupsByOrder(ctx));
  const localHour = hourIn(timeZone, new Date(now));
  const inHours = localHour >= settings.contactFromHour && localHour < settings.contactToHour;

  let reminders = 0;
  let escalations = 0;
  let paused = 0;
  let deferred = 0;
  let postponedDue = 0;
  let limitados = 0;
  const excluidos = {};

  for (const item of rows) {
    const order = parseOrderRow(item);
    if (!order) continue;
    /*
     * SOLO PEDIDOS ELEGIBLES.
     *
     * Ni históricos, ni cerrados, ni cancelados, ni sin asignación vigente, ni
     * los asignados antes de autorizar el supervisor. Esto evita que el primer
     * arranque escriba a pedidos de meses atrás (y que escale 300 incidencias
     * que no son de nadie).
     */
    const elegibilidad = supervisionEligibility(order, settings, item.id);
    if (!elegibilidad.eligible) {
      excluidos[elegibilidad.reason] = (excluidos[elegibilidad.reason] ?? 0) + 1;
      continue;
    }
    const state = supervisionOf(order, { settings, now, pendingPickups: pickups.get(item.id) ?? 0 });
    if (state.stage === SUPERVISOR_STAGES.CLOSED) continue;
    const history = byOrder.get(item.id) ?? [];

    // POSPOSICIÓN VENCIDA: se avisa UNA vez y el seguimiento vuelve a correr.
    const untilMs = firstTime(order.delivery?.supervisor?.postponed_until);
    if (untilMs && untilMs <= now && !order.delivery?.supervisor?.postpone_due_notified_at) {
      await patchSupervisor(ctx, item, order, { postpone_due_notified_at: new Date(now).toISOString() });
      await supervisorEvent(ctx, {
        orderId: item.id,
        kind: 'postpone_due',
        stage: SUPERVISOR_STAGES.POSTPONED,
        status: 'ok',
        detail: 'Volvió la fecha acordada: se reanuda el seguimiento',
        actor: 'Supervisor IA',
        idempotencyKey: `supervisor-postpone-due:${item.id}:${new Date(untilMs).toISOString()}`,
      });
      postponedDue += 1;
    }

    if (state.stage === SUPERVISOR_STAGES.POSTPONED) continue;
    // Sin responsable o con incidencia, sigue administración: se escala y no se
    // le manda nada al repartidor (no hay a quién o no debe actuar todavía).
    if (state.stage === SUPERVISOR_STAGES.NO_RESPONSIBLE) {
      if (escalations >= settings.maxEscalationsPerTick) {
        limitados += 1;
        continue;
      }
      escalations += await escalate(ctx, deps, { item, order, state, settings, reason: 'no_responsible' });
      continue;
    }
    if (state.stage === SUPERVISOR_STAGES.ISSUE) {
      if (escalations >= settings.maxEscalationsPerTick) {
        limitados += 1;
        continue;
      }
      escalations += await escalate(ctx, deps, { item, order, state, settings, reason: 'issue' });
      continue;
    }

    // PAUSA: si el repartidor respondió hace poco, no se le insiste.
    const lastReplyAt = firstTime(order.delivery?.supervisor?.last_reply_at);
    if (lastReplyAt && now - lastReplyAt < settings.followUpMinutes * 60000) {
      paused += 1;
      continue;
    }

    const attempts = remindersOf(history, state.stage).length;
    /*
     * ESCALADO POR TIEMPO (`escalateAfterMinutes`).
     *
     * Antes este ajuste solo se normalizaba: lo leía la configuración y no lo
     * usaba nadie, así que «escalar a los N minutos» no existía de verdad.
     *
     * Exige que YA se haya avisado al menos una vez (`attempts >= 1`): el primer
     * paso siempre es el recordatorio; el escalado por tiempo cubre el caso de
     * una incidencia que sigue abierta después. Sin esa condición, un pedido
     * viejo saltaba directo a administración sin que el repartidor supiera nada.
     */
    if (attempts >= 1 && state.elapsedMinutes >= settings.escalateAfterMinutes) {
      if (escalations >= settings.maxEscalationsPerTick) {
        limitados += 1;
        continue;
      }
      escalations += await escalate(ctx, deps, { item, order, state, settings, reason: 'overdue' });
      continue;
    }
    if (attempts >= settings.maxAttempts) {
      // LÍMITE ALCANZADO: se deja de escribir y la incidencia sigue abierta.
      if (escalations >= settings.maxEscalationsPerTick) {
        limitados += 1;
        continue;
      }
      escalations += await escalate(ctx, deps, { item, order, state, settings, reason: 'max_attempts' });
      continue;
    }

    const lastAttemptAt = Math.max(0, ...remindersOf(history, state.stage).map((row) => Date.parse(row.created_at ?? '') || 0));
    const dueAt = attempts === 0 ? state.anchorAt + settings.firstReminderMinutes * 60000 : lastAttemptAt + settings.followUpMinutes * 60000;
    if (now < dueAt) continue;

    if (!inHours) {
      deferred += 1;
      continue;
    }

    /*
     * LÍMITE DE VOLUMEN POR PASADA: un primer arranque con muchos pedidos
     * pendientes no puede disparar cientos de mensajes de golpe. Lo que no entra
     * hoy entra en la siguiente pasada (el pedido sigue donde estaba).
     */
    if (reminders >= settings.maxRemindersPerTick) {
      limitados += 1;
      continue;
    }

    const status = await sendReminder(ctx, deps, { item, order, state, settings, attempt: attempts + 1 });
    if (status === 'sent' || status === 'notified') reminders += 1;
    // Con el envío imposible, el supervisor no se queda callado: escala.
    if (status === 'failed' || status === 'pending') {
      if (escalations < settings.maxEscalationsPerTick) {
        escalations += await escalate(ctx, deps, { item, order, state, settings, reason: 'reminder_undeliverable' });
      } else {
        limitados += 1;
      }
    }
  }

  /*
   * CONCILIACIÓN DIARIA, PROGRAMADA.
   *
   * Antes solo existía el endpoint manual: nadie la lanzaba sola. Ahora, a partir
   * de la hora configurada (`dailySummaryHour`) y UNA vez por día (la clave de
   * idempotencia es el propio día), el tick deja el resumen y avisa a
   * administración. No cierra ningún pedido por antigüedad.
   */
  let daily = false;
  if (localHour >= settings.dailySummaryHour) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(now));
    const key = `supervisor-daily:${day}`;
    if (!events.some((row) => row.idempotency_key === key)) {
      await dailyReconciliation(ctx, { deps, users, pickups, now, timeZone });
      daily = true;
    }
  }

  /*
   * LATIDO: deja constancia de que ESTA pasada ocurrió, con lo que hizo. Es un
   * único documento que se sobrescribe (no engorda la bitácora) y es lo que el
   * panel enseña como «última ejecución»: dato real del backend, no un reloj.
   */
  const resultado = { enabled: true, reminders, escalations, paused, deferred, postponedDue, daily, limited: limitados, excluded: excluidos, capped };
  await ctx.settings
    .write(SUPERVISOR_HEARTBEAT_KEY, { at: new Date(now).toISOString(), ...resultado })
    .catch(() => null);
  return resultado;
}

// ---------------------------------------------------------------- panel

const rowForPanel = (item, order, state, attempts, settings) => ({
  id: item.id,
  order_number: orderNumberOf(order, item),
  customer_name: clean(order.customer_name ?? item.name, 80) ?? 'Cliente',
  total: Number(order.total ?? item.total ?? 0) || 0,
  currency: order.currency ?? 'DOP',
  status: order.status ?? item.status ?? 'nuevo',
  responsible: state.responsible
    ? { type: state.responsible.type, name: state.responsible.name, user_id: state.responsible.userId ?? null }
    : null,
  stage: state.stage,
  severity: state.severity,
  next_action: state.nextAction,
  elapsed_minutes: state.elapsedMinutes,
  attempts,
  max_attempts: settings.maxAttempts,
  postpone_count: state.postponeCount ?? 0,
  postponed_until: state.postponedUntil ?? null,
  postpone_reason: state.postponeReason ?? null,
  delivered_at: order.delivered_at ?? null,
  deep_link: `/admin/?v=delivery&order=${encodeURIComponent(item.id)}`,
});

/**
 * Foto completa para el panel «Supervisor IA Delivery».
 * Solo lectura: no envía nada ni cambia estados.
 */
export async function supervisorSnapshot(ctx, options = {}) {
  const settings = await supervisorSettings(ctx);
  const now = Number.isFinite(options.now) ? options.now : ctx.clock().getTime();
  const users = options.users ?? (await ctx.users.listUsers().catch(() => []));
  const rows = (await ctx.store.listAdmin({ limit: 5000 })).filter((row) => row.type === 'order_intent');
  const events = await ctx.db.list(SUPERVISOR_EVENTS, { limit: 5000 }).catch(() => []);
  const byOrder = groupEvents(events);
  const pickups = options.pickups ?? (await pendingPickupsByOrder(ctx));
  const dayStart = now - 24 * 60 * 60 * 1000;

  const buckets = {
    revision: [],
    sin_iniciar: [],
    en_camino: [],
    atrasados: [],
    sin_respuesta: [],
    pospuestos: [],
    incidencias: [],
    confirmadas: [],
  };

  const excluded = {};
  for (const item of rows) {
    const order = parseOrderRow(item);
    if (!order) continue;
    const state = supervisionOf(order, { settings, now, pendingPickups: pickups.get(item.id) ?? 0 });
    const history = byOrder.get(item.id) ?? [];
    const attempts = remindersOf(history, state.stage).length;
    const row = rowForPanel(item, order, state, attempts, settings);

    if (state.stage === SUPERVISOR_STAGES.CLOSED) {
      const deliveredAt = firstTime(order.delivered_at);
      if (String(order.status) === 'entregado' && deliveredAt >= dayStart) buckets.confirmadas.push(row);
      continue;
    }
    /*
     * EL PANEL SOLO ENSEÑA LO QUE EL SUPERVISOR VA A TOCAR.
     * Lo excluido se cuenta aparte (por motivo), para que administración sepa
     * que no está olvidado: está fuera de alcance a propósito.
     */
    const elegibilidad = supervisionEligibility(order, settings, item.id);
    if (!elegibilidad.eligible) {
      excluded[elegibilidad.reason] = (excluded[elegibilidad.reason] ?? 0) + 1;
      // Las asignaciones anteriores a la activación no reciben mensajes en
      // bloque, pero siguen visibles para que administración pueda revisarlas.
      if (!['closed', 'delivery_cancelled'].includes(elegibilidad.reason)) {
        buckets.revision.push({
          ...row,
          review_reason: elegibilidad.reason,
          next_action: elegibilidad.reason === 'before_activation'
            ? 'Revisar pedido histórico y activar seguimiento si sigue pendiente'
            : elegibilidad.reason === 'no_assignment_date'
              ? 'Revisar fecha de asignación y activar seguimiento si sigue pendiente'
              : 'Revisar y asignar un repartidor',
        });
      }
      continue;
    }
    if (state.stage === SUPERVISOR_STAGES.POSTPONED) buckets.pospuestos.push(row);
    if ([SUPERVISOR_STAGES.NOT_CONFIRMED, SUPERVISOR_STAGES.SEND_FAILED, SUPERVISOR_STAGES.PENDING_START, SUPERVISOR_STAGES.PICKUP_PENDING].includes(state.stage)) buckets.sin_iniciar.push(row);
    if (state.stage === SUPERVISOR_STAGES.IN_TRANSIT || state.stage === SUPERVISOR_STAGES.AWAITING_CONFIRMATION) buckets.en_camino.push(row);
    if (state.stage === SUPERVISOR_STAGES.ISSUE || state.stage === SUPERVISOR_STAGES.NO_RESPONSIBLE) buckets.incidencias.push(row);
    if (state.severity === 'late' && state.stage !== SUPERVISOR_STAGES.POSTPONED) buckets.atrasados.push(row);
    if (attempts >= settings.maxAttempts) buckets.sin_respuesta.push(row);
  }

  const byUrgency = (a, b) => b.elapsed_minutes - a.elapsed_minutes;
  for (const list of Object.values(buckets)) list.sort(byUrgency);

  const upcoming = [...buckets.sin_iniciar, ...buckets.en_camino, ...buckets.pospuestos]
    .map((row) => ({ ...row }))
    .sort((a, b) => b.elapsed_minutes - a.elapsed_minutes)
    .slice(0, 12);

  const count = (list) => list.length;
  const latido = (await ctx.settings.read(SUPERVISOR_HEARTBEAT_KEY).catch(() => null))?.value ?? null;
  return {
    ok: true,
    enabled: settings.enabled,
    generated_at: new Date(now).toISOString(),
    /* Última pasada REAL del backend (el scheduler corre cada 30 s). */
    last_run_at: latido?.at ?? null,
    last_run: latido
      ? {
          reminders: latido.reminders ?? 0,
          escalations: latido.escalations ?? 0,
          deferred: latido.deferred ?? 0,
          paused: latido.paused ?? 0,
          limited: latido.limited ?? 0,
          capped: latido.capped === true,
        }
      : null,
    settings,
    activation: {
      mode: settings.activationMode,
      activatedAt: settings.activatedAt,
      includeOldOrders: settings.includeOldOrders,
      authorized: settings.includeOrderIds.length,
      required: !settings.activatedAt && !settings.includeOldOrders && settings.activationMode !== 'all',
    },
    excluded,
    counts: {
      revision: count(buckets.revision),
      sin_iniciar: count(buckets.sin_iniciar),
      en_camino: count(buckets.en_camino),
      atrasados: count(buckets.atrasados),
      sin_respuesta: count(buckets.sin_respuesta),
      pospuestos: count(buckets.pospuestos),
      incidencias: count(buckets.incidencias),
      confirmadas: count(buckets.confirmadas),
    },
    buckets,
    upcoming,
    activity: events.slice(0, 25).map((row) => ({
      id: row.id,
      order_id: row.order_id,
      kind: row.kind,
      stage: row.stage,
      status: row.status,
      detail: row.detail,
      created_at: row.created_at,
    })),
  };
}

/**
 * VISTA PREVIA DE DESTINATARIOS.
 *
 * No envía nada ni escribe nada: dice exactamente a quién se le escribiría en la
 * PRÓXIMA pasada con la hora actual, con el teléfono enmascarado y el motivo.
 * Es la pantalla que se mira antes de encender el supervisor en producción.
 */
export async function supervisorPreview(ctx, options = {}) {
  const settings = await supervisorSettings(ctx);
  const now = Number.isFinite(options.now) ? options.now : ctx.clock().getTime();
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const users = options.users ?? (await ctx.users.listUsers().catch(() => []));
  const rows = (await ctx.store.listAdmin({ limit: 5000 })).filter((row) => row.type === 'order_intent');
  const events = await ctx.db.list(SUPERVISOR_EVENTS, { limit: 20000 }).catch(() => []);
  const byOrder = groupEvents(events);
  const pickups = options.pickups ?? (await pendingPickupsByOrder(ctx));
  const localHour = hourIn(timeZone, new Date(now));
  const inHours = localHour >= settings.contactFromHour && localHour < settings.contactToHour;
  const excluded = {};
  const recipients = [];
  let candidatos = 0;

  for (const item of rows) {
    const order = parseOrderRow(item);
    if (!order) continue;
    const elegibilidad = supervisionEligibility(order, settings, item.id);
    if (!elegibilidad.eligible) {
      excluded[elegibilidad.reason] = (excluded[elegibilidad.reason] ?? 0) + 1;
      continue;
    }
    const state = supervisionOf(order, { settings, now, pendingPickups: pickups.get(item.id) ?? 0 });
    if (state.stage === SUPERVISOR_STAGES.CLOSED || state.stage === SUPERVISOR_STAGES.POSTPONED) continue;
    if (state.stage === SUPERVISOR_STAGES.NO_RESPONSIBLE || state.stage === SUPERVISOR_STAGES.ISSUE) {
      candidatos += 1;
      recipients.push({
        id: item.id,
        order_number: orderNumberOf(order, item),
        stage: state.stage,
        next_action: state.nextAction,
        kind: 'escalation',
        responsible: state.responsible?.name ?? null,
        phone: null,
        due: true,
      });
      continue;
    }
    const history = byOrder.get(item.id) ?? [];
    const attempts = remindersOf(history, state.stage).length;
    if (attempts >= settings.maxAttempts) {
      candidatos += 1;
      recipients.push({
        id: item.id,
        order_number: orderNumberOf(order, item),
        stage: state.stage,
        next_action: state.nextAction,
        kind: 'escalation',
        responsible: state.responsible?.name ?? null,
        phone: null,
        due: true,
      });
      continue;
    }
    const lastAttemptAt = Math.max(0, ...remindersOf(history, state.stage).map((row) => Date.parse(row.created_at ?? '') || 0));
    const dueAt = attempts === 0 ? state.anchorAt + settings.firstReminderMinutes * 60000 : lastAttemptAt + settings.followUpMinutes * 60000;
    if (now < dueAt) continue;
    const phone = await recipientPhoneOf(ctx, state.responsible, users);
    candidatos += 1;
    recipients.push({
      id: item.id,
      order_number: orderNumberOf(order, item),
      stage: state.stage,
      next_action: state.nextAction,
      kind: 'reminder',
      responsible: state.responsible?.name ?? null,
      responsible_type: state.responsible?.type ?? null,
      phone: phone ? `***${phone.slice(-4)}` : null,
      would_notify: settings.internalNotifications && state.responsible?.type === 'internal' ? 'internal' : phone ? 'whatsapp' : 'none',
      due: true,
    });
  }

  const enviables = recipients.filter((row) => row.kind === 'reminder');
  return {
    ok: true,
    generated_at: new Date(now).toISOString(),
    enabled: settings.enabled,
    activation: {
      mode: settings.activationMode,
      activatedAt: settings.activatedAt,
      includeOldOrders: settings.includeOldOrders,
      authorized: settings.includeOrderIds.length,
      required: !settings.activatedAt && !settings.includeOldOrders && settings.activationMode !== 'all',
    },
    in_hours: inHours,
    limits: { reminders: settings.maxRemindersPerTick, escalations: settings.maxEscalationsPerTick },
    totals: {
      candidates: candidatos,
      reminders: enviables.length,
      escalations: recipients.length - enviables.length,
      would_send: Math.min(enviables.length, settings.maxRemindersPerTick),
      deferred_by_limit: Math.max(0, enviables.length - settings.maxRemindersPerTick),
    },
    excluded,
    recipients: recipients.slice(0, 200),
  };
}

/**
 * CONCILIACIÓN DIARIA: un resumen con lo que necesita intervención humana.
 * No cierra nada por antigüedad; solo informa y deja constancia.
 */
export async function dailyReconciliation(ctx, options = {}) {
  const snapshot = await supervisorSnapshot(ctx, options);
  const deps = options.deps ?? {};
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: options.timeZone ?? DEFAULT_TIME_ZONE }).format(new Date(options.now ?? ctx.clock().getTime()));
  const pendientes =
    snapshot.counts.sin_iniciar + snapshot.counts.en_camino + snapshot.counts.atrasados + snapshot.counts.incidencias + snapshot.counts.sin_respuesta;
  const body = [
    `${snapshot.counts.sin_iniciar} sin iniciar`,
    `${snapshot.counts.en_camino} en camino`,
    `${snapshot.counts.atrasados} atrasados`,
    `${snapshot.counts.sin_respuesta} sin respuesta`,
    `${snapshot.counts.pospuestos} pospuestos`,
    `${snapshot.counts.incidencias} incidencias`,
  ].join(' · ');
  const notified = pendientes
    ? await notifySupervisorAdmins(ctx, deps, {
        type: 'DELIVERY_SUPERVISOR_DAILY',
        title: 'Resumen de entregas',
        body,
        orderId: 'daily',
        idempotencyKey: `supervisor-daily:${day}`,
        data: { day, ...snapshot.counts },
      })
    : 0;
  await supervisorEvent(ctx, {
    orderId: null,
    kind: 'daily',
    stage: null,
    status: pendientes ? 'attention' : 'ok',
    detail: body,
    actor: 'Supervisor IA',
    data: { day, ...snapshot.counts },
    idempotencyKey: `supervisor-daily:${day}`,
  });
  return { ok: true, day, pendientes, counts: snapshot.counts, admins_notified: notified };
}

// ------------------------------------------------- interpretación de respuestas

/** Intenciones que el sistema acepta (lista blanca, nada más). */
export const SUPERVISOR_INTENTS = Object.freeze([
  'ack',
  'start',
  'pickup',
  'arriving',
  'delivered',
  'confirm',
  'issue',
  'postpone',
  'help_admin',
  'unknown',
]);

/**
 * Interpretación DETERMINISTA en español dominicano.
 * Se comprueban las negaciones PRIMERO: «no lo entregué» no es «entregado».
 */
export function parseSupervisorIntent(inbound) {
  /*
   * LOS BOTONES DE LA PLANTILLA SE ENTIENDEN POR PAYLOAD **Y POR TEXTO**.
   *
   * Las respuestas rápidas de una plantilla de Cloud API pueden llegar con
   * `button.payload` o solo con `button.text` (según cómo se registró el botón
   * en Meta). Si solo se mira el payload, pulsar «Entregado» no haría nada y el
   * repartidor pensaría que el sistema está roto.
   */
  const buttonId = fold(inbound?.button?.payload ?? inbound?.interactive?.button_reply?.id ?? '');
  const buttonText = fold(inbound?.button?.text ?? inbound?.interactive?.button_reply?.title ?? '');
  const button = `${buttonId} ${buttonText}`.trim();
  if (button) {
    if (button.includes('iniciar')) return 'start';
    if (button.includes('confirmar')) return 'confirm';
    if (button.includes('entregado')) return 'delivered';
    if (button.includes('problema') || button.includes('incidencia')) return 'issue';
  }
  const text = fold(inbound?.text?.body ?? inbound?.body ?? '');
  if (!text) return null;
  const words = ` ${text} `;
  const negatedDelivery = /(no|aun no|todavia no|no he|sin)\s+(lo\s+)?(entreg|pude|puedo|llegue|llego|consegui)/.test(words);
  if (/(^|\s)(confirmo|confirmar|confirmado|si, confirmo|claro que si)(\s|$)/.test(words) || /^ si(\s|$)/.test(words) || /^ claro(\s|$)/.test(words)) return 'confirm';
  if (/\b(necesito hablar con (un )?(administrador|admin|encargado)|hablar con administracion|pasa con (el|la) (encargado|jefe)|necesito ayuda)\b/.test(words)) return 'help_admin';
  if (/\b(posponer|pospongo|reprogramar|reprogramo|manana lo entrego|lo entrego manana|manana lo llevo|lo llevo manana|despues lo llevo|no puedo hoy|otro dia)\b/.test(words)) return 'postpone';
  if (/\b(no pude conseguir|no consegui|no hay producto|no tienen (el )?producto|no pude comprar)\b/.test(words)) return 'issue';
  if (/\b(el cliente no (esta|se encuentra|abre)|no hay nadie|direccion (incorrecta|mal)|rechazo|rechazo el pedido|no pude entregar|problema|incidencia|se accidento|se me dano)\b/.test(words)) return 'issue';
  if (/\b(ya lo entregue|ya entregue|entregado|entregue el pedido|pedido entregado|lo deje|cobrado|completado)\b/.test(words) && !negatedDelivery) return 'delivered';
  if (/\b(estoy llegando|ya casi llego|estoy cerca|voy llegando|llegando)\b/.test(words)) return 'arriving';
  if (/\b(estoy recogiendo|voy a recoger|recogiendo|ya compre|ya compre los productos|ya tengo los productos|recogi)\b/.test(words)) return 'pickup';
  if (/\b(ya lo recibi|recibi el pedido|enterado|recibido|anotado|de acuerdo|ok|okay)\b/.test(words)) return 'ack';
  if (/\b(empiezo|inicio|iniciar|voy para alla|voy en camino|voy de camino|estoy de camino|salgo ahora|salgo para alla|me voy para alla|estoy saliendo|arranco|en camino)\b/.test(words)) return 'start';
  if (text === '1') return 'start';
  if (text === '2') return 'delivered';
  if (text === '3') return 'issue';
  return null;
}

/** Fecha que menciona el repartidor («mañana», «el lunes», AAAA-MM-DD…). */
export function parseDateHint(text, timeZone = DEFAULT_TIME_ZONE) {
  const value = fold(text);
  const iso = String(text ?? '').match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const dayMonth = String(text ?? '').match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/);
  if (dayMonth) {
    const year = Number(dayMonth[3] ?? new Date().getFullYear());
    return `${year}-${String(dayMonth[2]).padStart(2, '0')}-${String(dayMonth[1]).padStart(2, '0')}`;
  }
  const today = new Date();
  const add = (days) => {
    const next = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(next);
  };
  if (/\bpasado manana\b/.test(value)) return add(2);
  if (/\bmanana\b/.test(value)) return add(1);
  const weekdays = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  for (let index = 0; index < weekdays.length; index += 1) {
    if (new RegExp(`\\b(el )?${weekdays[index]}\\b`).test(value)) {
      const delta = ((index - today.getDay() + 7) % 7) || 7;
      return add(delta);
    }
  }
  return null;
}

/** Respuesta al repartidor: texto libre SOLO dentro de la ventana de 24 h. */
const outboundReply = async (ctx, phone, body, conversation, idempotencyKey) => {
  try {
    if (!ctx.whatsapp?.enabled || !phone) return { ok: false, reason: 'whatsapp_disabled' };
    if (!conversation || !ctx.customers.canSendFreeText(conversation)) return { ok: false, reason: 'outside_window' };
    const sent = await ctx.whatsapp.sendText(phone, body, { idempotencyKey });
    return sent?.ok ? { ok: true, messageId: sent.messageId ?? null } : { ok: false, reason: sent?.error?.message ?? 'send_failed' };
  } catch (error) {
    console.error('[crm] supervisor: respuesta al repartidor:', error?.message ?? error);
    return { ok: false, reason: 'send_failed' };
  }
};

/**
 * RESPUESTA DE UN REPARTIDOR (interno o externo) POR WHATSAPP.
 *
 * Siempre devuelve un resultado y NUNCA lanza: el webhook de Meta no puede
 * caerse por esto. Si el número no es de un repartidor, `handled:false` y el
 * mensaje sigue su curso normal como cliente.
 */
export async function handleSupervisorReply(input) {
  const { ctx, inbound, conversation = null, deps = {} } = input;
  const from = toE164(inbound?.fromE164 ?? inbound?.from ?? inbound?.waId);
  if (!from) return { handled: false, reason: 'no_phone' };

  const saved = savedCourierContacts((await ctx.settings.read('delivery_contacts').catch(() => null))?.value);
  const contact = saved.find((row) => row.phone === from) ?? null;
  const users = contact ? [] : deps.users ?? (await ctx.users.listUsers().catch(() => []));
  const internalUser = contact
    ? null
    : users.find((user) => user.active !== false && (toE164(user.personal_phone) === from || toE164(user.fleet_phone) === from)) ?? null;
  if (!contact && !internalUser) return { handled: false, reason: 'not_a_courier' };

  const settings = await supervisorSettings(ctx);
  if (!settings.enabled) return { handled: false, reason: 'supervisor_off' };

  /*
   * La conversación que devuelve el webhook se leyó ANTES de sellar
   * `last_inbound_at`, así que puede llegar sin ese dato y la respuesta se
   * quedaría sin enviar por «ventana cerrada» (falso). Se relee antes de usar.
   */
  let replyConversation = conversation;
  const liveConversation = async () => {
    if (replyConversation?.last_inbound_at) return replyConversation;
    const customerId = replyConversation?.customer_id ?? null;
    if (!customerId) return replyConversation;
    replyConversation = (await ctx.customers.conversationFor(customerId).catch(() => null)) ?? replyConversation;
    return replyConversation;
  };

  const text = String(inbound?.text?.body ?? inbound?.body ?? '').slice(0, 600);
  const rows = (await ctx.store.listAdmin({ limit: 5000 })).filter((row) => row.type === 'order_intent');
  const open = [];
  for (const item of rows) {
    const order = parseOrderRow(item);
    if (!order) continue;
    if (CLOSED_STATUSES.includes(String(order.status ?? item.status ?? ''))) continue;
    if (contact) {
      if (courierOf(order)?.phone_e164 !== contact.phone) continue;
    } else if (order.delivery?.delivery_user_id !== internalUser.id) continue;
    open.push({ item, order });
  }
  const responderName = contact?.name ?? internalUser?.display_name ?? internalUser?.username ?? 'Repartidor';
  if (!open.length) {
    await outboundReply(
      ctx,
      from,
      'No tienes pedidos abiertos asignados. Si crees que es un error, avisa a administración.',
      await liveConversation(),
      `supervisor-no-open:${inbound.waMessageId ?? from}`,
    );
    return { handled: true, reason: 'no_open_order' };
  }

  // 1) Intención determinista; 2) si no hay, la IA PROPONE (nunca ejecuta).
  let intent = parseSupervisorIntent(inbound);
  let source = 'rules';
  let aiNote = null;
  if (!intent && settings.useDeepSeek && typeof ctx.proofreading?.interpret === 'function') {
    const ai = await ctx.proofreading
      .interpret({ text, options: SUPERVISOR_INTENTS, context: { pedidos_abiertos: open.slice(0, 8).map(({ order }) => order.order_number ?? null) }, actorId: 'supervisor' })
      .catch(() => null);
    if (ai && ai.intent && SUPERVISOR_INTENTS.includes(ai.intent) && Number(ai.confidence ?? 0) >= 0.6) {
      intent = ai.intent;
      source = 'deepseek';
      aiNote = clean(ai.note, 200);
    }
  }

  // 2) ¿De qué pedido habla? Con varios abiertos NO se adivina.
  let target = open[0];
  if (open.length > 1) {
    const folded = fold(text);
    const byNumber = open.find(({ order, item }) => {
      const number = fold(orderNumberOf(order, item));
      return number && folded.includes(number);
    });
    if (!byNumber) {
      await outboundReply(
        ctx,
        from,
        `Tienes ${open.length} pedidos abiertos: ${open.map(({ order, item }) => orderNumberOf(order, item)).join(', ')}.\nResponde con el número de pedido para saber de cuál hablamos.`,
        await liveConversation(),
        `supervisor-ambiguous:${inbound.waMessageId ?? from}`,
      );
      return { handled: true, reason: 'ambiguous', replied: true };
    }
    target = byNumber;
  }
  const { item, order } = target;
  const number = orderNumberOf(order, item);
  const state = supervisionOf(order, { settings, now: ctx.clock().getTime() });
  const supervisor = order.delivery?.supervisor ?? {};
  const pending = supervisor.pending_action ?? null;
  const replyKey = (suffix) => `supervisor-reply:${inbound.waMessageId ?? ctx.clock().toISOString()}:${suffix}`;

  const answer = async (body, suffix) => outboundReply(ctx, from, body, await liveConversation(), replyKey(suffix));
  /**
   * Un solo guardado por respuesta: estado del envío (si es externo), estado
   * operativo y bloque del supervisor. Antes se escribía dos veces y la segunda
   * borraba lo de la primera.
   */
  const remember = async (patch = {}, event) => {
    const { external, deliveryStatus, ...supervisorPatch } = patch;
    /*
     * Se RELEE el pedido antes de escribir: entre la lectura inicial y este
     * punto pudo cambiar (la transición oficial a entregado, o la posposición
     * recién aplicada). Escribir sobre la copia vieja borraba ese cambio.
     */
    const fresh = await (async () => {
      try {
        // OJO: en SQLite `store.listAdmin()` es SÍNCRONO. Nunca `.then()` aquí.
        const rows = await Promise.resolve(ctx.store.listAdmin({ limit: 5000 }));
        return parseOrderRow(rows.find((row) => row.id === item.id));
      } catch {
        return null;
      }
    })();
    const baseOrder = fresh ?? order;
    const base = baseOrder.delivery ?? {};
    const at = ctx.clock().toISOString();
    const next = {
      ...baseOrder,
      delivery: {
        ...base,
        ...(deliveryStatus ? { delivery_status: deliveryStatus } : {}),
        ...(external ? { external: { ...(base.external ?? {}), ...external } } : {}),
        supervisor: { ...(base.supervisor ?? {}), last_reply_at: at, ...supervisorPatch },
      },
      updated_at: at,
    };
    await ctx.store.update(item.id, { orderJson: JSON.stringify(next) });
    await supervisorEvent(ctx, {
      orderId: item.id,
      kind: event.kind,
      stage: state.stage,
      status: event.status ?? 'ok',
      detail: event.detail,
      actor: `Repartidor ${responderName}`,
      data: { intent, source, note: aiNote, text: text.slice(0, 200) },
      idempotencyKey: replyKey(`event:${event.kind}`),
    });
    return next;
  };

  if (!intent) {
    await remember({}, { kind: 'unclear', status: 'asked', detail: 'Mensaje ambiguo: se preguntó antes de actuar' });
    await answer(
      `No entendí del todo. Para el pedido ${number} puedes responder:\n• Entregado\n• Voy en camino\n• Tengo un problema\n• Mañana lo entrego`,
      'unclear',
    );
    return { handled: true, reason: 'unclear', orderId: item.id };
  }

  if (intent === 'ack') {
    await remember({ acknowledged_at: ctx.clock().toISOString() }, { kind: 'ack', detail: 'Repartidor confirmó que recibió el pedido' });
    await answer(`Anotado. Pedido ${number}: ${state.nextAction}. Cuando lo tengas listo, escríbenos por aquí.`, 'ack');
    return { handled: true, reason: 'ack', orderId: item.id };
  }

  if (intent === 'start') {
    if ([SUPERVISOR_STAGES.NOT_CONFIRMED, SUPERVISOR_STAGES.SEND_FAILED].includes(state.stage)) {
      await answer(`Todavía no te hemos enviado los datos del pedido ${number}. Espera el mensaje con la dirección y el mapa.`, 'start-not-sent');
      return { handled: true, reason: 'start_without_assignment', orderId: item.id };
    }
    if (state.stage === SUPERVISOR_STAGES.ISSUE) {
      await answer(`El pedido ${number} tiene una incidencia abierta: administración debe resolverla antes de continuar.`, 'start-issue');
      return { handled: true, reason: 'issue_pending', orderId: item.id };
    }
    await remember(
      {
        deliveryStatus: contact ? undefined : 'IN_TRANSIT',
        external: contact ? { status: COURIER_STATUS.IN_PROGRESS, started_at: ctx.clock().toISOString() } : undefined,
        started_at: ctx.clock().toISOString(),
      },
      { kind: 'started', detail: 'Entrega iniciada por WhatsApp' },
    );
    await answer(`Anotado: pedido ${number} en camino. Cuando termines, responde «Entregado».`, 'start');
    return { handled: true, reason: 'started', orderId: item.id };
  }

  if (intent === 'pickup') {
    await remember(
      { pickup_reported_at: ctx.clock().toISOString() },
      { kind: 'pickup_reported', detail: 'El repartidor reportó la recogida en tienda' },
    );
    await answer(`Anotado: recogida del pedido ${number} reportada. Si en la tienda pagaste algo, guarda el comprobante.`, 'pickup');
    return { handled: true, reason: 'pickup_reported', orderId: item.id };
  }

  if (intent === 'arriving') {
    await remember({ arriving_at: ctx.clock().toISOString() }, { kind: 'arriving', detail: 'El repartidor avisó que está llegando' });
    await answer(`Anotado: estás llegando con el pedido ${number}. Confirma aquí cuando lo entregues.`, 'arriving');
    return { handled: true, reason: 'arriving', orderId: item.id };
  }

  if (intent === 'delivered') {
    if (state.stage === SUPERVISOR_STAGES.AWAITING_CONFIRMATION) {
      await answer(`¿Confirmas que el pedido ${number} fue entregado al cliente? Responde «CONFIRMAR».`, 'delivered-again');
      return { handled: true, reason: 'awaiting_confirmation', orderId: item.id };
    }
    await remember(
      {
        external: contact ? { status: COURIER_STATUS.AWAITING_CONFIRMATION, delivered_reported_at: ctx.clock().toISOString() } : undefined,
        delivered_reported_at: ctx.clock().toISOString(),
        pending_action: { type: 'confirm_delivery', stage: 'awaiting_confirmation', asked_at: ctx.clock().toISOString() },
      },
      { kind: 'delivered_reported', detail: 'El repartidor marcó el pedido como entregado (pendiente de confirmar)' },
    );
    await answer(`¿Confirmas que el pedido ${number} fue entregado al cliente? Responde «CONFIRMAR» para cerrarlo.`, 'delivered');
    return { handled: true, reason: 'awaiting_confirmation', orderId: item.id };
  }

  if (intent === 'confirm') {
    // ¿Confirmaba una POSPOSICIÓN pendiente?
    if (pending?.type === 'postpone') {
      const result = await postponeDelivery({
        ctx,
        item,
        order,
        actor: { id: contact ? null : internalUser.id, display_name: responderName },
        reason: pending.reason ?? 'Reprogramado por el repartidor',
        until: pending.until,
        source: contact ? 'EXTERNAL_COURIER' : 'INTERNAL_COURIER',
        deps,
      });
      if (!result.ok) {
        await answer(`No pude posponer el pedido ${number}: ${result.message}`, 'postpone-error');
        return { handled: true, reason: 'postpone_failed', orderId: item.id };
      }
      await remember({ pending_action: null }, { kind: 'postponed', detail: `Pospuesto hasta ${result.postponedUntil.slice(0, 10)}` });
      await answer(`Listo. Pedido ${number} pospuesto para el ${result.postponedUntil.slice(0, 10)}. Ese día te recordamos.`, 'postpone-ok');
      return { handled: true, reason: 'postponed', orderId: item.id };
    }
    if (state.stage !== SUPERVISOR_STAGES.AWAITING_CONFIRMATION) {
      await answer(`Para cerrar un pedido primero responde «Entregado» y luego «CONFIRMAR».`, 'confirm-invalid');
      return { handled: true, reason: 'confirm_without_report', orderId: item.id };
    }
    if (typeof deps.completeDelivery !== 'function') {
      await answer('No pude cerrar el pedido en el sistema. Avisa a administración.', 'confirm-unavailable');
      return { handled: true, reason: 'confirm_unavailable', orderId: item.id };
    }
    const done = await deps.completeDelivery(item.id, {
      reason: contact ? `Entregado por repartidor externo ${contact.name}` : `Entregado por ${internalUser.display_name ?? 'agente'}`,
      source: contact ? 'EXTERNAL_COURIER' : 'INTERNAL_COURIER',
    });
    if (!done?.ok) {
      await answer('No se pudo cerrar el pedido en el sistema. Avisa al equipo para que lo revise.', 'confirm-error');
      return { handled: true, reason: 'confirm_failed', orderId: item.id, error: done?.error ?? null };
    }
    await remember(
      {
        external: contact ? { status: COURIER_STATUS.DELIVERED, delivered_at: ctx.clock().toISOString() } : undefined,
        pending_action: null,
        confirmed_at: ctx.clock().toISOString(),
      },
      { kind: 'delivered_confirmed', detail: 'Entrega confirmada por WhatsApp' },
    );
    await answer(`Listo. Pedido ${number} cerrado como entregado. ¡Gracias!`, 'confirm-ok');
    return { handled: true, reason: 'delivered', orderId: item.id };
  }

  if (intent === 'issue') {
    await remember(
      {
        deliveryStatus: contact ? undefined : 'ISSUE_REPORTED',
        external: contact ? { status: COURIER_STATUS.ISSUE, issue_at: ctx.clock().toISOString(), issue_note: text.slice(0, 300) } : undefined,
        issue_at: ctx.clock().toISOString(),
        issue_note: text.slice(0, 300),
      },
      { kind: 'issue', status: 'attention', detail: `Incidencia reportada: ${text.slice(0, 160)}` },
    );
    await escalate(ctx, deps, {
      item,
      order,
      state: { ...state, stage: SUPERVISOR_STAGES.ISSUE, nextAction: STAGE_NEXT_ACTION.issue },
      settings,
      reason: 'courier_issue',
    });
    await answer(`Anotado el problema con el pedido ${number}. Administración ya fue avisada y se pondrá en contacto.`, 'issue');
    return { handled: true, reason: 'issue', orderId: item.id };
  }

  if (intent === 'postpone') {
    const hint = parseDateHint(text, deps.timeZone ?? DEFAULT_TIME_ZONE);
    if (!hint) {
      await remember(
        { pending_action: { type: 'postpone', asked_at: ctx.clock().toISOString(), reason: text.slice(0, 200) } },
        { kind: 'postpone_asked', status: 'asked', detail: 'Pidió posponer sin fecha: se pidió el día' },
      );
      await answer(`¿Para qué día posponemos el pedido ${number}? Escríbelo así: 2026-10-22`, 'postpone-date');
      return { handled: true, reason: 'postpone_date_needed', orderId: item.id };
    }
    await remember(
      { pending_action: { type: 'postpone', until: hint, reason: text.slice(0, 200), asked_at: ctx.clock().toISOString() } },
      { kind: 'postpone_asked', status: 'asked', detail: `Propuso posponer para ${hint}` },
    );
    await answer(`¿Confirmas posponer el pedido ${number} para el ${hint}? Responde «CONFIRMAR».`, 'postpone-confirm');
    return { handled: true, reason: 'postpone_confirmation', orderId: item.id };
  }

  if (intent === 'help_admin') {
    await remember({ help_requested_at: ctx.clock().toISOString() }, { kind: 'help_requested', status: 'attention', detail: 'El repartidor pidió hablar con administración' });
    await notifySupervisorAdmins(ctx, deps, {
      type: 'DELIVERY_SUPERVISOR_HELP',
      title: 'Un repartidor pide hablar',
      body: `${contact ? contact.name : internalUser.display_name ?? 'Agente'} · pedido ${number}`,
      orderId: item.id,
      idempotencyKey: `supervisor-help:${item.id}:${inbound.waMessageId ?? ctx.clock().toISOString()}`,
      data: { order_id: item.id, from: contact ? 'external' : 'internal' },
    });
    await answer('Ya avisamos a administración. Te escriben en cuanto puedan.', 'help');
    return { handled: true, reason: 'help_admin', orderId: item.id };
  }

  return { handled: false, reason: 'unhandled' };
}
