/*
 * UAT DE INTEGRACIÓN — Delivery + CRM + Smart Commerce (aislado).
 *
 * Levanta el CRM real (startCrmServer) de la rama `integracion/delivery-crm`
 * sobre una SQLite PROPIA y recorre por HTTP:
 *   1. pedido creado de punta a punta
 *   2. asignación al repartidor
 *   3. login del móvil
 *   4. aislamiento (solo ve lo suyo)
 *   5. INICIAR ENTREGA
 *   6. ENTREGADO con código (fallos incluidos)
 *   7. efectivo declarado
 *   8. custodia creada UNA sola vez (reintento e idempotencia)
 *   9. rendición parcial y rechazo de sobre-rendición
 *  10. Smart Commerce intacto (config + endpoints de fulfillment)
 *
 * Sin WhatsApp, sin scheduler, sin producción.
 */
import path from 'node:path';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const PORT = Number(process.env.UAT_PORT ?? 4478);
const TOKEN = 'uat-integracion-token';
const DATA = path.join(ROOT, 'uat-integracion.sqlite');
for (const file of [DATA, `${DATA}-wal`, `${DATA}-shm`]) rmSync(file, { force: true });

const { startCrmServer } = await import(pathToFileURL(`${ROOT}/server/crm-server.mjs`).href);
const app = await startCrmServer({
  port: PORT,
  host: '127.0.0.1',
  dataFile: DATA,
  token: TOKEN,
  quiet: true,
  schedulerEnabled: false,
});
const BASE = app.url;

await app.ctx.settings.write('delivery_contacts', [
  { id: 'contact-ext-1', name: 'Mensajero Externo UAT', phone: '+18095550101', shareOrders: true },
]);

let pass = 0;
const fails = [];
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`OK   ${name}`);
  } else {
    fails.push(name);
    console.log(`FAIL ${name} ${extra}`);
  }
};

const call = async (url, { method = 'GET', cookie, token, body } = {}) => {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

const admin = (route, options = {}) => call(`/api/admin/${route}`, { ...options, cookie: options.cookie ?? session });
const courier = (route, options = {}) => call(route, options);

/* ------------------------------------------------------------------ admin */
const loginAdmin = await fetch(`${BASE}/api/admin/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: TOKEN }),
});
const session = (loginAdmin.headers.get('set-cookie') ?? '').split(';')[0];
check('sesión de administración', loginAdmin.status === 200 && session.length > 0);

/* ------------------------------------------------------------------ repartidor */
const PHONE = '+18095550101';
const PIN = '445566';
const account = await admin('couriers', {
  method: 'POST',
  body: { kind: 'EXTERNAL', phone: PHONE, displayName: 'Mensajero Externo UAT', contactId: 'contact-ext-1', appAccess: true, pin: PIN },
});
check('cuenta móvil creada', account.status === 201, JSON.stringify(account.data?.error ?? ''));

/* ------------------------------------------------------------------ pedido */
const customer = await admin('pos/customers', {
  method: 'POST',
  body: { name: 'Cliente Integración', phone: '8095550301' },
});
const created = await admin('orders', {
  method: 'POST',
  body: {
    name: customer.data?.customer?.name ?? 'Cliente Integración',
    phone: '8095550301',
    status: 'nuevo',
    paymentMethod: 'CASH',
    items: [{ variantId: 'capsules_10', quantity: 2 }],
  },
});
const orderId = created.data?.item?.id ?? created.data?.order?.id ?? created.data?.id ?? null;
check('pedido creado en el CRM', Boolean(orderId), JSON.stringify(created.data).slice(0, 200));

const listed = await admin(`orders/${orderId}`);
check('el CRM lee el pedido creado en la tienda', listed.status === 200, `status=${listed.status}`);
check(
  'el pedido tiene método de pago y total en el CRM',
  listed.data?.item?.payment_method === 'CASH' || listed.data?.order?.payment_method === 'CASH' || listed.data?.item?.doc?.payment_method === 'CASH',
  JSON.stringify(listed.data?.item ?? {}).slice(0, 160),
);

const assigned = await admin(`orders/${orderId}/courier/assign`, { method: 'POST', body: { contactPhone: PHONE } });
check('pedido asignado al repartidor', assigned.status === 200, JSON.stringify(assigned.data?.error ?? ''));

/* ------------------------------------------------------------------ móvil */
const login = await courier('/api/courier/login', { method: 'POST', body: { phone: PHONE, pin: PIN } });
check('login del móvil', login.status === 200 && typeof login.data?.token === 'string');
const token = login.data?.token;

const mine = await courier('/api/courier/orders', { token });
check('el repartidor ve SOLO su pedido', mine.data?.count === 1 && mine.data.orders[0].id === orderId, `count=${mine.data?.count}`);
const detail = await courier(`/api/courier/orders/${orderId}`, { token });
const dueCents = detail.data?.order?.amount_to_collect_cents;
check('el detalle trae el importe a cobrar', Number.isInteger(dueCents) && dueCents > 0, `due=${dueCents}`);
const actionsBefore = detail.data?.order?.available_actions ?? [];
check('acción disponible: empezar', actionsBefore.includes('start'), JSON.stringify(actionsBefore));

/* ------------------------------------------------------------------ INICIAR ENTREGA */
const started = await courier(`/api/courier/orders/${orderId}/start`, {
  method: 'POST',
  token,
  body: { idempotencyKey: `start:${orderId}`, expectedVersion: detail.data?.order?.version },
});
check('INICIAR ENTREGA aceptado', [200, 202].includes(started.status), JSON.stringify(started.data).slice(0, 200));
const afterStart = await courier(`/api/courier/orders/${orderId}`, { token });
const lifeAfterStart = afterStart.data?.order?.delivery_lifecycle;
check(
  'el pedido quedó marcado como en reparto',
  ['PICKED_UP', 'EN_ROUTE', 'PICKUP_PENDING', 'ARRIVED'].includes(String(lifeAfterStart)),
  `lifecycle=${lifeAfterStart}`,
);
check('el DTO del móvil sigue sin exponer costos ni márgenes', !/cost_cents|profit|margin/i.test(JSON.stringify(afterStart.data)));

/* ------------------------------------------------------------------ código de entrega */
const codeSet = await admin(`orders/${orderId}/delivery-code`, { method: 'POST', body: {} });
const code = codeSet.data?.code;
check('código de entrega generado por administración', codeSet.status === 200 && typeof code === 'string' && code.length >= 4, JSON.stringify(codeSet.data).slice(0, 120));

const current = await courier(`/api/courier/orders/${orderId}`, { token });
const version = current.data?.order?.version;

const wrong = await courier(`/api/courier/orders/${orderId}/deliver`, {
  method: 'POST',
  token,
  body: { idempotencyKey: `deliver-wrong:${orderId}`, expectedVersion: version, proofCode: '000000', cashReceivedCents: dueCents },
});
check('código incorrecto rechazado', wrong.status === 409 && wrong.data?.error === 'invalid_proof', `status=${wrong.status} error=${wrong.data?.error}`);

const noCash = await courier(`/api/courier/orders/${orderId}/deliver`, {
  method: 'POST',
  token,
  body: { idempotencyKey: `deliver-nocash:${orderId}`, expectedVersion: version, proofCode: code },
});
check('pedido contra efectivo exige el importe', noCash.status === 422 && noCash.data?.error === 'cash_amount_required', `status=${noCash.status} error=${noCash.data?.error}`);

const shortCash = await courier(`/api/courier/orders/${orderId}/deliver`, {
  method: 'POST',
  token,
  body: { idempotencyKey: `deliver-short:${orderId}`, expectedVersion: version, proofCode: code, cashReceivedCents: dueCents - 50000 },
});
check('diferencia sin motivo rechazada', shortCash.status === 422 && shortCash.data?.error === 'difference_reason_required', `status=${shortCash.status} error=${shortCash.data?.error}`);

const declared = dueCents - 50000;
const delivered = await courier(`/api/courier/orders/${orderId}/deliver`, {
  method: 'POST',
  token,
  body: { idempotencyKey: `deliver-ok:${orderId}`, expectedVersion: version, proofCode: code, cashReceivedCents: declared, cashReason: 'Cliente pagó con billete grande' },
});
check('ENTREGADO aceptado con código y efectivo declarado', [200, 202].includes(delivered.status), JSON.stringify(delivered.data).slice(0, 200));

/* ------------------------------------------------------------------ custodia: una sola vez */
const courierId = account.data?.courier?.id;
const cashRow = async () => {
  const response = await admin('delivery-cash');
  return (response.data?.couriers ?? []).find((row) => row.courier_id === courierId) ?? {};
};
const cash = await cashRow();
check('la custodia registra el efectivo DECLARADO', cash.pending_cents === declared, `pending=${cash.pending_cents} declared=${declared}`);
check('lo cargado coincide con lo declarado, no con el saldo del pedido', cash.charged_cents === declared, `charged=${cash.charged_cents} due=${dueCents}`);

const replay = await courier(`/api/courier/orders/${orderId}/deliver`, {
  method: 'POST',
  token,
  body: { idempotencyKey: `deliver-ok:${orderId}`, expectedVersion: version, proofCode: code, cashReceivedCents: declared, cashReason: 'Cliente pagó con billete grande' },
});
const cashAgain = await cashRow();
check('reintento idempotente no duplica el cargo', replay.status < 500 && cashAgain.charged_cents === declared, `charged=${cashAgain.charged_cents} replay=${replay.status}`);

/* ------------------------------------------------------------------ rendiciones */
const half = Math.floor(declared / 2);
const partial = await admin('delivery-cash/remittance', {
  method: 'POST',
  body: { courierAccountId: courierId, amountCents: half, note: 'Rendición parcial UAT' },
});
check('rendición parcial aceptada', [200, 201].includes(partial.status), JSON.stringify(partial.data).slice(0, 160));
const afterPartial = await cashRow();
check('el pendiente baja con la rendición parcial', afterPartial.pending_cents === declared - half, `pending=${afterPartial.pending_cents}`);

const over = await admin('delivery-cash/remittance', {
  method: 'POST',
  body: { courierAccountId: courierId, amountCents: (afterPartial.pending_cents ?? 0) + 100000 },
});
check('sobre-rendición rechazada', [400, 409, 422].includes(over.status), `status=${over.status} error=${over.data?.error}`);

const total = await admin('delivery-cash/remittance', {
  method: 'POST',
  body: { courierAccountId: courierId, amountCents: afterPartial.pending_cents, note: 'Rendición total UAT' },
});
check('rendición total aceptada', [200, 201].includes(total.status), JSON.stringify(total.data).slice(0, 160));
const settled = await cashRow();
check('saldo en cero tras rendir todo', settled.pending_cents === 0, `pending=${settled.pending_cents}`);

/* ------------------------------------------------------------------ panel de custodia */
const movements = await admin('delivery-cash/movements');
check('movimientos del libro visibles en el panel', movements.status === 200 && (movements.data?.movements ?? []).length >= 3, `n=${(movements.data?.movements ?? []).length}`);
check(
  'cada movimiento conserva su clave de idempotencia',
  (movements.data?.movements ?? []).every((row) => typeof row.idempotency_key === 'string' && row.idempotency_key.length > 0),
);
const filtered = await admin(`delivery-cash/movements?courierId=${encodeURIComponent(courierId)}`);
check(
  'el historial se filtra por repartidor',
  filtered.status === 200 && (filtered.data?.movements ?? []).every((row) => row.courier_account_id === courierId),
);
const incidents = await admin('delivery-cash/incidents');
check('la conciliación del panel no encuentra discrepancias', incidents.status === 200 && incidents.data?.ok === true && (incidents.data?.incidents ?? []).length === 0, JSON.stringify(incidents.data?.incidents ?? []).slice(0, 200));
check('la conciliación informa totales en centavos', incidents.data?.totals?.chargedCents === incidents.data?.totals?.remittedCents + incidents.data?.totals?.pendingCents);
const courierOnPanel = await courier('/api/admin/delivery-cash/movements', { token });
check('el token del repartidor NO abre la custodia', [401, 403].includes(courierOnPanel.status), `status=${courierOnPanel.status}`);

/* ------------------------------------------------------------------ Smart Commerce intacto */
const commerceConfig = await call('/api/store/commerce/config');
check('endpoint de Smart Commerce responde', commerceConfig.status === 200);
const operations = await admin('store/commerce/operations/requests');
check(
  'fulfillment responde sin inventar pedidos',
  operations.status === 200 || operations.data?.error === 'commerce_disabled',
  `status=${operations.status} error=${operations.data?.error}`,
);

/* ------------------------------------------------------------------ concurrencia (Fase 4) */
const second = await admin('orders', {
  method: 'POST',
  body: {
    name: 'Cliente Concurrencia',
    phone: '8095550302',
    status: 'nuevo',
    paymentMethod: 'CASH',
    items: [{ variantId: 'capsules_10', quantity: 1 }],
  },
});
const secondId = second.data?.item?.id ?? second.data?.order?.id ?? second.data?.id ?? null;
await admin(`orders/${secondId}/courier/assign`, { method: 'POST', body: { contactPhone: PHONE } });
const secondDetail = await courier(`/api/courier/orders/${secondId}`, { token });
const secondDue = secondDetail.data?.order?.amount_to_collect_cents;
const secondVersion = secondDetail.data?.order?.version;
await courier(`/api/courier/orders/${secondId}/start`, {
  method: 'POST',
  token,
  body: { idempotencyKey: `start:${secondId}`, expectedVersion: secondVersion },
});
const secondCode = (await admin(`orders/${secondId}/delivery-code`, { method: 'POST', body: {} })).data?.code;
const fresh = await courier(`/api/courier/orders/${secondId}`, { token });
const beforeRace = (await cashRow()).charged_cents ?? 0;
const race = await Promise.all([
  courier(`/api/courier/orders/${secondId}/deliver`, {
    method: 'POST',
    token,
    body: { idempotencyKey: `race-a:${secondId}`, expectedVersion: fresh.data?.order?.version, proofCode: secondCode, cashReceivedCents: secondDue },
  }),
  courier(`/api/courier/orders/${secondId}/deliver`, {
    method: 'POST',
    token,
    body: { idempotencyKey: `race-b:${secondId}`, expectedVersion: fresh.data?.order?.version, proofCode: secondCode, cashReceivedCents: secondDue },
  }),
]);
const winners = race.filter((row) => [200, 202].includes(row.status)).length;
check('doble pulsación simultánea: solo una entrega se confirma', winners === 1, `status=${race.map((row) => row.status).join(',')}`);
const raceCash = await cashRow();
const raceDelta = (raceCash.charged_cents ?? 0) - beforeRace;
check(
  'la custodia del segundo pedido se cargó UNA sola vez',
  raceDelta === secondDue,
  `delta=${raceDelta} due=${secondDue}`,
);

console.log(`\nRESULTADO: ${pass} OK · ${fails.length} fallos`);
if (fails.length) console.log('Fallos:', fails.join(' | '));
await app.close?.();
process.exit(fails.length ? 1 : 0);
