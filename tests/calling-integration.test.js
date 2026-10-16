// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqlQuery } from '../server/sql-query.mjs';
import { createCallingStore } from '../server/calling-store.mjs';
import { createCallingService, publicCall } from '../server/calling-service.mjs';
import { callPermission, createCallingApi, validCallSdp } from '../server/calling-api.mjs';
import { startCrmServer } from '../server/crm-server.mjs';

const SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n';
const actor = { id: 'agent1', display_name: 'Agente 1' };
const customer = { id: 'cus1', name: 'Cliente', phone_e164: '+18095550001' };
const conversation = { id: 'conv1', customer_id: customer.id };
const payload = (calls, extra = {}) => ({ object: 'whatsapp_business_account', entry: [{ id: '678', changes: [{ field: 'calls', value: {
  metadata: { phone_number_id: '123' }, calls, ...extra,
} }] }] });

describe('voz: permisos y transporte', () => {
  it('respeta vigencia y límites publicados por Meta, sin inventar permisos', () => {
    const actions = [{ action_name: 'start_call', can_perform_action: true }];
    expect(callPermission({ permission: { status: 'temporary', expiration_time: 100 }, actions }, 101000).canCall).toBe(false);
    expect(callPermission({ permission: { status: 'permanent' }, actions }).canCall).toBe(true);
    expect(callPermission({ permission: { status: 'permanent' }, actions: [] }).canCall).toBe(false);
    expect(callPermission({ permission: { status: 'granted' }, actions }).canCall).toBe(false);
  });
  it('desactivado no envía solicitudes; video o SDP enorme no se aceptan', async () => {
    const fetchImpl = vi.fn();
    const api = createCallingApi({ fetchImpl });
    expect((await api.action('connect', { phone: '18095550001', sdp: SDP })).error).toBe('calling_disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(validCallSdp(SDP)).toBe(true);
    expect(validCallSdp(`${SDP}m=video 9 UDP/TLS/RTP/SAVPF 96\r\n`)).toBe(false);
    expect(validCallSdp(`${SDP}${'a'.repeat(50000)}`)).toBe(false);
  });
  it('usa el phone number ID y el contrato oficial para conectar sin revelar tokens', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ calls: [{ id: 'wacid.test' }] })));
    const api = createCallingApi({ enabled: true, env: { WHATSAPP_ACCESS_TOKEN: 'secret', WHATSAPP_PHONE_NUMBER_ID: '123' }, fetchImpl });
    expect(await api.action('connect', { phone: '18095550001', sdp: SDP, reference: 'local' })).toEqual({ ok: true, callId: 'wacid.test' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://graph.facebook.com/v21.0/123/calls');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ action: 'connect', to: '18095550001', session: { sdp_type: 'offer', sdp: SDP } });
  });
  it('un error de servidor de Meta es incierto y no habilita un reenvío automático', async () => {
    const api = createCallingApi({ enabled: true, env: { WHATSAPP_ACCESS_TOKEN: 'secret', WHATSAPP_PHONE_NUMBER_ID: '123' },
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: 1 } }), { status: 500 }) });
    expect(await api.action('connect', { phone: '18095550001', sdp: SDP })).toMatchObject({ ok: false, uncertain: true, error: 'meta_calling_unconfirmed' });
  });
});

describe('voz: persistencia, concurrencia y recuperación', () => {
  let handle, store, api, service, now;
  beforeEach(async () => {
    handle = new DatabaseSync(':memory:');
    store = await createCallingStore(createSqlQuery({ backend: 'sqlite', handle }));
    now = Date.now();
    api = { enabled: true, phoneNumberId: '123', businessAccountId: '678',
      permission: vi.fn(async () => ({ ok: true, permission: { canCall: true, canRequest: true } })),
      action: vi.fn(async (_, { callId }) => ({ ok: true, callId: callId ?? 'wacid.out' })),
      requestPermission: vi.fn(async () => ({ ok: true, messageId: 'wamid.permission' })) };
    service = createCallingService({ store, api, enabled: true, clock: () => now,
      customers: { findOrCreateByPhone: async () => ({ ok: true, customer }), recordOutbound: vi.fn() },
      db: { findBy: async () => conversation } });
  });
  afterEach(async () => { await service.stop(); handle.close(); });
  const input = (action, body = {}, a = actor) => ({ action, conversation, customer, actor: a, body, canSendFreeText: true });

  it('un reintento simultáneo inicia una sola llamada', async () => {
    const body = { sdp: SDP, requestId: randomUUID() };
    const results = await Promise.all([service.perform(input('connect', body)), service.perform(input('connect', body))]);
    expect(api.action.mock.calls.filter(([a]) => a === 'connect')).toHaveLength(1);
    expect(results.some((r) => r.ok)).toBe(true);
  });
  it('un agente o conversación ocupados no generan otra llamada', async () => {
    await service.perform(input('connect', { sdp: SDP, requestId: randomUUID() }));
    const second = await service.perform(input('connect', { sdp: SDP, requestId: randomUUID() }));
    expect(second.error).toBe('call_busy');
    expect(api.action).toHaveBeenCalledTimes(1);
  });
  it('sin permiso o con opt-out nunca inicia la llamada', async () => {
    api.permission.mockResolvedValue({ ok: true, permission: { canCall: false } });
    expect((await service.perform(input('connect', { sdp: SDP, requestId: randomUUID() }))).error).toBe('call_permission_required');
    expect((await service.perform({ ...input('connect'), customer: { ...customer, do_not_contact: true } })).error).toBe('do_not_contact');
    expect(api.action).not.toHaveBeenCalled();
  });
  it('requiere ventana abierta y evita solicitudes de permiso duplicadas', async () => {
    expect((await service.perform({ ...input('permission'), canSendFreeText: false })).error).toBe('permission_requires_open_window');
    await Promise.all([service.perform(input('permission')), service.perform(input('permission'))]);
    expect(api.requestPermission).toHaveBeenCalledTimes(1);
  });
  it('guarda el webhook antes de procesarlo y elimina el SDP del evento al terminar', async () => {
    const started = await service.perform(input('connect', { sdp: SDP, requestId: randomUUID() }));
    const e = payload([{ id: 'wacid.out', event: 'connect', direction: 'BUSINESS_INITIATED', timestamp: '10', session: { sdp_type: 'answer', sdp: SDP } }]);
    await service.ingest(e); await service.ingest(e);
    expect(await store.pending()).toHaveLength(1);
    await service.tick();
    const call = await store.get(started.call.id);
    expect(call.remoteSdp.sdp).toBe(SDP);
    expect(await store.pending()).toHaveLength(0);
    expect(handle.prepare('SELECT payload FROM phytoemagry_call_events_v1').get().payload).toBeNull();
    expect(publicCall(call, { id: 'other' }, true).remoteSession).toBeUndefined();
    expect(publicCall(call, actor).remoteSdp).toBeUndefined();
  });
  it('un evento tardío no revive una llamada terminada y limpia el SDP', async () => {
    const started = await service.perform(input('connect', { sdp: SDP, requestId: randomUUID() }));
    await service.ingest(payload([{ id: 'wacid.out', event: 'terminate', timestamp: '20', duration: 3 }])); await service.tick();
    await service.ingest(payload([{ id: 'wacid.out', event: 'connect', timestamp: '10', session: { sdp_type: 'answer', sdp: SDP } }])); await service.tick();
    expect(await store.get(started.call.id)).toMatchObject({ status: 'completed', remoteSdp: null });
  });
  it('el SDP recibido después de ACCEPTED sigue estableciendo audio sin retroceder el estado', async () => {
    const started = await service.perform(input('connect', { sdp: SDP, requestId: randomUUID() }));
    await service.ingest(payload([], { statuses: [{ id: 'wacid.out', status: 'ACCEPTED', timestamp: '20', type: 'call' }] })); await service.tick();
    await service.ingest(payload([{ id: 'wacid.out', event: 'connect', timestamp: '10', session: { sdp_type: 'answer', sdp: SDP } }])); await service.tick();
    expect(await store.get(started.call.id)).toMatchObject({ status: 'active', remoteSdp: { sdp: SDP } });
  });
  it('el webhook final completa la duración incluso si el agente ya colgó', async () => {
    const started = await service.perform(input('connect', { sdp: SDP, requestId: randomUUID() }));
    await service.perform(input('terminate', { id: started.call.id }));
    await service.ingest(payload([{ id: 'wacid.out', event: 'terminate', timestamp: '30', duration: 15 }])); await service.tick();
    expect(await store.get(started.call.id)).toMatchObject({ status: 'completed', duration: 15, remoteSdp: null });
  });
  it('no permite reutilizar el id de operación para leer otra conversación', async () => {
    const body = { sdp: SDP, requestId: randomUUID() };
    await service.perform(input('connect', body));
    const result = await service.perform({ ...input('connect', body), conversation: { ...conversation, id: 'other-conversation' } });
    expect(result.error).toBe('invalid_request_id');
  });
  it('ignora eventos de otro WABA o número', async () => {
    const e = payload([{ id: 'wacid.in', event: 'connect', from: '18095550001', timestamp: '10', session: { sdp_type: 'offer', sdp: SDP } }]);
    e.entry[0].id = 'other'; await service.ingest(e);
    expect(await store.pending()).toHaveLength(0);
    e.entry[0].id = '678'; e.entry[0].changes[0].value.metadata.phone_number_id = 'other'; await service.ingest(e);
    expect(await store.pending()).toHaveLength(0);
  });
  it('dos agentes intentan atender y solo uno obtiene la reserva', async () => {
    await service.ingest(payload([{ id: 'wacid.in', event: 'connect', from: '18095550001', timestamp: '10', session: { sdp_type: 'offer', sdp: SDP } }])); await service.tick();
    const [call] = await service.incoming();
    const results = await Promise.all([service.perform(input('pre_accept', { id: call.id, sdp: SDP })), service.perform(input('pre_accept', { id: call.id, sdp: SDP }, { id: 'agent2' }))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(api.action.mock.calls.filter(([a]) => a === 'pre_accept')).toHaveLength(1);
  });
  it('recibe y acepta identificadores opacos con caracteres Base64 sin descartarlos', async () => {
    const id = 'wacid.ABC+/def==';
    await service.ingest(payload([{ id, event: 'connect', from: '18095550001', session: { sdp_type: 'offer', sdp: SDP } }]));
    await service.tick();
    const [call] = await service.incoming();
    expect(call.metaId).toBe(id);
    expect((await service.perform(input('pre_accept', { id: call.id, sdp: SDP }))).ok).toBe(true);
    expect(api.action).toHaveBeenCalledWith('pre_accept', { callId: id, sdp: SDP });
  });
  it('un timeout de Meta se conserva como operación incierta para no repetir la llamada', async () => {
    api.action.mockResolvedValue({ ok: false, error: 'meta_calling_unconfirmed', uncertain: true });
    const body = { sdp: SDP, requestId: randomUUID() };
    const result = await service.perform(input('connect', body));
    expect(result.call.id).toBeTruthy();
    await service.perform(input('connect', body));
    expect(api.action).toHaveBeenCalledTimes(1);
  });
  it('al desaparecer el navegador termina la sesión tras el plazo de heartbeat', async () => {
    const result = await service.perform(input('connect', { sdp: SDP, requestId: randomUUID() }));
    now += 46000; await service.tick();
    expect(api.action).toHaveBeenLastCalledWith('terminate', { callId: 'wacid.out' });
    expect((await store.get(result.call.id)).status).toBe('failed');
  });
});

describe('voz: rutas autenticadas y webhook real', () => {
  let app, dir, cookie, conv;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'phyto-calling-'));
    app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: path.join(dir, 'crm.sqlite'), token: 'test-calling-key',
      quiet: true, schedulerEnabled: false, metaAppSecret: 'test-app-secret', callingEnabled: true,
      callingApi: { enabled: true, phoneNumberId: '123', businessAccountId: '678',
        permission: async () => ({ ok: true, permission: { canCall: true } }), action: async () => ({ ok: true, callId: 'wacid.http' }) } });
    const login = await fetch(`${app.url}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'test-calling-key' }) });
    cookie = login.headers.get('set-cookie').split(';')[0];
    const found = await app.customers.findOrCreateByPhone({ phone: '18095550001' });
    conv = await app.collections.findBy('conversations', 'customer_id', found.customer.id);
  });
  afterEach(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  it('sin sesión no revela llamadas y con origen ajeno no acepta acciones', async () => {
    expect((await fetch(`${app.url}/api/admin/calling/incoming`)).status).toBe(401);
    expect((await fetch(`${app.url}/api/admin/conversations/${conv.id}/calling/connect`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  });
  it('webhook firmado queda en la bandeja durable antes del HTTP 200; firma falsa no ingresa', async () => {
    const raw = JSON.stringify(payload([{ id: 'wacid.http-in', event: 'connect', from: '18095550001', timestamp: '10', session: { sdp_type: 'offer', sdp: SDP } }]));
    const signature = `sha256=${createHmac('sha256', 'test-app-secret').update(raw).digest('hex')}`;
    const post = (sig) => fetch(`${app.url}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
    expect((await post('sha256=invalid')).status).toBe(401);
    expect((await post(signature)).status).toBe(200);
    const sql = createSqlQuery({ backend: 'sqlite', handle: app.store.handle });
    const count = await sql.query('SELECT COUNT(*) AS n FROM phytoemagry_call_events_v1');
    expect(Number(count.rows[0].n)).toBe(1);
    expect(await app.collections.count('wa_messages')).toBe(0);
  });
});
