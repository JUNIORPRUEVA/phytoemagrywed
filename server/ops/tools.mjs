/**
 * CENTRO IA — REGISTRO COMPARTIDO DE HERRAMIENTAS DE AGENTE.
 *
 * QUÉ ES
 * La ÚNICA lista de cosas que un agente puede pedirle al sistema. Todos los
 * agentes DESCUBREN las mismas herramientas (el catálogo es público para el
 * equipo), pero **ver una herramienta no es poder ejecutarla**: cada agente
 * tiene su propia lista blanca (`ops_agents.tools`) y el motor vuelve a
 * comprobarla en cada invocación. Cada entrada declara, además, su alcance, su
 * riesgo, su plazo, si es idempotente y qué deja en la traza. Si una
 * herramienta no está aquí, no existe.
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
  /*
   * AGENTE DE SEGUIMIENTO (Centro IA).
   * `*.propose` es la capacidad de PREPARAR una acción; ejecutarla exige el
   * permiso real de LA PERSONA que aprueba (`followups.create|update|delete`).
   * Un agente nunca recibe esos permisos de escritura.
   */
  'followups.read',
  'followups.propose',
  'messages.read',
  'messages.propose',
]);

/** Clasificaciones admitidas (listas cerradas: el catálogo no inventa valores). */
export const TOOL_EFFECTS = Object.freeze(['read', 'write', 'high_impact', 'forbidden']);
export const TOOL_RISKS = Object.freeze(['low', 'medium', 'high']);
export const TOOL_SCOPES = Object.freeze(['ticket', 'order', 'agent', 'followup', 'message']);

/** Plazo global del motor: ninguna herramienta puede declarar más que esto. */
export const MAX_TOOL_TIMEOUT_MS = 20_000;

/**
 * Catálogo. `schema` valida los argumentos (tipos y obligatorios) ANTES de
 * tocar nada; `enabled: false` significa «registrada pero no asignable».
 */
export const OPS_TOOLS = Object.freeze({
  'ticket.get_context': {
    effect: 'read',
    scope: 'ticket',
    risk: 'low',
    permission: 'tickets.read',
    enabled: true,
    description: 'Contexto del ticket y de su entidad vinculada (sin datos personales de más)',
    schema: { ticketId: { type: 'string', required: true } },
    inputs: { ticketId: 'Identificador del ticket' },
    outputs: { ticket: 'Ticket saneado', participants: 'Participantes', recentMessages: 'Últimos mensajes' },
    timeoutMs: 8000,
    idempotent: true,
    audit: 'call',
    requiresApproval: false,
  },
  'order.get_status': {
    effect: 'read',
    scope: 'order',
    risk: 'low',
    permission: 'orders.read',
    enabled: true,
    description: 'Estado operativo del pedido vinculado (sin importes ni datos del cliente)',
    schema: { orderId: { type: 'string', required: true } },
    inputs: { orderId: 'Identificador del pedido' },
    outputs: { status: 'Estado del pedido', deliveryStatus: 'Estado de la entrega' },
    timeoutMs: 8000,
    idempotent: true,
    audit: 'call',
    requiresApproval: false,
  },
  'ticket.post_message': {
    effect: 'write',
    scope: 'ticket',
    risk: 'low',
    permission: 'tickets.reply',
    enabled: true,
    description: 'Escribe un mensaje interno en el hilo',
    schema: {
      body: { type: 'string', required: true, max: 4000 },
      clientKey: { type: 'string', required: false, max: 140 },
    },
    inputs: { body: 'Texto del mensaje interno', clientKey: 'Clave de idempotencia del mensaje' },
    outputs: { message: 'Mensaje creado', duplicate: 'true si ya existía' },
    timeoutMs: 10000,
    idempotent: true,
    audit: 'action',
    requiresApproval: false,
  },
  'ticket.request_ack': {
    effect: 'write',
    scope: 'ticket',
    risk: 'low',
    permission: 'tickets.reply',
    enabled: true,
    description: 'Pide a una persona que acuse recibo de la tarea',
    schema: { note: { type: 'string', required: false, max: 400 } },
    inputs: { note: 'Frase con la que se pide el acuse' },
    outputs: { message: 'Mensaje creado' },
    timeoutMs: 10000,
    idempotent: true,
    audit: 'action',
    requiresApproval: false,
  },
  'ticket.set_follow_up': {
    effect: 'write',
    scope: 'ticket',
    risk: 'low',
    permission: 'tickets.update',
    enabled: true,
    description: 'Programa un seguimiento (reanuda el trabajo en esa hora)',
    schema: { at: { type: 'string', required: true }, note: { type: 'string', required: false, max: 300 } },
    inputs: { at: 'Fecha y hora ISO del seguimiento', note: 'Motivo del seguimiento' },
    outputs: { nextRunAt: 'Siguiente vuelta programada' },
    timeoutMs: 8000,
    idempotent: true,
    audit: 'action',
    requiresApproval: false,
  },
  'ticket.escalate': {
    effect: 'write',
    scope: 'ticket',
    risk: 'medium',
    permission: 'tickets.reply',
    enabled: true,
    description: 'Escala el ticket a una persona con el motivo',
    schema: { reason: { type: 'string', required: true, max: 400 } },
    inputs: { reason: 'Motivo de la escalada' },
    outputs: { ticket: 'Ticket escalado' },
    timeoutMs: 10000,
    idempotent: true,
    audit: 'action',
    requiresApproval: false,
  },
  'ticket.complete_work': {
    effect: 'write',
    scope: 'ticket',
    risk: 'low',
    permission: 'tickets.update',
    enabled: true,
    description: 'Da por terminado el TRABAJO (no cierra el ticket)',
    schema: { note: { type: 'string', required: false, max: 400 } },
    inputs: { note: 'Resumen del trabajo hecho' },
    outputs: { ticket: 'Ticket con la tarea terminada' },
    timeoutMs: 10000,
    idempotent: true,
    audit: 'action',
    requiresApproval: false,
  },
  /*
   * COLABORACIÓN ENTRE AGENTES (Fase 6).
   *
   * No crea otro ticket ni mueve permisos: pide a OTRO agente autorizado que
   * mire ESTE mismo ticket y deje su respuesta en el hilo compartido. El
   * receptor trabaja con SUS herramientas y SUS permisos.
   */
  'agent.request_help': {
    effect: 'write',
    scope: 'agent',
    risk: 'medium',
    permission: 'tickets.update',
    enabled: true,
    description: 'Pide ayuda a otro agente autorizado sobre ESTE ticket (queda registrado)',
    schema: {
      agentKey: { type: 'string', required: true, max: 80 },
      question: { type: 'string', required: true, max: 300 },
    },
    inputs: { agentKey: 'Clave del agente al que se le pide ayuda', question: 'Qué se necesita aclarar' },
    outputs: { delegationId: 'Identificador de la delegación', to: 'Agente destinatario', status: 'pending' },
    timeoutMs: 10000,
    idempotent: true,
    audit: 'action',
    requiresApproval: false,
  },

  /*
   * AGENTE DE SEGUIMIENTO (Centro IA).
   *
   * Consulta libre; ESCRITURA SOLO POR APROBACIÓN. Estas cinco de escritura llevan
   * `approvalOnly: true`: el motor de tickets se niega a ejecutarlas sin una
   * aprobación humana, aunque un plan futuro las pidiera. Se ejecutan al aprobar
   * la propuesta, con los permisos de la persona (`followups.*`).
   */
  'followup.list': {
    effect: 'read',
    scope: 'followup',
    risk: 'low',
    permission: 'followups.read',
    enabled: true,
    description: 'Lista los seguimientos pendientes, vencidos y próximos (solo clientes autorizados)',
    schema: { filter: { type: 'string', required: false, max: 20 } },
    inputs: { filter: 'hoy | vencidos | proximos | todos' },
    outputs: { today: 'Seguimientos de hoy', overdue: 'Vencidos', upcoming: 'Próximos' },
    timeoutMs: 8000,
    idempotent: true,
    audit: 'call',
    requiresApproval: false,
  },
  'schedule.list': {
    effect: 'read',
    scope: 'message',
    risk: 'low',
    permission: 'messages.read',
    enabled: true,
    description: 'Lista los mensajes programados con su estado de envío',
    schema: { status: { type: 'string', required: false, max: 20 } },
    inputs: { status: 'Filtro opcional por estado' },
    outputs: { rows: 'Programaciones', counts: 'Totales por estado' },
    timeoutMs: 8000,
    idempotent: true,
    audit: 'call',
    requiresApproval: false,
  },
  'followup.create': {
    effect: 'write',
    scope: 'followup',
    risk: 'low',
    permission: 'followups.propose',
    approverPermission: 'followups.create',
    enabled: true,
    approvalOnly: true,
    requiresApproval: true,
    description: 'Prepara un seguimiento para un cliente (necesita aprobación)',
    schema: {
      customerId: { type: 'string', required: true, max: 80 },
      reason: { type: 'string', required: true, max: 200 },
      date: { type: 'string', required: false, max: 10 },
    },
    inputs: { customerId: 'Cliente', reason: 'Motivo', date: 'Fecha AAAA-MM-DD' },
    outputs: { followupId: 'Seguimiento creado', scheduledAt: 'Fecha' },
    timeoutMs: 10000,
    idempotent: true,
    audit: 'action',
  },
  'followup.reschedule': {
    effect: 'write',
    scope: 'followup',
    risk: 'low',
    permission: 'followups.propose',
    approverPermission: 'followups.update',
    enabled: true,
    approvalOnly: true,
    requiresApproval: true,
    description: 'Cambia la fecha de un seguimiento pendiente (necesita aprobación)',
    schema: { followupId: { type: 'string', required: true, max: 80 }, date: { type: 'string', required: true, max: 10 } },
    inputs: { followupId: 'Seguimiento', date: 'Fecha nueva' },
    outputs: { followupId: 'Seguimiento', scheduledAt: 'Fecha nueva' },
    timeoutMs: 10000,
    idempotent: true,
    audit: 'action',
  },
  'followup.complete': {
    effect: 'write',
    scope: 'followup',
    risk: 'low',
    permission: 'followups.propose',
    approverPermission: 'followups.update',
    enabled: true,
    approvalOnly: true,
    requiresApproval: true,
    description: 'Da por hecho un seguimiento pendiente (necesita aprobación)',
    schema: { followupId: { type: 'string', required: true, max: 80 } },
    inputs: { followupId: 'Seguimiento' },
    outputs: { followupId: 'Seguimiento completado' },
    timeoutMs: 10000,
    idempotent: true,
    audit: 'action',
  },
  'followup.cancel': {
    effect: 'write',
    scope: 'followup',
    risk: 'medium',
    permission: 'followups.propose',
    approverPermission: 'followups.delete',
    enabled: true,
    approvalOnly: true,
    requiresApproval: true,
    description: 'Cancela un seguimiento pendiente con un motivo (necesita aprobación de administración)',
    schema: { followupId: { type: 'string', required: true, max: 80 }, reason: { type: 'string', required: false, max: 200 } },
    inputs: { followupId: 'Seguimiento', reason: 'Motivo' },
    outputs: { followupId: 'Seguimiento cancelado' },
    timeoutMs: 10000,
    idempotent: true,
    audit: 'action',
  },
  'schedule.create': {
    effect: 'write',
    scope: 'message',
    risk: 'medium',
    permission: 'messages.propose',
    approverPermission: 'followups.create',
    enabled: true,
    approvalOnly: true,
    requiresApproval: true,
    description: 'Prepara un mensaje programado con el texto EXACTO a enviar (necesita aprobación)',
    schema: {
      customerId: { type: 'string', required: true, max: 80 },
      text: { type: 'string', required: true, max: 900 },
      scheduledAt: { type: 'string', required: true, max: 40 },
    },
    inputs: { customerId: 'Cliente', text: 'Texto congelado', scheduledAt: 'Fecha y hora ISO' },
    outputs: { scheduledId: 'Programación creada', scheduledAt: 'Fecha y hora' },
    timeoutMs: 10000,
    idempotent: true,
    audit: 'action',
  },
  'schedule.reschedule': {
    effect: 'write',
    scope: 'message',
    risk: 'medium',
    permission: 'messages.propose',
    approverPermission: 'followups.update',
    enabled: true,
    approvalOnly: true,
    requiresApproval: true,
    description: 'Cambia la hora de un mensaje programado (necesita aprobación)',
    schema: { scheduledId: { type: 'string', required: true, max: 80 }, scheduledAt: { type: 'string', required: true, max: 40 } },
    inputs: { scheduledId: 'Programación', scheduledAt: 'Fecha y hora ISO' },
    outputs: { scheduledId: 'Programación', scheduledAt: 'Fecha y hora' },
    timeoutMs: 10000,
    idempotent: true,
    audit: 'action',
  },
  'schedule.cancel': {
    effect: 'write',
    scope: 'message',
    risk: 'medium',
    permission: 'messages.propose',
    approverPermission: 'followups.delete',
    enabled: true,
    approvalOnly: true,
    requiresApproval: true,
    description: 'Cancela un mensaje programado que todavía no ha salido (necesita aprobación de administración)',
    schema: { scheduledId: { type: 'string', required: true, max: 80 }, reason: { type: 'string', required: false, max: 200 } },
    inputs: { scheduledId: 'Programación', reason: 'Motivo' },
    outputs: { scheduledId: 'Programación', status: 'Estado final' },
    timeoutMs: 10000,
    idempotent: true,
    audit: 'action',
  },
  /*
   * CERRAR EL TICKET ES UNA DECISIÓN CON CONSECUENCIAS: exige aprobación.
   * Es la herramienta con la que se demuestra el circuito humano en el bucle.
   */
  'ticket.close': {
    effect: 'high_impact',
    scope: 'ticket',
    risk: 'high',
    permission: null,
    approverPermission: 'tickets.close',
    enabled: true,
    requiresApproval: true,
    description: 'Cierra el ticket (resuelto) con un motivo',
    schema: { resolution: { type: 'string', required: true, max: 600 } },
    inputs: { resolution: 'Motivo del cierre' },
    outputs: { ticket: 'Ticket resuelto' },
    timeoutMs: 10000,
    idempotent: true,
    audit: 'action',
  },

  /* ------- registradas y DESACTIVADAS: no se pueden asignar todavía ------- */
  'order.change_total': {
    effect: 'high_impact',
    scope: 'order',
    risk: 'high',
    permission: null,
    approverPermission: 'orders.update_operational',
    enabled: false,
    requiresApproval: true,
    description: 'Cambiar importes de un pedido (financiero)',
    schema: { orderId: { type: 'string', required: true }, total: { type: 'number', required: true } },
    inputs: { orderId: 'Pedido', total: 'Importe nuevo' },
    outputs: { order: 'Pedido actualizado' },
    timeoutMs: 10000,
    idempotent: false,
    audit: 'action',
  },
  'order.cancel': {
    effect: 'high_impact',
    scope: 'order',
    risk: 'high',
    permission: null,
    approverPermission: 'orders.update_operational',
    enabled: false,
    requiresApproval: true,
    description: 'Cancelar un pedido',
    schema: { orderId: { type: 'string', required: true }, reason: { type: 'string', required: true } },
    inputs: { orderId: 'Pedido', reason: 'Motivo' },
    outputs: { order: 'Pedido cancelado' },
    timeoutMs: 10000,
    idempotent: false,
    audit: 'action',
  },
  'order.refund': {
    effect: 'high_impact',
    scope: 'order',
    risk: 'high',
    permission: null,
    approverPermission: 'orders.update_operational',
    enabled: false,
    requiresApproval: true,
    description: 'Devolver dinero',
    schema: { orderId: { type: 'string', required: true }, amount: { type: 'number', required: true } },
    inputs: { orderId: 'Pedido', amount: 'Importe a devolver' },
    outputs: { refund: 'Devolución registrada' },
    timeoutMs: 10000,
    idempotent: false,
    audit: 'action',
  },
  'customer.update_sensitive': {
    effect: 'high_impact',
    scope: 'order',
    risk: 'high',
    permission: null,
    approverPermission: 'clients.update',
    enabled: false,
    requiresApproval: true,
    description: 'Cambiar datos sensibles del cliente',
    schema: { customerId: { type: 'string', required: true }, field: { type: 'string', required: true } },
    inputs: { customerId: 'Cliente', field: 'Campo a cambiar' },
    outputs: { customer: 'Cliente actualizado' },
    timeoutMs: 10000,
    idempotent: false,
    audit: 'action',
  },

  /* ------- prohibidas: no son una capacidad del sistema ------- */
  'db.query_raw': {
    effect: 'forbidden',
    scope: 'order',
    risk: 'high',
    permission: null,
    enabled: false,
    requiresApproval: false,
    description: 'Consulta libre a la base de datos (NO EXISTE)',
    schema: {},
    inputs: {},
    outputs: {},
    timeoutMs: 0,
    idempotent: false,
    audit: 'action',
  },
  'server.exec': {
    effect: 'forbidden',
    scope: 'agent',
    risk: 'high',
    permission: null,
    enabled: false,
    requiresApproval: false,
    description: 'Ejecutar comandos en el servidor (NO EXISTE)',
    schema: {},
    inputs: {},
    outputs: {},
    timeoutMs: 0,
    idempotent: false,
    audit: 'action',
  },
  'whatsapp.send_external': {
    effect: 'forbidden',
    scope: 'ticket',
    risk: 'high',
    permission: null,
    enabled: false,
    requiresApproval: false,
    description: 'Enviar WhatsApp a un cliente (NO EXISTE)',
    schema: {},
    inputs: {},
    outputs: {},
    timeoutMs: 0,
    idempotent: false,
    audit: 'action',
  },
});

/** ¿Existe la herramienta? */
export function toolOf(name) {
  return OPS_TOOLS[String(name ?? '')] ?? null;
}

/** Plazo efectivo de una herramienta (nunca por encima del global). */
export function timeoutOf(name) {
  const ms = Number(toolOf(name)?.timeoutMs ?? 0);
  if (!Number.isFinite(ms) || ms <= 0) return MAX_TOOL_TIMEOUT_MS;
  return Math.min(ms, MAX_TOOL_TIMEOUT_MS);
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
    scope: tool.scope ?? null,
    risk: tool.risk ?? null,
    permission: tool.permission,
    approverPermission: tool.approverPermission ?? null,
    enabled: Boolean(tool.enabled),
    requiresApproval: Boolean(tool.requiresApproval),
    approvalOnly: tool.approvalOnly === true,
    description: tool.description,
    inputs: tool.inputs ?? {},
    outputs: tool.outputs ?? {},
    timeoutMs: timeoutOf(name),
    idempotent: tool.idempotent !== false,
    audit: tool.audit ?? 'call',
  }));
}

/**
 * Ficha de UNA herramienta para la oficina del agente.
 * Devuelve `null` si no existe (nunca inventa una entrada).
 */
export function toolSpec(name) {
  if (!toolOf(name)) return null;
  return toolCatalog().find((entry) => entry.name === name) ?? null;
}
