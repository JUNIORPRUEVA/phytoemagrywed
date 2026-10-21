/**
 * CENTRO DE OPERACIONES — CATÁLOGO DE HERRAMIENTAS DE AGENTE (Etapa D).
 *
 * QUÉ ES
 * La ÚNICA lista de cosas que un agente puede pedirle al sistema. Cada entrada
 * declara su efecto, el permiso que exige, si necesita aprobación humana y si
 * está activa. Si una herramienta no está aquí, no existe.
 *
 * TRES NIVELES DE EFECTO
 *   - `read`  : solo lee (proyección saneada).
 *   - `write` : deja rastro en el ticket (mensaje, acuse, plazo, escalado…).
 *   - `high_impact`: NO se ejecuta sin aprobación humana explícita.
 *
 * DOS PERMISOS DISTINTOS
 *   - `permission`        → lo que necesita EL AGENTE (solo `read`/`write`).
 *   - `approverPermission` → lo que necesita LA PERSONA que aprueba y ejecuta
 *                            una herramienta `high_impact`. El agente nunca
 *                            tiene ese permiso: cerrar un ticket no es suyo.
 *
 * Las herramientas `desactivadas` no se pueden asignar a ningún agente: el
 * registro las rechaza con `tool_disabled`. Las `prohibidas` están escritas a
 * propósito para dejar constancia de que NO son una capacidad del sistema
 * (consultas crudas, comandos, WhatsApp externo).
 *
 * Este archivo no ejecuta nada: solo describe y valida.
 */

/** Permisos que un agente puede tener. Lista cerrada (ver contrato §4). */
export const AGENT_PERMISSIONS = Object.freeze([
  'tickets.read',
  'tickets.read_all',
  'tickets.reply',
  'tickets.ack',
  'tickets.update',
  'orders.read',
]);

/**
 * Catálogo. `schema` valida los argumentos (tipos y obligatorios) ANTES de
 * tocar nada; `enabled: false` significa «registrada pero no asignable».
 */
export const OPS_TOOLS = Object.freeze({
  'ticket.get_context': {
    effect: 'read',
    permission: 'tickets.read',
    enabled: true,
    description: 'Contexto del ticket y de su entidad vinculada (sin datos personales de más)',
    schema: { ticketId: { type: 'string', required: true } },
  },
  'order.get_status': {
    effect: 'read',
    permission: 'orders.read',
    enabled: true,
    description: 'Estado operativo del pedido vinculado (sin importes ni datos del cliente)',
    schema: { orderId: { type: 'string', required: true } },
  },
  'ticket.post_message': {
    effect: 'write',
    permission: 'tickets.reply',
    enabled: true,
    description: 'Escribe un mensaje interno en el hilo',
    schema: {
      body: { type: 'string', required: true, max: 4000 },
      clientKey: { type: 'string', required: false, max: 140 },
    },
  },
  'ticket.request_ack': {
    effect: 'write',
    permission: 'tickets.reply',
    enabled: true,
    description: 'Pide a una persona que acuse recibo de la tarea',
    schema: { note: { type: 'string', required: false, max: 400 } },
  },
  'ticket.set_follow_up': {
    effect: 'write',
    permission: 'tickets.update',
    enabled: true,
    description: 'Programa un seguimiento (reanuda el trabajo en esa hora)',
    schema: { at: { type: 'string', required: true }, note: { type: 'string', required: false, max: 300 } },
  },
  'ticket.escalate': {
    effect: 'write',
    permission: 'tickets.reply',
    enabled: true,
    description: 'Escala el ticket a una persona con el motivo',
    schema: { reason: { type: 'string', required: true, max: 400 } },
  },
  'ticket.complete_work': {
    effect: 'write',
    permission: 'tickets.update',
    enabled: true,
    description: 'Da por terminado el TRABAJO (no cierra el ticket)',
    schema: { note: { type: 'string', required: false, max: 400 } },
  },
  /*
   * CERRAR EL TICKET ES UNA DECISIÓN CON CONSECUENCIAS: exige aprobación.
   * Es la herramienta con la que se demuestra el circuito humano en el bucle.
   */
  'ticket.close': {
    effect: 'high_impact',
    permission: null,
    approverPermission: 'tickets.close',
    enabled: true,
    requiresApproval: true,
    description: 'Cierra el ticket (resuelto) con un motivo',
    schema: { resolution: { type: 'string', required: true, max: 600 } },
  },

  /* ------- registradas y DESACTIVADAS: no se pueden asignar todavía ------- */
  'order.change_total': {
    effect: 'high_impact',
    permission: null,
    approverPermission: 'orders.update_operational',
    enabled: false,
    requiresApproval: true,
    description: 'Cambiar importes de un pedido (financiero)',
    schema: { orderId: { type: 'string', required: true }, total: { type: 'number', required: true } },
  },
  'order.cancel': {
    effect: 'high_impact',
    permission: null,
    approverPermission: 'orders.update_operational',
    enabled: false,
    requiresApproval: true,
    description: 'Cancelar un pedido',
    schema: { orderId: { type: 'string', required: true }, reason: { type: 'string', required: true } },
  },
  'order.refund': {
    effect: 'high_impact',
    permission: null,
    approverPermission: 'orders.update_operational',
    enabled: false,
    requiresApproval: true,
    description: 'Devolver dinero',
    schema: { orderId: { type: 'string', required: true }, amount: { type: 'number', required: true } },
  },
  'customer.update_sensitive': {
    effect: 'high_impact',
    permission: null,
    approverPermission: 'clients.update',
    enabled: false,
    requiresApproval: true,
    description: 'Cambiar datos sensibles del cliente',
    schema: { customerId: { type: 'string', required: true }, field: { type: 'string', required: true } },
  },

  /* ------- prohibidas: no son una capacidad del sistema ------- */
  'db.query_raw': {
    effect: 'forbidden',
    permission: null,
    enabled: false,
    description: 'Consulta libre a la base de datos (NO EXISTE)',
    schema: {},
  },
  'server.exec': {
    effect: 'forbidden',
    permission: null,
    enabled: false,
    description: 'Ejecutar comandos en el servidor (NO EXISTE)',
    schema: {},
  },
  'whatsapp.send_external': {
    effect: 'forbidden',
    permission: null,
    enabled: false,
    description: 'Enviar WhatsApp a un cliente (NO EXISTE)',
    schema: {},
  },
});

/** ¿Existe la herramienta y está activa? */
export function toolOf(name) {
  return OPS_TOOLS[String(name ?? '')] ?? null;
}

/** Valida argumentos contra el esquema. Devuelve `{ok, args}` o `{ok:false,error}`. */
export function validateArgs(toolName, rawArgs = {}) {
  const tool = toolOf(toolName);
  if (!tool) return { ok: false, error: 'unknown_tool' };
  if (tool.effect === 'forbidden') return { ok: false, error: 'tool_forbidden' };
  const source = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  const out = {};
  for (const [key, rule] of Object.entries(tool.schema)) {
    const value = source[key];
    if (value === undefined || value === null || value === '') {
      if (rule.required) return { ok: false, error: `missing_arg:${key}` };
      continue;
    }
    if (rule.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) return { ok: false, error: `invalid_arg:${key}` };
      out[key] = number;
      continue;
    }
    const text = String(value);
    if (rule.max && text.length > rule.max) return { ok: false, error: `arg_too_long:${key}` };
    out[key] = text;
  }
  /* Argumentos desconocidos se descartan: nunca viajan a la ejecución. */
  return { ok: true, args: out };
}

/** Herramientas que un agente PUEDE recibir (activas y no prohibidas). */
export function assignableTools() {
  return Object.entries(OPS_TOOLS)
    .filter(([, tool]) => tool.enabled && tool.effect !== 'forbidden')
    .map(([name]) => name);
}

/** Catálogo público (sin ejecutar nada), para la pantalla de administración. */
export function toolCatalog() {
  return Object.entries(OPS_TOOLS).map(([name, tool]) => ({
    name,
    effect: tool.effect,
    permission: tool.permission,
    approverPermission: tool.approverPermission ?? null,
    enabled: Boolean(tool.enabled),
    requiresApproval: Boolean(tool.requiresApproval),
    description: tool.description,
  }));
}
