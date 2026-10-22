// @vitest-environment node
/**
 * SUPERVISOR DE REPARTO — UAT INTEGRAL (servidor real, sin WhatsApp de verdad).
 *
 * Qué se demuestra aquí, y por qué importa:
 *
 *  1. Si el repartidor NO tiene teléfono, el supervisor lo detecta por entrega,
 *     deja de intentar avisarle, escala a administración con ese motivo EXACTO y
 *     lo deja escrito. No inventa números ni escribe a nadie más.
 *  2. El ticket interno del reparto se abre SOLO (el puente está cableado al
 *     scheduler) y el agente consulta la entrega antes de opinar.
 *  3. El chat del supervisor responde con los datos reales del reparto (no con
 *     la lista genérica de tickets).
 *  4. El teléfono del repartidor se valida EN EL BACKEND al guardarlo.
 *  5. Un pedido cancelado no se puede marcar como entregado desde WhatsApp.
 *
 * Nunca se envía un WhatsApp real: el cliente de WhatsApp es un doble que
 * apunta lo que se le pide enviar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'supervisor-integral-token';
const APP_SECRET = 'supervisor-integral-secret';
const ADMIN_USER = 'admin@integral.local';
const ADMIN_PASS = 'AdminIntegral-12345';
const CUSTOMER_PHONE = '18095558888';
const L1 = { latitude: 18.6157, longitude: -68.7071, name: 'Casa', address: 'Calle Principal 12' };

let tmpDir;
let app;
let adminCookie = '';
let conversationId = '';
let now = new Date('2026-10-22T13:00:00.000Z');

const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-INT',
  businessAccountId: 'WABA1',
  sent: [],
  async sendText(to, body, options) {
    whatsapp.sent.push({ to, body, options, type: 'text' });
    return { ok: true, status: 200, messageId: `wamid.INT_TEXT_${whatsapp.sent.length}` };
  },
  async sendTemplate(to, template) {
    whatsapp.sent.push({ to, template, type: 'template' });
    return { ok: true, status: 200, messageId: `wamid.INT_TPL_${whatsapp.sent.length}` };
  },
  async sendDocument(to, input) {
    whatsapp.sent.push({ to, ...input, type: 'document' });
    return { ok: true, status: 200, waMessageId: `wamid.INT_DOC_${whatsapp.sent.length}` };
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
const request = (route, options = {}, cookie = adminCookie) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers ?? {}) },
  });

async function login(username, password) {
  const response = await request('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }, '');
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}

/** Mensaje entrante firmado, tal y como lo manda Meta. */
async function inbound(from, body, id = `wamid.IN.${Math.random().toString(36).slice(2)}`) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'PN-INT' },
              contacts: [{ profile: { name: 'Contacto' }, wa_id: from }],
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
  return request('/api/webhooks/whatsapp', { method: 'POST', headers: { 'x-hub-signature-256': signature }, body: raw }, '');
}

const advance = (minutes) => {
  now = new Date(now.getTime() + minutes * 60 * 1000);
};

async function createOrder(overrides = {}) {
  const response = await request('/api/admin/orders', {
    method: 'POST',
    body: JSON.stringify({
      phone: CUSTOMER_PHONE,
      name: 'Cliente Integral',
      paymentMethod: 'CASH',
      conversationId,
      items: [{ variantId: 'capsules_10', quantity: 1 }],
      deliveryLocation: L1,
      deliveryFee: 250,
      ...overrides,
    }),
  });
  expect(response.status).toBe(201);
  return json(response);
}

async function createUser(input) {
  const response = await request('/api/admin/users', { method: 'POST', body: JSON.stringify(input) });
  return { status: response.status, body: await json(response) };
}

async function assignCourier(orderId, userId) {
  const response = await request(`/api/admin/orders/${orderId}/delivery/assign`, {
    method: 'POST',
    body: JSON.stringify({ deliveryUserId: userId, deliveryNote: 'Entrega UAT' }),
  });
  return { status: response.status, body: await json(response) };
}

/** Una vuelta COMPLETA del scheduler (los ticks del Centro IA incluidos). */
async function tick() {
  return app.ctx.scheduler.tick();
}

/**
 * Repartidor interno CON teléfono válido. Se busca y, si no lo hay, se crea y se
 * le guarda el número (así cada prueba puede correr sola).
 */
async function repartidorConNumero() {
  const existente = (await app.ctx.users.listUsers()).find((row) => row.personal_phone === '+18095550123');
  if (existente) return existente;
  const creado = await createUser({
    username: `reparto.numero.${Date.now()}@integral.local`,
    password: 'Reparto-12345',
    displayName: 'Luisa Con Número',
    role: 'DELIVERY',
  });
  expect(creado.status).toBe(201);
  const guardado = await request(`/api/admin/users/${creado.body.user.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ personalPhone: '809 555 0123' }),
  });
  expect(guardado.status).toBe(200);
  return (await app.ctx.users.listUsers()).find((row) => row.id === creado.body.user.id);
}

const eventos = async () => app.collections.list('delivery_supervision_events', { limit: 1000 });
const ticketDePedido = async (orderId) =>
  (await app.collections.list('ops_tickets', { limit: 200 })).find((row) => row.entity_id === orderId) ?? null;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-supervisor-integral-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phyto.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsappPhoneNumber: '+18095550000',
    whatsapp,
    whatsappMedia: whatsapp,
    storage,
    bootstrapAdminUser: ADMIN_USER,
    bootstrapAdminPassword: ADMIN_PASS,
    schedulerEnabled: false,
    clock: () => now,
  });
  adminCookie = await login(ADMIN_USER, ADMIN_PASS);
  /*
   * ACTIVACIÓN CON FECHA ANTERIOR. El supervisor solo mira pedidos asignados a
   * partir de `activatedAt`; si se activara ahora, los pedidos que el test crea
   * después quedarían «en revisión» y no se supervisarían (es la regla real, no
   * un fallo). Se fija el corte antes de crear nada.
   */
  const ajustes = await request('/api/admin/delivery-supervisor/settings', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, activatedAt: '2026-10-22T11:00:00.000Z' }),
  });
  expect(ajustes.status).toBe(200);
  await inbound(CUSTOMER_PHONE, 'Hola, quiero hacer un pedido');
  const data = await json(await request('/api/admin/conversations'));
  conversationId = data.conversations.find((row) => row.customer?.phone_e164 === `+${CUSTOMER_PHONE}`)?.id;
  expect(conversationId).toBeTruthy();
  // Sin stock la transición a entregado se niega (y aquí probamos el reparto).
  const stock = await request('/api/admin/inventory/restock', {
    method: 'POST',
    body: JSON.stringify({ quantity: 120, unitCost: '126.66', reason: 'Inventario UAT reparto' }),
  });
  expect(stock.status).toBe(201);
}, 60000);

afterAll(async () => {
  await app?.close?.();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('Fase 2 · el repartidor sin teléfono se detecta y se escala', () => {
  let sinNumero;
  let pedido;

  it('un repartidor puede existir sin teléfono (dato real, no un error)', async () => {
    const creado = await createUser({
      username: 'reparto.sin.numero@integral.local',
      password: 'Reparto-12345',
      displayName: 'Ramón Sin Número',
      role: 'DELIVERY',
    });
    expect(creado.status).toBe(201);
    sinNumero = creado.body.user;
    expect(sinNumero.personal_phone ?? null).toBeNull();
  });

  it('al pasar el primer plazo, escala con el motivo «courier_without_phone» y no escribe a nadie', async () => {
    const enviadosAntes = whatsapp.sent.length;
    const orden = await createOrder();
    pedido = { ...(orden.order ?? {}), id: orden.item.id };
    const asignado = await assignCourier(pedido.id, sinNumero.id);
    expect(asignado.status).toBe(200);

    advance(45);
    const vuelta = await tick();

    /* Hay una entrega abierta con repartidor sin número: se cuenta y se dice. */
    const resumen = await json(await request('/api/admin/delivery-supervisor'));
    expect(resumen.counts.without_phone).toBeGreaterThanOrEqual(1);
    const fila = [...(resumen.buckets.sin_iniciar ?? []), ...(resumen.buckets.atrasados ?? [])].find(
      (row) => row.id === pedido.id,
    );
    expect(fila).toBeTruthy();
    expect(fila.phone_missing).toBe(true);

    /* El escalado queda escrito con su motivo exacto. */
    const escalados = (await eventos()).filter(
      (entry) => entry.order_id === pedido.id && entry.kind === 'escalation' && entry.data?.reason === 'courier_without_phone',
    );
    expect(escalados).toHaveLength(1);

    /* A nadie se le escribió por WhatsApp por este pedido sin número. */
    const nuevos = whatsapp.sent.slice(enviadosAntes).filter((row) => row.to !== `+${CUSTOMER_PHONE}`);
    expect(nuevos).toHaveLength(0);

    /* Y no se inventó ninguna entrega: el pedido sigue como estaba. */
    expect(resumen.counts.confirmadas).toBe(0);
    expect(vuelta.supervisor).toBeTruthy();
  }, 60000);

  it('la segunda pasada no repite el escalado (no es un aviso, es un estado)', async () => {
    advance(30);
    await tick();
    const escalados = (await eventos()).filter(
      (entry) => entry.order_id === pedido.id && entry.kind === 'escalation' && entry.data?.reason === 'courier_without_phone',
    );
    expect(escalados).toHaveLength(1);
  }, 60000);

  it('el chat del supervisor lo explica con el número de pedido y pide el dato', async () => {
    const agente = await request('/api/admin/ops/agents', {
      method: 'POST',
      body: JSON.stringify({
        key: 'delivery_supervisor',
        name: 'Supervisor de reparto',
        role: 'Seguimiento de entregas',
        ticketTypes: ['delivery'],
        tools: [
          'ticket.get_context',
          'order.get_status',
          'delivery.get_status',
          'ticket.post_message',
          'ticket.request_ack',
          'ticket.escalate',
          'ticket.complete_work',
          'agent.request_help',
        ],
        config: { followUpMinutes: 20 },
      }),
    });
    expect([200, 201, 409]).toContain(agente.status);

    const respuesta = await request('/api/admin/ops/agents/delivery_supervisor/ask', {
      method: 'POST',
      body: JSON.stringify({ message: '¿Qué entregas tienes y a quién no le puedes escribir?' }),
    });
    expect(respuesta.status).toBe(200);
    const cuerpo = await json(respuesta);
    expect(cuerpo.answer?.source).toBe('registros');
    const texto = String(cuerpo.answer?.text ?? '');
    /* Habla del reparto REAL: el pedido y la falta de teléfono. */
    expect(pedido.order_number).toBeTruthy();
    expect(texto).toContain(pedido.order_number);
    expect(texto.toLowerCase()).toContain('teléfono');
    expect(texto.toLowerCase()).toMatch(/entregas que estoy mirando|reparto:/);
    /* Y no finge que ya escribió. */
    expect(texto.toLowerCase()).not.toContain('ya le escribí');
  }, 60000);

  it('la pantalla propia del supervisor también contesta con las entregas reales', async () => {
    const respuesta = await request('/api/admin/delivery-supervisor/ask', {
      method: 'POST',
      body: JSON.stringify({ question: '¿Qué entregas tengo abiertas y quién las lleva?' }),
    });
    expect(respuesta.status).toBe(200);
    const cuerpo = await json(respuesta);
    expect(cuerpo.topic).toBe('orders');
    expect(cuerpo.answer).toContain(pedido.order_number);
    /* Y dice el nombre del repartidor y, si falta, que falta el teléfono. */
    expect(cuerpo.answer).toContain('Ramón Sin Número');
    expect(cuerpo.answer).toContain('SIN teléfono');
  }, 30000);
});

describe('Fase 1 · el ticket del reparto se abre solo y el agente consulta la entrega', () => {
  let pedido;

  it('una entrega en riesgo abre su ticket, se lo asigna al agente y lo consulta', async () => {
    const orden = await createOrder({ name: 'Cliente Ticket' });
    pedido = orden.item;
    const repartidor = await repartidorConNumero();
    expect(repartidor).toBeTruthy();
    const asignado = await assignCourier(pedido.id, repartidor.id);
    expect(asignado.status).toBe(200);

    advance(60);
    await tick();

    const ticket = await ticketDePedido(pedido.id);
    expect(ticket).toBeTruthy();
    expect(ticket.type).toBe('delivery');
    expect(ticket.assigned_agent_id).toBe('delivery_supervisor');

    /* El motor de agentes corre DESPUÉS del puente en la misma pasada. */
    const run = (await app.collections.list('ops_agent_runs', { limit: 100 })).find((row) => row.ticket_id === ticket.id);
    expect(run).toBeTruthy();
    expect(run.agent_key).toBe('delivery_supervisor');

    /*
     * Cada vuelta ejecuta UN paso. Se dejan correr las suficientes para que el
     * agente cargue el contexto, CONSULTE LA ENTREGA y escriba su saludo.
     */
    for (let i = 0; i < 4; i += 1) await tick();
    const despues = (await app.collections.list('ops_agent_runs', { limit: 100 })).find((row) => row.id === run.id);
    expect(despues.state?.deliveryChecked).toBe(true);
    expect(String(despues.state?.deliveryNextAction ?? '')).toMatch(/entrega|recoger|confirmar/i);

    const mensajes = await app.collections.list('ops_ticket_messages', { limit: 200 });
    const suyos = mensajes.filter((row) => row.ticket_id === ticket.id && row.author_type === 'agent');
    expect(suyos.length).toBeGreaterThanOrEqual(1);
    /* El saludo usa el dato REAL de la entrega, no una frase genérica. */
    expect(suyos.some((row) => /En reparto toca/i.test(String(row.body ?? '')))).toBe(true);
    /* Y no se inventa el cierre: el pedido sigue como estaba. */
    expect(suyos.some((row) => /entregado y cerrado/i.test(String(row.body ?? '')))).toBe(false);

    /*
     * ESCENARIO A COMPLETO: el repartidor reporta la entrega y la confirma; el
     * pedido se cierra con la transición OFICIAL y el supervisor da su trabajo
     * por terminado (sin cerrar el ticket: eso sigue siendo humano).
     */
    const numero = orden.order.order_number;
    await inbound('+18095550123', `Entregado el pedido ${numero}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await inbound('+18095550123', `CONFIRMAR ${numero}`);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const entregado = await json(await request(`/api/admin/orders/${pedido.id}`));
    expect(entregado.order?.status).toBe('entregado');

    /* Varias vueltas para que el agente vuelva a leer la entrega y termine. */
    for (let i = 0; i < 4; i += 1) await tick();
    const ticketFinal = await ticketDePedido(pedido.id);
    expect(ticketFinal.task?.completed_at).toBeTruthy();
    /* El ticket NO se cerró solo: sigue abierto para una persona. */
    expect(['resolved', 'closed', 'cancelled']).not.toContain(String(ticketFinal.status));
  }, 120000);
});

describe('Fase 2 · el teléfono se valida en el backend', () => {
  let repartidor;

  it('rechaza un teléfono que no es un número y no toca lo ya guardado', async () => {
    const creado = await createUser({
      username: 'reparto.valida@integral.local',
      password: 'Reparto-12345',
      displayName: 'Luisa Válida',
      role: 'DELIVERY',
    });
    expect(creado.status).toBe(201);
    repartidor = creado.body.user;

    const basura = await request(`/api/admin/users/${repartidor.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ personalPhone: 'el de la flota' }),
    });
    expect(basura.status).toBe(422);
    expect((await json(basura)).error).toBe('invalid_phone');

    const corto = await request(`/api/admin/users/${repartidor.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ personalPhone: '809555' }),
    });
    expect(corto.status).toBe(422);

    const incompleto = await request(`/api/admin/users/${repartidor.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ personalPhone: '809555012' }),
    });
    expect(incompleto.status).toBe(422);

    const bueno = await request(`/api/admin/users/${repartidor.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ personalPhone: '809 555 0123' }),
    });
    expect(bueno.status).toBe(200);
    const fila = (await app.ctx.users.listUsers()).find((row) => row.id === repartidor.id);
    expect(fila.personal_phone).toBe('+18095550123');
  }, 30000);

  it('con el número guardado, la entrega deja de estar bloqueada y el aviso sale', async () => {
    const orden = await createOrder({ name: 'Cliente Con Número' });
    const asignado = await assignCourier(orden.item.id, repartidor.id);
    expect(asignado.status).toBe(200);

    advance(45);
    const enviadosAntes = whatsapp.sent.length;
    await tick();

    const resumen = await json(await request('/api/admin/delivery-supervisor'));
    const fila = [...(resumen.buckets.sin_iniciar ?? []), ...(resumen.buckets.atrasados ?? [])].find(
      (row) => row.id === orden.item.id,
    );
    expect(fila).toBeTruthy();
    expect(fila.phone_missing).toBe(false);

    /* Se intentó avisar al número del repartidor (texto o plantilla). */
    const suyos = whatsapp.sent.slice(enviadosAntes).filter((row) => row.to === '+18095550123');
    expect(suyos.length).toBeGreaterThanOrEqual(1);
  }, 60000);
});

describe('Fase 3 · un aviso ENVIADO no es un acuse', () => {
  it('el recordatorio sale, queda como enviado, y el acuse se registra aparte cuando el repartidor responde', async () => {
    const repartidor = await repartidorConNumero();
    expect(repartidor.personal_phone).toBe('+18095550123');
    const orden = await createOrder({ name: 'Cliente Acuse' });
    expect((await assignCourier(orden.item.id, repartidor.id)).status).toBe(200);

    advance(30);
    await tick();

    const recordatorios = (await eventos()).filter((entry) => entry.order_id === orden.item.id && entry.kind === 'reminder');
    expect(recordatorios.length).toBeGreaterThanOrEqual(1);
    expect(recordatorios.at(-1).data?.whatsapp).toBe('sent');

    /* Enviado NO es acuse: el pedido todavía no tiene acuse del repartidor. */
    const antes = await json(await request(`/api/admin/orders/${orden.item.id}`));
    expect(antes.order?.delivery?.supervisor?.acknowledged_at ?? null).toBeNull();

    /*
     * EL ACUSE VA CON EL NÚMERO DEL PEDIDO. El repartidor puede tener varios
     * pedidos abiertos y el supervisor no adivina: «recibido» a secas no puede
     * dar por acusado un pedido cualquiera (eso ya se prueba en
     * `delivery-supervisor.test.js`).
     */
    await inbound('+18095550123', `Recibido el pedido ${orden.order.order_number}`);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const despues = await json(await request(`/api/admin/orders/${orden.item.id}`));
    const propios = (await eventos()).filter((entry) => entry.order_id === orden.item.id);
    expect(
      Boolean(despues.order?.delivery?.supervisor?.acknowledged_at),
      `eventos: ${propios.map((row) => `${row.kind}/${row.status}`).join(' ')}`,
    ).toBe(true);
    const acuses = (await eventos()).filter((entry) => entry.order_id === orden.item.id && entry.kind === 'ack');
    expect(acuses).toHaveLength(1);
    /* El acuse queda con autor: lo dio el repartidor, no el sistema. */
    expect(String(acuses[0].actor ?? '')).toContain('Repartidor');
  }, 60000);
});

describe('Fase 5 · un pedido cancelado no se entrega', () => {
  it('la cancelación gana: ni el panel ni el repartidor pueden marcarlo entregado', async () => {
    const orden = await createOrder({ name: 'Cliente Cancelado' });
    const repartidor = await repartidorConNumero();
    expect(repartidor).toBeTruthy();
    expect((await assignCourier(orden.item.id, repartidor.id)).status).toBe(200);

    const cancelado = await request(`/api/admin/orders/${orden.item.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'CANCELADO', reason: 'El cliente anuló el pedido por teléfono' }),
    });
    expect(cancelado.status).toBe(200);

    const intentoPanel = await request(`/api/admin/orders/${orden.item.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'ENTREGADO', reason: 'Intento de entrega posterior a la anulación' }),
    });
    expect(intentoPanel.status).toBe(409);
    expect((await json(intentoPanel)).error).toBe('order_cancelled');

    /* El repartidor escribe «Entregado» y «CONFIRMAR»: no hay pedido abierto. */
    await inbound('+18095550123', 'Entregado');
    await inbound('+18095550123', 'CONFIRMAR');
    await new Promise((resolve) => setTimeout(resolve, 400));

    const detalle = await json(await request(`/api/admin/orders/${orden.item.id}`));
    expect(detalle.order?.status ?? detalle.item?.status).toBe('cancelado');
  }, 60000);
});
