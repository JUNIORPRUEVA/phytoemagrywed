/**
 * COLA DE MENSAJES PROGRAMADOS + SCHEDULER (fase S5).
 *
 * DOS COSAS DISTINTAS, A PROPÓSITO
 *   - SEGUIMIENTO   = recordatorio/TAREA para el vendedor. No envía nada.
 *   - MENSAJE PROGRAMADO = un mensaje concreto que el sistema INTENTARÁ enviar a
 *     una fecha y hora. Es esta cola.
 *
 * POR QUÉ UNA COLA PERSISTENTE Y NO `setTimeout`
 *   Un `setTimeout` vive en la memoria del proceso: un reinicio, un redespliegue o
 *   una caída se lo llevan por delante y el mensaje nunca sale (o sale dos veces si
 *   se reintenta a mano). Aquí el trabajo vive en la base de datos y el scheduler lo
 *   CONSULTA. La idempotencia es doble:
 *     1. `idempotency_key` ÚNICA en la colección → no puede existir dos veces el
 *        mismo mensaje programado.
 *     2. Reclamo por transición de estado (`SCHEDULED` → `PROCESSING` con token):
 *        un reinicio a mitad de envío no reenvía lo ya reclamado; y una fila que se
 *        quedó «Processing» por una caída vuelve a la cola tras un tiempo de gracia.
 *
 * REGLA QUE NO SE ROMPE
 *   Si al llegar la hora el mensaje YA NO puede enviarse legalmente (ventana de 24 h
 *   cerrada, opt-out, plantilla sin aprobar), NO SE FUERZA: queda `BLOCKED` y se crea
 *   una alerta para que una persona decida. Programar no es un permiso para saltarse
 *   las reglas de WhatsApp.
 */

import { randomBytes } from 'node:crypto';

/** Estados de un mensaje programado. */
export const SCHEDULED_STATUSES = Object.freeze([
  'SCHEDULED',
  'PROCESSING',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'CANCELLED',
  'BLOCKED',
]);

/** Estados finales: no se vuelve a tocar el trabajo. */
export const FINAL_SCHEDULED_STATUSES = Object.freeze(['SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED', 'BLOCKED']);

/** Motivos por los que un mensaje queda BLOQUEADO (se muestran al operador). */
export const BLOCK_REASONS = Object.freeze({
  OUTSIDE_WINDOW: 'Fuera de la ventana de 24 h: WhatsApp solo permite plantilla aprobada.',
  DO_NOT_CONTACT: 'El cliente pidió no recibir mensajes.',
  TEMPLATE_NOT_APPROVED: 'La plantilla no está aprobada en Meta.',
  WHATSAPP_NOT_CONFIGURED: 'WhatsApp no está configurado en el servidor.',
  UNKNOWN_TEMPLATE: 'La plantilla ya no existe.',
  CUSTOMER_MISSING: 'El cliente del mensaje ya no existe.',
  CONVERSATION_MISMATCH: 'La conversación guardada no es de este cliente: no se envía.',
});

/** Milisegundos que una fila puede estar «Processing» antes de considerarla huérfana. */
export const DEFAULT_STALE_MS = 5 * 60 * 1000;

function newId() {
  return `sch_${randomBytes(8).toString('hex')}`;
}

function short(value, max = 200) {
  if (value === null || value === undefined) return null;
  const clean = String(value).replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

function long(value, max = 1200) {
  if (value === null || value === undefined) return null;
  const clean = String(value).replace(/\r\n/g, '\n').trim();
  return clean ? clean.slice(0, max) : null;
}

/** Fecha/hora ISO válida o null. */
function isoDate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Componentes EXACTOS de la plantilla (los parámetros que se enviarán).
 *
 * Se guardan tal cual se aprobaron al programar y se sanean una sola vez: al
 * llegar la hora NO se reconstruye nada, se manda esto. Es lo que garantiza que
 * el cliente reciba el mismo texto que el agente revisó.
 */
function componentsOf(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row) => row && typeof row === 'object' && typeof row.type === 'string')
    .slice(0, 5)
    .map((row) => ({
      ...row,
      parameters: Array.isArray(row.parameters)
        ? row.parameters
            .filter((parameter) => parameter && typeof parameter === 'object')
            .slice(0, 20)
            .map((parameter) => ({ type: String(parameter.type ?? 'text'), text: String(parameter.text ?? '') }))
        : [],
    }));
}

/**
 * @param {object} deps
 * @param {any} deps.db                 colecciones
 * @param {any} deps.customers          servicio de clientes (conversación, reglas)
 * @param {any} deps.whatsapp           cliente de WhatsApp (sendText / sendTemplate)
 * @param {any} [deps.followups]        para crear la alerta cuando algo se bloquea
 * @param {any} [deps.audit]            traza comercial
 * @param {(name: string) => Promise<{ok: boolean, reason?: string, template?: any}>} [deps.resolveTemplate]
 * @param {() => Date} [deps.clock]
 * @param {(message: string) => void} [deps.log]
 * @param {number} [deps.staleMs]
 */
export function createScheduler(deps) {
  const db = deps.db;
  const customers = deps.customers;
  const whatsapp = deps.whatsapp;
  const followups = deps.followups;
  const audit = deps.audit;
  const resolveTemplate = deps.resolveTemplate ?? (async () => ({ ok: false, reason: 'unknown_template' }));
  const clock = deps.clock ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const staleMs = Number(deps.staleMs ?? DEFAULT_STALE_MS);

  /** Marca una fila como bloqueada y crea la alerta para el operador (una sola vez). */
  async function block(doc, reason, extra = {}) {
    const now = clock().toISOString();
    const updated = await db.update('scheduled_messages', doc.id, {
      status: 'BLOCKED',
      blocked_reason: reason,
      blocked_message: BLOCK_REASONS[reason] ?? reason,
      processed_at: now,
      ...extra,
    });
    if (followups?.createManual && doc.customer_id) {
      // La alerta es una TAREA: "este mensaje no salió, míralo tú".
      await followups.createManual({
        customerId: doc.customer_id,
        conversationId: doc.conversation_id ?? null,
        type: 'alert',
        reason: `Mensaje programado bloqueado: ${BLOCK_REASONS[reason] ?? reason}`,
        scheduledAt: now.slice(0, 10),
        idempotencyKey: `alert:${doc.id}`,
      });
    }
    await audit?.record({
      entity: 'message',
      entityId: doc.id,
      action: 'message.blocked',
      summary: `Mensaje programado bloqueado (${reason})`,
      data: { reason, customer_id: doc.customer_id ?? null },
      idempotencyKey: `message.blocked:${doc.id}`,
    });
    log(`[crm] mensaje programado ${doc.id} BLOQUEADO: ${reason}`);
    return updated;
  }

  return {
    statuses: SCHEDULED_STATUSES,
    staleMs,

    /**
     * Programa un mensaje. IDEMPOTENTE por `idempotencyKey`: reintentar la misma
     * programación devuelve la que ya existe, no crea otra.
     *
     * @param {{ customerId: string, conversationId?: string|null, orderId?: string|null,
     *           scheduledAt: string, type?: 'text'|'template', text?: string|null,
     *           template?: string|null, createdBy?: string|null, idempotencyKey?: string|null,
     *           templateComponents?: any[]|null, templateBody?: string|null,
     *           templateLanguage?: string|null, timeZone?: string|null }} input
     */
    async schedule(input) {
      const customerId = short(input.customerId, 80);
      if (!customerId) return { ok: false, error: 'customer_required' };
      const type = input.type === 'template' ? 'template' : 'text';
      const text = long(input.text);
      const template = short(input.template, 60);
      if (type === 'text' && !text) return { ok: false, error: 'text_required' };
      if (type === 'template' && !template) return { ok: false, error: 'template_required' };
      const scheduledAt = isoDate(input.scheduledAt);
      if (!scheduledAt) return { ok: false, error: 'invalid_date' };

      const id = newId();
      const doc = {
        id,
        customer_id: customerId,
        conversation_id: short(input.conversationId, 80),
        order_id: short(input.orderId, 80),
        type,
        text: type === 'text' ? text : null,
        template: type === 'template' ? template : null,
        /*
         * CONTENIDO CONGELADO de la plantilla. Se guarda lo que el agente aprobó
         * al programar: el idioma, los parámetros y el texto final. Al llegar la
         * hora se manda ESTO, sin volver a calcularlo (si la compra cambió entre
         * medias, el mensaje programado no cambia solo).
         */
        template_language: type === 'template' ? (short(input.templateLanguage, 10) ?? 'es') : null,
        template_components: type === 'template' ? componentsOf(input.templateComponents) : [],
        template_body: type === 'template' ? long(input.templateBody, 1024) : null,
        /* La zona horaria con la que se eligió la hora (para poder auditarla). */
        time_zone: short(input.timeZone, 60),
        scheduled_at: scheduledAt,
        status: 'SCHEDULED',
        attempts: 0,
        claimed_token: null,
        processing_at: null,
        processed_at: null,
        sent_at: null,
        wa_message_id: null,
        message_id: null,
        blocked_reason: null,
        blocked_message: null,
        error_code: null,
        error_message: null,
        created_by: short(input.createdBy, 60) ?? 'panel',
        scheduled_by_user_id: short(input.scheduledByUserId, 80),
        scheduled_by_display_name_snapshot: short(input.createdBy, 120),
        created_at: clock().toISOString(),
        idempotency_key: short(input.idempotencyKey, 120) ?? `sm:${id}`,
      };
      const result = await db.insert('scheduled_messages', doc);
      if (result.duplicate) {
        const existing = await db.findBy('scheduled_messages', 'idempotency_key', doc.idempotency_key);
        return { ok: true, duplicate: true, message: existing ?? doc };
      }
      await audit?.record({
        entity: 'message',
        entityId: doc.id,
        action: 'message.scheduled',
        summary: `Mensaje ${type === 'template' ? `(plantilla ${template})` : ''} programado`,
        data: { customer_id: customerId, scheduled_at: scheduledAt, order_id: doc.order_id },
        idempotencyKey: `message.scheduled:${doc.id}`,
      });
      return { ok: true, duplicate: false, message: doc };
    },

    /** Cancela un mensaje que todavía no ha salido. */
    async cancel(id, patch = {}) {
      const current = await db.get('scheduled_messages', id);
      if (!current) return null;
      if (current.status !== 'SCHEDULED') return current;
      const updated = await db.update('scheduled_messages', id, {
        status: 'CANCELLED',
        processed_at: clock().toISOString(),
        blocked_reason: null,
        error_message: short(patch.reason, 200),
      });
      await audit?.record({
        entity: 'message',
        entityId: id,
        action: 'message.cancelled',
        summary: 'Mensaje programado cancelado',
        idempotencyKey: `message.cancelled:${id}`,
      });
      return updated;
    },

    /** Reprograma: nueva fecha/hora (solo si aún no ha salido). */
    async reschedule(id, scheduledAt) {
      const current = await db.get('scheduled_messages', id);
      if (!current) return null;
      if (FINAL_SCHEDULED_STATUSES.includes(current.status) && current.status !== 'BLOCKED') return current;
      const next = isoDate(scheduledAt);
      if (!next) return null;
      return db.update('scheduled_messages', id, {
        status: 'SCHEDULED',
        scheduled_at: next,
        blocked_reason: null,
        blocked_message: null,
        error_code: null,
        error_message: null,
        processed_at: null,
        claimed_token: null,
      });
    },

    /** Los mensajes de un cliente (para su ficha 360). */
    async listForCustomer(customerId) {
      const rows = await db.list('scheduled_messages', { by: 'scheduled_at', order: 'asc' });
      return rows.filter((row) => row.customer_id === customerId);
    },

    /** Los que vienen (para el panel). */
    async list(options = {}) {
      const rows = await db.list('scheduled_messages', { by: 'scheduled_at', order: 'asc', limit: 1000 });
      const filtered = options.status ? rows.filter((row) => row.status === options.status) : rows;
      return options.limit ? filtered.slice(0, options.limit) : filtered;
    },

    /** Números para HOY: pendientes, bloqueados y fallidos. */
    async summary() {
      const rows = await this.list();
      const now = clock().getTime();
      const problems = rows
        .filter((row) => row.status === 'BLOCKED' || row.status === 'FAILED')
        .slice(0, 10)
        .map((row) => ({
          id: row.id,
          customer_id: row.customer_id,
          conversation_id: row.conversation_id,
          type: row.type,
          text: row.text,
          template: row.template,
          scheduled_at: row.scheduled_at,
          status: row.status,
          blocked_reason: row.blocked_reason,
          blocked_message: row.blocked_message,
          error_code: row.error_code,
          error_message: row.error_message,
        }));
      return {
        scheduled: rows.filter((row) => row.status === 'SCHEDULED').length,
        due: rows.filter((row) => row.status === 'SCHEDULED' && Date.parse(row.scheduled_at) <= now).length,
        blocked: rows.filter((row) => row.status === 'BLOCKED').length,
        failed: rows.filter((row) => row.status === 'FAILED').length,
        sent: rows.filter((row) => ['SENT', 'DELIVERED', 'READ'].includes(row.status)).length,
        cancelled: rows.filter((row) => row.status === 'CANCELLED').length,
        problems,
        upcoming: rows
          .filter((row) => row.status === 'SCHEDULED' && Date.parse(row.scheduled_at) > now)
          .slice(0, 10),
      };
    },

    /**
     * Recupera las filas «Processing» huérfanas (el proceso murió a mitad de envío).
     * Vuelven a la cola; como mucho se reintentan `maxAttempts` veces.
     */
    async recoverStale(maxAttempts = 3) {
      const rows = await db.list('scheduled_messages', { limit: 2000 });
      const now = clock().getTime();
      let recovered = 0;
      for (const row of rows) {
        if (row.status !== 'PROCESSING') continue;
        const started = Date.parse(row.processing_at ?? row.created_at);
        if (Number.isFinite(started) && now - started < staleMs) continue;
        if (Number(row.attempts) >= maxAttempts) {
          await db.update('scheduled_messages', row.id, {
            status: 'FAILED',
            error_message: 'Se agotaron los intentos tras una interrupción.',
            processed_at: clock().toISOString(),
          });
          continue;
        }
        await db.update('scheduled_messages', row.id, { status: 'SCHEDULED', claimed_token: null, processing_at: null });
        recovered += 1;
      }
      return recovered;
    },

    /**
     * Procesa un trabajo concreto. Exportado para poder probarlo sin arrancar el
     * temporizador (los tests no esperan relojes).
     * @param {any} doc
     */
    async process(doc) {
      const current = await db.get('scheduled_messages', doc.id);
      if (!current || current.status !== 'SCHEDULED') return current;
      // Reclamo: si otra ejecución ya lo cogió, esta no hace nada.
      const token = randomBytes(8).toString('hex');
      const claimed = await db.update('scheduled_messages', doc.id, {
        status: 'PROCESSING',
        claimed_token: token,
        processing_at: clock().toISOString(),
        attempts: Number(current.attempts ?? 0) + 1,
      });
      if (claimed?.claimed_token !== token) return claimed;

      const customer = await customers.get(current.customer_id);
      if (!customer) return block(claimed, 'CUSTOMER_MISSING');
      if (customer.do_not_contact || customer.whatsapp_opt_out_at) return block(claimed, 'DO_NOT_CONTACT');
      if (!whatsapp?.enabled) return block(claimed, 'WHATSAPP_NOT_CONFIGURED');

      const conversation = current.conversation_id
        ? await db.get('conversations', current.conversation_id)
        : await customers.conversationFor(customer.id, { create: false });
      /*
       * REVALIDACIÓN DEL DESTINATARIO, justo antes de enviar: la conversación
       * guardada tiene que ser de ESTE cliente. Si no lo es, no sale nada.
       */
      if (current.conversation_id && conversation && conversation.customer_id !== customer.id) {
        return block(claimed, 'CONVERSATION_MISMATCH');
      }

      /** @type {any} */
      let template = null;
      if (current.type === 'template') {
        const check = await resolveTemplate(current.template);
        if (!check?.ok) return block(claimed, check?.reason === 'unknown_template' ? 'UNKNOWN_TEMPLATE' : 'TEMPLATE_NOT_APPROVED');
        template = check.template;
      } else if (!customers.canSendFreeText(conversation)) {
        // La ventana se comprueba EN EL MOMENTO del envío, no al programar.
        return block(claimed, 'OUTSIDE_WINDOW');
      }

      const sendResult = template
        ? await whatsapp.sendTemplate(customer.phone_e164, {
            name: template.name,
            language: current.template_language ?? template.language ?? 'es',
            // LOS PARÁMETROS CONGELADOS: los mismos que el agente aprobó, tal cual.
            components: Array.isArray(current.template_components) ? current.template_components : [],
          })
        : await whatsapp.sendText(customer.phone_e164, current.text);

      const now = clock().toISOString();
      if (!sendResult?.ok) {
        const recorded = await customers.recordOutbound({
          customer,
          conversation,
          body: template ? current.template_body ?? null : current.text,
          template: template?.name ?? null,
          status: 'failed',
          error: sendResult?.error ?? { message: sendResult?.reason ?? 'error' },
          idempotencyKey: current.idempotency_key,
          sentBy: 'system',
          sentByDisplayName: 'Sistema',
          actorType: 'SYSTEM',
        });
        const failed = await db.update('scheduled_messages', doc.id, {
          status: 'FAILED',
          processed_at: now,
          // El código de error de Meta es un número: se guarda tal cual.
          error_code: sendResult?.error?.code ?? null,
          error_message: short(sendResult?.error?.message ?? 'Error de envío', 200),
          message_id: recorded?.message?.id ?? null,
        });
        await audit?.record({
          entity: 'message',
          entityId: doc.id,
          action: 'message.failed',
          summary: `Mensaje programado falló: ${sendResult?.error?.message ?? 'error'}`,
          idempotencyKey: `message.failed:${doc.id}`,
        });
        return failed;
      }

      const recorded = await customers.recordOutbound({
        customer,
        conversation,
        body: template ? current.template_body ?? null : current.text,
        template: template?.name ?? null,
        waMessageId: sendResult.messageId ?? null,
        status: 'sent',
        idempotencyKey: current.idempotency_key,
        meta: { phoneNumberId: whatsapp.phoneNumberId },
        sentBy: 'system',
        sentByDisplayName: 'Sistema',
        actorType: 'SYSTEM',
      });
      const sent = await db.update('scheduled_messages', doc.id, {
        status: 'SENT',
        sent_at: now,
        processed_at: now,
        wa_message_id: sendResult.messageId ?? null,
        message_id: recorded?.message?.id ?? null,
      });
      await audit?.record({
        entity: 'message',
        entityId: doc.id,
        action: 'message.sent',
        summary: 'Mensaje programado enviado',
        data: { template: template?.name ?? null },
        idempotencyKey: `message.sent:${doc.id}`,
      });
      log(`[crm] mensaje programado ${doc.id} enviado a ${customer.id}`);
      return sent;
    },

    /** Una pasada: recupera huérfanos y procesa lo que ya toca. */
    async tick() {
      const recovered = await this.recoverStale();
      const now = clock().getTime();
      const rows = await this.list({ status: 'SCHEDULED' });
      const due = rows.filter((row) => Date.parse(row.scheduled_at) <= now);
      let sent = 0;
      for (const row of due) {
        const result = await this.process(row);
        if (result?.status === 'SENT') sent += 1;
      }
      return { recovered, due: due.length, sent };
    },

    /**
     * Arranca el bucle. Devuelve una función para detenerlo. Sin `intervalMs` no
     * se arranca nada (los tests llaman a `tick()` a mano).
     */
    start(options = {}) {
      const intervalMs = Number(options.intervalMs ?? deps.intervalMs ?? 0);
      if (!intervalMs || intervalMs < 1000) return () => {};
      const run = () => {
        this.tick().catch((error) => log(`[crm] scheduler: ${error?.message ?? error}`));
      };
      run();
      const timer = setInterval(run, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      return () => clearInterval(timer);
    },
  };
}
