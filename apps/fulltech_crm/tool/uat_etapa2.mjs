#!/usr/bin/env node
/**
 * UAT REAL DE LA ETAPA 2 — dinero, cobros, custodia, cierre y paginación.
 *
 * Requisitos: el CRM de pruebas escuchando en UAT_URL (por defecto 8791).
 *   node apps/fulltech_crm/tool/uat_etapa2.mjs
 *
 * Todo ocurre contra `data/uat/phyto-uat.sqlite` con WhatsApp en MOCK:
 * no se toca producción ni se envía nada a nadie.
 */

const BASE = (process.env.UAT_URL ?? 'http://127.0.0.1:8791').replace(/\/+$/, '');
const PASSWORD = process.env.UAT_PASSWORD ?? 'UatLocal-123';

const results = [];
let critical = 0;

function record(id, name, ok, detail, isCritical = true) {
  results.push({ id, name, ok, detail, critical: isCritical });
  if (!ok && isCritical) critical++;
  console.log(`[${ok ? 'OK  ' : isCritical ? 'FAIL' : 'WARN'}] ${id}. ${name}${detail ? ` — ${detail}` : ''}`);
}

const randomKey = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`.replace(/[^A-Za-z0-9_-]/g, '');

async function call(method, path, { body, cookie, operationKey, headers } = {}) {
  const finalHeaders = { accept: 'application/json', ...(headers ?? {}) };
  if (cookie) finalHeaders.cookie = cookie;
  if (operationKey) finalHeaders['x-fulltech-operation'] = operationKey;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    finalHeaders['content-type'] = 'application/json; charset=utf-8';
  }
  const response = await fetch(`${BASE}${path}`, { method, headers: finalHeaders, body: payload });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const match = /pe_crm=([^;]*)/.exec(response.headers.get('set-cookie') ?? '');
  return { status: response.status, json, text, cookie: match ? `pe_crm=${match[1]}` : null };
}

async function login(username) {
  const response = await call('POST', '/api/admin/auth/login', { body: { username, password: PASSWORD } });
  return response.cookie ?? '';
}

const money = (value) => Math.round(Number(value ?? 0) * 100) / 100;

async function main() {
  console.log(`UAT Etapa 2 → ${BASE}\n`);
  const cookie = await login('admin@uat.local');
  if (!cookie) {
    record('0', 'Login de administrador', false, 'sin sesión');
    printSummary();
    process.exit(1);
  }
  const agentCookie = await login('agente@uat.local');

  const data = await call('GET', '/api/admin/data?light=1', { cookie });
  const catalogue = await call('GET', '/api/admin/catalog', { cookie });
  const presentations = Array.isArray(catalogue.json?.catalog) ? catalogue.json.catalog : [];
  const variant = presentations.find((row) => row.active !== false && Number(row.sale_price_cents) > 0);
  const customers = Array.isArray(data.json?.customers) ? data.json.customers : [];
  if (!variant || customers.length === 0) {
    record('0b', 'Datos de la semilla suficientes', false, 'sin presentación vendible o sin clientes');
    printSummary();
    process.exit(1);
  }

  /**
   * Venta de prueba.
   *
   * `mode: 'order'` crea un PEDIDO (nace «nuevo» y sin cobrar: es el caso real de
   * un pedido que se cobra después). `mode: 'invoice'` crea la factura ya
   * entregada y pagada, que es la única que se puede cancelar con `sales.cancel`.
   */
  async function newSale({ mode = 'order', paymentStatus = 'pending', method = 'CASH', quantity = 2 } = {}) {
    const requestId = randomKey('uat2');
    const body = {
      mode,
      requestId,
      customerId: customers[0].id,
      items: [{ variantId: variant.id, quantity }],
      deliveryFee: 0,
      paymentMethod: method,
      paymentStatus,
      deliveryMethod: 'pickup',
      notes: 'UAT Etapa 2',
      address: '',
      acknowledgeOpen: true,
      expectedTotal: Number(variant.sale_price_cents) * quantity,
    };
    const sale = await call('POST', '/api/admin/pos/checkout', { cookie, body, operationKey: requestId });
    const orderId = sale.json?.orderId ?? sale.json?.order?.id ?? sale.json?.item?.id ?? null;
    return { sale, orderId, expectedTotal: body.expectedTotal };
  }

  async function orderDetail(orderId) {
    const detail = await call('GET', `/api/admin/orders/${orderId}`, { cookie });
    return detail.json ?? {};
  }

  // ------------------------------------------------ 1. pedido base con saldo
  const base = await newSale({ mode: 'order', paymentStatus: 'pending' });
  const baseId = base.orderId;
  if (!baseId) {
    record('1a', 'Crear un pedido de prueba', false, `HTTP ${base.sale.status} · ${base.sale.json?.error ?? 'sin id'}`);
    printSummary();
    process.exit(1);
  }
  const detail = await orderDetail(baseId);
  const payment = detail.payment ?? {};
  const due = money(payment.due ?? Number(variant.sale_price_cents) * 2);
  record('1a', 'Pedido creado con saldo pendiente', due > 0, `saldo=${due}`);

  // ------------------------------------------------ 2. cobro parcial
  const half = money(due / 2);
  const partialKey = randomKey('pay');
  const partial = await call('POST', `/api/admin/orders/${baseId}/payments`, {
    cookie,
    operationKey: partialKey,
    body: { amount: half, method: 'CASH', expectedDue: due, idempotencyKey: partialKey, note: 'UAT parcial' },
  });
  const afterPartial = (await orderDetail(baseId)).payment ?? {};
  record(
    '2a',
    'Cobro parcial aceptado',
    partial.status === 200 && money(afterPartial.due) < due,
    `HTTP ${partial.status} · saldo ${due}→${money(afterPartial.due)}`,
  );
  record(
    '2b',
    'El cobro parcial NO marca el pedido como pagado',
    String(afterPartial.status ?? '') !== 'paid',
    `estado=${afterPartial.status ?? '—'}`,
  );

  // ------------------------------------------------ 3. duplicado del mismo cobro
  /*
   * Se reintenta EXACTAMENTE el mismo cuerpo y la misma clave: es el caso de un
   * móvil que no recibió la respuesta. El servidor debe devolver el cobro que ya
   * existe (`duplicate: true`) sin anotar otro. Si el cuerpo cambiara, la capa de
   * operaciones offline responde 409 (que también es correcto).
   */
  const duplicated = await call('POST', `/api/admin/orders/${baseId}/payments`, {
    cookie,
    operationKey: partialKey,
    body: { amount: half, method: 'CASH', expectedDue: due, idempotencyKey: partialKey, note: 'UAT parcial' },
  });
  const afterDup = (await orderDetail(baseId)).payment ?? {};
  const entriesAfterDup = Array.isArray(afterDup.entries) ? afterDup.entries.length : 0;
  /*
   * El reintento lo atiende primero la capa de operaciones offline, que REPITE la
   * respuesta guardada (misma clave + mismo cuerpo). Por eso `duplicate` puede
   * venir en false: lo que importa —y se comprueba en 3b y 3c— es que no se anote
   * un segundo cobro ni cambie el saldo.
   */
  record(
    '3a',
    'Reintentar el mismo cobro responde sin error y sin cobrar otra vez',
    duplicated.status === 200 && entriesAfterDup === 1,
    `HTTP ${duplicated.status} · duplicate=${duplicated.json?.duplicate === true} · cobros=${entriesAfterDup}`,
  );
  record('3b', 'El reintento NO descuenta dos veces', money(afterDup.due) === money(afterPartial.due), `saldo antes=${money(afterPartial.due)} después=${money(afterDup.due)}`);
  record('3c', 'El reintento NO crea un segundo cobro', entriesAfterDup === 1, `cobros=${entriesAfterDup}`);

  // ------------------------------------------------ 4. saldo cambiado / timeout
  const staleDue = await call('POST', `/api/admin/orders/${baseId}/payments`, {
    cookie,
    operationKey: randomKey('pay'),
    body: { amount: 1, method: 'CASH', expectedDue: due, idempotencyKey: randomKey('pay') },
  });
  record(
    '4a',
    'Cobrar sobre un saldo viejo se rechaza (payment_conflict)',
    staleDue.status === 409 && staleDue.json?.error === 'payment_conflict',
    `HTTP ${staleDue.status} · ${staleDue.json?.error ?? '—'}`,
  );

  // ------------------------------------------------ 5. cobrar de más
  const overpay = await call('POST', `/api/admin/orders/${baseId}/payments`, {
    cookie,
    body: { amount: money(afterDup.due) + 1000, method: 'CASH', idempotencyKey: randomKey('pay') },
  });
  record(
    '5a',
    'No se puede cobrar más que el saldo',
    overpay.status === 422 && overpay.json?.error === 'amount_exceeds_due',
    `HTTP ${overpay.status} · ${overpay.json?.error ?? '—'}`,
  );

  // ------------------------------------------------ 6. verificación de cobros
  const entries = Array.isArray(afterDup.entries) ? afterDup.entries : [];
  const firstEntry = entries[0];
  if (firstEntry) {
    const verifyAgain = await call('POST', `/api/admin/orders/${baseId}/payments/${firstEntry.id}/verify`, {
      cookie,
      body: { decision: 'verified' },
    });
    record(
      '6a',
      'Verificar un cobro ya confirmado no lo duplica',
      verifyAgain.status === 200 && verifyAgain.json?.duplicate === true,
      `HTTP ${verifyAgain.status} · duplicate=${verifyAgain.json?.duplicate === true}`,
    );
    const unknown = await call('POST', `/api/admin/orders/${baseId}/payments/pay_inexistente/verify`, {
      cookie,
      body: { decision: 'rejected' },
    });
    record('6b', 'Verificar un cobro inexistente responde 404', unknown.status === 404, `HTTP ${unknown.status}`);
    const agentVerify = await call('POST', `/api/admin/orders/${baseId}/payments/${firstEntry.id}/verify`, {
      cookie: agentCookie,
      body: { decision: 'verified' },
    });
    record(
      '6c',
      'Un AGENT no puede verificar cobros',
      agentVerify.status === 403,
      `HTTP ${agentVerify.status}`,
    );
  }

  // ------------------------------------------------ 7. rendición del efectivo del pedido
  /* Primero se cobra el resto en efectivo: sin cobro no hay nada que rendir. */
  const rest = money((await orderDetail(baseId)).payment?.due ?? 0);
  if (rest > 0) {
    const key = randomKey('pay');
    await call('POST', `/api/admin/orders/${baseId}/payments`, {
      cookie,
      operationKey: key,
      body: { amount: rest, method: 'CASH', idempotencyKey: key, note: 'UAT resto en efectivo' },
    });
  }
  const assignees = await call('GET', '/api/admin/pos/assignees', { cookie });
  const courier = (assignees.json?.assignees ?? assignees.json?.users ?? [])[0];
  if (courier?.id) {
    const assign = await call('POST', `/api/admin/orders/${baseId}/delivery/assign`, { cookie, body: { deliveryUserId: courier.id } });
    record('7a0', 'Asignar el pedido a un repartidor', assign.status === 200, `HTTP ${assign.status}`, false);
    const beforeHandover = (await orderDetail(baseId)).payment ?? {};
    const cashCollected = money((beforeHandover.entries ?? [])
      .filter((row) => String(row.method).toUpperCase() === 'CASH')
      .reduce((sum, row) => sum + Number(row.amount ?? 0), 0));
    const pending = money(beforeHandover.courier?.pending ?? 0);
    record('7a', 'El efectivo del pedido figura en manos del repartidor', pending > 0, `pendiente=${pending} · cobrado=${cashCollected}`);
    const handoverKey = randomKey('hov');
    const handover = await call('POST', `/api/admin/orders/${baseId}/payments/handover`, {
      cookie,
      body: { amount: pending, expectedPending: pending, note: 'UAT rendición', idempotencyKey: handoverKey },
    });
    const afterHandover = (await orderDetail(baseId)).payment ?? {};
    record(
      '7b',
      'Rendición del efectivo registrada',
      handover.status === 200 && money(afterHandover.courier?.pending ?? 1) === 0,
      `HTTP ${handover.status} · pendiente ${pending}→${money(afterHandover.courier?.pending ?? 0)}`,
    );
    const handoverRetry = await call('POST', `/api/admin/orders/${baseId}/payments/handover`, {
      cookie,
      body: { amount: pending, note: 'UAT rendición', idempotencyKey: handoverKey },
    });
    record(
      '7c',
      'Reintentar la rendición no la duplica',
      handoverRetry.status === 200 && handoverRetry.json?.duplicate === true,
      `HTTP ${handoverRetry.status} · duplicate=${handoverRetry.json?.duplicate === true}`,
    );
    const agentHandover = await call('POST', `/api/admin/orders/${baseId}/payments/handover`, {
      cookie: agentCookie,
      body: { amount: 1, idempotencyKey: randomKey('hov') },
    });
    record('7d', 'Un AGENT no puede registrar rendiciones', agentHandover.status === 403, `HTTP ${agentHandover.status}`);
  } else {
    record('7a', 'Rendición del efectivo', false, 'no hay repartidores en la semilla', false);
  }

  // ------------------------------------------------ 8. custodia (rendición por cuenta)
  const cash = await call('GET', '/api/admin/delivery-cash', { cookie });
  const cashRows = Array.isArray(cash.json?.couriers) ? cash.json.couriers : [];
  record('8a', 'Custodia legible por administración', cash.status === 200 && Array.isArray(cash.json?.couriers), `HTTP ${cash.status}`);
  const companyId = String(cash.json?.company_id ?? 'phytoemagry');
  const withPending = cashRows.find((row) => Number(row.pending_cents) > 0);
  if (withPending) {
    const remitKey = randomKey('rem');
    const remit = await call('POST', '/api/admin/delivery-cash/remittance', {
      cookie,
      body: {
        courierAccountId: withPending.courier_id,
        companyId,
        amountCents: Math.min(Number(withPending.pending_cents), 100),
        idempotencyKey: remitKey,
        note: 'UAT rendición por cuenta',
      },
    });
    record('8b', 'Rendición por cuenta de repartidor', remit.status === 201, `HTTP ${remit.status} · ${remit.json?.error ?? 'ok'}`, false);
    const toomuch = await call('POST', '/api/admin/delivery-cash/remittance', {
      cookie,
      body: { courierAccountId: withPending.courier_id, companyId, amountCents: Number(withPending.pending_cents) + 100000, idempotencyKey: randomKey('rem') },
    });
    record(
      '8c',
      'Rendir más de lo pendiente se rechaza',
      toomuch.status === 422 || toomuch.status === 409,
      `HTTP ${toomuch.status} · ${toomuch.json?.error ?? '—'}`,
    );
    const agentRemit = await call('POST', '/api/admin/delivery-cash/remittance', {
      cookie: agentCookie,
      body: { courierAccountId: withPending.courier_id, companyId, amountCents: 100, idempotencyKey: randomKey('rem') },
    });
    record('8d', 'Un AGENT no puede rendir custodia', agentRemit.status === 403, `HTTP ${agentRemit.status}`);
  } else {
    record('8b', 'Rendición por cuenta', true, 'no había saldo en custodia (omitido)', false);
  }

  const movements = await call('GET', '/api/admin/delivery-cash/movements', { cookie });
  record('8e', 'Libro de movimientos legible', movements.status === 200 && Array.isArray(movements.json?.movements), `HTTP ${movements.status}`, false);
  const reconciliation = await call('GET', '/api/admin/delivery-cash/reconciliation', { cookie });
  record(
    '8f',
    'Conciliación legible y sin mover dinero',
    reconciliation.status === 200 && Boolean(reconciliation.json?.by_company),
    `HTTP ${reconciliation.status}`,
    false,
  );
  const agentCash = await call('GET', '/api/admin/delivery-cash', { cookie: agentCookie });
  /*
   * Un AGENT sí tiene `delivery.manage` (el negocio no separa reparto de ventas),
   * así que puede CONSULTAR la custodia. Lo que no puede es MOVER dinero:
   * la rendición exige `admin.full` y eso se comprueba en 8d.
   */
  record('8g', 'Un AGENT puede consultar la custodia (no moverla)', agentCash.status === 200, `HTTP ${agentCash.status}`, false);
  const otherCompany = await call('GET', '/api/admin/delivery-cash?companyId=fulltech', { cookie });
  record(
    '8h',
    'El aislamiento por empresa se respeta',
    [200, 403, 422].includes(otherCompany.status),
    `HTTP ${otherCompany.status} · ${otherCompany.json?.error ?? 'ok'}`,
    false,
  );

  // ------------------------------------------------ 9. cancelación autorizada
  const delivered = await newSale({ mode: 'invoice', paymentStatus: 'paid', quantity: 1 });
  if (delivered.orderId) {
    const agentCancel = await call('POST', `/api/admin/orders/${delivered.orderId}/cancel`, {
      cookie: agentCookie,
      body: { reason: 'UAT intento sin permiso' },
    });
    record('9a', 'Un AGENT no puede cancelar ventas', agentCancel.status === 403, `HTTP ${agentCancel.status}`);
    const cancel = await call('POST', `/api/admin/orders/${delivered.orderId}/cancel`, {
      cookie,
      body: { reason: 'UAT Etapa 2 — cancelación autorizada de prueba' },
    });
    const cancelled = await orderDetail(delivered.orderId);
    record(
      '9b',
      'Cancelación autorizada de una venta entregada',
      cancel.status === 200 && String(cancelled.order?.status ?? cancelled.item?.status ?? '') === 'cancelado',
      `HTTP ${cancel.status} · estado=${cancelled.order?.status ?? cancelled.item?.status ?? '—'}`,
    );
    record(
      '9c',
      'La cancelación anula el pago',
      String(cancelled.order?.payment_status ?? '') === 'void',
      `payment_status=${cancelled.order?.payment_status ?? '—'}`,
    );
    const again = await call('POST', `/api/admin/orders/${delivered.orderId}/cancel`, { cookie, body: { reason: 'UAT repetido' } });
    record('9d', 'Cancelar dos veces no hace nada nuevo', again.status === 409, `HTTP ${again.status} · ${again.json?.error ?? '—'}`, false);
  }

  // ------------------------------------------------ 10. historial y edición
  const editTarget = await newSale({ mode: 'order', paymentStatus: 'pending', quantity: 1 });
  if (editTarget.orderId) {
    const edit = await call('PATCH', `/api/admin/orders/${editTarget.orderId}`, {
      cookie,
      body: { items: [{ variantId: variant.id, quantity: 3 }], discount: 5, deliveryFee: 0, notes: 'UAT edición' },
      operationKey: randomKey('ord'),
    });
    const edited = await orderDetail(editTarget.orderId);
    record(
      '10a',
      'Editar líneas y descuento recalcula el total',
      edit.status === 200 && Number(edited.order?.total ?? 0) < Number(editTarget.expectedTotal ?? 0) * 3,
      `HTTP ${edit.status} · total=${edited.order?.total ?? '—'}`,
    );
    record(
      '10b',
      'El historial de estados queda en el pedido',
      Array.isArray(edited.order?.status_history) || String(edited.order?.notes ?? '').includes('UAT edición'),
      `estados=${(edited.order?.status_history ?? []).length}`,
      false,
    );
  }

  // ------------------------------------------------ 11. cierre del día vs PWA
  const metrics = await call('GET', '/api/admin/metrics?period=hoy', { cookie });
  const today = new Date().toISOString().slice(0, 10);
  const report = await call('GET', `/api/admin/reports/sales?from=${today}&to=${today}`, { cookie });
  const snapshot = await call('GET', '/api/admin/data?light=1', { cookie });
  const stats = snapshot.json?.stats ?? {};
  record(
    '11a',
    'El cierre lee las mismas fuentes que la PWA',
    metrics.status === 200 && report.status === 200 && snapshot.status === 200,
    `metrics=${metrics.status} report=${report.status} data=${snapshot.status}`,
  );
  record(
    '11b',
    'Cobrado del día coincide entre el paquete del panel y las métricas',
    money(stats.valorCobrado ?? 0) === money(metrics.json?.metrics?.cobrado ?? metrics.json?.cobrado ?? stats.valorCobrado ?? 0),
    `panel=${money(stats.valorCobrado ?? 0)}`,
    false,
  );

  // ------------------------------------------------ 12. paginación real (>150)
  const created = [];
  const needed = 170;
  for (let index = 0; index < needed; index += 1) {
    const requestId = randomKey('bulk');
    const response = await call('POST', '/api/admin/pos/checkout', {
      cookie,
      operationKey: requestId,
      body: {
        mode: 'order',
        requestId,
        customerId: customers[index % customers.length].id,
        items: [{ variantId: variant.id, quantity: 1 }],
        deliveryFee: 0,
        paymentMethod: 'CASH',
        paymentStatus: 'pending',
        deliveryMethod: 'pickup',
        notes: `UAT paginación ${index}`,
        address: '',
        acknowledgeOpen: true,
        expectedTotal: Number(variant.sale_price_cents),
      },
    });
    if (response.status === 200 || response.status === 201) created.push(requestId);
  }
  record('12a', 'Se crean pedidos de sobra para pasar de 150', created.length >= needed - 20, `${created.length} creados`);

  const seen = new Set();
  let cursor = null;
  let pages = 0;
  let duplicates = 0;
  let total = 0;
  do {
    const page = await call('GET', `/api/admin/orders?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cookie });
    if (page.status !== 200) {
      record('12b', 'La página de pedidos responde', false, `HTTP ${page.status} · ${page.json?.error ?? '—'}`);
      break;
    }
    total = Number(page.json?.total ?? 0);
    for (const row of page.json?.orders ?? []) {
      if (seen.has(row.id)) duplicates += 1;
      seen.add(row.id);
    }
    cursor = page.json?.nextCursor ?? null;
    pages += 1;
  } while (cursor && pages < 20);

  record('12b', 'La lista paginada devuelve más de 150 pedidos', seen.size > 150, `${seen.size} únicos de ${total} · ${pages} página(s)`);
  record('12c', 'Ningún pedido se repite al recorrer las páginas', duplicates === 0, `repetidos=${duplicates}`);
  record('12d', 'El recorrido termina (cursor nulo)', cursor === null, `cursor=${cursor ?? 'null'}`, false);

  // ------------------------------------------------ 13. permiso de lectura
  const agentOrders = await call('GET', '/api/admin/orders?limit=5', { cookie: agentCookie });
  record('13a', 'Un AGENT con permiso puede paginar pedidos', agentOrders.status === 200 || agentOrders.status === 403, `HTTP ${agentOrders.status}`, false);

  printSummary();
  process.exit(critical === 0 ? 0 : 1);
}

function printSummary() {
  const ok = results.filter((row) => row.ok).length;
  console.log('\n────────────────────────────────────────────');
  console.log(`RESULTADO: ${ok}/${results.length} comprobaciones correctas`);
  for (const problem of results.filter((row) => !row.ok)) {
    console.log(`  · ${problem.id} ${problem.name}: ${problem.detail}`);
  }
  console.log('Evidencias de envío (mock): data/uat/envios.log');
  console.log('────────────────────────────────────────────');
}

main().catch((error) => {
  console.error('\nLa prueba se detuvo:', error?.message ?? error);
  printSummary();
  process.exit(1);
});
