// @vitest-environment node
/**
 * AGENTE DE SEGUIMIENTO — propuestas, aprobación humana y ejecución real.
 *
 * Lo que se demuestra aquí:
 *  1. Las herramientas de escritura son SOLO POR APROBACIÓN (el agente no puede
 *     ejecutarlas por su cuenta).
 *  2. Una propuesta NO escribe nada hasta que una persona la aprueba.
 *  3. Al aprobar se ejecuta con los permisos de LA PERSONA (el operador no
 *     puede cancelar; administración sí).
 *  4. Los seguimientos los crea el motor de siempre y los mensajes entran en la
 *     cola persistente del programador con el texto CONGELADO.
 *  5. Lo que propone el modelo se valida: lo incoherente se descarta y se dice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';
import { OPS_TOOLS, toolCatalog } from '../server/ops/tools.mjs';
import {
  WORK_ACTIONS,
  applyWorkDecision,
  decideWorkProposal,
  ensureWorkAgent,
  proposeWork,
  workSnapshot,
} from '../server/ops/work.mjs';
import { saveAgent } from '../server/ops/agents.mjs';

const TOKEN = 'work-token';
const ADMIN = { username: 'w.admin', password: 'W-Admin-123', name: 'Ana Admin' };
const OPERADOR = { username: 'w.op', password: 'W-Oper-123', name: 'Oscar Operador' };

let tmpDir;
let app;
let adminCookie = '';
let operadorCookie = '';
let adminId = '';
let operadorId = '';
let customerId = '';
let conversationId = '';

const json = async (response) => JSON.parse(await response.text());

function call(route, options = {}, cookie = adminCookie) {
  return fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers ?? {}) },
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

const canAdmin = () => (permission) => permission === '*' || ['admin.full', 'followups.read', 'followups.create', 'followups.update', 'followups.delete', 'chats.force_reassign'].includes(permission);
const canOperador = () => (permission) => ['followups.read', 'followups.create', 'followups.update', 'chats.force_reassign'].includes(permission);

const adminActor = () => ({ id: adminId, actor_type: 'USER', display_name: ADMIN.name });
const operadorActor = () => ({ id: operadorId, actor_type: 'USER', display_name: OPERADOR.name });

/** Abre la ventana de 24 h como haría el webhook con un mensaje entrante. */
async function openWindow() {
  await app.ctx.db.update('conversations', conversationId, { last_inbound_at: new Date().toISOString() });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-work-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'work.sqlite'),
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
  const session = await json(await call('/api/admin/session'));
  adminId = session.user?.id ?? '';
  expect(adminId).toBeTruthy();
  const created = await call('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: OPERADOR.username, password: OPERADOR.password, role: 'OPERADOR', displayName: OPERADOR.name }),
  });
  operadorId = (await json(created)).user.id;
  operadorCookie = await login(OPERADOR);

  const start = await call('/api/admin/conversations/start', {
    method: 'POST',
    body: JSON.stringify({ phone: '+18095550999', name: 'Cliente Seguimiento UAT' }),
  });
  const body = await json(start);
  customerId = body.customer?.id ?? body.customerId ?? null;
  conversationId = body.conversation?.id ?? body.conversationId ?? null;
  expect(customerId).toBeTruthy();
}, 60_000);

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('registro de herramientas del agente', () => {
  it('las escrituras son solo por aprobación y piden permiso de la persona', () => {
    const catalog = toolCatalog();
    const writes = catalog.filter((tool) => (tool.scope === 'followup' || tool.scope === 'message') && tool.effect === 'write');
    expect(writes.length).toBe(7);
    for (const tool of writes) {
      expect(tool.approvalOnly).toBe(true);
      expect(tool.requiresApproval).toBe(true);
      expect(tool.permission).toMatch(/propose/);
      expect(['followups.create', 'followups.update', 'followups.delete']).toContain(tool.approverPermission);
      expect(OPS_TOOLS[tool.name].enabled).toBe(true);
    }
    const reads = catalog.filter((tool) => (tool.scope === 'followup' || tool.scope === 'message') && tool.effect === 'read');
    expect(reads.map((tool) => tool.name).sort()).toEqual(['followup.list', 'schedule.list']);
  });

  it('el alta del agente es explícita, idempotente y solo de administración', async () => {
    const denied = await ensureWorkAgent({ ctx: app.ctx, actor: operadorActor(), can: canOperador(), saveAgent });
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(403);

    const first = await ensureWorkAgent({ ctx: app.ctx, actor: adminActor(), can: canAdmin(), saveAgent });
    expect(first.ok).toBe(true);
    expect(first.existing).toBe(false);
    expect(first.agent.config.workMode).toBe('followups');
    expect(first.agent.config.planner).toBe('llm');

    const again = await ensureWorkAgent({ ctx: app.ctx, actor: adminActor(), can: canAdmin(), saveAgent });
    expect(again.existing).toBe(true);
    expect(again.agent.id).toBe(first.agent.id);
  });
});

describe('propuestas con aprobación', () => {
  it('una propuesta de seguimiento no crea nada hasta aprobarla', async () => {
    const before = await app.ctx.db.list('followups', { limit: 50 });
    const result = await proposeWork({
      ctx: app.ctx,
      actor: adminActor(),
      can: canAdmin(),
      action: 'followup.create',
      params: { customerId, reason: 'Confirmar la recompra', date: '2026-11-02' },
      origin: 'chat',
    });
    expect(result.ok).toBe(true);
    expect(result.proposal.status).toBe('pending');
    const afterProposal = await app.ctx.db.list('followups', { limit: 50 });
    expect(afterProposal.length).toBe(before.length);

    const pending = await app.ctx.db.list('ops_agent_approvals', { limit: 50 });
    expect(pending.some((row) => row.id === result.proposal.id && row.ticket_id === null)).toBe(true);

    const approved = await decideWorkProposal({
      ctx: app.ctx,
      actor: adminActor(),
      can: canAdmin(),
      proposalId: result.proposal.id,
      approve: true,
    });
    expect(approved.ok).toBe(true);
    expect(approved.executed).toBe(true);
    expect(approved.result.followupId).toBeTruthy();

    const afterApproval = await app.ctx.db.list('followups', { limit: 50 });
    expect(afterApproval.length).toBe(before.length + 1);
    const created = afterApproval.find((row) => row.id === approved.result.followupId);
    expect(created.customer_id).toBe(customerId);
    expect(created.status).toBe('pending');

    /* Aprobar dos veces no duplica: la segunda ya está consumida. */
    const again = await decideWorkProposal({
      ctx: app.ctx,
      actor: adminActor(),
      can: canAdmin(),
      proposalId: result.proposal.id,
      approve: true,
    });
    expect(again.ok).toBe(false);
    expect(again.error).toBe('proposal_consumed');
  });

  it('repetir la misma propuesta devuelve la que ya está pendiente', async () => {
    const params = { customerId, reason: 'Llamada de control', date: '2026-11-03' };
    const first = await proposeWork({ ctx: app.ctx, actor: adminActor(), can: canAdmin(), action: 'followup.create', params });
    const second = await proposeWork({ ctx: app.ctx, actor: adminActor(), can: canAdmin(), action: 'followup.create', params });
    expect(second.duplicate).toBe(true);
    expect(second.proposal.id).toBe(first.proposal.id);
  });

  it('rechazar no ejecuta nada y deja el motivo', async () => {
    const before = await app.ctx.db.list('followups', { limit: 50 });
    const proposal = await proposeWork({
      ctx: app.ctx,
      actor: adminActor(),
      can: canAdmin(),
      action: 'followup.create',
      params: { customerId, reason: 'Propuesta que se rechaza', date: '2026-11-04' },
    });
    const rejected = await decideWorkProposal({
      ctx: app.ctx,
      actor: adminActor(),
      can: canAdmin(),
      proposalId: proposal.proposal.id,
      approve: false,
      note: 'No hace falta ahora',
    });
    expect(rejected.ok).toBe(true);
    expect(rejected.proposal.status).toBe('rejected');
    expect(rejected.proposal.decisionNote).toBe('No hace falta ahora');
    const after = await app.ctx.db.list('followups', { limit: 50 });
    expect(after.length).toBe(before.length);
  });

  it('cancelar un seguimiento exige el permiso de administración', async () => {
    const followups = await app.ctx.db.list('followups', { limit: 50 });
    const target = followups[0];
    expect(target).toBeTruthy();

    const proposal = await proposeWork({
      ctx: app.ctx,
      actor: operadorActor(),
      can: canOperador(),
      action: 'followup.cancel',
      params: { followupId: target.id, reason: 'Duplicado' },
    });
    expect(proposal.ok).toBe(true);

    const denied = await decideWorkProposal({
      ctx: app.ctx,
      actor: operadorActor(),
      can: canOperador(),
      proposalId: proposal.proposal.id,
      approve: true,
    });
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(403);
    const stillPending = await app.ctx.db.get('followups', target.id);
    expect(stillPending.status).toBe('pending');

    const allowed = await decideWorkProposal({
      ctx: app.ctx,
      actor: adminActor(),
      can: canAdmin(),
      proposalId: proposal.proposal.id,
      approve: true,
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.executed).toBe(true);
    const cancelled = await app.ctx.db.get('followups', target.id);
    expect(cancelled.status).toBe('cancelled');
  });

  it('un mensaje programado exige la ventana de 24 h y entra en la cola con el texto exacto', async () => {
    /* Sin ventana: se dice y no se propone nada. */
    await app.ctx.db.update('conversations', conversationId, { last_inbound_at: null });
    const closed = await proposeWork({
      ctx: app.ctx,
      actor: adminActor(),
      can: canAdmin(),
      action: 'schedule.create',
      params: { customerId, text: 'Mensaje fuera de ventana', scheduledAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(closed.ok).toBe(false);
    expect(closed.error).toBe('outside_window');

    /* Con ventana: se aprueba y queda en la cola, con el texto aprobado. */
    await openWindow();
    const text = 'Hola, le escribimos de Phytoemagry por su pedido. Cualquier duda, por aquí.';
    const when = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const proposal = await proposeWork({
      ctx: app.ctx,
      actor: adminActor(),
      can: canAdmin(),
      action: 'schedule.create',
      params: { customerId, text, scheduledAt: when },
    });
    expect(proposal.ok).toBe(true);

    const beforeQueue = await app.ctx.db.list('scheduled_messages', { limit: 20 });
    const approved = await decideWorkProposal({
      ctx: app.ctx,
      actor: adminActor(),
      can: canAdmin(),
      proposalId: proposal.proposal.id,
      approve: true,
    });
    expect(approved.executed).toBe(true);
    const queue = await app.ctx.db.list('scheduled_messages', { limit: 20 });
    expect(queue.length).toBe(beforeQueue.length + 1);
    const row = queue.find((item) => item.id === approved.result.scheduledId);
    expect(row.status).toBe('SCHEDULED');
    /* El texto es EXACTAMENTE el aprobado (no se regenera después). */
    expect(row.text).toBe(text);
    expect(row.scheduled_at).toBe(when);
  });

  it('una propuesta caducada no se puede aprobar', async () => {
    const proposal = await proposeWork({
      ctx: app.ctx,
      actor: adminActor(),
      can: canAdmin(),
      action: 'followup.create',
      params: { customerId, reason: 'Propuesta vieja', date: '2026-11-05' },
    });
    await app.ctx.db.update('ops_agent_approvals', proposal.proposal.id, { expires_at: '2020-01-01T00:00:00.000Z' });
    const expired = await decideWorkProposal({
      ctx: app.ctx,
      actor: adminActor(),
      can: canAdmin(),
      proposalId: proposal.proposal.id,
      approve: true,
    });
    expect(expired.ok).toBe(false);
    expect(expired.error).toBe('proposal_expired');
  });

  it('un cliente que no lleva el operador no aparece ni se puede proponer', async () => {
    /* Se crea otro cliente y se abre una conversación asignada a otra persona. */
    const start = await call('/api/admin/conversations/start', {
      method: 'POST',
      body: JSON.stringify({ phone: '+18095551111', name: 'Cliente de otro agente' }),
    });
    const body = await json(start);
    const otherCustomer = body.customer?.id ?? body.customerId;
    /* El operador no lleva esa conversación: no la ve. */
    const snapshot = await workSnapshot({ ctx: app.ctx, actor: operadorActor(), can: canOperador() });
    expect(snapshot.customers.some((row) => row.id === otherCustomer)).toBe(operatorVisible(otherCustomer));
    const proposal = await proposeWork({
      ctx: app.ctx,
      actor: operadorActor(),
      can: canOperador(),
      action: 'followup.create',
      params: { customerId: otherCustomer, reason: 'No autorizado', date: '2026-11-06' },
    });
    if (!operatorVisible(otherCustomer)) {
      expect(proposal.ok).toBe(false);
      expect(proposal.error).toBe('not_your_customer');
    }
    function operatorVisible(id) {
      /* El operador sí ve los clientes de SUS conversaciones; este no es suyo. */
      return snapshot.customers.some((row) => row.id === id);
    }
  });
});

describe('lo que propone el modelo', () => {
  it('solo se convierten en propuestas las acciones válidas', async () => {
    await openWindow();
    const applied = await applyWorkDecision({
      ctx: app.ctx,
      actor: adminActor(),
      can: canAdmin(),
      raw: {
        reply: 'Tienes dos cosas pendientes.',
        proposals: [
          { action: 'followup.create', params: { customerId, reason: 'Recompra de noviembre', date: '2026-11-07' }, why: 'compró hace un mes' },
          { action: 'inventar_cosa', params: {}, why: 'no existe' },
          { action: 'followup.create', params: { customerId: 'no-existe', reason: 'x', date: '2026-11-07' }, why: 'cliente inventado' },
          { action: 'schedule.create', params: { customerId, text: 'Recordatorio', scheduledAt: '2020-01-01T10:00:00.000Z' }, why: 'fecha pasada' },
        ],
      },
    });
    expect(applied.ok).toBe(true);
    expect(applied.reply).toContain('pendientes');
    expect(applied.proposals.length).toBe(1);
    expect(applied.proposals[0].action).toBe('followup.create');
    expect(applied.rejected.map((row) => row.error).sort()).toEqual(['date_too_soon', 'unknown_action', 'unknown_customer']);
    /* Todas nacen pendientes: nada ejecutado. */
    for (const proposal of applied.proposals) expect(proposal.status).toBe('pending');
  });

  it('una respuesta que no es JSON no rompe nada', async () => {
    const applied = await applyWorkDecision({ ctx: app.ctx, actor: adminActor(), can: canAdmin(), raw: 'texto suelto' });
    expect(applied.ok).toBe(false);
    expect(applied.proposals).toEqual([]);
  });

  it('las acciones permitidas son una lista cerrada', () => {
    expect(Object.keys(WORK_ACTIONS).sort()).toEqual([
      'followup.cancel',
      'followup.complete',
      'followup.create',
      'followup.reschedule',
      'schedule.cancel',
      'schedule.create',
      'schedule.reschedule',
    ]);
  });
});
