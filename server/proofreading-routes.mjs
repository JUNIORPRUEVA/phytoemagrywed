// Solo se invoca después de autenticación y comprobación del origen/CSRF.
export async function handleProofreadingRoute({ req, res, route, ctx, actor, can, canOpen, readJson, json }) {
  const config = route === '/api/admin/settings/deepseek';
  const test = route === '/api/admin/settings/deepseek/test';
  const correction = route === '/api/admin/proofreading';
  const orderMessage = route === '/api/admin/ai/order-message';
  const replySuggestion = route === '/api/admin/ai/reply-suggestion';
  if (!config && !test && !correction && !orderMessage && !replySuggestion) return false;
  const send = (status, body) => { json(res, status, body); return true; };
  if (!can(config || test ? 'settings.manage' : 'chats.reply')) return send(403, { ok: false, error: 'forbidden' });
  if (config && req.method === 'GET') return send(200, { ok: true, deepseek: await ctx.proofreading.status() });
  if (req.method !== 'POST') return send(405, { ok: false });
  let body;
  try { body = await readJson(req, 20000); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); }
  catch { return send(400, { ok: false, message: 'Datos no válidos.' }); }
  if (config) {
    try { return send(200, { ok: true, deepseek: await ctx.proofreading.save(body) }); }
    catch (error) { return send(400, { ok: false, message: ['Elige el modelo Flash económico.', 'El límite diario debe estar entre 1 y 1000.', 'La clave API no tiene un formato válido.', 'Guarda una clave API para activar las correcciones.'].includes(error.message) ? error.message : 'No se pudo guardar la configuración.' }); }
  }
  if (test) return send(200, { ok: true, connected: await ctx.proofreading.test() });
  if (orderMessage) {
    const conversation = typeof body.conversationId === 'string' ? await ctx.db.get('conversations', body.conversationId) : null;
    if (!conversation || !(await canOpen(conversation))) return send(403, { ok: false, error: 'conversation_not_accessible' });
    const customer = await ctx.customers.get(conversation.customer_id);
    const missing = Array.isArray(body.missing) ? body.missing.map((item) => String(item).slice(0, 120)).slice(0, 6) : [];
    const mensaje = await ctx.proofreading.compose({
      missing,
      customerName: customer?.name || '',
      orderNumber: String(body.orderNumber || '').slice(0, 40),
      total: Number.isFinite(Number(body.total)) ? Number(body.total) : null,
      actorId: actor?.id || 'legacy',
    });
    return send(200, { ok: true, ...mensaje });
  }
  if (replySuggestion) {
    const conversation = typeof body.conversationId === 'string' ? await ctx.db.get('conversations', body.conversationId) : null;
    if (!conversation || !(await canOpen(conversation))) return send(403, { ok: false, error: 'conversation_not_accessible' });
    const customer = await ctx.customers.get(conversation.customer_id);
    // El servidor obtiene el contexto desde el hilo autorizado; el navegador no
    // puede inyectar conversaciones, mensajes ni datos de otro usuario.
    const messages = await ctx.customers.messagesFor(conversation.id, { limit: 200 });
    const recientes = messages.slice(-5);
    const suggestion = await ctx.proofreading.suggestReply({
      messages: recientes,
      customerName: customer?.name || '',
      actorId: actor?.id || 'legacy',
      // Las fotos del tramo reciente se descargan en el servidor y viajan a la IA
      // como contenido multimodal; el navegador nunca ve la clave ni el binario.
      media: await ctx.aiMediaImages?.(recientes),
    });
    return send(200, { ok: true, ...suggestion });
  }
  const conversation = typeof body.conversationId === 'string' ? await ctx.db.get('conversations', body.conversationId) : null;
  if (!conversation || !(await canOpen(conversation))) return send(403, { ok: false, error: 'conversation_not_accessible' });
  const customer = await ctx.customers.get(conversation.customer_id);
  const suggestion = await ctx.proofreading.correct({ text: body.text, conversationId: conversation.id, names: [customer?.name || ''], actorId: actor?.id || 'legacy' });
  return send(200, { ok: true, suggestion });
}
