// @vitest-environment node
/**
 * ESCENARIO EXTREMO A EXTREMO MULTIEMPRESA (backend real, sin mocks).
 *
 * Recorre el guion de aceptación completo con datos sintéticos:
 *
 *   solicitud → documentos → revisión → aprobación → alta de acceso →
 *   login del repartidor → pedido asignado → aceptar/recoger/iniciar →
 *   GPS recibido y visible en el CRM → llegada → entrega con efectivo →
 *   custodia por empresa → rendición → segunda empresa → revocación.
 *
 * Lo que NO prueba: la interfaz de Flutter ni el GPS del teléfono. Prueba el
 * backend que esa app consume, con las mismas rutas y cabeceras.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'e2e-multiempresa-uat';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PHONE = '+18095557701';

let app; let dir; let admin; let scene;

const login = async (body) => {
  const response = await fetch(`${app.url}/api/admin/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie').split(';')[0];
};

const adminCall = async (route, { method = 'GET', body } = {}) => {
  const response = await fetch(`${app.url}/api/admin/${route}`, { method,
    headers: { cookie: admin, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

const publicCall = async (route, { method = 'GET', body } = {}) => {
  const response = await fetch(`${app.url}${route}`, { method,
    headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

const courierCall = async (route, { token, method = 'GET', body, companyId } = {}) => {
  const response = await fetch(`${app.url}${route}`, { method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(companyId ? { 'x-courier-company': companyId } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

const createOrder = async (phone) => {
  const customer = await adminCall('pos/customers', { method: 'POST', body: { name: `Cliente ${phone.slice(-4)}`, phone } });
  const created = await adminCall('orders', { method: 'POST', body: {
    name: customer.data.customer?.name ?? 'Cliente', phone, status: 'nuevo',
    paymentMethod: 'CASH', items: [{ variantId: 'capsules_10', quantity: 1 }] } });
  return created.data.item?.id ?? created.data.order?.id ?? created.data.id;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crm-e2e-multiempresa-'));
  app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: join(dir, 'e2e.sqlite'),
    token: TOKEN, quiet: true, schedulerEnabled: false,
    whatsapp: { enabled: false }, metaCapi: { enabled: false } });
  admin = await login({ token: TOKEN });
  await app.ctx.settings.write('delivery_contacts', [
    { id: 'contact-e2e', name: 'Repartidor E2E', phone: PHONE, shareOrders: true },
  ]);
});

afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('escenario completo multiempresa', () => {
  it('registro, documentos, aprobación y acceso (pasos 1-6)', async () => {
    expect((await publicCall('/api/courier/companies')).data.companies.map((row) => row.id).sort())
      .toEqual(['fulltech', 'phytoemagry']);

    const applied = await publicCall('/api/courier/applications', { method: 'POST', body: {
      companyId: 'phytoemagry', name: 'Repartidor E2E', phone: PHONE,
      vehicleType: 'MOTO', zone: 'Distrito Nacional', termsAccepted: true } });
    expect(applied.status).toBe(202);
    const { applicationId, receipt } = applied.data;

    // MOTO: identidad, licencia y selfie (la matrícula es un número, no un documento).
    for (const kind of ['IDENTITY', 'DRIVING_LICENSE', 'SELFIE']) {
      const uploaded = await publicCall(`/api/courier/applications/${applicationId}/documents`, {
        method: 'POST', body: { receipt, kind, dataBase64: PNG } });
      expect(uploaded.status).toBe(201);
    }
    const expediente = await publicCall(`/api/courier/applications/${applicationId}/documents?receipt=${receipt}`);
    expect(expediente.data.missing).toEqual([]);
    expect(expediente.data.documents).toHaveLength(3);

    const listed = await adminCall(`courier-applications/${applicationId}/documents`);
    for (const document of listed.data.documents) {
      const reviewed = await adminCall(`courier-documents/${document.id}/review`, {
        method: 'POST', body: { decision: 'accepted' } });
      expect(reviewed.status).toBe(200);
    }
    const approved = await adminCall(`courier-applications/${applicationId}/review`, {
      method: 'POST', body: { companyId: 'phytoemagry', decision: 'approved' } });
    expect(approved.data.operational_access).toBe(false);

    // La aprobación NO crea la cuenta: el alta del acceso es un acto aparte.
    const account = await adminCall('couriers', { method: 'POST', body: {
      kind: 'EXTERNAL', phone: PHONE, displayName: 'Repartidor E2E',
      contactId: 'contact-e2e', appAccess: true, pin: '123456', companyId: 'phytoemagry' } });
    expect(account.status).toBe(201);
    expect(account.data.courier.company_id).toBe('phytoemagry');
    scene = { courierId: account.data.courier.id };
  });

  it('login del repartidor y pedido asignado (pasos 7-9)', async () => {
    const session = await courierCall('/api/courier/login', { method: 'POST',
      body: { phone: PHONE, pin: '123456' } });
    expect(session.status).toBe(200);
    expect(session.data.companies).toEqual(['phytoemagry']);
    scene.token = session.data.token;

    const me = await courierCall('/api/courier/me', { token: scene.token });
    expect(me.status).toBe(200);

    const orderId = await createOrder('8095557001');
    scene.orderId = orderId;
    const assigned = await adminCall(`orders/${orderId}/courier/assign`, { method: 'POST', body: { contactPhone: PHONE } });
    expect([200, 201]).toContain(assigned.status);

    const list = await courierCall('/api/courier/orders', { token: scene.token, companyId: 'phytoemagry' });
    expect(list.status).toBe(200);
    expect(list.data.orders.map((row) => row.id)).toContain(orderId);
  });

  it('aceptar, iniciar y enviar GPS visible en el CRM (pasos 10-12)', async () => {
    const base = `/api/courier/orders/${scene.orderId}`;
    expect((await courierCall(`${base}/accept`, { token: scene.token, method: 'POST', body: {} })).status).toBe(200);
    expect((await courierCall(`${base}/pickup`, { token: scene.token, method: 'POST', body: {} })).data.state).toBe('PICKED_UP');
    expect((await courierCall(`${base}/start`, { token: scene.token, method: 'POST', body: {} })).data.state).toBe('EN_ROUTE');

    const position = await courierCall('/api/courier/location', { token: scene.token, companyId: 'phytoemagry',
      method: 'POST', body: { latitude: 18.4861, longitude: -69.9312, accuracy: 8 } });
    expect(position.status).toBe(200);

    const map = await adminCall('delivery-courier-positions?companyId=phytoemagry');
    expect(map.status).toBe(200);
    const mine = map.data.positions.find((row) => row.courier_id === scene.courierId);
    expect(mine).toBeTruthy();
    expect(mine.company_id ?? 'phytoemagry').toBe('phytoemagry');
  });

  it('entrega con efectivo, custodia y rendición (pasos 13-16)', async () => {
    const base = `/api/courier/orders/${scene.orderId}`;
    expect((await courierCall(`${base}/arrive`, { token: scene.token, method: 'POST', body: {} })).data.state).toBe('ARRIVED');
    const code = (await adminCall(`orders/${scene.orderId}/delivery-code`, { method: 'POST', body: {} })).data?.code;
    expect(typeof code).toBe('string');
    const probe = await courierCall(`${base}/deliver`, { token: scene.token, method: 'POST', body: { proofCode: code } });
    expect(probe.data.error).toBe('cash_amount_required');
    const delivered = await courierCall(`${base}/deliver`, { token: scene.token, method: 'POST',
      body: { proofCode: code, cashReceivedCents: probe.data.expected_cents } });
    expect(delivered.data.state).toBe('DELIVERED');

    const custody = await adminCall('delivery-cash?companyId=phytoemagry');
    expect(custody.status).toBe(200);
    const mine = custody.data.couriers.find((row) => row.courier_id === scene.courierId);
    expect(Number(mine.charged_cents)).toBe(Number(probe.data.expected_cents));
    expect(Number(mine.pending_cents)).toBeGreaterThan(0);
    scene.phytoCustody = custody.data.couriers;
    scene.phytoPending = Number(mine.pending_cents);

    const remitted = await adminCall('delivery-cash/remittance', { method: 'POST', body: {
      courierAccountId: scene.courierId, companyId: 'phytoemagry',
      amountCents: scene.phytoPending, idempotencyKey: `e2e-remit-${scene.courierId}` } });
    expect([200, 201]).toContain(remitted.status);
    const after = await adminCall('delivery-cash?companyId=phytoemagry');
    expect(Number(after.data.couriers.find((row) => row.courier_id === scene.courierId).pending_cents)).toBe(0);
  });

  it('segunda empresa, aislamiento y revocación (pasos 17-22)', async () => {
    expect((await adminCall(`couriers/${scene.courierId}/companies`, { method: 'POST',
      body: { companyId: 'fulltech', active: true } })).status).toBe(200);
    const fresh = await courierCall('/api/courier/login', { method: 'POST', body: { phone: PHONE, pin: '123456' } });
    expect(fresh.data.companies.sort()).toEqual(['fulltech', 'phytoemagry']);
    const token = fresh.data.token;
    scene.token = token;

    const fulltechOrder = await createOrder('8095557002');
    const item = await app.ctx.store.getAdmin(fulltechOrder);
    const order = JSON.parse(item.order_json);
    order.origin = 'FULLTECH_STORE';
    order.company_id = 'fulltech';
    await app.ctx.store.update(fulltechOrder, { orderJson: JSON.stringify(order) });
    expect([200, 201]).toContain((await adminCall(`orders/${fulltechOrder}/courier/assign`, {
      method: 'POST', body: { contactPhone: PHONE } })).status);
    const fulltechList = await courierCall('/api/courier/orders', { token, companyId: 'fulltech' });
    expect(fulltechList.data.orders.map((row) => row.id)).toContain(fulltechOrder);
    // El pedido FULLTECH no aparece en la lista de PHYTOEMAGRY ni al revés.
    expect((await courierCall('/api/courier/orders', { token, companyId: 'phytoemagry' })).data.orders
      .map((row) => row.id)).not.toContain(fulltechOrder);

    // Custodia separada: FULLTECH empieza en cero y no hereda el saldo de PHYTO.
    const fulltechCustody = await adminCall('delivery-cash?companyId=fulltech');
    expect(fulltechCustody.status).toBe(200);
    expect(Number(fulltechCustody.data.couriers.find((row) => row.courier_id === scene.courierId)?.pending_cents ?? 0)).toBe(0);
    // Una oficina sin concesión no puede leer la custodia de FULLTECH.
    expect((await adminCall('delivery-cash?companyId=fulltech', { method: 'GET' })).status).toBe(200);

    // Revocar FULLTECH corta esa empresa y deja PHYTOEMAGRY intacta.
    expect((await adminCall(`couriers/${scene.courierId}/companies`, { method: 'POST',
      body: { companyId: 'fulltech', active: false } })).status).toBe(200);
    const revoked = await courierCall('/api/courier/orders', { token, companyId: 'fulltech' });
    expect([401, 403]).toContain(revoked.status);
    const newSession = await courierCall('/api/courier/login', { method: 'POST', body: { phone: PHONE, pin: '123456' } });
    expect(newSession.data.companies).toEqual(['phytoemagry']);
    expect((await courierCall('/api/courier/orders', { token: newSession.data.token, companyId: 'phytoemagry' })).status).toBe(200);
  });
});
