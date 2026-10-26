// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

let app, dir, cookie;
const request = async (route, body, admin = false) => {
  const response = await fetch(app.url + route, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(admin ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
};

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'courier-application-'));
  app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: path.join(dir, 'uat.sqlite'),
    token: 'uat-application-only', quiet: true, schedulerEnabled: false });
  const login = await fetch(app.url + '/api/admin/login', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'uat-application-only' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
afterEach(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

it('solicitud y aprobación empresarial no crean acceso operativo ni credenciales', async () => {
  const companies = await request('/api/courier/companies');
  expect(companies.data.companies.map((row) => row.id).sort()).toEqual(['fulltech', 'phytoemagry']);
  const application = { companyId: 'fulltech', name: 'Repartidor UAT', phone: '+18095550666',
    vehicleType: 'MOTO', zone: 'Distrito Nacional', termsAccepted: true };
  expect((await request('/api/courier/applications', application)).status).toBe(202);
  expect((await request('/api/courier/applications', application)).status).toBe(202);
  expect((await request('/api/courier/login', { phone: application.phone, pin: '123456' })).status).toBe(401);
  expect((await app.ctx.db.list('courier_accounts', { limit: 10 })).length).toBe(0);
  expect((await app.ctx.db.list('courier_company_grants', { limit: 10 })).length).toBe(0);
  expect((await request('/api/admin/courier-applications')).status).toBe(401);
  const pending = await request('/api/admin/courier-applications?companyId=fulltech', null, true);
  expect(pending.data.applications).toHaveLength(1);
  const id = pending.data.applications[0].id;
  /* La oficina ve con qué se postula: vehículo y zona, sin inventarlos. */
  expect(pending.data.applications[0].vehicle_type).toBe('MOTO');
  expect(pending.data.applications[0].zone).toBe('Distrito Nacional');
  expect((await request(`/api/admin/courier-applications/${id}/review`,
    { companyId: 'phytoemagry', decision: 'approved' }, true)).status).toBe(422);
  /* Pedir información exige motivo y NO aprueba ni concede acceso. */
  expect((await request(`/api/admin/courier-applications/${id}/review`,
    { companyId: 'fulltech', decision: 'info_required' }, true)).status).toBe(422);
  const info = await request(`/api/admin/courier-applications/${id}/review`,
    { companyId: 'fulltech', decision: 'info_required', note: 'Falta foto de la licencia' }, true);
  expect(info.status).toBe(200);
  expect(info.data.status).toBe('info_required');
  expect(info.data.operational_access).toBe(false);
  const reviewed = await request(`/api/admin/courier-applications/${id}/review`,
    { companyId: 'fulltech', decision: 'approved' }, true);
  expect(reviewed.status).toBe(200);
  expect(reviewed.data.operational_access).toBe(false);
  expect((await request(`/api/admin/courier-applications/${id}/review`,
    { companyId: 'fulltech', decision: 'approved' }, true)).status).toBe(409);
  expect((await request('/api/courier/login', { phone: application.phone, pin: '123456' })).status).toBe(401);
});

it('el alta exige vehículo, zona y aceptación expresa de las condiciones', async () => {
  const base = { companyId: 'phytoemagry', name: 'Repartidor Sin Datos', phone: '+18095550677' };
  expect((await request('/api/courier/applications', { ...base, zone: 'Santiago', termsAccepted: true })).data.error)
    .toBe('invalid_vehicle_type');
  expect((await request('/api/courier/applications', { ...base, vehicleType: 'MOTO', termsAccepted: true })).data.error)
    .toBe('invalid_zone');
  expect((await request('/api/courier/applications', { ...base, vehicleType: 'MOTO', zone: 'Santiago', termsAccepted: false })).data.error)
    .toBe('terms_required');
  expect(((await app.ctx.db.list('courier_applications', { limit: 10 })) ?? []).length).toBe(0);
});

it('el solicitante consulta su estado con el recibo, no con el teléfono', async () => {
  const submitted = await request('/api/courier/applications', { companyId: 'phytoemagry',
    name: 'Repartidor Estado', phone: '+18095550688', vehicleType: 'CARRO', zone: 'Santo Domingo Este', termsAccepted: true });
  expect(submitted.status).toBe(202);
  const { applicationId, receipt } = submitted.data;
  expect(applicationId).toBeTruthy();
  expect(receipt).toBeTruthy();
  const status = await request(`/api/courier/applications/${applicationId}/status?receipt=${receipt}`);
  expect(status.status).toBe(200);
  expect(status.data.status).toBe('pending');
  expect(status.data.operational_access).toBe(false);
  // Sin recibo correcto no se revela ni el estado ni que la solicitud exista.
  expect((await request(`/api/courier/applications/${applicationId}/status`)).status).toBe(404);
  expect((await request(`/api/courier/applications/${applicationId}/status?receipt=otro`)).status).toBe(404);
  // Repetir la solicitud devuelve el MISMO recibo: no duplica la fila.
  const again = await request('/api/courier/applications', { companyId: 'phytoemagry',
    name: 'Repartidor Estado', phone: '+18095550688', vehicleType: 'CARRO', zone: 'Santo Domingo Este', termsAccepted: true });
  expect(again.data.applicationId).toBe(applicationId);
  expect(again.data.receipt).toBe(receipt);
  // Las decisiones de la oficina quedan auditadas (antes se descartaban en silencio).
  await request(`/api/admin/courier-applications/${applicationId}/review`,
    { companyId: 'phytoemagry', decision: 'rejected', note: 'Sin licencia' }, true);
  const audit = await app.ctx.audit.list({ entity: 'courier_application', entityId: applicationId, limit: 20 });
  expect(audit.some((row) => row.action === 'courier.application_submitted')).toBe(true);
  expect(audit.some((row) => row.action === 'courier.application_rejected')).toBe(true);
  // Tras un rechazo se puede volver a postular (fila nueva, no reabrir la vieja).
  const retry = await request('/api/courier/applications', { companyId: 'phytoemagry',
    name: 'Repartidor Estado', phone: '+18095550688', vehicleType: 'CARRO', zone: 'Santo Domingo Este', termsAccepted: true });
  expect(retry.status).toBe(202);
  expect(retry.data.applicationId).not.toBe(applicationId);
});
