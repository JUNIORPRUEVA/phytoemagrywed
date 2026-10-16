#!/usr/bin/env node
/** Configuración explícita autorizada: conserva webhook y campos existentes. */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parseCallingEnv } from './check-whatsapp-calling.mjs';
import { callingConfiguration, callingReadiness } from '../server/whatsapp-calling.mjs';

const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, apply: { type: 'boolean', default: false },
  'show-icon': { type: 'boolean', default: false }, 'create-template': { type: 'boolean', default: false } } });
const env = { ...(values['env-file'] ? parseCallingEnv(await readFile(values['env-file'], 'utf8')) : {}), ...process.env };
const c = callingConfiguration(env);
if (c.issues.length || !c.appId || !env.META_APP_SECRET || !env.WHATSAPP_VERIFY_TOKEN) {
  console.error('Falta configuración válida de Meta.'); process.exitCode = 1;
} else {
  async function graph(path, body, appToken = false) {
    try {
      const response = await fetch(`https://graph.facebook.com/${c.graphVersion}/${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { authorization: `Bearer ${appToken ? `${c.appId}|${env.META_APP_SECRET}` : c.accessToken}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      if (!response.ok || data.error) {
        // Texto solo para diagnosticar; se elimina cualquier secreto antes de imprimir.
        let message = String(data.error?.error_user_msg ?? data.error?.message ?? '').replace(/\s+/g, ' ');
        for (const secret of [c.accessToken, env.META_APP_SECRET, env.WHATSAPP_VERIFY_TOKEN]) if (secret) message = message.replaceAll(secret, '[oculto]');
        message = message.replace(/access_token=[^&\s]+/gi, 'access_token=[oculto]').slice(0, 400);
        return { ok: false, httpStatus: response.status, code: data.error?.code ?? null, subcode: data.error?.error_subcode ?? null, message };
      }
      return { ok: true, data };
    } catch { return { ok: false, error: 'network_or_invalid_response' }; }
  }
  const result = { applied: false };
  const subscriptions = await graph(`${c.appId}/subscriptions`, null, true);
  const existing = subscriptions.data?.data?.find((s) => s.object === 'whatsapp_business_account');
  if (!subscriptions.ok || !existing?.callback_url?.startsWith('https://') || !Array.isArray(existing.fields)) {
    result.error = 'cannot_preserve_existing_webhook';
    result.details = subscriptions.ok ? null : subscriptions;
    process.exitCode = 1;
  } else {
    const fields = existing.fields.map((f) => typeof f === 'string' ? f : f.name).filter(Boolean);
    result.callsSubscribed = fields.includes('calls');
    if (values.apply) {
      if (!result.callsSubscribed) {
        const updated = await graph(`${c.appId}/subscriptions`, { object: existing.object,
          callback_url: existing.callback_url, verify_token: env.WHATSAPP_VERIFY_TOKEN,
          fields: [...new Set([...fields, 'calls'])].join(','), include_values: true }, true);
        result.subscriptionUpdate = updated.ok ? { ok: updated.data?.success === true } : updated;
      }
      const settings = await graph(`${c.phoneNumberId}/settings`, { calling: { status: 'ENABLED',
        call_icon_visibility: values['show-icon'] ? 'DEFAULT' : 'DISABLE_ALL', callback_permission_status: 'ENABLED' } });
      result.settingsUpdate = settings.ok ? { ok: settings.data?.success === true } : settings;
      result.applied = result.settingsUpdate.ok === true;
    }
    if (values['create-template']) {
      if (!values.apply) { result.template = { ok: false, error: 'apply_required' }; }
      else {
        const name = 'phyto_permiso_llamada_v1';
        const existingTemplate = await graph(`${c.businessAccountId}/message_templates?name=${name}&fields=name,status,language,components`);
        const found = existingTemplate.data?.data?.find((t) => t.name === name && t.language === 'es');
        if (found) result.template = { ok: true, name, status: found.status };
        else if (!existingTemplate.ok) result.template = existingTemplate;
        else {
          const created = await graph(`${c.businessAccountId}/message_templates`, { name, language: 'es', category: 'UTILITY',
            components: [{ type: 'BODY', text: 'Queremos llamarte por WhatsApp para ayudarte con tu consulta o pedido en Phytoemagry. ¿Nos permites llamarte?' }, { type: 'call_permission_request' }] });
          result.template = created.ok ? { ok: true, name, status: created.data?.status ?? 'PENDING' } : created;
        }
      }
    }
    const confirmed = await graph(`${c.appId}/subscriptions`, null, true);
    const confirmedFields = confirmed.data?.data?.find((s) => s.object === 'whatsapp_business_account')?.fields;
    result.callsSubscribed = Array.isArray(confirmedFields) && confirmedFields.some((f) => (typeof f === 'string' ? f : f.name) === 'calls');
    result.messageSubscriptionPreserved = Array.isArray(confirmedFields) && fields.every((f) => confirmedFields.some((v) => (typeof v === 'string' ? v : v.name) === f));
    const settings = await graph(`${c.phoneNumberId}/settings`);
    result.settings = settings.ok ? callingReadiness(settings.data) : settings;
    if (values.apply && (!result.applied || !result.callsSubscribed || !result.messageSubscriptionPreserved)) process.exitCode = 2;
  }
  console.log(JSON.stringify(result, null, 2));
}
