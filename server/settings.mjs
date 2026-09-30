/**
 * AJUSTES DEL NEGOCIO — lo que antes solo se podía cambiar por variable de entorno.
 *
 * Se guarda en la colección `settings` (un documento por clave) para que sobreviva
 * a un reinicio y valga en los tres backends. Hoy hay una sola clave:
 *
 *   `followup` → qué días del plan de postventa están activos.
 *
 * Regla: un valor ausente NO se inventa. El plan se construye a partir del plan
 * base (`FOLLOWUP_PLAN`) y los interruptores solo lo *filtran*. Si el negocio
 * apaga «Día 21», no se crea nunca más esa tarea; las que ya existían no se borran
 * (una tarea creada es una promesa con un cliente, no un ajuste de pantalla).
 */

/** Clave donde vive la configuración del seguimiento. */
export const FOLLOWUP_SETTINGS_KEY = 'followup';

/**
 * Normaliza los interruptores: `{ day1: true, day3: false, ... }`.
 * Solo se aceptan claves que existan en el plan base.
 *
 * @param {any} raw
 * @param {Array<{key: string}>} plan
 */
export function normalizeFollowupSettings(raw, plan) {
  const keys = plan.map((entry) => entry.key);
  const source = raw && typeof raw === 'object' && raw.enabled && typeof raw.enabled === 'object' ? raw.enabled : {};
  /** @type {Record<string, boolean>} */
  const enabled = {};
  for (const key of keys) enabled[key] = source[key] !== false;
  return { enabled };
}

/**
 * @param {object} deps
 * @param {any} deps.db
 * @param {Array<{key: string, day: number, type: string, reason: string, template: string|null}>} deps.plan
 * @param {() => Date} [deps.clock]
 */
export function createSettingsService(deps) {
  const db = deps.db;
  const basePlan = deps.plan;
  const clock = deps.clock ?? (() => new Date());

  async function read(key) {
    const doc = await db.findBy('settings', 'key', key);
    return doc ?? null;
  }

  async function write(key, value) {
    const existing = await read(key);
    const now = clock().toISOString();
    const doc = {
      id: existing?.id ?? `set_${key}`,
      key,
      value,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing) return db.update('settings', existing.id, doc);
    const result = await db.insert('settings', doc);
    // Carrera con otra escritura: nos quedamos con la fila que ganó.
    return result.duplicate ? ((await read(key)) ?? doc) : doc;
  }

  return {
    basePlan,
    clock,

    /** Configuración del seguimiento (interruptores por día). */
    async followup() {
      const doc = await read(FOLLOWUP_SETTINGS_KEY);
      return normalizeFollowupSettings(doc?.value, basePlan);
    },

    /** Guarda los interruptores (solo los que existen en el plan base). */
    async saveFollowup(raw) {
      const normalized = normalizeFollowupSettings(raw, basePlan);
      await write(FOLLOWUP_SETTINGS_KEY, normalized);
      return normalized;
    },

    /**
     * Plan de seguimiento EFECTIVO: el plan base filtrado por los interruptores.
     * Es lo que el motor de seguimiento usa al crear tareas.
     */
    async followupPlan() {
      const { enabled } = await this.followup();
      return basePlan.filter((entry) => enabled[entry.key] !== false).map((entry) => ({ ...entry }));
    },

    /** Ajustes completos para el panel, sin datos internos. */
    async snapshot() {
      return { followup: await this.followup(), plan: basePlan.map((entry) => ({ ...entry })) };
    },

    read,
    write,
  };
}
