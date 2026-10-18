// @vitest-environment node
/**
 * VENTA CON TIENDAS PROVEEDORAS Y RECOGIDAS POR PEDIDO.
 *
 * Lo que se comprueba:
 *   · la línea del carrito CONSERVA la tienda elegida al convertirse en pedido,
 *   · dos artículos de la misma tienda son UNA recogida; de tiendas distintas, dos,
 *   · volver a calcular las recogidas no las duplica (idempotencia),
 *   · la recogida queda ligada al cliente (para el historial 360°).
 */
import { describe, expect, it } from 'vitest';
import { computeOrderTotals } from '../src/lib/catalog.js';
import { groupItemsBySupplier, syncOrderPickups } from '../server/suppliers.mjs';

const catalogo = {
  variants: [
    { id: 'cam', sku: 'CAM', name: 'Cámara IP', price: 1500, capsules: 0, general: true, label: 'Cámara IP', product_type: 'third_party', completeBottle: false },
    { id: 'dvr', sku: 'DVR', name: 'DVR', price: 4000, capsules: 0, general: true, label: 'DVR', product_type: 'third_party', completeBottle: false },
    { id: 'cable', sku: 'CAB', name: 'Cable', price: 50, capsules: 0, general: true, label: 'Cable', product_type: 'third_party', completeBottle: false },
    { id: 'phyto', sku: 'PHY', name: 'Phyto', price: 2500, capsules: 10, general: true, label: 'Phyto', completeBottle: false },
  ],
};

describe('la tienda viaja con la línea del carrito', () => {
  it('conserva supplier_id, nombre y costo en el pedido', () => {
    const totals = computeOrderTotals(
      [{ variantId: 'cam', quantity: 2, supplierId: 'sup_a', supplierName: 'Tienda A', supplierCostCents: 120000 }],
      { product: catalogo },
    );
    const line = totals.items[0];
    expect(line.supplier_id).toBe('sup_a');
    expect(line.supplier_name).toBe('Tienda A');
    expect(line.supplier_cost_cents).toBe(120000);
    expect(line.product_type).toBe('third_party');
    expect(line.quantity).toBe(2);
  });

  it('una línea propia no lleva tienda', () => {
    const totals = computeOrderTotals([{ variantId: 'phyto', quantity: 1 }], { product: catalogo });
    expect(totals.items[0].supplier_id).toBeUndefined();
    expect(totals.items[0].product_type).toBeUndefined();
  });
});

function memoryDb() {
  const rows = new Map();
  return {
    rows,
    async findBy(collection, field, value) {
      for (const doc of rows.values()) if (doc[field] === value) return doc;
      return null;
    },
    async insert(collection, doc) {
      if (rows.has(doc.id)) return { duplicate: true, doc };
      rows.set(doc.id, doc);
      return { duplicate: false, doc };
    },
    async update(collection, id, patch) {
      const next = { ...rows.get(id), ...patch };
      rows.set(id, next);
      return next;
    },
    async list() {
      return [...rows.values()];
    },
  };
}

const suppliers = [
  { id: 'sup_a', name: 'Tienda A', lat: 18.6, lng: -68.7 },
  { id: 'sup_b', name: 'Tienda B', lat: null, lng: null },
];

const order = {
  id: 'order_1',
  customer_id: 'cus_1',
  items: [
    { name: 'Cámara IP', quantity: 2, product_type: 'third_party', supplier_id: 'sup_a', cost_cents: 120000 },
    { name: 'DVR', quantity: 1, product_type: 'third_party', supplier_id: 'sup_a', cost_cents: 300000 },
    { name: 'Cable', quantity: 20, product_type: 'third_party', supplier_id: 'sup_b', cost_cents: 5000 },
    { name: 'Phyto', quantity: 1, product_type: 'own' },
  ],
};

describe('recogidas del pedido', () => {
  it('genera DOS recogidas (una por tienda) y se las queda el cliente', async () => {
    const db = memoryDb();
    const creadas = await syncOrderPickups(db, { order, suppliers });
    expect(creadas).toHaveLength(2);
    const lista = await db.list();
    expect(lista).toHaveLength(2);
    const a = lista.find((row) => row.supplier_id === 'sup_a');
    expect(a.customer_id).toBe('cus_1');
    expect(a.quantity).toBe(3);
    expect(a.items.map((row) => row.name).sort()).toEqual(['Cámara IP', 'DVR']);
    expect(a.location_status).toBe('ok');
    const b = lista.find((row) => row.supplier_id === 'sup_b');
    expect(b.location_status).toBe('pending');
    expect(b.status).toBe('pending_purchase');
  });

  it('volver a calcularlas NO duplica recogidas', async () => {
    const db = memoryDb();
    await syncOrderPickups(db, { order, suppliers });
    await syncOrderPickups(db, { order, suppliers });
    const lista = await db.list();
    expect(lista).toHaveLength(2);
  });

  it('si cambia la cantidad, actualiza la misma recogida', async () => {
    const db = memoryDb();
    await syncOrderPickups(db, { order, suppliers });
    const cambiado = {
      ...order,
      items: order.items.map((row) => (row.name === 'Cámara IP' ? { ...row, quantity: 5 } : row)),
    };
    const actualizadas = await syncOrderPickups(db, { order: cambiado, suppliers });
    expect(actualizadas).toHaveLength(1);
    const lista = await db.list();
    expect(lista).toHaveLength(2);
    expect(lista.find((row) => row.supplier_id === 'sup_a').quantity).toBe(6);
  });

  it('un pedido sin artículos de tienda no genera recogidas', async () => {
    const db = memoryDb();
    const grupos = await syncOrderPickups(db, {
      order: { ...order, items: [{ name: 'Phyto', quantity: 1, product_type: 'own' }] },
      suppliers,
    });
    expect(grupos).toHaveLength(0);
    expect(await db.list()).toHaveLength(0);
  });

  it('agrupa también la venta rápida que eligió tienda', () => {
    const grupos = groupItemsBySupplier([
      { name: 'Suelto', quantity: 1, product_type: 'quick_sale', supplier_id: 'sup_a' },
      { name: 'Otro', quantity: 2, product_type: 'quick_sale', supplier_id: 'sup_a' },
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].quantity).toBe(3);
  });
});
