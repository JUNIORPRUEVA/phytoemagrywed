// @vitest-environment node
/**
 * CONCILIACIÓN DE CUSTODIA HISTÓRICA.
 *
 * Reglas que se fijan aquí:
 *   · un movimiento sin empresa demostrable se ve en el reporte y sigue bloqueando
 *     rendiciones nuevas;
 *   · registrar una resolución NO cambia importes, ni el libro, ni desbloquea nada;
 *   · la justificación es obligatoria y la segunda resolución del mismo movimiento
 *     se rechaza (idempotencia por movimiento, no por petición);
 *   · todo queda auditado y solo la central puede hacerlo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';
import { CASH_COLLECTION } from '../server/delivery-cash.mjs';

const TOKEN = 'cash-resolution-uat';
let app; let dir; let admin; let operador; let courierId; let movementId;

const login = async (body) => {
  const response = await fetch(`${app.url}/api/admin/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie').split(';')[0];
};
const call = async (route, { cookie = admin, method = 'GET', body } = {}) => {
  const response = await fetch(`${app.url}/api/admin/${route}`, { method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crm-cash-resolution-'));
  app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: join(dir, 'cash.sqlite'),
    token: TOKEN, quiet: true, schedulerEnabled: false,
    whatsapp: { enabled: false }, metaCapi: { enabled: false } });
  admin = await login({ token: TOKEN });
  const created = await call('users', { method: 'POST', body: {
    username: 'oficina-caja', displayName: 'Oficina Caja', role: 'OPERADOR', password: 'Oficina-Uat-123' } });
  expect(created.status).toBe(201);
  operador = await login({ username: 'oficina-caja', password: 'Oficina-Uat-123' });
  await app.ctx.settings.write('delivery_contacts', [
    { id: 'contact-caja', name: 'Mensajero Caja', phone: '+18095559444', shareOrders: true },
  ]);
  const courier = await call('couriers', { method: 'POST', body: { kind: 'EXTERNAL',
    phone: '+18095559444', displayName: 'Mensajero Caja', contactId: 'contact-caja',
    appAccess: true, pin: '123456' } });
  expect(courier.status).toBe(201);
  courierId = courier.data.courier.id;
  /* Cargo histórico sintético SIN pedido y SIN empresa: no se puede demostrar. */
  movementId = 'cash_ambiguous_uat_1';
  await app.ctx.db.insert(CASH_COLLECTION, {
    id: movementId, order_id: null, courier_account_id: courierId, company_id: null,
    kind: 'charge', amount_cents: 50000, note: 'Cobro histórico sin referencia',
    idempotency_key: 'historic-1', actor: 'UAT', created_at: new Date().toISOString(),
  });
});

afterEach(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('conciliación de movimientos ambiguos', () => {
  it('el movimiento aparece como no resuelto y la rendición sigue bloqueada', async () => {
    const report = await call('delivery-cash/reconciliation');
    expect(report.status).toBe(200);
    expect(report.data.unresolved_movements.map((row) => row.id)).toContain(movementId);
    const remittance = await call('delivery-cash/remittance', { method: 'POST',
      body: { courierAccountId: courierId, companyId: 'phytoemagry', amountCents: 1000, idempotencyKey: 'r-1' } });
    expect(remittance.status).toBe(409);
    expect(remittance.data.error).toBe('historical_custody_unresolved');
  });

  it('registrar la revisión queda auditada y NO mueve dinero ni desbloquea', async () => {
    const created = await call('delivery-cash/resolutions', { method: 'POST', body: {
      movementId, companyId: 'phytoemagry',
      justification: 'El comprobante del cuaderno coincide con el pedido PE-123.',
      evidence: 'cuaderno-2025-pagina-14' } });
    expect(created.status).toBe(201);
    expect(created.data.applied).toBe(false);
    expect(created.data.resolution.status).toBe('pending_authorization');
    // El libro no se tocó: mismo importe y sin empresa inventada.
    const ledger = await app.ctx.db.list(CASH_COLLECTION, { limit: 10 });
    const row = ledger.find((entry) => entry.id === movementId);
    expect(row.amount_cents).toBe(50000);
    expect(row.company_id).toBe(null);
    // Sigue bloqueado: la resolución es una propuesta, no una reasignación.
    expect((await call('delivery-cash/remittance', { method: 'POST', body: {
      courierAccountId: courierId, companyId: 'phytoemagry', amountCents: 1000, idempotencyKey: 'r-2' } })).status).toBe(409);
    const audit = await app.ctx.audit.list({ entity: 'cash_movement', entityId: movementId, limit: 20 });
    expect(audit.some((entry) => entry.action === 'cash.resolution_recorded')).toBe(true);
    const listed = await call('delivery-cash/resolutions');
    expect(listed.data.resolutions.map((entry) => entry.movement_id)).toEqual([movementId]);
  });

  it('exige justificación y rechaza una segunda resolución del mismo movimiento', async () => {
    const short = await call('delivery-cash/resolutions', { method: 'POST',
      body: { movementId, justification: 'ok' } });
    expect(short.status).toBe(422);
    expect(short.data.error).toBe('justification_required');
    const first = await call('delivery-cash/resolutions', { method: 'POST',
      body: { movementId, justification: 'Evidencia del comprobante firmado.' } });
    expect(first.status).toBe(201);
    const second = await call('delivery-cash/resolutions', { method: 'POST',
      body: { movementId, justification: 'Otra versión distinta de la conclusión.' } });
    expect(second.status).toBe(409);
    expect(second.data.error).toBe('already_resolved');
    expect(((await app.ctx.db.list('cash_resolutions', { limit: 10 })) ?? []).length).toBe(1);
  });

  it('un movimiento inexistente o una empresa inválida no se aceptan', async () => {
    expect((await call('delivery-cash/resolutions', { method: 'POST',
      body: { movementId: 'no_existe', justification: 'Justificación suficientemente larga.' } })).status).toBe(404);
    expect((await call('delivery-cash/resolutions', { method: 'POST',
      body: { movementId, companyId: 'empresa_inventada', justification: 'Justificación suficientemente larga.' } })).status).toBe(422);
  });

  it('solo la central consulta y registra conciliaciones', async () => {
    expect((await call('delivery-cash/reconciliation', { cookie: operador })).status).toBe(403);
    expect((await call('delivery-cash/resolutions', { cookie: operador })).status).toBe(403);
    expect((await call('delivery-cash/resolutions', { cookie: operador, method: 'POST',
      body: { movementId, justification: 'Intento de la oficina sin permiso central.' } })).status).toBe(403);
  });
});
