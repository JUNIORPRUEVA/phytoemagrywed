// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';
import { crmCompanyEvidence } from '../server/logistics-tenancy.mjs';

const order = (id, customerId, conversationId, companyId) => ({ type: 'order_intent', id,
  order_json: JSON.stringify({ id, customer_id: customerId, conversation_id: conversationId,
    company_id: companyId, items: [] }) });

describe('cuarentena de identidad CRM', () => {
  it('no infiere la empresa del chat por compartir cliente y pone conflictos en cuarentena', () => {
    const evidence = crmCompanyEvidence([
      order('p1', 'mixed', 'phyto-chat', 'phytoemagry'),
      order('p2', 'mixed', 'fulltech-chat', 'fulltech'),
      order('p3', 'phyto-only', null, 'phytoemagry'),
    ]);
    expect(evidence.customer('mixed')).toBeNull();
    expect(evidence.customer('phyto-only')).toBe('phytoemagry');
    expect(evidence.conversation('phyto-chat')).toBe('phytoemagry');
    expect(evidence.conversation('fulltech-chat')).toBe('fulltech');
    expect(evidence.conversation({ id: 'unlinked', customer_id: 'phyto-only' })).toBeNull();
    expect(evidence.conversation({ id: 'phyto-chat', company_id: 'fulltech' })).toBeNull();
    const legacy = crmCompanyEvidence([{ type: 'order_intent', id: 'legacy-capsules',
      customer_id: 'legacy-customer', variant_id: 'capsules_5', capsules: 5 }]);
    expect(legacy.customer('legacy-customer')).toBe('phytoemagry');
    const unproven = crmCompanyEvidence([{ type: 'order_intent', id: 'legacy-unknown',
      customer_id: 'unknown-customer', variant_name: '5 cápsulas' }]);
    expect(unproven.customer('unknown-customer')).toBeNull();
  });

  let app; let dir; let adminCookie; let agentCookie; let agentId;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crm-company-quarantine-'));
    app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: join(dir, 'uat.sqlite'),
      token: 'quarantine-uat', quiet: true, schedulerEnabled: false,
      whatsapp: { enabled: false }, metaCapi: { enabled: false } });
    const login = async (body) => {
      const response = await fetch(`${app.url}/api/admin/login`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return response.headers.get('set-cookie').split(';')[0];
    };
    adminCookie = await login({ token: 'quarantine-uat' });
    const created = await fetch(`${app.url}/api/admin/users`, { method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'agent-quarantine', displayName: 'Agente UAT',
        role: 'AGENT', password: 'Quarantine-Uat-123' }) });
    expect(created.status).toBe(201);
    agentId = (await created.json()).user.id;
    agentCookie = await login({ username: 'agent-quarantine', password: 'Quarantine-Uat-123' });
  });
  afterEach(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });
  const get = async (app, route, cookie) => {
    const response = await fetch(`${app.url}${route}`, { headers: { cookie } });
    return { status: response.status, data: await response.json() };
  };

  it('oculta ficha y conversación sin empresa de listas e IDs; superadmin conserva revisión', async () => {
    const made = await app.ctx.customers.findOrCreateByPhone({ phone: '8095557711',
      name: 'Histórico UAT', source: 'uat', optIn: false });
    const customer = made.customer;
    const conversation = await app.ctx.customers.conversationFor(customer.id);
    const listed = await get(app, '/api/admin/data', agentCookie);
    expect(listed.status).toBe(200);
    expect(listed.data.customers.some((row) => row.id === customer.id)).toBe(false);
    expect(listed.data.conversations.some((row) => row.id === conversation.id)).toBe(false);
    expect((await get(app, `/api/admin/customers/${customer.id}`, agentCookie)).status).toBe(404);
    expect((await get(app, `/api/admin/conversations/${conversation.id}/messages`, agentCookie)).status).toBe(404);
    expect((await get(app, '/api/admin/customers', agentCookie)).data.customers.some((row) => row.id === customer.id)).toBe(false);
    expect((await get(app, '/api/admin/conversations', agentCookie)).data.conversations.some((row) => row.id === conversation.id)).toBe(false);
    expect((await get(app, `/api/admin/customers/${customer.id}`, adminCookie)).status).toBe(200);
    await app.ctx.db.update('customers', customer.id, { company_id: 'phytoemagry' });
    await app.ctx.db.update('conversations', conversation.id, { company_id: 'phytoemagry' });
    await app.ctx.customers.assignConversation(conversation.id, { userId: agentId });
    expect((await get(app, '/api/admin/customers', agentCookie)).data.customers.some((row) => row.id === customer.id)).toBe(true);
    expect((await get(app, '/api/admin/conversations', agentCookie)).data.conversations.some((row) => row.id === conversation.id)).toBe(true);
    const profile = await get(app, `/api/admin/customers/${customer.id}`, agentCookie);
    expect(profile.status).toBe(200);
    expect(profile.data.history).toBeNull();
    expect(profile.data.store_account).toBeNull();
    await app.ctx.db.update('conversations', conversation.id, { company_id: 'fulltech' });
    expect((await get(app, `/api/admin/customers/${customer.id}`, agentCookie)).status).toBe(404);
  });
});
