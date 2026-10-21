// @vitest-environment node
/**
 * CENTRO DE OPERACIONES — ETAPA C (avisos, acuses y seguimiento de la tarea).
 *
 * Contra el CRM REAL (SQLite temporal, WhatsApp simulado) comprueba:
 *  - un aviso por persona y suceso (asignación, mensaje, mención, plazo, escalado);
 *  - que un mensaje NO avisa a quien lo escribe y que un reintento no duplica;
 *  - que leer, acusar y completar son TRES estados distintos y persistentes;
 *  - que el contador de no leídos lo mantiene el servidor y cuadra;
 *  - permisos de participantes y accesos no autorizados;
 *  - la pasada de plazos (scheduler) sin navegador y sin repetir aviso;
 *  - paginación del hilo y supervivencia a un reinicio del backend.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';
import { opsDeadlineTick } from '../server/ops/notify.mjs';

const TOKEN = 'ops-stage-c-token';
const APP_SECRET = 'ops-stage-c-secret';
const ADMIN = { username: 'ana.c@phyto.local', password: 'AnaC-123456', name: 'Ana Admin' };
const AGENT = { username: 'carlos.c@phyto.local', password: 'CarlosC-123456', name: 'Carlos Méndez' };
const COURIER = { username: 'luis.c@phyto.local', password: 'LuisC-123456', name: 'Luis Paredes' };

let tmpDir;
let app;
let adminCookie = '';
let agentCookie = '';
let courierCookie = '';
let adminId = '';
let agentId = '';
let courierId = '';
let now = new Date('2026-10-21T16:00:00.000Z');

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-C',
  businessAccountId: 'WABA-C',
  sent: [],
  async sendText(to, body, options) {
    mockWhatsApp.sent.push({ to, body, options, type: 'text' });
    return { ok: true, status: 200, messageId: `wamid.C_TXT_${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    mockWhatsApp.sent.push({ to, template, type: 'template' });
    return { ok: true, status: 200, messageId: `wamid.C_TPL_${mockWhatsApp.sent.length}` };
  },
  async sendDocument(to, input) {
    mockWhatsApp.sent.push({ to, ...input, type: 'document' });
    return { ok: true, status: 200, waMessageId: `wamid.C_DOC_${mockWhatsApp.sent.length}` };
  },
  async sendInteractive() {
    return { ok: false, skipped: true };
  },
  async markAsRead() {
    return { ok: true };
  },
};

const storage = {
  enabled: true,
  provider: 'memory',
  objects: new Map(),
  async put(key, buffer) {
    storage.objects.set(key, Buffer.from(buffer));
    return { ok: true, objectKey: key, size: buffer.length };
  },
  async get(key) {
    const found = storage.objects.get(key);
    return found ? { ok: true, buffer: found } : { ok: false, error: 'not_found' };
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
    dataFile: path.join(tmpDir, 'ops-c.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsappPhoneNumber: '+18095550000',
    whatsapp: mockWhatsApp,
    whatsappMedia: mockWhatsApp,
    storage,
    bootstrapAdminUser: ADMIN.username,
    bootstrapAdminPassword: ADMIN.password,
    bootstrapAdminDisplayName: ADMIN.name,
    schedulerEnabled: false,
    clock: () => now,
  });
}

const notificationsOf = async (userId, type = null) =>
  (await app.collections.list('user_notifications', { where: { recipient_user_id: userId }, limit: 500 })).filter(
    (row) => !type || row.type === type,
  );

async function newTicket(body = {}) {
  const response = await call('/api/admin/ops/tickets', {
    method: 'POST',
    body: JSON.stringify({ type: 'admin', title: 'Ticket de prueba', ...body }),
  });
  expect(response.status).toBe(201);
  return (await json(response)).ticket;
}

async function say(ticketId, body, key, cookie = adminCookie) {
  const response = await call(
    `/api/admin/ops/tickets/${ticketId}/messages`,
    { method: 'POST', body: JSON.stringify({ body, clientKey: key }) },
    cookie,
  );
  return { status: response.status, body: await json(response) };
}

const detail = async (ticketId, cookie = adminCookie) => json(await call(`/api/admin/ops/tickets/${ticketId}`, {}, cookie));

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-ops-c-'));
  app = await bootApp();
  adminCookie = await login(ADMIN);
  adminId = (await json(await call('/api/admin/session'))).user.id;
  const agent = await json(
    await call('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: AGENT.username, password: AGENT.password, role: 'AGENT', displayName: AGENT.name }),
    }),
  );
  agentId = agent.user.id;
  const courier = await json(
    await call('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: COURIER.username, password: COURIER.password, role: 'DELIVERY', displayName: COURIER.name }),
    }),
  );
  courierId = courier.user.id;
  agentCookie = await login(AGENT);
  courierCookie = await login(COURIER);
}, 90_000);

afterAll(async () => {
  await app?.close?.();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('avisos internos', () => {
  it('la asignación avisa al asignado UNA vez', async () => {
    const ticket = await newTicket({ title: 'Revisar la nevera del local', assignedUserId: agentId });
    let rows = await notificationsOf(agentId, 'OPS_TICKET_ASSIGNED');
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_type).toBe('ticket');
    expect(rows[0].entity_id).toBe(ticket.id);
    expect(rows[0].deep_link).toContain(`ticket=${ticket.id}`);

    /* Reasignar a la MISMA persona no vuelve a avisar. */
    await call(`/api/admin/ops/tickets/${ticket.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ assignedUserId: agentId }),
    });
    rows = await notificationsOf(agentId, 'OPS_TICKET_ASSIGNED');
    expect(rows).toHaveLength(1);
  });

  it('un mensaje avisa a los demás participantes y nunca al autor', async () => {
    const ticket = await newTicket({ title: 'Aviso de mensaje', assignedUserId: agentId });
    const before = {
      agent: (await notificationsOf(agentId, 'OPS_TICKET_MESSAGE')).length,
      admin: (await notificationsOf(adminId, 'OPS_TICKET_MESSAGE')).length,
    };

    const sent = await say(ticket.id, 'Revisen la factura, falta el sello.', `msg-${ticket.id}`);
    expect(sent.status).toBe(201);

    const agentNotes = await notificationsOf(agentId, 'OPS_TICKET_MESSAGE');
    expect(agentNotes.length).toBe(before.agent + 1);
    expect(agentNotes.at(-1).body).toContain('falta el sello');
    expect(agentNotes.at(-1).data.ticket_id).toBe(ticket.id);

    /* El autor (administración) no recibe aviso de su propio mensaje. */
    expect((await notificationsOf(adminId, 'OPS_TICKET_MESSAGE')).length).toBe(before.admin);
  });

  it('mencionar con @ avisa distinto y sin acentos', async () => {
    const ticket = await newTicket({ title: 'Mención en el hilo', assignedUserId: agentId });
    const before = (await notificationsOf(agentId, 'OPS_TICKET_MENTION')).length;

    /* El nombre real es «Carlos Méndez»: se menciona sin tilde y en minúsculas. */
    const sent = await say(ticket.id, '@carlos mendez mira esto, por favor', `mention-${ticket.id}`);
    expect(sent.status).toBe(201);

    const notes = await notificationsOf(agentId, 'OPS_TICKET_MENTION');
    expect(notes.length).toBe(before + 1);
    expect(notes.at(-1).title).toContain('te mencionaron');
    expect(notes.at(-1).data.mentioned).toBe(true);
  });

  it('el doble envío del mismo mensaje no duplica ni mensaje ni aviso', async () => {
    const ticket = await newTicket({ title: 'Idempotencia del aviso', assignedUserId: agentId });
    const before = (await notificationsOf(agentId, 'OPS_TICKET_MESSAGE')).length;

    const first = await say(ticket.id, 'Solo una vez', `dup-${ticket.id}`);
    const second = await say(ticket.id, 'Solo una vez', `dup-${ticket.id}`);
    expect(first.status).toBe(201);
    expect(second.body.duplicate).toBe(true);

    const rows = await app.collections.list('ops_ticket_messages', { where: { ticket_id: ticket.id }, limit: 50 });
    expect(rows).toHaveLength(1);
    expect((await notificationsOf(agentId, 'OPS_TICKET_MESSAGE')).length).toBe(before + 1);
  });

  it('leer el ticket marca sus avisos como leídos y pone el contador a cero', async () => {
    const ticket = await newTicket({ title: 'Leer apaga la campana', assignedUserId: agentId });
    await say(ticket.id, 'Primero', `read1-${ticket.id}`);
    await say(ticket.id, 'Segundo', `read2-${ticket.id}`);

    let view = await detail(ticket.id, agentCookie);
    expect(view.ticket.unreadCount).toBe(2);

    await call(`/api/admin/ops/tickets/${ticket.id}/read`, { method: 'POST', body: JSON.stringify({ seq: 2 }) }, agentCookie);

    view = await detail(ticket.id, agentCookie);
    expect(view.ticket.unreadCount).toBe(0);
    expect(view.ticket.myReadSeq).toBe(2);

    const notes = await notificationsOf(agentId);
    const ofTicket = notes.filter((row) => row.entity_id === ticket.id);
    expect(ofTicket.length).toBeGreaterThan(0);
    expect(ofTicket.every((row) => row.status === 'read')).toBe(true);
    expect(ofTicket.every((row) => Boolean(row.read_at))).toBe(true);
  });

  it('la pasada de plazos avisa una vez por plazo y no repite', async () => {
    const past = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const ticket = await newTicket({ title: 'Entrega con plazo vencido', assignedUserId: agentId, dueAt: past });
    const before = (await notificationsOf(agentId, 'OPS_TICKET_DUE')).length;

    const first = await opsDeadlineTick({
      ctx: app.ctx,
      deps: { notify: (input) => app.notifyUser(input) },
      now,
    });
    expect(first.notified).toBeGreaterThan(0);
    const after = (await notificationsOf(agentId, 'OPS_TICKET_DUE')).length;
    expect(after).toBe(before + 1);
    expect((await notificationsOf(agentId, 'OPS_TICKET_DUE')).at(-1).data.ticket_id).toBe(ticket.id);

    /* Segunda pasada: el plazo YA se avisó. */
    const second = await opsDeadlineTick({
      ctx: app.ctx,
      deps: { notify: (input) => app.notifyUser(input) },
      now,
    });
    expect(second.notified).toBe(0);
    expect((await notificationsOf(agentId, 'OPS_TICKET_DUE')).length).toBe(after);
  });
});

describe('acuse, avance y cierre del TRABAJO', () => {
  it('leer, acusar, completar y resolver son cuatro estados distintos', async () => {
    const ticket = await newTicket({ title: 'Trabajo por estados', assignedUserId: agentId, type: 'assignment' });

    /* 1. Leer: no acusa. */
    await say(ticket.id, 'Empieza cuando puedas', `st-${ticket.id}`);
    await call(`/api/admin/ops/tickets/${ticket.id}/read`, { method: 'POST', body: JSON.stringify({ seq: 1 }) }, agentCookie);
    let view = await detail(ticket.id, agentCookie);
    expect(view.ticket.task.acknowledgedAt).toBeNull();
    expect(view.ticket.task.completedAt).toBeNull();

    /* 2. Acusar: hay acuse, NO hay trabajo completado ni ticket cerrado. */
    const ack = await call(
      `/api/admin/ops/tickets/${ticket.id}/task`,
      { method: 'POST', body: JSON.stringify({ action: 'acknowledge', note: 'Recibido' }) },
      agentCookie,
    );
    expect(ack.status).toBe(200);
    view = await detail(ticket.id, agentCookie);
    expect(view.ticket.task.acknowledgedAt).toBeTruthy();
    expect(view.ticket.task.acknowledgedByName).toBe(AGENT.name);
    expect(view.ticket.task.completedAt).toBeNull();
    expect(view.ticket.status).not.toBe('resolved');

    /* 3. Completar: el trabajo queda hecho; el ticket SIGUE abierto. */
    const done = await call(
      `/api/admin/ops/tickets/${ticket.id}/task`,
      { method: 'POST', body: JSON.stringify({ action: 'complete', note: 'Nevera revisada' }) },
      agentCookie,
    );
    expect(done.status).toBe(200);
    view = await detail(ticket.id, agentCookie);
    expect(view.ticket.task.completedAt).toBeTruthy();
    expect(view.ticket.task.completedByName).toBe(AGENT.name);
    expect(view.ticket.status).not.toBe('resolved');
    expect(view.events.some((event) => event.kind === 'completed')).toBe(true);

    /* 4. Resolver: ahora sí, y libera el flujo. */
    const resolved = await call(
      `/api/admin/ops/tickets/${ticket.id}/resolve`,
      { method: 'POST', body: JSON.stringify({ resolution: 'Todo correcto' }) },
    );
    expect(resolved.status).toBe(200);
    view = await detail(ticket.id);
    expect(view.ticket.status).toBe('resolved');
  });

  it('iniciar, avance y problema quedan en la línea de tiempo con su autor', async () => {
    const ticket = await newTicket({ title: 'Seguimiento de avance', assignedUserId: agentId });

    for (const [action, note] of [
      ['start', 'Salgo para allá'],
      ['progress', 'Ya voy por la mitad'],
      ['issue', 'La dirección no aparece'],
    ]) {
      const response = await call(
        `/api/admin/ops/tickets/${ticket.id}/task`,
        { method: 'POST', body: JSON.stringify({ action, note, idempotencyKey: `${action}-${ticket.id}` }) },
        agentCookie,
      );
      expect(response.status).toBe(200);
    }

    const view = await detail(ticket.id, agentCookie);
    expect(view.ticket.task.startedByName).toBe(AGENT.name);
    expect(view.ticket.task.lastProgressByName).toBe(AGENT.name);
    expect(view.ticket.task.issueCount).toBe(1);
    const kinds = view.events.map((event) => event.kind);
    expect(kinds).toEqual(expect.arrayContaining(['started', 'progress', 'issue']));
  });

  it('escalar marca espera + prioridad, avisa a administración y se audita', async () => {
    const ticket = await newTicket({ title: 'Caso que hay que escalar', assignedUserId: courierId });
    const before = (await notificationsOf(adminId, 'OPS_TICKET_ESCALATED')).length;

    const response = await call(
      `/api/admin/ops/tickets/${ticket.id}/task`,
      { method: 'POST', body: JSON.stringify({ action: 'escalate', note: 'No encuentro el local' }) },
      courierCookie,
    );
    expect(response.status).toBe(200);

    const view = await detail(ticket.id);
    expect(view.ticket.status).toBe('waiting');
    expect(view.ticket.waitingOn).toBe('human');
    expect(view.ticket.priority).toBe('high');
    expect(view.ticket.task.escalationReason).toContain('No encuentro');

    const admins = await app.collections.list('user_notifications', { limit: 500 });
    const escalations = admins.filter((row) => row.type === 'OPS_TICKET_ESCALATED' && row.entity_id === ticket.id);
    expect(escalations.length).toBeGreaterThan(0);
    expect(escalations.every((row) => String(row.body).includes('No encuentro'))).toBe(true);
    expect((await notificationsOf(adminId, 'OPS_TICKET_ESCALATED')).length).toBe(before + 1);
  });

  it('un ticket ajeno no se puede tocar ni por la ruta de tarea', async () => {
    const ticket = await newTicket({ title: 'Privado de administración' });
    const response = await call(
      `/api/admin/ops/tickets/${ticket.id}/task`,
      { method: 'POST', body: JSON.stringify({ action: 'progress', note: 'Intruso' }) },
      courierCookie,
    );
    expect(response.status).toBe(403);
  });
});

describe('participantes', () => {
  it('alta y baja con permiso, y reglas de integridad', async () => {
    const ticket = await newTicket({ title: 'Gestión de participantes', assignedUserId: agentId });

    /* Un repartidor no gestiona participantes. */
    const denied = await call(
      `/api/admin/ops/tickets/${ticket.id}/participants`,
      { method: 'POST', body: JSON.stringify({ userId: courierId }) },
      courierCookie,
    );
    expect(denied.status).toBe(403);

    /* Administración sí. */
    const added = await call(`/api/admin/ops/tickets/${ticket.id}/participants`, {
      method: 'POST',
      body: JSON.stringify({ userId: courierId }),
    });
    expect(added.status).toBe(200);
    let view = await detail(ticket.id);
    expect(view.participants.some((row) => row.userId === courierId)).toBe(true);

    /* El responsable no se puede quitar sin reasignar. */
    const locked = await call(`/api/admin/ops/tickets/${ticket.id}/participants/${agentId}`, { method: 'DELETE' });
    expect(locked.status).toBe(409);
    expect((await json(locked)).error).toBe('assignee_locked');

    /* Quitar a un observador sí. */
    const removed = await call(`/api/admin/ops/tickets/${ticket.id}/participants/${courierId}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    view = await detail(ticket.id);
    expect(view.participants.some((row) => row.userId === courierId)).toBe(false);
  });

  it('el directorio del equipo exige permiso y no expone hashes', async () => {
    const denied = await call('/api/admin/ops/users', {}, courierCookie);
    expect(denied.status).toBe(403);

    const response = await call('/api/admin/ops/users');
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.users.length).toBeGreaterThan(0);
    expect(body.users.every((user) => !('password_hash' in user))).toBe(true);
    expect(body.users.some((user) => user.name === AGENT.name)).toBe(true);
  });
});

describe('paginación y reinicio', () => {
  it('el hilo se pide por páginas hacia atrás', async () => {
    const ticket = await newTicket({ title: 'Hilo largo' });
    for (let index = 1; index <= 5; index += 1) {
      await say(ticket.id, `Mensaje ${index}`, `page-${ticket.id}-${index}`);
    }

    const first = await json(await call(`/api/admin/ops/tickets/${ticket.id}?limit=2`));
    expect(first.messages.map((row) => row.seq)).toEqual([4, 5]);
    expect(first.hasMore).toBe(true);

    const previous = await json(await call(`/api/admin/ops/tickets/${ticket.id}?limit=2&before=${first.oldestSeq}`));
    expect(previous.messages.map((row) => row.seq)).toEqual([2, 3]);
    expect(previous.hasMore).toBe(true);
  });

  it('avisos, acuse y estado sobreviven a un reinicio del backend', async () => {
    const ticket = await newTicket({ title: 'Sobrevivir a la Etapa C', assignedUserId: agentId });
    await say(ticket.id, 'Mensaje antes del reinicio', `restart-c-${ticket.id}`);
    await call(
      `/api/admin/ops/tickets/${ticket.id}/task`,
      { method: 'POST', body: JSON.stringify({ action: 'acknowledge', note: 'Visto' }) },
      agentCookie,
    );
    const notesBefore = await notificationsOf(agentId, 'OPS_TICKET_MESSAGE');

    await app.close();
    app = await bootApp();
    adminCookie = await login(ADMIN);
    agentCookie = await login(AGENT);

    const view = await detail(ticket.id, agentCookie);
    expect(view.ticket.task.acknowledgedByName).toBe(AGENT.name);
    expect(view.messages).toHaveLength(1);
    const notesAfter = await notificationsOf(agentId, 'OPS_TICKET_MESSAGE');
    expect(notesAfter.length).toBe(notesBefore.length);
    expect(notesAfter.some((row) => row.entity_id === ticket.id)).toBe(true);
  }, 60_000);
});
