// @vitest-environment node
/**
 * BUS DE EVENTOS DEL CRM.
 *
 * Lo que se comprueba:
 *   · solo se publican cambios CONFIRMADOS (2xx) y de tipos conocidos,
 *   · el evento no lleva datos privados (ni teléfono, ni importes, ni el hilo),
 *   · cada quien recibe solo lo suyo (permiso + ser el repartidor),
 *   · el cursor reenvía lo perdido y no repite lo ya visto,
 *   · el mismo dispositivo que hizo el cambio no se lo repite a sí mismo.
 */
import { describe, expect, it } from 'vitest';
import { clientAccepts, createRealtimeHub, eventFromMutation } from '../server/realtime.mjs';

const order = { id: 'order_1', status: 'enviado', delivery: { delivery_user_id: 'user_rep' } };

describe('qué se publica', () => {
  it('el alta de un pedido avisa una vez, con su id', () => {
    const events = eventFromMutation({
      method: 'POST',
      route: '/api/admin/orders',
      status: 201,
      body: { ok: true, order },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'order.created', entity: { kind: 'order', id: 'order_1' } });
  });

  it('un cambio de estado dice de qué pedido y cuál es el estado', () => {
    const [event] = eventFromMutation({
      method: 'PATCH',
      route: '/api/admin/orders/order_1/status',
      status: 200,
      body: { ok: true, order: { ...order, status: 'entregado' } },
    });
    expect(event.type).toBe('order.status_changed');
    expect(event.data.status).toBe('entregado');
  });

  it('un error NO avisa a nadie', () => {
    expect(eventFromMutation({ method: 'PATCH', route: '/api/admin/orders/order_1/status', status: 422, body: { ok: false } })).toEqual([]);
    expect(eventFromMutation({ method: 'POST', route: '/api/admin/orders', status: 500, body: { ok: false } })).toEqual([]);
  });

  it('una lectura no avisa', () => {
    expect(eventFromMutation({ method: 'GET', route: '/api/admin/orders/order_1', status: 200, body: { ok: true, order } })).toEqual([]);
  });

  it('el asignar repartidor se marca como evento de una sola persona', () => {
    const [event] = eventFromMutation({
      method: 'POST',
      route: '/api/admin/orders/order_1/delivery/assign',
      status: 200,
      body: { ok: true, order },
    });
    expect(event.type).toBe('order.assigned');
    expect(event.audience).toBe('assignee');
    expect(event.data.delivery_user_id).toBe('user_rep');
  });

  it('cobros y rendiciones se distinguen', () => {
    const [cobro] = eventFromMutation({
      method: 'POST',
      route: '/api/admin/orders/order_1/payments',
      status: 200,
      body: { ok: true, order, payment: { status: 'paid' } },
    });
    const [rendicion] = eventFromMutation({
      method: 'POST',
      route: '/api/admin/orders/order_1/payments/handover',
      status: 200,
      body: { ok: true, order },
    });
    expect(cobro.type).toBe('payment.recorded');
    expect(cobro.data.payment_status).toBe('paid');
    expect(rendicion.type).toBe('payment.handover_recorded');
  });

  it('el evento no arrastra teléfono ni importes', () => {
    const [event] = eventFromMutation({
      method: 'POST',
      route: '/api/admin/orders',
      status: 201,
      body: { ok: true, order: { ...order, customer: { phone_e164: '+18095551234' }, total: 2500 } },
    });
    const texto = JSON.stringify(event);
    expect(texto).not.toContain('18095551234');
    expect(texto).not.toContain('2500');
    expect(event.data).not.toHaveProperty('total');
  });

  it('inventario y supervisor también avisan', () => {
    const [inv] = eventFromMutation({
      method: 'POST',
      route: '/api/admin/inventory/adjust',
      status: 200,
      body: { ok: true, product: { id: 'product_1' } },
    });
    const [sup] = eventFromMutation({
      method: 'POST',
      route: '/api/admin/delivery-supervisor/run',
      status: 200,
      body: { ok: true, result: { reminders: 2 } },
    });
    expect(inv.type).toBe('inventory.changed');
    expect(sup.type).toBe('supervisor.changed');
  });

  /*
   * LA FINALIZACIÓN QUE HACE EL REPARTIDOR.
   *
   * La app no cierra la entrega por `/orders/:id/finish`: usa la sesión de
   * seguimiento (`/delivery-tracking/:sesion/complete`). Si esta ruta no se
   * traduce, administración y Supervisor se quedan con la entrega «en camino»
   * hasta recargar: por eso se fija aquí, con el pedido tomado de la SESIÓN y no
   * de la URL (en la URL va el id del seguimiento).
   */
  it('cerrar la sesión de seguimiento avisa del pedido de esa sesión', () => {
    const cerrada = {
      ok: true,
      session: { id: 'dts_1', order_id: 'order_1', delivery_user_id: 'user_rep', status: 'COMPLETED' },
      order: { id: 'order_1', status: 'entregado' },
    };
    const [fin] = eventFromMutation({
      method: 'POST',
      route: '/api/admin/delivery-tracking/dts_1/complete',
      status: 200,
      body: cerrada,
    });
    expect(fin).toMatchObject({
      type: 'delivery.completed',
      entity: { kind: 'order', id: 'order_1' },
      audience: 'assignee',
      requires: null,
    });
    expect(fin.data.delivery_user_id).toBe('user_rep');
    // Detener el seguimiento sin entregar NO puede parecer una entrega hecha.
    const [parada] = eventFromMutation({
      method: 'POST',
      route: '/api/admin/delivery-tracking/dts_1/stop',
      status: 200,
      body: { ...cerrada, session: { ...cerrada.session, status: 'CANCELLED' } },
    });
    expect(parada.type).toBe('order.updated');
    // Sin el pedido de la sesión no se publica nada (nunca un evento sin destino).
    expect(
      eventFromMutation({
        method: 'POST',
        route: '/api/admin/delivery-tracking/dts_1/complete',
        status: 200,
        body: { ok: true, session: { id: 'dts_1', status: 'COMPLETED' } },
      }),
    ).toEqual([]);
  });
});

describe('quién recibe qué', () => {
  const admin = { actor: { id: 'user_admin', role: 'ADMIN' }, can: () => true };
  const rep = { actor: { id: 'user_rep', role: 'DELIVERY' }, can: (p) => p === 'orders.read' };
  const otro = { actor: { id: 'user_otro', role: 'AGENT' }, can: (p) => p === 'orders.read' };
  const sinPermiso = { actor: { id: 'user_x', role: 'AGENT' }, can: () => false };

  const asignado = {
    type: 'order.assigned',
    requires: 'orders.read',
    audience: 'assignee',
    data: { orderId: 'order_1', delivery_user_id: 'user_rep' },
  };

  it('administración ve todo; el repartidor ve lo suyo; otro agente no', () => {
    expect(clientAccepts(asignado, admin)).toBe(true);
    expect(clientAccepts(asignado, rep)).toBe(true);
    expect(clientAccepts(asignado, otro)).toBe(false);
  });

  it('sin permiso no llega nada', () => {
    expect(clientAccepts({ ...asignado, audience: 'panel' }, sinPermiso)).toBe(false);
  });

  it('un evento general sí llega a quien tiene el permiso', () => {
    expect(clientAccepts({ type: 'order.updated', requires: 'orders.read', audience: 'panel', data: {} }, otro)).toBe(true);
  });
});

describe('reanudar sin perder ni repetir', () => {
  const evento = (id) => ({ type: 'order.updated', entity: { kind: 'order', id }, data: { orderId: id }, requires: 'orders.read' });

  it('el cursor reenvía lo perdido y solo lo posterior', () => {
    const hub = createRealtimeHub();
    hub.publish(evento('a'));
    const segundo = hub.publish(evento('b'))[0];
    expect(hub.replay(segundo.seq)).toEqual([]);
    expect(hub.replay(segundo.seq - 1).map((e) => e.data.orderId)).toEqual(['b']);
    expect(hub.replay(0)).toEqual([]);
  });

  it('lo reenviado conserva el número de secuencia', () => {
    const hub = createRealtimeHub();
    hub.publish(evento('a'));
    const [second] = hub.publish(evento('b'));
    const reenviado = hub.replay(second.seq - 1);
    expect(reenviado).toHaveLength(1);
    expect(reenviado[0].seq).toBe(second.seq);
  });

  it('el mismo dispositivo no se repite su propio cambio', () => {
    const hub = createRealtimeHub();
    const recibidos = [];
    hub.subscribe({
      actor: { id: 'user_admin', role: 'ADMIN' },
      can: () => true,
      origin: 'dev_a',
      send: (chunk) => recibidos.push(chunk),
    });
    hub.publish({ ...evento('a'), origin: 'dev_a' });
    expect(recibidos).toHaveLength(0);
    hub.publish({ ...evento('b'), origin: 'dev_b' });
    expect(recibidos).toHaveLength(1);
  });

  it('al suscribirse con cursor llega lo perdido', () => {
    const hub = createRealtimeHub();
    hub.publish(evento('a'));
    const [segundo] = hub.publish(evento('b'));
    const recibidos = [];
    hub.subscribe({
      actor: { id: 'user_admin', role: 'ADMIN' },
      can: () => true,
      since: segundo.seq - 1,
      send: (chunk) => recibidos.push(chunk),
    });
    expect(recibidos).toHaveLength(1);
    expect(recibidos[0]).toContain('order.updated');
  });

  it('el búfer no crece sin fin', () => {
    const hub = createRealtimeHub({ bufferSize: 3 });
    for (let i = 0; i < 10; i += 1) hub.publish(evento(`o${i}`));
    expect(hub.stats().buffered).toBe(3);
    expect(hub.stats().seq).toBe(10);
  });

  it('un tipo desconocido se ignora (no se inventan eventos)', () => {
    const hub = createRealtimeHub();
    expect(hub.publish({ type: 'inventado', data: {} })).toEqual([]);
    expect(hub.stats().seq).toBe(0);
  });
});
