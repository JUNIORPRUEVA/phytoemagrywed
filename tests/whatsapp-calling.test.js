// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { callingReadiness, createCallingDiagnostics } from '../server/whatsapp-calling.mjs';
import { checkCalling, parseCallingEnv } from '../scripts/check-whatsapp-calling.mjs';

const env = {
  WHATSAPP_ACCESS_TOKEN: 'secret-token-test', WHATSAPP_PHONE_NUMBER_ID: '12345',
  WHATSAPP_BUSINESS_ACCOUNT_ID: '67890', META_APP_ID: '98765',
};
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });

describe('preparación de Calling API', () => {
  it('el diagnóstico local no hace ninguna petición', async () => {
    const fetchImpl = vi.fn();
    const report = await checkCalling({ env, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.configuration.configured).toBe(true);
    expect(JSON.stringify(report)).not.toContain(env.WHATSAPP_ACCESS_TOKEN);
  });

  it('consulta solo GET al dominio oficial y no devuelve claves SIP', async () => {
    const fetchImpl = vi.fn(async () => reply({ calling: { status: 'ENABLED', sip: {
      status: 'ENABLED', servers: [{ hostname: 'private-host', password: 'SIP-SECRET' }],
    } } }));
    const result = await createCallingDiagnostics({ env, fetchImpl }).settings();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v21.0/12345/settings');
    expect(options.method).toBe('GET');
    expect(options.redirect).toBe('error');
    expect(options.headers.authorization).toBe(`Bearer ${env.WHATSAPP_ACCESS_TOKEN}`);
    expect(result.blockers).toContain('sip_enabled_requires_transport_review');
    expect(JSON.stringify(result)).not.toMatch(/SIP-SECRET|private-host/);
    expect(result.requiresLiveValidation).toBe(true);
  });

  it.each(['NOT_SET', 'DISABLED', 'UNKNOWN'])('no confunde %s con llamadas habilitadas', (status) => {
    expect(callingReadiness({ calling: { status } }).blockers.length).toBeGreaterThan(0);
  });

  it('una respuesta sin datos no se interpreta como disponibilidad', () => {
    expect(callingReadiness({})).toMatchObject({ settingsAvailable: false, callingStatus: 'UNKNOWN' });
  });

  it('omite valores inesperados de Meta en lugar de imprimirlos', () => {
    const result = callingReadiness({ calling: { status: 'secret-value', call_icon_visibility: 'private-value' } });
    expect(result).toMatchObject({ callingStatus: 'UNKNOWN', iconVisibility: null });
    expect(JSON.stringify(result)).not.toMatch(/secret-value|private-value/);
  });

  it('considera las restricciones de Meta aunque el estado sea ENABLED', () => {
    expect(callingReadiness({ calling: { status: 'ENABLED', restrictions: { restrictions: [{ type: 'BIC' }] } } }).blockers)
      .toContain('meta_calling_restrictions');
  });

  it.each([
    { WHATSAPP_PHONE_NUMBER_ID: '../other/settings' },
    { WHATSAPP_GRAPH_VERSION: 'v21.0/../../host' },
    { WHATSAPP_ACCESS_TOKEN: '' },
  ])('rechaza configuración inválida antes de usar la red', async (patch) => {
    const fetchImpl = vi.fn();
    const result = await createCallingDiagnostics({ env: { ...env, ...patch }, fetchImpl }).settings();
    expect(result.error).toBe('invalid_configuration');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('permite fijar la versión de llamadas sin cambiar la de mensajes', async () => {
    const fetchImpl = vi.fn(async () => reply({ calling: { status: 'NOT_SET' } }));
    await createCallingDiagnostics({ env: { ...env, WHATSAPP_CALLING_GRAPH_VERSION: 'v25.0' }, fetchImpl }).settings();
    expect(fetchImpl.mock.calls[0][0]).toContain('/v25.0/');
  });

  it('no expone errores crudos del proveedor ni excepciones de red', async () => {
    const provider = createCallingDiagnostics({ env, fetchImpl: async () => reply({ error: {
      message: env.WHATSAPP_ACCESS_TOKEN, code: 190, error_subcode: 463,
    } }, 400) });
    expect(await provider.settings()).toEqual({ ok: false, error: 'meta_request_failed', httpStatus: 400, code: 190, subcode: 463 });
    const network = createCallingDiagnostics({ env, fetchImpl: async () => { throw new Error(env.WHATSAPP_ACCESS_TOKEN); } });
    expect(await network.settings()).toEqual({ ok: false, error: 'network_or_invalid_response' });
  });

  it('verifica la app esperada y no da por comprobado el campo calls', async () => {
    const client = createCallingDiagnostics({ env, fetchImpl: async () => reply({ data: [
      { whatsapp_business_api_data: { id: env.META_APP_ID, name: 'private-name' } },
    ] }) });
    expect(await client.subscriptions()).toEqual({ ok: true, currentAppSubscribed: true, callsFieldVerified: false });
  });

  it('no interpreta una respuesta de suscripciones desconocida como éxito', async () => {
    const client = createCallingDiagnostics({ env, fetchImpl: async () => reply({ success: true }) });
    expect(await client.subscriptions()).toEqual({ ok: false, error: 'unexpected_subscription_response' });
  });
  it('verifica el campo calls con la app real sin publicar su secreto', async () => {
    const fetchImpl = vi.fn(async (url) => url.endsWith('/subscribed_apps')
      ? reply({ data: [{ whatsapp_business_api_data: { id: env.META_APP_ID } }] })
      : reply({ data: [{ object: 'whatsapp_business_account', fields: [{ name: 'messages' }, { name: 'calls' }] }] }));
    const result = await createCallingDiagnostics({ env: { ...env, META_APP_SECRET: 'app-secret' }, fetchImpl }).subscriptions();
    expect(result).toEqual({ ok: true, currentAppSubscribed: true, callsFieldVerified: true });
    expect(JSON.stringify(result)).not.toContain('app-secret');
  });

  it('lee solo claves de WhatsApp sin ejecutar contenido del archivo', () => {
    const parsed = parseCallingEnv('\uFEFFWHATSAPP_PHONE_NUMBER_ID=123 # comentario\nWHATSAPP_ACCESS_TOKEN="literal$(command)"\nPHYTO_CRM_DATABASE_URL=private\n');
    expect(parsed.WHATSAPP_PHONE_NUMBER_ID).toBe('123');
    expect(parsed.WHATSAPP_ACCESS_TOKEN).toBe('literal$(command)');
    expect(parsed.PHYTO_CRM_DATABASE_URL).toBeUndefined();
    expect(() => parseCallingEnv('WHATSAPP_ACCESS_TOKEN="unterminated')).toThrow('invalid_env_format');
  });
});
