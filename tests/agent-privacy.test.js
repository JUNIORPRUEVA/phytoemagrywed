// @vitest-environment node
/*
 * BLINDAJE DE PRIVACIDAD (lo pidió el negocio con estas palabras):
 *   «el agente no admin no debería de poder ver los seguimientos que se le está
 *    haciendo a un cliente que no es asignado… si puede ver las conversaciones
 *    pero no puede enviar mensaje… que pueda solicitar que se le asigne la
 *    conversación pero que él solo no lo pueda hacer».
 *
 * En este archivo se comprueba esa regla contra el servidor de verdad, no contra
 * mocks: lista sí, contenido no; nadie se auto-asigna; la petición avisa a
 * administración; y cuando administración asigna, el agente entra.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'clave-blindaje';
const APP_SECRET = 'secreto-blindaje';
const ADMIN_USER = 'ana@phyto.local';
const ADMIN_PASS = 'AnaAdmin-12345';
const PASS = 'Agente-12345';

const TELEFONOS = {
  maria: '18095557001',
  pedro: '18095557002',
  libre: '18095557003',
};

let tmpDir;
let app;
let adminCookie = '';
let mariaCookie = '';
let pedroCookie = '';
let maria = null;
let pedro = null;
/** @type {Record<string, any>} */
let conv = {};

const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-BLINDAJE',
  businessAccountId: 'WABA-BLINDAJE',
  async sendText(to, body) {
    whatsapp.sent.push({ to, body });
    return { ok: true, status: 200, messageId: `wamid.BL${whatsapp.sent.length}` };
  },
  async sendTemplate(to) {
    whatsapp.sent.push({ to });
    return { ok: true, status: 200, messageId: `wamid.BLT${whatsapp.sent.length}` };
  },
  async sendLocation(to) {
    whatsapp.sent.push({ to });
    return { ok: true, status: 200, messageId: `wamid.BLL${whatsapp.sent.length}` };
  },
  async sendInteractive() {
    return { ok: false, skipped: true };
  },
  async markAsRead() {
    return { ok: true };
  },
  sent: [],
};

const request = (route, options = {}, cookie = adminCookie) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers ?? {}) },
  });

const body = async (response) => JSON.parse(await response.text());

async function login(username, password) {
  const response = await request('/api/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }, '');
  return { response, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0], body: await body(response) };
}

async function inbound(id, from, text) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-BLINDAJE',
        changes: [
          {
            value: {
              contacts: [{ profile: { name: `Cliente ${text}` }, wa_id: from }],
              messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  return request('/api/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}` },
    body: raw,
  }, '');
}

async function esperar(fn) {
  const inicio = Date.now();
  for (;;) {
    const valor = await fn();
    if (valor) return valor;
    if (Date.now() - inicio > 5000) throw new Error('timeout esperando la conversación');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function conversacionDe(phone) {
  return esperar(async () => {
    const rows = (await body(await request('/api/admin/conversations'))).conversations;
    return rows.find((row) => row.customer?.phone_e164 === `+${phone}`);
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-blindaje-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsapp,
    schedulerEnabled: false,
    bootstrapAdminUser: ADMIN_USER,
    bootstrapAdminPassword: ADMIN_PASS,
    bootstrapAdminDisplayName: 'Ana Admin',
  });
  adminCookie = (await login(ADMIN_USER, ADMIN_PASS)).cookie;
  maria = (await body(await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'maria@phyto.local', password: PASS, displayName: 'María', role: 'AGENT' }),
  }))).user;
  pedro = (await body(await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'pedro@phyto.local', password: PASS, displayName: 'Pedro', role: 'AGENT' }),
  }))).user;
  mariaCookie = (await login('maria@phyto.local', PASS)).cookie;
  pedroCookie = (await login('pedro@phyto.local', PASS)).cookie;

  await inbound('wamid.BL-1', TELEFONOS.maria, 'Hola María');
  await inbound('wamid.BL-2', TELEFONOS.pedro, 'Hola Pedro');
  await inbound('wamid.BL-3', TELEFONOS.libre, 'Hola, nadie');
  conv.maria = await conversacionDe(TELEFONOS.maria);
  conv.pedro = await conversacionDe(TELEFONOS.pedro);
  conv.libre = await conversacionDe(TELEFONOS.libre);
  expect(conv.maria?.id && conv.pedro?.id && conv.libre?.id).toBeTruthy();

  expect((await request(`/api/admin/conversations/${conv.pedro.id}/assign`, {
    method: 'POST',
    body: JSON.stringify({ userId: pedro.id }),
  })).status).toBe(200);
  expect((await request(`/api/admin/conversations/${conv.maria.id}/assign`, {
    method: 'POST',
    body: JSON.stringify({ userId: maria.id }),
  })).status).toBe(200);
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('blindaje: el agente no admin solo entra en lo suyo', () => {
  it('ve las conversaciones en la lista, pero no puede abrir ni contestar la de otro agente', async () => {
    const lista = (await body(await request('/api/admin/conversations', {}, mariaCookie))).conversations;
    // La LISTA se ve entera (como en WhatsApp: nombre y último mensaje).
    const ids = lista.map((row) => row.id);
    expect(ids).toContain(conv.maria.id);
    expect(ids).toContain(conv.pedro.id);
    expect(ids).toContain(conv.libre.id);

    // El HILO, no: 403 con el motivo y con quién la tiene.
    const hilo = await request(`/api/admin/conversations/${conv.pedro.id}/messages`, {}, mariaCookie);
    expect(hilo.status).toBe(403);
    const detalle = await body(hilo);
    expect(detalle.error).toBe('not_your_conversation');
    expect(detalle.assigned_user_id).toBe(pedro.id);
    expect(detalle.message).toContain('Pide que te la asignen');
    expect(JSON.stringify(detalle)).not.toContain('Hola Pedro');

    // Ni marcarla leída, ni escribir.
    expect((await request(`/api/admin/conversations/${conv.pedro.id}/read`, { method: 'POST', body: '{}' }, mariaCookie)).status).toBe(403);
    whatsapp.sent = [];
    const envio = await request(`/api/admin/conversations/${conv.pedro.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'me meto donde no me llaman' }),
    }, mariaCookie);
    expect(envio.status).toBe(403);
    expect(whatsapp.sent).toHaveLength(0);

    // Y lo suyo sigue funcionando.
    expect((await request(`/api/admin/conversations/${conv.maria.id}/messages`, {}, mariaCookie)).status).toBe(200);
  });

  it('la conversación sin asignar tampoco se abre: se PIDE, y administración recibe el aviso', async () => {
    const hilo = await request(`/api/admin/conversations/${conv.libre.id}/messages`, {}, mariaCookie);
    expect(hilo.status).toBe(403);
    const detalleLibre = await body(hilo);
    expect(detalleLibre.error).toBe('not_your_conversation');
    expect(detalleLibre.message).toContain('todavía no está asignada');

    // Ni el agente ni un tercero se la quedan solos.
    expect((await request(`/api/admin/conversations/${conv.libre.id}/take`, { method: 'POST', body: '{}' }, mariaCookie)).status).toBe(403);
    expect((await request(`/api/admin/conversations/${conv.libre.id}/take`, { method: 'POST', body: '{}' }, pedroCookie)).status).toBe(403);
    expect((await body(await request(`/api/admin/conversations/${conv.libre.id}/messages`, {}, adminCookie))).conversation.assigned_user_id ?? null).toBe(null);

    const peticion = await request(`/api/admin/conversations/${conv.libre.id}/assignment-request`, { method: 'POST', body: '{}' }, mariaCookie);
    expect(peticion.status).toBe(202);
    const aviso = (await app.collections.list('user_notifications', { limit: 500 }))
      .find((row) => row.type === 'CONVERSATION_ASSIGNMENT_REQUESTED' && row.entity_id === conv.libre.id);
    expect(aviso).toBeTruthy();
    expect(aviso.recipient_user_id).not.toBe(maria.id);
    expect(aviso.data.requested_by_user_id).toBe(maria.id);
    // Sigue sin dueño: pedir no es asignarse.
    expect((await body(await request(`/api/admin/conversations/${conv.libre.id}/messages`, {}, adminCookie))).conversation.assigned_user_id ?? null).toBe(null);
  });

  it('las acciones en lote también respetan el blindaje (no se marca leído lo ajeno)', async () => {
    const respuesta = await request('/api/admin/conversations/bulk', {
      method: 'POST',
      body: JSON.stringify({ action: 'mark_read', ids: [conv.maria.id, conv.pedro.id, conv.libre.id] }),
    }, mariaCookie);
    expect(respuesta.status).toBe(200);
    const resultados = Object.fromEntries((await body(respuesta)).results.map((row) => [row.id, row]));
    expect(resultados[conv.maria.id].ok).toBe(true);
    expect(resultados[conv.pedro.id]).toMatchObject({ ok: false, error: 'not_your_conversation' });
    expect(resultados[conv.libre.id]).toMatchObject({ ok: false, error: 'not_your_conversation' });
  });

  it('los seguimientos de un cliente que no lleva son invisibles (y no se pueden programar)', async () => {
    const clienteAjeno = conv.pedro.customer.id;
    const clientePropio = conv.maria.customer.id;

    // Programar un seguimiento para el cliente de otro → 403.
    const prohibido = await request('/api/admin/followups', {
      method: 'POST',
      body: JSON.stringify({ customerId: clienteAjeno, reason: 'me entrometo', scheduledAt: '2099-01-01' }),
    }, mariaCookie);
    expect(prohibido.status).toBe(403);
    expect((await body(prohibido)).error).toBe('not_your_customer');

    // Administración sí puede crearlo para ese cliente (le asigna a Pedro).
    const ajeno = await request('/api/admin/followups', {
      method: 'POST',
      body: JSON.stringify({ customerId: clienteAjeno, reason: 'seguimiento ajeno', scheduledAt: '2099-01-01', assignedUserId: pedro.id }),
    });
    expect(ajeno.status).toBe(201);
    const ajenoId = (await body(ajeno)).followup.id;

    const propio = await request('/api/admin/followups', {
      method: 'POST',
      body: JSON.stringify({ customerId: clientePropio, reason: 'seguimiento propio', scheduledAt: '2099-01-01', assignedUserId: maria.id }),
    });
    expect(propio.status).toBe(201);
    const propioId = (await body(propio)).followup.id;

    const visibles = await body(await request('/api/admin/followups', {}, mariaCookie));
    const todos = [
      ...visibles.today, ...visibles.overdue, ...visibles.upcoming,
      ...visibles.completed, ...visibles.cancelled,
    ];
    const ids = todos.map((row) => row.id);
    expect(ids).toContain(propioId);
    expect(ids).not.toContain(ajenoId);
    expect(ids.every((id) => id !== ajenoId)).toBe(true);

    // Y administración los ve los dos (no se ha perdido nada por el camino).
    const admin = await body(await request('/api/admin/followups', {}, adminCookie));
    const idsAdmin = [
      ...admin.today, ...admin.overdue, ...admin.upcoming, ...admin.completed, ...admin.cancelled,
    ].map((row) => row.id);
    expect(idsAdmin).toContain(ajenoId);
    expect(idsAdmin).toContain(propioId);

    // Completar el de otro tampoco: es de quien lleva ese cliente.
    const completar = await request(`/api/admin/followups/${ajenoId}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'complete' }),
    }, mariaCookie);
    expect(completar.status).toBe(403);
    expect((await body(completar)).error).toBe('not_your_customer');
  });

  it('en cuanto administración la asigna, el agente ya lee y contesta (el blindaje no rompe el trabajo)', async () => {
    expect((await request(`/api/admin/conversations/${conv.libre.id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ userId: maria.id }),
    })).status).toBe(200);

    expect((await request(`/api/admin/conversations/${conv.libre.id}/messages`, {}, mariaCookie)).status).toBe(200);
    whatsapp.sent = [];
    const envio = await request(`/api/admin/conversations/${conv.libre.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Ya me la asignaron' }),
    }, mariaCookie);
    expect(envio.status).toBe(200);
    expect(whatsapp.sent.at(-1)).toMatchObject({ to: `+${TELEFONOS.libre}` });

    // Y el aviso anterior ya no aplica: es suya.
    const repetida = await request(`/api/admin/conversations/${conv.libre.id}/assignment-request`, { method: 'POST', body: '{}' }, mariaCookie);
    expect(repetida.status).toBe(409);
    expect((await body(repetida)).error).toBe('already_yours');
  });
});
