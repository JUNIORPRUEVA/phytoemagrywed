import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import pgDriver from 'pg';
import { startUatPostgres } from './lib/fulltech-uat-postgres.mjs';
import { startCrmServer } from '../server/crm-server.mjs';

const pg = await startUatPostgres();
let app;
const bin = 'C:/Program Files/PostgreSQL/17/bin';
const exe = (name) => join(bin, `${name}.exe`);
const backup = join(pg.directory, 'before-logistics.dump');
const checks = [];
const verify = async (name, fn) => {
  await pg.verify();
  await fn();
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
};
const request = async (route, body, cookie) => {
  const response = await fetch(`${app.url}${route}`, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
};

try {
  const identity = await pg.verify();
  assert.equal(identity.purpose, 'FULLTECH_DESTRUCTIVE_UAT_ONLY');
  // Respaldo ANTES del arranque/migración del CRM, de la base creada por este arnés.
  execFileSync(exe('pg_dump'), ['-Fc', '-f', backup, pg.url], { windowsHide: true });
  const archive = execFileSync(exe('pg_restore'), ['--list', backup], { encoding: 'utf8', windowsHide: true });
  assert.match(archive, /fulltech_uat_guard/);
  checks.push('respaldo previo verificable');
  app = await startCrmServer({ port: 0, host: '127.0.0.1', databaseUrl: pg.url,
    dataFile: join(pg.directory, 'unused.sqlite'), token: 'logistics-uat-only',
    quiet: true, schedulerEnabled: false, whatsapp: { enabled: false }, metaCapi: { enabled: false } });
  assert.equal(app.storage, 'postgres');
  const login = await fetch(`${app.url}/api/admin/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'logistics-uat-only' }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  await verify('registro y migración aditiva PostgreSQL', async () => {
    const companies = await request('/api/admin/logistics/companies', null, cookie);
    assert.deepEqual(companies.data.companies.map((row) => row.id).sort(), ['fulltech', 'phytoemagry']);
    const extra = await request('/api/admin/logistics/companies', { id: 'tercera_tienda', name: 'Tercera tienda UAT' }, cookie);
    assert.equal(extra.status, 201);
    await app.ctx.db.list('courier_company_grants', { limit: 1 });
    const tables = (await pg.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'phytoemagry_%'"))
      .rows.map((row) => row.tablename);
    assert.ok(tables.includes('phytoemagry_logistics_companies'));
    assert.ok(tables.includes('phytoemagry_courier_company_grants'));
  });
  await verify('solicitud sin alta ni permiso automático', async () => {
    const applied = await request('/api/courier/applications', {
      companyId: 'tercera_tienda', name: 'Repartidor sintético', phone: '+18095550999',
      vehicleType: 'MOTO', zone: 'Zona UAT sintética', termsAccepted: true });
    assert.equal(applied.status, 202);
    const rows = await request('/api/admin/courier-applications?companyId=tercera_tienda', null, cookie);
    assert.equal(rows.data.applications.length, 1);
    assert.equal(rows.data.applications[0].vehicle_type, 'MOTO');
    // El solicitante puede consultar su estado con el recibo, sin abrir nada más.
    const estado = await request(`/api/courier/applications/${applied.data.applicationId}/status?receipt=${applied.data.receipt}`);
    assert.equal(estado.status, 200);
    assert.equal(estado.data.status, 'pending');
    const reviewed = await request(`/api/admin/courier-applications/${rows.data.applications[0].id}/review`,
      { companyId: 'tercera_tienda', decision: 'approved' }, cookie);
    assert.equal(reviewed.data.operational_access, false);
    await app.ctx.db.list('courier_accounts', { limit: 1 });
    assert.equal((await pg.pool.query('SELECT count(*)::int AS n FROM phytoemagry_courier_accounts')).rows[0].n, 0);
  });
  await verify('cuarentena CRM de ficha y conversación PostgreSQL', async () => {
    const made = await app.ctx.customers.findOrCreateByPhone({ phone: '8095550666',
      name: 'Histórico sintético', source: 'uat', optIn: false });
    const conversation = await app.ctx.customers.conversationFor(made.customer.id);
    const created = await request('/api/admin/users', { username: 'crm-quarantine-pg',
      displayName: 'Agente UAT', role: 'AGENT', password: 'Quarantine-Pg-123' }, cookie);
    assert.equal(created.status, 201);
    const response = await fetch(`${app.url}/api/admin/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        username: 'crm-quarantine-pg', password: 'Quarantine-Pg-123' }) });
    assert.equal(response.status, 200);
    const agentCookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(agentCookie);
    const data = await request('/api/admin/data', null, agentCookie);
    assert.equal(data.data.customers.some((row) => row.id === made.customer.id), false);
    assert.equal(data.data.conversations.some((row) => row.id === conversation.id), false);
    assert.equal((await request(`/api/admin/customers/${made.customer.id}`, null, agentCookie)).status, 404);
    assert.equal((await request(`/api/admin/conversations/${conversation.id}/messages`, null, agentCookie)).status, 404);
  });
  await verify('aislamiento de pedidos en repartidor multiempresa PostgreSQL', async () => {
    const phone = '+18095550888';
    await app.ctx.settings.write('delivery_contacts', [
      { id: 'contact-pg-uat', name: 'UAT courier', phone, shareOrders: true },
    ]);
    const created = await request('/api/admin/couriers', { kind: 'EXTERNAL', phone,
      displayName: 'Repartidor UAT', contactId: 'contact-pg-uat', appAccess: true,
      pin: '123456' }, cookie);
    assert.equal(created.status, 201);
    const courierId = created.data.courier.id;
    const grant = await request(`/api/admin/couriers/${courierId}/companies`,
      { companyId: 'fulltech', active: true }, cookie);
    assert.equal(grant.status, 200);
    const orders = [];
    for (const [companyId, suffix] of [['phytoemagry', '1'], ['fulltech', '2']]) {
      const made = await request('/api/admin/orders', { name: `Cliente UAT ${suffix}`,
        phone: `80955508${suffix}1`, status: 'nuevo', paymentMethod: 'CASH',
        items: [{ variantId: 'capsules_10', quantity: 1 }] }, cookie);
      assert.equal(made.status, 201);
      const id = made.data.item?.id ?? made.data.order?.id ?? made.data.id;
      assert.ok(id);
      const item = await app.ctx.store.getAdmin(id);
      const order = JSON.parse(item.order_json);
      if (companyId === 'fulltech') {
        order.origin = 'FULLTECH_STORE'; order.company_id = 'fulltech';
        await app.ctx.store.update(id, { orderJson: JSON.stringify(order) });
      }
      const assigned = await request(`/api/admin/orders/${id}/courier/assign`,
        { contactPhone: phone }, cookie);
      assert.equal(assigned.status, 200);
      orders.push(id);
    }
    const session = await request('/api/courier/login', { phone, pin: '123456' });
    assert.equal(session.status, 200);
    const courierGet = async (path, companyId) => {
      const response = await fetch(`${app.url}${path}`, { headers: {
        authorization: `Bearer ${session.data.token}`, 'x-courier-company': companyId } });
      return { status: response.status, data: await response.json() };
    };
    for (const [companyId, own, other] of [
      ['phytoemagry', orders[0], orders[1]], ['fulltech', orders[1], orders[0]]]) {
      const listed = await courierGet('/api/courier/orders', companyId);
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.data.orders.map((row) => row.id), [own]);
      assert.equal((await courierGet(`/api/courier/orders/${other}`, companyId)).status, 404);
    }
    assert.equal((await courierGet('/api/courier/orders', 'tercera_tienda')).status, 403);
  });
  await verify('rendición concurrente e idempotente por empresa', async () => {
    await app.ctx.db.insert('courier_accounts', { id: 'courier_pg_synthetic', company_id: 'fulltech',
      active: true, app_access: true, display_name: 'UAT synthetic' });
    await app.ctx.db.insert('courier_company_grants', { id: 'courier_pg_synthetic:fulltech',
      courier_account_id: 'courier_pg_synthetic', company_id: 'fulltech', active: true });
    await app.ctx.db.insert('delivery_cash_ledger', { id: 'charge_pg_synthetic',
      courier_account_id: 'courier_pg_synthetic', company_id: 'fulltech', order_id: null,
      kind: 'charge', amount_cents: 10000, idempotency_key: 'charge:pg:synthetic',
      created_at: new Date().toISOString() });
    const endpoint = '/api/admin/delivery-cash/remittance';
    const [a, b] = await Promise.all([
      request(endpoint, { courierAccountId: 'courier_pg_synthetic', companyId: 'fulltech',
        amountCents: 7000, idempotencyKey: 'rem:pg:a' }, cookie),
      request(endpoint, { courierAccountId: 'courier_pg_synthetic', companyId: 'fulltech',
        amountCents: 7000, idempotencyKey: 'rem:pg:b' }, cookie),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 422]);
    const winnerKey = a.status === 201 ? 'rem:pg:a' : 'rem:pg:b';
    const duplicate = await request(endpoint, { courierAccountId: 'courier_pg_synthetic',
      companyId: 'fulltech', amountCents: 7000, idempotencyKey: winnerKey }, cookie);
    assert.equal(duplicate.status, 201);
    assert.equal(duplicate.data.duplicate, true);
    assert.equal(duplicate.data.summary.pending_cents, 3000);
    const rows = (await pg.pool.query("SELECT doc FROM phytoemagry_delivery_cash_ledger WHERE kind='remittance'")).rows;
    assert.equal(rows.length, 1);
  });
  await verify('bloqueo contable y rollback de custodia ambigua', async () => {
    await app.ctx.db.insert('delivery_cash_ledger', { id: 'legacy_unresolved_pg',
      courier_account_id: 'courier_pg_synthetic', order_id: null, kind: 'remittance',
      amount_cents: 1000, idempotency_key: 'legacy:unresolved:pg',
      created_at: new Date().toISOString() });
    const denied = await request('/api/admin/delivery-cash/remittance', {
      courierAccountId: 'courier_pg_synthetic', companyId: 'fulltech',
      amountCents: 100, idempotencyKey: 'rem:pg:blocked' }, cookie);
    assert.equal(denied.status, 409);
    assert.equal(denied.data.error, 'historical_custody_unresolved');
    const count = (await pg.pool.query("SELECT count(*)::int AS n FROM phytoemagry_delivery_cash_ledger WHERE kind='remittance' AND idempotency_key='rem:pg:blocked'" )).rows[0].n;
    assert.equal(count, 0);
  });
  // Ensayo de restauración SIN tocar la base migrada: otra DB en el MISMO cluster verificado.
  await verify('rollback por restauración del respaldo previo', async () => {
    const rollbackDb = `fulltech_rollback_${pg.runId}`;
    const admin = new pgDriver.Client({ host: '127.0.0.1', port: identity.port,
      user: identity.username, database: 'postgres' });
    await admin.connect();
    try { await admin.query(`CREATE DATABASE ${rollbackDb}`); } finally { await admin.end(); }
    execFileSync(exe('pg_restore'), ['-d',
      `postgresql://${identity.username}@127.0.0.1:${identity.port}/${rollbackDb}`, backup],
      { windowsHide: true });
    const restored = new pgDriver.Client({ host: '127.0.0.1', port: identity.port,
      user: identity.username, database: rollbackDb });
    await restored.connect();
    try {
      const guard = (await restored.query('SELECT nonce FROM fulltech_uat_guard WHERE id=$1', ['isolated'])).rows[0];
      assert.equal(guard.nonce, pg.runId);
      const table = (await restored.query("SELECT to_regclass('phytoemagry_logistics_companies') AS name")).rows[0];
      assert.equal(table.name, null);
    } finally { await restored.end(); }
  });
  process.stdout.write(`POSTGRES_LOGISTICS_UAT ${checks.length}/${checks.length}\n`);
} finally {
  await app?.close();
  await pg.stop();
}
