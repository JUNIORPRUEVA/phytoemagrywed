// @vitest-environment node
/**
 * CENTRO DE OPERACIONES — tickets internos (Etapa B).
 *
 * Comprueba contra el CRM REAL (SQLite temporal, WhatsApp simulado) lo que la
 * Etapa B promete:
 *  - alta manual y desde un pedido, con DUPLICADO imposible mientras está activo;
 *  - mensajes persistidos, con `seq` correcto incluso en envíos simultáneos;
 *  - idempotencia por `clientKey` (un doble toque no escribe dos veces);
 *  - lectura y acuse como estados SEPARADOS (leer no acusa ni cierra);
 *  - autorización en el servidor: un repartidor solo ve sus tickets;
 *  - todo sigue ahí después de REINICIAR el backend;
 *  - cerrar libera el flujo (se puede abrir otro ticket del mismo pedido).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'ops-stage-b-token';
const APP_SECRET = 'ops-stage-b-secret';
const ADMIN_USER = 'admin@phyto.local';
const ADMIN_PASS = 'AdminOps-12345';
const AGENT_USER = 'agente@phyto.local';
const AGENT_PASS = 'AgenteOps-12345';
const COURIER_USER = 'reparto@phyto.local';
const COURIER_PASS = 'RepartoOps-12345';
const CUSTOMER_PHONE = '18095557701';

let tmpDir;
let app;
let adminCookie = '';
let agentCookie = '';
let courierCookie = '';
let agentId = '';
let courierId = '';
let conversationId = '';
let now = new Date('2026-10-21T14:00:00.000Z');

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-OPS',
  businessAccountId: 'WABA-OPS',
  sent: [],
  async sendText(to, body, options) {
    mockWhatsApp.sent.push({ to, body, options, type: 'text' });
    return { ok: true, status: 200, messageId: `wamid.OPS_TXT_${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    mockWhatsApp.sent.push({ to, template, type: 'template' });
    return { ok: true, status: 200, messageId: `wamid.OPS_TPL_${mockWhatsApp.sent.length}` };
  },
  async sendDocument(to, input) {
    mockWhatsApp.sent.push({ to, ...input, type: 'document' });
    return { ok: true, status: 200, waMessageId: `wamid.OPS_DOC_${mockWhatsApp.sent.length}` };
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

async function login(username, password) {
  const response = await fetch(`${app.url}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}

async function inbound(from, body) {
  const id = `wamid.OPS.${Math.random().toString(36).slice(2)}`;
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-OPS',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'PN-OPS' },
              contacts: [{ profile: { name: `Cliente ${from.slice(-4)}` }, wa_id: from }],
              messages: [{ id, from, timestamp: `${Math.floor(now.getTime() / 1000)}`, type: 'text', text: { body } }],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  return fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
}

async function createOrder(overrides = {}) {
  const response = await call('/api/admin/orders', {
    method: 'POST',
    body: JSON.stringify({
      phone: CUSTOMER_PHONE,
      name: 'Cliente Operaciones',
      paymentMethod: 'CASH',
      conversationId,
      items: [{ variantId: 'capsules_10', quantity: 1 }],
      ...overrides,
    }),
  });
  expect(response.status).toBe(201);
  return json(response);
}

async function bootApp() {
  return startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'ops.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsappPhoneNumber: '+18095550000',
    whatsapp: mockWhatsApp,
    whatsappMedia: mockWhatsApp,
    storage,
    bootstrapAdminUser: ADMIN_USER,
    bootstrapAdminPassword: ADMIN_PASS,
    schedulerEnabled: false,
    clock: () => now,
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-ops-'));
  app = await bootApp();
  adminCookie = await login(ADMIN_USER, ADMIN_PASS);

  const agent = await json(
    await call('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: AGENT_USER, password: AGENT_PASS, role: 'AGENT', displayName: 'Agente Ops' }),
    }),
  );
  agentId = agent.user.id;
  const courier = await json(
    await call('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: COURIER_USER, password: COURIER_PASS, role: 'DELIVERY', displayName: 'Reparto Ops' }),
    }),
  );
  courierId = courier.user.id;
  agentCookie = await login(AGENT_USER, AGENT_PASS);
  courierCookie = await login(COURIER_USER, COURIER_PASS);

  await inbound(CUSTOMER_PHONE, 'Hola, quiero un pedido');
  const data = await json(await call('/api/admin/conversations'));
  conversationId = data.conversations.find((row) => row.customer?.phone_e164 === `+${CUSTOMER_PHONE}`)?.id;
  expect(conversationId).toBeTruthy();
}, 90_000);

afterAll(async () => {
  await app?.close?.();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('alta de tickets', () => {
  it('crea un ticket manual con número único y al creador como participante', async () => {
    const response = await call('/api/admin/ops/tickets', {
      method: 'POST',
      body: JSON.stringify({
        type: 'incident',
        title: 'Revisar factura de proveedor',
        description: 'La factura llegó sin el sello de la tienda.',
        priority: 'high',
      }),
    });
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.ticket.number).toMatch(/^TK-[0-9A-F]{6}$/);
    expect(body.ticket.status).toBe('open');
    expect(body.ticket.priorityLabel).toBe('Alta');

    const detail = await json(await call(`/api/admin/ops/tickets/${body.ticket.id}`));
    expect(detail.participants.some((row) => row.role === 'owner')).toBe(true);
  });

  it('rechaza tipos inválidos y asuntos demasiado cortos', async () => {
    const badType = await call('/api/admin/ops/tickets', {
      method: 'POST',
      body: JSON.stringify({ type: 'teleport', title: 'Algo' }),
    });
    expect(badType.status).toBe(422);
    expect((await json(badType)).error).toBe('invalid_type');

    const badTitle = await call('/api/admin/ops/tickets', {
      method: 'POST',
      body: JSON.stringify({ type: 'admin', title: 'ab' }),
    });
    expect(badTitle.status).toBe(422);
    expect((await json(badTitle)).error).toBe('invalid_title');
  });

  it('crea el ticket de un pedido y NO permite dos activos del mismo flujo', async () => {
    const order = await createOrder();
    const orderId = order.item.id;

    const before = await json(await call(`/api/admin/ops/orders/${orderId}/ticket`));
    expect(before.ticket).toBeNull();

    const first = await call('/api/admin/ops/tickets', {
      method: 'POST',
      body: JSON.stringify({
        type: 'delivery',
        title: 'Entregar pedido de prueba',
        entityType: 'order',
        entityId: orderId,
      }),
    });
    expect(first.status).toBe(201);
    const created = await json(first);
    expect(created.ticket.orderNumber).toBeTruthy();

    const again = await call('/api/admin/ops/tickets', {
      method: 'POST',
      body: JSON.stringify({
        type: 'delivery',
        title: 'Entregar pedido de prueba',
        entityType: 'order',
        entityId: orderId,
      }),
    });
    expect(again.status).toBe(409);
    const duplicate = await json(again);
    expect(duplicate.error).toBe('duplicate_ticket');
    expect(duplicate.ticket.id).toBe(created.ticket.id);

    const lookup = await json(await call(`/api/admin/ops/orders/${orderId}/ticket`));
    expect(lookup.ticket.id).toBe(created.ticket.id);

    /* Un pedido que no existe no puede tener ticket. */
    const missing = await call('/api/admin/ops/tickets', {
      method: 'POST',
      body: JSON.stringify({ type: 'delivery', title: 'Pedido fantasma', entityType: 'order', entityId: 'no-existe' }),
    });
    expect(missing.status).toBe(404);
    expect((await json(missing)).error).toBe('order_not_found');
  });
});

describe('mensajes internos', () => {
  it('guarda el mensaje con su autor y sella la actividad del ticket', async () => {
    const created = await json(
      await call('/api/admin/ops/tickets', {
        method: 'POST',
        body: JSON.stringify({ type: 'admin', title: 'Cuadrar caja del turno' }),
      }),
    );
    const ticketId = created.ticket.id;

    const sent = await call(`/api/admin/ops/tickets/${ticketId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Revisen el cierre de ayer, falta un pago.', clientKey: `k-${ticketId}-1` }),
    });
    expect(sent.status).toBe(201);
    const payload = await json(sent);
    const session = await json(await call('/api/admin/session'));
    expect(payload.message.seq).toBe(1);
    expect(payload.message.authorType).toBe('user');
    expect(payload.message.authorName).toBe(session.user.display_name);
    expect(payload.ticket.status).toBe('in_progress');
    expect(payload.ticket.lastMessagePreview).toContain('cierre de ayer');

    /* La idempotencia: el MISMO clientKey no escribe otro mensaje. */
    const repeated = await call(`/api/admin/ops/tickets/${ticketId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Revisen el cierre de ayer, falta un pago.', clientKey: `k-${ticketId}-1` }),
    });
    expect(repeated.status).toBe(200);
    expect((await json(repeated)).duplicate).toBe(true);

    const detail = await json(await call(`/api/admin/ops/tickets/${ticketId}`));
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0].body).toContain('cierre de ayer');

    /* Y sigue estando en la BASE, no solo en la respuesta. */
    const rows = await app.collections.list('ops_ticket_messages', { where: { ticket_id: ticketId }, limit: 50 });
    expect(rows).toHaveLength(1);
  });

  it('reparte números de secuencia únicos con envíos simultáneos', async () => {
    const response = await call('/api/admin/ops/tickets', {
      method: 'POST',
      body: JSON.stringify({ type: 'admin', title: 'Prueba de concurrencia' }),
    });
    expect(response.status).toBe(201);
    const created = await json(response);
    const ticketId = created.ticket.id;
    const sends = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        call(`/api/admin/ops/tickets/${ticketId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ body: `Mensaje ${index}`, clientKey: `conc-${ticketId}-${index}` }),
        }),
      ),
    );
    expect(sends.every((response) => response.status === 201)).toBe(true);
    const detail = await json(await call(`/api/admin/ops/tickets/${ticketId}`));
    const seqs = detail.messages.map((row) => row.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('dos tickets manuales con el mismo título son DOS trabajos distintos', async () => {
    const base = { type: 'incident', title: 'Revisar caja del turno' };
    const first = await call('/api/admin/ops/tickets', { method: 'POST', body: JSON.stringify(base) });
    const second = await call('/api/admin/ops/tickets', { method: 'POST', body: JSON.stringify(base) });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await json(first)).ticket.id).not.toBe((await json(second)).ticket.id);
  });

  it('el mismo formulario enviado dos veces devuelve el MISMO ticket', async () => {
    const body = JSON.stringify({ type: 'incident', title: 'Doble toque', idempotencyKey: 'form-incidente-1' });
    const first = await call('/api/admin/ops/tickets', { method: 'POST', body });
    expect(first.status).toBe(201);
    const created = await json(first);

    const again = await call('/api/admin/ops/tickets', { method: 'POST', body });
    expect(again.status).toBe(409);
    expect((await json(again)).ticket.id).toBe(created.ticket.id);
  });

  it('rechaza un mensaje vacío y no deja escribir en un ticket cerrado', async () => {
    const created = await json(
      await call('/api/admin/ops/tickets', {
        method: 'POST',
        body: JSON.stringify({ type: 'admin', title: 'Ticket que se cierra' }),
      }),
    );
    const ticketId = created.ticket.id;

    const empty = await call(`/api/admin/ops/tickets/${ticketId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '   ' }),
    });
    expect(empty.status).toBe(422);
    expect((await json(empty)).error).toBe('empty_message');

    const closed = await call(`/api/admin/ops/tickets/${ticketId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolution: 'No hacía falta' }),
    });
    expect(closed.status).toBe(200);

    const after = await call(`/api/admin/ops/tickets/${ticketId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Tarde' }),
    });
    expect(after.status).toBe(409);
    expect((await json(after)).error).toBe('ticket_closed');
  });
});

describe('lectura, acuse y avisos', () => {
  it('el acuse es un estado distinto de la lectura y no cierra el ticket', async () => {
    const created = await json(
      await call('/api/admin/ops/tickets', {
        method: 'POST',
        body: JSON.stringify({ type: 'assignment', title: 'Confirmar asignación', assignedUserId: agentId }),
      }),
    );
    const ticketId = created.ticket.id;

    await call(`/api/admin/ops/tickets/${ticketId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Te toca esta entrega.', clientKey: `ack-${ticketId}-1` }),
    });

    /* El agente ve el aviso como no leído. */
    let inbox = await json(await call('/api/admin/ops/inbox?filter=mios', {}, agentCookie));
    let row = inbox.items.find((item) => item.id === ticketId);
    expect(row.unread).toBe(true);
    expect(row.ackPending).toBe(false);

    /* Leer NO acusa recibo. */
    const read = await call(`/api/admin/ops/tickets/${ticketId}/read`, {
      method: 'POST',
      body: JSON.stringify({ seq: 1 }),
      headers: { cookie: agentCookie },
    });
    expect(read.status).toBe(200);

    inbox = await json(await call('/api/admin/ops/inbox?filter=mios', {}, agentCookie));
    row = inbox.items.find((item) => item.id === ticketId);
    expect(row.unread).toBe(false);
    expect(row.ackPending).toBe(true);

    /* Acusar sí lo marca, y el ticket NO se cierra solo. */
    const ack = await call(`/api/admin/ops/tickets/${ticketId}/ack`, {
      method: 'POST',
      body: JSON.stringify({ seq: 1, note: 'Recibido, salgo en 10 minutos' }),
      headers: { cookie: agentCookie },
    });
    expect(ack.status).toBe(200);

    const detail = await json(await call(`/api/admin/ops/tickets/${ticketId}`));
    expect(detail.ticket.status).not.toBe('resolved');
    expect(detail.events.some((event) => event.kind === 'ack')).toBe(true);
  });

  it('un repartidor SOLO ve los tickets donde participa', async () => {
    const created = await json(
      await call('/api/admin/ops/tickets', {
        method: 'POST',
        body: JSON.stringify({ type: 'incident', title: 'Ticket privado de administración' }),
      }),
    );

    const forbidden = await call(`/api/admin/ops/tickets/${created.ticket.id}`, {}, courierCookie);
    expect(forbidden.status).toBe(403);
    expect((await json(forbidden)).error).toBe('forbidden');

    const inbox = await json(await call('/api/admin/ops/inbox?filter=todos', {}, courierCookie));
    expect(inbox.items.some((item) => item.id === created.ticket.id)).toBe(false);

    /* Y tampoco puede escribir en él. */
    const write = await call(`/api/admin/ops/tickets/${created.ticket.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Hola' }),
      headers: { cookie: courierCookie },
    });
    expect(write.status).toBe(403);
  });

  it('el repartidor sí trabaja en el ticket que tiene asignado', async () => {
    const order = await createOrder({ phone: '18095557702', name: 'Cliente Reparto' });
    const created = await json(
      await call('/api/admin/ops/tickets', {
        method: 'POST',
        body: JSON.stringify({
          type: 'delivery',
          title: 'Entregar pedido asignado',
          entityType: 'order',
          entityId: order.item.id,
          assignedUserId: courierId,
        }),
      }),
    );
    const ticketId = created.ticket.id;

    const detail = await json(await call(`/api/admin/ops/tickets/${ticketId}`, {}, courierCookie));
    expect(detail.ticket.id).toBe(ticketId);
    expect(detail.permissions.close).toBe(false);

    const reply = await call(`/api/admin/ops/tickets/${ticketId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Voy en camino', clientKey: `courier-${ticketId}` }),
      headers: { cookie: courierCookie },
    });
    expect(reply.status).toBe(201);
    expect((await json(reply)).message.authorName).toBe('Reparto Ops');

    /* Cerrar NO es cosa suya. */
    const close = await call(`/api/admin/ops/tickets/${ticketId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolution: 'Entregado' }),
      headers: { cookie: courierCookie },
    });
    expect(close.status).toBe(403);
  });
});

describe('ciclo de vida y persistencia', () => {
  it('cerrar libera el flujo: el mismo pedido admite un ticket nuevo', async () => {
    const order = await createOrder({ phone: '18095557703', name: 'Cliente Reintento' });
    const first = await json(
      await call('/api/admin/ops/tickets', {
        method: 'POST',
        body: JSON.stringify({ type: 'delivery', title: 'Primer intento', entityType: 'order', entityId: order.item.id }),
      }),
    );
    const resolved = await call(`/api/admin/ops/tickets/${first.ticket.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolution: 'Entregado sin novedad' }),
    });
    expect(resolved.status).toBe(200);
    const resolvedBody = await json(resolved);
    expect(resolvedBody.ticket.status).toBe('resolved');

    const second = await call('/api/admin/ops/tickets', {
      method: 'POST',
      body: JSON.stringify({ type: 'delivery', title: 'Segundo intento', entityType: 'order', entityId: order.item.id }),
    });
    expect(second.status).toBe(201);
    expect((await json(second)).ticket.id).not.toBe(first.ticket.id);

    /* El histórico se conserva. */
    const rows = await app.collections.list('ops_tickets', { where: { entity_id: order.item.id }, limit: 20 });
    expect(rows).toHaveLength(2);
  });

  it('los tickets y sus mensajes sobreviven a un reinicio del backend', async () => {
    const created = await json(
      await call('/api/admin/ops/tickets', {
        method: 'POST',
        body: JSON.stringify({ type: 'admin', title: 'Sobrevivir al reinicio' }),
      }),
    );
    await call(`/api/admin/ops/tickets/${created.ticket.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Esto tiene que seguir aquí', clientKey: `restart-${created.ticket.id}` }),
    });

    await app.close();
    app = await bootApp();
    adminCookie = await login(ADMIN_USER, ADMIN_PASS);

    const detail = await json(await call(`/api/admin/ops/tickets/${created.ticket.id}`));
    expect(detail.ticket.title).toBe('Sobrevivir al reinicio');
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0].body).toBe('Esto tiene que seguir aquí');
  }, 60_000);
});
