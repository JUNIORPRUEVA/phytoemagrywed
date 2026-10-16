/** Cliente oficial de voz. Los secretos y las operaciones de Meta viven en servidor. */
import { callingConfiguration } from './whatsapp-calling.mjs';

export function callPermission(body, now = Date.now()) {
  const status = ['temporary', 'permanent', 'no_permission'].includes(body?.permission?.status) ? body.permission.status : 'no_permission';
  const expiration = Number(body?.permission?.expiration_time ?? body?.permission?.expiration ?? 0);
  const allowed = (name) => body?.actions?.some((a) => a.action_name === name && a.can_perform_action === true) === true;
  return {
    status, expiresAt: expiration > 0 ? expiration * 1000 : null,
    canCall: allowed('start_call') && (status === 'permanent' || (status === 'temporary' && expiration * 1000 > now)),
    canRequest: allowed('send_call_permission_request'),
  };
}

export function validCallSdp(sdp) {
  return typeof sdp === 'string' && sdp.length <= 48000 && /^v=0\r?\n/.test(sdp) &&
    /^m=audio /m.test(sdp) && !/^m=(video|application) /m.test(sdp) && /a=rtpmap:\d+ opus\/48000/i.test(sdp);
}

export function createCallingApi({ env = {}, enabled = false, fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  const c = callingConfiguration(env);
  const configured = c.issues.length === 0;
  const template = String(env.WHATSAPP_CALLING_PERMISSION_TEMPLATE ?? '').trim();
  const language = String(env.WHATSAPP_CALLING_PERMISSION_LANGUAGE ?? 'es').trim();
  const hasPermissionTemplate = /^[a-z0-9_]{1,100}$/.test(template) && /^\d+$/.test(c.businessAccountId);
  async function request(endpoint, payload, root = c.phoneNumberId) {
    if (!enabled || !configured) return { ok: false, error: 'calling_disabled' };
    try {
      const response = await fetchImpl(`https://graph.facebook.com/${c.graphVersion}/${root}/${endpoint}`, {
        method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${c.accessToken}`, 'content-type': 'application/json' },
        ...(payload ? { body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }) } : {}),
      });
      const body = await response.json();
      if (!response.ok || body?.error) return { ok: false, error: 'meta_calling_error', status: response.status,
        code: typeof body?.error?.code === 'number' ? body.error.code : null };
      return { ok: true, body };
    } catch { return { ok: false, error: 'meta_calling_unconfirmed', uncertain: true }; }
  }
  return {
    enabled: enabled && configured, phoneNumberId: c.phoneNumberId, businessAccountId: c.businessAccountId, hasPermissionTemplate,
    async permission(phone) {
      if (!/^\d{8,15}$/.test(phone)) return { ok: false, error: 'invalid_phone' };
      const r = await request(`call_permissions?user_wa_id=${phone}`);
      return r.ok ? { ok: true, permission: callPermission(r.body) } : r;
    },
    async requestPermission(phone, { freeForm = true } = {}) {
      if (!/^\d{8,15}$/.test(phone)) return { ok: false, error: 'invalid_phone' };
      if (!freeForm) {
        if (!hasPermissionTemplate) return { ok: false, error: 'permission_requires_open_window' };
        const templates = await request(`message_templates?name=${encodeURIComponent(template)}&fields=name,status,language,components`, null, c.businessAccountId);
        if (!templates.ok) return templates;
        const approved = templates.body?.data?.find((t) => t.name === template && t.status === 'APPROVED' && t.language === language &&
          t.components?.some((component) => component.type?.toLowerCase() === 'call_permission_request') &&
          !JSON.stringify(t.components).includes('{{'));
        if (!approved) return { ok: false, error: 'call_permission_template_unavailable' };
        const r = await request('messages', { to: phone, recipient_type: 'individual', type: 'template',
          template: { name: template, language: { code: language } } });
        return r.ok ? { ok: true, messageId: r.body?.messages?.[0]?.id ?? null } : r;
      }
      const r = await request('messages', { to: phone, recipient_type: 'individual', type: 'interactive',
        interactive: { type: 'call_permission_request', action: { name: 'call_permission_request' },
          body: { text: '¿Nos permites llamarte por WhatsApp para ayudarte con tu consulta o pedido de Phytoemagry?' } } });
      return r.ok ? { ok: true, messageId: r.body?.messages?.[0]?.id ?? null } : r;
    },
    async action(action, { phone, callId, sdp, reference } = {}) {
      if (!['connect', 'pre_accept', 'accept', 'reject', 'terminate'].includes(action)) return { ok: false, error: 'invalid_action' };
      if (action === 'connect' ? !/^\d{8,15}$/.test(phone ?? '') : !/^[\w.:-]{1,250}$/.test(callId ?? '')) return { ok: false, error: 'invalid_call' };
      const needsSdp = ['connect', 'pre_accept', 'accept'].includes(action);
      if (needsSdp && !validCallSdp(sdp)) return { ok: false, error: 'invalid_sdp' };
      const r = await request('calls', { action,
        ...(action === 'connect' ? { to: phone } : { call_id: callId }),
        ...(needsSdp ? { session: { sdp_type: action === 'connect' ? 'offer' : 'answer', sdp } } : {}),
        ...(reference ? { biz_opaque_callback_data: reference } : {}),
      });
      if (!r.ok) return r;
      const id = r.body?.calls?.[0]?.id;
      if (action === 'connect' && !id) return { ok: false, error: 'meta_calling_unconfirmed', uncertain: true };
      if (action !== 'connect' && r.body?.success !== true) return { ok: false, error: 'meta_calling_unconfirmed', uncertain: true };
      return { ok: true, callId: id ?? callId };
    },
  };
}
