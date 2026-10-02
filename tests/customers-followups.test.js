// @vitest-environment node
/**
 * CLIENTES Y SEGUIMIENTO — el servidor se arranca de verdad y se registran
 * compras reales, porque lo que importa es que un cliente NO se duplique, que
 * sus totales cuadren y que el seguimiento se cree UNA sola vez por venta.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';
import { estimateSupply, resolveDailyCapsules, resolvePlan } from '../server/followups.mjs';

const TOKEN = 'clave-clientes-123';
/** Plan de prueba: hoy, +1 día y +7 días (los días son configurables). */
const PLAN = [
  { key: 'd0', day: 0, type: 'thanks', reason: 'Hoy', template: 'phyto_purchase_thanks' },
  { key: 'd1', day: 1, type: 'checkin', reason: 'Mañana' },
  { key: 'd7', day: 7, type: 'education', reason: 'Una semana', template: 'phyto_weekly_education' },
];

let tmpDir;
let app;
let cookie = '';

const call = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      cookie,
      ...(options.headers ?? {}),
    },
  });

const json = async (response) => JSON.parse(await response.text());

const buy = (body) => call('/api/admin/purchases', { method: 'POST', body: JSON.stringify({ paymentMethod: 'CASH', ...body }) });

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-cus-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    followupPlan: PLAN,
  });
  const login = await call('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('plan de seguimiento configurable', () => {
  it('sin configuración usa el plan de casa (día 1, 3, 7, 14, 21, 30)', () => {
    expect(resolvePlan('').map((entry) => entry.day)).toEqual([1, 3, 7, 14, 21, 30]);
    expect(resolvePlan('{json roto}')).toHaveLength(6);
  });

  it('acepta un plan propio y calcula la dosis y la duración del frasco', () => {
    const plan = resolvePlan(JSON.stringify([{ key: 'x', day: 2, type: 'checkin', reason: 'Prueba' }]));
    expect(plan).toHaveLength(1);
    expect(plan[0].day).toBe(2);
    // La dosis sale del texto APROBADO del producto, no se inventa.
    expect(resolveDailyCapsules('1 cápsula al día después del desayuno.')).toBe(1);
    expect(resolveDailyCapsules(null, 2)).toBe(2);
    expect(estimateSupply({ capsules: 60, quantity: 1, dailyCapsules: 1 })).toMatchObject({
      days: 60,
      totalCapsules: 60,
    });
  });
});

describe('registrar una compra a mano', () => {
  it('crea el cliente y usa el precio OFICIAL del catálogo', async () => {
    const response = await buy({
      name: 'Junior Pérez',
      phone: '809-555-1234',
      location: 'Higüey',
      variantId: 'capsules_60',
      quantity: 1,
      status: 'entregado',
      date: new Date().toISOString(),
    });
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.customer.phone_e164).toBe('+18095551234');
    // capsules_60 cuesta 10000 en el catálogo: el panel no manda el precio.
    expect(body.item.unit_price).toBe(10000);
    expect(body.item.total).toBe(10000);
    expect(body.item.customer_id).toBe(body.customer.id);
    expect(body.item.source).toBe('manual');
  });

  it('el mismo teléfono escrito de otra forma es el MISMO cliente', async () => {
    const before = await json(await call('/api/admin/customers'));
    const first = before.customers.find((row) => row.phone_e164 === '+18095551234');

    const again = await buy({
      phone: '+1 (809) 555-1234',
      variantId: 'capsules_5',
      quantity: 2,
      status: 'confirmado',
      date: daysAgo(1),
    });
    const body = await json(again);
    expect(body.customer.id).toBe(first.id);
    expect(body.duplicate).toBe(false);

    const after = await json(await call('/api/admin/customers'));
    expect(after.customers.filter((row) => row.phone_e164 === '+18095551234')).toHaveLength(1);

    const profile = await json(await call(`/api/admin/customers/${first.id}`));
    expect(profile.purchases).toHaveLength(2);
    // Solo cuenta el dinero ENTREGADO: el segundo pedido está confirmado, no entregado.
    expect(profile.totals.total_purchases).toBe(1);
    expect(profile.totals.total_spent).toBe(10000);
    expect(profile.totals.open_purchases).toBe(1);
  });

  it('rechaza una compra sin teléfono o sin frasco del catálogo', async () => {
    const sinTelefono = await buy({ name: 'Sin teléfono', variantId: 'capsules_5' });
    expect(sinTelefono.status).toBe(422);
    expect((await json(sinTelefono)).error).toBe('invalid_phone');

    const sinFrasco = await buy({ phone: '809-555-9999', variantId: 'frasco-inventado' });
    expect(sinFrasco.status).toBe(422);
    expect((await json(sinFrasco)).error).toBe('invalid_variant');
  });
});

describe('la venta entregada genera el seguimiento (una sola vez)', () => {
  it('crea las tareas con su fecha y deja el próximo aviso en el cliente', async () => {
    const customer = (await json(await call('/api/admin/customers'))).customers.find(
      (row) => row.phone_e164 === '+18095551234',
    );
    const profile = await json(await call(`/api/admin/customers/${customer.id}`));
    const delivered = profile.purchases.find((row) => row.status === 'entregado');

    const followups = await json(await call('/api/admin/followups'));
    const mine = [...followups.today, ...followups.overdue, ...followups.upcoming].filter(
      (row) => row.purchase_id === delivered.id,
    );
    expect(mine).toHaveLength(PLAN.length);
    expect(mine.map((row) => row.key).sort()).toEqual(['d0', 'd1', 'd7']);
    expect(mine.every((row) => row.status === 'pending')).toBe(true);

    const refreshed = await json(await call(`/api/admin/customers/${customer.id}`));
    expect(refreshed.customer.next_followup_at).toBe(app.followups.today());
  });

  it('volver a marcar la venta como entregada NO duplica las tareas', async () => {
    const customer = (await json(await call('/api/admin/customers'))).customers.find(
      (row) => row.phone_e164 === '+18095551234',
    );
    const profile = await json(await call(`/api/admin/customers/${customer.id}`));
    const delivered = profile.purchases.find((row) => row.status === 'entregado');

    // Es lo que pasa si el negocio vuelve a tocar el estado, o si el proceso se
    // reinicia y se repara el historial: la misma clave impide el duplicado.
    const first = await app.followups.scheduleForPurchase({
      customerId: customer.id,
      purchaseId: delivered.id,
      deliveredAt: delivered.received_at,
      capsules: delivered.capsules,
      quantity: delivered.quantity,
    });
    const second = await app.followups.scheduleForPurchase({
      customerId: customer.id,
      purchaseId: delivered.id,
      deliveredAt: delivered.received_at,
      capsules: delivered.capsules,
      quantity: delivered.quantity,
    });
    expect(first.created).toHaveLength(0);
    expect(second.created).toHaveLength(0);

    const stored = await app.collections.list('followups');
    expect(stored.filter((row) => row.purchase_id === delivered.id)).toHaveLength(PLAN.length);
  });
});

describe('pantalla HOY: pendiente, para hoy y vencido', () => {
  it('clasifica cada tarea por su fecha', async () => {
    // Venta entregada hace 5 días: las tareas del día 0 y 1 ya vencieron.
    const response = await buy({
      name: 'María Vencida',
      phone: '8295554321',
      variantId: 'capsules_5',
      quantity: 1,
      status: 'entregado',
      date: daysAgo(5),
    });
    expect(response.status).toBe(201);

    const followups = await json(await call('/api/admin/followups'));
    expect(followups.reference).toBe(app.followups.today());

    const overdueForMaria = followups.overdue.filter((row) => row.customer?.phone_e164 === '+18295554321');
    expect(overdueForMaria.map((row) => row.key).sort()).toEqual(['d0', 'd1']);
    expect(overdueForMaria.every((row) => row.scheduled_at < followups.reference)).toBe(true);

    const upcomingForMaria = followups.upcoming.filter((row) => row.customer?.phone_e164 === '+18295554321');
    expect(upcomingForMaria.map((row) => row.key)).toEqual(['d7']);

    // Y ninguna de las dos ventas se ha tocado todavía: nada se marcó hecho solo.
    expect(followups.summary.dueNow).toBeGreaterThan(0);
  });

  it('completar, posponer y cancelar una tarea deja el estado correcto', async () => {
    const followups = await json(await call('/api/admin/followups'));
    const target = followups.overdue.find((row) => row.key === 'd0');

    const postponed = await json(
      await call(`/api/admin/followups/${target.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'postpone', days: 2 }) }),
    );
    expect(postponed.followup.status).toBe('pending');
    expect(postponed.followup.postponed_from).toBe(target.scheduled_at);
    expect(postponed.followup.scheduled_at > target.scheduled_at).toBe(true);

    const completed = await json(
      await call(`/api/admin/followups/${target.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'complete' }) }),
    );
    expect(completed.followup.status).toBe('completed');

    const other = followups.overdue.find((row) => row.key === 'd1');
    const cancelled = await json(
      await call(`/api/admin/followups/${other.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'cancel' }) }),
    );
    expect(cancelled.followup.status).toBe('cancelled');

    // Una tarea completada ya no es "para hoy" ni "vencida".
    const after = await json(await call('/api/admin/followups'));
    expect(after.overdue.some((row) => row.id === target.id)).toBe(false);
    expect(after.cancelled.some((row) => row.id === other.id)).toBe(true);
  });

  it('el negocio puede crear una tarea manual para un cliente', async () => {
    const customer = (await json(await call('/api/admin/customers'))).customers[0];
    const response = await call('/api/admin/followups', {
      method: 'POST',
      body: JSON.stringify({
        customerId: customer.id,
        reason: 'Llamar el lunes',
        scheduledAt: app.followups.today(),
      }),
    });
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.followup.origin).toBe('manual');
    expect(body.followup.status).toBe('pending');
  });
});

describe('no contactar', () => {
  it('cancela el seguimiento de marketing y deja al cliente marcado', async () => {
    const customer = (await json(await call('/api/admin/customers'))).customers.find(
      (row) => row.phone_e164 === '+18095551234',
    );
    const response = await call(`/api/admin/customers/${customer.id}/opt-out`, { method: 'POST' });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.customer.do_not_contact).toBe(true);
    expect(body.customer.automation_state).toBe('PAUSED');
    expect(body.cancelled).toBeGreaterThan(0);

    const followups = await json(await call('/api/admin/followups'));
    const pending = [...followups.today, ...followups.overdue, ...followups.upcoming].filter(
      (row) => row.customer_id === customer.id && row.status === 'pending',
    );
    // Solo sobrevive lo manual: la decisión del cliente manda sobre el plan.
    expect(pending.every((row) => row.origin === 'manual')).toBe(true);

    const back = await call(`/api/admin/customers/${customer.id}/opt-in`, { method: 'POST' });
    expect((await json(back)).customer.do_not_contact).toBe(false);
  });
});

/**
 * PREFERENCIAS DE PEDIDO del cliente.
 *
 * Lo que se repite en cada pedido (frasco, cantidad, forma de pago y nota) se
 * guarda CON el cliente para que el próximo pedido solo tenga que confirmar la
 * cantidad. Estas pruebas fijan la frontera: lo que no existe no se guarda.
 */
describe('preferencias de pedido del cliente', () => {
  const clienteLuis = async () => {
    const data = await json(await call('/api/admin/customers'));
    return data.customers.find((row) => row.phone_e164 === '+18095551234');
  };

  it('se guardan con el cliente y sobreviven al siguiente pedido', async () => {
    const customer = await clienteLuis();
    const response = await call(`/api/admin/customers/${customer.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        orderPrefs: {
          variantId: 'capsules_15',
          quantity: 3,
          paymentMethod: 'TRANSFER',
          note: 'Entregar después de las 5 pm',
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.customer.orderPrefs).toMatchObject({
      variant_id: 'capsules_15',
      quantity: 3,
      payment_method: 'TRANSFER',
      location_id: null,
    });
    expect(body.customer.orderPrefs.note).toContain('5 pm');
    expect(body.customer.orderPrefs.updated_at).toBeTruthy();

    // Y se leen tal cual en el perfil 360 (que es de donde los toma el panel).
    const profile = await json(await call(`/api/admin/customers/${customer.id}`));
    expect(profile.customer.orderPrefs.quantity).toBe(3);

    // Un pedido nuevo NO pisa las preferencias por su cuenta.
    const venta = await buy({
      phone: '+1 (809) 555-1234',
      variantId: 'capsules_5',
      quantity: 1,
      status: 'confirmado',
      date: new Date().toISOString(),
    });
    expect(venta.status).toBe(201);
    const despues = await json(await call(`/api/admin/customers/${customer.id}`));
    expect(despues.customer.orderPrefs.quantity).toBe(3);
    expect(despues.customer.orderPrefs.variant_id).toBe('capsules_15');
  });

  it('lo que no existe no se guarda: frasco, cantidad, pago y ubicación se validan', async () => {
    const customer = await clienteLuis();
    const antes = (await json(await call(`/api/admin/customers/${customer.id}`))).customer.orderPrefs;

    const malos = [
      { variantId: 'frasco-inventado', quantity: 1 },
      { variantId: 'capsules_10', quantity: 0 },
      { variantId: 'capsules_10', quantity: 99999 },
      { variantId: 'capsules_10', quantity: 1, paymentMethod: 'BITCOIN' },
      // Una ubicación que no es de ESTE cliente tampoco vale.
      { variantId: 'capsules_10', quantity: 1, locationId: 'loc_inventada' },
    ];
    for (const malo of malos) {
      const response = await call(`/api/admin/customers/${customer.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ orderPrefs: malo }),
      });
      expect(response.status).toBe(422);
      expect((await json(response)).error).toBe('invalid_order_prefs');
    }

    // Ni una de las intentonas cambió lo que había guardado.
    const despues = (await json(await call(`/api/admin/customers/${customer.id}`))).customer.orderPrefs;
    expect(despues).toEqual(antes);
  });

  it('se pueden borrar con `null` (y sin nada dentro no se guarda un hueco)', async () => {
    const customer = await clienteLuis();
    const vacias = await call(`/api/admin/customers/${customer.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ orderPrefs: { variantId: '', quantity: null, paymentMethod: null, note: '   ' } }),
    });
    expect(vacias.status).toBe(200);
    // Sin nada dentro son preferencias VACÍAS: se guardan como null, no como hueco.
    expect((await json(vacias)).customer.orderPrefs).toBe(null);

    const puestas = await call(`/api/admin/customers/${customer.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ orderPrefs: { variantId: 'capsules_30', quantity: 2, paymentMethod: 'CASH' } }),
    });
    expect((await json(puestas)).customer.orderPrefs.variant_id).toBe('capsules_30');

    const borradas = await call(`/api/admin/customers/${customer.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ orderPrefs: null }),
    });
    const sinPreferencias = await json(borradas);
    expect(sinPreferencias.customer.orderPrefs).toBe(null);
    // Y lo demás del cliente sigue intacto.
    expect(sinPreferencias.customer.phone_e164).toBe('+18095551234');
  });
});
