/**
 * CLIENTES, CONVERSACIONES Y MENSAJES — servicio de dominio del CRM.
 *
 * Idea central: **un cliente es una persona, no un canal**. Da igual si llegó
 * por la landing, por WhatsApp o si la venta se registra a mano: si el teléfono
 * normalizado coincide, es el MISMO cliente. El teléfono en formato E.164 es el
 * identificador fuerte porque este negocio no tiene email ni cuenta de usuario.
 *
 * Este módulo NO decide cuándo se envía un mensaje: registra lo que ocurre y da
 * los datos que el panel necesita para que una persona decida.
 */

import { randomBytes } from 'node:crypto';

import { classifyIntent, detectHealthConcern, detectHumanRequest, detectOptOut, toE164, toWaId } from './whatsapp.mjs';

/** Estados de automatización de una conversación. */
export const AUTOMATION_STATES = Object.freeze(['AUTOMATIC', 'HUMAN_REQUIRED', 'HUMAN_ACTIVE', 'PAUSED', 'CLOSED']);

/** Estados por los que pasa un mensaje saliente. */
export const MESSAGE_STATUSES = Object.freeze(['pending', 'sent', 'delivered', 'read', 'failed']);

/** Canales por los que puede entrar una venta. */
export const SALE_CHANNELS = Object.freeze(['landing', 'whatsapp', 'manual', 'otro']);

function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

/** Texto corto sin saltos de línea. */
function short(value, max = 200) {
  if (value === null || value === undefined) return null;
  const clean = String(value).replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

/**
 * Crea el servicio de clientes/conversaciones/mensajes.
 *
 * @param {object} deps
 * @param {any} deps.db         almacén de colecciones
 * @param {any} [deps.store]    almacén de pedidos (para el historial de compras)
 * @param {any} [deps.followups] motor de seguimiento
 * @param {() => Date} [deps.clock]
 */
export function createCustomerService(deps) {
  const db = deps.db;
  const store = deps.store;
  const followups = deps.followups;
  const clock = deps.clock ?? (() => new Date());

  /** Pedidos de un cliente (filtra en memoria: el CRM maneja cientos, no millones). */
  async function purchasesOf(customerId) {
    if (!store?.listAdmin) return [];
    const rows = await store.listAdmin({ limit: 500 });
    return rows
      .filter((row) => row.customer_id === customerId && row.type === 'order_intent')
      .sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)));
  }

  /** Suma el dinero solo de los pedidos ENTREGADOS (una venta es una venta entregada). */
  function totalsFrom(purchases) {
    const delivered = purchases.filter((row) => row.status === 'entregado');
    return {
      total_purchases: delivered.length,
      total_spent: delivered.reduce((sum, row) => sum + (Number(row.total) || 0), 0),
      last_purchase_at: delivered[0]?.received_at ?? null,
      open_purchases: purchases.filter((row) => row.status !== 'entregado' && row.status !== 'perdido').length,
      last_order_at: purchases[0]?.received_at ?? null,
    };
  }

  /** Busca por teléfono normalizado (el identificador fuerte). */
  async function findByPhone(phone) {
    const e164 = toE164(phone);
    if (!e164) return null;
    return db.findBy('customers', 'phone_e164', e164);
  }

  return {
    /** Teléfono normalizado a E.164 (o null si no identifica a nadie). */
    normalizePhone: toE164,

    /**
     * Encuentra o crea el cliente por teléfono.
     *
     * No duplica: si ya existe, solo completa los datos que falten (nunca pisa lo
     * que escribió una persona). Si dos peticiones llegan a la vez, la clave única
     * `phone_e164` impide el duplicado y se devuelve el que ganó.
     *
     * @param {{ phone: string, name?: string|null, location?: string|null, source?: string|null, optIn?: boolean }} input
     */
    async findOrCreateByPhone(input) {
      const e164 = toE164(input.phone);
      if (!e164) return { ok: false, error: 'invalid_phone' };
      const existing = await db.findBy('customers', 'phone_e164', e164);
      const now = new Date().toISOString();
      if (existing) {
        /** @type {Record<string, any>} */
        const patch = {};
        if (!existing.name && short(input.name, 120)) patch.name = short(input.name, 120);
        if (!existing.location && short(input.location, 120)) patch.location = short(input.location, 120);
        if (input.source && !existing.source) patch.source = short(input.source, 40);
        if (input.optIn === true && existing.whatsapp_opt_in !== true) {
          patch.whatsapp_opt_in = true;
          patch.whatsapp_opt_in_at = now;
        }
        if (Object.keys(patch).length === 0) return { ok: true, customer: existing, created: false };
        const updated = await db.update('customers', existing.id, { ...patch, updated_at: now });
        return { ok: true, customer: updated, created: false };
      }

      const customer = {
        id: newId('cus'),
        name: short(input.name, 120),
        phone: short(input.phone, 40),
        phone_e164: e164,
        email: null,
        location: short(input.location, 120),
        source: short(input.source, 40) ?? 'desconocido',
        created_at: now,
        updated_at: now,
        whatsapp_opt_in: input.optIn === true,
        whatsapp_opt_in_at: input.optIn === true ? now : null,
        whatsapp_opt_out_at: null,
        do_not_contact: false,
        automation_state: 'AUTOMATIC',
        notes: null,
        last_contact_at: null,
        next_followup_at: null,
        last_purchase_at: null,
        total_purchases: 0,
        total_spent: 0,
      };
      const result = await db.insert('customers', customer);
      if (result.duplicate) {
        // Carrera con otra petición: gana la primera fila guardada.
        const winner = await db.findBy('customers', 'phone_e164', e164);
        return { ok: true, customer: winner ?? customer, created: false };
      }
      await db.insert('conversations', {
        id: newId('cnv'),
        customer_id: customer.id,
        channel: 'whatsapp',
        status: 'AUTOMATIC',
        assigned_to: null,
        last_message_at: null,
        last_inbound_at: null,
        unread_count: 0,
        created_at: now,
        updated_at: now,
      });
      return { ok: true, customer, created: true };
    },

    get: (id) => db.get('customers', id),

    /** Busca un cliente por su teléfono (para el webhook). */
    findByPhone,

    /** Lista de clientes con búsqueda por nombre, teléfono o ciudad. */
    async list(options = {}) {
      const rows = await db.list('customers', { limit: 500 });
      const needle = String(options.q ?? '').trim().toLowerCase();
      const filtered = needle
        ? rows.filter((row) =>
            [row.name, row.phone, row.phone_e164, row.location, row.notes]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(needle),
          )
        : rows;
      return options.limit ? filtered.slice(0, options.limit) : filtered;
    },

    update(id, patch) {
      return db.update('customers', id, { ...patch, updated_at: new Date().toISOString() });
    },

    /** Recalcula los totales desde los pedidos (derivado ⇒ no puede desincronizarse). */
    async refreshTotals(customerId) {
      const purchases = await purchasesOf(customerId);
      const totals = totalsFrom(purchases);
      const updated = await db.update('customers', customerId, {
        total_purchases: totals.total_purchases,
        total_spent: totals.total_spent,
        last_purchase_at: totals.last_purchase_at,
        updated_at: new Date().toISOString(),
      });
      return { customer: updated, totals, purchases };
    },

    purchasesOf,
    totalsFrom,

    /** Conversación de WhatsApp del cliente (se crea si no existe). */
    async conversationFor(customerId, options = {}) {
      const rows = await db.list('conversations');
      const found = rows.find((row) => row.customer_id === customerId);
      if (found || options.create === false) return found ?? null;
      const now = new Date().toISOString();
      const doc = {
        id: newId('cnv'),
        customer_id: customerId,
        channel: 'whatsapp',
        status: 'AUTOMATIC',
        assigned_to: null,
        last_message_at: null,
        last_inbound_at: null,
        unread_count: 0,
        created_at: now,
        updated_at: now,
      };
      await db.insert('conversations', doc);
      return doc;
    },

    /**
     * Bandeja: conversaciones + cliente + último mensaje + seguimiento pendiente.
     * Todo lo que el negocio necesita para decidir a quién atender.
     */
    async listConversations(options = {}) {
      const [conversations, customers, messages] = await Promise.all([
        db.list('conversations', { by: 'last_message_at', order: 'desc' }),
        db.list('customers', { limit: 500 }),
        db.list('wa_messages', { by: 'created_at', order: 'desc', limit: 500 }),
      ]);
      const byCustomer = new Map(customers.map((row) => [row.id, row]));
      const items = conversations.map((conversation) => {
        const customer = byCustomer.get(conversation.customer_id) ?? null;
        const last = messages.find((message) => message.conversation_id === conversation.id) ?? null;
        return {
          ...conversation,
          customer,
          last_message: last ? { body: last.body, direction: last.direction, status: last.status, type: last.type ?? 'text', at: last.created_at } : null,
          /*
           * Pendiente de respuesta = el ÚLTIMO mensaje lo escribió el cliente.
           * Se calcula del propio hilo, así que NO se apaga por abrir o marcar
           * como leída la conversación: solo cuando el negocio contesta.
           */
          awaiting_reply: last ? last.direction === 'inbound' : false,
        };
      });
      return options.limit ? items.slice(0, options.limit) : items;
    },

    /** Mensajes de una conversación, del más antiguo al más nuevo. */
    async messagesFor(conversationId, options = {}) {
      const rows = await db.list('wa_messages', { by: 'created_at', order: 'asc' });
      const scoped = rows.filter((row) => row.conversation_id === conversationId);
      if (options.limit) return scoped.slice(-options.limit);
      return scoped;
    },

    /**
     * Registra un mensaje ENTRANTE (webhook).
     *
     * IDEMPOTENTE por `wa_message_id`: Meta reintenta webhooks, y un reintento no
     * puede crear un segundo mensaje ni volver a marcar la conversación.
     * Devuelve `{ duplicate:true }` en ese caso, sin tocar nada más.
     *
     * @param {{ waMessage: any }} input
     */
    async recordInbound(input) {
      const message = input.waMessage;
      if (!message?.waMessageId) return { ok: false, error: 'missing_message_id' };
      const existing = await db.findBy('wa_messages', 'wa_message_id', message.waMessageId);
      if (existing) return { ok: true, duplicate: true, customer: null, message: existing };

      const found = await this.findOrCreateByPhone({
        phone: message.from,
        name: message.profileName,
        source: 'whatsapp',
      });
      if (!found.ok) return { ok: false, error: 'invalid_phone' };
      const customer = found.customer;
      const conversation = await this.conversationFor(customer.id);

      const optOut = detectOptOut(message.body);
      const humanRequest = detectHumanRequest(message.body);
      const healthConcern = detectHealthConcern(message.body);
      const intent = classifyIntent(message.body);

      const now = new Date().toISOString();
      const doc = {
        id: newId('msg'),
        conversation_id: conversation.id,
        customer_id: customer.id,
        wa_message_id: message.waMessageId,
        direction: 'inbound',
        type: message.type ?? 'text',
        template_name: null,
        body: message.body,
        intent,
        button_id: message.buttonId ?? null,
        status: 'received',
        sent_at: null,
        delivered_at: null,
        read_at: null,
        failed_at: null,
        error_code: null,
        error_message: null,
        provider: null,
        created_at: now,
        received_at: message.receivedAt ?? now,
        idempotency_key: null,
      };
      await db.insert('wa_messages', doc);

      await db.update('conversations', conversation.id, {
        last_message_at: now,
        last_inbound_at: now,
        unread_count: Number(conversation.unread_count ?? 0) + 1,
        status: humanRequest || healthConcern ? 'HUMAN_REQUIRED' : conversation.status ?? 'AUTOMATIC',
        updated_at: now,
      });

      /** @type {Record<string, any>} */
      const customerPatch = { last_contact_at: now, updated_at: now };
      if (optOut) {
        customerPatch.do_not_contact = true;
        customerPatch.whatsapp_opt_out_at = now;
        customerPatch.whatsapp_opt_in = false;
        customerPatch.automation_state = 'PAUSED';
      } else if (humanRequest || healthConcern) {
        customerPatch.automation_state = 'HUMAN_REQUIRED';
      }
      await db.update('customers', customer.id, customerPatch);

      // Un opt-out manda: se cancelan los seguimientos de marketing pendientes.
      const cancelled = optOut && followups ? await followups.cancelMarketingFor(customer.id, 'opt_out') : [];

      return {
        ok: true,
        duplicate: false,
        customer: { ...customer, ...customerPatch },
        conversation,
        message: doc,
        intent,
        optOut,
        humanRequired: humanRequest || healthConcern,
        cancelledFollowups: cancelled.length,
      };
    },

    /**
     * Registra un mensaje SALIENTE (lo envía el panel con una persona delante).
     *
     * @param {{ customer: any, conversation: any, body?: string|null, template?: string|null, waMessageId?: string|null, status?: string, error?: any, sentBy?: string|null, idempotencyKey?: string|null, meta?: Record<string, any>|null }} input
     */
    async recordOutbound(input) {
      const now = new Date().toISOString();
      const doc = {
        id: newId('msg'),
        conversation_id: input.conversation.id,
        customer_id: input.customer.id,
        wa_message_id: input.waMessageId ?? null,
        direction: 'outbound',
        type: input.template ? 'template' : 'text',
        template_name: input.template ?? null,
        body: input.body ?? null,
        intent: null,
        button_id: null,
        status: input.status ?? 'pending',
        sent_at: input.status && input.status !== 'failed' ? now : null,
        delivered_at: null,
        read_at: null,
        failed_at: input.status === 'failed' ? now : null,
        error_code: input.error?.code ?? null,
        error_message: input.error ? short(input.error.message, 200) : null,
        provider: input.meta ?? null,
        sent_by: input.sentBy ?? 'panel',
        created_at: now,
        idempotency_key: input.idempotencyKey ?? null,
      };
      const result = await db.insert('wa_messages', doc);
      if (result.duplicate) return { ok: true, duplicate: true, message: doc };

      await db.update('conversations', input.conversation.id, {
        last_message_at: now,
        status: input.customer.automation_state === 'HUMAN_REQUIRED' ? input.conversation.status : input.conversation.status,
        updated_at: now,
      });
      await db.update('customers', input.customer.id, { last_contact_at: now, updated_at: now });
      return { ok: true, duplicate: false, message: doc };
    },

    /**
     * Aplica un estado del webhook (`sent`, `delivered`, `read`, `failed`).
     * Idempotente: repetir el mismo estado no cambia nada.
     */
    async updateMessageStatus(input) {
      const message = await db.findBy('wa_messages', 'wa_message_id', input.waMessageId);
      if (!message) return { ok: false, error: 'unknown_message' };
      const now = new Date().toISOString();
      /** @type {Record<string, any>} */
      const patch = { status: input.status };
      if (input.status === 'sent' && !message.sent_at) patch.sent_at = now;
      if (input.status === 'delivered' && !message.delivered_at) patch.delivered_at = now;
      if (input.status === 'read' && !message.read_at) patch.read_at = now;
      if (input.status === 'failed') {
        patch.failed_at = now;
        patch.error_code = input.errorCode ?? null;
        patch.error_message = short(input.errorMessage, 200);
      }
      const updated = await db.update('wa_messages', message.id, patch);
      return { ok: true, message: updated, changed: updated?.status !== message.status };
    },

    /** Marca la conversación como leída (la insignia del panel). */
    async markConversationRead(conversationId) {
      return db.update('conversations', conversationId, { unread_count: 0, updated_at: new Date().toISOString() });
    },

    /** Cambia el estado de automatización (humano, pausa, cierre). */
    async setAutomationState(customerId, state, patch = {}) {
      if (!AUTOMATION_STATES.includes(state)) return null;
      const updated = await db.update('customers', customerId, {
        automation_state: state,
        updated_at: new Date().toISOString(),
        ...(state === 'CLOSED' ? { notes: patch.note ?? null } : {}),
      });
      const conversation = await this.conversationFor(customerId, { create: false });
      if (conversation) await db.update('conversations', conversation.id, { status: state });
      return updated;
    },

    /** No contactar (opt-out manual desde el panel). */
    async applyOptOut(customerId, patch = {}) {
      const now = new Date().toISOString();
      const cancelled = followups ? await followups.cancelMarketingFor(customerId, patch.reason ?? 'opt_out') : [];
      const customer = await db.update('customers', customerId, {
        do_not_contact: true,
        whatsapp_opt_in: false,
        whatsapp_opt_out_at: now,
        automation_state: 'PAUSED',
        updated_at: now,
      });
      return { customer, cancelled: cancelled.length };
    },

    /** Vuelve a permitir el contacto (con consentimiento explícito del negocio). */
    async clearOptOut(customerId) {
      const now = new Date().toISOString();
      return db.update('customers', customerId, {
        do_not_contact: false,
        whatsapp_opt_in: true,
        whatsapp_opt_in_at: now,
        whatsapp_opt_out_at: null,
        automation_state: 'AUTOMATIC',
        updated_at: now,
      });
    },

    /** ¿Se puede escribir texto libre? (ventana de 24 h de WhatsApp). */
    canSendFreeText(conversation) {
      const last = conversation?.last_inbound_at;
      if (!last) return false;
      return Date.now() - Date.parse(last) < 24 * 60 * 60 * 1000;
    },

    /** Perfil 360: todo lo que hay que saber de un cliente, en una sola llamada. */
    async profile(customerId) {
      const customer = await db.get('customers', customerId);
      if (!customer) return null;
      const purchases = await purchasesOf(customerId);
      const conversation = await this.conversationFor(customerId);
      const messages = conversation ? await this.messagesFor(conversation.id, { limit: 100 }) : [];
      const followupRows = followups ? await followups.listForCustomer(customerId) : [];
      const nextFollowup = followupRows.find((row) => row.status === 'pending') ?? null;
      const supply = followups && purchases[0] ? followups.supplyFor(purchases[0]) : null;
      return {
        customer,
        purchases,
        totals: totalsFrom(purchases),
        conversation,
        messages,
        followups: followupRows,
        nextFollowup,
        supply,
        canSendFreeText: this.canSendFreeText(conversation),
        unread: Number(conversation?.unread_count ?? 0),
      };
    },

    /** Métricas simples (solo con datos que existen; nada inventado). */
    async metrics(options = {}) {
      const [customers, conversations, messages, followupBuckets] = await Promise.all([
        db.list('customers', { limit: 1000 }),
        db.list('conversations', { limit: 1000 }),
        db.list('wa_messages', { limit: 5000 }),
        followups ? followups.buckets() : Promise.resolve({ today: [], overdue: [], completed: [] }),
      ]);
      const purchases = store?.listAdmin ? await store.listAdmin({ limit: 1000 }) : [];
      const delivered = purchases.filter((row) => row.type === 'order_intent' && row.status === 'entregado');
      const withPurchase = new Set(delivered.map((row) => row.customer_id).filter(Boolean));
      const deliveredByCustomer = new Map();
      for (const row of delivered) {
        if (!row.customer_id) continue;
        deliveredByCustomer.set(row.customer_id, (deliveredByCustomer.get(row.customer_id) ?? 0) + 1);
      }
      const outbound = messages.filter((row) => row.direction === 'outbound');
      const since = options.since ?? null;
      return {
        customers: {
          total: customers.length,
          nuevos: since ? customers.filter((row) => String(row.created_at ?? '') >= since).length : customers.length,
          conCompra: withPurchase.size,
          sinCompra: customers.length - withPurchase.size,
          noContactar: customers.filter((row) => row.do_not_contact === true).length,
          enSeguimiento: new Set(
            followupBuckets.today.concat(followupBuckets.overdue).map((row) => row.customer_id),
          ).size,
        },
        conversations: {
          total: conversations.length,
          humanRequired: conversations.filter((row) => row.status === 'HUMAN_REQUIRED').length,
          humanaActiva: conversations.filter((row) => row.status === 'HUMAN_ACTIVE').length,
          pausadas: conversations.filter((row) => row.status === 'PAUSED').length,
          sinLeer: conversations.reduce((sum, row) => sum + (Number(row.unread_count) || 0), 0),
          // Sin contestar = el último mensaje del hilo lo escribió el cliente.
          sinContestar: conversations.filter((conversation) => {
            const last = messages.find((message) => message.conversation_id === conversation.id) ?? null;
            return last ? last.direction === 'inbound' : false;
          }).length,
        },
        followups: {
          hoy: followupBuckets.today.length,
          vencidos: followupBuckets.overdue.length,
          completados: followupBuckets.completed.length,
        },
        messages: {
          enviados: outbound.filter((row) => row.status !== 'pending').length,
          entregados: outbound.filter((row) => row.delivered_at || row.read_at).length,
          leidos: outbound.filter((row) => row.read_at).length,
          fallidos: outbound.filter((row) => row.status === 'failed').length,
          recibidos: messages.filter((row) => row.direction === 'inbound').length,
        },
        sales: {
          pedidos: purchases.filter((row) => row.type === 'order_intent').length,
          entregados: delivered.length,
          valorEntregado: delivered.reduce((sum, row) => sum + (Number(row.total) || 0), 0),
          recompras: [...deliveredByCustomer.values()].filter((count) => count > 1).length,
          manuales: delivered.filter((row) => row.channel === 'manual' || row.source === 'manual').length,
        },
      };
    },
  };
}
