// @vitest-environment node
/*
 * CICLO DEL CLIENTE: correcciones manuales, supersesión y coherencia.
 *
 * El defecto que se corrige aquí era real: corregir «Interesado → Prospecto» a
 * mano no servía de nada porque el mensaje que provocó el interés volvía a subir
 * al cliente en el mismo instante. Ahora la corrección manda sobre la evidencia
 * ANTERIOR y un interés NUEVO posterior vuelve a contar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

let app;
let dir;
let cookie = '';
let n = 0;

const call = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers ?? {}) },
  });
const json = async (route, options) => (await call(route, options)).json();
const telefono = () => `+1809666${String(7000 + n++).slice(-4)}`;

const escribe = (phone, body, id = `wamid.${Math.random().toString(36).slice(2)}`) =>
  app.customers.recordInbound({
    waMessage: { waMessageId: id, from: phone.replace('+', ''), profileName: 'Cliente', body, type: 'text', receivedAt: new Date().toISOString() },
  });

const etapa = async (id) => (await app.customers.customerStage(id)).stage;
const ficha = (id) => app.ctx.db.get('customers', id);
const historial = (id) => app.customers.stageHistory(id);
const cambiarEtapa = (id, stage, reason = 'corrección de prueba') =>
  call(`/api/admin/customers/${id}/stage`, { method: 'POST', body: JSON.stringify({ stage, reason }) });

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ciclo-overrides-'));
  app = await startCrmServer({
    host: '127.0.0.1',
    port: 0,
    dataFile: path.join(dir, 'crm.sqlite'),
    token: 'overrides-test',
    quiet: true,
    schedulerEnabled: false,
    whatsapp: { enabled: false },
  });
  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'overrides-test' }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('corrección manual vs clasificación automática', () => {
  it('Interesado → Prospecto a mano NO se deshace con el mensaje antiguo', async () => {
    const phone = telefono();
    const r = await escribe(phone, '¿Cuánto cuesta el frasco de 30 cápsulas?');
    expect(await etapa(r.customer.id)).toBe('INTERESTED');

    const cambio = await cambiarEtapa(r.customer.id, 'PROSPECT', 'se equivocó el clasificador');
    expect(cambio.status).toBe(200);
    expect(await etapa(r.customer.id)).toBe('PROSPECT');

    // La evidencia NO se borra (queda como dato), pero queda anulada.
    const fila = await ficha(r.customer.id);
    expect(fila.interest_at).toBeTruthy();
    expect(fila.interest_ignored_until).toBeTruthy();
    expect(String(fila.interest_at) <= String(fila.interest_ignored_until)).toBe(true);

    const h = await historial(r.customer.id);
    expect(h[0]).toMatchObject({ from_stage: 'INTERESTED', to_stage: 'PROSPECT', source: 'manual' });
    expect(h[0].reason).toContain('clasificador');
  });

  it('un mensaje con interés NUEVO después de la corrección sí vuelve a subirlo', async () => {
    const phone = telefono();
    const r = await escribe(phone, 'precio del frasco de 60 por favor');
    await cambiarEtapa(r.customer.id, 'PROSPECT', 'revisión manual');
    expect(await etapa(r.customer.id)).toBe('PROSPECT');

    await escribe(phone, 'quiero comprar dos frascos de 60');
    expect(await etapa(r.customer.id)).toBe('INTERESTED');
    const fila = await ficha(r.customer.id);
    expect(fila.interest_reopened_at).toBeTruthy();
    expect(fila.interest_reason).toBe('intencion_compra');
  });

  it('un saludo después de la corrección NO lo vuelve a subir', async () => {
    const phone = telefono();
    const r = await escribe(phone, 'cuanto vale el de 30');
    await cambiarEtapa(r.customer.id, 'PROSPECT', 'sin interés real');
    await escribe(phone, 'hola, buenas');
    expect(await etapa(r.customer.id)).toBe('PROSPECT');
  });

  it('marcar Interesado a mano se mantiene aunque llegue un mensaje genérico', async () => {
    const phone = telefono();
    const r = await app.customers.findOrCreateByPhone({ phone, name: 'Cliente manual' });
    await cambiarEtapa(r.customer.id, 'INTERESTED', 'lo dijo por teléfono');
    expect(await etapa(r.customer.id)).toBe('INTERESTED');
    await escribe(phone, 'ok gracias');
    expect(await etapa(r.customer.id)).toBe('INTERESTED');
  });

  it('volver a automático recupera la evidencia guardada', async () => {
    const phone = telefono();
    const r = await escribe(phone, '¿tienen el frasco de 15 disponible?');
    await cambiarEtapa(r.customer.id, 'PROSPECT', 'corrección');
    expect(await etapa(r.customer.id)).toBe('PROSPECT');
    const limpiar = await call(`/api/admin/customers/${r.customer.id}/stage`, { method: 'POST', body: JSON.stringify({ stage: null, reason: 'volver a automático' }) });
    expect(limpiar.status).toBe(200);
    expect(await etapa(r.customer.id)).toBe('INTERESTED');
    const fila = await ficha(r.customer.id);
    expect(fila.customer_stage_manual_at ?? null).toBeNull();
    expect(fila.interest_ignored_until ?? null).toBeNull();
  });

  it('repetir la misma corrección no duplica el historial', async () => {
    const phone = telefono();
    const r = await app.customers.findOrCreateByPhone({ phone, name: 'Cliente repetido' });
    const primera = await cambiarEtapa(r.customer.id, 'INTERESTED', 'primera');
    const segunda = await cambiarEtapa(r.customer.id, 'INTERESTED', 'otra vez');
    expect(primera.status).toBe(200);
    expect(segunda.status).toBe(200);
    const h = await historial(r.customer.id);
    expect(h).toHaveLength(1);
  });

  it('Cliente y Recompra se rechazan como etapa manual', async () => {
    const phone = telefono();
    const r = await app.customers.findOrCreateByPhone({ phone, name: 'Cliente hecho' });
    for (const stage of ['CUSTOMER', 'REPEAT_CUSTOMER']) {
      const respuesta = await cambiarEtapa(r.customer.id, stage, 'intento');
      expect(respuesta.status).toBe(422);
      expect((await respuesta.json()).error).toBe('not_manual');
    }
  });

  it('no se puede bajar a Prospecto a quien ya compró', async () => {
    const phone = telefono();
    const alta = await json('/api/admin/purchases', {
      method: 'POST',
      body: JSON.stringify({ name: 'Comprador', phone, variantId: 'capsules_60', quantity: 1, status: 'nuevo', paymentMethod: 'CASH' }),
    });
    await call(`/api/admin/items/${alta.item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'entregado' }) });
    expect(await etapa(alta.customer.id)).toBe('CUSTOMER');
    const intento = await cambiarEtapa(alta.customer.id, 'PROSPECT', 'no debería');
    expect(intento.status).toBe(409);
    expect((await intento.json()).error).toBe('completed_purchase_stage_conflict');
    expect(await etapa(alta.customer.id)).toBe('CUSTOMER');
  });
});

describe('coherencia entre lista, bandeja y ficha', () => {
  it('las tres vistas devuelven la MISMA etapa efectiva', async () => {
    const phone = telefono();
    const r = await escribe(phone, 'quiero pedir un frasco de 30');
    await cambiarEtapa(r.customer.id, 'PROSPECT', 'revisión');

    const lista = (await json('/api/admin/customers')).customers.find((row) => row.id === r.customer.id);
    const bandeja = (await json('/api/admin/conversations')).conversations.find((row) => row.id === r.conversation.id);
    const perfil = await json(`/api/admin/customers/${r.customer.id}`);

    expect(lista.customer_stage).toBe('PROSPECT');
    expect(bandeja.customer_stage).toBe('PROSPECT');
    expect(perfil.customer_stage).toBe('PROSPECT');
    expect(perfil.customer.customer_stage).toBe('PROSPECT');
  });

  it('archivar, finalizar o programar seguimiento no cambia la etapa', async () => {
    const phone = telefono();
    const r = await escribe(phone, 'cuanto cuesta el de 60');
    expect(await etapa(r.customer.id)).toBe('INTERESTED');
    await call(`/api/admin/conversations/${r.conversation.id}/archive`, { method: 'POST' });
    expect(await etapa(r.customer.id)).toBe('INTERESTED');
    await call(`/api/admin/conversations/${r.conversation.id}/unarchive`, { method: 'POST' });
    await call(`/api/admin/conversations/${r.conversation.id}/resolve`, { method: 'POST' });
    expect(await etapa(r.customer.id)).toBe('INTERESTED');
    const seguimiento = await call('/api/admin/followups', {
      method: 'POST',
      body: JSON.stringify({ customerId: r.customer.id, type: 'checkin', scheduledAt: new Date(Date.now() + 86400000).toISOString() }),
    });
    expect([200, 201]).toContain(seguimiento.status);
    expect(await etapa(r.customer.id)).toBe('INTERESTED');
  });
});

describe('permisos y aislamiento', () => {
  it('un repartidor no puede cambiar etapas (403) y sin sesión es 401', async () => {
    const phone = telefono();
    const r = await app.customers.findOrCreateByPhone({ phone, name: 'Protegido' });
    const creado = await json('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'reparto-etapa@test.local', password: 'Reparto-12345', displayName: 'Reparto', role: 'DELIVERY' }),
    });
    const login = await fetch(`${app.url}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: creado.user.username, password: 'Reparto-12345' }),
    });
    const suCookie = login.headers.get('set-cookie').split(';')[0];
    const respuesta = await fetch(`${app.url}/api/admin/customers/${r.customer.id}/stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: suCookie },
      body: JSON.stringify({ stage: 'INTERESTED' }),
    });
    expect([401, 403]).toContain(respuesta.status);
    expect(await etapa(r.customer.id)).toBe('PROSPECT');

    const sinSesion = await fetch(`${app.url}/api/admin/customers/${r.customer.id}/stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'INTERESTED' }),
    });
    expect(sinSesion.status).toBe(401);
  });

  it('cambiar la etapa de un cliente inexistente da 404 y no crea nada', async () => {
    const respuesta = await cambiarEtapa('cus_no_existe_0000', 'INTERESTED');
    expect(respuesta.status).toBe(404);
  });
});

describe('reconciliación (solo lectura)', () => {
  it('el informe explica el cálculo automático, la corrección y los conflictos sin escribir', async () => {
    const phone = telefono();
    const r = await escribe(phone, 'me interesa el frasco de 30');
    await cambiarEtapa(r.customer.id, 'PROSPECT', 'corrección auditada');

    const antes = await ficha(r.customer.id);
    const informe = await json('/api/admin/customers/stage-dry-run');
    expect(informe.ok).toBe(true);
    const fila = informe.report.find((row) => row.customerId === r.customer.id);
    expect(fila.customerStage).toBe('PROSPECT');
    expect(fila.calculatedWithoutManual).toBe('INTERESTED');
    expect(fila.manual).toBe('PROSPECT');
    expect(fila.interest_superseded).toBe(true);
    expect(informe.conflicts.some((row) => row.customerId === r.customer.id)).toBe(true);

    const despues = await ficha(r.customer.id);
    expect(despues.updated_at).toBe(antes.updated_at);
    expect(informe.report.every((row) => row.wouldWrite === false)).toBe(true);
  });
});
