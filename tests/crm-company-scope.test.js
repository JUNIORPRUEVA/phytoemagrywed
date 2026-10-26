// @vitest-environment node
/**
 * ALCANCE ADMINISTRATIVO POR EMPRESA.
 *
 * `delivery.manage` era global: quien lo tuviera veía la custodia, las cuentas
 * de reparto, las posiciones y los reportes de CUALQUIER empresa. Aquí se fija
 * la regla nueva:
 *
 *   · sin concesiones → solo PHYTOEMAGRY (lo de siempre, nada se rompe),
 *   · con concesiones → exactamente las concedidas,
 *   · la superadministración central (`admin.full`) sigue viendo todo.
 *
 * La concesión se da y se quita desde una sola ruta auditada y el cambio se
 * aplica en la siguiente petición, sin tocar el rol ni los permisos.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'company-scope-uat';
let app; let dir; let admin; let operador; let operadorId; let phytoOrder; let fulltechOrder;

const login = async (body) => {
  const response = await fetch(`${app.url}/api/admin/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie').split(';')[0];
};

const call = async (route, { cookie = admin, method = 'GET', body } = {}) => {
  const response = await fetch(`${app.url}/api/admin/${route}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

const createOrder = async (phone) => {
  const customer = await call('pos/customers', { method: 'POST', body: { name: `Cliente ${phone.slice(-4)}`, phone } });
  const created = await call('orders', { method: 'POST', body: {
    name: customer.data.customer?.name ?? 'Cliente',
    phone,
    status: 'nuevo',
    paymentMethod: 'CASH',
    items: [{ variantId: 'capsules_10', quantity: 1 }],
  } });
  return created.data.item?.id ?? created.data.order?.id ?? created.data.id;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crm-company-scope-'));
  app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: join(dir, 'scope.sqlite'),
    token: TOKEN, quiet: true, schedulerEnabled: false,
    whatsapp: { enabled: false }, metaCapi: { enabled: false } });
  admin = await login({ token: TOKEN });
  const created = await call('users', { method: 'POST', body: {
    username: 'operador-fulltech', displayName: 'Oficina UAT', role: 'OPERADOR', password: 'Oficina-Uat-123' } });
  expect(created.status).toBe(201);
  operadorId = created.data.user.id;
  operador = await login({ username: 'operador-fulltech', password: 'Oficina-Uat-123' });
  phytoOrder = await createOrder('8095557701');
  fulltechOrder = await createOrder('8095557702');
  const item = await app.ctx.store.getAdmin(fulltechOrder);
  const order = JSON.parse(item.order_json);
  order.origin = 'FULLTECH_STORE';
  order.company_id = 'fulltech';
  await app.ctx.store.update(fulltechOrder, { orderJson: JSON.stringify(order) });
});

afterEach(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('alcance administrativo por empresa', () => {
  it('sin concesiones la oficina sigue operando solo PHYTOEMAGRY', async () => {
    expect((await call('delivery-cash?companyId=phytoemagry', { cookie: operador })).status).toBe(200);
    expect((await call('delivery-cash?companyId=fulltech', { cookie: operador })).status).toBe(403);
    expect((await call('delivery-cash/movements?companyId=fulltech', { cookie: operador })).status).toBe(403);
    expect((await call('delivery-courier-positions?companyId=fulltech', { cookie: operador })).status).toBe(403);
    expect((await call(`orders/${fulltechOrder}`, { cookie: operador })).status).toBe(404);
    expect((await call(`orders/${phytoOrder}`, { cookie: operador })).status).toBe(200);
  });

  it('conceder FULLTECH abre esa empresa y no PHYTOEMAGRY', async () => {
    const granted = await call(`users/${operadorId}/companies`, { method: 'POST', body: { companyId: 'fulltech', active: true } });
    expect(granted.status).toBe(200);
    expect((await call('delivery-cash?companyId=fulltech', { cookie: operador })).status).toBe(200);
    expect((await call('delivery-courier-positions?companyId=fulltech', { cookie: operador })).status).toBe(200);
    expect((await call(`orders/${fulltechOrder}`, { cookie: operador })).status).toBe(200);
    // Ya tiene concesiones explícitas: PHYTOEMAGRY deja de estar incluida.
    expect((await call('delivery-cash?companyId=phytoemagry', { cookie: operador })).status).toBe(403);
    expect((await call(`orders/${phytoOrder}`, { cookie: operador })).status).toBe(404);
    // La central conserva ambas.
    expect((await call('delivery-cash?companyId=phytoemagry', { cookie: admin })).status).toBe(200);
    expect((await call('delivery-cash?companyId=fulltech', { cookie: admin })).status).toBe(200);
  });

  it('revocar corta el acceso en la siguiente petición', async () => {
    await call(`users/${operadorId}/companies`, { method: 'POST', body: { companyId: 'fulltech', active: true } });
    expect((await call(`orders/${fulltechOrder}`, { cookie: operador })).status).toBe(200);
    const revoked = await call(`users/${operadorId}/companies`, { method: 'POST', body: { companyId: 'fulltech', active: false } });
    expect(revoked.status).toBe(200);
    expect((await call(`orders/${fulltechOrder}`, { cookie: operador })).status).toBe(404);
    expect((await call('delivery-cash?companyId=fulltech', { cookie: operador })).status).toBe(403);
  });

  it('solo la superadministración reparte empresas', async () => {
    const denied = await call(`users/${operadorId}/companies`, { cookie: operador, method: 'POST',
      body: { companyId: 'fulltech', active: true } });
    expect(denied.status).toBe(403);
    const invalid = await call(`users/${operadorId}/companies`, { method: 'POST',
      body: { companyId: 'empresa_inexistente', active: true } });
    expect(invalid.status).toBe(422);
  });

  it('el alcance también filtra las cuentas de reparto y deja registro en auditoría', async () => {
    await app.ctx.settings.write('delivery_contacts', [
      { id: 'contact-phi', name: 'Mensajero Phyto', phone: '+18095559100', shareOrders: true },
      { id: 'contact-ft', name: 'Mensajero Fulltech', phone: '+18095559101', shareOrders: true },
    ]);
    const phi = await call('couriers', { method: 'POST', body: { kind: 'EXTERNAL', phone: '+18095559100',
      displayName: 'Mensajero Phyto', contactId: 'contact-phi', appAccess: true, pin: '123456' } });
    const ft = await call('couriers', { method: 'POST', body: { kind: 'EXTERNAL', phone: '+18095559101',
      displayName: 'Mensajero Fulltech', contactId: 'contact-ft', appAccess: true, pin: '123456', companyId: 'fulltech' } });
    expect(phi.status).toBe(201);
    expect(ft.status).toBe(201);
    const before = await call('couriers', { cookie: operador });
    expect(before.status).toBe(200);
    expect(before.data.couriers.map((row) => row.phone)).toEqual(['+18095559100']);
    await call(`users/${operadorId}/companies`, { method: 'POST', body: { companyId: 'fulltech', active: true } });
    const afterGrant = await call('couriers', { cookie: operador });
    expect(afterGrant.data.couriers.map((row) => row.phone)).toEqual(['+18095559101']);
    const audit = await app.ctx.audit.list({ entity: 'user', entityId: operadorId, limit: 50 });
    expect(audit.some((row) => row.action === 'user.company_scope_granted')).toBe(true);
  });
});
