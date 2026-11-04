// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';
import { compensationAtAssignment } from '../server/courier-compensation-state.mjs';
import { courierOrderDTO } from '../server/courier-app.mjs';

let app;
let dir;
afterEach(async () => { await app?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

it('guarda por empresa una política explícita y la recupera tras reiniciar el backend efímero', async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'courier-rules-'));
  const dataFile = path.join(dir, 'crm.sqlite');
  const start = () => startCrmServer({ port: 0, host: '127.0.0.1', databaseUrl: '', dataFile,
    token: 'courier-rules-uat', quiet: true, schedulerEnabled: false,
    whatsapp: { enabled: false }, metaCapi: { enabled: false } });
  app = await start();
  const login = await fetch(`${app.url}/api/admin/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'courier-rules-uat' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = async (method, body) => {
    const response = await fetch(`${app.url}/api/admin/courier-compensation`, {
      method, headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  const invalid = await request('POST', { company_id: 'fulltech', policy: { active: true, base_model: 'DISTANCE' } });
  expect(invalid.data.error).toBe('invalid_policy');
  const input = { company_id: 'fulltech', policy: { active: true, base_model: 'DISTANCE',
    distance_base_cents: 5000, distance_per_km_cents: 1200, distance_min_cents: 6000,
    product_sale_percent: 3 } };
  const saved = await request('POST', input);
  expect(saved.status).toBe(200);
  expect(saved.data.policy).toMatchObject({ company_id: 'fulltech', distance_per_km_cents: 1200,
    product_sale_percent: 3 });
  const protectedUpdate = await request('POST', { company_id: 'fulltech', policy: {
    ...input.policy, delivery_bonus_cents: 700, require_pickup: true,
    shift_require_zero_custody: true } });
  expect(protectedUpdate.status).toBe(200);
  expect((await request('POST', { company_id: 'fulltech', policy: {
    active: true, base_model: 'DISTANCE', distance_base_cents: 5000,
    distance_per_km_cents: 0, product_sale_percent: 3 } })).status).toBe(422);
  const compactUpdate = await request('POST', { company_id: 'fulltech', policy: {
    active: true, base_model: 'DISTANCE', distance_base_cents: 5000,
    distance_per_km_cents: 1500, distance_min_cents: 6000,
    product_sale_percent: 4 } });
  expect(compactUpdate.data.policy).toMatchObject({ delivery_bonus_cents: 700,
    require_pickup: true, shift_require_zero_custody: true,
    distance_per_km_cents: 1500, product_sale_percent: 4 });
  await app.close();
  app = await start();
  const visible = await request('GET');
  expect(visible.data.policies).toHaveLength(1);
  expect(visible.data.policies[0].id).toBe(saved.data.policy.id);
});

it('fija la compensación al asignar y no la cambia al actualizar una política', async () => {
  const policies = [{ id: 'policy_1', company_id: 'fulltech', active: true,
    base_model: 'DISTANCE', distance_base_cents: 5000, distance_per_km_cents: 1200,
    distance_min_cents: 6000, product_sale_percent: 3, updated_at: '2026-11-03T10:00:00Z' }];
  const db = { list: async () => policies };
  const order = { company_id: 'fulltech', items: [{ supplier_id: 'store_1', quantity: 1, unitPrice: 2000 }],
    delivery: { route: { meters: 2500, provider: 'osrm' } } };
  const first = await compensationAtAssignment(db, order, new Date('2026-11-03T11:00:00Z'));
  expect(first.snapshot.total_cents).toBe(14000);
  policies[0].distance_per_km_cents = 5000;
  const repeated = await compensationAtAssignment(db,
    { ...order, delivery: { ...order.delivery, courier_compensation_snapshot: first.snapshot } });
  expect(repeated.snapshot).toEqual(first.snapshot);
  expect((await compensationAtAssignment(db, { ...order, delivery: {} })).error).toBe('compensation_route_or_policy_invalid');
  const dto = courierOrderDTO({ id: 'order_1', order_json: JSON.stringify({ ...order,
    delivery: { ...order.delivery, pickup: { name: 'Tienda', address: 'Calle 1', phone: '8095559999' },
      courier_compensation_snapshot: first.snapshot } }) });
  expect(dto.courier_compensation.total_cents).toBe(14000);
  expect(dto.courier_compensation_confirmed).toBe(false);
  expect(JSON.stringify(dto)).not.toContain('8095559999');
});
