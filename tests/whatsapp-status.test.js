// @vitest-environment node
/**
 * ESTADO DE WHATSAPP — una sola fuente de verdad.
 *
 * Lo que se comprueba aquí es exactamente el fallo reportado: el panel decía
 * «no configurado» (y con dos textos distintos) sin distinguir entre credencial
 * ausente, token rechazado, Meta caído o todo funcionando. Un timeout NO puede
 * convertirse en «faltan variables».
 */
import { describe, expect, it, vi } from 'vitest';
import { createWhatsAppStatus } from '../server/whatsapp-status.mjs';

const ENABLED = { enabled: true, mock: false, graphVersion: 'v21.0', listTemplates: vi.fn() };
const webhook = { verifyToken: 'verify-token', appSecret: 'app-secret' };

describe('estado de WhatsApp', () => {
  it('sin credenciales: envío y recepción no configurados, con motivo', async () => {
    const status = createWhatsAppStatus({ whatsapp: { enabled: false, mock: false }, ...webhook });
    const snapshot = status.snapshot();
    expect(snapshot.configured).toBe(false);
    expect(snapshot.mode).toBe('off');
    expect(snapshot.send).toBe('not_configured');
    expect(snapshot.receive).toBe('not_configured');
    expect(await status.probe()).toMatchObject({ send: 'not_configured', reason: 'missing_credentials' });
  });

  it('credenciales presentes pero sin token de webhook: puede enviar y NO recibe', async () => {
    const whatsapp = { ...ENABLED, listTemplates: vi.fn(async () => ({ ok: true, templates: [{ name: 'x' }] })) };
    const status = createWhatsAppStatus({ whatsapp, verifyToken: '', appSecret: 'app-secret' });
    await status.probe();
    const snapshot = status.snapshot();
    expect(snapshot.send).toBe('ok');
    expect(snapshot.receive).toBe('not_configured');
    expect(snapshot.reason).toBeNull();
    expect(snapshot.canSend).toBe(true);
  });

  it('todo bien: sin motivo y enviable', async () => {
    const whatsapp = { ...ENABLED, listTemplates: vi.fn(async () => ({ ok: true, templates: [] })) };
    const status = createWhatsAppStatus({ whatsapp, ...webhook });
    const probed = await status.probe();
    expect(probed.send).toBe('ok');
    const snapshot = status.snapshot();
    expect(snapshot.send).toBe('ok');
    expect(snapshot.receive).toBe('ok');
    expect(snapshot.canSend).toBe(true);
    expect(snapshot.reason).toBeNull();
  });

  it('Meta caída o timeout: DESCONOCIDO, nunca «no configurado»', async () => {
    const whatsapp = { ...ENABLED, listTemplates: vi.fn(async () => ({ ok: false, error: { message: 'fetch failed' } })) };
    const status = createWhatsAppStatus({ whatsapp, ...webhook });
    const probed = await status.probe();
    expect(probed.send).toBe('unknown');
    expect(probed.reason).toBe('unreachable');
    const snapshot = status.snapshot();
    expect(snapshot.send).toBe('unknown');
    expect(snapshot.canSend).toBe(false);
    expect(snapshot.reason).not.toBe('missing_credentials');
  });

  it('token rechazado por Meta (190/401) se informa como credencial inválida', async () => {
    const whatsapp = { ...ENABLED, listTemplates: vi.fn(async () => ({ ok: false, status: 401, error: { code: 190, message: 'Invalid OAuth access token' } })) };
    const status = createWhatsAppStatus({ whatsapp, ...webhook });
    const probed = await status.probe();
    expect(probed.send).toBe('token_invalid');
    expect(probed.reason).toBe('token_invalid');
    expect(status.snapshot().canSend).toBe(false);
  });

  it('un error 500 no se confunde con credencial inválida', async () => {
    const whatsapp = { ...ENABLED, listTemplates: vi.fn(async () => ({ ok: false, status: 500, error: { code: 1, message: 'Unknown error' } })) };
    const status = createWhatsAppStatus({ whatsapp, ...webhook });
    expect((await status.probe()).send).toBe('unknown');
  });

  it('modo local (UAT): se dice «mock» y no se bloquea el envío', async () => {
    const whatsapp = { enabled: true, mock: true, graphVersion: 'v21.0', listTemplates: vi.fn(async () => ({ ok: false, skipped: true, reason: 'mock_mode' })) };
    const status = createWhatsAppStatus({ whatsapp, ...webhook });
    await status.probe();
    const snapshot = status.snapshot();
    expect(snapshot.mode).toBe('mock');
    expect(snapshot.send).toBe('mock');
    expect(snapshot.canSend).toBe(true);
  });

  it('el snapshot no espera a Meta y la comprobación va en segundo plano', async () => {
    let resolver;
    const whatsapp = { ...ENABLED, listTemplates: vi.fn(() => new Promise((resolve) => { resolver = resolve; })) };
    const status = createWhatsAppStatus({ whatsapp, ...webhook });
    const snapshot = status.snapshot(); // sin probar todavía
    expect(snapshot.checked).toBe('unknown');
    expect(snapshot.send).toBe('unknown');
    expect(whatsapp.listTemplates).toHaveBeenCalledTimes(1); // se lanzó, no se esperó
    resolver({ ok: true, templates: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(status.snapshot().checked).toBe('live');
  });
});
