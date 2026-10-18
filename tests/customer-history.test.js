// @vitest-environment node
/**
 * HISTORIAL 360°: la línea de tiempo se arma LEYENDO los módulos existentes.
 * Lo que se comprueba aquí:
 *   · cada movimiento trae fecha, tipo, resumen y referencia a su registro,
 *   · el orden es del más reciente al más antiguo,
 *   · las notas internas no salen sin permiso,
 *   · no se inventan eventos ni se mezclan clientes,
 *   · una fuente que falla no tumba el historial.
 */
import { describe, expect, it } from 'vitest';
import { buildCustomerHistory } from '../server/history.mjs';

const orders = [
  {
    id: 'o1',
    customer_id: 'c1',
    number: 'PE-1',
    status: 'entregado',
    created_at: '2026-10-18T10:20:00Z',
    updated_at: '2026-10-18T12:15:00Z',
    items: [{ name: 'Cámara IP', quantity: 2 }],
  },
];

function fakeDb(rows = {}) {
  const lists = {
    wa_messages: [],
    pos_documents: [],
    followups: [],
    delivery_tracking_sessions: [],
    order_pickups: [],
    supplier_invoices: [],
    warranty_claims: [],
    ...rows,
  };
  return { list: async (name) => lists[name] ?? [] };
}

const db = fakeDb({
  wa_messages: [
    { id: 'm1', customer_id: 'c1', direction: 'inbound', body: 'Hola, precio?', created_at: '2026-10-18T10:00:00Z', conversation_id: 'cv1' },
    { id: 'm2', customer_id: 'c1', direction: 'outbound', body: 'Te envío la cotización', created_at: '2026-10-18T10:05:00Z', conversation_id: 'cv1', status: 'sent' },
    { id: 'm9', customer_id: 'c2', direction: 'inbound', body: 'Otro cliente', created_at: '2026-10-18T11:00:00Z' },
  ],
  pos_documents: [
    { id: 'q1', customer_id: 'c1', kind: 'quote', number: 'COT-1', total_cents: 100000, created_at: '2026-10-18T10:15:00Z', status: 'sent' },
    { id: 'i1', customer_id: 'c1', kind: 'invoice', number: 'FAC-1', total_cents: 100000, created_at: '2026-10-18T12:00:00Z', status: 'issued' },
  ],
  followups: [
    { id: 'f1', customer_id: 'c1', status: 'completed', scheduled_at: '2026-10-18T13:00:00Z', title: 'Llamar' },
  ],
  delivery_tracking_sessions: [
    { id: 'd1', customer_id: 'c1', status: 'ended', started_at: '2026-10-18T11:30:00Z', ended_at: '2026-10-18T12:10:00Z', order_id: 'o1', delivery_user_id: 'u1' },
  ],
  order_pickups: [
    { id: 'p1', customer_id: 'c1', order_id: 'o1', supplier_name: 'Ferretería Central', quantity: 3, status: 'purchased', created_at: '2026-10-18T11:00:00Z' },
  ],
  supplier_invoices: [
    { id: 'si1', customer_id: 'c1', order_id: 'o1', supplier_name: 'Ferretería Central', invoice_number: 'FC-88', attached: true, purchased_at: '2026-10-18T11:10:00Z' },
  ],
  warranty_claims: [
    { id: 'w1', customer_id: 'c1', order_id: 'o1', status: 'abierta', product_name: 'Cámara IP', created_at: '2026-10-18T14:00:00Z' },
  ],
});

describe('historial del cliente', () => {
  it('junta mensajes, documentos, pedido, entrega, compra, factura de proveedor y garantía', async () => {
    const history = await buildCustomerHistory({ db, customerId: 'c1', orders, includeInternal: true });
    const tipos = history.map((row) => row.type);
    expect(tipos).toContain('message_in');
    expect(tipos).toContain('message_out');
    expect(tipos).toContain('quote');
    expect(tipos).toContain('invoice');
    expect(tipos).toContain('order');
    expect(tipos).toContain('delivery');
    expect(tipos).toContain('followup');
    expect(tipos).toContain('pickup');
    expect(tipos).toContain('supplier_invoice');
    expect(tipos).toContain('warranty');
  });

  it('sale del más reciente al más antiguo', async () => {
    const history = await buildCustomerHistory({ db, customerId: 'c1', orders, includeInternal: true });
    const fechas = history.map((row) => row.at);
    expect(fechas).toEqual([...fechas].sort().reverse());
  });

  it('no mezcla movimientos de otros clientes', async () => {
    const history = await buildCustomerHistory({ db, customerId: 'c1', orders, includeInternal: true });
    expect(history.some((row) => row.detail === 'Otro cliente')).toBe(false);
    // Un pedido de otro cliente tampoco entra.
    const otros = await buildCustomerHistory({
      db,
      customerId: 'c1',
      orders: [{ id: 'o2', customer_id: 'c2', number: 'PE-2', status: 'nuevo', created_at: '2026-10-18T09:00:00Z' }],
      includeInternal: true,
    });
    expect(otros.some((row) => row.type === 'order')).toBe(false);
  });

  it('sin permiso, las notas internas (seguimientos, compras, garantías) no salen', async () => {
    const history = await buildCustomerHistory({ db, customerId: 'c1', orders });
    const tipos = history.map((row) => row.type);
    expect(tipos).not.toContain('followup');
    expect(tipos).not.toContain('pickup');
    expect(tipos).not.toContain('warranty');
    expect(tipos).not.toContain('supplier_invoice');
    expect(tipos).toContain('message_in');
    expect(tipos).toContain('order');
  });

  it('cada evento apunta a su registro original', async () => {
    const history = await buildCustomerHistory({ db, customerId: 'c1', orders, includeInternal: true });
    const message = history.find((row) => row.type === 'message_in');
    expect(message.ref).toEqual({ kind: 'conversation', id: 'cv1', messageId: 'm1' });
    const order = history.find((row) => row.type === 'order');
    expect(order.ref).toEqual({ kind: 'order', id: 'o1' });
    expect(order.title).toMatch(/PE-1/);
    const invoice = history.find((row) => row.type === 'invoice');
    expect(invoice.ref.id).toBe('i1');
  });

  it('un cliente sin movimientos devuelve una lista vacía (no inventa nada)', async () => {
    const history = await buildCustomerHistory({ db, customerId: 'c3', orders: [] });
    expect(history).toEqual([]);
  });

  it('una fuente rota no rompe el historial', async () => {
    const roto = { list: async (name) => { if (name === 'wa_messages') throw new Error('boom'); return []; } };
    const history = await buildCustomerHistory({ db: roto, customerId: 'c1', orders });
    expect(Array.isArray(history)).toBe(true);
    expect(history.some((row) => row.type === 'order')).toBe(true);
  });
});
