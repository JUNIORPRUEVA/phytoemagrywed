import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAiChatControlsRoute } from './ai-chat-controls-routes.mjs';

function fixture(permissions = ['chats.read', 'chats.reply', 'settings.manage']) {
  let global = null;
  const conversation = { id: 'chat-1' };
  const audit = [];
  const ctx = {
    settings: {
      read: async () => global,
      write: async (_key, value) => { global = { value }; },
    },
    db: {
      get: async (_collection, id) => id === conversation.id ? conversation : null,
      update: async (_collection, _id, patch) => Object.assign(conversation, patch),
    },
    audit: { record: async (entry) => audit.push(entry) },
  };
  const call = async (route, method = 'GET', body = {}) => {
    let response;
    const handled = await handleAiChatControlsRoute({
      req: { method }, res: {}, route, ctx,
      actor: { display_name: 'Prueba' },
      can: (permission) => permissions.includes(permission),
      canOpen: async () => true,
      readJson: async () => body,
      json: (_res, status, data) => { response = { status, data }; },
    });
    assert.equal(handled, true);
    return response;
  };
  return { call, audit, conversation };
}

test('el ajuste general y la excepción por chat sobreviven a lecturas posteriores', async () => {
  const { call, audit } = fixture();
  const base = '/api/admin/ai/chat-controls';
  assert.equal((await call(base)).data.enabled, false);
  assert.equal((await call(base, 'POST', { enabled: true })).data.enabled, true);
  assert.equal((await call(`${base}/chat-1`)).data.effectiveEnabled, true);
  assert.equal((await call(`${base}/chat-1`, 'POST', { mode: 'off' })).data.effectiveEnabled, false);
  assert.equal((await call(`${base}/chat-1`)).data.mode, 'off');
  assert.equal((await call(base, 'POST', { enabled: false })).data.enabled, false);
  assert.equal((await call(`${base}/chat-1`, 'POST', { mode: 'on' })).data.effectiveEnabled, true);
  assert.equal((await call(`${base}/chat-1`)).data.automationReady, false);
  assert.equal(audit.length, 4);
});

test('solo administración cambia el ajuste general y solo un usuario autorizado cambia su chat', async () => {
  const base = '/api/admin/ai/chat-controls';
  const agent = fixture(['chats.read', 'chats.reply']);
  assert.equal((await agent.call(base, 'POST', { enabled: true })).status, 403);
  assert.equal((await agent.call(`${base}/chat-1`, 'POST', { mode: 'on' })).status, 200);
  assert.equal((await agent.call(`${base}/chat-1`, 'POST', { mode: 'invalid' })).status, 400);
  const reader = fixture(['chats.read']);
  assert.equal((await reader.call(`${base}/chat-1`, 'POST', { mode: 'on' })).status, 403);
});
