/**
 * RUTAS DEL CENTRO DE OPERACIONES (tickets internos).
 *
 * Mismo patrón que el resto de módulos de rutas del CRM: se llama desde la
 * cadena de `/api/admin/*` DESPUÉS de comprobar la sesión y el CSRF, y devuelve
 * `true` cuando ya respondió.
 *
 * AUTORIZACIÓN
 *   - Sin `tickets.read` no se entra ni a la bandeja (403), aunque haya sesión.
 *   - Además de la sesión, cada ticket comprueba PARTICIPACIÓN (o
 *     `tickets.read_all`). El navegador no decide nada: la lista de la bandeja ya
 *     viene recortada del servidor.
 *   - Todo lo que escribe exige `idempotencyKey` o `clientKey` en el mensaje.
 */

import {
  OPS_TASK_ACTIONS,
  activeTicketForOrder,
  createTicket,
  inboxSummary,
  listInbox,
  participantDirectory,
  readTicket,
  removeParticipant,
  resolveTicket,
  searchOrderOptions,
  taskAction,
  updateTicket,
  addParticipant,
  projectTicket,
  participantOf,
  recordEvent,
} from './tickets.mjs';
import { acknowledge, markRead, postMessage } from './messages.mjs';
import {
  assignAgentToTicket,
  decideApproval,
  listAgents,
  listApprovals,
  runsForTicket,
  saveAgent,
} from './agents.mjs';
import { toolCatalog } from './tools.mjs';
import { agentOffice, centroDirectory } from './centro.mjs';
import { delegationsForTicket } from './collaboration.mjs';
import { commercialSnapshot } from './commercial.mjs';
import { agentAsk, agentFacts, factsToText } from './ask.mjs';
import {
  applyWorkDecision,
  buildWorkSystemPrompt,
  buildWorkUserPrompt,
  decideWorkProposal,
  ensureWorkAgent,
  proposeWork,
  workSnapshot,
} from './work.mjs';

const ID = '[a-zA-Z0-9_.:%-]+';

function clean(value, max = 120) {
  return String(value ?? '').trim().slice(0, max);
}

export async function handleOpsRoute({ req, res, route, ctx, actor, json, readJson, can, findOrder = null, listOrders = null, notify = null, llm = null, ai = null, aiTools = null }) {
  if (!/^\/api\/admin\/ops(?:\/|$)/.test(route)) return false;

  const send = (status, body) => {
    json(res, status, body);
    return true;
  };

  if (!can('tickets.read')) {
    return send(403, { ok: false, error: 'forbidden', message: 'No tienes acceso al centro de operaciones.' });
  }

  const method = String(req.method ?? 'GET').toUpperCase();
  /*
   * Dependencias que el módulo no debe conocer por dentro: avisos con push y
   * la lectura de pedidos que usan las herramientas de los agentes. Se inyectan
   * para que `ops/` no importe el servidor principal (y no haya ciclos).
   */
  const deps = { notify, findOrder };
  const readBody = async () => {
    try {
      const body = await readJson(req);
      return body && typeof body === 'object' ? body : {};
    } catch (error) {
      return { __error: error };
    }
  };
  const fail = (result) =>
    send(result.status ?? 400, {
      ok: false,
      error: result.error ?? 'ops_error',
      message: result.message ?? null,
      ...(result.ticket ? { ticket: result.ticket } : {}),
    });

  try {
    /* ------------------------------------------------------------- bandeja */
    if (route === '/api/admin/ops/inbox' && method === 'GET') {
      const params = new URLSearchParams(String(req.url ?? '').split('?')[1] ?? '');
      const result = await listInbox({
        ctx,
        actor,
        can,
        filter: clean(params.get('filter') ?? 'abiertos', 20),
        q: clean(params.get('q') ?? '', 80),
        type: clean(params.get('type') ?? '', 30),
      });
      /*
       * Contador de aprobaciones pendientes junto a la bandeja: evita una
       * petición extra en cada refresco y solo se cuenta a quien puede decidir.
       */
      const pendingApprovals = can('tickets.close')
        ? (await listApprovals({ ctx, status: 'pending' })).length
        : 0;
      return send(200, { ...result, pendingApprovals });
    }

    if (route === '/api/admin/ops/summary' && method === 'GET') {
      return send(200, await inboxSummary({ ctx, actor, can }));
    }

    /* --------------------------------------------------- alta de un ticket */
    if (route === '/api/admin/ops/tickets' && method === 'POST') {
      const body = await readBody();
      if (body.__error) return send(400, { ok: false, error: 'bad_request', message: 'No se pudo leer la petición.' });
      const result = await createTicket({ ctx, actor, can, input: body, findOrder, deps });
      if (!result.ok) return fail(result);
      return send(result.status ?? 201, { ok: true, ticket: result.ticket });
    }

    /* El ticket activo de un pedido (para «abrir/crear ticket» desde el pedido). */
    const orderMatch = new RegExp(`^/api/admin/ops/orders/(${ID})/ticket$`).exec(route);
    if (orderMatch && method === 'GET') {
      const result = await activeTicketForOrder({ ctx, actor, can, orderId: orderMatch[1] });
      if (!result.ok) return fail(result);
      return send(200, { ok: true, ticket: result.ticket });
    }

    /*
     * BUSCADOR DE PEDIDOS para vincular un ticket.
     * Devuelve como máximo 8 candidatos y solo lo justo para reconocerlos: sin
     * teléfono ni dirección. El permiso ya está garantizado por `orders.read`
     * en los roles que pueden crear tickets; quien no lo tenga no llega aquí.
     */
    if (route === '/api/admin/ops/orders' && method === 'GET') {
      if (!can('orders.read')) {
        return send(403, { ok: false, error: 'forbidden', message: 'No puedes buscar pedidos.' });
      }
      if (typeof listOrders !== 'function') {
        return send(503, { ok: false, error: 'orders_unavailable', message: 'No se pudo consultar los pedidos.' });
      }
      const params = new URLSearchParams(String(req.url ?? '').split('?')[1] ?? '');
      const rows = await listOrders();
      const orders = searchOrderOptions({
        rows,
        query: clean(params.get('q') ?? '', 60),
        limit: Number(params.get('limit') ?? 8),
      });
      return send(200, { ok: true, orders });
    }

    /* --------------------------------------------------- un ticket concreto */
    const ticketMatch = new RegExp(`^/api/admin/ops/tickets/(${ID})$`).exec(route);
    if (ticketMatch && method === 'GET') {
      const params = new URLSearchParams(String(req.url ?? '').split('?')[1] ?? '');
      const result = await readTicket({
        ctx,
        actor,
        can,
        id: ticketMatch[1],
        messageLimit: Number(params.get('limit') ?? 200),
        beforeSeq: params.get('before'),
      });
      if (!result.ok) return fail(result);
      /*
       * La ficha necesita saber, además del hilo: qué aprobaciones hay en este
       * ticket y cómo van las ejecuciones de sus agentes. Se leen aparte para
       * que el módulo de tickets no dependa del de agentes.
       */
      const [approvals, runs, delegations] = await Promise.all([
        listApprovals({ ctx, status: 'all', ticketId: result.ticket.id }),
        runsForTicket({ ctx, ticketId: result.ticket.id }),
        delegationsForTicket({ ctx, ticketId: result.ticket.id }),
      ]);
      return send(200, { ok: true, ...result, approvals, runs, delegations });
    }

    if (ticketMatch && method === 'PATCH') {
      const body = await readBody();
      if (body.__error) return send(400, { ok: false, error: 'bad_request', message: 'No se pudo leer la petición.' });
      const result = await updateTicket({ ctx, actor, can, id: ticketMatch[1], patch: body, deps });
      if (!result.ok) return fail(result);
      return send(200, { ok: true, ticket: result.ticket });
    }

    /* ----------------------------------------------------------- mensajes */
    const messagesMatch = new RegExp(`^/api/admin/ops/tickets/(${ID})/messages$`).exec(route);
    if (messagesMatch && method === 'POST') {
      const body = await readBody();
      if (body.__error) return send(400, { ok: false, error: 'bad_request', message: 'No se pudo leer la petición.' });
      const result = await postMessage({
        ctx,
        actor,
        can,
        ticketId: messagesMatch[1],
        body: body.body ?? body.text ?? '',
        clientKey: body.clientKey ?? body.idempotencyKey ?? null,
        deps,
      });
      if (!result.ok) return fail(result);
      return send(result.status ?? 201, {
        ok: true,
        duplicate: Boolean(result.duplicate),
        message: result.message,
        ticket: result.ticket,
      });
    }

    /* ------------------------------------------------- lectura y acuse */
    const readMatch = new RegExp(`^/api/admin/ops/tickets/(${ID})/read$`).exec(route);
    if (readMatch && method === 'POST') {
      const body = await readBody();
      if (body.__error) return send(400, { ok: false, error: 'bad_request', message: 'No se pudo leer la petición.' });
      const result = await markRead({ ctx, actor, can, ticketId: readMatch[1], seq: body.seq });
      if (!result.ok) return fail(result);
      return send(200, result);
    }

    const ackMatch = new RegExp(`^/api/admin/ops/tickets/(${ID})/ack$`).exec(route);
    if (ackMatch && method === 'POST') {
      const body = await readBody();
      if (body.__error) return send(400, { ok: false, error: 'bad_request', message: 'No se pudo leer la petición.' });
      const result = await acknowledge({
        ctx,
        actor,
        can,
        ticketId: ackMatch[1],
        seq: body.seq,
        note: body.note ?? '',
        deps,
      });
      if (!result.ok) return fail(result);
      return send(200, result);
    }

    /* ------------------------------------------------------------ cierre */
    const resolveMatch = new RegExp(`^/api/admin/ops/tickets/(${ID})/resolve$`).exec(route);
    if (resolveMatch && method === 'POST') {
      const body = await readBody();
      if (body.__error) return send(400, { ok: false, error: 'bad_request', message: 'No se pudo leer la petición.' });
      const result = await resolveTicket({
        ctx,
        actor,
        can,
        id: resolveMatch[1],
        resolution: body.resolution ?? body.note ?? '',
        cancelled: body.cancelled === true,
        deps,
      });
      if (!result.ok) return fail(result);
      return send(200, { ok: true, ticket: result.ticket });
    }

    /* ------------------------------------------------------ seguimiento de tarea */
    const taskMatch = new RegExp(`^/api/admin/ops/tickets/(${ID})/task$`).exec(route);
    if (taskMatch && method === 'POST') {
      const body = await readBody();
      if (body.__error) return send(400, { ok: false, error: 'bad_request', message: 'No se pudo leer la petición.' });
      const result = await taskAction({
        ctx,
        actor,
        can,
        id: taskMatch[1],
        action: body.action,
        note: body.note ?? '',
        idempotencyKey: body.idempotencyKey ?? body.idempotency_key ?? null,
        deps,
      });
      if (!result.ok) return fail(result);
      return send(200, { ok: true, duplicate: Boolean(result.duplicate), ticket: result.ticket });
    }

    /* --------------------------------------------------------- el equipo */
    if (route === '/api/admin/ops/users' && method === 'GET') {
      const params = new URLSearchParams(String(req.url ?? '').split('?')[1] ?? '');
      const result = await participantDirectory({ ctx, can, q: params.get('q') ?? '' });
      if (!result.ok) return fail(result);
      return send(200, result);
    }

    /* --------------------------------------------------------- agentes */
    /*
     * CENTRO IA — EL EQUIPO. Es la pantalla de entrada y la lee cualquiera con
     * `tickets.read`: son agentes internos, no datos de clientes. Los extras
     * (aprobaciones, administración) solo se cuentan a quien puede usarlos.
     */
    if (route === '/api/admin/ops/centro' && method === 'GET') {
      return send(200, await centroDirectory({ ctx, can }));
    }

    /*
     * OFICINA DE UN AGENTE. `:key` es su clave estable. Si no existe, 404: la
     * pantalla no se inventa un agente.
     */
    const officeMatch = new RegExp(`^/api/admin/ops/agents/(${ID})/office$`).exec(route);
    if (officeMatch && method === 'GET') {
      const result = await agentOffice({ ctx, can, key: officeMatch[1] });
      if (!result.ok) return send(404, { ok: false, error: result.error, message: 'Ese agente no existe.' });
      return send(200, result);
    }

    /* --------------------------------- AGENTE DE SEGUIMIENTO (Centro IA) */
    /*
     * Lectura del trabajo comercial: seguimientos, mensajes programados,
     * propuestas pendientes y totales. Solo lo que el usuario puede ver.
     */
    if (route === '/api/admin/ops/work' && method === 'GET') {
      if (!can('followups.read')) {
        return send(403, { ok: false, error: 'forbidden', message: 'No tienes acceso a seguimientos.' });
      }
      return send(200, { ok: true, ...(await workSnapshot({ ctx, actor, can })) });
    }

    /*
     * OPORTUNIDADES COMERCIALES (SOLO LECTURA).
     *
     * Resumen acotado —no la base— de lo que se puede ver: quién compró y no
     * ha vuelto, quién escribió y sigue sin respuesta, pedidos sin confirmar y
     * clientes frecuentes. Cada fila lleva su evidencia; los clientes con «no
     * contactar» o baja de WhatsApp quedan fuera y solo se cuentan.
     */
    if (route === '/api/admin/ops/work/commercial' && method === 'GET') {
      if (!can('followups.read')) {
        return send(403, { ok: false, error: 'forbidden', message: 'No tienes acceso a seguimientos.' });
      }
      const commercial = await commercialSnapshot({ ctx, can, actor, limits: { rows: 8 } });
      return send(200, { ok: true, commercial });
    }

    /*
     * CONSUMO Y PRESUPUESTO DEL PROVEEDOR IA.
     *
     * Es la contabilidad del propio CRM (llamadas, tokens, latencia y coste
     * ESTIMADO con las tarifas que se configuren). No es la factura del
     * proveedor y se dice en la respuesta.
     */
    if (route === '/api/admin/ops/ai/usage' && method === 'GET') {
      if (!can('admin.full')) return send(403, { ok: false, error: 'forbidden', message: 'Solo administración.' });
      const usage = typeof ctx.proofreading?.opsUsage === 'function' ? await ctx.proofreading.opsUsage() : null;
      if (!usage) {
        return send(200, { ok: true, usage: null, message: 'Este servidor no tiene el proveedor de IA configurado.' });
      }
      return send(200, { ok: true, usage });
    }

    /*
     * PEDIRLE CUENTAS A UN AGENTE.
     *
     * Solo LEE: contesta con sus ejecuciones, sus tickets y sus propuestas. No
     * escribe nada ni cambia el planificador del supervisor. Si el modelo no
     * está disponible contesta igual con el resumen determinista de registros.
     */
    const askMatch = new RegExp(`^/api/admin/ops/agents/(${ID})/ask$`).exec(route);
    if (askMatch && method === 'POST') {
      const body = await readBody();
      if (body.__error) return send(400, { ok: false, error: 'bad_request', message: 'No se pudo leer la petición.' });
      const message = clean(body.message, 800);
      if (!message) return send(422, { ok: false, error: 'message_required', message: 'Escribe qué quieres preguntar.' });
      /*
       * AUTORIZACIÓN POR RECURSO. El Agente de Seguimiento trabaja con datos
       * comerciales (clientes, compras, oportunidades): no se le puede
       * interrogar sin `followups.read`, aunque se tenga acceso a tickets. Los
       * demás agentes cuentan su propia operación y basta con `tickets.read`.
       */
      if (askMatch[1] === 'followup_agent' && !can('followups.read')) {
        return send(403, { ok: false, error: 'forbidden', message: 'No tienes acceso a seguimientos comerciales.' });
      }
      /*
       * HISTORIAL CORTO Y ACOTADO. Permite preguntas de seguimiento («y de esos,
       * ¿cuál compró más?») sin guardar nada en el servidor: lo manda el cliente,
       * se recortan los turnos y este usuario solo ve su propia conversación.
       */
      const history = Array.isArray(body.history)
        ? body.history
            .slice(-6)
            .map((turno) => ({ role: turno?.role === 'agent' ? 'agent' : 'user', text: clean(turno?.text, 600) }))
            .filter((turno) => turno.text)
        : [];
      const result = await agentAsk({ ctx, actor, can, key: askMatch[1], message, ai, aiTools, history });
      if (!result.ok) {
        const estado = result.error === 'agent_not_found' ? 404 : 422;
        return send(estado, {
          ok: false,
          error: result.error ?? 'ask_failed',
          message: result.error === 'agent_not_found' ? 'Ese agente no existe.' : 'No se pudo responder la pregunta.',
        });
      }
      /*
       * RASTRO DE CONSUMO. Se anota SIEMPRE: con modelo (tokens y milisegundos)
       * o sin él (respuesta de registros). Es la única forma de saber cuánto
       * gasta el Centro IA sin mirar la consola del proveedor.
       */
      await ctx.audit?.record?.({
        entity: 'ops_agent',
        entityId: askMatch[1],
        action: 'ops.agent_asked',
        actor: actor?.display_name ?? actor?.id ?? null,
        summary: result.answer.source === 'modelo'
          ? `${askMatch[1]}: respuesta del modelo (${result.answer.usage?.total ?? 0} tokens, ${result.answer.ms ?? 0} ms${result.answer.toolsUsed?.length ? `, ${result.answer.toolsUsed.length} consulta(s)` : ''})`
          : `${askMatch[1]}: respuesta de registros${result.answer.reason ? ` (${result.answer.reason})` : ''}`,
        data: {
          source: result.answer.source,
          reason: result.answer.reason ?? null,
          model: result.answer.model ?? null,
          tokens: result.answer.usage ?? null,
          ms: result.answer.ms ?? null,
          rounds: result.answer.rounds ?? null,
          tools: (result.answer.toolsUsed ?? []).map((row) => row.name),
        },
      }).catch(() => {});
      return send(200, { ok: true, ...result });
    }

    /*
     * CONVERSAR CON EL AGENTE.
     *
     * El modelo SOLO razona y propone: la respuesta trae texto y propuestas
     * validadas que quedan pendientes de aprobación humana. Aquí no se escribe
     * nada. Si el proveedor no está disponible, se dice (las listas siguen
     * funcionando y las programaciones ya aprobadas no dependen de él).
     */
    if (route === '/api/admin/ops/work/chat' && method === 'POST') {
      if (!can('followups.read')) {
        return send(403, { ok: false, error: 'forbidden', message: 'No tienes acceso a seguimientos.' });
      }
      const body = await readBody();
      if (body.__error) return send(400, { ok: false, error: 'bad_request', message: 'No se pudo leer la petición.' });
      const message = clean(body.message, 1000);
      if (!message) return send(422, { ok: false, error: 'message_required', message: 'Escribe qué necesitas.' });
      const snapshot = await workSnapshot({ ctx, actor, can });
      /*
       * SIN PROVEEDOR DE IA SE CONTESTA IGUAL, CON LOS REGISTROS.
       * Antes esto devolvía 503 y la pestaña «Conversar» quedaba inservible. Un
       * resumen de lo que de verdad hay (seguimientos, cola, propuestas) es útil
       * y no inventa nada: no se ejecuta ni se propone ninguna acción.
       */
      if (typeof llm !== 'function') {
        const facts = await agentFacts({ ctx, can, key: 'followup_agent', actor });
        return send(200, {
          ok: true,
          reply: facts.ok ? factsToText(facts.facts) : 'No tengo información suficiente todavía.',
          proposals: [],
          rejected: [],
          model: null,
          ms: null,
          degraded: true,
        });
      }
      /* Oportunidades reales del CRM, acotadas, para que pueda priorizar. */
      let commercial = null;
      try {
        commercial = await commercialSnapshot({ ctx, can, actor, limits: { rows: 8 } });
      } catch {
        commercial = null;
      }
      let answer = null;
      try {
        answer = await llm({
          system: buildWorkSystemPrompt(),
          user: buildWorkUserPrompt({ message, snapshot, commercial }),
          maxTokens: 900,
          actorId: `ops-agent:followup_agent:${actor?.id ?? 'anon'}`,
        });
      } catch {
        answer = null;
      }
      if (!answer) {
        /*
         * El proveedor falló (plazo, tope, clave o red). Se dice y se contesta
         * con los registros: NADA se simula como si fuera del modelo.
         */
        const facts = await agentFacts({ ctx, can, key: 'followup_agent', actor });
        await ctx.audit?.record?.({
          entity: 'ops_agent',
          entityId: 'followup_agent',
          action: 'ops.agent_asked',
          actor: actor?.display_name ?? actor?.id ?? null,
          summary: 'followup_agent: el modelo no respondió; se contestó con registros',
          data: { source: 'registros', reason: 'proveedor' },
        }).catch(() => {});
        return send(200, {
          ok: true,
          reply: facts.ok ? factsToText(facts.facts) : 'No tengo información suficiente todavía.',
          proposals: [],
          rejected: [],
          model: null,
          ms: null,
          degraded: true,
          reason: 'proveedor',
        });
      }
      const applied = await applyWorkDecision({ ctx, actor, can, raw: answer.json });
      await ctx.audit?.record?.({
        entity: 'ops_agent',
        entityId: 'followup_agent',
        action: 'ops.agent_asked',
        actor: actor?.display_name ?? actor?.id ?? null,
        summary: `followup_agent: respuesta del modelo (${answer.usage?.total ?? 0} tokens, ${answer.ms ?? 0} ms, ${applied.proposals.length} propuesta(s))`,
        data: {
          source: 'modelo',
          model: answer.model ?? null,
          tokens: answer.usage ?? null,
          ms: answer.ms ?? null,
          proposals: applied.proposals.length,
        },
      }).catch(() => {});
      return send(200, {
        ok: true,
        reply: applied.reply,
        proposals: applied.proposals,
        rejected: applied.rejected,
        model: answer.model ?? null,
        ms: answer.ms ?? null,
        usage: answer.usage ?? null,
        source: 'modelo',
      });
    }

    /* Alta (explícita) del Agente de Seguimiento. */
    if (route === '/api/admin/ops/work/agent' && method === 'POST') {
      const result = await ensureWorkAgent({ ctx, actor, can, saveAgent });
      if (!result.ok) {
        return send(result.status ?? 403, { ok: false, error: result.error, message: result.message ?? null });
      }
      return send(result.status ?? 200, { ok: true, agent: { key: result.agent.key, name: result.agent.name }, existing: result.existing === true });
    }

    /* Propuesta directa (la pide una persona desde la pantalla, sin modelo). */
    if (route === '/api/admin/ops/work/propose' && method === 'POST') {
      const body = await readBody();
      if (body.__error) return send(400, { ok: false, error: 'bad_request', message: 'No se pudo leer la petición.' });
      const result = await proposeWork({
        ctx,
        actor,
        can,
        action: clean(body.action, 40),
        params: body.params ?? {},
        justification: clean(body.justification, 300),
        origin: 'panel',
      });
      if (!result.ok) {
        return send(result.status ?? 422, { ok: false, error: result.error, message: result.message ?? null });
      }
      return send(result.status ?? 201, { ok: true, proposal: result.proposal, duplicate: Boolean(result.duplicate) });
    }

    /* Aprobar o rechazar una propuesta del Agente de Seguimiento. */
    const workDecide = new RegExp(`^/api/admin/ops/work/proposals/(${ID})/(approve|reject)$`).exec(route);
    if (workDecide && method === 'POST') {
      const body = await readBody();
      if (body.__error) return send(400, { ok: false, error: 'bad_request', message: 'No se pudo leer la petición.' });
      const result = await decideWorkProposal({
        ctx,
        actor,
        can,
        proposalId: workDecide[1],
        approve: workDecide[2] === 'approve',
        note: body.note ?? '',
      });
      if (!result.ok) {
        return send(result.status ?? 409, { ok: false, error: result.error, message: result.message ?? null });
      }
      return send(200, { ok: true, proposal: result.proposal, result: result.result ?? null, executed: result.executed === true });
    }

    if (route === '/api/admin/ops/agents' && method === 'GET') {
      if (!can('admin.full')) return send(403, { ok: false, error: 'forbidden', message: 'Solo administración.' });
      return send(200, { ok: true, agents: await listAgents({ ctx }), tools: toolCatalog() });
    }

    if (route === '/api/admin/ops/agents' && ['POST', 'PATCH'].includes(method)) {
      if (!can('admin.full')) return send(403, { ok: false, error: 'forbidden', message: 'Solo administración.' });
      const body = await readBody();
      if (body.__error) return send(400, { ok: false, error: 'bad_request', message: 'No se pudo leer la petición.' });
      const result = await saveAgent({ ctx, actor, input: body });
      if (!result.ok) return fail(result);
      return send(result.status ?? 200, { ok: true, agent: result.agent });
    }

    /* Asignar un agente a un ticket (lo hace una persona). */
    const agentAssign = new RegExp(`^/api/admin/ops/tickets/(${ID})/agent$`).exec(route);
    if (agentAssign && method === 'POST') {
      const body = await readBody();
      if (body.__error) return send(400, { ok: false, error: 'bad_request', message: 'No se pudo leer la petición.' });
      const result = await assignAgentToTicket({
        ctx,
        deps,
        actor,
        can,
        ticketId: agentAssign[1],
        agentKey: body.agentKey ?? body.agent_key,
      });
      if (!result.ok) return fail(result);
      return send(200, { ok: true, run: result.run ?? null, agent: { key: result.agent.key, name: result.agent.name } });
    }

    const runsMatch = new RegExp(`^/api/admin/ops/tickets/(${ID})/runs$`).exec(route);
    if (runsMatch && method === 'GET') {
      return send(200, { ok: true, runs: await runsForTicket({ ctx, ticketId: runsMatch[1] }) });
    }

    /* Delegaciones de un ticket (quién pidió ayuda a quién y cómo acabó). */
    if (route === '/api/admin/ops/delegations' && method === 'GET') {
      const params = new URLSearchParams(String(req.url ?? '').split('?')[1] ?? '');
      const ticketId = clean(params.get('ticket') ?? '', 80);
      if (!ticketId) {
        return send(422, { ok: false, error: 'ticket_required', message: 'Indica el ticket.' });
      }
      return send(200, { ok: true, delegations: await delegationsForTicket({ ctx, ticketId }) });
    }

    /* ------------------------------------------------------ aprobaciones */
    if (route === '/api/admin/ops/approvals' && method === 'GET') {
      const params = new URLSearchParams(String(req.url ?? '').split('?')[1] ?? '');
      const approvals = await listApprovals({
        ctx,
        status: params.get('status') ?? 'pending',
        ticketId: params.get('ticket') ?? null,
      });
      return send(200, { ok: true, approvals });
    }

    const approvalDecide = new RegExp(`^/api/admin/ops/approvals/(${ID})/(approve|reject)$`).exec(route);
    if (approvalDecide && method === 'POST') {
      const body = await readBody();
      if (body.__error) return send(400, { ok: false, error: 'bad_request', message: 'No se pudo leer la petición.' });
      const result = await decideApproval({
        ctx,
        deps,
        actor,
        can,
        approvalId: approvalDecide[1],
        approve: approvalDecide[2] === 'approve',
        note: body.note ?? '',
      });
      if (!result.ok) return fail(result);
      return send(200, { ok: true, approval: result.approval, result: result.result ?? null });
    }

    /* ------------------------------------------------------ participantes */
    const participantDrop = new RegExp(`^/api/admin/ops/tickets/(${ID})/participants/(${ID})$`).exec(route);
    if (participantDrop && method === 'DELETE') {
      const result = await removeParticipant({
        ctx,
        actor,
        can,
        id: participantDrop[1],
        userId: participantDrop[2],
      });
      if (!result.ok) return fail(result);
      return send(200, { ok: true, ticket: result.ticket });
    }

    const participantsMatch = new RegExp(`^/api/admin/ops/tickets/(${ID})/participants$`).exec(route);
    if (participantsMatch && method === 'POST') {
      if (!can('tickets.participants.manage')) {
        return send(403, { ok: false, error: 'forbidden', message: 'No puedes cambiar los participantes.' });
      }
      const body = await readBody();
      if (body.__error) return send(400, { ok: false, error: 'bad_request', message: 'No se pudo leer la petición.' });
      const ticket = await ctx.db.get('ops_tickets', participantsMatch[1]);
      if (!ticket) return send(404, { ok: false, error: 'ticket_not_found', message: 'Ese ticket no existe.' });
      const userId = clean(body.userId, 80);
      if (!userId) return send(422, { ok: false, error: 'user_required', message: 'Elige la persona.' });
      const users = await ctx.users.listUsers();
      const target = users.find((user) => user.id === userId && user.active !== false);
      if (!target) return send(422, { ok: false, error: 'invalid_user', message: 'Ese usuario no existe.' });
      await addParticipant(ctx, {
        ticketId: ticket.id,
        userId: target.id,
        name: target.display_name,
        role: body.role === 'assignee' ? 'assignee' : 'watcher',
        actor,
      });
      await recordEvent(ctx, {
        ticketId: ticket.id,
        kind: 'participant_added',
        actor,
        summary: `Añadido ${target.display_name ?? target.id}`,
      });
      await ctx.audit?.record?.({
        entity: 'ticket',
        entityId: ticket.id,
        action: 'ticket_participant_added',
        actor: actor?.display_name ?? null,
        summary: `${ticket.number} · +${target.display_name ?? target.id}`,
      });
      const myParticipant = await participantOf(ctx, ticket.id, actor?.id);
      return send(200, { ok: true, ticket: projectTicket(ticket, { can, myParticipant }) });
    }

    return send(404, { ok: false, error: 'not_found', message: 'Ruta del centro de operaciones desconocida.' });
  } catch (error) {
    /* Un fallo inesperado se cuenta en el log con su traza, no al navegador. */
    console.error('[ops] error:', error);
    return send(500, { ok: false, error: 'server_error', message: 'No se pudo completar la operación.' });
  }
}
