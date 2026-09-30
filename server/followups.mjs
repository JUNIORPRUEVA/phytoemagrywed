/**
 * SEGUIMIENTO — plan de acompañamiento por compra entregada.
 *
 * QUÉ HACE Y QUÉ NO HACE (esta fase)
 *  - SÍ: cuando una compra queda ENTREGADA, crea las tareas de seguimiento con su
 *    fecha (día 1, 3, 7, 14, 21, 30 por defecto, configurable).
 *  - SÍ: clasifica cada tarea en PENDIENTE / PARA HOY / VENCIDA para la pantalla HOY.
 *  - NO: enviar mensajes automáticamente. Una fecha de seguimiento es una TAREA
 *    para una persona: el CRM la muestra y el negocio decide qué escribir y cuándo
 *    pulsar ENVIAR. Programar no es enviar.
 *
 * La configuración vive en `FOLLOWUP_PLAN` (y se puede sobrescribir con la
 * variable `PHYTO_FOLLOWUP_PLAN` en JSON), no repartida por el código.
 */

import { randomBytes } from 'node:crypto';

/** Zona del negocio (República Dominicana). */
export const DEFAULT_TIME_ZONE = 'America/Santo_Domingo';

/**
 * Plan por defecto. `day` = días después de la entrega.
 * Cada entrada lleva su motivo y la plantilla oficial sugerida (informativa).
 */
export const FOLLOWUP_PLAN = Object.freeze([
  { key: 'day1', day: 1, type: 'thanks', reason: 'Agradecimiento y orientación de uso', template: 'phyto_purchase_thanks' },
  { key: 'day3', day: 3, type: 'checkin', reason: '¿Cómo te ha ido hasta ahora?', template: 'phyto_followup_checkin' },
  { key: 'day7', day: 7, type: 'education', reason: 'Contenido educativo aprobado', template: 'phyto_weekly_education' },
  { key: 'day14', day: 14, type: 'checkin', reason: 'Seguimiento personalizado', template: 'phyto_followup_checkin' },
  { key: 'day21', day: 21, type: 'education', reason: 'Contenido educativo aprobado', template: 'phyto_weekly_education' },
  { key: 'day30', day: 30, type: 'reorder', reason: 'Recompra cuando corresponda', template: 'phyto_reorder_reminder' },
]);

/** Estados de una tarea de seguimiento. */
export const FOLLOWUP_STATUSES = Object.freeze(['pending', 'completed', 'cancelled', 'skipped']);

/** Dosis diaria por defecto si no hay dato mejor (`usage` del producto dice 1). */
export const DEFAULT_DAILY_CAPSULES = 1;

/** Lee el plan del entorno si viene en JSON válido; si no, usa el de por defecto. */
export function resolvePlan(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return FOLLOWUP_PLAN.map((entry) => ({ ...entry }));
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) return FOLLOWUP_PLAN.map((entry) => ({ ...entry }));
    return parsed
      .filter((entry) => Number.isFinite(Number(entry?.day)) && String(entry?.key ?? '').trim())
      .map((entry) => ({
        key: String(entry.key).trim(),
        day: Math.max(0, Math.trunc(Number(entry.day))),
        type: String(entry.type ?? 'checkin'),
        reason: String(entry.reason ?? 'Seguimiento'),
        template: entry.template ? String(entry.template) : null,
      }));
  } catch {
    return FOLLOWUP_PLAN.map((entry) => ({ ...entry }));
  }
}

/**
 * Dosis diaria de cápsulas: del texto de uso aprobado o de la configuración.
 *
 * "1 cápsula al día después del desayuno" → 1. No se inventa nada: si el texto
 * no lo dice y no hay configuración, se usa 1 (el valor confirmado hoy).
 *
 * @param {string|null|undefined} usageText
 * @param {string|number|null|undefined} configured
 */
export function resolveDailyCapsules(usageText, configured) {
  const explicit = Number(configured);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const match = /(\d+)\s*c[áa]psulas?\s*(al d[íi]a|diarias?|por d[íi]a)/i.exec(String(usageText ?? ''));
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return DEFAULT_DAILY_CAPSULES;
}

/**
 * Estima cuánto dura un pedido y cuándo tocaría la próxima compra.
 *
 * Es una ESTIMACIÓN explicable: cápsulas totales ÷ dosis diaria. Sirve para
 * avisar al negocio, no para prometer nada al cliente.
 *
 * @param {{ capsules?: number|null, quantity?: number|null, dailyCapsules?: number }} input
 */
export function estimateSupply(input = {}) {
  const capsules = Number(input.capsules ?? 0);
  const quantity = Number(input.quantity ?? 1) || 1;
  const daily = Number(input.dailyCapsules ?? DEFAULT_DAILY_CAPSULES) || DEFAULT_DAILY_CAPSULES;
  if (!Number.isFinite(capsules) || capsules <= 0) return { days: null, totalCapsules: null, dailyCapsules: daily };
  const totalCapsules = capsules * quantity;
  return { days: Math.max(1, Math.round(totalCapsules / daily)), totalCapsules, dailyCapsules: daily };
}

// ------------------------------------------------------------------ utilidades

/** `YYYY-MM-DD` de una fecha en la zona del negocio. */
export function dayIn(date, timeZone = DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date instanceof Date ? date : new Date(date));
}

/** `YYYY-MM-DD` + n días (aritmética en UTC sobre fecha sin hora). */
export function addDays(day, days) {
  const [year, month, date] = String(day).split('-').map(Number);
  const base = Date.UTC(year, month - 1, date);
  const next = new Date(base + Math.trunc(days) * 86400000);
  return next.toISOString().slice(0, 10);
}

/** Diferencia en días entre dos `YYYY-MM-DD`. */
export function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** Identificador corto y aleatorio para tareas creadas a mano. */
function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

/**
 * Motor de seguimiento.
 *
 * @param {object} deps
 * @param {any} deps.db                almacén de colecciones (`store.db`)
 * @param {any[]} [deps.plan]
 * @param {string} [deps.timeZone]
 * @param {() => Date} [deps.clock]
 * @param {number} [deps.dailyCapsules]
 */
export function createFollowupEngine(deps) {
  const db = deps.db;
  const plan = deps.plan ?? FOLLOWUP_PLAN;
  const timeZone = deps.timeZone ?? DEFAULT_TIME_ZONE;
  const clock = deps.clock ?? (() => new Date());
  const dailyCapsules = Number(deps.dailyCapsules ?? DEFAULT_DAILY_CAPSULES) || DEFAULT_DAILY_CAPSULES;

  const today = () => dayIn(clock(), timeZone);

  return {
    plan,
    today,
    timeZone,
    dailyCapsules,

    /**
     * Crea el plan de seguimiento de una compra entregada.
     *
     * IDEMPOTENTE: la clave de cada tarea es `fu:<purchaseId>:<key>`. Si el proceso
     * se reinicia, si el pedido se vuelve a marcar como entregado o si dos
     * peticiones llegan a la vez, no se duplica ninguna tarea.
     *
     * @param {{ customerId: string, purchaseId: string, deliveredAt?: string, capsules?: number|null, quantity?: number|null }} input
     */
    async scheduleForPurchase(input) {
      const deliveredDay = dayIn(input.deliveredAt ?? clock(), timeZone);
      const supply = estimateSupply({ capsules: input.capsules, quantity: input.quantity, dailyCapsules });
      /** @type {any[]} */
      const created = [];
      for (const entry of plan) {
        const scheduledAt = addDays(deliveredDay, entry.day);
        const doc = {
          id: newId('fu'),
          customer_id: input.customerId,
          purchase_id: input.purchaseId,
          key: entry.key,
          type: entry.type,
          reason: entry.reason,
          template: entry.template ?? null,
          channel: 'whatsapp',
          scheduled_at: scheduledAt,
          status: 'pending',
          origin: 'plan',
          attempts: 0,
          last_error: null,
          created_at: new Date().toISOString(),
          idempotency_key: `fu:${input.purchaseId}:${entry.key}`,
        };
        const result = await db.insert('followups', doc);
        if (!result.duplicate) created.push(doc);
      }
      return { created, deliveredDay, supply, nextReorderAt: supply.days ? addDays(deliveredDay, supply.days) : null };
    },

    /** Tareas de un cliente (más cercanas primero). */
    async listForCustomer(customerId) {
      const rows = await db.list('followups', { by: 'scheduled_at', order: 'asc' });
      return rows.filter((row) => row.customer_id === customerId);
    },

    /** Tareas de una compra concreta. */
    async listForPurchase(purchaseId) {
      const rows = await db.list('followups', { by: 'scheduled_at', order: 'asc' });
      return rows.filter((row) => row.purchase_id === purchaseId);
    },

    /** La próxima tarea pendiente de un cliente (o null). */
    async nextForCustomer(customerId) {
      const pending = (await this.listForCustomer(customerId)).filter((row) => row.status === 'pending');
      return pending[0] ?? null;
    },

    /**
     * Clasifica las tareas para la pantalla HOY.
     *
     * Aquí está la decisión clave de esta fase: el sistema NO envía nada al llegar
     * la fecha; solo dice qué toca y qué se ha pasado de fecha.
     *
     * @param {{ customerId?: string }} [options]
     */
    async buckets(options = {}) {
      const reference = today();
      const all = await db.list('followups', { by: 'scheduled_at', order: 'asc' });
      const scoped = options.customerId ? all.filter((row) => row.customer_id === options.customerId) : all;
      const pending = scoped.filter((row) => row.status === 'pending');
      return {
        today: pending.filter((row) => row.scheduled_at === reference),
        overdue: pending.filter((row) => row.scheduled_at < reference),
        upcoming: pending.filter((row) => row.scheduled_at > reference),
        completed: scoped.filter((row) => row.status === 'completed'),
        cancelled: scoped.filter((row) => row.status === 'cancelled' || row.status === 'skipped'),
        reference,
      };
    },

    /** Cuentas para métricas y la insignia del panel. */
    async summary() {
      const { today: forToday, overdue, upcoming, completed } = await this.buckets();
      return {
        today: forToday.length,
        overdue: overdue.length,
        upcoming: upcoming.length,
        completed: completed.length,
        dueNow: forToday.length + overdue.length,
      };
    },

    /** Marca una tarea como realizada (el negocio ya escribió o llamó al cliente). */
    async complete(id, patch = {}) {
      return db.update('followups', id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        completed_by: patch.by ?? 'panel',
        message_id: patch.messageId ?? null,
        outcome: patch.outcome ?? null,
      });
    },

    /** Omite una tarea sin haber contactado (no es un error, es una decisión). */
    async skip(id, patch = {}) {
      return db.update('followups', id, {
        status: 'skipped',
        completed_at: new Date().toISOString(),
        outcome: patch.reason ?? 'omitido',
      });
    },

    /** Cancela una tarea (por ejemplo tras un opt-out o una venta cerrada). */
    async cancel(id, patch = {}) {
      return db.update('followups', id, {
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        outcome: patch.reason ?? 'cancelado',
      });
    },

    /** Posponer: nueva fecha (días o fecha concreta). */
    async postpone(id, patch = {}) {
      const current = await db.get('followups', id);
      if (!current) return null;
      const nextDate = patch.date
        ? String(patch.date).slice(0, 10)
        : addDays(current.scheduled_at ?? today(), Number(patch.days ?? 1) || 1);
      return db.update('followups', id, {
        scheduled_at: nextDate,
        status: 'pending',
        postponed_from: current.scheduled_at ?? null,
        postponed_at: new Date().toISOString(),
      });
    },

    /** Cambiar la fecha a mano. */
    async reschedule(id, date) {
      return db.update('followups', id, { scheduled_at: String(date).slice(0, 10), status: 'pending' });
    },

    /** Tarea creada por el negocio (fuera del plan automático). */
    async createManual(input) {
      const doc = {
        id: newId('fu'),
        customer_id: input.customerId,
        purchase_id: input.purchaseId ?? null,
        key: `manual_${Date.now().toString(36)}`,
        type: input.type ?? 'manual',
        reason: input.reason ?? 'Seguimiento manual',
        template: input.template ?? null,
        channel: 'whatsapp',
        scheduled_at: String(input.scheduledAt ?? today()).slice(0, 10),
        status: 'pending',
        origin: 'manual',
        attempts: 0,
        last_error: null,
        created_at: new Date().toISOString(),
        idempotency_key: input.idempotencyKey ?? `fu:manual:${newId('k')}`,
      };
      await db.insert('followups', doc);
      return doc;
    },

    /**
     * Cancela las tareas de MARKETING de un cliente (agradecimiento, educación,
     * recompra). Se usa cuando el cliente pide no recibir más mensajes: su
     * decisión manda sobre cualquier plan.
     */
    async cancelMarketingFor(customerId, reason = 'opt_out') {
      const pending = (await this.listForCustomer(customerId)).filter((row) => row.status === 'pending');
      const cancelled = [];
      for (const row of pending) {
        if (row.type === 'manual') continue;
        const updated = await this.cancel(row.id, { reason });
        if (updated) cancelled.push(updated);
      }
      return cancelled;
    },

    /** Estimación de duración del pedido (para avisar de la próxima recompra). */
    supplyFor(purchase) {
      return estimateSupply({
        capsules: purchase?.capsules,
        quantity: purchase?.quantity,
        dailyCapsules,
      });
    },
  };
}
