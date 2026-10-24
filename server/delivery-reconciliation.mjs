/**
 * CONCILIACIÓN DE CUSTODIA — reglas compartidas, SOLO LECTURA.
 *
 * Una sola implementación para el panel, el script de auditoría y las pruebas.
 * No escribe, no corrige y no "arregla" saldos: detecta y describe. Cualquier
 * corrección contable tiene que pasar por un flujo aparte con permisos,
 * confirmación y auditoría (no existe todavía a propósito).
 *
 * Dinero SIEMPRE en centavos enteros. Nada de coma flotante.
 */

const cents = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
};

const lifecycleOfOrder = (order) =>
  String(order?.delivery?.lifecycle ?? '').trim().toUpperCase();

/**
 * @param {{orders: Array<any>, ledger: Array<any>}} input
 *   `orders`: documentos de pedido ya parseados (`{id, ...order}`).
 *   `ledger`: filas del libro append-only (`{id, kind, amount_cents, order_id, courier_account_id, idempotency_key, created_at}`).
 */
export function reconcileDeliveryCash({ orders = [], ledger = [] } = {}) {
  const charges = ledger.filter((row) => String(row.kind ?? '') === 'charge');
  const remittances = ledger.filter((row) => String(row.kind ?? '') === 'remittance');

  /* Pedidos entregados que debían dejar efectivo. */
  const delivered = [];
  for (const order of orders) {
    if (!order) continue;
    const lifecycle = lifecycleOfOrder(order);
    const status = String(order.status ?? '').toLowerCase();
    if (lifecycle !== 'DELIVERED' && status !== 'entregado') continue;
    const expected = cents(order.delivery?.cash_expected_cents);
    const declared = cents(order.delivery?.cash_declared_cents);
    if (expected <= 0 && declared <= 0) continue;
    delivered.push({
      orderId: String(order.id ?? ''),
      expectedCents: expected,
      /* El efectivo declarado es el que entra a custodia; si falta, se usa el esperado. */
      custodyCents: declared || expected,
      declaredCents: declared,
      lifecycle: lifecycle || `status:${status}`,
    });
  }

  const incidents = [];
  const byOrder = new Map();
  for (const charge of charges) {
    const key = String(charge.order_id ?? '');
    byOrder.set(key, [...(byOrder.get(key) ?? []), charge]);
  }

  for (const order of delivered) {
    const rows = byOrder.get(order.orderId) ?? [];
    if (!rows.length) {
      incidents.push({
        type: 'delivered_without_charge',
        orderId: order.orderId,
        amountCents: order.custodyCents,
        action: 'Registrar el cargo faltante desde el pedido; no editar el libro a mano.',
      });
      continue;
    }
    const keys = new Set(rows.map((row) => String(row.idempotency_key ?? row.id ?? '')));
    if (keys.size !== rows.length) {
      incidents.push({
        type: 'duplicate_charge',
        orderId: order.orderId,
        amountCents: rows.reduce((sum, row) => sum + cents(row.amount_cents), 0),
        action: 'Revisar las claves de idempotencia; un pedido solo puede tener un cargo.',
      });
    }
    const charged = rows.reduce((sum, row) => sum + cents(row.amount_cents), 0);
    if (charged !== order.custodyCents) {
      incidents.push({
        type: 'charge_mismatch',
        orderId: order.orderId,
        amountCents: charged - order.custodyCents,
        action: 'Comparar cobro declarado por el repartidor con el cargo; documentar la diferencia.',
      });
    }
  }

  const deliveredIds = new Set(delivered.map((order) => order.orderId));
  for (const [orderId, rows] of byOrder) {
    if (!orderId) {
      incidents.push({
        type: 'charge_without_order',
        orderId: null,
        amountCents: rows.reduce((sum, row) => sum + cents(row.amount_cents), 0),
        action: 'Cargo sin pedido asociado: localizar su origen antes de rendir.',
      });
      continue;
    }
    if (deliveredIds.has(orderId)) continue;
    incidents.push({
      type: 'orphan_charge',
      orderId,
      amountCents: rows.reduce((sum, row) => sum + cents(row.amount_cents), 0),
      action: 'El pedido no figura como entregado; verificar si se completó fuera de la app.',
    });
  }

  /* Saldos por repartidor, con detección de negativos imposibles. */
  const balances = new Map();
  const bump = (courierId, field, amount) => {
    const key = String(courierId ?? '');
    const row = balances.get(key) ?? { courierId: key, chargedCents: 0, remittedCents: 0 };
    row[field] += amount;
    balances.set(key, row);
  };
  for (const row of charges) bump(row.courier_account_id, 'chargedCents', cents(row.amount_cents));
  for (const row of remittances) bump(row.courier_account_id, 'remittedCents', cents(row.amount_cents));
  for (const row of balances.values()) {
    row.pendingCents = row.chargedCents - row.remittedCents;
    if (row.pendingCents < 0) {
      incidents.push({
        type: 'negative_balance',
        courierId: row.courierId,
        amountCents: row.pendingCents,
        action: 'Se rindió más de lo cargado: revisar antes de aceptar más efectivo de ese repartidor.',
      });
    }
  }

  const chargedTotal = charges.reduce((sum, row) => sum + cents(row.amount_cents), 0);
  const remittedTotal = remittances.reduce((sum, row) => sum + cents(row.amount_cents), 0);
  const declaredTotal = delivered.reduce((sum, order) => sum + order.custodyCents, 0);

  return {
    ok: incidents.length === 0,
    totals: {
      deliveredWithCash: delivered.length,
      chargedCents: chargedTotal,
      remittedCents: remittedTotal,
      pendingCents: chargedTotal - remittedTotal,
      /* Cobrado en el móvil que aún no tiene cargo: el hueco más caro. */
      declaredWithoutChargeCents: incidents
        .filter((row) => row.type === 'delivered_without_charge')
        .reduce((sum, row) => sum + row.amountCents, 0),
      differenceCents: chargedTotal - declaredTotal,
    },
    balances: [...balances.values()],
    incidents,
  };
}
