// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/admin/sw.js', import.meta.url), 'utf8');
describe('cada push produce un aviso visible, requisito de Safari', () => {
  it.each(['valid', 'empty', 'invalid', 'null', 'array'])('%s', async (kind) => {
    const handlers = new Map();
    const showNotification = vi.fn().mockResolvedValue(undefined);
    vm.runInNewContext(source, { URL, self: { location: { origin: 'https://crm.example' }, registration: { showNotification }, addEventListener: (type, handler) => handlers.set(type, handler) } });
    let pending;
    const values = { valid: { title: 'Mensaje nuevo', body: 'Hola', conversationId: 'conv-123' }, null: null, array: [] };
    const data = kind === 'empty' ? null : { json() { if (kind === 'invalid') throw new SyntaxError('bad JSON'); return values[kind]; } };
    handlers.get('push')({ data, waitUntil: (promise) => { pending = promise; } });
    expect(pending).toBeDefined();
    await pending;
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][0]).toBe(kind === 'valid' ? 'Mensaje nuevo' : 'Phytoemagry');
    if (kind === 'valid') expect(showNotification.mock.calls[0][1].data.deepLink).toBe('/admin/?v=whatsapp&conversation=conv-123');
  });
});

describe('confirmación del worker independiente de la cookie de sesión', () => {
  function worker({ notificationError, networkError } = {}) {
    const handlers = new Map();
    const calls = [];
    const showNotification = vi.fn(async () => { calls.push('show'); if (notificationError) throw notificationError; });
    const fetch = vi.fn(async (url, options) => { calls.push('report'); if (networkError) throw new Error('offline'); return { ok: true }; });
    vm.runInNewContext(source, { URL, AbortController, setTimeout, clearTimeout, fetch, self: { location: { origin: 'https://crm.example' }, registration: { showNotification }, addEventListener: (type, handler) => handlers.set(type, handler) } });
    let pending;
    handlers.get('push')({ data: { json: () => ({ title: 'Prueba', receipt: { jobId: 'psh-123', token: 'test-token' } }) }, waitUntil: (promise) => { pending = promise; } });
    return { pending, calls, fetch };
  }
  it('muestra antes de llamar a red y confirma sin cookies', async () => {
    const test = worker();
    await test.pending;
    expect(test.calls).toEqual(['show', 'report']);
    expect(test.fetch.mock.calls[0][0]).toBe('/api/push/receipts');
    expect(test.fetch.mock.calls[0][1].credentials).toBe('omit');
    expect(JSON.parse(test.fetch.mock.calls[0][1].body)).toMatchObject({ status: 'displayed', jobId: 'psh-123' });
  });
  it('informa el error del sistema al crear el aviso', async () => {
    const error = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const test = worker({ notificationError: error });
    await expect(test.pending).rejects.toBe(error);
    expect(JSON.parse(test.fetch.mock.calls[0][1].body)).toMatchObject({ status: 'display_failed', error: 'NotAllowedError' });
  });
  it('un fallo del diagnóstico no impide mostrar la notificación', async () => {
    const test = worker({ networkError: true });
    await expect(test.pending).resolves.toBeUndefined();
    expect(test.calls[0]).toBe('show');
  });
});
