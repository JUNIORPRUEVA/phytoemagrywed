// @vitest-environment node
/**
 * CENTRO IA — OFICINA DE AGENTES, REGISTRO COMPARTIDO Y COLABORACIÓN.
 *
 * Qué se comprueba aquí (sin navegador y sin proveedor de modelo):
 *  1. El registro de herramientas declara TODO lo que el contrato exige y las
 *     herramientas peligrosas siguen desactivadas.
 *  2. El directorio del equipo y la oficina de un agente salen de datos reales
 *     (estados derivados de los runs, contadores y avisos comprobables).
 *  3. La colaboración entre agentes: se delega en el MISMO ticket, sin mover
 *     permisos, y se rechaza lo que no está autorizado (uno mismo, agente
 *     desactivado, tipo de ticket, bucles, profundidad y tope).
 *
 * Las pruebas de navegador están en `tests/panel-centro-ia-uat.test.js`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';
import { opsAgentTick } from '../server/ops/agents.mjs';
import { OPS_TOOLS, assignableTools, toolCatalog, toolSpec, validateArgs } from '../server/ops/tools.mjs';
import { agentOffice, agentStateOf, centroDirectory } from '../server/ops/centro.mjs';
import {
  MAX_DELEGATION_DEPTH,
  MAX_DELEGATIONS_PER_TICKET,
  listCollaborators,
} from '../server/ops/collaboration.mjs';

const TOKEN = 'centro-ia-token';
const ADMIN = { username: 'centro.admin', password: 'Centro-123456', name: 'Admin Centro' };
const OPERADOR = { username: 'centro.operador', password: 'Oper-123456', name: 'Operador Centro' };

let tmpDir;
let app;
let adminCookie = '';
let operadorId = '';
let operadorCookie = '';

const json = async (response) => JSON.parse(await response.text());

function call(route, options = {}, cookie = adminCookie) {
  return fetch(`${app.url}${route}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {}),
    },
  });
}

async function login({ username, password }) {
  const response = await fetch(`${app.url}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}

async function createAgent(input) {
  const response = await call('/api/admin/ops/agents', { method: 'POST', body: JSON.stringify(input) });
  expect(response.status).toBe(201);
  return (await json(response)).agent;
}

async function createTicket(input) {
  const response = await call('/api/admin/ops/tickets', { method: 'POST', body: JSON.stringify(input) });
  expect(response.status).toBe(201);
  return (await json(response)).ticket;
}

const tick = () => opsAgentTick({ ctx: app.ctx, deps: { notify: (input) => app.notifyUser(input) } });

async function drain(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) await tick();
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-centro-ia-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'centro.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
    whatsapp: {
      enabled: false,
      async sendText() {
        throw new Error('UAT: no se envía WhatsApp');
      },
      async sendTemplate() {
        throw new Error('UAT: no se envía WhatsApp');
      },
      async markAsRead() {
        return { ok: true };
      },
    },
    bootstrapAdminUser: ADMIN.username,
    bootstrapAdminPassword: ADMIN.password,
    bootstrapAdminDisplayName: ADMIN.name,
  });
  adminCookie = await login(ADMIN);
  const created = await call('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: OPERADOR.username, password: OPERADOR.password, role: 'OPERADOR', displayName: OPERADOR.name }),
  });
  expect(created.status).toBe(201);
  operadorId = (await json(created)).user.id;
  operadorCookie = await login(OPERADOR);
}, 60_000);

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/* ============================================ 1. REGISTRO COMPARTIDO */

describe('registro compartido de herramientas', () => {
  it('cada herramienta declara identificador, entradas, salidas, permiso, alcance, riesgo, plazo e idempotencia', () => {
    const catalog = toolCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(15);
    for (const tool of catalog) {
      expect(tool.name).toBeTruthy();
      expect(typeof tool.description).toBe('string');
      expect(['read', 'write', 'high_impact', 'forbidden']).toContain(tool.effect);
      expect(['ticket', 'order', 'agent', 'followup', 'message']).toContain(tool.scope);
      expect(['low', 'medium', 'high']).toContain(tool.risk);
      expect(typeof tool.idempotent).toBe('boolean');
      expect(['call', 'action']).toContain(tool.audit);
      expect(tool.timeoutMs).toBeGreaterThan(0);
      expect(tool.timeoutMs).toBeLessThanOrEqual(20_000);
      expect(typeof tool.inputs).toBe('object');
      expect(typeof tool.outputs).toBe('object');
    }
  });

  it('las herramientas peligrosas siguen desactivadas o prohibidas y no se pueden asignar', () => {
    const assignable = assignableTools();
    for (const name of ['order.change_total', 'order.cancel', 'order.refund', 'customer.update_sensitive']) {
      expect(OPS_TOOLS[name].enabled).toBe(false);
      expect(assignable).not.toContain(name);
    }
    for (const name of ['db.query_raw', 'server.exec', 'whatsapp.send_external']) {
      expect(OPS_TOOLS[name].effect).toBe('forbidden');
      expect(assignable).not.toContain(name);
    }
    /* Sigue habiendo UNA herramienta con aprobación humana obligatoria. */
    expect(OPS_TOOLS['ticket.close'].requiresApproval).toBe(true);
    expect(assignable).toContain('ticket.close');
  });

  it('la ficha de una herramienta y la validación de argumentos no inventan nada', () => {
    const spec = toolSpec('agent.request_help');
    expect(spec.permission).toBe('tickets.update');
    expect(spec.scope).toBe('agent');
    expect(toolSpec('no.existe')).toBeNull();

    expect(validateArgs('agent.request_help', {}).error).toBe('missing_arg:agentKey');
    expect(validateArgs('agent.request_help', { agentKey: 'x' }).error).toBe('missing_arg:question');
    expect(validateArgs('agent.request_help', { agentKey: 'a', question: 'b', sobra: 'x' }).args).toEqual({
      agentKey: 'a',
      question: 'b',
    });
  });

  it('un agente no puede recibir una herramienta desactivada ni darse permisos', async () => {
    const disabled = await call('/api/admin/ops/agents', {
      method: 'POST',
      body: JSON.stringify({ key: 'malo_desactivado', name: 'Malo', tools: ['order.refund'], ticketTypes: ['delivery'] }),
    });
    expect(disabled.status).toBe(422);
    expect((await json(disabled)).error).toBe('tool_disabled');

    const forbidden = await call('/api/admin/ops/agents', {
      method: 'POST',
      body: JSON.stringify({ key: 'malo_prohibido', name: 'Malo', tools: ['db.query_raw'], ticketTypes: ['delivery'] }),
    });
    expect(forbidden.status).toBe(422);
    expect((await json(forbidden)).error).toBe('tool_forbidden');
  });
});

/* ========================================== 2. DIRECTORIO Y OFICINA */

describe('directorio del equipo y oficina del agente', () => {
  it('lista los agentes con estado y contadores REALES (sin trabajo = en reposo)', async () => {
    await createAgent({
      key: 'reposo_uno',
      name: 'Agente En Reposo',
      role: 'Solo lectura',
      tools: ['ticket.get_context'],
      ticketTypes: ['delivery'],
      responsibilities: ['Mirar tickets'],
    });
    const response = await call('/api/admin/ops/centro');
    expect(response.status).toBe(200);
    const body = await json(response);
    const agent = body.agents.find((row) => row.key === 'reposo_uno');
    expect(agent).toBeTruthy();
    expect(agent.state).toBe('idle');
    expect(agent.stateLabel).toBe('En reposo');
    expect(agent.pending).toBe(0);
    expect(agent.unread).toBe(0);
    expect(agent.assigned).toBe(0);
    expect(agent.responsibilities).toEqual(['Mirar tickets']);
    expect(agent.planner).toBe('deterministic');
    /* Los totales son la suma de los agentes, no una cifra decorativa. */
    expect(body.totals.agents).toBe(body.agents.length);
    expect(body.totals.pending).toBe(body.agents.reduce((sum, row) => sum + row.pending, 0));
  });

  it('la oficina devuelve identidad, herramientas autorizadas y avisos honrados', async () => {
    const response = await call('/api/admin/ops/agents/reposo_uno/office');
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.agent.key).toBe('reposo_uno');
    expect(body.agent.tools.map((tool) => tool.name)).toEqual(['ticket.get_context']);
    expect(body.agent.config.collaboration).toBe(true);
    /* Aviso honesto: este agente no usa modelo. */
    expect(body.alerts.map((alert) => alert.text).join(' ')).toContain('determinista');
    expect(body.assigned).toEqual([]);
    expect(body.pending).toEqual([]);
    expect(body.stats.tools).toBe(1);
  });

  it('una clave que no existe no se inventa: 404', async () => {
    const response = await call('/api/admin/ops/agents/no_existe/office');
    expect(response.status).toBe(404);
    expect((await json(response)).error).toBe('agent_not_found');
  });

  it('el estado del agente se deriva de sus runs (no se guarda a mano)', () => {
    const now = '2026-10-21T10:00:00.000Z';
    expect(agentStateOf({ agent: { enabled: false }, runs: [], now })).toBe('paused');
    expect(agentStateOf({ agent: {}, runs: [], now })).toBe('idle');
    expect(agentStateOf({ agent: {}, runs: [{ status: 'running' }], now })).toBe('working');
    expect(agentStateOf({ agent: {}, runs: [{ status: 'waiting_human' }], now })).toBe('waiting_human');
    expect(agentStateOf({ agent: {}, runs: [{ status: 'waiting_event', next_run_at: '2099-01-01T00:00:00.000Z' }], now })).toBe('waiting');
    expect(agentStateOf({ agent: {}, runs: [{ status: 'waiting_event', next_run_at: '2020-01-01T00:00:00.000Z' }], now })).toBe('working');
  });

  it('la oficina cuenta el trabajo pendiente cuando el agente tiene un run vivo', async () => {
    const ticket = await createTicket({
      type: 'delivery',
      title: 'Confirmar entrega de la mañana',
      priority: 'normal',
      requiresAck: true,
    });
    const assign = await call(`/api/admin/ops/tickets/${ticket.id}/agent`, {
      method: 'POST',
      body: JSON.stringify({ agentKey: 'reposo_uno' }),
    });
    expect(assign.status).toBe(200);

    const office = await json(await call('/api/admin/ops/agents/reposo_uno/office'));
    expect(office.assigned.map((row) => row.id)).toContain(ticket.id);
    expect(office.pending.length).toBeGreaterThan(0);
    expect(office.stats.pending).toBeGreaterThan(0);
    expect(office.stats.assigned).toBe(1);
    /* El directorio lo refleja igual: mismo dato, dos vistas. */
    const directory = await json(await call('/api/admin/ops/centro'));
    const row = directory.agents.find((agent) => agent.key === 'reposo_uno');
    expect(row.pending).toBe(office.stats.pending);
    expect(row.assigned).toBe(1);
  });

  it('la bandeja de aprobaciones solo se cuenta a quien puede decidir', async () => {
    const asAdmin = await json(await call('/api/admin/ops/centro'));
    expect(asAdmin.canApprove).toBe(true);
    expect(asAdmin.canAdmin).toBe(true);
    /* Un operador con tickets.read ve el equipo, pero no administra. */
    const asOperator = await json(await call('/api/admin/ops/centro', {}, operadorCookie));
    expect(asOperator.ok).toBe(true);
    expect(asOperator.agents.length).toBeGreaterThan(0);
    expect(asOperator.canAdmin).toBe(false);
  });
});

/* ================================== 3. COLABORACIÓN ENTRE AGENTES */

describe('colaboración entre agentes', () => {
  let requester;
  let helper;
  let helperWithoutType;
  let helperDisabled;
  let helperOptOut;

  beforeAll(async () => {
    requester = await createAgent({
      key: 'supervisor_delivery',
      name: 'Supervisor Delivery',
      role: 'Seguimiento de entregas',
      tools: ['ticket.get_context', 'ticket.post_message', 'ticket.request_ack', 'ticket.complete_work', 'agent.request_help'],
      ticketTypes: ['delivery'],
      config: { followUpMinutes: 20 },
    });
    helper = await createAgent({
      key: 'asesor_pedidos',
      name: 'Asesor de pedidos',
      role: 'Aclaraciones de pedido',
      tools: ['ticket.get_context', 'ticket.post_message', 'ticket.complete_work'],
      ticketTypes: ['delivery'],
    });
    helperWithoutType = await createAgent({
      key: 'agente_inventario',
      name: 'Agente de inventario',
      tools: ['ticket.get_context', 'ticket.post_message'],
      ticketTypes: ['inventory'],
    });
    helperDisabled = await createAgent({
      key: 'agente_apagado',
      name: 'Agente apagado',
      tools: ['ticket.get_context', 'ticket.post_message'],
      ticketTypes: ['delivery'],
    });
    await call('/api/admin/ops/agents', {
      method: 'PATCH',
      body: JSON.stringify({ key: 'agente_apagado', name: 'Agente apagado', enabled: false, tools: ['ticket.get_context'], ticketTypes: ['delivery'] }),
    });
    helperOptOut = await createAgent({
      key: 'agente_solitario',
      name: 'Agente solitario',
      tools: ['ticket.get_context', 'ticket.post_message'],
      ticketTypes: ['delivery'],
      config: { collaboration: false },
    });
    /*
     * `reposo_uno` se creó antes en la sección anterior y también es de
     * `delivery`: se cambia de tipo para que el primer compañero válido sea el
     * que esta batería espera (el orden es por fecha de alta).
     */
    await call('/api/admin/ops/agents', {
      method: 'PATCH',
      body: JSON.stringify({ key: 'reposo_uno', name: 'Agente En Reposo', tools: ['ticket.get_context'], ticketTypes: ['inventory'] }),
    });
  }, 30_000);

  it('solo ofrece compañeros activos, del mismo tipo de ticket y que acepten ayuda', async () => {
    const ticket = { id: 't1', type: 'delivery' };
    const agent = await app.ctx.db.findBy('ops_agents', 'key', 'supervisor_delivery');
    const peers = await listCollaborators({ ctx: app.ctx, agent, ticket });
    const keys = peers.map((peer) => peer.key);
    expect(keys).toContain('asesor_pedidos');
    expect(keys).not.toContain('supervisor_delivery');
    expect(keys).not.toContain('agente_apagado');
    expect(keys).not.toContain('agente_inventario');
    expect(keys).not.toContain('agente_solitario');
  });

  it('delega en el MISMO ticket, deja constancia y el compañero responde con SUS herramientas', async () => {
    const ticket = await createTicket({
      type: 'delivery',
      title: 'Entrega sin confirmar (delegación)',
      priority: 'urgent',
      requiresAck: true,
    });
    await call(`/api/admin/ops/tickets/${ticket.id}/agent`, {
      method: 'POST',
      body: JSON.stringify({ agentKey: 'supervisor_delivery' }),
    });
    await drain(8);

    const delegations = (await json(await call(`/api/admin/ops/delegations?ticket=${ticket.id}`))).delegations;
    expect(delegations.length).toBe(1);
    expect(delegations[0].fromKey).toBe('supervisor_delivery');
    expect(delegations[0].toKey).toBe('asesor_pedidos');
    expect(['pending', 'accepted', 'completed']).toContain(delegations[0].status);

    /* No se abrió otro ticket: el trabajo vive en el mismo hilo. */
    const ticketView = await json(await call(`/api/admin/ops/tickets/${ticket.id}`));
    expect(ticketView.delegations.length).toBe(1);
    const bodies = ticketView.messages.map((message) => message.body).join('\n');
    expect(bodies).toContain('Le pido ayuda a Asesor de pedidos');
    expect(bodies).toContain('Reviso lo que me pide Supervisor Delivery');

    /* El receptor entró como participante (autorización explícita). */
    const participants = ticketView.ticket.participants ?? ticketView.participants ?? [];
    const names = (participants ?? []).map((row) => row.name ?? row.participantName ?? '');
    expect(names.join(' ')).toContain('Asesor de pedidos');

    /* El compañero usa SU lista de herramientas: no escribe como el otro. */
    const helperRow = await app.ctx.db.findBy('ops_agents', 'key', 'asesor_pedidos');
    expect(helperRow.tools).not.toContain('agent.request_help');
    expect(helperRow.permissions).toEqual(['tickets.read', 'tickets.reply', 'tickets.update']);
  });

  it('rechaza pedirse ayuda a uno mismo', async () => {
    const { requestHelp } = await import('../server/ops/collaboration.mjs');
    const direct = await requestHelp({
      ctx: app.ctx,
      agent: await app.ctx.db.findBy('ops_agents', 'key', 'supervisor_delivery'),
      ticket: { id: 'tx', type: 'delivery', number: 'TK-X' },
      run: { id: 'run_x', state: {} },
      args: { agentKey: 'supervisor_delivery', question: 'ayuda' },
      ensureRun: async () => null,
    });
    expect(direct.ok).toBe(false);
    expect(direct.error.code).toBe('delegation_self');
  });

  it('rechaza un compañero desactivado, de otro tipo de ticket o que no acepta ayuda', async () => {
    const { requestHelp } = await import('../server/ops/collaboration.mjs');
    const agent = await app.ctx.db.findBy('ops_agents', 'key', 'supervisor_delivery');
    const ticket = { id: 'ty', type: 'delivery', number: 'TK-Y' };
    const attempt = (agentKey) =>
      requestHelp({ ctx: app.ctx, agent, ticket, run: { id: 'run_y', state: {} }, args: { agentKey, question: 'ayuda' }, ensureRun: async () => null });

    expect((await attempt('agente_apagado')).error.code).toBe('delegation_target_disabled');
    expect((await attempt('agente_inventario')).error.code).toBe('delegation_type_denied');
    expect((await attempt('agente_solitario')).error.code).toBe('delegation_target_opt_out');
    expect((await attempt('no_existe')).error.code).toBe('delegation_target_missing');
    expect((await attempt('')).error.code).toBe('delegation_target_required');
  });

  it('corta los bucles y la profundidad de la cadena', async () => {
    const { requestHelp } = await import('../server/ops/collaboration.mjs');
    const agent = await app.ctx.db.findBy('ops_agents', 'key', 'supervisor_delivery');
    const ticket = { id: 'tz', type: 'delivery', number: 'TK-Z' };
    /* El compañero ya está en la cadena → bucle. */
    const loop = await requestHelp({
      ctx: app.ctx,
      agent,
      ticket,
      run: { id: 'run_z', state: { delegationChain: ['asesor_pedidos'] } },
      args: { agentKey: 'asesor_pedidos', question: 'ayuda' },
      ensureRun: async () => null,
    });
    expect(loop.error.code).toBe('delegation_loop');

    /* Cadena ya en el máximo → no se permite un eslabón más. */
    const deep = await requestHelp({
      ctx: app.ctx,
      agent,
      ticket,
      run: { id: 'run_z2', state: { delegationChain: ['a', 'b'].slice(0, MAX_DELEGATION_DEPTH) } },
      args: { agentKey: 'asesor_pedidos', question: 'ayuda' },
      ensureRun: async () => null,
    });
    expect(deep.error.code).toBe('delegation_depth_exceeded');
  });

  it('repetir la misma petición devuelve la que ya está viva (no duplica)', async () => {
    const { requestHelp } = await import('../server/ops/collaboration.mjs');
    const ticket = await createTicket({ type: 'delivery', title: 'Duplicado de colaboración', priority: 'normal' });
    const agent = await app.ctx.db.findBy('ops_agents', 'key', 'supervisor_delivery');
    const ensureRun = async () => ({ id: 'run_fake' });
    const first = await requestHelp({
      ctx: app.ctx,
      agent,
      ticket,
      run: { id: 'run_dup_1', state: {} },
      args: { agentKey: 'asesor_pedidos', question: '¿está pagado?' },
      ensureRun,
    });
    expect(first.ok).toBe(true);
    const second = await requestHelp({
      ctx: app.ctx,
      agent,
      ticket,
      run: { id: 'run_dup_2', state: {} },
      args: { agentKey: 'asesor_pedidos', question: '¿está pagado?' },
      ensureRun,
    });
    expect(second.ok).toBe(true);
    expect(second.result.duplicate).toBe(true);
    expect(second.result.delegationId).toBe(first.result.delegationId);

    const rows = await app.ctx.db.list('ops_agent_delegations', { where: { ticket_id: ticket.id }, limit: 20 });
    expect(rows.length).toBe(1);
  });

  it('respeta el tope de peticiones por ticket', async () => {
    const { requestHelp } = await import('../server/ops/collaboration.mjs');
    const ticket = await createTicket({ type: 'delivery', title: 'Tope de colaboraciones', priority: 'normal' });
    const agent = await app.ctx.db.findBy('ops_agents', 'key', 'supervisor_delivery');
    const extra = await createAgent({
      key: 'asesor_extra',
      name: 'Asesor extra',
      tools: ['ticket.get_context', 'ticket.post_message'],
      ticketTypes: ['delivery'],
    });
    /* Se llena el tope con peticiones a destinatarios distintos, cerrando cada una. */
    const targets = ['asesor_pedidos', 'asesor_extra', 'asesor_pedidos', 'asesor_extra'];
    for (const [index, target] of targets.entries()) {
      const created = await requestHelp({
        ctx: app.ctx,
        agent,
        ticket,
        run: { id: `run_cap_${index}`, state: {} },
        args: { agentKey: target, question: `petición ${index}` },
        ensureRun: async () => ({ id: `run_cap_fake_${index}` }),
      });
      expect(created.ok).toBe(true);
      /* Se cierra POR ID: la lista no garantiza orden. */
      await app.ctx.db.update('ops_agent_delegations', created.result.delegationId, {
        status: 'completed',
        updated_at: new Date().toISOString(),
      });
    }
    const rows = await app.ctx.db.list('ops_agent_delegations', { where: { ticket_id: ticket.id }, limit: 20 });
    expect(rows.length).toBe(MAX_DELEGATIONS_PER_TICKET);

    const over = await requestHelp({
      ctx: app.ctx,
      agent,
      ticket,
      run: { id: 'run_cap_over', state: {} },
      args: { agentKey: extra.key, question: 'una más' },
      ensureRun: async () => ({ id: 'run_cap_fake_over' }),
    });
    expect(over.ok).toBe(false);
    expect(over.error.code).toBe('delegation_limit');
  });

  it('sin compañeros válidos, el agente sigue su trabajo sin bucle', async () => {
    const ticket = await createTicket({
      type: 'delivery',
      title: 'Ayuda imposible',
      priority: 'urgent',
      requiresAck: true,
    });
    /* Se dejan SIN compañeros válidos: uno de otro tipo y otro desactivado. */
    const advisor = await app.ctx.db.findBy('ops_agents', 'key', 'asesor_pedidos');
    const extra = await app.ctx.db.findBy('ops_agents', 'key', 'asesor_extra');
    await call('/api/admin/ops/agents', {
      method: 'PATCH',
      body: JSON.stringify({ key: advisor.key, name: advisor.name, tools: advisor.tools, ticketTypes: ['inventory'] }),
    });
    await call('/api/admin/ops/agents', {
      method: 'PATCH',
      body: JSON.stringify({ key: extra.key, name: extra.name, tools: extra.tools, ticketTypes: ['delivery'], enabled: false }),
    });
    await call(`/api/admin/ops/tickets/${ticket.id}/agent`, {
      method: 'POST',
      body: JSON.stringify({ agentKey: 'supervisor_delivery' }),
    });
    await drain(6);

    const runs = (await json(await call(`/api/admin/ops/tickets/${ticket.id}/runs`))).runs;
    const requesterRun = runs.find((run) => run.agentKey === 'supervisor_delivery');
    expect(requesterRun.status).not.toBe('failed');
    /* Sin nadie a quien pedir ayuda no se inventa una delegación. */
    const delegations = (await json(await call(`/api/admin/ops/delegations?ticket=${ticket.id}`))).delegations;
    expect(delegations.length).toBe(0);

    /* Se deja como estaba para no afectar a otras pruebas. */
    await call('/api/admin/ops/agents', {
      method: 'PATCH',
      body: JSON.stringify({ key: advisor.key, name: advisor.name, tools: advisor.tools, ticketTypes: ['delivery'] }),
    });
    await call('/api/admin/ops/agents', {
      method: 'PATCH',
      body: JSON.stringify({ key: extra.key, name: extra.name, tools: extra.tools, ticketTypes: ['delivery'], enabled: true }),
    });
  }, 30_000);
});
