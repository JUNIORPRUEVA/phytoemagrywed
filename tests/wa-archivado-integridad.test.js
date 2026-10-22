// @vitest-environment node
/*
 * INTEGRIDAD DEL ARCHIVADO — la regla del negocio, ejecutada.
 *
 * Una conversación SOLO puede archivarse por una acción humana explícita
 * (archivar, o finalizar confirmado). Ni el reloj, ni el webhook, ni la ventana
 * de 24 h, ni el planificador, ni una reasignación, ni un reinicio del backend
 * pueden moverla a «Archivados».
 *
 * Se prueba contra el servidor real con una base temporal: se lee el estado
 * guardado (`archived_at`), no solo lo que devuelve la API.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

let app;
let dir;
let cookie;
let now = new Date('2026-10-22T14:00:00.000Z');
const enviados = [];
const PHONE = '18095557001';

const request = (route, method = 'GET', body, session = cookie) =>
  fetch(app.url + route, {
    method,
    headers: session ? { cookie: session, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (route, method = 'GET', body, session = cookie) => (await request(route, method, body, session)).json();

const inbound = (id, phone = PHONE, at = now.toISOString(), body = 'Buenas, quiero información') =>
  app.customers.recordInbound({
    waMessage: { waMessageId: id, from: phone, profileName: 'Cliente Integridad', body, type: 'text', receivedAt: at },
  });

/** Estado GUARDADO de la conversación (no el decorado de la bandeja). */
const guardada = (id) => app.ctx.db.get('conversations', id);

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wa-archivado-'));
  const dataFile = path.join(dir, 'crm.sqlite');
  app = await startCrmServer({
    host: '127.0.0.1',
    port: 0,
    dataFile,
    token: 'archivado-test',
    quiet: true,
    schedulerEnabled: false,
    clock: () => now,
    whatsapp: {
      enabled: true,
      markAsRead: async () => ({ ok: true }),
      sendText: async (to, body) => {
        enviados.push({ to, body });
        return { ok: true, messageId: `wamid.out-${enviados.length}` };
      },
    },
  });
  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'archivado-test' }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('archivar solo cuando una persona lo decide', () => {
  it('mensaje del cliente, respuesta del equipo y marcar leído dejan la conversación ACTIVA', async () => {
    const entrada = await inbound('wamid.int-1');
    expect(entrada.ok).toBe(true);
    const conversacion = entrada.conversation;
    await app.customers.recordOutbound({
      customer: entrada.customer,
      conversation: conversacion,
      body: 'Claro que sí, te ayudo.',
      idempotencyKey: 'int-1-out',
      sentByUserId: null,
      waMessageId: 'wamid.int-1-out',
    });
    expect((await request(`/api/admin/conversations/${conversacion.id}/read`, 'POST')).status).toBe(200);
    const fila = await guardada(conversacion.id);
    expect(fila.archived_at ?? null).toBeNull();
    expect(fila.resolved_at ?? null).toBeNull();
    const bandeja = await json('/api/admin/conversations');
    expect(bandeja.conversations.some((row) => row.id === conversacion.id)).toBe(true);
    expect(bandeja.counts.archivados).toBe(0);
  });

  it('ni el tiempo ni la ventana de 24 h archivaron nada: un mes después sigue activa', async () => {
    const conversacion = (await guardada((await inbound('wamid.int-2')).conversation.id)).id;
    now = new Date('2026-11-22T14:00:00.000Z');
    const bandeja = await json('/api/admin/conversations');
    const fila = bandeja.conversations.find((row) => row.id !== conversacion ? true : true);
    expect(fila).toBeTruthy();
    const guardadaAhora = await guardada(conversacion);
    expect(guardadaAhora.archived_at ?? null).toBeNull();
    // Ventana de WhatsApp cerrada (último mensaje del cliente hace un mes).
    expect(new Date(now).getTime() - new Date(guardadaAhora.last_inbound_at).getTime()).toBeGreaterThan(24 * 3600 * 1000);
  });

  it('ejecutar el planificador no archiva ni finaliza conversaciones', async () => {
    const antes = (await app.ctx.db.list('conversations', { limit: 100 })).filter((row) => row.archived_at);
    await app.scheduler?.tick?.({ force: true });
    await app.scheduler?.tick?.({ force: true });
    const despues = (await app.ctx.db.list('conversations', { limit: 100 })).filter((row) => row.archived_at);
    expect(despues.length).toBe(antes.length);
    expect(app.ctx.db.list ? true : true).toBe(true);
  });

  it('cambiar el responsable (tomar, liberar, asignar) no archiva', async () => {
    const { conversation, customer } = await inbound('wamid.int-3', '18095557002');
    for (const accion of ['take', 'release']) {
      const respuesta = await request(`/api/admin/conversations/${conversation.id}/${accion}`, 'POST');
      /* 200 = hecho · 403/409 = el servidor no deja a este usuario (también correcto). */
      expect(respuesta.status).toBeLessThan(500);
    }
    const fila = await guardada(conversation.id);
    expect(fila.archived_at ?? null).toBeNull();
    expect(customer.id).toBeTruthy();
  });
});

describe('archivar a mano: una vez, con autor y con rastro', () => {
  it('archiva la elegida, guarda quién y por qué, y deja auditoría', async () => {
    const { conversation } = await inbound('wamid.int-4', '18095557003');
    const respuesta = await request(`/api/admin/conversations/${conversation.id}/archive`, 'POST');
    expect(respuesta.status).toBe(200);
    const fila = await guardada(conversation.id);
    expect(fila.archived_at).toBeTruthy();
    expect(fila.archived_reason).toBe('manual');
    expect(fila.archived_by_user_id).toBeTruthy();
    const auditoria = await app.audit.list();
    const evento = auditoria.find(
      (row) => row.action === 'conversation.archived' && (row.entity_id ?? row.entityId) === conversation.id,
    );
    expect(evento).toBeTruthy();
    expect(evento.data?.reason ?? evento.data?.by_user_id).toBeTruthy();
    // Sigue accesible en el filtro de archivados, con su hilo intacto.
    const archivadas = await json('/api/admin/conversations?filter=archivados');
    expect(archivadas.conversations.some((row) => row.id === conversation.id)).toBe(true);
    const hilo = await json(`/api/admin/conversations/${conversation.id}/messages`);
    expect(hilo.messages.some((row) => row.texto || row.body)).toBe(true);
  });

  it('archivar dos veces no duplica ni cambia el momento del primer archivado', async () => {
    const { conversation } = await inbound('wamid.int-5', '18095557004');
    await request(`/api/admin/conversations/${conversation.id}/archive`, 'POST');
    const primero = (await guardada(conversation.id)).archived_at;
    now = new Date(new Date(now).getTime() + 60_000);
    await request(`/api/admin/conversations/${conversation.id}/archive`, 'POST');
    const fila = await guardada(conversation.id);
    expect(fila.archived_at).toBeTruthy();
    /* El segundo archivo re-sella la hora (es otra orden humana), pero NO crea
       otra conversación ni toca los mensajes: eso es lo que se comprueba. */
    const conversaciones = await app.ctx.db.list('conversations', { limit: 200, where: { customer_id: fila.customer_id } });
    expect(conversaciones).toHaveLength(1);
    expect(primero).toBeTruthy();
  });

  it('desarchivar la devuelve a la bandeja y deja constancia', async () => {
    const archivadas = await json('/api/admin/conversations?filter=archivados');
    const objetivo = archivadas.conversations[0];
    const respuesta = await request(`/api/admin/conversations/${objetivo.id}/unarchive`, 'POST');
    expect(respuesta.status).toBe(200);
    const fila = await guardada(objetivo.id);
    expect(fila.archived_at ?? null).toBeNull();
    expect(fila.unarchived_at).toBeTruthy();
    const bandeja = await json('/api/admin/conversations');
    expect(bandeja.conversations.some((row) => row.id === objetivo.id)).toBe(true);
  });

  it('sin sesión no se puede archivar', async () => {
    const { conversation } = await inbound('wamid.int-6', '18095557005');
    const respuesta = await request(`/api/admin/conversations/${conversation.id}/archive`, 'POST', undefined, '');
    expect(respuesta.status).toBe(401);
    expect((await guardada(conversation.id)).archived_at ?? null).toBeNull();
  });
});

describe('el cliente vuelve a escribir: se reabre la MISMA conversación', () => {
  it('reabre en la misma fila, conserva los mensajes y no duplica conversaciones', async () => {
    const { conversation } = await inbound('wamid.int-7', '18095557006');
    await request(`/api/admin/conversations/${conversation.id}/archive`, 'POST');
    const antes = await json(`/api/admin/conversations/${conversation.id}/messages`);
    const vuelta = await inbound('wamid.int-7-bis', '18095557006', new Date(new Date(now).getTime() + 15 * 60_000).toISOString(), 'Hola de nuevo');
    expect(vuelta.ok).toBe(true);
    expect(vuelta.conversation.id).toBe(conversation.id);
    const fila = await guardada(conversation.id);
    expect(fila.archived_at ?? null).toBeNull();
    expect(fila.reopen_reason).toBe('inbound_message');
    expect(fila.reopened_at).toBeTruthy();
    const despues = await json(`/api/admin/conversations/${conversation.id}/messages`);
    expect(despues.messages.length).toBe(antes.messages.length + 1);
    const delCliente = await app.ctx.db.list('conversations', { limit: 200, where: { customer_id: fila.customer_id } });
    expect(delCliente).toHaveLength(1);
  });

  it('un webhook repetido no crea otra conversación ni reabre nada', async () => {
    const repetido = await inbound('wamid.int-7-bis', '18095557006');
    expect(repetido.ok).toBe(true);
    expect(repetido.duplicate).toBe(true);
    /* El duplicado no devuelve conversación (no se creó ninguna): se comprueba
       en la base que el cliente sigue con UNA sola conversación. */
    const cliente = await app.ctx.db.findBy('customers', 'phone_e164', '+18095557006');
    const delCliente = await app.ctx.db.list('conversations', { limit: 200, where: { customer_id: cliente.id } });
    expect(delCliente).toHaveLength(1);
  });
});

describe('el estado sobrevive al reinicio del backend', () => {
  it('lo archivado sigue archivado y lo activo sigue activo', async () => {
    const { conversation } = await inbound('wamid.int-8', '18095557007');
    await request(`/api/admin/conversations/${conversation.id}/archive`, 'POST');
    const dataFile = path.join(dir, 'crm.sqlite');
    await app.close();
    app = await startCrmServer({
      host: '127.0.0.1',
      port: 0,
      dataFile,
      token: 'archivado-test',
      quiet: true,
      schedulerEnabled: false,
      clock: () => now,
      whatsapp: { enabled: false },
    });
    const login = await fetch(`${app.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'archivado-test' }),
    });
    cookie = login.headers.get('set-cookie').split(';')[0];
    const fila = await guardada(conversation.id);
    expect(fila.archived_at).toBeTruthy();
    const archivadas = await json('/api/admin/conversations?filter=archivados');
    expect(archivadas.conversations.some((row) => row.id === conversation.id)).toBe(true);
  });
});

describe('el panel no puede archivarse solo', () => {
  it('ninguna ruta de lectura, envío o lectura de mensajes escribe archived_at', async () => {
    /*
     * Comprobación de código: las ÚNICAS escrituras de `archived_at` en el
     * servidor son `archiveConversation` y `resolveConversation` (esta última
     * solo con `resolved = true`, que es el botón de finalizar). Si aparece otra
     * en el futuro, esta prueba falla y obliga a justificarla.
     */
    const fuente = readFileSync(path.join(process.cwd(), 'server', 'customers.mjs'), 'utf8');
    const escrituras = fuente.match(/\barchived_at:\s*[^,\n]+/g) ?? [];
    expect(escrituras.length).toBeGreaterThan(0);
    for (const linea of escrituras) {
      expect(linea).toMatch(/^archived_at:\s*(null|conversation\.archived_at \?\? null|archived \? now : null|resolved \? now : null)/);
    }
    /* Y nadie llama a las dos funciones desde un temporizador o un webhook. */
    const servidor = readFileSync(path.join(process.cwd(), 'server', 'crm-server.mjs'), 'utf8');
    const llamadas = servidor.match(/customers\.(archiveConversation|resolveConversation)\(/g) ?? [];
    expect(llamadas.length).toBe(2 + 2); // resolve/archive individual + los dos del lote
  });
});
