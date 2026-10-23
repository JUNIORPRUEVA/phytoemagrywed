import { describe, expect, it, vi } from 'vitest';
import {
  SUPERVISOR_EVENTS,
  SUPERVISOR_ESCALATION_TEMPLATE,
  SUPERVISOR_REMINDER_TEMPLATE,
  SUPERVISOR_STAGES,
  handleSupervisorReply,
  parseDateHint,
  parseSupervisorIntent,
  postponeDelivery,
  supervisionEligibility,
  supervisionOf,
  supervisorSettings,
  supervisorSnapshot,
  supervisorTick,
} from '../server/delivery-supervisor.mjs';
import { COURIER_STATUS } from '../server/delivery-courier.mjs';

/* ------------------------------------------------------------------ utilidades */

const CONTACT = { id: 'cus_mensajero', name: 'Mensajero Pedro', phone: '8095550123' };

const baseOrder = (extra = {}) => ({
  id: 'ord_1',
  order_number: 'PE-100001',
  status: 'confirmado',
  customer_id: 'cus_cliente',
  customer_name: 'Ana Pérez',
  currency: 'DOP',
  total: 1500,
  created_at: '2026-10-18T12:00:00.000Z',
  delivery: {
    delivery_assigned_at: '2026-10-18T12:00:00.000Z',
    external: {
      contact_id: CONTACT.id,
      contact_name: CONTACT.name,
      phone_e164: '+18095550123',
      status: COURIER_STATUS.SENT,
      assigned_at: '2026-10-18T12:00:00.000Z',
    },
  },
  ...extra,
});

function makeWorld({
  orders = [],
  supervisor = {},
  users = [],
  contacts = [CONTACT],
  adminContacts = [],
  template = { ok: true, template: { name: SUPERVISOR_REMINDER_TEMPLATE, language: 'es' } },
  send = { ok: true, messageId: 'wamid.OUT.1' },
  now = '2026-10-18T15:00:00.000Z',
} = {}) {
  const world = {
    now,
    rows: orders.map((order) => ({ id: order.id, type: 'order_intent', status: order.status, orderJson: JSON.stringify(order) })),
    events: [],
    notifications: [],
    sends: [],
    texts: [],
    audits: [],
    completed: [],
  };
  const ctx = {
    clock: () => new Date(world.now),
    settings: {
      read: async (key) => {
        if (key === 'delivery_contacts') return { value: contacts };
        if (key === 'delivery_supervisor') return { value: { activationMode: 'all', ...supervisor } };
        if (key === 'delivery_control') return { value: { deliveryAdminEscalationContacts: adminContacts } };
        return null;
      },
      write: async () => ({}),
    },
    db: {
      async insert(name, doc) {
        if (name === SUPERVISOR_EVENTS) {
          if (doc.idempotency_key && world.events.some((entry) => entry.idempotency_key === doc.idempotency_key)) return { duplicate: true, doc };
          world.events.push(doc);
          return { duplicate: false, doc };
        }
        return { duplicate: false, doc };
      },
      async findBy(name, field, value) {
        if (name !== SUPERVISOR_EVENTS) return null;
        return world.events.find((entry) => entry[field] === value) ?? null;
      },
      async list(name) {
        return name === SUPERVISOR_EVENTS ? [...world.events] : [];
      },
      async update(name, id, patch) {
        /* El almacén real actualiza el documento; el falso tiene que igualarlo. */
        if (name !== SUPERVISOR_EVENTS) return null;
        const index = world.events.findIndex((entry) => entry.id === id);
        if (index < 0) return null;
        world.events[index] = { ...world.events[index], ...patch };
        return world.events[index];
      },
      async get() {
        return null;
      },
    },
    store: {
      async listAdmin() {
        return world.rows;
      },
      async update(id, patch) {
        world.rows = world.rows.map((row) => (row.id === id ? { ...row, orderJson: patch.orderJson } : row));
        return world.rows.find((row) => row.id === id) ?? null;
      },
    },
    users: {
      listUsers: async () => users,
      get: async (id) => users.find((user) => user.id === id) ?? null,
    },
    customers: {
      get: async () => null,
      conversationFor: async () => ({ id: 'cnv_mensajero' }),
      canSendFreeText: () => true,
      recordOutbound: async () => null,
    },
    whatsapp: {
      enabled: true,
      sendTemplate: vi.fn(async (to, payload) => {
        world.sends.push({ to, payload });
        return send;
      }),
      sendText: vi.fn(async (to, body) => {
        world.texts.push({ to, body });
        return { ok: true, messageId: 'wamid.TEXT.1' };
      }),
    },
    audit: {
      record: async (entry) => {
        world.audits.push(entry);
        return entry;
      },
    },
    proofreading: { interpret: async () => null },
  };
  const deps = {
    checkTemplate: async (name) => (typeof template === 'function' ? template(name) : template),
    refreshTemplate: async () => null,
    orderDeepLink: (orderId) => `https://phytoemagryrd.lat/admin/?v=delivery&order=${orderId}`,
    notifyUser: async (input) => {
      world.notifications.push(input);
      return { duplicate: false, notification: { id: `not_${world.notifications.length}`, ...input } };
    },
    push: async () => null,
    completeDelivery: async (orderId, options) => {
      world.completed.push({ orderId, options });
      return { ok: true };
    },
  };
  return { ctx, deps, world };
}

const currentOrder = (world, id = 'ord_1') => JSON.parse(world.rows.find((row) => row.id === id).orderJson);
const inbound = (body, extra = {}) => ({ waMessageId: `wamid.IN.${Math.random().toString(36).slice(2)}`, fromE164: '+18095550123', text: { body }, ...extra });

/* --------------------------------------------------------------- estado */

describe('estado de supervisión', () => {
  it('sin responsable pide asignar y no inventa nada', () => {
    const state = supervisionOf({ id: 'x', status: 'nuevo', created_at: '2026-10-18T12:00:00.000Z', delivery: {} });
    expect(state.stage).toBe(SUPERVISOR_STAGES.NO_RESPONSIBLE);
    expect(state.nextAction).toBe('Asignar un responsable');
  });

  it('reconoce cada etapa del repartidor externo', () => {
    const stageOf = (status) =>
      supervisionOf({ ...baseOrder(), delivery: { ...baseOrder().delivery, external: { ...baseOrder().delivery.external, status } } }).stage;
    expect(stageOf(COURIER_STATUS.ASSIGNED)).toBe(SUPERVISOR_STAGES.NOT_CONFIRMED);
    expect(stageOf(COURIER_STATUS.SENT)).toBe(SUPERVISOR_STAGES.PENDING_START);
    expect(stageOf(COURIER_STATUS.IN_PROGRESS)).toBe(SUPERVISOR_STAGES.IN_TRANSIT);
    expect(stageOf(COURIER_STATUS.AWAITING_CONFIRMATION)).toBe(SUPERVISOR_STAGES.AWAITING_CONFIRMATION);
    expect(stageOf(COURIER_STATUS.ISSUE)).toBe(SUPERVISOR_STAGES.ISSUE);
  });

  it('un agente interno iniciado queda en camino y un pedido pospuesto se aparta', () => {
    const interno = supervisionOf({
      id: 'x',
      status: 'enviado',
      delivery: { delivery_user_id: 'usr_1', delivery_status: 'IN_TRANSIT', delivery_assigned_at: '2026-10-18T12:00:00.000Z' },
    });
    expect(interno.stage).toBe(SUPERVISOR_STAGES.IN_TRANSIT);
    /*
     * Fecha RELATIVA al reloj de la prueba: una fecha fija caducaba sola (a
     * partir de ese día la posposición quedaba en el pasado y esta prueba
     * empezaba a fallar sin que nada se hubiera roto).
     */
    const manana = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const pospuesto = supervisionOf({
      ...baseOrder(),
      delivery: { ...baseOrder().delivery, supervisor: { postponed_until: manana } },
    });
    expect(pospuesto.stage).toBe(SUPERVISOR_STAGES.POSTPONED);
  });

  it('un pedido cerrado no se supervisa', () => {
    expect(supervisionOf(baseOrder({ status: 'entregado' })).stage).toBe(SUPERVISOR_STAGES.CLOSED);
  });
});

/* --------------------------------------------------------- interpretación */

describe('interpretación determinista de las respuestas', () => {
  it('entiende las frases del negocio', () => {
    const intent = (text) => parseSupervisorIntent({ text: { body: text } });
    expect(intent('Ya lo recibí')).toBe('ack');
    expect(intent('Voy para allá')).toBe('start');
    expect(intent('Estoy recogiendo')).toBe('pickup');
    expect(intent('Ya compré los productos')).toBe('pickup');
    expect(intent('Estoy llegando')).toBe('arriving');
    expect(intent('Ya lo entregué')).toBe('delivered');
    expect(intent('El cliente no está')).toBe('issue');
    expect(intent('No pude conseguir el producto')).toBe('issue');
    expect(intent('Mañana lo entrego')).toBe('postpone');
    expect(intent('Necesito hablar con administración')).toBe('help_admin');
    expect(intent('Sí, confirmar')).toBe('confirm');
  });

  it('no confunde una negación con una entrega', () => {
    const intent = (text) => parseSupervisorIntent({ text: { body: text } });
    expect(intent('No lo entregué todavía')).not.toBe('delivered');
    expect(intent('No lo entregué todavía')).toBeNull();
    expect(intent('No pude entregar')).toBe('issue');
  });

  it('entiende los botones de la plantilla', () => {
    expect(parseSupervisorIntent({ button: { payload: 'ENTREGADO' } })).toBe('delivered');
    expect(parseSupervisorIntent({ button: { payload: 'INICIAR_ENTREGA' } })).toBe('start');
    expect(parseSupervisorIntent({ button: { payload: 'PROBLEMA' } })).toBe('issue');
    // Respuesta rápida SIN payload (Cloud API puede mandar solo el texto).
    expect(parseSupervisorIntent({ button: { text: 'Iniciar entrega' } })).toBe('start');
    expect(parseSupervisorIntent({ button: { text: 'Entregado' } })).toBe('delivered');
    expect(parseSupervisorIntent({ button: { text: 'Reportar problema' } })).toBe('issue');
    expect(parseSupervisorIntent({ interactive: { button_reply: { title: 'Reportar problema' } } })).toBe('issue');
  });

  it('lee la fecha que dice el repartidor', () => {
    expect(parseDateHint('lo entrego el 2026-10-22')).toBe('2026-10-22');
    expect(parseDateHint('mañana lo entrego')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parseDateHint('el lunes')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parseDateHint('ya voy')).toBeNull();
  });
});

/* ------------------------------------------------------------- posposición */

describe('posponer una entrega', () => {
  const item = { id: 'ord_1' };

  it('exige motivo y fecha futura dentro del límite', async () => {
    const { ctx } = makeWorld();
    const order = baseOrder();
    expect((await postponeDelivery({ ctx, item, order, until: '2026-10-20' })).error).toBe('reason_required');
    expect((await postponeDelivery({ ctx, item, order, reason: 'Cliente no está', until: '2026-10-10' })).error).toBe('date_in_past');
    expect((await postponeDelivery({ ctx, item, order, reason: 'Cliente no está', until: '2027-03-01' })).error).toBe('date_too_far');
    expect((await postponeDelivery({ ctx, item, order, reason: 'Cliente no está', until: 'no-es-fecha' })).error).toBe('invalid_date');
  });

  it('guarda la fecha, conserva el estado y audita', async () => {
    const { ctx, world } = makeWorld({ orders: [baseOrder()] });
    const result = await postponeDelivery({ ctx, item, order: baseOrder(), reason: 'Cliente no está', until: '2026-10-20', note: 'Prefiere el martes' });
    expect(result.ok).toBe(true);
    const saved = currentOrder(world);
    expect(saved.status).toBe('confirmado');
    expect(saved.delivery.supervisor.postponed_until).toBe('2026-10-20T12:00:00.000Z');
    expect(saved.delivery.supervisor.postpone_reason).toBe('Cliente no está');
    expect(saved.delivery.supervisor.postpone_count).toBe(1);
    expect(world.audits.some((entry) => entry.action === 'order.delivery_postponed')).toBe(true);
    expect(world.events.some((entry) => entry.kind === 'postponed')).toBe(true);
  });

  it('no deja posponer sin fin', async () => {
    const { ctx } = makeWorld();
    const order = baseOrder();
    order.delivery.supervisor = { postpone_count: 3 };
    const result = await postponeDelivery({ ctx, item, order, reason: 'Otra vez', until: '2026-10-21' });
    expect(result.status).toBe(409);
    expect(result.error).toBe('postpone_limit');
  });
});

/* ------------------------------------------------------------ recordatorios */

describe('motor de recordatorios', () => {
  it('no supervisa pedidos cerrados, sin repartidor ni anteriores a la activación', () => {
    const cerrado = baseOrder({ id: 'ord_c', order_number: 'PE-C', status: 'entregado' });
    const sinRepartidor = baseOrder({ id: 'ord_s', order_number: 'PE-S', delivery: {} });
    const viejo = baseOrder({ id: 'ord_v', order_number: 'PE-V' });
    const nuevo = baseOrder({ id: 'ord_n', order_number: 'PE-N' });
    const settings = { activationMode: 'new', activatedAt: '2026-10-18T11:00:00.000Z' };
    expect(supervisionEligibility(cerrado, settings).reason).toBe('closed');
    expect(supervisionEligibility(sinRepartidor, settings).reason).toBe('unassigned');
    expect(supervisionEligibility(viejo, settings).eligible).toBe(true);
    viejo.delivery.delivery_assigned_at = '2026-10-01T10:00:00.000Z';
    expect(supervisionEligibility(viejo, settings).reason).toBe('before_activation');
    expect(supervisionEligibility(viejo, settings, 'ord_v').eligible).toBe(false);
    expect(supervisionEligibility(viejo, { ...settings, includeOldOrders: true }).eligible).toBe(true);
    expect(supervisionEligibility(viejo, { ...settings, includeOrderIds: ['ord_v'] }).eligible).toBe(true);
    expect(supervisionEligibility(nuevo, { ...settings, activatedAt: null }).reason).toBe('not_activated');
  });

  it('no escribe a pedidos sin responsable ni históricos al activar', async () => {
    const viejo = baseOrder({ id: 'ord_h', order_number: 'PE-H', delivery: { delivery_assigned_at: '2026-09-01T10:00:00.000Z', delivery_user_id: 'usr_rep', delivery_user_name_snapshot: 'Ruben', delivery_status: 'PENDING_CONTACT' } });
    const sinRepartidor = baseOrder({ id: 'ord_sin', order_number: 'PE-SIN', delivery: {} });
    const { ctx, deps, world } = makeWorld({
      orders: [viejo, sinRepartidor],
      supervisor: { activationMode: 'new', activatedAt: '2026-10-18T11:00:00.000Z' },
      users: [{ id: 'usr_rep', role: 'AGENT', active: true, display_name: 'Ruben', personal_phone: '8095550123' }],
    });
    world.now = '2026-10-18T16:00:00.000Z';
    const result = await supervisorTick(ctx, deps);
    expect(result.reminders).toBe(0);
    expect(result.escalations).toBe(0);
    expect(world.sends).toHaveLength(0);
    expect(world.notifications).toHaveLength(0);
    expect(result.excluded.before_activation).toBe(1);
    expect(result.excluded.unassigned).toBe(1);
  });

  it('respeta el límite de avisos por pasada y deja el resto para la siguiente', async () => {
    const pedidos = [
      baseOrder({ id: 'ord_1', order_number: 'PE-1' }),
      baseOrder({ id: 'ord_2', order_number: 'PE-2' }),
      baseOrder({ id: 'ord_3', order_number: 'PE-3' }),
    ];
    const { ctx, deps, world } = makeWorld({ orders: pedidos, supervisor: { maxRemindersPerTick: 2 } });
    world.now = '2026-10-18T15:30:00.000Z';
    const result = await supervisorTick(ctx, deps);
    expect(result.reminders).toBe(2);
    expect(result.limited).toBe(1);
    expect(world.sends).toHaveLength(2);
  });

  it('espera el primer plazo antes de escribir', async () => {
    const { ctx, deps, world } = makeWorld({ orders: [baseOrder()] });
    world.now = '2026-10-18T12:04:00.000Z'; // 4 min después de asignar (el plazo es 5)
    const result = await supervisorTick(ctx, deps);
    expect(result.reminders).toBe(0);
    expect(world.sends).toHaveLength(0);
  });

  it('manda un recordatorio con la siguiente acción y no lo repite', async () => {
    const { ctx, deps, world } = makeWorld({ orders: [baseOrder()] });
    world.now = '2026-10-18T15:30:00.000Z'; // 30 min después de asignar
    const first = await supervisorTick(ctx, deps);
    expect(first.reminders).toBe(1);
    expect(world.sends).toHaveLength(1);
    expect(world.sends[0].payload.name).toBe(SUPERVISOR_REMINDER_TEMPLATE);
    const parameters = world.sends[0].payload.components[0].parameters.map((entry) => entry.text);
    expect(parameters).toEqual([CONTACT.name, 'PE-100001', 'Iniciar la entrega']);

    const second = await supervisorTick(ctx, deps);
    expect(second.reminders).toBe(0);
    expect(world.sends).toHaveLength(1);
  });

  it('sin plantilla aprobada intenta el texto libre y no lo da por enviado si Meta lo rechaza', async () => {
    const { ctx, deps, world } = makeWorld({ orders: [baseOrder()], template: { ok: false, reason: 'template_not_approved' }, users: [{ id: 'usr_admin', role: 'ADMIN', active: true }] });
    world.now = '2026-10-18T15:30:00.000Z';
    const result = await supervisorTick(ctx, deps);
    /*
     * Antes se quedaba en «pendiente» sin intentar nada. Ahora se prueba el
     * texto libre (solo entrega dentro de la ventana de 24 h): si el mock lo
     * acepta, cuenta como enviado; si Meta lo rechaza, queda pendiente con el
     * motivo real y el tiempo sigue corriendo hasta escalar.
     */
    expect(world.sends).toHaveLength(0);
    const libre = world.texts.at(-1);
    expect(libre?.to).toBe(`+1${CONTACT.phone}`);
    const reminder = world.events.find((entry) => entry.kind === 'reminder');
    expect(['sent', 'pending']).toContain(reminder.status);
    if (reminder.status === 'sent') {
      expect(reminder.data.channel).toBe('text');
      expect(result.reminders).toBe(1);
    } else {
      expect(reminder.data.error).toContain('template_not_approved');
      expect(result.escalations).toBe(1);
      expect(world.notifications.some((entry) => entry.type === 'DELIVERY_SUPERVISOR_ESCALATION')).toBe(true);
    }
  });

  it('si el texto libre también falla, deja el motivo real y escala', async () => {
    const { ctx, deps, world } = makeWorld({ orders: [baseOrder()], template: { ok: false, reason: 'template_not_approved' }, users: [{ id: 'usr_admin', role: 'ADMIN', active: true }] });
    ctx.whatsapp.sendText = vi.fn(async () => ({ ok: false, error: { message: 'Message outside customer service window (131047)' } }));
    world.now = '2026-10-18T15:30:00.000Z';
    const result = await supervisorTick(ctx, deps);
    const reminder = world.events.find((entry) => entry.kind === 'reminder');
    expect(reminder.status).toBe('pending');
    expect(reminder.data.error).toContain('template_not_approved');
    expect(reminder.data.error).toContain('131047');
    expect(result.escalations).toBe(1);
  });

  it('respeta el límite de intentos y deja la incidencia abierta', async () => {
    const { ctx, deps, world } = makeWorld({
      orders: [baseOrder()],
      supervisor: { maxAttempts: 2, followUpMinutes: 5, firstReminderMinutes: 5 },
      users: [{ id: 'usr_admin', role: 'ADMIN', active: true }],
    });
    world.now = '2026-10-18T13:00:00.000Z';
    await supervisorTick(ctx, deps);
    world.now = '2026-10-18T13:06:00.000Z';
    await supervisorTick(ctx, deps);
    world.now = '2026-10-18T13:12:00.000Z';
    const result = await supervisorTick(ctx, deps);
    expect(world.sends).toHaveLength(2);
    expect(result.escalations).toBe(1);
    const notice = world.notifications.find((entry) => entry.type === 'DELIVERY_SUPERVISOR_ESCALATION');
    expect(notice).toBeTruthy();
  });

  it('se calla si el repartidor respondió hace poco', async () => {
    const order = baseOrder();
    order.delivery.supervisor = { last_reply_at: '2026-10-18T15:20:00.000Z' };
    const { ctx, deps, world } = makeWorld({ orders: [order] });
    world.now = '2026-10-18T15:30:00.000Z';
    const result = await supervisorTick(ctx, deps);
    expect(result.paused).toBe(1);
    expect(world.sends).toHaveLength(0);
  });

  it('no escribe fuera del horario de contacto', async () => {
    const { ctx, deps, world } = makeWorld({ orders: [baseOrder()] });
    world.now = '2026-10-18T23:30:00.000Z'; // 19:30 RD → dentro; se prueba el borde de la noche
    const night = makeWorld({ orders: [baseOrder()] });
    night.world.now = '2026-10-19T02:00:00.000Z'; // 22:00 RD → fuera
    const result = await supervisorTick(night.ctx, night.deps);
    expect(result.deferred).toBe(1);
    expect(night.world.sends).toHaveLength(0);
  });

  it('la posposición vence y el seguimiento se reanuda una sola vez', async () => {
    const order = baseOrder();
    order.delivery.supervisor = { postponed_until: '2026-10-18T13:00:00.000Z', postpone_reason: 'Cliente no está' };
    const { ctx, deps, world } = makeWorld({ orders: [order] });
    world.now = '2026-10-18T15:00:00.000Z';
    const first = await supervisorTick(ctx, deps);
    expect(first.postponedDue).toBe(1);
    const second = await supervisorTick(ctx, deps);
    expect(second.postponedDue).toBe(0);
    expect(world.events.filter((entry) => entry.kind === 'postpone_due')).toHaveLength(1);
  });

  it('con el supervisor apagado no manda nada', async () => {
    const { ctx, deps, world } = makeWorld({ orders: [baseOrder()], supervisor: { enabled: false } });
    world.now = '2026-10-18T20:00:00.000Z';
    const result = await supervisorTick(ctx, deps);
    expect(result.enabled).toBe(false);
    expect(world.sends).toHaveLength(0);
  });

  it('lanza la conciliación diaria UNA vez, a partir de la hora configurada', async () => {
    const { ctx, deps, world } = makeWorld({
      orders: [baseOrder()],
      supervisor: { dailySummaryHour: 18 },
      users: [{ id: 'usr_admin', role: 'ADMIN', active: true, display_name: 'Admin' }],
    });
    world.now = '2026-10-18T15:00:00.000Z'; // 11:00 en RD: todavía no toca
    const antes = await supervisorTick(ctx, deps);
    expect(antes.daily).toBe(false);
    expect(world.events.some((entry) => entry.kind === 'daily')).toBe(false);

    world.now = '2026-10-18T23:30:00.000Z'; // 19:30 en RD: ya pasó la hora
    const despues = await supervisorTick(ctx, deps);
    expect(despues.daily).toBe(true);
    expect(world.events.filter((entry) => entry.kind === 'daily')).toHaveLength(1);

    const otraVez = await supervisorTick(ctx, deps);
    expect(otraVez.daily).toBe(false);
    expect(world.events.filter((entry) => entry.kind === 'daily')).toHaveLength(1);
  });
});

/* ------------------------------------------ escalado por WhatsApp a admin */

const issueOrder = () => {
  const order = baseOrder();
  return {
    ...order,
    delivery: { ...order.delivery, external: { ...order.delivery.external, status: COURIER_STATUS.ISSUE } },
  };
};

describe('escalado a administración por WhatsApp', () => {
  it('avisa una sola vez, con datos mínimos y enlace absoluto, sin perder la campana interna', async () => {
    const { ctx, deps, world } = makeWorld({
      orders: [issueOrder()],
      users: [{ id: 'usr_admin', role: 'ADMIN', active: true }],
      adminContacts: [
        { name: 'Yahaira', phone: '8294933332' },
        { name: 'Junior', phone: '8293987826' },
      ],
      template: (name) => ({ ok: true, template: { name, language: 'es' } }),
    });
    world.now = '2026-10-18T15:30:00.000Z';
    const first = await supervisorTick(ctx, deps);
    expect(first.escalations).toBe(1);

    const toAdmins = world.sends.filter((row) => row.payload.name === SUPERVISOR_ESCALATION_TEMPLATE);
    expect(toAdmins).toHaveLength(2);
    expect(toAdmins.map((row) => row.to)).toEqual(['+18294933332', '+18293987826']);

    const parameters = toAdmins[0].payload.components[0].parameters.map((entry) => entry.text);
    expect(parameters).toEqual([
      'PE-100001',
      CONTACT.name,
      'https://phytoemagryrd.lat/admin/?v=delivery&order=ord_1',
    ]);
    // Minimización: ni teléfono ni dirección del cliente viajan a administración.
    expect(parameters.join(' ')).not.toContain('8095550123');
    expect(parameters.join(' ')).not.toContain('Calle');

    // El aviso interno sigue saliendo.
    expect(world.notifications.some((entry) => entry.type === 'DELIVERY_SUPERVISOR_ESCALATION')).toBe(true);

    // Segunda pasada: ni WhatsApp ni campana se repiten.
    const second = await supervisorTick(ctx, deps);
    expect(second.escalations).toBe(0);
    expect(world.sends.filter((row) => row.payload.name === SUPERVISOR_ESCALATION_TEMPLATE)).toHaveLength(2);
    expect(world.events.filter((entry) => entry.kind === 'escalation')).toHaveLength(1);
  });

  it('si la plantilla no está aprobada deja constancia y no finge el envío', async () => {
    const { ctx, deps, world } = makeWorld({
      orders: [issueOrder()],
      users: [{ id: 'usr_admin', role: 'ADMIN', active: true }],
      adminContacts: [{ name: 'Yahaira', phone: '8294933332' }],
      template: { ok: false, reason: 'template_not_approved' },
    });
    world.now = '2026-10-18T15:30:00.000Z';
    await supervisorTick(ctx, deps);
    expect(world.sends).toHaveLength(0);
    const escalation = world.events.find((entry) => entry.kind === 'escalation');
    expect(escalation.data.whatsapp[0].status).toBe('pending');
    expect(escalation.data.whatsapp[0].error).toBe('template_not_approved');
    expect(world.audits.some((entry) => entry.action === 'delivery.supervisor_escalation_unavailable')).toBe(true);
  });

  it('manda a TODOS los destinos de administración únicos (sin tope de cuatro)', async () => {
    const adminContacts = Array.from({ length: 6 }, (_, index) => ({
      name: `Admin ${index + 1}`,
      phone: `82940000${index}0`,
    }));
    const { ctx, deps, world } = makeWorld({
      orders: [issueOrder()],
      users: [{ id: 'usr_admin', role: 'ADMIN', active: true }],
      adminContacts,
      template: (name) => ({ ok: true, template: { name, language: 'es' } }),
    });
    world.now = '2026-10-18T15:30:00.000Z';
    await supervisorTick(ctx, deps);
    /* Seis contactos de respaldo (ningún ADMIN con teléfono) → seis mensajes. */
    expect(world.sends.filter((row) => row.payload.name === SUPERVISOR_ESCALATION_TEMPLATE)).toHaveLength(6);
  });
});

/* -------------------------------------------------- respuestas por WhatsApp */

describe('respuestas del repartidor por WhatsApp', () => {
  it('entiende las frases reales del repartidor («voy de camino», «mañana lo llevo»)', () => {
    expect(parseSupervisorIntent(inbound('Voy de camino'))).toBe('start');
    expect(parseSupervisorIntent(inbound('Estoy de camino'))).toBe('start');
    expect(parseSupervisorIntent(inbound('Ya lo entregué'))).toBe('delivered');
    expect(parseSupervisorIntent(inbound('No pude entregar, no hay nadie'))).toBe('issue');
    expect(parseSupervisorIntent(inbound('Mañana lo llevo'))).toBe('postpone');
  });

  it('ignora números que no son de reparto', async () => {
    const { ctx, deps } = makeWorld({ orders: [baseOrder()] });
    const result = await handleSupervisorReply({ ctx, inbound: inbound('Ya lo entregué', { fromE164: '+18090000000' }), deps });
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('not_a_courier');
  });

  it('«Entregado» NO cierra: pide confirmación explícita', async () => {
    const { ctx, deps, world } = makeWorld({ orders: [baseOrder()] });
    const result = await handleSupervisorReply({ ctx, inbound: inbound('Ya lo entregué'), conversation: { id: 'cnv_mensajero' }, deps });
    expect(result.reason).toBe('awaiting_confirmation');
    expect(world.completed).toHaveLength(0);
    const saved = currentOrder(world);
    expect(saved.delivery.external.status).toBe(COURIER_STATUS.AWAITING_CONFIRMATION);
    expect(world.texts.at(-1).body).toContain('CONFIRMAR');
  });

  it('«CONFIRMAR» ejecuta la transición oficial una sola vez', async () => {
    const order = baseOrder();
    order.delivery.external.status = COURIER_STATUS.AWAITING_CONFIRMATION;
    const { ctx, deps, world } = makeWorld({ orders: [order] });
    const result = await handleSupervisorReply({ ctx, inbound: inbound('Sí, confirmar'), conversation: { id: 'cnv_mensajero' }, deps });
    expect(result.reason).toBe('delivered');
    expect(world.completed).toHaveLength(1);
    expect(world.completed[0].orderId).toBe('ord_1');
    const saved = currentOrder(world);
    expect(saved.delivery.external.status).toBe(COURIER_STATUS.DELIVERED);
  });

  it('no confirma sin haber reportado la entrega', async () => {
    const { ctx, deps, world } = makeWorld({ orders: [baseOrder()] });
    const result = await handleSupervisorReply({ ctx, inbound: inbound('CONFIRMAR'), conversation: { id: 'cnv_mensajero' }, deps });
    expect(result.reason).toBe('confirm_without_report');
    expect(world.completed).toHaveLength(0);
  });

  it('con dos pedidos abiertos NO adivina: pide el número', async () => {
    const second = baseOrder({ id: 'ord_2', order_number: 'PE-100002' });
    const { ctx, deps, world } = makeWorld({ orders: [baseOrder(), second] });
    const result = await handleSupervisorReply({ ctx, inbound: inbound('Entregado'), conversation: { id: 'cnv_mensajero' }, deps });
    expect(result.reason).toBe('ambiguous');
    expect(world.completed).toHaveLength(0);
    expect(world.texts.at(-1).body).toContain('PE-100001');
    expect(world.texts.at(-1).body).toContain('PE-100002');
  });

  it('con dos pedidos abiertos, el número elegido manda', async () => {
    const second = baseOrder({ id: 'ord_2', order_number: 'PE-100002' });
    const { ctx, deps, world } = makeWorld({ orders: [baseOrder(), second] });
    const result = await handleSupervisorReply({ ctx, inbound: inbound('Entregado PE-100002'), conversation: { id: 'cnv_mensajero' }, deps });
    expect(result.orderId).toBe('ord_2');
    expect(currentOrder(world, 'ord_2').delivery.external.status).toBe(COURIER_STATUS.AWAITING_CONFIRMATION);
    expect(currentOrder(world, 'ord_1').delivery.external.status).toBe(COURIER_STATUS.SENT);
  });

  it('una incidencia escala a administración y no cierra nada', async () => {
    const { ctx, deps, world } = makeWorld({ orders: [baseOrder()], users: [{ id: 'usr_admin', role: 'ADMIN', active: true }] });
    const result = await handleSupervisorReply({ ctx, inbound: inbound('El cliente no está'), conversation: { id: 'cnv_mensajero' }, deps });
    expect(result.reason).toBe('issue');
    expect(world.completed).toHaveLength(0);
    expect(currentOrder(world).delivery.external.status).toBe(COURIER_STATUS.ISSUE);
    expect(world.notifications.some((entry) => entry.type === 'DELIVERY_SUPERVISOR_ESCALATION')).toBe(true);
  });

  it('«mañana lo entrego» pide confirmación y luego pospone', async () => {
    const { ctx, deps, world } = makeWorld({ orders: [baseOrder()] });
    const asked = await handleSupervisorReply({ ctx, inbound: inbound('no puedo hoy'), conversation: { id: 'cnv_mensajero' }, deps });
    expect(asked.reason).toBe('postpone_date_needed');
    const dated = await handleSupervisorReply({ ctx, inbound: inbound('posponer para el 2026-10-22'), conversation: { id: 'cnv_mensajero' }, deps });
    expect(dated.reason).toBe('postpone_confirmation');
    expect(currentOrder(world).delivery.supervisor.pending_action.type).toBe('postpone');
    const confirmed = await handleSupervisorReply({ ctx, inbound: inbound('CONFIRMAR'), conversation: { id: 'cnv_mensajero' }, deps });
    expect(confirmed.reason).toBe('postponed');
    const saved = currentOrder(world);
    expect(saved.delivery.supervisor.postponed_until).toBe('2026-10-22T12:00:00.000Z');
    expect(saved.delivery.external.status).toBe(COURIER_STATUS.SENT);
    expect(world.completed).toHaveLength(0);
  });

  it('un agente interno también puede responder desde su teléfono', async () => {
    const order = baseOrder({
      delivery: {
        delivery_user_id: 'usr_rep',
        delivery_user_name_snapshot: 'Ruben',
        delivery_status: 'PENDING_CONTACT',
        delivery_assigned_at: '2026-10-18T12:00:00.000Z',
      },
    });
    const users = [{ id: 'usr_rep', role: 'AGENT', active: true, display_name: 'Ruben', personal_phone: '8095550123' }];
    const { ctx, deps, world } = makeWorld({ orders: [order], users, contacts: [] });
    const result = await handleSupervisorReply({ ctx, inbound: inbound('Voy para allá'), conversation: { id: 'cnv_rep' }, deps });
    expect(result.reason).toBe('started');
    expect(currentOrder(world).delivery.delivery_status).toBe('IN_TRANSIT');
  });

  it('el agente interno que avisa «entregado» queda esperando CONFIRMAR y cierra con la transición oficial', async () => {
    const order = baseOrder({
      status: 'enviado',
      delivery: {
        delivery_user_id: 'usr_rep',
        delivery_user_name_snapshot: 'Ruben',
        delivery_status: 'IN_TRANSIT',
        delivery_assigned_at: '2026-10-18T12:00:00.000Z',
      },
    });
    const users = [{ id: 'usr_rep', role: 'AGENT', active: true, display_name: 'Ruben', personal_phone: '8095550123' }];
    const { ctx, deps, world } = makeWorld({ orders: [order], users, contacts: [] });
    const reported = await handleSupervisorReply({ ctx, inbound: inbound('Ya lo entregué'), conversation: { id: 'cnv_rep' }, deps });
    expect(reported.reason).toBe('awaiting_confirmation');
    expect(world.completed).toHaveLength(0);
    const enEspera = supervisionOf(currentOrder(world), { settings: {}, now: Date.parse(world.now) });
    expect(enEspera.stage).toBe(SUPERVISOR_STAGES.AWAITING_CONFIRMATION);

    const confirmed = await handleSupervisorReply({ ctx, inbound: inbound('CONFIRMAR'), conversation: { id: 'cnv_rep' }, deps });
    expect(confirmed.reason).toBe('delivered');
    expect(world.completed).toHaveLength(1);
    expect(world.completed[0].orderId ?? world.completed[0].id ?? world.completed[0]).toBeTruthy();
  });

  it('un mensaje que no se entiende pregunta antes de actuar', async () => {
    const { ctx, deps, world } = makeWorld({ orders: [baseOrder()] });
    const result = await handleSupervisorReply({ ctx, inbound: inbound('jaja ok'), conversation: { id: 'cnv_mensajero' }, deps });
    expect(result.handled).toBe(true);
    expect(world.completed).toHaveLength(0);
    expect(currentOrder(world).delivery.external.status).toBe(COURIER_STATUS.SENT);
  });

  it('la IA solo propone: una intención fuera de la lista no se ejecuta', async () => {
    const { ctx, deps, world } = makeWorld({ orders: [baseOrder()] });
    ctx.proofreading.interpret = async () => ({ intent: 'entregado_confirmado', confidence: 0.99 });
    const result = await handleSupervisorReply({ ctx, inbound: inbound('ok listo'), conversation: { id: 'cnv_mensajero' }, deps });
    expect(world.completed).toHaveLength(0);
    expect(currentOrder(world).delivery.external.status).toBe(COURIER_STATUS.SENT);
    expect(result.handled).toBe(true);
  });

  it('la IA con poca confianza no mueve el pedido', async () => {
    const { ctx, deps, world } = makeWorld({ orders: [baseOrder()] });
    ctx.proofreading.interpret = async () => ({ intent: 'delivered', confidence: 0.2 });
    await handleSupervisorReply({ ctx, inbound: inbound('ok listo'), conversation: { id: 'cnv_mensajero' }, deps });
    expect(world.completed).toHaveLength(0);
    expect(currentOrder(world).delivery.external.status).toBe(COURIER_STATUS.SENT);
  });
});

/* ------------------------------------------------------------------- panel */

describe('foto para el panel', () => {
  it('agrupa por situación y devuelve los ajustes', async () => {
    const orders = [
      baseOrder({ id: 'ord_1' }),
      baseOrder({ id: 'ord_2', order_number: 'PE-100002', status: 'enviado', delivery: { delivery_assigned_at: '2026-10-18T12:00:00.000Z', delivery_user_id: 'usr_rep', delivery_status: 'IN_TRANSIT' } }),
      baseOrder({ id: 'ord_3', order_number: 'PE-100003', status: 'entregado', delivered_at: '2026-10-18T13:00:00.000Z' }),
    ];
    const { ctx, deps } = makeWorld({ orders });
    const snapshot = await supervisorSnapshot(ctx, deps);
    expect(snapshot.counts.sin_iniciar).toBe(1);
    expect(snapshot.counts.en_camino).toBe(1);
    expect(snapshot.counts.confirmadas).toBe(1);
    expect(snapshot.settings.maxAttempts).toBe(3);
    expect(snapshot.buckets.sin_iniciar[0].order_number).toBe('PE-100001');
  });

  it('muestra pedidos asignados antes de activar para revisión sin mezclarlos con los avisos automáticos', async () => {
    const antiguo = baseOrder({ id: 'ord_old', order_number: 'PE-OLD' });
    antiguo.delivery.delivery_assigned_at = '2026-10-17T10:00:00.000Z';
    antiguo.delivery.external.assigned_at = '2026-10-17T10:00:00.000Z';
    const { ctx, deps } = makeWorld({
      orders: [antiguo],
      supervisor: { activationMode: 'new', activatedAt: '2026-10-18T00:00:00.000Z' },
    });
    const snapshot = await supervisorSnapshot(ctx, deps);
    expect(snapshot.counts.revision).toBe(1);
    expect(snapshot.buckets.revision[0]).toMatchObject({
      id: 'ord_old',
      review_reason: 'before_activation',
      next_action: expect.stringContaining('Revisar pedido histórico'),
    });
    expect(snapshot.counts.sin_iniciar).toBe(0);
  });

  it('los ajustes se normalizan y respetan límites', async () => {
    const { ctx } = makeWorld();
    const settings = await supervisorSettings(ctx);
    expect(settings).toMatchObject({ enabled: true, firstReminderMinutes: 5, maxAttempts: 3 });
    const { ctx: otro } = makeWorld({ supervisor: { firstReminderMinutes: 99999, maxAttempts: 0, contactFromHour: -5 } });
    const clamped = await supervisorSettings(otro);
    expect(clamped.firstReminderMinutes).toBe(1440);
    expect(clamped.maxAttempts).toBe(1);
    expect(clamped.contactFromHour).toBe(0);
  });

  it('migra una instalación habilitada sin fecha y fija un corte sin activar pedidos viejos', async () => {
    const value = { enabled: true, activationMode: 'new', activatedAt: null, includeOldOrders: false };
    const write = vi.fn(async (_key, next) => { Object.assign(value, next); });
    const ctx = { clock: () => new Date('2026-10-19T14:00:00.000Z'), settings: { read: async () => ({ value }), write } };
    const settings = await supervisorSettings(ctx);
    expect(settings.activatedAt).toBe('2026-10-19T14:00:00.000Z');
    expect(write).toHaveBeenCalledTimes(1);
    expect(value.includeOldOrders).toBe(false);
  });
});
