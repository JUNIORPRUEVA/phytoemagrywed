// @vitest-environment node
/**
 * TIENDAS PROVEEDORAS, PRODUCTOS DE TERCEROS Y RECOGIDAS.
 *
 * Estas pruebas cubren las reglas que no pueden fallar en producción:
 *   · no inventar coordenadas,
 *   · no fiarse de una «disponibilidad» sin fecha de verificación,
 *   · agrupar por tienda (una recogida por establecimiento, no por artículo),
 *   · no mezclar artículos propios con los de tiendas.
 */
import { describe, expect, it } from 'vitest';
import { handleSupplierRoutes } from '../server/suppliers-routes.mjs';
import {
  coordinatesFromMapsLink,
  groupItemsBySupplier,
  locationStatus,
  normalizeProductSupplier,
  normalizeSupplier,
  pickupStoreIds,
  supplierKey,
} from '../server/suppliers.mjs';

describe('ubicación de la tienda', () => {
  it('lee coordenadas de los enlaces de Maps habituales', () => {
    expect(coordinatesFromMapsLink('https://www.google.com/maps/@18.6157,-68.7073,17z')).toEqual({
      lat: 18.6157,
      lng: -68.7073,
    });
    expect(coordinatesFromMapsLink('https://maps.google.com/?q=18.6157,-68.7073')).toEqual({
      lat: 18.6157,
      lng: -68.7073,
    });
    expect(coordinatesFromMapsLink('https://www.google.com/maps/place/X/data=!3d18.6157!4d-68.7073')).toEqual({
      lat: 18.6157,
      lng: -68.7073,
    });
    expect(coordinatesFromMapsLink('https://maps.google.com/maps?ll=18.6157,-68.7073&z=16')).toEqual({
      lat: 18.6157,
      lng: -68.7073,
    });
  });

  it('si el enlace no lleva coordenadas NO se inventa ninguna', () => {
    expect(coordinatesFromMapsLink('https://maps.app.goo.gl/abc123')).toBeNull();
    expect(coordinatesFromMapsLink('Calle Duarte 12, Higüey')).toBeNull();
    expect(coordinatesFromMapsLink('')).toBeNull();
  });

  it('una tienda sin coordenadas queda «Ubicación pendiente»', () => {
    expect(locationStatus({ lat: null, lng: null })).toBe('pending');
    expect(locationStatus({ lat: 18.6, lng: -68.7 })).toBe('ok');
    expect(locationStatus({ lat: 18.6 })).toBe('pending');
  });

  it('toma la ubicación del enlace cuando el formulario no trae coordenadas', () => {
    const supplier = normalizeSupplier({
      name: 'Ferretería Central',
      maps_url: 'https://www.google.com/maps/@18.6157,-68.7073,17z',
    });
    expect(supplier.lat).toBeCloseTo(18.6157);
    expect(supplier.lng).toBeCloseTo(-68.7073);
    expect(locationStatus(supplier)).toBe('ok');
  });

  it('rechaza media coordenada y enlaces que no son http', () => {
    expect(() => normalizeSupplier({ name: 'Tienda', lat: 18.6 })).toThrow(/latitud y longitud/);
    expect(() => normalizeSupplier({ name: 'Tienda', maps_url: 'javascript:alert(1)' })).toThrow(/http/);
    expect(() => normalizeSupplier({ name: '' })).toThrow(/nombre/);
  });
});

describe('relación producto ↔ tienda', () => {
  it('«disponible» sin fecha de verificación no cuenta como confirmado', () => {
    const link = normalizeProductSupplier({ supplier_id: 'sup_1', availability: 'available' });
    expect(link.availability).toBe('unknown');
    expect(link.verified_at).toBeNull();
  });

  it('acepta la disponibilidad confirmada con su fecha', () => {
    const link = normalizeProductSupplier({
      supplier_id: 'sup_1',
      availability: 'available',
      verified_at: '2026-10-18T10:00:00.000Z',
      cost_cents: 250000,
      pickup_eta_minutes: 25,
    });
    expect(link.availability).toBe('available');
    expect(link.cost_cents).toBe(250000);
    expect(link.pickup_eta_minutes).toBe(25);
  });

  it('exige tienda y un costo válido', () => {
    expect(() => normalizeProductSupplier({})).toThrow(/tienda/i);
    expect(() => normalizeProductSupplier({ supplier_id: 'sup_1', cost_cents: -5 })).toThrow(/costo/i);
  });

  it('no duplica la misma tienda escrita distinto', () => {
    expect(supplierKey({ name: 'Ferretería  Central', phone: '(809) 555-1234' })).toBe(
      supplierKey({ name: 'ferreteria central', phone: '8095551234' }),
    );
    expect(supplierKey({ name: 'Tienda A' })).not.toBe(supplierKey({ name: 'Tienda B' }));
    expect(supplierKey({ name: 'Tienda A', address: 'Calle 1', phone: '8091111111' })).toBe(
      supplierKey({ name: 'Tienda A', address: 'Calle 1', phone: '8092222222' }),
    );
    expect(supplierKey({ name: 'Tienda A', address: 'Calle 1' })).not.toBe(
      supplierKey({ name: 'Tienda A', address: 'Calle 2' }),
    );
  });
});

describe('agrupación por tienda (recogidas)', () => {
  const items = [
    { name: 'Cámara IP exterior', quantity: 2, product_type: 'third_party', supplier_id: 'sup_a', supplier_name: 'Tienda A', cost_cents: 150000 },
    { name: 'DVR 8 canales', quantity: 1, product_type: 'third_party', supplier_id: 'sup_a', supplier_name: 'Tienda A', cost_cents: 400000 },
    { name: 'Disco duro 2 TB', quantity: 1, product_type: 'third_party', supplier_id: 'sup_a', supplier_name: 'Tienda A', cost_cents: 300000 },
    { name: 'Cable UTP (metro)', quantity: 20, product_type: 'third_party', supplier_id: 'sup_b', supplier_name: 'Tienda B', cost_cents: 5000 },
    { name: 'Conectores RJ45', quantity: 4, product_type: 'third_party', supplier_id: 'sup_b', supplier_name: 'Tienda B', cost_cents: 2500 },
    { name: 'Cápsulas Phytoemagry', quantity: 3, product_type: 'own', supplier_id: null },
  ];

  it('hace DOS recogidas (una por tienda), no una por artículo', () => {
    const groups = groupItemsBySupplier(items);
    expect(groups).toHaveLength(2);
    const [a, b] = groups.sort((x, y) => x.supplier_id.localeCompare(y.supplier_id));
    expect(a.supplier_id).toBe('sup_a');
    expect(a.items).toHaveLength(3);
    expect(a.quantity).toBe(4);
    expect(a.cost_cents).toBe(2 * 150000 + 400000 + 300000);
    expect(b.supplier_id).toBe('sup_b');
    expect(b.items).toHaveLength(2);
    expect(b.quantity).toBe(24);
    expect(b.cost_cents).toBe(20 * 5000 + 4 * 2500);
  });

  it('no mezcla artículos propios ni líneas sin tienda', () => {
    const groups = groupItemsBySupplier(items);
    const nombres = groups.flatMap((group) => group.items.map((item) => item.name));
    expect(nombres).not.toContain('Cápsulas Phytoemagry');
  });

  it('una venta rápida con tienda también genera su recogida', () => {
    const groups = groupItemsBySupplier([
      { name: 'Artículo suelto', quantity: 1, product_type: 'quick_sale', supplier_id: 'sup_a', cost_cents: 10000 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toEqual([{ name: 'Artículo suelto', quantity: 1, unit_cost_cents: 10000 }]);
  });

  it('detecta varios orígenes aunque un producto propio no indique tienda', () => {
    expect(pickupStoreIds(items)).toEqual(['sup_a', 'sup_b']);
    expect(pickupStoreIds([{ supplier_id: 'sup_a' }, { supplierId: 'sup_a' }])).toEqual(['sup_a']);
  });
});

describe('privacidad de la ficha de tienda', () => {
  it('rechaza la lista y el detalle general al repartidor sin consultar datos privados', async () => {
    for (const route of ['/api/admin/suppliers', '/api/admin/suppliers/sup_1']) {
      let result;
      const handled = await handleSupplierRoutes({
        req: { method: 'GET', url: route }, res: {}, route,
        ctx: { db: { list: () => { throw new Error('no debe leer tiendas'); } } },
        actor: { role: 'DELIVERY', id: 'courier_1' },
        can: permission => permission === 'delivery.tracking.start',
        json: (_res, status, body) => { result = { status, body }; },
      });
      expect(handled).toBe(true);
      expect(result).toEqual({ status: 403, body: { ok: false, error: 'forbidden' } });
    }
  });

  it('separa tiendas por empresa, oculta contactos al agente y conserva el ID al inactivar', async () => {
    const records = new Map([
      ['logistics_companies', new Map([
        ['phytoemagry', { id: 'phytoemagry', active: true }],
        ['fulltech', { id: 'fulltech', active: true }],
      ])],
    ]);
    const table = name => {
      if (!records.has(name)) records.set(name, new Map());
      return records.get(name);
    };
    const db = {
      list: async name => [...table(name).values()],
      get: async (name, id) => table(name).get(id) ?? null,
      insert: async (name, row) => { table(name).set(row.id, row); return row; },
      update: async (name, id, change) => {
        const row = { ...table(name).get(id), ...change };
        table(name).set(id, row);
        return row;
      },
    };
    const request = async ({ method = 'GET', route, body, role = 'ADMIN', permissions }) => {
      let response;
      await handleSupplierRoutes({
        req: { method, url: route }, res: {}, route: route.split('?')[0],
        ctx: { db, clock: () => new Date('2026-11-03T12:00:00Z') },
        actor: { id: role.toLowerCase(), role },
        can: permission => permissions?.includes(permission) ?? (permission === 'admin.full' || permission === 'orders.read'),
        readJson: async () => body,
        json: (_res, status, payload) => { response = { status, payload }; },
      });
      return response;
    };
    const phyto = await request({ method: 'POST', route: '/api/admin/suppliers',
      body: { company_id: 'phytoemagry', name: 'Tienda Central', address: 'Calle 1', phone: '8091111111' } });
    const fulltech = await request({ method: 'POST', route: '/api/admin/suppliers',
      body: { company_id: 'fulltech', name: 'Tienda Central', address: 'Calle 1', phone: '8092222222' } });
    expect(phyto.status).toBe(201);
    expect(fulltech.status).toBe(201);
    const duplicate = await request({ method: 'POST', route: '/api/admin/suppliers',
      body: { company_id: 'phytoemagry', name: 'Tienda Central', address: 'Calle 1', phone: '8093333333' } });
    expect(duplicate.payload.error).toBe('duplicate_supplier');
    const agentList = await request({ route: '/api/admin/suppliers', role: 'AGENT', permissions: ['orders.read'] });
    expect(agentList.payload.suppliers.map(row => row.id)).toEqual([phyto.payload.supplier.id]);
    expect(JSON.stringify(agentList.payload)).not.toContain('8091111111');
    await db.insert('product_suppliers', { id: 'link_private', product_id: 'prod_private', supplier_id: phyto.payload.supplier.id,
      company_id: 'phytoemagry', cost_cents: 4500, notes: 'Costo interno' });
    const agentLinks = await request({ route: '/api/admin/products/prod_private/suppliers', role: 'AGENT', permissions: ['orders.read'] });
    const agentStore = await request({ route: `/api/admin/suppliers/${phyto.payload.supplier.id}`, role: 'AGENT', permissions: ['orders.read'] });
    expect(agentLinks.payload.links[0].cost_cents).toBeUndefined();
    expect(agentStore.payload.links[0].notes).toBeUndefined();
    const foreign = await request({ route: `/api/admin/suppliers/${fulltech.payload.supplier.id}`, role: 'AGENT', permissions: ['orders.read'] });
    expect(foreign.status).toBe(404);
    const removed = await request({ method: 'DELETE', route: `/api/admin/suppliers/${phyto.payload.supplier.id}` });
    expect(removed.payload.supplier.active).toBe(false);
    expect(await db.get('suppliers', phyto.payload.supplier.id)).not.toBeNull();
    await db.insert('suppliers', { id: 'legacy_store', name: 'Antigua', address: 'Calle 9', phone: '8094444444' });
    const before = await request({ route: '/api/admin/suppliers', role: 'AGENT', permissions: ['orders.read'] });
    expect(before.payload.suppliers.map(row => row.id)).not.toContain('legacy_store');
    const pending = await request({ route: '/api/admin/suppliers/unassigned' });
    expect(pending.payload.suppliers.map(row => row.id)).toContain('legacy_store');
    const assigned = await request({ method: 'POST', route: '/api/admin/suppliers/legacy_store/assign-company',
      body: { company_id: 'fulltech' } });
    expect(assigned.status).toBe(200);
    expect((await db.get('suppliers', 'legacy_store')).company_id).toBe('fulltech');
  });
});
