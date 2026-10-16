/** Invocado únicamente dentro de la zona autenticada y protegida contra CSRF. */
export async function handleCallingRoute({ req, res, route, url, ctx, actor, can, canOpen, readJson, json }) {
  const match = /^\/api\/admin\/conversations\/([^/]+)\/calling(?:\/([a-z_-]+))?$/.exec(route);
  const incoming = route === '/api/admin/calling/incoming';
  const config = route === '/api/admin/calling/config';
  if (!match && !incoming && !config) return false;
  const send = (status, body) => { json(res, status, body); return true; };
  if (!can('chats.reply')) return send(403, { ok: false, error: 'forbidden' });
  if (config) {
    if (req.method !== 'GET') return send(405, { ok: false, error: 'method_not_allowed' });
    return send(200, { ok: true, enabled: ctx.calling.enabled, iceServers: ctx.callingIceServers ?? [] });
  }
  if (incoming) {
    if (req.method !== 'GET') return send(405, { ok: false, error: 'method_not_allowed' });
    const calls = [];
    for (const call of await ctx.calling.incoming()) {
      const conversation = await ctx.db.get('conversations', call.conversationId);
      if (await canOpen(conversation)) {
        const { remoteSdp, version, ...safe } = call;
        calls.push(safe);
      }
    }
    return send(200, { ok: true, enabled: ctx.calling.enabled, calls });
  }
  let id;
  try { id = decodeURIComponent(match[1]); } catch { return send(400, { ok: false, error: 'invalid_conversation' }); }
  const conversation = await ctx.db.get('conversations', id);
  if (!conversation || !(await canOpen(conversation))) return send(403, { ok: false, error: 'conversation_not_accessible' });
  const action = match[2] ?? '';
  if (!action && req.method === 'GET') return send(200, await ctx.calling.list(id, actor));
  if (action === 'permission-state' && req.method === 'GET') {
    const customer = await ctx.customers.get(conversation.customer_id);
    const result = await ctx.calling.perform({ action, conversation, customer, actor });
    return send(result.ok ? 200 : result.status ?? 409, result);
  }
  // Estado con SDP solo se entrega al agente propietario o, antes de aceptar,
  // a un agente con acceso efectivo a esta conversación.
  if (action === 'state' && req.method === 'GET') {
    const customer = await ctx.customers.get(conversation.customer_id);
    const result = await ctx.calling.perform({ action, conversation, customer, actor, body: { id: url.searchParams.get('id') } });
    return send(result.ok ? 200 : result.status ?? 409, result);
  }
  if (req.method !== 'POST') return send(405, { ok: false, error: 'method_not_allowed' });
  if (!['permission', 'connect', 'pre_accept', 'accept', 'reject', 'terminate', 'heartbeat'].includes(action)) return send(404, { ok: false, error: 'not_found' });
  let body;
  try { body = await readJson(req); } catch { return send(400, { ok: false, error: 'invalid_body' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { ok: false, error: 'invalid_body' });
  const customer = await ctx.customers.get(conversation.customer_id);
  if (!customer) return send(404, { ok: false, error: 'not_found' });
  const result = await ctx.calling.perform({ action, conversation, customer, actor, body,
    canSendFreeText: ctx.customers.canSendFreeText(conversation) });
  return send(result.ok ? 200 : result.status >= 400 && result.status < 600 ? result.status : 409, result);
}
