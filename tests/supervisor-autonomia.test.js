// @vitest-environment node
/**
 * SUPERVISOR IA DE DELIVERY — AUTONOMÍA, PLAZOS E IDEMPOTENCIA
 *
 * Pruebas de los comportamientos que la auditoría forense encontró sin cubrir
 * (o defectuosos) y que el motor DEBE garantizar:
 *
 *   · escalado por tiempo REAL (`escalateAfterMinutes` antes era un ajuste muerto)
 *   · reserva del trabajo ANTES de enviar (dos pasadas no duplican el aviso)
 *   · el scheduler no se solapa consigo mismo
 *   · tras un reinicio no se repiten avisos
 *   · un pedido entregado antes del plazo no genera recordatorio ni escalado
 *   · un cambio de etapa reinicia el conteo sin repetir el aviso anterior
 *   · una reasignación avisa al repartidor nuevo, no al anterior
 *   · un webhook duplicado no responde dos veces
 *
 * Reloj CONTROLADO: `now` se mueve a mano, nunca depende de la hora real.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SUPERVISOR_EVENTS,
  SUPERVISOR_REMINDER_TEMPLATE,
  handleSupervisorReply,
  supervisorAnswer,
  supervisorDiagnostics,
  supervisorTick,
} from '../server/delivery-supervisor.mjs';
import { COURIER_STATUS } from '../server/delivery-courier.mjs';
import { createScheduler } from '../server/scheduler.mjs';

const T0 = Date.parse('2026-10-20T14:00:00.000Z');
const minutos = (n) => new Date(T0 + n * 60000).toISOString();

const CONTACTO = { id: 'cus_rep', name: 'Pedro Reparto', phone: '8095550123' };

/** Pedido asignado a un repartidor EXTERNO en `assignedAt`. */
function pedido({ id = 'ord_1', numero = 'PE-100001', estado = 'confirmado', assignedAt = minutos(0), contacto = CONTACTO } = {}) {
  return {
    id,
    order_number: numero,
    status: estado,
    customer_id: 'cus_cliente',
    customer_name: 'Ana Pérez',
    currency: 'DOP',
    total: 1500,
    created_at: assignedAt,
    delivery: {
      delivery_assigned_at: assignedAt,
      external: {
        contact_id: contacto.id,
        contact_name: contacto.name,
        phone_e164: `+1${contacto.phone}`,
        status: COURIER_STATUS.SENT,
        assigned_at: assignedAt,
      },
    },
  };
}

/** Pedido asignado a un AGENTE INTERNO (aviso por campana). */
function pedidoInterno({ id = 'ord_int', numero = 'PE-200002', assignedAt = minutos(0) } = {}) {
  return {
    id,
    order_number: numero,
    status: 'confirmado',
    customer_id: 'cus_cliente',
    customer_name: 'Ana Pérez',
    currency: 'DOP',
    total: 900,
    created_at: assignedAt,
    delivery: { delivery_user_id: 'usr_del', delivery_user_name_snapshot: 'Carlos', delivery_status: 'PENDING_CONTACT', delivery_assigned_at: assignedAt },
  };
}

function mundo({ ordenes = [], supervisor = {} } = {}) {
  const world = {
    now: minutos(0),
    rows: ordenes.map((order) => ({ id: order.id, type: 'order_intent', status: order.status, orderJson: JSON.stringify(order) })),
    events: [],
    notifications: [],
    sends: [],
    texts: [],
    audits: [],
    settings: { delivery_supervisor: { activationMode: 'all', ...supervisor } },
  };
  const ctx = {
    clock: () => new Date(world.now),
    settings: {
      read: async (key) => (world.settings[key] ? { value: world.settings[key] } : key === 'delivery_contacts' ? { value: [CONTACTO] } : key === 'delivery_control' ? { value: { deliveryAdminEscalationContacts: [{ name: 'Jefa', phone: '8095559999' }] } } : null),
      write: async (key, value) => {
        world.settings[key] = value;
        return value;
      },
    },
    db: {
      async insert(name, doc) {
        if (name !== SUPERVISOR_EVENTS) return { duplicate: false, doc };
        if (doc.idempotency_key && world.events.some((entry) => entry.idempotency_key === doc.idempotency_key)) return { duplicate: true, doc };
        world.events.push(doc);
        return { duplicate: false, doc };
      },
      async findBy(name, field, value) {
        return name === SUPERVISOR_EVENTS ? world.events.find((entry) => entry[field] === value) ?? null : null;
      },
      async list(name) {
        return name === SUPERVISOR_EVENTS ? [...world.events] : [];
      },
      async update(name, id, patch) {
        if (name !== SUPERVISOR_EVENTS) return null;
        const index = world.events.findIndex((entry) => entry.id === id);
        if (index < 0) return null;
        world.events[index] = { ...world.events[index], ...patch };
        return world.events[index];
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
    users: { listUsers: async () => [{ id: 'usr_del', role: 'DELIVERY', active: true, display_name: 'Carlos' }], get: async () => ({ id: 'usr_del', display_name: 'Carlos' }) },
    customers: { get: async () => null, conversationFor: async () => ({ id: 'cnv_rep', last_inbound_at: minutos(0) }), canSendFreeText: () => true, recordOutbound: async () => null },
    whatsapp: {
      enabled: true,
      sendTemplate: vi.fn(async (to, payload) => {
        world.sends.push({ to, payload });
        return { ok: true, messageId: `wamid.${world.sends.length}` };
      }),
      sendText: vi.fn(async (to, body) => {
        world.texts.push({ to, body });
        return { ok: true, messageId: `wamid.T.${world.texts.length}` };
      }),
    },
    audit: { record: async (entry) => (world.audits.push(entry), entry) },
    proofreading: { interpret: async () => null },
  };
  const deps = {
    checkTemplate: async (name) => ({ ok: true, template: { name, language: 'es' } }),
    refreshTemplate: async () => null,
    orderDeepLink: (id) => `https://phytoemagryrd.lat/admin/?v=delivery&order=${id}`,
    notifyUser: async (input) => {
      world.notifications.push(input);
      return { duplicate: false, notification: { id: `not_${world.notifications.length}`, ...input } };
    },
    push: async () => null,
    users: [{ id: 'usr_del', role: 'DELIVERY', active: true, display_name: 'Carlos' }, { id: 'usr_admin', role: 'ADMIN', active: true, display_name: 'Jefa' }],
  };
  return { ctx, deps, world };
}

const eventos = (world, kind) => world.events.filter((entry) => entry.kind === kind);

describe('Supervisor IA: plazos configurados', () => {
  it('avisa al cumplirse el primer plazo y NO escala antes de tiempo', async () => {
    const { ctx, deps, world } = mundo({ ordenes: [pedido()], supervisor: { escalateAfterMinutes: 30 } });

    world.now = minutos(9);
    expect((await supervisorTick(ctx, deps)).reminders).toBe(0); // aún no toca

    world.now = minutos(11);
    const primero = await supervisorTick(ctx, deps);
    expect(primero.reminders).toBe(1);
    expect(world.sends).toHaveLength(1);
    expect(eventos(world, 'reminder')[0].status).toBe('sent');

    world.now = minutos(20);
    const antes = await supervisorTick(ctx, deps);
    expect(antes.escalations).toBe(0); // 20 < 30 min configurados
    expect(eventos(world, 'escalation')).toHaveLength(0);
  });

  it('escala a administración al cumplirse el plazo configurado, una sola vez', async () => {
    const { ctx, deps, world } = mundo({ ordenes: [pedido()], supervisor: { escalateAfterMinutes: 30, followUpMinutes: 60 } });
    world.now = minutos(11);
    await supervisorTick(ctx, deps); // primer aviso
    expect(eventos(world, 'escalation')).toHaveLength(0);

    world.now = minutos(31);
    const escalado = await supervisorTick(ctx, deps);
    expect(escalado.escalations).toBe(1);
    const escalamientos = eventos(world, 'escalation');
    expect(escalamientos).toHaveLength(1);
    expect(escalamientos[0].data.reason).toBe('overdue');
    expect(escalamientos[0].status).toBe('notified');
    expect(world.sends.some((entry) => entry.payload.name === 'phyto_delivery_sin_atender_admin_v1')).toBe(true);

    world.now = minutos(45);
    expect((await supervisorTick(ctx, deps)).escalations).toBe(0);
    expect(eventos(world, 'escalation')).toHaveLength(1);
    expect(eventos(world, 'escalation_whatsapp')).toHaveLength(1);
  });

  it('un pedido entregado antes del plazo no genera recordatorio ni escalado', async () => {
    const { ctx, deps, world } = mundo({ ordenes: [pedido({ estado: 'entregado' })], supervisor: { escalateAfterMinutes: 30 } });
    world.now = minutos(40);
    const r = await supervisorTick(ctx, deps);
    expect(r.reminders).toBe(0);
    expect(r.escalations).toBe(0);
    expect(world.sends).toHaveLength(0);
    expect(world.events.filter((entry) => entry.kind !== 'daily')).toHaveLength(0);
  });
});

describe('Supervisor IA: un solo aviso aunque haya dos pasadas', () => {
  it('dos pasadas simultáneas envían UN solo recordatorio (reserva atómica)', async () => {
    const { ctx, deps, world } = mundo({ ordenes: [pedido()] });
    world.now = minutos(15);
    const [a, b] = await Promise.all([supervisorTick(ctx, deps), supervisorTick(ctx, deps)]);
    expect(a.reminders + b.reminders).toBe(1);
    expect(world.sends).toHaveLength(1);
    expect(eventos(world, 'reminder')).toHaveLength(1);
  });

  it('tras reiniciar el servidor no se repite el aviso ya enviado', async () => {
    const { ctx, deps, world } = mundo({ ordenes: [pedido()] });
    world.now = minutos(15);
    await supervisorTick(ctx, deps);
    expect(world.sends).toHaveLength(1);
    // «Reinicio»: motor nuevo sobre la MISMA base (los eventos viven fuera).
    const { ctx: ctx2, deps: deps2 } = mundo({ ordenes: [pedido()] });
    ctx2.db = ctx.db;
    world.now = minutos(20);
    const tras = await supervisorTick(ctx2, deps2);
    expect(tras.reminders).toBe(0);
    expect(world.sends).toHaveLength(1);
  });

  it('el scheduler no se solapa consigo mismo', async () => {
    let liberar;
    const bloqueo = new Promise((resolve) => (liberar = resolve));
    let ejecuciones = 0;
    const scheduler = createScheduler({
      db: { list: async () => [], update: async () => ({}) },
      customers: {},
      whatsapp: {},
      deliverySupervisorTick: async () => {
        ejecuciones += 1;
        await bloqueo;
        return { reminders: 0 };
      },
    });
    const primera = scheduler.tick();
    const segunda = await scheduler.tick();
    expect(segunda.skipped).toBe('already_running');
    liberar();
    await primera;
    expect(ejecuciones).toBe(1);
  });
});

describe('Supervisor IA: cambios de estado y de repartidor', () => {
  it('un cambio de etapa cuenta aparte y no repite el aviso de la anterior', async () => {
    const { ctx, deps, world } = mundo({ ordenes: [pedido()], supervisor: { escalateAfterMinutes: 600 } });
    world.now = minutos(15);
    await supervisorTick(ctx, deps);
    expect(eventos(world, 'reminder')).toHaveLength(1);

    // El repartidor empieza la entrega: cambia la etapa (pending_start → in_transit).
    const fila = world.rows[0];
    const order = JSON.parse(fila.orderJson);
    order.delivery.external.status = COURIER_STATUS.IN_PROGRESS;
    order.delivery.external.started_at = minutos(16);
    fila.orderJson = JSON.stringify(order);

    world.now = minutos(20);
    const segundo = await supervisorTick(ctx, deps);
    expect(segundo.reminders).toBe(0); // su plazo de la etapa nueva aún no vence
    world.now = minutos(27);
    const tercero = await supervisorTick(ctx, deps);
    expect(tercero.reminders).toBe(1);
    expect(world.sends).toHaveLength(2);
    expect(eventos(world, 'reminder').map((entry) => entry.stage)).toEqual(['pending_start', 'in_transit']);
  });

  it('una reasignación avisa al repartidor nuevo y deja de escribir al anterior', async () => {
    const nuevo = { id: 'cus_rep2', name: 'María Reparto', phone: '8095557777' };
    const { ctx, deps, world } = mundo({ ordenes: [pedido()] });
    world.now = minutos(15);
    await supervisorTick(ctx, deps);
    expect(world.sends[0].to).toBe('+18095550123');

    const fila = world.rows[0];
    const order = JSON.parse(fila.orderJson);
    order.delivery.external = { contact_id: nuevo.id, contact_name: nuevo.name, phone_e164: `+1${nuevo.phone}`, status: COURIER_STATUS.SENT, assigned_at: minutos(16) };
    order.delivery.delivery_assigned_at = minutos(16);
    fila.orderJson = JSON.stringify(order);

    /*
     * El aviso siguiente ya está programado sobre el plazo; lo que cambia es a
     * QUIÉN se le manda. Se avanza al vencimiento para comprobarlo.
     */
    world.now = minutos(46);
    await supervisorTick(ctx, deps);
    const ultimo = world.sends.at(-1);
    expect(ultimo.to).toBe('+18095557777');
    expect(ultimo.payload.components[0].parameters[0].text).toBe('María Reparto');
  });
});

describe('Supervisor IA: webhooks y avisos internos', () => {
  it('un webhook duplicado del repartidor no responde dos veces', async () => {
    const { ctx, deps, world } = mundo({ ordenes: [pedido()] });
    world.now = minutos(5);
    const entrada = { waMessageId: 'wamid.DUP.1', fromE164: '+18095550123', text: { body: 'Voy en camino' } };
    const uno = await handleSupervisorReply({ ctx, deps, inbound: entrada, conversation: { id: 'cnv_rep', last_inbound_at: minutos(0) } });
    const dos = await handleSupervisorReply({ ctx, deps, inbound: entrada, conversation: { id: 'cnv_rep', last_inbound_at: minutos(0) } });
    expect(uno.handled).toBe(true);
    expect(dos.handled).toBe(true);
    expect(world.events.filter((entry) => entry.kind === 'started')).toHaveLength(1);
  });

  it('sin WhatsApp configurado el aviso interno igual llega y queda registrado', async () => {
    const { ctx, deps, world } = mundo({ ordenes: [pedidoInterno()] });
    ctx.whatsapp.enabled = false;
    world.now = minutos(15);
    const r = await supervisorTick(ctx, deps);
    expect(r.reminders).toBe(1);
    expect(world.notifications.some((entry) => entry.type === 'DELIVERY_SUPERVISOR_REMINDER')).toBe(true);
    expect(eventos(world, 'reminder')[0].status).toBe('notified');
  });

  it('deja constancia de la última pasada para el panel', async () => {
    const { ctx, deps, world } = mundo({ ordenes: [pedido()] });
    world.now = minutos(15);
    await supervisorTick(ctx, deps);
    expect(world.settings.delivery_supervisor_heartbeat.at).toBe(minutos(15));
    expect(world.settings.delivery_supervisor_heartbeat.reminders).toBe(1);
  });
});

/*
 * WHATSAPP REAL AL REPARTIDOR DEL CRM.
 *
 * El negocio se quejó de que al mensajero solo le llegaban notificaciones. Estas
 * pruebas fijan lo que ahora tiene que pasar: se le escribe por WhatsApp a su
 * teléfono (personal o flota) y, si la plantilla no está aprobada, se intenta el
 * texto libre dejando constancia del motivo real si Meta lo rechaza.
 */
describe('Supervisor IA: WhatsApp real al repartidor del CRM', () => {
  const conTelefono = [
    { id: 'usr_del', role: 'DELIVERY', active: true, display_name: 'Carlos', personal_phone: '+18095550123' },
    { id: 'usr_admin', role: 'ADMIN', active: true, display_name: 'Jefa' },
  ];

  it('escribe al teléfono personal del repartidor con cuenta en el CRM', async () => {
    const { ctx, deps, world } = mundo({ ordenes: [pedidoInterno()] });
    deps.users = conTelefono;
    ctx.users.listUsers = async () => conTelefono;
    world.now = minutos(11);

    const r = await supervisorTick(ctx, deps);
    expect(r.reminders).toBe(1);
    expect(world.sends).toHaveLength(1);
    expect(world.sends[0].to).toBe('+18095550123');
    const evento = eventos(world, 'reminder')[0];
    expect(evento.status).toBe('sent');
    expect(evento.data.channel).toBe('template');
    expect(evento.data.responsible).toBe('internal');
  });

  it('si el personal falta usa el teléfono de la flota', async () => {
    const { ctx, deps, world } = mundo({ ordenes: [pedidoInterno()] });
    deps.users = [{ id: 'usr_del', role: 'DELIVERY', active: true, display_name: 'Carlos', fleet_phone: '+18095550777' }];
    ctx.users.listUsers = async () => deps.users;
    world.now = minutos(11);
    await supervisorTick(ctx, deps);
    expect(world.sends[0].to).toBe('+18095550777');
  });

  it('sin plantilla aprobada intenta el texto libre y lo deja registrado', async () => {
    const { ctx, deps, world } = mundo({ ordenes: [pedidoInterno()] });
    deps.users = conTelefono;
    ctx.users.listUsers = async () => conTelefono;
    deps.checkTemplate = async () => ({ ok: false, reason: 'template_not_approved' });
    world.now = minutos(11);

    await supervisorTick(ctx, deps);
    expect(world.texts).toHaveLength(1);
    expect(world.texts[0].to).toBe('+18095550123');
    const evento = eventos(world, 'reminder')[0];
    expect(evento.status).toBe('sent');
    expect(evento.data.channel).toBe('text');
  });
});

describe('Supervisor IA: diagnóstico y chat', () => {
  it('dice qué falta: ningún repartidor tiene teléfono', async () => {
    const { ctx, deps } = mundo({ ordenes: [pedidoInterno()] });
    const diag = await supervisorDiagnostics(ctx, deps);
    expect(diag.ready).toBe(false);
    expect(diag.blockers.map((row) => row.code)).toContain('couriers_without_phone');
    expect(diag.blockers.map((row) => row.code)).toContain('orders_without_phone');
    expect(diag.orders.without_phone).toBe(1);

    const answer = supervisorAnswer(diag, '¿por qué no le escribes al repartidor?');
    expect(answer.topic).toBe('whatsapp');
    expect(answer.answer).toContain('teléfono');
  });

  it('con teléfono, WhatsApp y plantilla listos responde que puede escribir', async () => {
    const { ctx, deps } = mundo({ ordenes: [pedidoInterno()] });
    deps.users = [{ id: 'usr_del', role: 'DELIVERY', active: true, display_name: 'Carlos', personal_phone: '+18095550123' }];
    ctx.users.listUsers = async () => deps.users;
    const diag = await supervisorDiagnostics(ctx, deps);
    expect(diag.ready).toBe(true);
    expect(diag.blockers).toHaveLength(0);
    expect(diag.couriers[0].has_phone).toBe(true);
    expect(diag.couriers[0].personal).toBe('***0123');

    const answer = supervisorAnswer(diag, '¿me puedes escribir por WhatsApp?');
    expect(answer.topic).toBe('whatsapp');
    expect(answer.answer).toContain('Sí estoy enviando');
  });

  it('avisa cuando el supervisor está apagado o fuera de horario', async () => {
    const { ctx, deps, world } = mundo({ ordenes: [pedidoInterno()], supervisor: { enabled: false } });
    const diag = await supervisorDiagnostics(ctx, deps);
    expect(diag.blockers.map((row) => row.code)).toContain('supervisor_off');
    expect(supervisorAnswer(diag, '¿estás activo?').topic).toBe('settings');

    world.now = '2026-10-20T02:00:00.000Z'; // 22:00 en RD
    const tarde = await supervisorDiagnostics(ctx, deps);
    expect(tarde.blockers.map((row) => row.code)).toContain('out_of_hours');
    expect(supervisorAnswer(tarde, '¿a qué hora escribes?').topic).toBe('schedule');
  });
});
