/**
 * CHAT QUE ABRE EL CRM (nosotros escribimos primero).
 *
 * Caso real que se reportó: se crea el contacto desde el CRM y se le escribe
 * —o se le manda una plantilla— sin que el cliente haya escrito nunca. Ese chat
 * tiene que CONTAR como cualquier otro (aparecer en la bandeja, sumar en
 * «Todos» y en «Prospectos») y el cliente tiene que quedar en **Prospecto**.
 *
 * La regla vive en el servidor: una conversación solo se considera «vacía» si
 * viene de una importación y no tiene NADA. Este archivo la deja clavada para
 * que no se rompa al tocar la bandeja.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-chat-saliente';
const TELEFONO = '18095559011';

let tmpDir;
let app;
let cookie = '';

const api = async (ruta, init = {}) => {
  const respuesta = await fetch(`${app.url}${ruta}`, {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: respuesta.status, body: await respuesta.json() };
};

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-chat-saliente-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
  });
  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

it('un chat donde solo escribió el CRM cuenta y deja al cliente en Prospecto', async () => {
  // 1) Se crea el contacto desde el CRM (el mismo camino del botón «Crear cliente»).
  const alta = await api('/api/admin/conversations/start', {
    method: 'POST',
    body: JSON.stringify({ phone: TELEFONO, name: 'Cliente Escrito Primero' }),
  });
  expect(alta.status).toBe(200);
  expect(alta.body.created).toBe(true);

  const cliente = alta.body.customer;
  const conversacion = alta.body.conversation;
  expect(cliente?.id).toBeTruthy();
  expect(conversacion?.id).toBeTruthy();

  // 2) Le escribe el CRM (plantilla), sin que él haya escrito nunca.
  const enviado = await app.customers.recordOutbound({
    customer: cliente,
    conversation: conversacion,
    body: 'Hola, te escribimos de FullTECH',
    template: 'bienvenida_fulltech',
    status: 'sent',
    sentBy: 'panel',
  });
  expect(enviado.ok).toBe(true);

  // 3) La bandeja y el cliente, tal como los ve el panel.
  const datos = await api('/api/admin/data');
  const fila = (datos.body.conversations ?? []).find((row) => row.customer_id === cliente.id);
  const ficha = (datos.body.customers ?? []).find((row) => row.id === cliente.id);
  const etapas = (datos.body.conversations ?? []).map((row) => row.customer_stage);

  // El chat NO se esconde: está, no es «vacío» y no está archivado.
  expect(fila).toBeTruthy();
  expect(fila.empty).toBe(false);
  expect(fila.archived_at ?? null).toBeNull();
  expect(fila.last_message_at).toBeTruthy();

  // Y el cliente es PROSPECTO (escribir nosotros no lo convierte en interesado).
  expect(ficha.customer_stage).toBe('PROSPECT');
  expect(fila.customer_stage).toBe('PROSPECT');
  expect(etapas).toContain('PROSPECT');
  expect(fila.last_message?.direction).toBe('outbound');
});
