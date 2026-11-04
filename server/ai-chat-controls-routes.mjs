// Controles del futuro agente conversacional. Esta fase no envía mensajes.
const SETTINGS_KEY = 'ai_chat_controls';
const VALID_MODES = new Set(['inherit', 'on', 'off']);

export function effectiveAiChatEnabled(globalEnabled, mode) {
  return mode === 'on' || (mode !== 'off' && globalEnabled === true);
}

export async function handleAiChatControlsRoute({ req, res, route, ctx, actor, can, canOpen, readJson, json }) {
  const base = '/api/admin/ai/chat-controls';
  if (route !== base && !route.startsWith(`${base}/`)) return false;
  const send = (status, body) => { json(res, status, body); return true; };
  if (!can('chats.read')) return send(403, { ok: false, error: 'forbidden' });
  if (!['GET', 'POST'].includes(req.method)) return send(405, { ok: false, error: 'method_not_allowed' });

  const setting = await ctx.settings.read(SETTINGS_KEY);
  const globalEnabled = setting?.value?.enabled === true;
  const automationReady = false; // Hasta que el motor de envío sea probado y autorizado.
  if (route === base) {
    if (req.method === 'GET') return send(200, { ok: true, enabled: globalEnabled, automationReady });
    if (!can('settings.manage')) return send(403, { ok: false, error: 'forbidden' });
    let body;
    try { body = await readJson(req, 1000); } catch { return send(400, { ok: false, error: 'invalid_body' }); }
    if (typeof body?.enabled !== 'boolean') return send(400, { ok: false, error: 'invalid_enabled' });
    await ctx.settings.write(SETTINGS_KEY, { enabled: body.enabled });
    await ctx.audit?.record({
      entity: 'settings', entityId: SETTINGS_KEY, action: 'ai_chat.global_changed',
      actor: actor?.display_name ?? null, summary: body.enabled ? 'IA global preparada' : 'IA global desactivada',
      data: { enabled: body.enabled, automation_ready: automationReady },
    });
    return send(200, { ok: true, enabled: body.enabled, automationReady });
  }

  const id = decodeURIComponent(route.slice(base.length + 1));
  if (!id || id.includes('/')) return send(404, { ok: false, error: 'not_found' });
  const conversation = await ctx.db.get('conversations', id);
  if (!conversation || !(await canOpen(conversation))) return send(404, { ok: false, error: 'not_found' });
  const mode = VALID_MODES.has(conversation.ai_chat_mode) ? conversation.ai_chat_mode : 'inherit';
  if (req.method === 'GET') return send(200, {
    ok: true, conversationId: id, mode, globalEnabled,
    effectiveEnabled: effectiveAiChatEnabled(globalEnabled, mode), automationReady,
  });
  if (!can('chats.reply')) return send(403, { ok: false, error: 'forbidden' });
  let body;
  try { body = await readJson(req, 1000); } catch { return send(400, { ok: false, error: 'invalid_body' }); }
  if (!VALID_MODES.has(body?.mode)) return send(400, { ok: false, error: 'invalid_mode' });
  await ctx.db.update('conversations', id, { ai_chat_mode: body.mode });
  await ctx.audit?.record({
    entity: 'conversation', entityId: id, action: 'ai_chat.mode_changed',
    actor: actor?.display_name ?? null, summary: `IA del chat: ${body.mode}`,
    data: { mode: body.mode, effective_enabled: effectiveAiChatEnabled(globalEnabled, body.mode), automation_ready: automationReady },
  });
  return send(200, {
    ok: true, conversationId: id, mode: body.mode, globalEnabled,
    effectiveEnabled: effectiveAiChatEnabled(globalEnabled, body.mode), automationReady,
  });
}
