// @vitest-environment node
/*
 * BANDEJA: filtros por etapa, fechas, prioridad y búsqueda en el historial.
 *
 * Servidor real y base temporal. Lo que se comprueba es la RESPUESTA del CRM
 * (`/api/admin/conversations`), que es lo que pinta el panel.
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
const bandeja = (query) => json(`/api/admin/conversations?${query}`);

const telefono = () => `+1809556${String(3000 + n++).slice(-4)}`;

function escribe(phone, body, at = new Date(), id = `wamid.${Math.random().toString(36).slice(2)}`) {
  return app.customers.recordInbound({
    waMessage: { waMessageId: id, from: phone.replace('+', ''), profileName: 'Cliente', body, type: 'text', receivedAt: at.toISOString() },
  });
}

async function pedido(phone, status = 'nuevo') {
  const respuesta = await call('/api/admin/purchases', {
    method: 'POST',
    body: JSON.stringify({ name: 'Cliente', phone, variantId: 'capsules_60', quantity: 1, status, paymentMethod: 'CASH' }),
  });
  return respuesta.json();
}
const entregar = (id) => call(`/api/admin/items/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'entregado' }) });

/** Crea una conversación con un mensaje entrante y devuelve { customer, conversation }. */
async function conversacion(phone = telefono(), body = 'Hola') {
  const r = await escribe(phone, body);
  return { customer: r.customer, conversation: r.conversation, phone };
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bandeja-filtros-'));
  app = await startCrmServer({
    host: '127.0.0.1',
    port: 0,
    dataFile: path.join(dir, 'crm.sqlite'),
    token: 'filtros-test',
    quiet: true,
    schedulerEnabled: false,
    whatsapp: { enabled: false },
  });
  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'filtros-test' }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('filtros por etapa comercial', () => {
  it('cada etapa cae en su filtro y los contadores cuadran', async () => {
    const prospecto = await conversacion();
    const interesado = await conversacion();
    await escribe(interesado.phone, '¿Cuánto cuesta el frasco de 30 cápsulas?');
    const cliente = await conversacion();
    const uno = await pedido(cliente.phone, 'nuevo');
    await entregar(uno.item.id);
    const recompra = await conversacion();
    const a = await pedido(recompra.phone, 'nuevo');
    await entregar(a.item.id);
    const b = await pedido(recompra.phone, 'nuevo');
    await entregar(b.item.id);

    const etapas = async (filtro) => (await bandeja(`filter=todos&stage=${filtro}`)).conversations.map((row) => row.id);

    expect(await etapas('prospectos')).toContain(prospecto.conversation.id);
    expect(await etapas('interesados')).toContain(interesado.conversation.id);
    expect(await etapas('recompra')).toContain(recompra.conversation.id);
    expect(await etapas('interesados')).not.toContain(recompra.conversation.id);

    const { counts } = await bandeja('filter=todos');
    expect(counts.prospectos).toBeGreaterThanOrEqual(1);
    expect(counts.interesados).toBeGreaterThanOrEqual(1);
    expect(counts.recompra).toBeGreaterThanOrEqual(1);
    expect(counts.etapa_clientes).toBeGreaterThanOrEqual(1);
    // «Clientes» (histórico) sigue contando compras entregadas, recompras incluidas.
    expect(counts.clientes).toBeGreaterThanOrEqual(2);
  });

  it('etapa + fecha se combinan (sin borrarse la una a la otra)', async () => {
    /*
     * Conversación de AYER (todo su historial es de ayer, así que su
     * `last_message_at` es de ayer) con evidencia de interés.
     */
    const ayer = new Date(Date.now() - 86400000);
    const phone = telefono();
    const viejo = await escribe(phone, '¿precio del frasco de 60?', ayer);

    const sinFecha = await bandeja('filter=todos&stage=interesados');
    expect(sinFecha.conversations.some((row) => row.id === viejo.conversation.id)).toBe(true);

    /*
     * La fecha se calcula en la ZONA DEL CRM, no en UTC: después de las 20:00 locales
     * el día UTC ya es otro y «ayer» apuntaba a hoy (fallo real de esta prueba).
     */
    const diaCrm = (date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo' }).format(date);
    const soloHoy = await bandeja(`filter=todos&stage=interesados&from=${diaCrm(new Date())}`);
    expect(soloHoy.conversations.some((row) => row.id === viejo.conversation.id)).toBe(false);

    // Y con el rango que SÍ la incluye, aparece: la etapa no borró la fecha.
    const ayerISO = diaCrm(ayer);
    const conAyer = await bandeja(`filter=todos&stage=interesados&from=${ayerISO}&to=${ayerISO}`);
    expect(conAyer.conversations.some((row) => row.id === viejo.conversation.id)).toBe(true);
  });

  it('etapa + sin asignar se combinan', async () => {
    const r = await bandeja('filter=sin-asignar&stage=prospectos');
    expect(Array.isArray(r.conversations)).toBe(true);
    for (const row of r.conversations) {
      expect(row.assigned_user_id).toBeFalsy();
      expect(row.customer_stage).toBe('PROSPECT');
    }
  });

  it('un rango de fechas inválido se rechaza con 422', async () => {
    const respuesta = await call('/api/admin/conversations?from=2026-10-20&to=2026-10-01');
    expect(respuesta.status).toBe(422);
  });
});

describe('búsqueda por palabras clave', () => {
  it('encuentra por nombre, por teléfono y por texto DENTRO del historial', async () => {
    const phone = telefono();
    await app.customers.findOrCreateByPhone({ phone, name: 'Yahaira Peña' });
    const primera = await escribe(phone, 'Me interesa el frasco de 30 cápsulas de Phytoemagry');
    // Dos mensajes más recientes: la palabra buscada queda en el HISTORIAL.
    await escribe(phone, 'gracias');
    await escribe(phone, 'quedo pendiente');

    const porNombre = await bandeja('q=yahaira');
    expect(porNombre.conversations.some((row) => row.id === primera.conversation.id)).toBe(true);
    expect(porNombre.conversations[0].match?.campo).toBe('cliente');

    const porTelefono = await bandeja(`q=${phone.replace('+', '')}`);
    expect(porTelefono.conversations.some((row) => row.id === primera.conversation.id)).toBe(true);

    const porHistorial = await bandeja('q=phytoemagry 30 capsulas');
    const fila = porHistorial.conversations.find((row) => row.id === primera.conversation.id);
    expect(fila).toBeTruthy();
    expect(fila.match?.campo).toBe('mensaje');
    expect(fila.match?.snippet).toMatch(/Phytoemagry/i);
    expect(fila.match?.message_id).toBeTruthy();
  });

  it('una conversación aparece UNA vez aunque el texto esté en varios mensajes', async () => {
    const phone = telefono();
    await escribe(phone, 'delivery hoy por favor');
    await escribe(phone, 'delivery hoy otra vez');
    const r = await bandeja('q=delivery hoy');
    const ids = r.conversations.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('busca por número de pedido', async () => {
    const phone = telefono();
    await escribe(phone, 'hola');
    const alta = await pedido(phone, 'nuevo');
    const numero = alta.item.order_number;
    expect(numero).toBeTruthy();
    const r = await bandeja(`q=${encodeURIComponent(numero)}`);
    expect(r.conversations.some((row) => row.conversation_id === undefined && row.customer?.phone_e164 === phone)).toBe(true);
    expect(r.conversations[0].match?.campo).toBe('pedido');
  });

  it('sin resultados devuelve lista vacía (no error)', async () => {
    const r = await bandeja('q=zzzz-no-existe-9999');
    expect(r.ok).toBe(true);
    expect(r.conversations).toHaveLength(0);
  });

  it('la búsqueda NO mezcla conversaciones archivadas en la bandeja normal, pero las encuentra al buscar', async () => {
    const r = await conversacion(telefono(), 'quiero informacion del frasco');
    await call(`/api/admin/conversations/${r.conversation.id}/archive`, { method: 'POST' });
    const activas = await bandeja('filter=todos');
    expect(activas.conversations.some((row) => row.id === r.conversation.id)).toBe(false);
    const archivadas = await bandeja('filter=archivados');
    expect(archivadas.conversations.some((row) => row.id === r.conversation.id)).toBe(true);
    const buscando = await bandeja('q=informacion del frasco');
    expect(buscando.conversations.some((row) => row.id === r.conversation.id)).toBe(true);
  });
});

describe('orden por atención (prioridad de venta)', () => {
  it('el interesado que espera respuesta sube; el orden reciente no cambia', async () => {
    // Conversación leída, ya contestada, de un cliente antiguo.
    const tranquila = await conversacion(telefono(), 'ok gracias por todo');
    await app.customers.recordOutbound({
      customer: tranquila.customer,
      conversation: tranquila.conversation,
      body: 'A la orden.',
      idempotencyKey: 'prioridad-out',
      waMessageId: 'wamid.prioridad-out',
    });
    await call(`/api/admin/conversations/${tranquila.conversation.id}/read`, { method: 'POST' });

    // Interesado que acaba de escribir y nadie ha contestado.
    const urgente = await conversacion(telefono(), '¿cuánto cuesta el frasco de 60? quiero comprarlo');

    const recientes = await bandeja('filter=todos');
    const prioridad = await bandeja('filter=todos&sort=priority');

    const posicion = (lista, id) => lista.conversations.findIndex((row) => row.id === id);
    expect(posicion(prioridad, urgente.conversation.id)).toBeLessThan(posicion(prioridad, tranquila.conversation.id));
    const filaUrgente = prioridad.conversations.find((row) => row.id === urgente.conversation.id);
    expect(filaUrgente.priority.score).toBeGreaterThan(0);
    expect(filaUrgente.priority.razones.length).toBeGreaterThan(0);
    // El orden por defecto sigue siendo el de actividad reciente.
    expect(recientes.conversations[0].last_message_at >= recientes.conversations.at(-1).last_message_at).toBe(true);
    expect(recientes.conversations.every((row) => row.priority === undefined)).toBe(true);
  });
});

describe('integridad y permisos', () => {
  it('un webhook duplicado no altera contadores ni duplica filas', async () => {
    const phone = telefono();
    const primera = await escribe(phone, 'hola, quiero saber el precio', new Date(), 'wamid.duplicado-1');
    const antes = await bandeja('filter=todos');
    await escribe(phone, 'hola, quiero saber el precio', new Date(), 'wamid.duplicado-1');
    const despues = await bandeja('filter=todos');
    expect(despues.counts.todos).toBe(antes.counts.todos);
    expect(despues.conversations.filter((row) => row.id === primera.conversation.id)).toHaveLength(1);
  });

  it('archivar o finalizar no cambia la etapa del cliente', async () => {
    const r = await conversacion(telefono(), 'quiero comprar dos frascos');
    const antes = (await bandeja('filter=todos&stage=interesados')).conversations.find((row) => row.id === r.conversation.id);
    expect(antes).toBeTruthy();
    await call(`/api/admin/conversations/${r.conversation.id}/resolve`, { method: 'POST' });
    const despues = (await bandeja('filter=archivados')).conversations.find((row) => row.id === r.conversation.id);
    expect(despues.customer_stage).toBe('INTERESTED');
  });

  it('un repartidor no puede leer la bandeja completa', async () => {
    const creado = await json('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'reparto-filtros@test.local', password: 'Reparto-12345', displayName: 'Reparto', role: 'DELIVERY' }),
    });
    expect(creado.user?.id).toBeTruthy();
    const login = await fetch(`${app.url}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: creado.user.username, password: 'Reparto-12345' }),
    });
    const suCookie = login.headers.get('set-cookie').split(';')[0];
    const respuesta = await fetch(`${app.url}/api/admin/conversations?q=hola`, { headers: { cookie: suCookie } });
    // Con `chats.read` puede entrar, pero solo ve SUS conversaciones (ninguna).
    if (respuesta.status === 200) {
      const cuerpo = await respuesta.json();
      expect(cuerpo.conversations).toHaveLength(0);
    } else {
      expect([401, 403]).toContain(respuesta.status);
    }
    const sinSesion = await fetch(`${app.url}/api/admin/conversations`);
    expect(sinSesion.status).toBe(401);
  });
});
