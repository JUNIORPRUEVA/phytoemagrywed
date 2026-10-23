/**
 * UAT — DESTINATARIO DEL ESCALADO Y FALTA DE TELÉFONO.
 *
 * Comprueba, con WhatsApp simulado y reloj controlado:
 *   1. El escalado de T+30 va al contacto de administración CONFIGURADO, con la
 *      plantilla aprobada y sus 3 parámetros en el orden real (pedido, delivery,
 *      enlace al panel).
 *   2. También deja aviso interno a las cuentas ADMIN (campana).
 *   3. Un repartidor SIN teléfono NO inventa número: se escala una sola vez con
 *      el motivo `courier_without_phone`, el pedido aparece en «sin teléfono» y
 *      no se envía nada a un número que no existe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'escalado-token';
const ADMIN = { username: 'admin.escalado', password: 'AdminEscalado-12345', name: 'Ana Escalado' };
const CUSTOMER_PHONE = '18095559051';
const ADMIN_CONTACT = { name: 'Jefa de Operaciones', phone: '809 555 9999' };
const ADMIN_CONTACT_E164 = '+18095559999';
const COURIER_OK = { username: 'ok.reparto@local', password: 'Reparto-12345', name: 'Luis Con Teléfono', phone: '809 555 1666' };
const COURIER_OK_E164 = '+18095551666';
const COURIER_SIN = { username: 'sin.reparto@local', password: 'Reparto-12345', name: 'Marta Sin Teléfono' };

let tmpDir;
let app;
let cookie = '';
let courierOkId = '';
let courierSinId = '';
let now = new Date('2026-10-22T13:00:00.000Z'); // 09:00 en RD

const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-ESC',
  businessAccountId: 'WABA-ESC',
  sent: [],
  async sendText(to, body) {
    whatsapp.sent.push({ to, body, type: 'text' });
    return { ok: true, messageId: `wamid.ESC_T_${whatsapp.sent.length}` };
  },
  async sendTemplate(to, template) {
    whatsapp.sent.push({ to, template, type: 'template' });
    return { ok: true, messageId: `wamid.ESC_TPL_${whatsapp.sent.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

const api = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { cookie, 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
const json = async (response) => JSON.parse(await response.text());
const avanzar = (minutes) => {
  now = new Date(now.getTime() + minutes * 60 * 1000);
};
const pasada = async () => {
  const response = await api('/api/admin/delivery-supervisor/run', { method: 'POST' });
  expect(response.status).toBe(200);
  return json(response);
};
const eventos = async () => app.collections.list('delivery_supervision_events', { limit: 1000 });

async function crearPedido(nombre) {
  return json(
    await api('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        phone: CUSTOMER_PHONE,
        name: nombre,
        paymentMethod: 'CASH',
        items: [{ variantId: 'capsules_10', quantity: 1 }],
        deliveryLocation: { latitude: 18.6157, longitude: -68.7071, address: 'Calle Duarte 45' },
        deliveryFee: 250,
      }),
    }),
  );
}

async function aprobarPlantilla(name, variables) {
  const body = variables.map((_, index) => `{{${index + 1}}}`).join(' · ');
  const response = await api('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({ name, status: 'APPROVED', body, variables, lastSyncedAt: now.toISOString(), lastTemplateSyncAt: now.toISOString() }),
  });
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-escalado-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'escalado.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
    clock: () => now,
    whatsapp,
    bootstrapAdminUser: ADMIN.username,
    bootstrapAdminPassword: ADMIN.password,
    bootstrapAdminDisplayName: ADMIN.name,
  });

  const login = await fetch(`${app.url}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password }),
  });
  expect(login.status).toBe(200);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  for (const courier of [COURIER_OK, COURIER_SIN]) {
    const creado = await json(
      await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ username: courier.username, password: courier.password, displayName: courier.name, role: 'DELIVERY' }),
      }),
    );
    if (courier.phone) {
      courierOkId = creado.user.id;
      const conNumero = await api(`/api/admin/users/${courierOkId}`, { method: 'PATCH', body: JSON.stringify({ personalPhone: courier.phone }) });
      expect(conNumero.status).toBe(200);
    } else {
      courierSinId = creado.user.id;
    }
  }

  /* Contacto de administración: es a QUIEN se escala. */
  await app.ctx.settings.write('delivery_control', {
    deliveryReminderMinutes: 10,
    deliveryAdminEscalationMinutes: 60,
    deliveryAdminEscalationContacts: [{ name: ADMIN_CONTACT.name, phone: ADMIN_CONTACT.phone }],
  });

  const ajustes = await api('/api/admin/delivery-supervisor/settings', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, activatedAt: '2026-10-22T12:00:00.000Z' }),
  });
  expect(ajustes.status).toBe(200);

  const stock = await api('/api/admin/inventory/restock', {
    method: 'POST',
    body: JSON.stringify({ quantity: 120, unitCost: '126.66', reason: 'Inventario UAT escalado' }),
  });
  expect(stock.status).toBe(201);

  await aprobarPlantilla('phyto_pedido_repartidor_v1', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  await aprobarPlantilla('phyto_supervisor_recordatorio_v1', ['a', 'b', 'c']);
  await aprobarPlantilla('phyto_delivery_sin_atender_admin_v1', ['a', 'b', 'c']);
}, 90_000);

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('escalado del supervisor', () => {
  it('T+30 avisa al contacto de administración configurado, con sus 3 parámetros', async () => {
    const pedido = await crearPedido('Cliente Escalado');
    const asignado = await api(`/api/admin/orders/${pedido.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: courierOkId }),
    });
    expect(asignado.status).toBe(200);

    /* T+0 sin WhatsApp; T+5 primer aviso; T+30 escalado. */
    expect(whatsapp.sent.length).toBe(0);
    avanzar(5);
    await pasada();
    expect(whatsapp.sent.some((row) => row.to === COURIER_OK_E164), `enviados: ${whatsapp.sent.map((row) => `${row.to}:${row.type}`).join(', ')}`).toBe(true);
    avanzar(25);
    await pasada();

    const alAdmin = whatsapp.sent.filter((row) => row.to === ADMIN_CONTACT_E164);
    expect(alAdmin.length, 'se escribe al contacto configurado, no a un número inventado').toBe(1);
    const plantilla = alAdmin[0].template;
    expect(plantilla.name).toBe('phyto_delivery_sin_atender_admin_v1');
    const parametros = plantilla.components?.[0]?.parameters ?? [];
    expect(parametros).toHaveLength(3);
    expect(parametros[0].text).toBe(pedido.order.order_number);
    expect(parametros[1].text).toContain('Luis Con Teléfono');
    expect(parametros[2].text).toContain('/admin/?v=delivery&order=');

    /* Aviso interno a administración (campana), además del WhatsApp. */
    const avisos = await app.collections.list('user_notifications', { limit: 200 });
    expect(avisos.some((row) => row.type === 'DELIVERY_SUPERVISOR_ESCALATION')).toBe(true);

    /* Y queda en el chat del pedido como hecho del sistema. */
    const chats = await json(await api('/api/admin/ops/chats'));
    const chat = (chats.chats ?? []).find((row) => String(row.orderId) === String(pedido.item.id));
    expect(chat).toBeTruthy();
    const mensajes = (await app.collections.list('ops_ticket_messages', { limit: 500 })).filter(
      (row) => String(row.ticket_id) === String(chat.ticketId),
    );
    expect(mensajes.some((row) => row.meta?.direction === 'system' && String(row.body).includes('Escalado a administración'))).toBe(true);
  }, 60_000);

  it('un repartidor SIN teléfono no inventa número: se escala una vez con su motivo', async () => {
    const antes = whatsapp.sent.length;
    const pedido = await crearPedido('Cliente Sin Teléfono');
    const asignado = await api(`/api/admin/orders/${pedido.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: courierSinId }),
    });
    expect(asignado.status).toBe(200);

    avanzar(2);
    await pasada();

    /* Nada se envía a un teléfono que no existe: solo puede salir a administración. */
    const nuevos = whatsapp.sent.slice(antes);
    expect(nuevos.every((row) => row.to === ADMIN_CONTACT_E164)).toBe(true);

    const escalados = (await eventos()).filter((row) => row.order_id === pedido.item.id && row.kind === 'escalation');
    expect(escalados).toHaveLength(1);
    expect(escalados[0].data?.reason).toBe('courier_without_phone');
    expect(String(escalados[0].detail ?? '')).toContain('sin teléfono');

    /* El pedido se ve en «sin teléfono» del estado del supervisor. */
    const estado = await json(await api('/api/admin/delivery-supervisor'));
    expect(estado.without_phone?.total).toBeGreaterThanOrEqual(1);
    const fila = (estado.buckets?.sin_iniciar ?? [])
      .concat(estado.buckets?.sin_respuesta ?? [], estado.buckets?.incidencias ?? [])
      .find((row) => String(row.id) === String(pedido.item.id));
    expect(fila, `estado: ${JSON.stringify(estado.counts)}`).toBeTruthy();
    expect(fila.has_phone).toBe(false);
  }, 60_000);
});
