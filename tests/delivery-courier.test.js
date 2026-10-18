import { describe, expect, it, vi } from 'vitest';
import {
  COURIER_STATUS,
  COURIER_TEMPLATE,
  assignCourier,
  buildCourierPayload,
  handleCourierInbound,
  normalizeCourierContact,
  parseCourierIntent,
  savedCourierContacts,
  sendOrderToCourier,
} from '../server/delivery-courier.mjs';

/* ------------------------------------------------------------------ utilidades */

const COURIER = { id: 'cus_courier', name: 'Mensajero Pedro', phone: '8095550123', concept: 'Mensajería' };
const CUSTOMER = { id: 'cus_cliente', name: 'Ana Pérez', phone_e164: '+18095550100' };

const order = (extra = {}) => ({
  id: 'ord_1',
  order_number: 'PE-123456',
  status: 'confirmado',
  customer_id: CUSTOMER.id,
  currency: 'DOP',
  total: 1500,
  notes: 'Casa verde, portón negro',
  items: [
    { variantId: 'p1', name: 'Frasco 30 cápsulas', quantity: 2 },
    { variantId: 'p2', name: 'Frasco 60 cápsulas', quantity: 1 },
  ],
  delivery: {
    location: { latitude: 18.4861, longitude: -69.9312, address: 'Calle Duarte 12, Santo Domingo' },
    external: { contact_id: 'cus_courier', contact_name: 'Mensajero Pedro', phone_e164: '+18095550123', status: COURIER_STATUS.ASSIGNED },
  },
  ...extra,
});

/** Contexto falso: registra lo que pasa y no toca ninguna base real. */
function makeCtx({ contacts = [COURIER], orders = [], template = { ok: true, template: { name: COURIER_TEMPLATE, language: 'es' } }, send = { ok: true, messageId: 'wamid.TEST.1' } } = {}) {
  const state = { orders: orders.map((row) => ({ ...row })), sent: [], texts: [], audits: [], updates: [], recorded: [] };
  const ctx = {
    clock: () => new Date('2026-10-18T10:00:00.000Z'),
    settings: { read: async (key) => (key === 'delivery_contacts' ? { value: contacts } : null) },
    whatsapp: {
      enabled: true,
      sendTemplate: vi.fn(async (to, payload) => {
        state.sent.push({ to, payload });
        return send;
      }),
      sendText: vi.fn(async (to, body) => {
        state.texts.push({ to, body });
        return { ok: true, messageId: 'wamid.TEXT.1' };
      }),
    },
    customers: {
      get: async (id) => (id === COURIER.id ? { id: COURIER.id, phone_e164: '+18095550123' } : id === CUSTOMER.id ? CUSTOMER : null),
      conversationFor: async () => ({ id: 'cnv_courier' }),
      canSendFreeText: () => true,
      recordOutbound: async (input) => {
        state.recorded.push(input);
        return { id: 'msg_1' };
      },
    },
    store: {
      listAdmin: async () => state.orders,
      update: async (id, patch) => {
        state.updates.push({ id, patch });
        const row = state.orders.find((entry) => entry.id === id);
        if (row && patch.orderJson) state.orders = state.orders.map((entry) => (entry.id === id ? { ...entry, orderJson: patch.orderJson } : entry));
        return row ?? null;
      },
    },
    audit: {
      record: async (entry) => {
        state.audits.push(entry);
        return entry;
      },
    },
  };
  return { ctx, state, checkTemplate: async () => template };
}

const row = (value) => ({ id: value.id, type: 'order_intent', status: value.status, orderJson: JSON.stringify(value) });
const inbound = (body, extra = {}) => ({ waMessageId: 'wamid.IN.1', fromE164: '+18095550123', text: body ? { body } : undefined, ...extra });

/* --------------------------------------------------------------------- pruebas */

describe('contactos de reparto', () => {
  it('limpia el teléfono y respeta el permiso de compartir pedidos', () => {
    expect(normalizeCourierContact({ name: '  Pedro  ', phone: '809-555-0123' })).toMatchObject({
      name: 'Pedro',
      phone: '+18095550123',
      shareOrders: true,
    });
    expect(normalizeCourierContact({ phone: '8095550123', shareOrders: false })?.shareOrders).toBe(false);
    expect(normalizeCourierContact({ phone: '123' })).toBeNull();
  });

  it('descarta duplicados por teléfono', () => {
    const list = savedCourierContacts([
      { name: 'Pedro', phone: '8095550123' },
      { name: 'Pedro repetido', phone: '+18095550123' },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Pedro');
  });
});

describe('interpretación de la respuesta', () => {
  it('entiende los botones de la plantilla', () => {
    expect(parseCourierIntent({ button: { payload: 'INICIAR_ENTREGA' } })).toBe('start');
    expect(parseCourierIntent({ button: { payload: 'ENTREGADO' } })).toBe('delivered');
    expect(parseCourierIntent({ button: { payload: 'PROBLEMA' } })).toBe('issue');
  });

  it('entiende el texto y los números', () => {
    expect(parseCourierIntent({ text: { body: 'Ya salgo para allá' } })).toBe('start');
    expect(parseCourierIntent({ text: { body: 'Entregado' } })).toBe('delivered');
    expect(parseCourierIntent({ text: { body: '1' } })).toBe('start');
    expect(parseCourierIntent({ text: { body: '3' } })).toBe('issue');
  });

  it('NO confunde una negación con una entrega', () => {
    // «No entregado, el cliente no estaba» es un problema, no una entrega.
    expect(parseCourierIntent({ text: { body: 'No entregado, el cliente no estaba' } })).toBe('issue');
    // «todavía no entregué» es ambiguo: no cambia NADA (mejor no adivinar).
    expect(parseCourierIntent({ text: { body: 'todavía no entregué' } })).toBeNull();
  });
});

describe('enviar el pedido al repartidor', () => {
  it('envía con los datos mínimos y deja el pedido marcado como enviado', async () => {
    const o = order();
    const { ctx, state, checkTemplate } = makeCtx({ orders: [row(o)] });
    const result = await sendOrderToCourier({ ctx, item: row(o), order: o, actor: { id: 'u1', display_name: 'Vendedor' }, checkTemplate });

    expect(result.ok).toBe(true);
    expect(state.sent).toHaveLength(1);
    const { to, payload } = state.sent[0];
    expect(to).toBe('+18095550123');
    expect(payload.name).toBe(COURIER_TEMPLATE);
    const params = payload.components[0].parameters.map((p) => p.text);
    expect(params[1]).toBe('PE-123456');
    expect(params[3]).toContain('Frasco 30 cápsulas');
    expect(params[6]).toContain('maps.google.com');
    // El pedido queda con estado enviado y el id del mensaje.
    const saved = JSON.parse(state.orders[0].orderJson);
    expect(saved.delivery.external.status).toBe(COURIER_STATUS.SENT);
    expect(saved.delivery.external.wa_message_id).toBe('wamid.TEST.1');
    // Queda registrado en el hilo y auditado.
    expect(state.recorded[0].template).toBe(COURIER_TEMPLATE);
    expect(state.audits.some((a) => a.action === 'order.courier_sent')).toBe(true);
  });

  it('no envía dos veces sin pedirlo expresamente', async () => {
    const o = order();
    o.delivery.external = { ...o.delivery.external, status: COURIER_STATUS.SENT, wa_message_id: 'wamid.OLD' };
    const { ctx, state, checkTemplate } = makeCtx({ orders: [row(o)] });
    const result = await sendOrderToCourier({ ctx, item: row(o), order: o, checkTemplate });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('already_sent');
    expect(state.sent).toHaveLength(0);

    const again = await sendOrderToCourier({ ctx, item: row(o), order: o, checkTemplate, resend: true });
    expect(again.ok).toBe(true);
    expect(state.sent).toHaveLength(1);
  });

  it('se niega si el número no está guardado como repartidor', async () => {
    const o = order();
    const { ctx, state, checkTemplate } = makeCtx({ contacts: [], orders: [row(o)] });
    const result = await sendOrderToCourier({ ctx, item: row(o), order: o, checkTemplate });
    expect(result.error).toBe('contact_not_saved');
    expect(state.sent).toHaveLength(0);
  });

  it('se niega si el contacto tiene desactivado recibir pedidos', async () => {
    const o = order();
    const { ctx, state, checkTemplate } = makeCtx({ contacts: [{ ...COURIER, shareOrders: false }], orders: [row(o)] });
    const result = await sendOrderToCourier({ ctx, item: row(o), order: o, checkTemplate });
    expect(result.error).toBe('contact_sharing_disabled');
    expect(state.sent).toHaveLength(0);
  });

  it('se niega si el teléfono es del propio cliente', async () => {
    const o = order();
    o.delivery.external = { ...o.delivery.external, phone_e164: CUSTOMER.phone_e164 };
    const { ctx, state, checkTemplate } = makeCtx({ contacts: [{ ...COURIER, phone: CUSTOMER.phone_e164 }], orders: [row(o)] });
    const result = await sendOrderToCourier({ ctx, item: row(o), order: o, checkTemplate });
    expect(result.error).toBe('contact_is_customer');
    expect(state.sent).toHaveLength(0);
  });

  it('se niega sin dirección de entrega', async () => {
    const o = order({ delivery: { external: { contact_id: 'cus_courier', phone_e164: '+18095550123' } } });
    const { ctx, state, checkTemplate } = makeCtx({ orders: [row(o)] });
    const result = await sendOrderToCourier({ ctx, item: row(o), order: o, checkTemplate });
    expect(result.error).toBe('missing_destination');
    expect(state.sent).toHaveLength(0);
  });

  it('NO envía si la plantilla no está aprobada por Meta', async () => {
    const o = order();
    const { ctx, state, checkTemplate } = makeCtx({ orders: [row(o)], template: { ok: false, reason: 'template_not_approved' } });
    const result = await sendOrderToCourier({ ctx, item: row(o), order: o, checkTemplate });
    expect(result.error).toBe('template_not_approved');
    expect(state.sent).toHaveLength(0);
  });

  it('no envía un pedido cerrado', async () => {
    const o = order({ status: 'entregado' });
    const { ctx, checkTemplate } = makeCtx({ orders: [row(o)] });
    const result = await sendOrderToCourier({ ctx, item: row(o), order: o, checkTemplate });
    expect(result.error).toBe('order_closed');
  });
});

describe('asignar repartidor externo', () => {
  it('guarda el contacto elegido y vuelve a «asignado»', async () => {
    const o = order({ delivery: {} });
    const { ctx, state } = makeCtx({ orders: [row(o)] });
    const result = await assignCourier({ ctx, item: row(o), order: o, contactPhone: '8095550123', actor: { id: 'u1', display_name: 'Ana' } });
    expect(result.ok).toBe(true);
    expect(result.courier.status).toBe(COURIER_STATUS.ASSIGNED);
    expect(state.audits[0].action).toBe('order.courier_assigned');
  });

  it('rechaza un número que no está guardado', async () => {
    const o = order({ delivery: {} });
    const { ctx } = makeCtx({ contacts: [], orders: [row(o)] });
    const result = await assignCourier({ ctx, item: row(o), order: o, contactPhone: '8095559999' });
    expect(result.error).toBe('contact_not_saved');
  });
});

describe('respuestas del repartidor', () => {
  const completeDelivery = () => vi.fn(async () => ({ ok: true }));

  it('ignora mensajes de números que no son repartidores guardados', async () => {
    const { ctx, state } = makeCtx({ orders: [row(order())] });
    const finish = completeDelivery();
    const result = await handleCourierInbound({ ctx, inbound: inbound('Entregado', { fromE164: '+18090000000' }), completeDelivery: finish });
    expect(result.handled).toBe(false);
    expect(finish).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });

  it('«Entregado» pide confirmación y NO cierra el pedido', async () => {
    const o = order();
    const { ctx, state } = makeCtx({ orders: [row(o)] });
    const finish = completeDelivery();
    const result = await handleCourierInbound({ ctx, inbound: inbound('Entregado'), completeDelivery: finish });
    expect(result.reason).toBe('awaiting_confirmation');
    expect(finish).not.toHaveBeenCalled();
    const saved = JSON.parse(state.orders[0].orderJson);
    expect(saved.delivery.external.status).toBe(COURIER_STATUS.AWAITING_CONFIRMATION);
    expect(state.texts[0].body).toContain('CONFIRMAR');
  });

  it('«CONFIRMAR» sin haber reportado no cierra nada', async () => {
    const { ctx } = makeCtx({ orders: [row(order())] });
    const finish = completeDelivery();
    const result = await handleCourierInbound({ ctx, inbound: inbound('CONFIRMAR'), completeDelivery: finish });
    expect(result.reason).toBe('confirm_without_report');
    expect(finish).not.toHaveBeenCalled();
  });

  it('reportar + confirmar ejecuta la transición oficial UNA vez', async () => {
    const o = order();
    o.delivery.external = { ...o.delivery.external, status: COURIER_STATUS.AWAITING_CONFIRMATION };
    const { ctx, state } = makeCtx({ orders: [row(o)] });
    const finish = completeDelivery();
    const result = await handleCourierInbound({ ctx, inbound: inbound('CONFIRMAR'), completeDelivery: finish });
    expect(result.reason).toBe('delivered');
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0][0]).toBe('ord_1');
    const saved = JSON.parse(state.orders[0].orderJson);
    expect(saved.delivery.external.status).toBe(COURIER_STATUS.DELIVERED);
  });

  it('con dos pedidos abiertos no adivina: pide el número', async () => {
    const a = order();
    const b = order({ id: 'ord_2', order_number: 'PE-999999' });
    const { ctx, state } = makeCtx({ orders: [row(a), row(b)] });
    const finish = completeDelivery();
    const result = await handleCourierInbound({ ctx, inbound: inbound('Entregado'), completeDelivery: finish });
    expect(result.reason).toBe('ambiguous');
    expect(finish).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
    expect(state.texts[0].body).toContain('PE-123456');
  });

  it('con dos pedidos abiertos y el número en el texto, acierta el correcto', async () => {
    const a = order();
    const b = order({ id: 'ord_2', order_number: 'PE-999999' });
    const { ctx, state } = makeCtx({ orders: [row(a), row(b)] });
    const finish = completeDelivery();
    const result = await handleCourierInbound({ ctx, inbound: inbound('Entregado PE-999999'), completeDelivery: finish });
    expect(result.orderId).toBe('ord_2');
    const bSaved = JSON.parse(state.orders.find((r) => r.id === 'ord_2').orderJson);
    expect(bSaved.delivery.external.status).toBe(COURIER_STATUS.AWAITING_CONFIRMATION);
    const aSaved = JSON.parse(state.orders.find((r) => r.id === 'ord_1').orderJson);
    expect(aSaved.delivery.external.status).toBe(COURIER_STATUS.ASSIGNED);
  });

  it('«iniciar entrega» solo marca el envío en curso (no cambia el estado del pedido)', async () => {
    const o = order();
    const { ctx, state } = makeCtx({ orders: [row(o)] });
    const result = await handleCourierInbound({ ctx, inbound: inbound('Ya salgo'), completeDelivery: completeDelivery() });
    expect(result.reason).toBe('started');
    const saved = JSON.parse(state.orders[0].orderJson);
    expect(saved.delivery.external.status).toBe(COURIER_STATUS.IN_PROGRESS);
    expect(saved.status).toBe('confirmado');
  });

  it('un problema del repartidor no cierra el pedido', async () => {
    const o = order();
    const { ctx, state } = makeCtx({ orders: [row(o)] });
    const finish = completeDelivery();
    const result = await handleCourierInbound({ ctx, inbound: inbound('No pude entregar, nadie estaba'), completeDelivery: finish });
    expect(result.reason).toBe('issue');
    expect(finish).not.toHaveBeenCalled();
    const saved = JSON.parse(state.orders[0].orderJson);
    expect(saved.delivery.external.status).toBe(COURIER_STATUS.ISSUE);
    expect(saved.status).toBe('confirmado');
  });

  it('no toca pedidos de otro repartidor', async () => {
    const o = order();
    o.delivery.external = { ...o.delivery.external, phone_e164: '+18095559999' };
    const { ctx, state } = makeCtx({ orders: [row(o)] });
    const finish = completeDelivery();
    const result = await handleCourierInbound({ ctx, inbound: inbound('Entregado'), completeDelivery: finish });
    expect(result.handled).toBe(false);
    expect(finish).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });
});

describe('datos que viajan al repartidor', () => {
  it('incluye lo necesario y nada más', () => {
    const payload = buildCourierPayload({
      order: order(),
      customer: CUSTOMER,
      contact: normalizeCourierContact(COURIER),
      destination: { latitude: 18.4861, longitude: -69.9312, address: 'Calle Duarte 12' },
    });
    expect(payload.variables).toHaveLength(8);
    expect(payload.text).toContain('PE-123456');
    expect(payload.text).not.toContain('historial');
    // Dirección sí, pero sin datos internos del cliente.
    expect(payload.text).not.toContain('total_spent');
    expect(payload.text.length).toBeLessThanOrEqual(2000);
  });
});
