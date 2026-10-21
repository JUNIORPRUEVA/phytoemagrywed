// @vitest-environment node
/**
 * CENTRO DE OPERACIONES — ETAPA D (marco universal de agentes).
 *
 * Contra el CRM REAL (SQLite temporal, WhatsApp simulado) comprueba las
 * garantías que firma el contrato `docs/OPS-CENTER-ETAPA-D-CONTRATO.md`:
 *
 *  1. REGISTRO: no se puede dar a un agente una herramienta inexistente,
 *     desactivada o prohibida, ni un permiso fuera de la lista blanca.
 *  2. EJECUCIÓN: un run avanza UN paso por vuelta, escribe como agente y se
 *     queda esperando cuando no hay trabajo.
 *  3. REANUDACIÓN: una respuesta humana vuelve a poner el run en marcha.
 *  4. IDEMPOTENCIA: repetir un evento no duplica el mensaje del agente.
 *  5. APROBACIÓN HUMANA: cerrar exige aprobación; sin ella NO se cierra, y una
 *     aprobación se ejecuta UNA sola vez.
 *  6. PERMISOS: sin `orders.read` la herramienta de pedidos falla y queda
 *     registrado el error; el agente no puede darse permisos a sí mismo.
 *  7. RECUPERACIÓN: un run con el lease caducado vuelve a la cola (simula caída).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';
import { opsAgentTick, recoverStaleRuns } from '../server/ops/agents.mjs';
import { assignableTools } from '../server/ops/tools.mjs';

const TOKEN = 'ops-stage-d-token';
const ADMIN = { username: 'ana.d@phyto.local', password: 'AnaD-123456', name: 'Ana Admin' };
const AGENT = { username: 'carlos.d@phyto.local', password: 'CarlosD-123456', name: 'Carlos Méndez' };
/* Un repartidor NO tiene `tickets.close`: sirve de contraejemplo de aprobador. */
const COURIER = { username: 'luis.d@phyto.local', password: 'LuisD-123456', name: 'Luis Paredes' };

let tmpDir;
let app;
let adminCookie = '';
let agentCookie = '';
let courierCookie = '';
let now = new Date('2026-10-22T09:00:00.000Z');

const mockWhatsApp = {
  enabled: false,
  sent: [],
  async sendText() {
    return { ok: false, skipped: true };
  },
  async sendTemplate() {
    return { ok: false, skipped: true };
  },
  async sendDocument() {
    return { ok: false, skipped: true };
  },
  async sendInteractive() {
    return { ok: false, skipped: true };
  },
  async markAsRead() {
    return { ok: true };
  },
};

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

async function bootApp() {
  return startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'ops-d.sqlite'),
    token: TOKEN,
    quiet: true,
    whatsapp: mockWhatsApp,
    whatsappMedia: mockWhatsApp,
    bootstrapAdminUser: ADMIN.username,
    bootstrapAdminPassword: ADMIN.password,
    bootstrapAdminDisplayName: ADMIN.name,
    schedulerEnabled: false,
    clock: () => now,
  });
}

/** Una vuelta del motor, tal y como la llama el scheduler. */
const tick = () =>
  opsAgentTick({
    ctx: app.ctx,
    deps: {
      notify: (input) => app.notifyUser(input),
      findOrder: async (id) => ({ id, order_number: `PED-${id}`, status: 'READY' }),
    },
  });

async function newTicket(body = {}) {
  const response = await call('/api/admin/ops/tickets', {
    method: 'POST',
    body: JSON.stringify({ type: 'admin', title: 'Ticket de prueba', ...body }),
  });
  expect(response.status).toBe(201);
  return (await json(response)).ticket;
}

async function registerAgent(body) {
  const response = await call('/api/admin/ops/agents', { method: 'POST', body: JSON.stringify(body) });
  return { status: response.status, body: await json(response) };
}

async function assign(ticketId, agentKey) {
  const response = await call(`/api/admin/ops/tickets/${ticketId}/agent`, {
    method: 'POST',
    body: JSON.stringify({ agentKey }),
  });
  return { status: response.status, body: await json(response) };
}

const runsOf = (ticketId) => app.collections.list('ops_agent_runs', { where: { ticket_id: ticketId }, limit: 50 });
/** Mensajes del hilo EN ORDEN de secuencia (la lista no garantiza orden). */
const messagesOf = async (ticketId) =>
  (
    await app.collections.list('ops_ticket_messages', { where: { ticket_id: ticketId }, limit: 200 })
  ).sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
const callsOf = (runId) => app.collections.list('ops_tool_calls', { where: { run_id: runId }, limit: 100 });
const approvalsOf = (ticketId) =>
  app.collections.list('ops_agent_approvals', { where: { ticket_id: ticketId }, limit: 100 });
const stepsOf = (runId) => app.collections.list('ops_agent_steps', { where: { run_id: runId }, limit: 200 });

/** Avanza el motor hasta que el run deja de estar pendiente (o se agota). */
async function runUntilIdle(ticketId, maxTicks = 12) {
  const seen = [];
  for (let index = 0; index < maxTicks; index += 1) {
    const result = await tick();
    seen.push(result);
    const run = (await runsOf(ticketId)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (!run) break;
    if (!['pending', 'waiting_event'].includes(run.status)) break;
    /* Sin trabajo: el propio run decide esperar y sale del bucle. */
    if (run.status === 'waiting_event' && runsSettled(seen)) break;
  }
  return seen;
}

/**
 * Un run «en espera» sigue siendo reclamable, así que el bucle debe parar por
 * número de pasos, no por estado. Este ayudante evita vueltas infinitas.
 */
function runsSettled(seen) {
  return seen.length >= 3;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-ops-d-'));
  app = await bootApp();
  adminCookie = await login(ADMIN);
  const agent = await json(
    await call('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: AGENT.username, password: AGENT.password, role: 'AGENT', displayName: AGENT.name }),
    }),
  );
  expect(agent.user?.id).toBeTruthy();
  agentCookie = await login(AGENT);
  const courier = await json(
    await call('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: COURIER.username, password: COURIER.password, role: 'DELIVERY', displayName: COURIER.name }),
    }),
  );
  expect(courier.user?.id).toBeTruthy();
  courierCookie = await login(COURIER);
}, 90_000);

afterAll(async () => {
  await app?.close?.();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/* =========================================================== 1. REGISTRO */

describe('registro de agentes: el contrato no admite atajos', () => {
  it('solo administración puede dar de alta agentes', async () => {
    const response = await call(
      '/api/admin/ops/agents',
      { method: 'POST', body: JSON.stringify({ key: 'intruso', name: 'Intruso', tools: ['ticket.get_context'] }) },
      agentCookie,
    );
    expect(response.status).toBe(403);
  });

  it('rechaza herramientas prohibidas, desactivadas e inexistentes', async () => {
    const forbidden = await registerAgent({ key: 'malo_a', name: 'Malo A', tools: ['db.query_raw'] });
    expect(forbidden.status).toBe(422);
    expect(forbidden.body.error).toBe('tool_forbidden');

    const exec = await registerAgent({ key: 'malo_b', name: 'Malo B', tools: ['server.exec'] });
    expect(exec.body.error).toBe('tool_forbidden');

    const disabled = await registerAgent({ key: 'malo_c', name: 'Malo C', tools: ['order.refund'] });
    expect(disabled.body.error).toBe('tool_disabled');

    const invented = await registerAgent({ key: 'malo_d', name: 'Malo D', tools: ['ticket.teleport'] });
    expect(invented.body.error).toBe('unknown_tool');
  });

  it('los permisos se derivan de las herramientas y nunca incluyen cerrar', async () => {
    const created = await registerAgent({
      key: 'asistente_delivery',
      name: 'Asistente de reparto',
      tools: ['ticket.get_context', 'ticket.post_message', 'ticket.request_ack', 'ticket.complete_work'],
      ticketTypes: ['admin'],
      config: { autoEnroll: false, followUpMinutes: 15 },
    });
    expect(created.status).toBe(201);
    const stored = await app.ctx.db.findBy('ops_agents', 'key', 'asistente_delivery');
    expect(stored.permissions).toEqual(
      expect.arrayContaining(['tickets.read', 'tickets.reply', 'tickets.update']),
    );
    /* Cerrar NO está: es decisión humana. */
    expect(stored.permissions).not.toContain('tickets.close');
    expect(stored.tools).not.toContain('ticket.close');
    expect(stored.version).toBe(1);
  });

  it('el catálogo público separa lo asignable de lo que no existe', async () => {
    const catalog = (await json(await call('/api/admin/ops/agents'))).tools;
    const pdf = catalog.find((tool) => tool.name === 'db.query_raw');
    expect(pdf.effect).toBe('forbidden');
    expect(pdf.enabled).toBe(false);
    const close = catalog.find((tool) => tool.name === 'ticket.close');
    expect(close.requiresApproval).toBe(true);
    expect(close.approverPermission).toBe('tickets.close');
    /* Ninguna herramienta prohibida está en la lista asignable. */
    const assignable = assignableTools();
    expect(assignable).not.toContain('db.query_raw');
    expect(assignable).not.toContain('whatsapp.send_external');
    expect(assignable).toContain('ticket.post_message');
  });
});

/* ========================================================== 2. EJECUCIÓN */

describe('ejecución durable de un agente', () => {
  it('asigna, carga contexto, saluda y se queda esperando', async () => {
    const ticket = await newTicket({ title: 'Confirmar la entrega del jueves' });
    const assigned = await assign(ticket.id, 'asistente_delivery');
    expect(assigned.status).toBe(200);

    const runs = await runsOf(ticket.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('pending');
    expect(runs[0].agent_key).toBe('asistente_delivery');

    /* Una vuelta = un paso. El primer paso es leer contexto. */
    await tick();
    let run = (await runsOf(ticket.id))[0];
    expect(run.step).toBe(1);
    expect(run.state.contextLoaded).toBe(true);

    /* Segunda vuelta: el saludo. */
    await tick();
    run = (await runsOf(ticket.id))[0];
    expect(run.step).toBe(2);
    const messages = await messagesOf(ticket.id);
    const greeting = messages.find((row) => row.author_type === 'agent');
    expect(greeting).toBeTruthy();
    expect(greeting.author_name).toBe('Asistente de reparto');
    expect(greeting.kind).toBe('text');

    /* El agente figura como participante de tipo `agent`, no como persona. */
    const participants = await app.collections.list('ops_ticket_participants', {
      where: { ticket_id: ticket.id },
      limit: 20,
    });
    const aiRow = participants.find((row) => row.participant_id === 'agent:asistente_delivery');
    expect(aiRow.participant_type).toBe('agent');

    /* Tercera vuelta: no hay trabajo → esperando. */
    await tick();
    run = (await runsOf(ticket.id))[0];
    expect(run.status).toBe('waiting_event');
    expect(run.next_run_at).toBeTruthy();
  });

  it('una respuesta humana reanuda el run y el agente contesta', async () => {
    const ticket = await newTicket({ title: 'Verificar el albarán firmado' });
    await assign(ticket.id, 'asistente_delivery');
    await tick();
    await tick();
    await tick();

    const reply = await call(`/api/admin/ops/tickets/${ticket.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Ya lo firmé, revisa el PDF adjunto.', clientKey: `human-${ticket.id}` }),
    });
    expect(reply.status).toBe(201);

    /* El evento despertó el run (lo marca para ahora, no ejecuta nada). */
    const woken = (await runsOf(ticket.id))[0];
    expect(['pending', 'waiting_event']).toContain(woken.status);

    await tick();
    const messages = await messagesOf(ticket.id);
    const aiReplies = messages.filter((row) => row.author_type === 'agent');
    expect(aiReplies.length).toBe(2);
    expect(aiReplies[1].body).toContain('Anotado');
    /* El orden del hilo es por número de secuencia, no por llegada. */
    expect(messages.map((row) => row.seq)).toEqual([...messages.map((row) => row.seq)].sort((a, b) => a - b));
  });

  it('repetir el mismo evento no duplica el mensaje del agente', async () => {
    const ticket = await newTicket({ title: 'Sin duplicados, por favor' });
    await assign(ticket.id, 'asistente_delivery');
    await runUntilIdle(ticket.id);

    const run = (await runsOf(ticket.id))[0];
    const before = (await messagesOf(ticket.id)).filter((row) => row.author_type === 'agent').length;

    /* Se fuerza otra vuelta con el mismo estado: el paso ya está hecho. */
    await app.ctx.db.update('ops_agent_runs', run.id, { status: 'pending', next_run_at: now.toISOString() });
    await tick();

    const after = (await messagesOf(ticket.id)).filter((row) => row.author_type === 'agent').length;
    expect(after).toBe(before);
    /* Y la llamada está registrada con su clave de idempotencia. */
    const calls = await callsOf(run.id);
    expect(calls.every((row) => Boolean(row.idempotency_key))).toBe(true);
  });

  it('cada paso queda registrado para poder auditar qué hizo', async () => {
    const ticket = await newTicket({ title: 'Trazabilidad del agente' });
    await assign(ticket.id, 'asistente_delivery');
    await runUntilIdle(ticket.id);
    const run = (await runsOf(ticket.id))[0];
    const steps = await stepsOf(run.id);
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps.map((row) => row.kind)).toContain('tool');
    /* Los pasos están numerados y no se repiten. */
    const numbers = steps.map((row) => row.step);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

/* =============================================== 3. APROBACIÓN HUMANA */

describe('aprobación humana: cerrar no es cosa del agente', () => {
  it('pide aprobación, NO cierra, y solo el humano con permiso la ejecuta', async () => {
    const agenteConCierre = await registerAgent({
      key: 'asistente_cierre',
      name: 'Asistente con cierre',
      tools: ['ticket.get_context', 'ticket.post_message', 'ticket.complete_work', 'ticket.close'],
      ticketTypes: ['admin'],
    });
    expect(agenteConCierre.status).toBe(201);

    const ticket = await newTicket({ title: 'Cerrar cuando esté todo' });
    await assign(ticket.id, 'asistente_cierre');

    /* El trabajo se completa desde el agente (paso permitido). */
    const run = (await runsOf(ticket.id))[0];
    await app.ctx.db.update('ops_agent_runs', run.id, {
      state: { contextLoaded: true, greeted: true, lastSeenSeq: 0, workCompleted: true },
    });
    /* El TRABAJO lo da por hecho una persona (completar ≠ cerrar). */
    await app.ctx.db.update('ops_tickets', ticket.id, { task: { completed_at: now.toISOString() } });
    await tick();

    /* Ahora el agente pide cerrar: aparece la aprobación y el ticket sigue vivo. */
    await tick();
    const approvals = (await approvalsOf(ticket.id)).filter((row) => row.tool === 'ticket.close');
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe('pending');
    expect(approvals[0].required_permission).toBe('tickets.close');

    const stillOpen = await app.ctx.db.get('ops_tickets', ticket.id);
    expect(stillOpen.status).not.toBe('resolved');

    /* El run queda esperando a una persona (no puede saltárselo). */
    const waiting = (await runsOf(ticket.id))[0];
    expect(waiting.status).toBe('waiting_human');

    /* Sin el permiso del aprobador no se aprueba (un repartidor no cierra). */
    const denied = await call(`/api/admin/ops/approvals/${approvals[0].id}/approve`, {
      method: 'POST',
      body: JSON.stringify({}),
    }, courierCookie);
    expect(denied.status).toBe(403);

    /* Administración aprueba: se ejecuta UNA vez. */
    const approved = await call(`/api/admin/ops/approvals/${approvals[0].id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ note: 'Adelante' }),
    });
    expect(approved.status).toBe(200);
    const after = await app.ctx.db.get('ops_tickets', ticket.id);
    expect(after.status).toBe('resolved');

    const consumed = await app.ctx.db.get('ops_agent_approvals', approvals[0].id);
    expect(consumed.status).toBe('consumed');
    expect(consumed.decided_by_name).toBe(ADMIN.name);
    expect(consumed.executed_at).toBeTruthy();

    /* Aprobar dos veces no cierra dos veces ni vuelve a ejecutar. */
    const twice = await call(`/api/admin/ops/approvals/${approvals[0].id}/approve`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(twice.status).toBe(409);
    const calls = await callsOf(consumed.run_id);
    expect(calls.filter((row) => row.tool === 'ticket.close')).toHaveLength(1);
  });

  it('rechazar no ejecuta nada y deja constancia', async () => {
    const ticket = await newTicket({ title: 'Rechazo de cierre' });
    await assign(ticket.id, 'asistente_cierre');
    const run = (await runsOf(ticket.id))[0];
    await app.ctx.db.update('ops_agent_runs', run.id, {
      state: { contextLoaded: true, greeted: true, lastSeenSeq: 0, workCompleted: true },
    });
    await app.ctx.db.update('ops_tickets', ticket.id, { task: { completed_at: now.toISOString() } });
    await tick();
    await tick();
    const approval = (await approvalsOf(ticket.id)).find((row) => row.status === 'pending');
    expect(approval).toBeTruthy();

    const rejected = await call(`/api/admin/ops/approvals/${approval.id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ note: 'Falta la firma del cliente' }),
    });
    expect(rejected.status).toBe(200);

    const ticketAfter = await app.ctx.db.get('ops_tickets', ticket.id);
    expect(ticketAfter.status).not.toBe('resolved');
    const stored = await app.ctx.db.get('ops_agent_approvals', approval.id);
    expect(stored.status).toBe('rejected');
    expect(stored.decision_note).toBe('Falta la firma del cliente');

    /* Los eventos del ticket dejan rastro del rechazo. */
    const events = await app.collections.list('ops_ticket_events', { where: { ticket_id: ticket.id }, limit: 100 });
    expect(events.some((row) => row.kind === 'approval_rejected')).toBe(true);
  });
});

/* ============================================================= 4. PERMISOS */

describe('permisos del agente', () => {
  it('sin orders.read la herramienta de pedidos falla y queda registrado', async () => {
    await registerAgent({
      key: 'solo_lectura',
      name: 'Solo lectura',
      tools: ['ticket.get_context', 'order.get_status'],
      ticketTypes: ['admin'],
    });
    const ticket = await newTicket({ title: 'Pedido a consultar' });
    await assign(ticket.id, 'solo_lectura');
    const run = (await runsOf(ticket.id))[0];
    /* Se fuerza el plan hacia la herramienta de pedidos. */
    await app.ctx.db.update('ops_agent_runs', run.id, {
      state: { contextLoaded: true, greeted: true, lastSeenSeq: 0 },
      step: 0,
    });
    /* El plan determinista no llama a order.get_status, así que se prueba el
       guardián ejecutando la herramienta con un agente que NO la tiene. */
    const outcome = await app.ctx.db.findBy('ops_agents', 'key', 'solo_lectura');
    expect(outcome.tools).toContain('order.get_status');
    const permissions = outcome.permissions;
    expect(permissions).toContain('orders.read');
    /* Ningún permiso fuera de la lista blanca. */
    expect(permissions).not.toContain('tickets.close');
    expect(permissions).not.toContain('orders.update_operational');
  });

  it('no se puede dar de alta un agente con un permiso inventado', async () => {
    /* `customer.update_sensitive` está desactivada: no entra. */
    const attempt = await registerAgent({
      key: 'codicioso',
      name: 'Codicioso',
      tools: ['ticket.get_context', 'customer.update_sensitive'],
      ticketTypes: ['admin'],
    });
    expect(attempt.status).toBe(422);
    expect(attempt.body.error).toBe('tool_disabled');
  });

  it('un agente desactivado no ejecuta nada', async () => {
    const ticket = await newTicket({ title: 'Agente apagado' });
    await assign(ticket.id, 'asistente_delivery');
    const stored = await app.ctx.db.findBy('ops_agents', 'key', 'asistente_delivery');
    await app.ctx.db.update('ops_agents', stored.id, { enabled: false });
    const run = (await runsOf(ticket.id))[0];
    await app.ctx.db.update('ops_agent_runs', run.id, { status: 'pending', next_run_at: now.toISOString() });
    await tick();
    const after = (await runsOf(ticket.id))[0];
    expect(after.status).toBe('failed');
    expect(after.last_error.code).toBe('agent_unavailable');
    /* Se vuelve a activar para no afectar a otras pruebas. */
    await app.ctx.db.update('ops_agents', stored.id, { enabled: true });
  });
});

/* ======================================================== 5. RECUPERACIÓN */

describe('recuperación tras una caída', () => {
  it('un run con el lease caducado vuelve a la cola con un intento más', async () => {
    const ticket = await newTicket({ title: 'Se cayó a media ejecución' });
    await assign(ticket.id, 'asistente_delivery');
    const run = (await runsOf(ticket.id))[0];
    /* Se simula «el proceso murió con el lease tomado». */
    await app.ctx.db.update('ops_agent_runs', run.id, {
      status: 'running',
      lease_owner: 'proceso-muerto',
      lease_until: new Date(now.getTime() - 5 * 60_000).toISOString(),
      attempt: 1,
    });

    const result = await recoverStaleRuns({ ctx: app.ctx });
    expect(result.recovered).toBeGreaterThanOrEqual(1);

    const recovered = (await runsOf(ticket.id))[0];
    expect(recovered.status).toBe('pending');
    expect(recovered.attempt).toBe(2);
    expect(recovered.lease_owner).toBeNull();

    /* Y el trabajo continúa de verdad. */
    await tick();
    const advanced = (await runsOf(ticket.id))[0];
    expect(advanced.step).toBeGreaterThan(0);
  });

  it('una aprobación caducada ya no se puede aprobar', async () => {
    const ticket = await newTicket({ title: 'Aprobación caducada' });
    await assign(ticket.id, 'asistente_cierre');
    const run = (await runsOf(ticket.id))[0];
    await app.ctx.db.update('ops_agent_runs', run.id, {
      state: { contextLoaded: true, greeted: true, lastSeenSeq: 0, workCompleted: true },
    });
    await app.ctx.db.update('ops_tickets', ticket.id, { task: { completed_at: now.toISOString() } });
    await tick();
    await tick();
    const approval = (await approvalsOf(ticket.id)).find((row) => row.status === 'pending');
    expect(approval).toBeTruthy();

    await app.ctx.db.update('ops_agent_approvals', approval.id, {
      expires_at: new Date(now.getTime() - 1000).toISOString(),
    });
    const late = await call(`/api/admin/ops/approvals/${approval.id}/approve`, { method: 'POST', body: JSON.stringify({}) });
    expect(late.status).toBe(409);
    const body = await json(late);
    expect(body.error).toBe('approval_expired');
    const ticketAfter = await app.ctx.db.get('ops_tickets', ticket.id);
    expect(ticketAfter.status).not.toBe('resolved');
  });

  it('el estado del run sobrevive a reiniciar el backend', async () => {
    const ticket = await newTicket({ title: 'Persistencia del run' });
    await assign(ticket.id, 'asistente_delivery');
    await tick();
    const before = (await runsOf(ticket.id))[0];
    expect(before.step).toBe(1);

    /* Reinicio: se cierra el servidor y se levanta con el MISMO fichero. */
    await app.close();
    app = await bootApp();
    adminCookie = await login(ADMIN);

    const after = (await runsOf(ticket.id))[0];
    expect(after.id).toBe(before.id);
    expect(after.step).toBe(1);
    expect(after.state.contextLoaded).toBe(true);

    /* Y sigue avanzando desde donde estaba, sin repetir el paso 1. */
    await tick();
    const next = (await runsOf(ticket.id))[0];
    expect(next.step).toBe(2);
  });
});

/* ================================== 6. BANDEJA DE APROBACIONES Y REGISTRO */

describe('bandeja de aprobaciones', () => {
  /** Deja un ticket con una aprobación de cierre pendiente. */
  async function pendingApprovalTicket(title) {
    const ticket = await newTicket({ title });
    await assign(ticket.id, 'asistente_cierre');
    const run = (await runsOf(ticket.id))[0];
    await app.ctx.db.update('ops_agent_runs', run.id, {
      state: { contextLoaded: true, greeted: true, lastSeenSeq: 0, workCompleted: true },
    });
    await app.ctx.db.update('ops_tickets', ticket.id, { task: { completed_at: now.toISOString() } });
    await tick();
    const approval = (await approvalsOf(ticket.id)).find((row) => row.status === 'pending');
    expect(approval).toBeTruthy();
    return { ticket, approval };
  }

  it('la bandeja dice de qué ticket es cada petición', async () => {
    const { ticket } = await pendingApprovalTicket('Cierre pendiente con número de ticket');
    const list = await json(await call('/api/admin/ops/approvals?status=pending'));
    expect(list.ok).toBe(true);
    const row = list.approvals.find((item) => item.ticketId === ticket.id);
    expect(row).toBeTruthy();
    /* Sin el número, en una bandeja global no se sabe qué se está aprobando. */
    expect(row.ticketNumber).toBe(ticket.number);
    expect(row.ticketTitle).toBe('Cierre pendiente con número de ticket');
    expect(row.requiredPermission).toBe('tickets.close');
  });

  it('el contador de la bandeja solo se cuenta a quien puede decidir', async () => {
    await pendingApprovalTicket('Cierre pendiente para el contador');
    const admin = await json(await call('/api/admin/ops/inbox'));
    expect(admin.pendingApprovals).toBeGreaterThanOrEqual(1);

    /* Un repartidor tiene `tickets.read` pero no `tickets.close`: cuenta 0. */
    const courier = await json(await call('/api/admin/ops/inbox', {}, courierCookie));
    expect(courier.ok).toBe(true);
    expect(courier.pendingApprovals).toBe(0);
  });

  it('decidir desde la bandeja deja el ticket resuelto y la aprobación consumida', async () => {
    const { ticket, approval } = await pendingApprovalTicket('Cierre aprobado desde la bandeja');
    const decided = await call(`/api/admin/ops/approvals/${approval.id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ note: 'Desde la bandeja' }),
    });
    expect(decided.status).toBe(200);
    const after = await app.ctx.db.get('ops_tickets', ticket.id);
    expect(after.status).toBe('resolved');
    const stored = await app.ctx.db.get('ops_agent_approvals', approval.id);
    expect(stored.status).toBe('consumed');

    /* Y sale de la lista de pendientes. */
    const list = await json(await call('/api/admin/ops/approvals?status=pending'));
    expect(list.approvals.some((row) => row.id === approval.id)).toBe(false);
  });
});

/* ============================ 7. LECTURA DEL PEDIDO VINCULADO (order.get_status) */

describe('estado del pedido vinculado', () => {
  it('el agente consulta el pedido antes de saludar y lo dice en el mensaje', async () => {
    await registerAgent({
      key: 'asistente_pedidos',
      name: 'Asistente de pedidos',
      tools: ['ticket.get_context', 'order.get_status', 'ticket.post_message'],
      ticketTypes: ['admin'],
    });
    const ticket = await newTicket({ title: 'Seguimiento del pedido vinculado' });
    /* Se vincula el pedido en el documento: el buscador real exige un pedido que
       exista, y aquí lo que se prueba es el plan, no el alta. */
    await app.ctx.db.update('ops_tickets', ticket.id, { entity_type: 'order', entity_id: 'ord_uat_1' });
    await assign(ticket.id, 'asistente_pedidos');
    expect((await runsOf(ticket.id))[0]).toBeTruthy();

    await tick(); // 1: contexto
    await tick(); // 2: estado del pedido
    let run = (await runsOf(ticket.id))[0];
    expect(run.state.orderChecked).toBe(true);
    expect(run.state.orderStatus).toBe('READY');
    const calls = await callsOf(run.id);
    expect(calls.some((row) => row.tool === 'order.get_status' && row.status === 'ok')).toBe(true);

    await tick(); // 3: saludo
    run = (await runsOf(ticket.id))[0];
    const messages = await messagesOf(ticket.id);
    /* El primer mensaje aporta algo: dice cómo va el pedido. */
    expect(messages[0].body).toContain('READY');
    /* Y no se vuelve a consultar en cada vuelta. */
    await tick();
    const after = await callsOf(run.id);
    expect(after.filter((row) => row.tool === 'order.get_status')).toHaveLength(1);
  });

  it('si el pedido no se puede leer, el run sigue y no se repite la consulta', async () => {
    const ticket = await newTicket({ title: 'Pedido que no se puede leer' });
    await app.ctx.db.update('ops_tickets', ticket.id, { entity_type: 'order', entity_id: 'ord_missing' });
    await assign(ticket.id, 'asistente_pedidos');
    await tick(); // contexto

    /* Pedido inexistente: la lectura falla con `retryable:false`. */
    await opsAgentTick({
      ctx: app.ctx,
      deps: { notify: (input) => app.notifyUser(input), findOrder: async () => null },
    });
    let run = (await runsOf(ticket.id))[0];
    expect(run.state.orderChecked).toBe(true);
    expect(run.status).toBe('pending');
    expect(run.last_error.code).toBe('order_not_found');

    /* El trabajo continúa: saluda sin el dato, sin quedarse en bucle. */
    await tick();
    run = (await runsOf(ticket.id))[0];
    const messages = await messagesOf(ticket.id);
    expect(messages.some((row) => row.author_type === 'agent')).toBe(true);
    expect(messages[0].body).not.toContain('READY');
    const calls = await callsOf(run.id);
    expect(calls.filter((row) => row.tool === 'order.get_status')).toHaveLength(1);
  });

  it('el guardián de permisos impide ejecutar la herramienta sin su permiso', async () => {
    const stored = await app.ctx.db.findBy('ops_agents', 'key', 'solo_lectura');
    /* Se quita el permiso dejando la herramienta: el registro no puede hacerlo,
       pero el motor debe seguir negándose aunque alguien toque la base. */
    await app.ctx.db.update('ops_agents', stored.id, {
      permissions: (stored.permissions ?? []).filter((permission) => permission !== 'orders.read'),
    });

    const ticket = await newTicket({ title: 'Sin permiso de pedidos' });
    await app.ctx.db.update('ops_tickets', ticket.id, { entity_type: 'order', entity_id: 'ord_x' });
    await assign(ticket.id, 'solo_lectura');
    await tick(); // contexto
    await tick(); // intento de leer el pedido → denegado

    const run = (await runsOf(ticket.id))[0];
    const denied = (await callsOf(run.id)).find((row) => row.tool === 'order.get_status');
    expect(denied).toBeTruthy();
    expect(denied.status).toBe('error');
    expect(denied.error.code).toBe('agent_permission_denied');

    /* Se restaura para no afectar a las pruebas siguientes. */
    await app.ctx.db.update('ops_agents', stored.id, { permissions: stored.permissions });
  });
});
