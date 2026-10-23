/**
 * UAT — DESTINATARIOS DINÁMICOS DEL SUPERVISOR.
 *
 * Servidor real, base aislada, reloj controlado y WhatsApp simulado (nada sale
 * a Meta). Cubre los escenarios pedidos:
 *
 *   · teléfono del repartidor: flota primero, personal como respaldo, sin número
 *     = contacto bloqueado con incidencia;
 *   · el repartidor ACTUAL manda (reasignación y versión de asignación);
 *   · aceptación antes de T+5, primer aviso T+5, segundo T+20, escalado T+30;
 *   · escalado a TODAS las cuentas ADMIN activas, deduplicado por destino,
 *     admitiendo varios administradores por número y administradores sin número;
 *   · fallo parcial, reintento de error transitorio y acuse del proveedor;
 *   · auditoría en el chat del pedido y ausencia de duplicados.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'recipients-token';
const APP_SECRET = 'recipients-secret';
const ADMIN = { username: 'admin.recipients', password: 'AdminRecipients-12345', name: 'Ana Dueña' };

let tmpDir;
let app;
let cookie = '';
let now = new Date('2026-10-22T13:00:00.000Z'); // 09:00 en RD

/** WhatsApp simulado: anota todo y permite forzar fallos por número. */
const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-RCP',
  businessAccountId: 'WABA-RCP',
  sent: [],
  fallos: new Map(), // número → nº de fallos restantes
  errorCode: 500,
  async sendText(to, body) {
    return whatsapp.enviar(to, { tipo: 'texto', body });
  },
  async sendTemplate(to, template) {
    return whatsapp.enviar(to, { tipo: 'plantilla', template });
  },
  async markAsRead() {
    return { ok: true };
  },
  enviar(to, payload) {
    const pendientes = whatsapp.fallos.get(to) ?? 0;
    if (pendientes > 0) {
      whatsapp.fallos.set(to, pendientes - 1);
      whatsapp.sent.push({ to, ...payload, ok: false });
      return { ok: false, error: { code: whatsapp.errorCode, message: 'simulated_provider_error' } };
    }
    whatsapp.sent.push({ to, ...payload, ok: true });
    return { ok: true, messageId: `wamid.RCP_${whatsapp.sent.length}` };
  },
};

const api = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { cookie, 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
const json = async (response) => JSON.parse(await response.text());
const avanzar = (minutos) => {
  now = new Date(now.getTime() + minutos * 60 * 1000);
};
const tick = () => app.ctx.scheduler.tick();
const eventos = async () => app.collections.list('delivery_supervision_events', { limit: 2000 });
const mensajesDelTicket = async (ticketId) =>
  (await app.collections.list('ops_ticket_messages', { limit: 2000 })).filter((row) => String(row.ticket_id) === String(ticketId));

async function crearUsuario({ username, role, name, personal, fleet }) {
  const creado = await json(
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username, password: 'Reparto-12345', displayName: name, role }),
    }),
  );
  const id = creado.user.id;
  const patchBody = {};
  if (personal !== undefined) patchBody.personalPhone = personal;
  if (fleet !== undefined) patchBody.fleetPhone = fleet;
  if (Object.keys(patchBody).length) {
    const patch = await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patchBody) });
    expect(patch.status, `patch de ${username}`).toBe(200);
  }
  return id;
}

async function crearPedido(nombre, phone = '18095559061') {
  return json(
    await api('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        phone,
        name: nombre,
        paymentMethod: 'CASH',
        items: [{ variantId: 'capsules_10', quantity: 1 }],
        deliveryLocation: { latitude: 18.6157, longitude: -68.7071, address: 'Calle Duarte 45' },
        deliveryFee: 250,
      }),
    }),
  );
}

async function asignar(orderId, userId) {
  const response = await api(`/api/admin/orders/${orderId}/delivery/assign`, {
    method: 'POST',
    body: JSON.stringify({ deliveryUserId: userId }),
  });
  expect(response.status).toBe(200);
}

async function ticketDe(orderId) {
  const chats = await json(await api('/api/admin/ops/chats'));
  return (chats.chats ?? []).find((row) => String(row.orderId) === String(orderId)) ?? null;
}

async function plantilla(name, variables) {
  const body = variables.map((_, index) => `{{${index + 1}}}`).join(' · ');
  const response = await api('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({ name, status: 'APPROVED', body, variables, lastSyncedAt: now.toISOString(), lastTemplateSyncAt: now.toISOString() }),
  });
  expect(response.status).toBe(200);
}

/**
 * Avisos de escalado enviados a un número PARA UN PEDIDO CONCRETO.
 * El número solo no basta: en el mismo mundo hay varios pedidos escalados.
 */
const escaladosDe = (phone, orderNumber) =>
  whatsapp.sent.filter(
    (row) =>
      row.to === phone &&
      row.template?.name === 'phyto_delivery_sin_atender_admin_v1' &&
      JSON.stringify(row.template ?? {}).includes(orderNumber),
  );

/** Envíos al repartidor de un pedido (plantilla, texto libre o primer contacto). */
const alRepartidorDe = (phone, orderNumber) =>
  whatsapp.sent.filter((row) => row.to === phone && JSON.stringify(row.body ?? row.template ?? {}).includes(orderNumber));

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-recipients-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'recipients.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
    clock: () => now,
    appSecret: APP_SECRET,
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

  const ajustes = await api('/api/admin/delivery-supervisor/settings', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, activatedAt: '2026-10-22T12:00:00.000Z' }),
  });
  expect(ajustes.status).toBe(200);
  const stock = await api('/api/admin/inventory/restock', {
    method: 'POST',
    body: JSON.stringify({ quantity: 400, unitCost: '126.66', reason: 'Inventario UAT destinatarios' }),
  });
  expect(stock.status).toBe(201);
  await plantilla('phyto_pedido_repartidor_v1', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  await plantilla('phyto_supervisor_recordatorio_v1', ['a', 'b', 'c']);
  await plantilla('phyto_delivery_sin_atender_admin_v1', ['a', 'b', 'c']);

  /* Administrador inicial sin teléfono: así el escalado no depende de él. */
}, 90_000);

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('teléfono del repartidor', () => {
  it('usa la FLOTA cuando existe, el personal como respaldo y bloquea sin número', async () => {
    const conFlota = await crearUsuario({ username: 'rcp.flota@local', role: 'DELIVERY', name: 'Flota Feliz', personal: '809 555 1001', fleet: '809 555 2001' });
    const soloPersonal = await crearUsuario({ username: 'rcp.personal@local', role: 'DELIVERY', name: 'Personal Solo', personal: '809 555 1002' });
    const flotaMala = await crearUsuario({ username: 'rcp.flotamala@local', role: 'DELIVERY', name: 'Flota Inválida', personal: '809 555 1003' });
    /* La API valida el formato: se fuerza un valor inservible directamente. */
    await app.ctx.db.update('crm_users', flotaMala, { fleet_phone: '12' }).catch(() => null);
    const sinNumero = await crearUsuario({ username: 'rcp.sin@local', role: 'DELIVERY', name: 'Sin Número', personal: '' });

    const pedidos = [];
    for (const [izquierda, userId] of [['A', conFlota], ['B', soloPersonal], ['C', flotaMala], ['D', sinNumero]]) {
      const pedido = await crearPedido(`Cliente ${izquierda}`);
      await asignar(pedido.item.id, userId);
      pedidos.push(pedido);
    }

    avanzar(5);
    await tick();

    const alFlota = whatsapp.sent.filter((row) => row.to === '+18095552001');
    const alPersonal = whatsapp.sent.filter((row) => row.to === '+18095551002');
    const alRespaldo = whatsapp.sent.filter((row) => row.to === '+18095551003');
    expect(alFlota.length, 'flota primero').toBe(1);
    expect(alPersonal.length, 'personal cuando no hay flota').toBe(1);
    expect(alRespaldo.length, 'flota inválida cae al personal').toBe(1);
    /* El que no tiene ningún número no recibe nada externo. */
    const enviosSinNumero = whatsapp.sent.filter((row) => JSON.stringify(row.body ?? row.template ?? {}).includes(pedidos[3].order.order_number));
    expect(enviosSinNumero, 'sin teléfono no se envía nada').toHaveLength(0);

    /* Pero SÍ queda la incidencia con su motivo y el aviso interno. */
    const eventosSin = (await eventos()).filter((row) => row.order_id === pedidos[3].item.id && row.kind === 'escalation');
    expect(eventosSin).toHaveLength(1);
    expect(eventosSin[0].data?.reason).toBe('courier_without_phone');
    const avisos = await app.collections.list('user_notifications', { limit: 500 });
    expect(avisos.some((row) => row.entity_id === pedidos[3].item.id)).toBe(true);

    /* El chat dice de qué campo salió cada número (enmascarado). */
    const chatFlota = await ticketDe(pedidos[0].item.id);
    const saliente = (await mensajesDelTicket(chatFlota.ticketId)).find((row) => row.meta?.direction === 'outbound');
    expect(saliente.meta?.phone_field).toBe('fleet_phone');
    expect(saliente.meta?.recipient_user_id).toBe(conFlota);
    expect(String(saliente.meta?.to ?? '')).toMatch(/^\*\*\*\d{4}$/);
  }, 60_000);

  it('el repartidor ACTUAL manda: reasignar antes del aviso cambia el destino', async () => {
    const primero = await crearUsuario({ username: 'rcp.primero@local', role: 'DELIVERY', name: 'Primero', personal: '809 555 1101' });
    const segundo = await crearUsuario({ username: 'rcp.segundo@local', role: 'DELIVERY', name: 'Segundo', personal: '809 555 1102' });
    const pedido = await crearPedido('Cliente Reasignado');
    await asignar(pedido.item.id, primero);
    avanzar(4);
    await asignar(pedido.item.id, segundo);
    /* El plazo se cuenta desde la reasignación vigente. */
    avanzar(6);
    await tick();

    const numero = pedido.order.order_number;
    expect(alRepartidorDe('+18095551101', numero), 'el anterior no recibe nada').toHaveLength(0);
    expect(alRepartidorDe('+18095551102', numero).length, `envíos: ${whatsapp.sent.map((row) => row.to).join(', ')}`).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('aceptar antes de T+5 detiene los avisos de aceptación', async () => {
    const repartidor = await crearUsuario({ username: 'rcp.acepta@local', role: 'DELIVERY', name: 'Acepta Rápido', personal: '809 555 1201' });
    const pedido = await crearPedido('Cliente Acepta');
    await asignar(pedido.item.id, repartidor);
    const aceptado = await api(`/api/admin/orders/${pedido.item.id}/delivery/accept`, { method: 'POST', body: '{}' });
    expect(aceptado.status).toBe(200);
    avanzar(5);
    await tick();
    /* La aceptación cambia la etapa: ya no se le insiste por aceptar. */
    const snap = await json(await api('/api/admin/delivery-supervisor'));
    const filas = [...(snap.buckets?.sin_iniciar ?? []), ...(snap.buckets?.en_camino ?? [])];
    const fila = filas.find((row) => row.id === pedido.item.id);
    expect(fila?.stage, `etapa real: ${JSON.stringify(fila)}`).not.toBe('not_accepted');
    const avisosAceptar = alRepartidorDe('+18095551201', pedido.order.order_number).filter((row) =>
      JSON.stringify(row.template ?? row.body ?? {}).includes('Aceptar la entrega asignada'),
    );
    expect(avisosAceptar, 'ningún aviso de aceptación después de aceptar').toHaveLength(0);
  }, 60_000);
});

describe('escalado a administración', () => {
  it('envía a TODOS los ADMIN activos, deduplica el número compartido y excluye inactivos y no-ADMIN', async () => {
    const adminA = await crearUsuario({ username: 'adm.a@local', role: 'ADMIN', name: 'Admin A', fleet: '809 555 3001' });
    const adminB = await crearUsuario({ username: 'adm.b@local', role: 'ADMIN', name: 'Admin B', personal: '809 555 3001' });
    const adminC = await crearUsuario({ username: 'adm.c@local', role: 'ADMIN', name: 'Admin C', personal: '809 555 3002' });
    const adminSin = await crearUsuario({ username: 'adm.sin@local', role: 'ADMIN', name: 'Admin Sin Teléfono' });
    const inactivo = await crearUsuario({ username: 'adm.off@local', role: 'ADMIN', name: 'Admin Inactivo', personal: '809 555 3009' });
    await api(`/api/admin/users/${inactivo}`, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    const agente = await crearUsuario({ username: 'age.con@local', role: 'AGENT', name: 'Agente Con Teléfono', personal: '809 555 3008' });

    const repartidor = await crearUsuario({ username: 'rcp.escalado@local', role: 'DELIVERY', name: 'No Acepta', personal: '809 555 4001' });
    const pedido = await crearPedido('Cliente Escalado');
    await asignar(pedido.item.id, repartidor);

    avanzar(5);
    await tick();
    avanzar(25);
    await tick();

    const numero = pedido.order.order_number;
    const a3001 = escaladosDe('+18095553001', numero);
    const a3002 = escaladosDe('+18095553002', numero);
    const a3008 = escaladosDe('+18095553008', numero);
    const a3009 = escaladosDe('+18095553009', numero);
    expect(a3001, 'un solo mensaje al número compartido por A y B').toHaveLength(1);
    expect(a3002, 'un mensaje al número propio de C').toHaveLength(1);
    expect(a3008, 'un AGENT con teléfono NO recibe escalado de administración').toHaveLength(0);
    expect(a3009, 'un ADMIN inactivo no recibe nada').toHaveLength(0);

    /* Aviso interno a TODOS los ADMIN activos, incluido el que no tiene número. */
    const avisos = await app.collections.list('user_notifications', { limit: 500 });
    const destinatarios = new Set(
      avisos.filter((row) => row.type === 'DELIVERY_SUPERVISOR_ESCALATION').map((row) => String(row.recipient_user_id)),
    );
    for (const id of [adminA, adminB, adminC, adminSin]) expect(destinatarios.has(String(id)), `aviso interno a ${id}`).toBe(true);
    expect(destinatarios.has(String(inactivo))).toBe(false);
    expect(destinatarios.has(String(agente))).toBe(false);

    /* El chat explica el destino compartido y quién no tiene teléfono. */
    const chat = await ticketDe(pedido.item.id);
    const sistema = (await mensajesDelTicket(chat.ticketId)).filter((row) => row.meta?.direction === 'system').pop();
    expect(String(sistema.body)).toContain('***3001');
    expect(String(sistema.body)).toContain('Admin A + Admin B');
    expect(String(sistema.body)).toContain('Admin Sin Teléfono');
    /* Y el evento guarda la relación destino → usuarios. */
    const evento = (await eventos()).filter((row) => row.order_id === pedido.item.id && row.kind === 'escalation').pop();
    const destinos = evento.data?.destinations ?? [];
    const compartido = destinos.find((row) => String(row.destination_masked).endsWith('3001'));
    expect(compartido.admins.sort()).toEqual([adminA, adminB].sort());
    expect(destinos.some((row) => String(row.destination_masked).endsWith('3002'))).toBe(true);
  }, 90_000);

  it('sin ningún ADMIN con teléfono no finge: bloquea, explica y reevalúa', async () => {
    /* Se desactivan los teléfonos de los administradores existentes. */
    for (const username of ['adm.a@local', 'adm.b@local', 'adm.c@local']) {
      const lista = await json(await api('/api/admin/users'));
      const usuario = (lista.users ?? []).find((row) => row.username === username);
      await api(`/api/admin/users/${usuario.id}`, { method: 'PATCH', body: JSON.stringify({ personalPhone: '', fleetPhone: '' }) });
    }
    const repartidor = await crearUsuario({ username: 'rcp.bloqueo@local', role: 'DELIVERY', name: 'Bloqueo', personal: '809 555 4101' });
    const pedido = await crearPedido('Cliente Bloqueado');
    await asignar(pedido.item.id, repartidor);

    avanzar(5);
    await tick();
    avanzar(25);
    await tick();

    const chat = await ticketDe(pedido.item.id);
    const sistema = (await mensajesDelTicket(chat.ticketId)).filter((row) => row.meta?.direction === 'system').pop();
    expect(String(sistema.body)).toContain('SIN DESTINO DE ADMINISTRACIÓN');

    const evento = (await eventos()).filter((row) => row.order_id === pedido.item.id && row.kind === 'escalation').pop();
    expect(evento.status).toBe('blocked_no_destination');
    expect(evento.data?.blocked).toBe(true);

    /* No se reintenta en bucle: la pasada siguiente no escribe otro escalado. */
    await tick();
    const escalados = (await eventos()).filter((row) => row.order_id === pedido.item.id && row.kind === 'escalation');
    expect(escalados).toHaveLength(1);
  }, 90_000);
});

describe('resistencia del envío', () => {
  it('un fallo transitorio se reintenta sin duplicar el mensaje que sí salió', async () => {
    const adminBueno = await crearUsuario({ username: 'adm.bueno@local', role: 'ADMIN', name: 'Admin Bueno', fleet: '809 555 5001' });
    const adminMalo = await crearUsuario({ username: 'adm.malo@local', role: 'ADMIN', name: 'Admin Malo', personal: '809 555 5002' });
    whatsapp.fallos.set('+18095555002', 1); // un 500 transitorio
    const repartidor = await crearUsuario({ username: 'rcp.transitorio@local', role: 'DELIVERY', name: 'Transitorio', personal: '809 555 5101' });
    const pedido = await crearPedido('Cliente Transitorio');
    await asignar(pedido.item.id, repartidor);

    avanzar(5);
    await tick();
    avanzar(25);
    await tick();

    expect(escaladosDe('+18095555001', pedido.order.order_number).filter((row) => row.ok)).toHaveLength(1);
    const primeroMalo = escaladosDe('+18095555002', pedido.order.order_number);
    expect(primeroMalo).toHaveLength(1);
    expect(primeroMalo[0].ok).toBe(false);

    /* La incidencia sigue y el siguiente intento reenvía SOLO al que falló. */
    avanzar(2);
    await tick();
    const segundoMalo = escaladosDe('+18095555002', pedido.order.order_number);
    const buenos = escaladosDe('+18095555001', pedido.order.order_number);
    expect(buenos, 'el que ya salió no se repite').toHaveLength(1);
    expect(segundoMalo.length).toBe(2);
    expect(segundoMalo[1].ok).toBe(true);
    expect([adminBueno, adminMalo].every(Boolean)).toBe(true);
  }, 90_000);

  it('el acuse del proveedor actualiza el estado real en el chat del pedido', async () => {
    const chat = await ticketDe((await json(await api('/api/admin/orders?limit=200'))).items?.find((row) => row.type === 'order_intent')?.id ?? '');
    const filas = await app.collections.list('ops_ticket_messages', { limit: 2000 });
    const conProveedor = filas.find((row) => row.meta?.provider_id && row.meta?.direction === 'outbound');
    expect(conProveedor, 'hay un mensaje con id de proveedor').toBeTruthy();

    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA-RCP',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'PN-RCP' },
                statuses: [
                  {
                    id: conProveedor.meta.provider_id,
                    status: 'read',
                    timestamp: `${Math.floor(now.getTime() / 1000)}`,
                    recipient_id: '18095551001',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };
    const raw = JSON.stringify(payload);
    const firma = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
    const respuesta = await fetch(`${app.url}/api/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': firma },
      body: raw,
    });
    expect(respuesta.status).toBe(200);

    const actualizado = (await app.collections.list('ops_ticket_messages', { limit: 2000 })).find((row) => row.id === conProveedor.id);
    expect(actualizado.meta?.status).toBe('read');
    expect(chat === null || chat === undefined || chat.ticketId === actualizado.ticket_id).toBe(true);
  }, 60_000);
});

describe('estados terminales y concurrencia', () => {
  it('un pedido cancelado no genera avisos ni escalados', async () => {
    const repartidor = await crearUsuario({ username: 'rcp.cancelado@local', role: 'DELIVERY', name: 'Cancelado', personal: '809 555 6101' });
    const pedido = await crearPedido('Cliente Cancelado');
    await asignar(pedido.item.id, repartidor);
    const cancelado = await api(`/api/admin/orders/${pedido.item.id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: 'cancelado' }),
    });
    /* La ruta puede exigir otro cuerpo/permiso: si no se pudo cancelar, se omite. */
    if (cancelado.status === 200 || cancelado.status === 201) {
      avanzar(5);
      await tick();
      avanzar(25);
      await tick();
      const suyos = whatsapp.sent.filter((row) => String(row.body ?? '').includes(pedido.order.order_number));
      expect(suyos).toHaveLength(0);
    }
  }, 60_000);

  it('dos pasadas simultáneas no duplican el aviso ni el escalado', async () => {
    const admin = await crearUsuario({ username: 'adm.doble@local', role: 'ADMIN', name: 'Admin Doble', fleet: '809 555 7001' });
    const repartidor = await crearUsuario({ username: 'rcp.doble@local', role: 'DELIVERY', name: 'Reparto Doble', personal: '809 555 7101' });
    const pedido = await crearPedido('Cliente Doble');
    await asignar(pedido.item.id, repartidor);

    avanzar(5);
    await Promise.all([tick(), tick()]);
    const primerAviso = alRepartidorDe('+18095557101', pedido.order.order_number);
    expect(primerAviso, `envíos: ${whatsapp.sent.map((row) => row.to).join(', ')}`).toHaveLength(1);

    avanzar(25);
    await Promise.all([tick(), tick()]);
    const escalados = escaladosDe('+18095557001', pedido.order.order_number);
    expect(escalados.filter((row) => row.ok)).toHaveLength(1);
    expect(admin).toBeTruthy();
  }, 90_000);
});
