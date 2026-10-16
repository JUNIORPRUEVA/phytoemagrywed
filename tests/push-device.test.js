// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
const previous = { public: process.env.PHYTO_WEB_PUSH_PUBLIC_KEY, private: process.env.PHYTO_WEB_PUSH_PRIVATE_KEY };
process.env.PHYTO_WEB_PUSH_PUBLIC_KEY = keys.publicKey;
process.env.PHYTO_WEB_PUSH_PRIVATE_KEY = keys.privateKey;
const { startCrmServer } = await import('../server/crm-server.mjs');
let app, directory, cookie, iphone, android;
let send;
const request = async (route, body) => {
  const response = await fetch(`${app.url}/api/admin/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie || '' }, body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
};

beforeAll(async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'phyto-push-device-'));
  app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: path.join(directory, 'test.sqlite'), token: 'push-device-token', quiet: true, bootstrapAdminUser: 'push-device@phyto.local', bootstrapAdminPassword: 'PushDevice-12345', schedulerEnabled: false });
  const login = await request('auth/login', { username: 'push-device@phyto.local', password: 'PushDevice-12345' });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  iphone = (await request('push-subscriptions', { endpoint: 'https://web.push.apple.com/test-iphone', keys: { p256dh: 'test', auth: 'test' } })).body.subscription.id;
  android = (await request('push-subscriptions', { endpoint: 'https://fcm.googleapis.com/test-android', keys: { p256dh: 'test', auth: 'test' } })).body.subscription.id;
});
beforeEach(() => { send = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201 }); });
afterAll(async () => {
  await app?.close();
  rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of [['PHYTO_WEB_PUSH_PUBLIC_KEY', previous.public], ['PHYTO_WEB_PUSH_PRIVATE_KEY', previous.private]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe('prueba push del dispositivo actual', () => {
  it('envía únicamente al iPhone solicitado, con entrega urgente y cifrado estándar', async () => {
    const result = await request('push-subscriptions/test', { subscriptionId: iphone });
    expect(result.body.push).toMatchObject({ subscriptions: 1, sent: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].endpoint).toBe('https://web.push.apple.com/test-iphone');
    expect(send.mock.calls[0][2]).toMatchObject({ urgency: 'high', contentEncoding: 'aes128gcm', TTL: 86400, timeout: 15000 });
  });
  it('rechaza un teléfono de otro usuario sin enviar a los demás', async () => {
    await app.collections.insert('push_subscriptions', { id: 'other-device', user_id: 'other-user', endpoint: 'https://web.push.apple.com/other', active: true });
    const result = await request('push-subscriptions/test', { subscriptionId: 'other-device' });
    expect(result.response.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });
  it('conserva BadJwtToken para diagnosticar el rechazo de Apple', async () => {
    send.mockRejectedValue({ statusCode: 403, message: 'Push rejected', body: '{"reason":"BadJwtToken"}' });
    const result = await request('push-subscriptions/test', { subscriptionId: iphone });
    expect(result.body.ok).toBe(false);
    expect(result.body.message).toContain('BadJwtToken');
    expect(result.body.push.errors).toEqual([{ statusCode: 403, reason: 'BadJwtToken' }]);
    expect((await app.collections.get('push_subscriptions', iphone)).last_error.reason).toBe('BadJwtToken');
    expect((await app.collections.get('push_subscriptions', iphone)).active).toBe(true);
  });
  it('el worker confirma sin cookie y el estado diferencia aceptación de creación del aviso', async () => {
    const sent = await request('push-subscriptions/test', { subscriptionId: iphone });
    const receipt = JSON.parse(send.mock.calls[0][1]).receipt;
    const response = await fetch(`${app.url}/api/push/receipts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...receipt, status: 'displayed', workerVersion: 'test-worker' }),
    });
    expect(response.status).toBe(200);
    const job = await app.collections.get('push_jobs', receipt.jobId);
    expect(job.status).toBe('sent');
    expect(job.device_status).toBe('displayed');
    const status = await fetch(`${app.url}/api/admin/push-status`, { headers: { cookie } }).then((r) => r.json());
    const visible = status.push.recentJobs.find((row) => row.notification_id === sent.body.notification.id);
    expect(visible).toMatchObject({ deviceStatus: 'displayed', workerVersion: 'test-worker' });
    expect(JSON.stringify(visible)).not.toContain(receipt.token);
    const downgrade = await fetch(`${app.url}/api/push/receipts`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...receipt, status: 'display_failed', error: 'NotAllowedError' }),
    });
    expect(downgrade.status).toBe(200);
    expect((await app.collections.get('push_jobs', receipt.jobId)).device_status).toBe('displayed');
  });
  it('rechaza una confirmación falsificada sin modificar el envío', async () => {
    await request('push-subscriptions/test', { subscriptionId: iphone });
    const receipt = JSON.parse(send.mock.calls[0][1]).receipt;
    const response = await fetch(`${app.url}/api/push/receipts`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...receipt, token: '0'.repeat(64), status: 'displayed' }),
    });
    expect(response.status).toBe(403);
    expect((await app.collections.get('push_jobs', receipt.jobId)).device_status).toBeUndefined();
  });
  it('conserva el fallo de showNotification aunque el proveedor haya aceptado el push', async () => {
    await request('push-subscriptions/test', { subscriptionId: iphone });
    const receipt = JSON.parse(send.mock.calls[0][1]).receipt;
    await fetch(`${app.url}/api/push/receipts`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...receipt, status: 'display_failed', error: 'NotAllowedError' }),
    });
    expect(await app.collections.get('push_jobs', receipt.jobId)).toMatchObject({ status: 'sent', device_status: 'display_failed', device_error: 'NotAllowedError' });
  });
  it('conserva una confirmación que llega antes de la respuesta del proveedor', async () => {
    send.mockImplementation(async (subscription, payload) => {
      const receipt = JSON.parse(payload).receipt;
      const response = await fetch(`${app.url}/api/push/receipts`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...receipt, status: 'displayed' }),
      });
      expect(response.status).toBe(200);
      return { statusCode: 201 };
    });
    const result = await request('push-subscriptions/test', { subscriptionId: iphone });
    const job = result.body.status.recentJobs.find((row) => row.notification_id === result.body.notification.id);
    expect(job).toMatchObject({ status: 'sent', deviceStatus: 'displayed' });
  });
  it('da de baja un endpoint expirado sin afectar al otro teléfono', async () => {
    send.mockRejectedValue({ statusCode: 410, message: 'Gone', body: '{"reason":"Unregistered"}' });
    const result = await request('push-subscriptions/test', { subscriptionId: iphone });
    expect(result.body.push.expired).toBe(1);
    expect((await app.collections.get('push_subscriptions', iphone)).active).toBe(false);
    expect((await app.collections.get('push_subscriptions', android)).active).toBe(true);
  });
});
