// @vitest-environment node
/*
 * CICLO DE VIDA DEL CLIENTE — 4 etapas, automáticas y auditables.
 *
 *   PROSPECTO → INTERESADO → CLIENTE → RECOMPRA
 *
 * Lo que se prueba aquí es la REGLA, no la UI: servidor real, base temporal y
 * pedidos reales creados y entregados por las rutas del CRM.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';
import { classifyInterest, deriveCommercialState, resolveCustomerStage } from '../server/customers.mjs';

let app;
let dir;
let cookie = '';
let contador = 0;

const call = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers ?? {}) },
  });
const json = async (route, options) => (await call(route, options)).json();

const telefono = () => `+1809555${String(2000 + contador++).slice(-4)}`;

/** Contacto nuevo por la vía real (mensaje entrante de WhatsApp). */
async function contacto(phone = telefono()) {
  return app.customers.findOrCreateByPhone({ phone, name: `Cliente ${contador}` });
}

/** Mensaje entrante real (webhook). */
function escribe(phone, body, id = `wamid.${Math.random().toString(36).slice(2)}`) {
  return app.customers.recordInbound({
    waMessage: { waMessageId: id, from: phone.replace('+', ''), profileName: 'Cliente', body, type: 'text', receivedAt: new Date().toISOString() },
  });
}

async function compra(phone, status = 'nuevo') {
  const respuesta = await call('/api/admin/purchases', {
    method: 'POST',
    body: JSON.stringify({ name: 'Cliente', phone, variantId: 'capsules_60', quantity: 1, status, paymentMethod: 'CASH' }),
  });
  const cuerpo = await respuesta.json();
  return cuerpo;
}

const entregar = (orderId) => call(`/api/admin/items/${orderId}`, { method: 'PATCH', body: JSON.stringify({ status: 'entregado' }) });
const cambiarEstado = (orderId, status) =>
  call(`/api/admin/items/${orderId}`, { method: 'PATCH', body: JSON.stringify({ status }) });

const etapa = async (customerId) => (await app.customers.customerStage(customerId)).stage;
const ficha = async (customerId) => app.ctx.db.get('customers', customerId);

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cliente-ciclo-'));
  app = await startCrmServer({
    host: '127.0.0.1',
    port: 0,
    dataFile: path.join(dir, 'crm.sqlite'),
    token: 'ciclo-test',
    quiet: true,
    schedulerEnabled: false,
    whatsapp: { enabled: false },
  });
  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'ciclo-test' }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('clasificador de interés (reglas, sin IA)', () => {
  it('un saludo no es interés', () => {
    expect(classifyInterest({ text: 'Hola' })).toMatchObject({ interested: false, reason: 'cortesia' });
    expect(classifyInterest({ text: 'Buenas tardes' }).interested).toBe(false);
  });
  it('preguntar el precio de un producto sí lo es', () => {
    expect(classifyInterest({ text: '¿Cuánto cuesta el frasco de 30 cápsulas?' })).toMatchObject({
      interested: true,
      reason: 'precio_producto',
    });
  });
  it('la intención explícita de compra sí lo es', () => {
    expect(classifyInterest({ text: 'Quiero pedir dos frascos' })).toMatchObject({ interested: true, reason: 'intencion_compra' });
  });
  it('una duda de entrega NO es interés (ni debe tocar la etapa)', () => {
    expect(classifyInterest({ text: '¿Dónde está mi pedido?' })).toMatchObject({ interested: false, reason: 'soporte_pedido' });
    expect(classifyInterest({ text: 'mi pedido no ha llegado y ya van 2 días' }).interested).toBe(false);
  });
  it('la negación manda sobre la palabra clave', () => {
    expect(classifyInterest({ text: 'no me interesa, gracias' })).toMatchObject({ interested: false, reason: 'negacion' });
  });
  it('un mensaje ambiguo no asciende y queda para revisión', () => {
    expect(classifyInterest({ text: 'tienen disponible?' })).toMatchObject({ interested: false, review: true });
  });
  it('las fotos y audios no se clasifican por texto', () => {
    expect(classifyInterest({ type: 'image', text: 'foto' })).toMatchObject({ interested: false, reason: 'no_texto' });
  });
});

describe('etapa derivada (función pura)', () => {
  const pedido = (status, extra = {}) => ({ type: 'order_intent', status, ...extra });
  it('sin nada es PROSPECTO', () => {
    expect(resolveCustomerStage({ customer: {}, purchases: [] }).stage).toBe('PROSPECT');
  });
  it('una compra entregada es CLIENTE; dos son RECOMPRA', () => {
    expect(resolveCustomerStage({ purchases: [pedido('entregado')] }).stage).toBe('CUSTOMER');
    expect(resolveCustomerStage({ purchases: [pedido('entregado'), pedido('entregado')] }).stage).toBe('REPEAT_CUSTOMER');
  });
  it('un pedido abierto es INTERESADO, no CLIENTE', () => {
    for (const status of ['nuevo', 'confirmado', 'en_preparacion', 'enviado']) {
      expect(resolveCustomerStage({ purchases: [pedido(status)] }).stage).toBe('INTERESTED');
    }
  });
  it('cancelado y perdido no cuentan como compra ni como interés', () => {
    for (const status of ['cancelado', 'perdido']) {
      expect(resolveCustomerStage({ purchases: [pedido(status)] }).stage).toBe('PROSPECT');
    }
  });
  it('un mensaje de soporte no degrada a un cliente con compra', () => {
    expect(resolveCustomerStage({ customer: {}, purchases: [pedido('entregado')] }).stage).toBe('CUSTOMER');
  });
  it('el estado comercial legacy NO cambia la etapa', () => {
    const heredado = deriveCommercialState({ customer: {}, purchases: [], hasInbound: true });
    expect(heredado).toBe('EN_CONVERSACION');
    expect(resolveCustomerStage({ customer: { commercial_state: heredado }, purchases: [] }).stage).toBe('PROSPECT');
  });
});

describe('automático de punta a punta (servidor real)', () => {
  it('contacto nuevo sin mensajes → PROSPECTO', async () => {
    const { customer } = await contacto();
    expect(await etapa(customer.id)).toBe('PROSPECT');
  });

  it('saludo genérico → sigue PROSPECTO y sin evidencia de interés', async () => {
    const { customer } = await contacto();
    await escribe(customer.phone_e164, 'Hola, buenas tardes');
    expect(await etapa(customer.id)).toBe('PROSPECT');
    expect((await ficha(customer.id)).interest_at ?? null).toBeNull();
  });

  it('pregunta por un producto concreto → INTERESADO (con evidencia y fecha)', async () => {
    const { customer } = await contacto();
    await escribe(customer.phone_e164, '¿Cuánto cuesta el frasco de 30 cápsulas?');
    const fila = await ficha(customer.id);
    expect(await etapa(customer.id)).toBe('INTERESTED');
    expect(fila.interest_at).toBeTruthy();
    expect(fila.interest_reason).toBe('precio_producto');
    expect(fila.interest_source).toBe('message');
    expect(fila.interest_message_id).toBeTruthy();
  });

  it('intención clara de compra → INTERESADO', async () => {
    const { customer } = await contacto();
    await escribe(customer.phone_e164, 'Quiero pedir dos frascos');
    expect(await etapa(customer.id)).toBe('INTERESTED');
  });

  it('mensaje ambiguo → se queda PROSPECTO y se marca para revisión', async () => {
    const { customer } = await contacto();
    await escribe(customer.phone_e164, 'tienen disponible?');
    const fila = await ficha(customer.id);
    expect(await etapa(customer.id)).toBe('PROSPECT');
    expect(fila.interest_at ?? null).toBeNull();
    expect(fila.interest_review).toBe(true);
  });

  it('un mensaje genérico posterior no borra el interés ya demostrado', async () => {
    const { customer } = await contacto();
    await escribe(customer.phone_e164, '¿Cuánto cuesta el de 60?');
    await escribe(customer.phone_e164, 'ok, gracias');
    expect(await etapa(customer.id)).toBe('INTERESTED');
  });

  it('pedido creado, confirmado y enviado: INTERESADO, nunca CLIENTE', async () => {
    const { customer } = await contacto();
    const pedido = await compra(customer.phone_e164, 'nuevo');
    expect(pedido.item?.id).toBeTruthy();
    expect(await etapa(customer.id)).toBe('INTERESTED');
    await cambiarEstado(pedido.item.id, 'confirmado');
    expect(await etapa(customer.id)).toBe('INTERESTED');
    await cambiarEstado(pedido.item.id, 'enviado');
    expect(await etapa(customer.id)).toBe('INTERESTED');
  });

  it('primera entrega → CLIENTE; segunda entrega distinta → RECOMPRA', async () => {
    const { customer } = await contacto();
    const uno = await compra(customer.phone_e164, 'nuevo');
    await entregar(uno.item.id);
    expect(await etapa(customer.id)).toBe('CUSTOMER');
    const dos = await compra(customer.phone_e164, 'nuevo');
    await entregar(dos.item.id);
    expect(await etapa(customer.id)).toBe('REPEAT_CUSTOMER');
  });

  it('repetir el evento de entrega del MISMO pedido no asciende otra vez', async () => {
    const { customer } = await contacto();
    const uno = await compra(customer.phone_e164, 'nuevo');
    await entregar(uno.item.id);
    await entregar(uno.item.id);
    await entregar(uno.item.id);
    const fila = await ficha(customer.id);
    expect(await etapa(customer.id)).toBe('CUSTOMER');
    expect(Number(fila.total_purchases ?? 0)).toBeLessThanOrEqual(1);
  });

  it('un pedido cancelado no cuenta como compra', async () => {
    const { customer } = await contacto();
    const uno = await compra(customer.phone_e164, 'nuevo');
    await entregar(uno.item.id);
    const dos = await compra(customer.phone_e164, 'nuevo');
    await cambiarEstado(dos.item.id, 'cancelado');
    expect(await etapa(customer.id)).toBe('CUSTOMER');
  });

  it('una venta ENTREGADA no se revierte con un cambio simple: 409 y la etapa no cambia', async () => {
    const { customer } = await contacto();
    const uno = await compra(customer.phone_e164, 'nuevo');
    await entregar(uno.item.id);
    expect(await etapa(customer.id)).toBe('CUSTOMER');
    /*
     * REGLA CONTABLE REAL del CRM: `entregado` es un hecho y solo se deshace con
     * la reversión protegida de la factura, no con un PATCH de estado. Si algún
     * día una reversión deja el pedido en otro estado, la etapa se recalcula
     * sola (es derivada) sin reescribir el pedido ni su historial.
     */
    const intento = await cambiarEstado(uno.item.id, 'cancelado');
    expect(intento.status).toBe(409);
    expect((await intento.json()).error).toBe('delivered_reversal_required');
    expect(await etapa(customer.id)).toBe('CUSTOMER');
    const orden = (await app.store.listAdmin({ limit: 500 })).find((row) => row.id === uno.item.id);
    expect(orden.status).toBe('entregado');
  });

  it('archivar, finalizar y reabrir la conversación no cambian la etapa', async () => {
    const { customer, conversation } = await escribe(telefono(), 'Hola, quiero información de un producto').then((r) => ({
      customer: r.customer,
      conversation: r.conversation,
    }));
    expect(await etapa(customer.id)).toBe('INTERESTED');
    await call(`/api/admin/conversations/${conversation.id}/archive`, { method: 'POST' });
    expect(await etapa(customer.id)).toBe('INTERESTED');
    await call(`/api/admin/conversations/${conversation.id}/unarchive`, { method: 'POST' });
    await call(`/api/admin/conversations/${conversation.id}/resolve`, { method: 'POST' });
    expect(await etapa(customer.id)).toBe('INTERESTED');
    await call(`/api/admin/conversations/${conversation.id}/reopen`, { method: 'POST' });
    expect(await etapa(customer.id)).toBe('INTERESTED');
  });

  it('programar un seguimiento no cambia la etapa', async () => {
    const { customer } = await contacto();
    const alta = await call('/api/admin/followups', {
      method: 'POST',
      body: JSON.stringify({ customerId: customer.id, type: 'checkin', scheduledAt: new Date(Date.now() + 86400000).toISOString() }),
    });
    expect([200, 201]).toContain(alta.status);
    expect(await etapa(customer.id)).toBe('PROSPECT');
  });

  it('Cliente y Recompra no se pueden poner a mano', async () => {
    const { customer } = await contacto();
    const uno = await app.customers.setCustomerStage(customer.id, 'CUSTOMER');
    expect(uno.ok).toBe(false);
    expect(uno.error).toBe('not_manual');
    const dos = await app.customers.setCustomerStage(customer.id, 'REPEAT_CUSTOMER');
    expect(dos.ok).toBe(false);
  });

  it('una etiqueta manual antigua se respeta y queda en el historial', async () => {
    const { customer } = await contacto();
    const cambio = await app.customers.setCustomerStage(customer.id, 'INTERESTED', { reason: 'lo dijo por teléfono' });
    expect(cambio.ok).toBe(true);
    expect(await etapa(customer.id)).toBe('INTERESTED');
    const historial = await app.customers.stageHistory(customer.id);
    expect(historial.length).toBe(1);
    expect(historial[0]).toMatchObject({ from_stage: 'PROSPECT', to_stage: 'INTERESTED' });
    // Y sigue mandando aunque luego escriba un mensaje genérico.
    await escribe(customer.phone_e164, 'hola');
    expect(await etapa(customer.id)).toBe('INTERESTED');
  });

  it('no se puede degradar a quien ya compró', async () => {
    const { customer } = await contacto();
    const uno = await compra(customer.phone_e164, 'nuevo');
    await entregar(uno.item.id);
    const intento = await app.customers.setCustomerStage(customer.id, 'PROSPECT');
    expect(intento.ok).toBe(false);
    expect(intento.error).toBe('completed_purchase_stage_conflict');
    expect(await etapa(customer.id)).toBe('CUSTOMER');
  });

  it('la etapa sobrevive al reinicio del servidor', async () => {
    const { customer } = await contacto();
    await escribe(customer.phone_e164, 'quiero comprar un frasco de 60');
    expect(await etapa(customer.id)).toBe('INTERESTED');
    const dataFile = path.join(dir, 'crm.sqlite');
    await app.close();
    app = await startCrmServer({
      host: '127.0.0.1',
      port: 0,
      dataFile,
      token: 'ciclo-test',
      quiet: true,
      schedulerEnabled: false,
      whatsapp: { enabled: false },
    });
    const login = await fetch(`${app.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'ciclo-test' }),
    });
    cookie = login.headers.get('set-cookie').split(';')[0];
    expect(await etapa(customer.id)).toBe('INTERESTED');
  });

  it('dos entregas simultáneas del mismo cliente dan RECOMPRA exactamente', async () => {
    const { customer } = await contacto();
    const uno = await compra(customer.phone_e164, 'nuevo');
    const dos = await compra(customer.phone_e164, 'nuevo');
    await Promise.all([entregar(uno.item.id), entregar(dos.item.id)]);
    expect(await etapa(customer.id)).toBe('REPEAT_CUSTOMER');
    const fila = await ficha(customer.id);
    expect(Number(fila.total_purchases ?? 0)).toBe(2);
  });

  it('sin proveedor de IA la clasificación funciona igual (0 llamadas)', async () => {
    const { customer } = await contacto();
    // El servidor arranca SIN credenciales de DeepSeek: nada de esto puede fallar.
    const r = await escribe(customer.phone_e164, '¿cuánto vale el frasco de 60 cápsulas?');
    expect(r.ok).toBe(true);
    expect(await etapa(customer.id)).toBe('INTERESTED');
  });

  it('un repartidor (sin clients.read) no ve la lista de clientes', async () => {
    const creado = await json('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'sinclientes@test.local', password: 'Sin-Clientes-12345', displayName: 'Sin clientes', role: 'DELIVERY' }),
    });
    expect(creado.user?.id).toBeTruthy();
    const login = await fetch(`${app.url}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: creado.user.username, password: 'Sin-Clientes-12345' }),
    });
    const suCookie = login.headers.get('set-cookie').split(';')[0];
    const respuesta = await fetch(`${app.url}/api/admin/customers`, { headers: { cookie: suCookie } });
    expect([401, 403]).toContain(respuesta.status);
    const sinSesion = await fetch(`${app.url}/api/admin/customers`);
    expect(sinSesion.status).toBe(401);
  });
});
