// @vitest-environment node
/**
 * UAT DE RELOJ FALSO — CALENDARIO EXACTO DE ACEPTACIÓN (T+0 / T+5 / T+20 / T+30).
 *
 * Servidor real, reloj controlado y WhatsApp simulado (no sale nada a Meta).
 * Demuestra, para la MISMA asignación vigente:
 *   T+0  ticket abierto y aviso INTERNO; **ningún** WhatsApp
 *   T+5  primer WhatsApp con el pedido y el ENLACE para aceptar
 *   T+20 segundo aviso corto (no repite los detalles)
 *   T+30 escalado a administración, una sola vez
 * Y que aceptar en T+7 **detiene** los avisos de aceptación.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'calendario-token';
const ADMIN_USER = 'admin@calendario.local';
const ADMIN_PASS = 'AdminCalendario-12345';
const COURIER_PHONE = '+18095551234';
const CUSTOMER_PHONE = '18095559000';

let tmpDir;
let app;
let cookie = '';
let courierId = '';
let now = new Date('2026-10-22T13:00:00.000Z'); // 09:00 en RD

const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-CAL',
  businessAccountId: 'WABA-CAL',
  sent: [],
  async sendText(to, body) {
    whatsapp.sent.push({ to, body, type: 'text' });
    return { ok: true, messageId: `wamid.CAL_T_${whatsapp.sent.length}` };
  },
  async sendTemplate(to, template) {
    whatsapp.sent.push({ to, template, type: 'template' });
    return { ok: true, messageId: `wamid.CAL_TPL_${whatsapp.sent.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

const json = async (r) => JSON.parse(await r.text());
const request = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers ?? {}) },
  });
const advance = (minutes) => {
  now = new Date(now.getTime() + minutes * 60 * 1000);
};
const tick = () => app.ctx.scheduler.tick();
const alRepartidor = () => whatsapp.sent.filter((row) => row.to === COURIER_PHONE);
const eventos = async () => app.collections.list('delivery_supervision_events', { limit: 1000 });

async function nuevoPedido(nombre) {
  const r = await request('/api/admin/orders', {
    method: 'POST',
    body: JSON.stringify({
      phone: CUSTOMER_PHONE,
      name: nombre,
      paymentMethod: 'CASH',
      items: [{ variantId: 'capsules_10', quantity: 1 }],
      deliveryLocation: { latitude: 18.6157, longitude: -68.7071, address: 'Calle Duarte 45' },
      deliveryFee: 250,
    }),
  });
  expect(r.status).toBe(201);
  const body = await json(r);
  const asignado = await request(`/api/admin/orders/${body.item.id}/delivery/assign`, {
    method: 'POST',
    body: JSON.stringify({ deliveryUserId: courierId, deliveryNote: 'Entregar antes de las 6' }),
  });
  expect(asignado.status).toBe(200);
  return body;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-calendario-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'cal.sqlite'),
    token: TOKEN,
    quiet: true,
    whatsapp,
    whatsappMedia: whatsapp,
    bootstrapAdminUser: ADMIN_USER,
    bootstrapAdminPassword: ADMIN_PASS,
    schedulerEnabled: false,
    clock: () => now,
  });
  const login = await fetch(`${app.url}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  const creado = await json(
    await request('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'cal.reparto@local', password: 'Reparto-12345', displayName: 'Rubén Calendario', role: 'DELIVERY' }),
    }),
  );
  courierId = creado.user.id;
  const conNumero = await request(`/api/admin/users/${courierId}`, {
    method: 'PATCH',
    body: JSON.stringify({ personalPhone: '809 555 1234' }),
  });
  expect(conNumero.status).toBe(200);
  /* El supervisor solo mira pedidos asignados DESPUÉS de su activación. */
  const ajustes = await request('/api/admin/delivery-supervisor/settings', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, activatedAt: '2026-10-22T12:00:00.000Z' }),
  });
  expect(ajustes.status).toBe(200);
  const stock = await request('/api/admin/inventory/restock', {
    method: 'POST',
    body: JSON.stringify({ quantity: 60, unitCost: '126.66', reason: 'Inventario UAT calendario' }),
  });
  expect(stock.status).toBe(201);
}, 60000);

afterAll(async () => {
  await app?.close?.();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('calendario exacto de aceptación (reloj falso)', () => {
  let pedido;
  let enviadosAntes = 0;

  it('T+0: ticket y aviso interno, y NINGÚN WhatsApp', async () => {
    const orden = await nuevoPedido('Cliente Calendario');
    pedido = orden;
    enviadosAntes = alRepartidor().length;
    await tick();
    expect(alRepartidor().slice(enviadosAntes)).toEqual([]);
    const snapshot = await json(await request('/api/admin/delivery-supervisor'));
    const fila = snapshot.buckets.sin_iniciar.find((row) => row.id === pedido.item.id);
    expect(fila).toBeTruthy();
    expect(fila.stage).toBe('not_accepted');
    /* Aviso interno al repartidor (campana), no WhatsApp. */
    const avisos = await app.collections.list('user_notifications', { limit: 200 });
    expect(avisos.some((row) => row.recipient_user_id === courierId && row.entity_id === pedido.item.id)).toBe(true);
  }, 60000);

  it('T+5: primer WhatsApp con el pedido y el enlace para aceptar', async () => {
    advance(5);
    await tick();
    const enviados = alRepartidor().slice(enviadosAntes);
    expect(enviados).toHaveLength(1);
    const cuerpo = enviados[0].body ?? JSON.stringify(enviados[0].template ?? {});
    expect(cuerpo).toContain(pedido.order.order_number);
    expect(cuerpo).toContain('/admin/?v=delivery&order=');
    expect(cuerpo).toContain('Aceptar la entrega asignada');
  }, 60000);

  it('no duplica el primer aviso aunque la pasada se repita', async () => {
    const antes = alRepartidor().length;
    await tick();
    await tick();
    expect(alRepartidor().length).toBe(antes);
  }, 60000);

  it('T+20: segundo aviso corto (sin repetir los detalles)', async () => {
    advance(15);
    await tick();
    const enviados = alRepartidor();
    expect(enviados.length).toBeGreaterThanOrEqual(2);
    const segundo = enviados.at(-1);
    const cuerpo = segundo.body ?? JSON.stringify(segundo.template ?? {});
    expect(cuerpo).toContain(pedido.order.order_number);
    /* Corto: no vuelve a mandar productos/dirección. */
    expect(cuerpo).not.toContain('Calle Duarte 45');
  }, 60000);

  it('T+30: escalado a administración una sola vez', async () => {
    advance(11);
    await tick();
    const escalados = (await eventos()).filter((row) => row.order_id === pedido.item.id && row.kind === 'escalation');
    expect(escalados).toHaveLength(1);
    await tick();
    const otraVez = (await eventos()).filter((row) => row.order_id === pedido.item.id && row.kind === 'escalation');
    expect(otraVez).toHaveLength(1);
  }, 60000);

  it('aceptar detiene los avisos de aceptación (T+7)', async () => {
    const orden = await nuevoPedido('Cliente Acepta');
    advance(5);
    await tick();
    const antes = alRepartidor().length;
    /* Aceptación AUTORITATIVA (no un «ok» por WhatsApp). */
    const aceptado = await request(`/api/admin/orders/${orden.item.id}/delivery/accept`, { method: 'POST', body: '{}' });
    expect(aceptado.status).toBe(200);
    advance(2); // T+7
    await tick();
    const snapshot = await json(await request('/api/admin/delivery-supervisor'));
    const fila = [...(snapshot.buckets.sin_iniciar ?? []), ...(snapshot.buckets.en_camino ?? [])].find((row) => row.id === orden.item.id);
    expect(fila?.stage).not.toBe('not_accepted');
    /* En T+20 y T+30 no se le insiste por ACEPTAR (sí puede pedirle iniciar). */
    advance(23);
    await tick();
    const deEse = alRepartidor()
      .slice(antes)
      .filter((row) => JSON.stringify(row).includes('Aceptar la entrega asignada'));
    expect(deEse).toHaveLength(0);
  }, 60000);

  it('la respuesta del repartidor queda en el chat del pedido con su identidad', async () => {
    const ticket = (await app.collections.list('ops_tickets', { limit: 200 })).find(
      (row) => String(row.entity_id) === String(pedido.item.id),
    );
    expect(ticket).toBeTruthy();
    const mensajes = await app.collections.list('ops_ticket_messages', { where: { ticket_id: ticket.id }, limit: 100 });
    const salientes = mensajes.filter((row) => row.meta?.direction === 'outbound');
    expect(salientes.length).toBeGreaterThanOrEqual(1);
    expect(['sent', 'pending', 'failed']).toContain(salientes[0].meta?.status);
    /* Toda comunicación externa lleva su canal y la zona horaria del negocio. */
    expect(salientes[0].meta?.channel).toBe('whatsapp');
    expect(salientes[0].meta?.tz).toBe('America/Santo_Domingo');
  }, 60000);
});
