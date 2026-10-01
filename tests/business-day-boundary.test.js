// @vitest-environment node
/**
 * FRONTERA UTC / AMERICA_SANTO_DOMINGO — manda el día del NEGOCIO.
 *
 * El caso que rompía (entre las 20:00 y las 24:00 hora de RD la pantalla HOY
 * quedaba vacía y las métricas del período contaban 0):
 *
 *   instante real        → 2026-10-01T00:30:00Z
 *   día UTC              → 2026-10-01   (lo que da `toISOString().slice(0, 10)`)
 *   día del negocio (RD) → 2026-09-30   (lo que da `dayIn(..., America/Santo_Domingo)`)
 *
 * Se comprueba con el RELOJ INYECTADO del servidor (`clock`), nunca con el reloj
 * de la máquina: el resultado no puede depender de cuándo ni desde dónde se
 * ejecute la suite (ni de su zona horaria).
 *
 * No toca producción: el servidor se arranca con su propia base temporal y un
 * cliente de WhatsApp falso. No se envía nada a nadie.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';
import { DEFAULT_TIME_ZONE, dayIn } from '../server/followups.mjs';

const TOKEN = 'clave-frontera-123';
const PHONE = '18095550777';
const PLAN = [{ key: 'd1', day: 1, type: 'thanks', reason: 'Gracias' }];

/** Un instante de la frontera: en UTC ya es día 1, en RD todavía el 30. */
const INSTANTE = '2026-10-01T00:30:00.000Z';
const DIA_UTC = '2026-10-01';
const DIA_NEGOCIO = '2026-09-30';

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN123',
  sent: [],
  async sendText() {
    return { ok: true, status: 200, messageId: 'wamid.NO-ENVIAR' };
  },
  async sendTemplate() {
    return { ok: true, status: 200, messageId: 'wamid.NO-ENVIAR' };
  },
  async markAsRead() {
    return { ok: true };
  },
};

let tmpDir;
let app;
let cookie = '';
let customerId = '';

const call = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
  });

const json = async (response) => JSON.parse(await response.text());

/** Crea un pedido con una fecha EXPLÍCITA (el día que le digamos, no «ahora»). */
const crearPedido = (fecha) =>
  call('/api/admin/orders', {
    method: 'POST',
    body: JSON.stringify({
      phone: PHONE,
      name: 'Cliente Frontera',
      items: [{ variantId: 'capsules_10', quantity: 1 }],
      date: fecha,
    }),
  });

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-frontera-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    followupPlan: PLAN,
    whatsapp: mockWhatsApp,
    schedulerEnabled: false,
    // EL reloj: congelado en la frontera. Es la pieza que hace determinista
    // toda esta prueba (nada depende de la hora a la que se ejecute).
    clock: () => new Date(INSTANTE),
  });
  const login = await call('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  // El pedido que define «hoy»: fecha del día de NEGOCIO.
  await crearPedido(`${DIA_NEGOCIO}T12:00:00.000Z`);
  const customers = await json(await call('/api/admin/customers'));
  customerId = customers.customers.find((row) => row.phone_e164 === `+${PHONE}`).id;
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('el mismo instante cae en días distintos según la zona', () => {
  it('UTC dice 2026-10-01 y el negocio dice 2026-09-30', () => {
    const fecha = new Date(INSTANTE);
    // Las dos formas de decir «hoy» que se estaban mezclando:
    expect(fecha.toISOString().slice(0, 10)).toBe(DIA_UTC);
    expect(dayIn(fecha, 'UTC')).toBe(DIA_UTC);
    expect(dayIn(fecha, DEFAULT_TIME_ZONE)).toBe(DIA_NEGOCIO);
    // Y la zona del negocio es la que dice el módulo (una sola definición).
    expect(DEFAULT_TIME_ZONE).toBe('America/Santo_Domingo');
  });
});

describe('con el reloj congelado en la frontera', () => {
  it('la pantalla HOY clasifica con el día de negocio, no con el día UTC', async () => {
    const inicial = await json(await call('/api/admin/followups'));
    expect(inicial.timeZone).toBe(DEFAULT_TIME_ZONE);
    expect(inicial.reference).toBe(DIA_NEGOCIO);

    // Tarea programada para el día del negocio → es de HOY.
    const hoy = await json(
      await call('/api/admin/followups', {
        method: 'POST',
        body: JSON.stringify({ customerId, reason: 'Llamar hoy', scheduledAt: DIA_NEGOCIO, idempotencyKey: 'fu:frontera:hoy' }),
      }),
    );
    expect(hoy.followup.scheduled_at).toBe(DIA_NEGOCIO);

    // Tarea programada para el día UTC (el «mañana» del negocio) → NO es de HOY.
    const manana = await json(
      await call('/api/admin/followups', {
        method: 'POST',
        body: JSON.stringify({ customerId, reason: 'Llamar mañana', scheduledAt: DIA_UTC, idempotencyKey: 'fu:frontera:manana' }),
      }),
    );
    expect(manana.followup.scheduled_at).toBe(DIA_UTC);

    const despues = await json(await call('/api/admin/followups'));
    const idsHoy = despues.today.map((row) => row.id);
    const idsProximas = despues.upcoming.map((row) => row.id);
    expect(idsHoy).toContain(hoy.followup.id);
    expect(idsHoy).not.toContain(manana.followup.id);
    expect(idsProximas).toContain(manana.followup.id);
  });

  it('las métricas de «hoy» cierran en el día de negocio', async () => {
    const metrics = await json(await call('/api/admin/metrics?period=hoy'));
    expect(metrics.metrics.period.name).toBe('hoy');
    expect(metrics.metrics.period.endDay).toBe(DIA_NEGOCIO);
    expect(metrics.metrics.period.startDay).toBe(DIA_NEGOCIO);
    // El pedido del día de negocio SÍ cuenta.
    expect(metrics.metrics.byPeriod.pedidosCreados).toBe(1);

    // Y un pedido con la fecha del día UTC siguiente (lo que el navegador manda
    // si usa `toISOString()`) NO entra en el «hoy» del negocio: no se contó mal,
    // es que para el negocio todavía no es ese día.
    await crearPedido(INSTANTE);
    const siguiente = await json(await call('/api/admin/metrics?period=hoy'));
    expect(siguiente.metrics.byPeriod.pedidosCreados).toBe(1);
    expect(siguiente.metrics.byPeriod.pedidosCreados).toBe(metrics.metrics.byPeriod.pedidosCreados);
  });
});
