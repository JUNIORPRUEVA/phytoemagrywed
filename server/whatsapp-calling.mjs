/**
 * Diagnóstico de Calling API. Solo GET a Meta; no activa ni inicia llamadas.
 * La respuesta de /settings puede contener claves SIP: nunca se devuelve cruda.
 */
export function callingReadiness(settings) {
  const calling = settings?.calling ?? settings?.data?.[0]?.calling;
  const status = ['ENABLED', 'DISABLED', 'NOT_SET'].includes(calling?.status) ? calling.status : 'UNKNOWN';
  const sipEnabled = calling?.sip?.status === 'ENABLED';
  const blockers = [];
  if (status !== 'ENABLED') blockers.push(status === 'NOT_SET' ? 'calling_not_set' : 'calling_not_enabled');
  if (sipEnabled) blockers.push('sip_enabled_requires_transport_review');
  if (Array.isArray(calling?.restrictions?.restrictions) && calling.restrictions.restrictions.length) {
    blockers.push('meta_calling_restrictions');
  }
  return {
    settingsAvailable: Boolean(calling),
    callingStatus: status,
    sipEnabled,
    iconVisibility: ['DEFAULT', 'DISABLE_ALL', 'NOT_SET'].includes(calling?.call_icon_visibility) ? calling.call_icon_visibility : null,
    blockers,
    // Un GET exitoso no confirma elegibilidad, permisos del cliente ni audio.
    requiresLiveValidation: true,
  };
}

export function callingConfiguration(env = {}) {
  const accessToken = String(env.WHATSAPP_ACCESS_TOKEN ?? '').trim();
  const phoneNumberId = String(env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim();
  const businessAccountId = String(env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? '').trim();
  const appId = String(env.META_APP_ID ?? '').trim();
  const graphVersion = String(env.WHATSAPP_CALLING_GRAPH_VERSION || env.WHATSAPP_GRAPH_VERSION || env.PHYTO_META_GRAPH_VERSION || 'v21.0').trim();
  const issues = [];
  if (!accessToken) issues.push('missing_access_token');
  if (!/^\d+$/.test(phoneNumberId)) issues.push('invalid_phone_number_id');
  if (businessAccountId && !/^\d+$/.test(businessAccountId)) issues.push('invalid_business_account_id');
  if (appId && !/^\d+$/.test(appId)) issues.push('invalid_app_id');
  if (!/^v\d+\.\d+$/.test(graphVersion)) issues.push('invalid_graph_version');
  return { accessToken, phoneNumberId, businessAccountId, appId, graphVersion, issues };
}

export function createCallingDiagnostics({ env = {}, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const config = callingConfiguration(env);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 30000) : 10000;

  async function get(path, token = config.accessToken) {
    if (config.issues.length) return { ok: false, error: 'invalid_configuration', issues: config.issues };
    try {
      const response = await fetchImpl(`https://graph.facebook.com/${config.graphVersion}/${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
      });
      const body = await response.json();
      if (!response.ok || body?.error) {
        // Nada del texto del proveedor: puede incluir credenciales o identificadores.
        return {
          ok: false,
          error: 'meta_request_failed',
          httpStatus: response.status,
          code: typeof body?.error?.code === 'number' ? body.error.code : null,
          subcode: typeof body?.error?.error_subcode === 'number' ? body.error.error_subcode : null,
        };
      }
      return { ok: true, body };
    } catch {
      return { ok: false, error: 'network_or_invalid_response' };
    }
  }

  return {
    configuration() {
      return {
        graphVersion: config.graphVersion,
        configured: config.issues.length === 0,
        issues: [...config.issues],
        appSecretPresent: Boolean(String(env.META_APP_SECRET ?? '').trim()),
        verifyTokenPresent: Boolean(String(env.WHATSAPP_VERIFY_TOKEN ?? '').trim()),
        businessAccountPresent: Boolean(config.businessAccountId),
        appIdPresent: Boolean(config.appId),
      };
    },
    async settings() {
      const result = await get(`${config.phoneNumberId}/settings`);
      return result.ok ? { ok: true, ...callingReadiness(result.body) } : result;
    },
    async subscriptions() {
      if (!config.businessAccountId || !config.appId) return { ok: false, error: 'missing_waba_or_app_id' };
      const result = await get(`${config.businessAccountId}/subscribed_apps`);
      if (!result.ok) return result;
      if (!Array.isArray(result.body?.data)) return { ok: false, error: 'unexpected_subscription_response' };
      const currentAppSubscribed = result.body.data.some((entry) => String(entry?.whatsapp_business_api_data?.id ?? '') === config.appId);
      let callsFieldVerified = false;
      if (currentAppSubscribed && String(env.META_APP_SECRET ?? '').trim()) {
        const app = await get(`${config.appId}/subscriptions`, `${config.appId}|${env.META_APP_SECRET}`);
        const fields = app.body?.data?.find((entry) => entry.object === 'whatsapp_business_account')?.fields;
        callsFieldVerified = app.ok && Array.isArray(fields) && fields.some((f) => (typeof f === 'string' ? f : f.name) === 'calls');
      }
      return {
        ok: true,
        currentAppSubscribed,
        callsFieldVerified,
      };
    },
  };
}
