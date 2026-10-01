// @vitest-environment node
/**
 * S6 — SALES WORKSPACE: estado comercial derivado, ficha 360, métricas por
 * período sin doble conteo y auditoría comercial.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';
import { AUDIT_ACTIONS } from '../server/audit.mjs';
import { COMMERCIAL_STATES, CUSTOMER_STAGES, deriveCommercialState, resolveCustomerStage } from '../server/customers.mjs';
import { DEFAULT_TIME_ZONE, dayIn } from '../server/followups.mjs';
import { isCompletedPurchaseStatus } from '../server/orders.mjs';

const TOKEN = 'clave-s6-123';
const APP_SECRET = 'secreto-s6';
const PLAN = [{ key: 'd1', day: 1, type: 'thanks', reason: 'Gracias' }];

/**
 * Un instante que cae DENTRO del día de negocio (`America/Santo_Domingo`).
 *
 * Los pedidos de este archivo se crean con esta fecha a propósito: si se deja
 * que el servidor los selle con `new Date()` (UTC), entre las 20:00 y las 24:00
 * de RD la marca cae en el día ISO siguiente y el pedido queda fuera de la
 * ventana de «hoy» (que es el día del negocio). El test no adivina qué día es
 * para el negocio: lo calcula con el mismo helper que usa el motor (`dayIn`).
 */
const instanteDelDiaDeNegocio = () => `${dayIn(new Date(), DEFAULT_TIME_ZONE)}T12:00:00.000Z`;

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN123',
  sent: [],
  async sendText(to, body) {
    mockWhatsApp.sent.push({ to, body });
    return { ok: true, status: 200, messageId: `wamid.W${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    mockWhatsApp.sent.push({ to, template });
    return { ok: true, status: 200, messageId: `wamid.WT${mockWhatsApp.sent.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

let tmpDir;
let app;
let cookie = '';

const call = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
  });

const json = async (response) => JSON.parse(await response.text());

async function inbound(id, body, from) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: `Cliente ${from.slice(-4)}` }, wa_id: from }],
              messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  await fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
}

async function waitForCustomer(phone) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const data = await json(await call('/api/admin/customers'));
    const found = data.customers.find((row) => row.phone_e164 === phone);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('el cliente no apareció');
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-s6-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    followupPlan: PLAN,
    whatsapp: mockWhatsApp,
    schedulerEnabled: false,
  });
  const login = await call('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('estado comercial del cliente (derivado, no inventado)', () => {
  it('la función pura sigue las reglas del encargo', () => {
    expect(COMMERCIAL_STATES).toContain('PEDIDO_CREADO');
    // Sin hechos: nuevo.
    expect(deriveCommercialState({ customer: {}, purchases: [], followups: [], hasInbound: false })).toBe('NUEVO');
    // Escribió, pero no es «interesado» solo por escribir.
    expect(deriveCommercialState({ customer: {}, hasInbound: true })).toBe('EN_CONVERSACION');
    // Pedido pendiente.
    expect(deriveCommercialState({ customer: {}, purchases: [{ type: 'order_intent', status: 'nuevo' }] })).toBe(
      'PEDIDO_CREADO',
    );
    // Pedido confirmado.
    expect(
      deriveCommercialState({ customer: {}, purchases: [{ type: 'order_intent', status: 'en_preparacion' }] }),
    ).toBe('CONFIRMADO');
    // Entregado con tarea pendiente → en seguimiento; sin tarea → entregado.
    const entregado = [{ type: 'order_intent', status: 'entregado' }];
    expect(deriveCommercialState({ customer: {}, purchases: entregado, followups: [{ status: 'pending' }] })).toBe(
      'SEGUIMIENTO',
    );
    expect(deriveCommercialState({ customer: {}, purchases: entregado, followups: [] })).toBe('ENTREGADO');
    // Dos entregas → recompra.
    expect(deriveCommercialState({ customer: {}, purchases: [...entregado, ...entregado] })).toBe('RECOMPRA');
    // Manual manda (y solo INTERESADO/PERDIDO son manuales).
    expect(deriveCommercialState({ customer: { commercial_state_manual: 'PERDIDO' }, purchases: entregado })).toBe(
      'PERDIDO',
    );
  });

  it('el estado se actualiza con los hechos reales del cliente', async () => {
    await inbound('wamid.S6-1', 'Hola, quiero información', '18095550606');
    const customer = await waitForCustomer('+18095550606');
    expect(customer.commercial_state).toBe('EN_CONVERSACION');

    // Pedido pendiente → PEDIDO_CREADO.
    const order = await json(
      await call('/api/admin/orders', {
        method: 'POST',
        body: JSON.stringify({
          customerId: customer.id,
          items: [{ variantId: 'capsules_10', quantity: 1 }],
          paymentMethod: 'CASH',
          // Fecha explícita del día de negocio (no la «de ahora mismo» en UTC).
          date: instanteDelDiaDeNegocio(),
        }),
      }),
    );
    let profile = await json(await call(`/api/admin/customers/${customer.id}`));
    expect(profile.commercial_state).toBe('PEDIDO_CREADO');

    // Entregado → ENTREGADO/SEGUIMIENTO (hay tarea pendiente del plan).
    await call(`/api/admin/items/${order.item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'entregado' }) });
    profile = await json(await call(`/api/admin/customers/${customer.id}`));
    expect(['ENTREGADO', 'SEGUIMIENTO']).toContain(profile.commercial_state);

    // Cambio manual: INTERESADO (juicio del vendedor) manda.
    const manual = await call(`/api/admin/customers/${customer.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ commercialState: 'INTERESADO' }),
    });
    expect((await json(manual)).customer.commercial_state).toBe('INTERESADO');

    // Un estado que es un HECHO no se puede poner a mano.
    const invalid = await call(`/api/admin/customers/${customer.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ commercialState: 'ENTREGADO' }),
    });
    expect(invalid.status).toBe(422);
    expect((await json(invalid)).error).toBe('not_manual');

    // Se vuelve al derivado.
    await call(`/api/admin/customers/${customer.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ commercialState: null }),
    });
    profile = await json(await call(`/api/admin/customers/${customer.id}`));
    expect(profile.customer.commercial_state_manual).toBeNull();
  });
});

describe('customerStage compatible', () => {
  it('la función pura no confunde seguimiento ni pedido creado con cliente', () => {
    expect(CUSTOMER_STAGES).toEqual(['PROSPECT', 'INTERESTED', 'CUSTOMER', 'INACTIVE']);
    expect(resolveCustomerStage({ customer: {}, purchases: [] })).toMatchObject({ stage: 'PROSPECT' });
    expect(resolveCustomerStage({ customer: { customer_stage_manual: 'INTERESTED' }, purchases: [] })).toMatchObject({
      stage: 'INTERESTED',
      source: 'manual',
    });
    expect(resolveCustomerStage({ customer: {}, purchases: [{ type: 'order_intent', status: 'nuevo' }] })).toMatchObject({
      stage: 'PROSPECT',
    });
    expect(resolveCustomerStage({ customer: {}, purchases: [{ type: 'order_intent', status: 'cancelado' }] })).toMatchObject({
      stage: 'PROSPECT',
    });
    expect(resolveCustomerStage({ customer: {}, purchases: [{ type: 'order_intent', status: 'entregado' }] })).toMatchObject({
      stage: 'CUSTOMER',
      reason: 'pedido_entregado',
    });
    expect(
      resolveCustomerStage({
        customer: { customer_stage_manual: 'PROSPECT' },
        purchases: [{ type: 'order_intent', status: 'entregado' }],
      }),
    ).toMatchObject({ stage: 'CUSTOMER', source: 'delivered_purchase' });
    expect(isCompletedPurchaseStatus('entregado')).toBe(true);
  });

  it('nuevo cliente → PROSPECT, manual → INTERESTED y compra entregada → CUSTOMER', async () => {
    await inbound('wamid.S6-STAGE-1', 'Hola, estoy viendo opciones', '18095550616');
    const customer = await waitForCustomer('+18095550616');
    expect(customer.customerStage).toBe('PROSPECT');

    const manual = await json(
      await call(`/api/admin/customers/${customer.id}/stage`, {
        method: 'POST',
        body: JSON.stringify({ stage: 'INTERESTED', reason: 'Pidió precios' }),
      }),
    );
    expect(manual.to).toBe('INTERESTED');
    let profile = await json(await call(`/api/admin/customers/${customer.id}`));
    expect(profile.customerStage).toBe('INTERESTED');
    expect(profile.stageHistory[0]).toMatchObject({ from_stage: 'PROSPECT', to_stage: 'INTERESTED' });

    await call(`/api/admin/customers/${customer.id}/stage`, {
      method: 'POST',
      body: JSON.stringify({ stage: null, reason: 'Volver a automático' }),
    });
    profile = await json(await call(`/api/admin/customers/${customer.id}`));
    expect(profile.customerStage).toBe('PROSPECT');

    const order = await json(
      await call('/api/admin/orders', {
        method: 'POST',
        body: JSON.stringify({
          customerId: customer.id,
          items: [{ variantId: 'capsules_5', quantity: 1 }],
          paymentMethod: 'CASH',
          status: 'entregado',
          date: instanteDelDiaDeNegocio(),
        }),
      }),
    );
    expect(order.order.status).toBe('entregado');
    profile = await json(await call(`/api/admin/customers/${customer.id}`));
    expect(profile.customerStage).toBe('CUSTOMER');

    for (const stage of ['PROSPECT', 'INTERESTED']) {
      const downgrade = await call(`/api/admin/customers/${customer.id}/stage`, {
        method: 'POST',
        body: JSON.stringify({ stage, reason: 'No debe degradar compradores' }),
      });
      expect(downgrade.status).toBe(409);
      expect((await json(downgrade)).error).toBe('completed_purchase_stage_conflict');
    }
    profile = await json(await call(`/api/admin/customers/${customer.id}`));
    expect(profile.customerStage).toBe('CUSTOMER');

    await call('/api/admin/followups', {
      method: 'POST',
      body: JSON.stringify({ customerId: customer.id, reason: 'Seguimiento vencido', scheduledAt: '2020-01-01' }),
    });
    profile = await json(await call(`/api/admin/customers/${customer.id}`));
    expect(profile.customerStage).toBe('CUSTOMER');
  });

  it('tags múltiples, dry-run y auditoría de etapa funcionan sin migrar clientes', async () => {
    const customers = await json(await call('/api/admin/customers'));
    const customer = customers.customers.find((row) => row.phone_e164 === '+18095550616');

    const tags = await json(await call('/api/admin/customer-tags'));
    expect(tags.tags.map((tag) => tag.label)).toEqual(
      expect.arrayContaining(['VIP', 'Recurrente', 'No responde', 'Alta prioridad', 'Primera compra', 'Recompra', 'Pago contra entrega']),
    );
    const vip = tags.tags.find((tag) => tag.label === 'VIP');
    const priority = tags.tags.find((tag) => tag.label === 'Alta prioridad');

    await call(`/api/admin/customers/${customer.id}/tags`, { method: 'POST', body: JSON.stringify({ tagId: vip.id }) });
    await call(`/api/admin/customers/${customer.id}/tags`, { method: 'POST', body: JSON.stringify({ tagId: priority.id }) });
    let customerTags = await json(await call(`/api/admin/customers/${customer.id}/tags`));
    expect(customerTags.tags.map((tag) => tag.label).sort()).toEqual(['Alta prioridad', 'VIP']);

    await call(`/api/admin/customers/${customer.id}/tags?tagId=${encodeURIComponent(vip.id)}`, { method: 'DELETE' });
    customerTags = await json(await call(`/api/admin/customers/${customer.id}/tags`));
    expect(customerTags.tags.map((tag) => tag.label)).toEqual(['Alta prioridad']);

    const reassign = await json(
      await call(`/api/admin/customers/${customer.id}/tags`, { method: 'POST', body: JSON.stringify({ tagId: vip.id }) }),
    );
    expect(reassign).toMatchObject({ ok: true, duplicate: false });
    expect(reassign.reactivated).toBe(true);
    customerTags = await json(await call(`/api/admin/customers/${customer.id}/tags`));
    expect(customerTags.tags.map((tag) => tag.label).sort()).toEqual(['Alta prioridad', 'VIP']);

    const beforeAudit = await json(await call('/api/admin/audit?entity=customer&limit=200'));
    const missingRemove = await json(await call(`/api/admin/customers/${customer.id}/tags?tagId=tag-no-existe`, { method: 'DELETE' }));
    expect(missingRemove).toMatchObject({ ok: true, removed: false, status: 'not_found' });
    await call(`/api/admin/customers/${customer.id}/tags?tagId=${encodeURIComponent(vip.id)}`, { method: 'DELETE' });
    const alreadyRemoved = await json(await call(`/api/admin/customers/${customer.id}/tags?tagId=${encodeURIComponent(vip.id)}`, { method: 'DELETE' }));
    expect(alreadyRemoved).toMatchObject({ ok: true, removed: false, status: 'not_found' });
    const afterAudit = await json(await call('/api/admin/audit?entity=customer&limit=200'));
    const removedEventsBefore = beforeAudit.entries.filter((row) => row.action === 'customer.tag_removed').length;
    const removedEventsAfter = afterAudit.entries.filter((row) => row.action === 'customer.tag_removed').length;
    expect(removedEventsAfter).toBe(removedEventsBefore + 1);

    const dryRun = await json(await call('/api/admin/customers/stage-dry-run'));
    const mine = dryRun.report.find((row) => row.customerId === customer.id);
    expect(mine).toMatchObject({ customerStage: 'CUSTOMER', wouldWrite: false });
    expect(dryRun.rule).toMatch(/order_intent.*entregado/i);

    const audit = await json(await call('/api/admin/audit?entity=customer'));
    expect(audit.entries.map((row) => row.action)).toEqual(expect.arrayContaining(['customer.stage_changed', 'customer.tag_assigned', 'customer.tag_removed']));
  });
});

describe('ficha 360 del cliente', () => {
  it('reúne resumen, whatsapp, pedidos, seguimientos y programados', async () => {
    const customers = await json(await call('/api/admin/customers'));
    const customer = customers.customers.find((row) => row.phone_e164 === '+18095550606');
    const profile = await json(await call(`/api/admin/customers/${customer.id}`));

    expect(profile.customer.id).toBe(customer.id);
    expect(profile.totals.total_purchases).toBe(1);
    expect(profile.totals.total_spent).toBe(2500);
    expect(profile.conversation.id).toBeTruthy();
    expect(Array.isArray(profile.messages)).toBe(true);
    expect(profile.followups.length).toBeGreaterThanOrEqual(1);
    expect(profile.nextFollowup).toBeTruthy();
    expect(Array.isArray(profile.scheduled)).toBe(true);
    expect(profile.commercial_state).toBeTruthy();

    // Un mensaje programado aparece en la ficha (no duplicado en otra parte).
    await call('/api/admin/scheduled', {
      method: 'POST',
      body: JSON.stringify({
        customerId: customer.id,
        conversationId: profile.conversation.id,
        scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
        text: 'Recordatorio de recompra',
        idempotencyKey: 'sm:s6:ficha',
      }),
    });
    const after = await json(await call(`/api/admin/customers/${customer.id}`));
    expect(after.scheduled.some((row) => row.idempotency_key === 'sm:s6:ficha')).toBe(true);
  });
});

describe('métricas por período (sin doble conteo)', () => {
  it('cuenta cada pedido UNA vez, por su fecha', async () => {
    const data = await json(await call('/api/admin/data'));
    const orders = data.items.filter((item) => item.type === 'order_intent');
    const delivered = orders.filter((item) => item.status === 'entregado');

    const body = await json(await call('/api/admin/metrics?period=hoy'));
    const metrics = body.metrics;
    expect(metrics.period.name).toBe('hoy');
    // La ventana de «hoy» es la del día de NEGOCIO (America/Santo_Domingo): el
    // test no la adivina, se la pregunta al servidor y comprueba que es la del
    // negocio — el mismo día que calcula `dayIn`, no el día UTC.
    const { startDay, endDay } = metrics.period;
    expect(endDay).toBe(dayIn(new Date(), DEFAULT_TIME_ZONE));
    expect(startDay).toBe(endDay);
    // Los pedidos de este archivo llevan fecha del día de negocio → cuentan hoy.
    expect(orders.length).toBeGreaterThanOrEqual(1);
    expect(metrics.byPeriod.pedidosCreados).toBe(orders.length);

    // La fecha de ENTREGA la pone el servidor al cambiar el estado
    // (`new Date().toISOString()`, en UTC) y NO se puede fijar desde la API: si
    // esa marca cae en el día ISO siguiente (entre las 20:00 y las 24:00 de RD),
    // el pedido todavía no entra en el «hoy» del negocio. Lo que se comprueba es
    // que manda la ventana del servidor y que el importe cuadra con lo contado.
    const diaDeEntrega = new Date().toISOString().slice(0, 10); // UTC, igual que el servidor
    const entregadosEnVentana = diaDeEntrega >= startDay && diaDeEntrega <= endDay ? delivered : [];
    expect(metrics.byPeriod.pedidosEntregados).toBe(entregadosEnVentana.length);
    expect(metrics.byPeriod.ventas).toBe(
      entregadosEnVentana.reduce((sum, item) => sum + (Number(item.total) || 0), 0),
    );

    // Pedir lo mismo otra vez no cambia nada (no hay contadores que se sumen).
    const again = await json(await call('/api/admin/metrics?period=hoy'));
    expect(again.metrics.byPeriod).toEqual(metrics.byPeriod);
  });

  it('acepta hoy / 7d / 30d y por defecto 30d', async () => {
    const hoy = await json(await call('/api/admin/metrics?period=hoy'));
    const seven = await json(await call('/api/admin/metrics?period=7d'));
    expect(seven.metrics.period).toMatchObject({ name: '7d', days: 7 });
    const fallback = await json(await call('/api/admin/metrics?period=loquesea'));
    expect(fallback.metrics.period.name).toBe('30d');
    const month = await json(await call('/api/admin/metrics'));
    expect(month.metrics.period.days).toBe(30);
    // Todos los pedidos del archivo llevan fecha del día de negocio, así que los
    // tres períodos (que se solapan) tienen que contar EXACTAMENTE los mismos:
    // ni doble conteo ni pedidos que se caen por una ventana mal calculada.
    expect(hoy.metrics.byPeriod.pedidosCreados).toBeGreaterThanOrEqual(1);
    expect(seven.metrics.byPeriod.pedidosCreados).toBe(hoy.metrics.byPeriod.pedidosCreados);
    expect(month.metrics.byPeriod.pedidosCreados).toBe(hoy.metrics.byPeriod.pedidosCreados);
    expect(month.metrics.byPeriod.clientesPendientesDeSeguimiento).toBeGreaterThanOrEqual(0);
  });
});

describe('auditoría comercial', () => {
  it('registra pedidos, seguimientos y mensajes, y se puede consultar', async () => {
    const orders = await json(await call('/api/admin/audit?entity=order'));
    const actions = orders.entries.map((row) => row.action);
    expect(actions).toContain('order.created');
    expect(actions).toContain('order.status_changed');
    expect(orders.entries[0].created_at).toBeTruthy();

    const summary = await json(await call('/api/admin/audit'));
    expect(summary.summary.total).toBeGreaterThan(0);
    expect(Object.keys(summary.summary.byAction).every((action) => AUDIT_ACTIONS.includes(action))).toBe(true);
  });

  it('la auditoría no se puede llenar con acciones inventadas', () => {
    expect(AUDIT_ACTIONS).toContain('message.blocked');
    expect(AUDIT_ACTIONS).not.toContain('lo-que-sea');
  });
});

describe('HOY como centro operativo', () => {
  it('el panel recibe secciones accionables y el catálogo del servidor', async () => {
    const data = await json(await call('/api/admin/data'));
    expect(data.hoy.reference).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.hoy.seguimientosHoy + data.hoy.seguimientosVencidos).toBeGreaterThanOrEqual(0);
    expect(data.scheduled).toMatchObject({
      scheduled: expect.any(Number),
      blocked: expect.any(Number),
      failed: expect.any(Number),
    });
    expect(data.catalog).toHaveLength(7);
    expect(data.commercial.states).toEqual([...COMMERCIAL_STATES]);
    expect(data.orderStatuses.map((status) => status.value)).toContain('en_preparacion');
    expect(data.audit.total).toBeGreaterThan(0);
    // Los clientes llegan ya con su estado comercial (no hay que calcularlo).
    expect(data.customers.every((row) => Boolean(row.commercial_state))).toBe(true);
  });
});
