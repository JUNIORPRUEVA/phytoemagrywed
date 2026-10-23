/**
 * UAT — PRUEBA DE WHATSAPP AL PROPIO ADMINISTRADOR (un solo mensaje).
 *
 * Verifica el endpoint `POST /api/admin/ops/whatsapp/self-test`:
 *   · exige confirmación explícita y permiso de administración;
 *   · el destino sale de la FICHA del administrador (flota primero);
 *   · envía UN mensaje y lo deja en Centro IA → Chats con su estado real;
 *   · la segunda llamada del día NO reenvía (anti-duplicado);
 *   · sin teléfono en la ficha responde con el motivo exacto.
 *
 * WhatsApp simulado: nada sale a Meta.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'self-test-token';
const ADMIN = { username: 'admin.selftest', password: 'AdminSelfTest-12345', name: 'Ana Prueba' };
const ADMIN_PHONES = { personalPhone: '809 555 9001', fleetPhone: '809 555 9002' };

let tmpDir;
let app;
let cookie = '';
let adminId = '';

const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-SELF',
  businessAccountId: 'WABA-SELF',
  sent: [],
  async sendText(to, body) {
    whatsapp.sent.push({ to, body, type: 'text' });
    return { ok: true, messageId: `wamid.SELF_${whatsapp.sent.length}` };
  },
  async sendTemplate(to, template) {
    whatsapp.sent.push({ to, template, type: 'template' });
    return { ok: true, messageId: `wamid.SELF_TPL_${whatsapp.sent.length}` };
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

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-self-test-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'self.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
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
  const lista = await json(await api('/api/admin/users'));
  adminId = lista.users.find((row) => row.username === ADMIN.username).id;
}, 90_000);

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('prueba de WhatsApp al propio administrador', () => {
  it('sin confirmación explícita no envía nada', async () => {
    const respuesta = await api('/api/admin/ops/whatsapp/self-test', { method: 'POST', body: JSON.stringify({}) });
    expect(respuesta.status).toBe(422);
    expect(whatsapp.sent).toHaveLength(0);
  });

  it('sin teléfono en la ficha lo dice y no inventa número', async () => {
    const respuesta = await api('/api/admin/ops/whatsapp/self-test', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    expect(respuesta.status).toBe(409);
    const cuerpo = await json(respuesta);
    expect(cuerpo.error).toBe('no_admin_phone');
    expect(whatsapp.sent).toHaveLength(0);
  });

  it('con flota y personal usa la FLOTA y registra el mensaje en Chats', async () => {
    const patch = await api(`/api/admin/users/${adminId}`, { method: 'PATCH', body: JSON.stringify(ADMIN_PHONES) });
    expect(patch.status).toBe(200);

    const respuesta = await api('/api/admin/ops/whatsapp/self-test', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    const cuerpo = await json(respuesta);
    expect(respuesta.status, JSON.stringify(cuerpo)).toBe(200);
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.status).toBe('sent');
    expect(cuerpo.phone_field).toBe('fleet_phone');
    expect(String(cuerpo.to)).toMatch(/^\*\*\*\d{4}$/);
    expect(cuerpo.reference).toMatch(/^SUPERVISOR-TEST-\d{8}$/);
    expect(cuerpo.messageId).toBeTruthy();

    /* Un solo mensaje, al número de flota, con el texto aprobado. */
    expect(whatsapp.sent).toHaveLength(1);
    expect(whatsapp.sent[0].to).toBe('+18095559002');
    expect(whatsapp.sent[0].body).toContain('Prueba del Supervisor IA Delivery de PHYTOEMAGRY');

    /* Aparece en Centro IA → Chats, con estado del proveedor y hora de RD. */
    const chats = await json(await api('/api/admin/ops/chats'));
    const chat = (chats.chats ?? []).find((row) => String(row.ticketId) === String(cuerpo.ticketId));
    expect(chat, 'el chat de prueba aparece en la lista').toBeTruthy();
    expect(String(chat.title)).toBe(cuerpo.reference);

    const detalle = await json(await api(`/api/admin/ops/tickets/${cuerpo.ticketId}`));
    const mensaje = (detalle.messages ?? []).find((row) => row.meta?.kind === 'self_test');
    expect(mensaje).toBeTruthy();
    expect(mensaje.meta.channel).toBe('whatsapp');
    expect(mensaje.meta.direction).toBe('outbound');
    expect(mensaje.meta.status).toBe('sent');
    expect(mensaje.meta.provider_id).toBe(cuerpo.messageId);
    expect(mensaje.meta.phone_field).toBe('fleet_phone');
    expect(mensaje.meta.recipient_user_id).toBe(adminId);
    expect(mensaje.meta.tz).toBe('America/Santo_Domingo');
  }, 60_000);

  it('la segunda llamada del día no reenvía (anti-duplicado)', async () => {
    const antes = whatsapp.sent.length;
    const respuesta = await api('/api/admin/ops/whatsapp/self-test', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    expect(respuesta.status).toBe(409);
    const cuerpo = await json(respuesta);
    expect(cuerpo.duplicate).toBe(true);
    expect(whatsapp.sent.length).toBe(antes);
  }, 60_000);
});
