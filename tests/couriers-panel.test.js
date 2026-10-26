// @vitest-environment node
/**
 * PANEL DE REPARTIDORES (página `/admin/couriers.html`).
 *
 * Se comprueba lo que de verdad importa del panel: que la página y su script se
 * sirven, que los datos que pinta vienen del backend (solicitud con vehículo y
 * zona), que las concesiones se leen por repartidor y que un usuario sin
 * `admin.full` no puede administrar solicitudes ni ver concesiones de una
 * empresa que no tiene.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'couriers-panel-uat';
let app; let dir; let admin; let operador; let courierId;

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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crm-couriers-panel-'));
  app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: join(dir, 'panel.sqlite'),
    token: TOKEN, quiet: true, schedulerEnabled: false,
    whatsapp: { enabled: false }, metaCapi: { enabled: false } });
  admin = await login({ token: TOKEN });
  const created = await call('users', { method: 'POST', body: {
    username: 'oficina-panel', displayName: 'Oficina Panel', role: 'OPERADOR', password: 'Oficina-Uat-123' } });
  expect(created.status).toBe(201);
  operador = await login({ username: 'oficina-panel', password: 'Oficina-Uat-123' });
  await app.ctx.settings.write('delivery_contacts', [
    { id: 'contact-panel', name: 'Mensajero Panel', phone: '+18095559222', shareOrders: true },
  ]);
  const courier = await call('couriers', { method: 'POST', body: { kind: 'EXTERNAL',
    phone: '+18095559222', displayName: 'Mensajero Panel', contactId: 'contact-panel',
    appAccess: true, pin: '123456', companyId: 'fulltech' } });
  expect(courier.status).toBe(201);
  courierId = courier.data.courier.id;
  const applied = await fetch(`${app.url}/api/courier/applications`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyId: 'phytoemagry',
      name: 'Solicitante Panel', phone: '+18095559333', vehicleType: 'BICICLETA',
      zone: 'Zona Panel', termsAccepted: true }) });
  expect(applied.status).toBe(202);
});

afterEach(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('página de repartidores', () => {
  it('la página y su script se sirven desde /admin', async () => {
    const page = await fetch(`${app.url}/admin/couriers.html`, { headers: { cookie: admin } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Repartidores');
    expect(html).toContain('Solicitudes de ingreso');
    const script = await fetch(`${app.url}/admin/couriers.js`, { headers: { cookie: admin } });
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type') ?? '').toContain('javascript');
  });

  it('muestra la validación junto al botón y crea un repartidor interno con PIN válido', async () => {
    const html = readFileSync(new URL('../public/admin/couriers.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('../public/admin/couriers.js', import.meta.url), 'utf8');
    const dom = new JSDOM(html, { url: `${app.url}/admin/couriers.html`, runScripts: 'outside-only' });
    const { window: win } = dom;
    const requests = [];
    win.fetch = (route, options = {}) => {
      requests.push({ route, method: options.method ?? 'GET' });
      return fetch(new URL(route, app.url), {
        ...options, headers: { ...options.headers, cookie: admin },
      });
    };
    try {
      win.eval(script);
      await expect.poll(() => win.document.querySelector('#status')?.textContent).toMatch(/Actualizado/);
      win.document.querySelector('[data-courier-new]').click();
      win.document.querySelector('#f-kind').value = 'INTERNAL';
      win.document.querySelector('#f-kind').dispatchEvent(new win.Event('change'));
      win.document.querySelector('#f-name').value = 'Junior Panel';
      win.document.querySelector('#f-phone').value = '8295319442';
      win.document.querySelector('#f-user').value =
        (await call('users')).data.users.find((user) => user.username === 'oficina-panel').id;
      win.document.querySelector('#f-pin').value = '0410';
      win.document.querySelector('[data-form-save]').click();
      const error = win.document.querySelector('#f-error');
      expect(error.hidden).toBe(false);
      expect(error.textContent).toContain('al menos 6 caracteres');
      expect(error.parentElement.id).toBe('d-actions');
      expect(requests.filter((request) => request.route === '/api/admin/couriers' && request.method === 'POST')).toHaveLength(0);

      win.document.querySelector('#f-pin').value = '041010';
      win.document.querySelector('[data-form-save]').click();
      await expect.poll(() => requests.filter((request) => request.route === '/api/admin/couriers' && request.method === 'POST').length).toBe(1);
      await expect.poll(() => win.document.querySelector('#status')?.textContent).toContain('Repartidor creado');
      const accounts = await call('couriers');
      const account = accounts.data.couriers.find((row) => row.display_name === 'Junior Panel');
      expect(account?.kind).toBe('INTERNAL');
      expect(account?.phone).toBe('+18295319442');
      const loginResponse = await fetch(`${app.url}/api/courier/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '+18295319442', pin: '041010' }),
      });
      expect(loginResponse.status).toBe(200);
    } finally {
      dom.window.close();
    }
  });

  it('las solicitudes llegan con vehículo, zona y condiciones; aprobar no da acceso', async () => {
    const listed = await call('courier-applications?companyId=phytoemagry');
    expect(listed.status).toBe(200);
    const [application] = listed.data.applications;
    expect(application.vehicle_type).toBe('BICICLETA');
    expect(application.zone).toBe('Zona Panel');
    expect(application.terms_accepted_at).toBeTruthy();
    const reviewed = await call(`courier-applications/${application.id}/review`,
      { method: 'POST', body: { companyId: 'phytoemagry', decision: 'approved' } });
    expect(reviewed.data.operational_access).toBe(false);
    expect(((await app.ctx.db.list('courier_accounts', { limit: 10 })) ?? [])
      .some((row) => row.phone_e164 === '+18095559333')).toBe(false);
  });

  it('las concesiones de un repartidor se leen de verdad y respetan el alcance', async () => {
    const grants = await call(`couriers/${courierId}/companies`);
    expect(grants.status).toBe(200);
    expect(grants.data.companies.map((row) => row.company_id)).toEqual(['fulltech']);
    // Un operador sin concesión no puede leer las de una empresa que no ve.
    expect((await call(`couriers/${courierId}/companies`, { cookie: operador })).status).toBe(403);
    // La central sí, y además puede conceder PHYTOEMAGRY.
    expect((await call(`couriers/${courierId}/companies`, { method: 'POST',
      body: { companyId: 'phytoemagry', active: true } })).status).toBe(200);
    expect((await call(`couriers/${courierId}/companies`)).data.companies
      .filter((row) => row.active).map((row) => row.company_id).sort()).toEqual(['fulltech', 'phytoemagry']);
  });

  it('administrar solicitudes exige superadministración', async () => {
    expect((await call('courier-applications', { cookie: operador })).status).toBe(403);
    const listed = await call('courier-applications');
    const [application] = listed.data.applications;
    expect((await call(`courier-applications/${application.id}/review`, { cookie: operador, method: 'POST',
      body: { companyId: 'phytoemagry', decision: 'approved' } })).status).toBe(403);
  });
});
