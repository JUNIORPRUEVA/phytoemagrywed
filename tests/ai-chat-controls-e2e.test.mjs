import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';
import { createWhatsAppClient } from '../server/whatsapp.mjs';

const token = 'local-ai-control-test';
const aiAnswer = {
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: 'Claro, te ayudo con eso.' }) } }] }),
};

test('A y B conservan sus excepciones tras reiniciar el backend; ningún control envía mensajes', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'phyto-ai-controls-'));
  const dataFile = join(folder, 'uat.sqlite');
  const wa = createWhatsAppClient({ mock: true, log: false });
  let sendCalls = 0;
  const whatsapp = {
    ...wa,
    sendText: (...args) => { sendCalls += 1; return wa.sendText(...args); },
    sendTemplate: (...args) => { sendCalls += 1; return wa.sendTemplate(...args); },
    sendInteractive: (...args) => { sendCalls += 1; return wa.sendInteractive(...args); },
  };
  let app;
  let cookie = '';
  const start = async () => {
    app = await startCrmServer({
      port: 0, host: '127.0.0.1', dataFile, token, quiet: true,
      schedulerEnabled: false, whatsapp,
      proofreadingFetch: async () => aiAnswer,
    });
    const login = await fetch(`${app.url}/api/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    assert.equal(login.status, 200);
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  };
  const request = async (route, body) => {
    const response = await fetch(`${app.url}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  const base = '/api/admin/ai/chat-controls';
  try {
    await start();
    const a = await app.customers.findOrCreateByPhone({ phone: '+18095551001', name: 'A Prueba', source: 'uat' });
    const b = await app.customers.findOrCreateByPhone({ phone: '+18095551002', name: 'B Prueba', source: 'uat' });
    const chatA = await app.customers.conversationFor(a.customer.id);
    const chatB = await app.customers.conversationFor(b.customer.id);
    const aRoute = `${base}/${encodeURIComponent(chatA.id)}`;
    const bRoute = `${base}/${encodeURIComponent(chatB.id)}`;

    assert.equal((await request(base)).enabled, false);
    assert.equal((await request(aRoute, { mode: 'on' })).effectiveEnabled, true);
    assert.equal((await request(bRoute)).effectiveEnabled, false);
    assert.equal((await request(base, { enabled: true })).enabled, true);
    assert.equal((await request(bRoute, { mode: 'off' })).effectiveEnabled, false);

    await app.close();
    await start();
    assert.equal((await request(aRoute)).effectiveEnabled, true);
    assert.equal((await request(bRoute)).effectiveEnabled, false);
    assert.equal((await request(bRoute, { mode: 'inherit' })).effectiveEnabled, true);
    assert.equal((await request(base, { enabled: false })).enabled, false);
    assert.equal((await request(bRoute)).effectiveEnabled, false);
    assert.equal((await request(aRoute)).effectiveEnabled, true);

    await app.collections.insert('wa_messages', {
      id: 'ai_control_inbound', conversation_id: chatA.id, customer_id: a.customer.id,
      direction: 'inbound', type: 'text', body: 'Hola, necesito información.',
      created_at: new Date().toISOString(),
    });
    await app.ctx.proofreading.save({ apiKey: 'sk-fake-test-not-a-real-key-123456', enabled: true, dailyLimit: 10 });
    const suggestion = await request('/api/admin/ai/reply-suggestion', { conversationId: chatA.id });
    assert.equal(suggestion.ai, true);
    assert.equal(suggestion.text, 'Claro, te ayudo con eso.');
    const messages = await app.collections.list('wa_messages', { limit: 100 });
    assert.equal(messages.filter((row) => row.direction === 'outbound').length, 0);
    assert.equal(sendCalls, 0);
  } finally {
    await app?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
