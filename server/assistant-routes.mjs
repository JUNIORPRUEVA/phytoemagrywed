// Solo se invoca después de autenticación y comprobación del origen/CSRF.
import { ASSISTANT_ACTIONS, assistantQuery } from './assistant.mjs';
import { cancelProposal, confirmProposal } from './assistant-actions.mjs';

/**
 * RUTA DEL ASISTENTE IA CONTEXTUAL DEL CHAT.
 *
 * `POST /api/admin/assistant/query`
 *   body: { conversationId, action, message }
 *
 * Seguridad (todo comprobado en el SERVIDOR):
 *   1. permiso `chats.reply` (no se heredan permisos de agentes del Centro IA);
 *   2. la conversación se resuelve en la base y se aplica `canOpen` (regla de
 *      dueño / conversación sin asignar con `chats.take_unassigned`);
 *   3. el cliente sale de la conversación, nunca del cuerpo de la petición;
 *   4. un límite por persona evita ráfagas que gasten cuota de IA;
 *   5. la consulta queda en auditoría sin guardar el texto del cliente.
 *
 * La ruta es de SOLO LECTURA: no hay ninguna escritura de negocio. Un borrador
 * devuelto no se envía ni se guarda aquí.
 */
const WINDOW_MS = 60_000;
/*
 * Tope por PERSONA y minuto: frena bucles y dobles clics sin estorbar a quien
 * trabaja. El panel además impide consultas en paralelo. La cuota diaria de
 * DeepSeek sigue siendo el límite económico real.
 */
const MAX_PER_WINDOW = 20;
const hitsByActor = new Map();

function allow(actorId) {
  const key = String(actorId || 'legacy');
  const now = Date.now();
  const list = (hitsByActor.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  if (list.length >= MAX_PER_WINDOW) {
    hitsByActor.set(key, list);
    return false;
  }
  list.push(now);
  hitsByActor.set(key, list);
  // Higiene: el mapa no crece sin límite si pasan muchas cuentas.
  if (hitsByActor.size > 200) {
    for (const [id, times] of hitsByActor) {
      if (!times.some((at) => now - at < WINDOW_MS)) hitsByActor.delete(id);
    }
  }
  return true;
}

export async function handleAssistantRoute({ req, res, route, ctx, actor, can, canOpen, readJson, json }) {
  const actionMatch = route.match(/^\/api\/admin\/assistant\/actions\/([^/]+)\/(confirm|cancel)$/);
  if (route !== '/api/admin/assistant/query' && !actionMatch) return false;
  const send = (status, body) => { json(res, status, body); return true; };

  if (!can('chats.reply')) return send(403, { ok: false, error: 'forbidden' });
  if (req.method !== 'POST') return send(405, { ok: false });

  /*
   * CONFIRMAR / CANCELAR UNA OPERACIÓN PREPARADA.
   * El permiso concreto (orders.create, clients.update…) y el estado real del
   * recurso se vuelven a comprobar dentro del motor, no aquí.
   */
  if (actionMatch) {
    let body = {};
    try { body = (await readJson(req, 20000)) ?? {}; } catch { body = {}; }
    const proposalId = decodeURIComponent(actionMatch[1]);
    if (actionMatch[2] === 'cancel') {
      const result = await cancelProposal({ ctx, actor, can, proposalId });
      return send(result.ok ? 200 : result.status ?? 409, result);
    }
    const result = await confirmProposal({
      ctx,
      actor,
      can,
      canOpen,
      proposalId,
      fingerprint: typeof body.fingerprint === 'string' ? body.fingerprint : null,
      cookie: req.headers.cookie,
    });
    return send(result.ok ? 200 : result.status ?? 409, result);
  }

  let body;
  try {
    body = await readJson(req, 20000);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch {
    return send(400, { ok: false, message: 'Datos no válidos.' });
  }

  const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
  if (!conversationId) return send(422, { ok: false, error: 'conversation_required' });

  const action = ASSISTANT_ACTIONS.includes(body.action) ? body.action : 'free';
  const message = typeof body.message === 'string' ? body.message.slice(0, 600) : '';

  const conversation = await ctx.db.get('conversations', conversationId);
  // Se responde igual que «no existe» para no dar pistas de conversaciones ajenas.
  if (!conversation || !(await canOpen(conversation))) {
    return send(403, { ok: false, error: 'conversation_not_accessible' });
  }
  const customer = await ctx.customers.get(conversation.customer_id);
  if (!customer) return send(409, { ok: false, error: 'customer_missing' });

  if (!allow(actor?.id)) {
    return send(429, { ok: false, error: 'rate_limited', message: 'Demasiadas consultas seguidas. Espera un minuto.' });
  }

  const started = Date.now();
  let result;
  try {
    result = await assistantQuery({ ctx, actor, conversation, customer, action, message });
  } catch (error) {
    console.error('[asistente] fallo:', error?.message ?? error);
    result = { ok: true, ai: false, reason: 'provider_error', sources: [], scope: { conversationId, customerId: customer.id, action } };
  }

  // Auditoría: qué se pidió y cómo acabó, SIN el texto del cliente ni el borrador.
  await ctx.audit?.record?.({
    entity: 'conversation',
    entityId: conversation.id,
    action: 'assistant.query',
    actor: actor?.display_name ?? actor?.id ?? null,
    summary: `Asistente IA · ${action} · ${result.ai ? 'ok' : result.reason ?? 'error'}`,
    data: {
      action,
      user_id: actor?.id ?? null,
      customer_id: customer.id,
      ai: result.ai === true,
      reason: result.reason ?? null,
      ms: Date.now() - started,
      model: result.meta?.model ?? null,
      tokens: result.meta?.usage?.total ?? null,
      sources: (result.sources ?? []).map((item) => item.type),
      had_message: Boolean(message),
    },
    idempotencyKey: null,
  }).catch?.(() => {});

  return send(200, { ok: true, ...result });
}
