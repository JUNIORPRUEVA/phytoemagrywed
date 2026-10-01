/**
 * AUDITORÍA COMERCIAL — trazabilidad de lo que pasó.
 *
 * No es contabilidad financiera: es el rastro comercial. Quién creó un pedido,
 * quién lo canceló, cuándo se completó un seguimiento, qué mensaje se programó y
 * si salió o no. Sirve para poder explicar cualquier número del panel.
 *
 * Nunca se borra ni se edita una entrada: se añaden.
 */

import { randomBytes } from 'node:crypto';

/** Acciones auditables (lista cerrada: evita etiquetas inventadas). */
export const AUDIT_ACTIONS = Object.freeze([
  'order.created',
  'order.updated',
  'order.status_changed',
  'order.cancelled',
  'followup.created',
  'followup.completed',
  'followup.postponed',
  'followup.cancelled',
  'message.scheduled',
  'message.sent',
  'message.failed',
  'message.blocked',
  'message.cancelled',
  // Recuperación EXCEPCIONAL de un envío ambiguo (SEND_UNKNOWN): quién lo revisó
  // y qué decidió. No es una acción normal del vendedor y queda registrado.
  'message.reconciled',
  /*
   * UBICACIONES: enviar una ubicación y COMPARTIRLA con otro chat. Compartir es
   * una acción sensible (la ubicación puede ser el domicilio de alguien), así que
   * queda registrada con origen y destino —siempre sin coordenadas—.
   */
  'location.sent',
  'location.shared',
  'customer.status_changed',
  'customer.opt_out',
  'customer.opt_in',
  /*
   * RESPUESTAS RÁPIDAS del panel (los textos que el operador reutiliza en el
   * chat). Se registra el alta, la edición y el borrado, con el NOMBRE como
   * resumen: el cuerpo del texto no se guarda en la traza (no aporta nada al
   * rastro y suele ser largo).
   */
  'quick_reply_created',
  'quick_reply_updated',
  'quick_reply_deleted',
  'inventory_added',
  'inventory_adjusted',
  'inventory_sale',
  'inventory_sale_reversed',
  'product_cost_changed',
  'sale_price_changed',
]);

function newId() {
  return `aud_${randomBytes(8).toString('hex')}`;
}

/** Texto corto y plano (nunca se guarda un objeto enorme ni un secreto). */
function short(value, max = 240) {
  if (value === null || value === undefined) return null;
  const clean = String(value).replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

/**
 * @param {object} deps
 * @param {any} deps.db   almacén de colecciones
 * @param {() => Date} [deps.clock]
 */
export function createAuditLog(deps) {
  const db = deps.db;
  const clock = deps.clock ?? (() => new Date());

  return {
    actions: AUDIT_ACTIONS,

    /**
     * Registra una entrada. IDEMPOTENTE si se pasa `idempotencyKey`: un webhook
     * reintentado o un envío repetido no duplican la traza.
     *
     * @param {{ entity: string, entityId?: string|null, action: string, actor?: string|null,
     *           summary?: string|null, data?: Record<string, any>|null,
     *           idempotencyKey?: string|null }} input
     */
    async record(input) {
      const action = String(input?.action ?? '').trim();
      if (!AUDIT_ACTIONS.includes(action)) {
        // Una acción desconocida es un error de programación, no un dato: se ignora
        // en vez de ensuciar la traza con etiquetas que nadie podrá interpretar.
        return null;
      }
      const id = newId();
      const doc = {
        id,
        entity: short(input.entity, 40) ?? 'sistema',
        entity_id: short(input.entityId, 80),
        action,
        actor: short(input.actor, 60) ?? 'panel',
        summary: short(input.summary, 240),
        data: input.data && typeof input.data === 'object' ? input.data : null,
        created_at: clock().toISOString(),
        idempotency_key: short(input.idempotencyKey, 120),
      };
      const result = await db.insert('audit', doc);
      return result?.duplicate ? null : doc;
    },

    /** Últimas entradas (más recientes primero), opcionalmente de una entidad. */
    async list(options = {}) {
      const rows = await db.list('audit', { limit: options.limit ?? 200, by: 'created_at', order: 'desc' });
      let filtered = rows;
      if (options.entity) filtered = filtered.filter((row) => row.entity === options.entity);
      if (options.entityId) filtered = filtered.filter((row) => row.entity_id === options.entityId);
      if (options.action) filtered = filtered.filter((row) => row.action === options.action);
      return options.limit ? filtered.slice(0, options.limit) : filtered;
    },

    /** Cuántas entradas hay de cada acción (diagnóstico rápido). */
    async summary(options = {}) {
      const rows = await this.list({ limit: options.limit ?? 1000 });
      /** @type {Record<string, number>} */
      const byAction = {};
      for (const row of rows) byAction[row.action] = (byAction[row.action] ?? 0) + 1;
      return { total: rows.length, byAction, latest: rows[0]?.created_at ?? null };
    },
  };
}
