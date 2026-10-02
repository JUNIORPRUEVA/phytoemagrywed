import { randomBytes } from 'node:crypto';

import { catalogItems, computeOrderTotals } from '../src/lib/catalog.js';
import { isCompletedPurchaseStatus, orderOf } from './orders.mjs';
import { dayIn } from './followups.mjs';

export const PRODUCT_ID = 'phytoemagry';
export const BASE_UNIT = 'capsule';
export const DEFAULT_UNIT_COST_CENTS = 12666;

const MOVEMENT_TYPES = new Set(['INITIAL', 'RESTOCK', 'SALE', 'SALE_REVERSAL', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'COUNT_ADJUSTMENT']);

function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export function moneyToCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const [units, cents = ''] = raw.split('.');
  return Number(units) * 100 + Number(cents.padEnd(2, '0'));
}

export function centsToMoney(cents) {
  if (cents === null || cents === undefined) return null;
  return (Number(cents) / 100).toFixed(2);
}

export function pesosToCents(value) {
  return Math.trunc(Number(value) || 0) * 100;
}

export function centsToPesos(cents) {
  return Math.round((Number(cents) || 0) / 100);
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function nonNegativeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function movementQuantity(type, quantity, input = {}) {
  if (type === 'COUNT_ADJUSTMENT') {
    const delta = Number(input.quantityDelta);
    return Number.isFinite(delta) ? Math.trunc(delta) : null;
  }
  return ['SALE', 'ADJUSTMENT_OUT'].includes(type) ? -Math.abs(quantity) : Math.abs(quantity);
}

function movementAction(type) {
  if (type === 'SALE') return 'inventory_sale';
  if (type === 'SALE_REVERSAL') return 'inventory_sale_reversed';
  if (type === 'RESTOCK' || type === 'INITIAL') return 'inventory_added';
  return 'inventory_adjusted';
}

function stockFromRows(rows) {
  return rows.reduce((sum, row) => sum + (Number(row.quantity_delta) || 0), 0);
}

function rangeFor(period, now, timeZone, query = {}) {
  const today = dayIn(now, timeZone);
  if (period === 'ayer') {
    const date = new Date(`${today}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    const day = dayIn(date, timeZone);
    return { name: 'ayer', startDay: day, endDay: day };
  }
  if (period === '7d' || period === '30d') {
    const days = period === '7d' ? 7 : 30;
    const date = new Date(`${today}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() - (days - 1));
    return { name: period, startDay: dayIn(date, timeZone), endDay: today, days };
  }
  if (period === 'mes') {
    return { name: 'mes', startDay: `${today.slice(0, 7)}-01`, endDay: today };
  }
  if (period === 'custom') {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(query.from ?? '')) ? String(query.from) : today;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(query.to ?? '')) ? String(query.to) : from;
    return { name: 'custom', startDay: from <= to ? from : to, endDay: to >= from ? to : from };
  }
  return { name: 'hoy', startDay: today, endDay: today };
}

function deliveredAtOf(row) {
  const order = orderOf(row);
  return order?.delivered_at ?? row.meta_purchase_sent_at ?? row.updated_at ?? row.received_at;
}

function lineSnapshots(order, unitCostCents, previousOrder = null) {
  const previousByVariant = new Map(
    (previousOrder?.items ?? [])
      .filter((line) => line.variantId && Number.isInteger(line.unit_cost_snapshot_cents))
      .map((line) => [line.variantId, line]),
  );
  return (order.items ?? []).map((line) => {
    const previous = previousByVariant.get(line.variantId) ?? null;
    const capsules = Number(line.capsules) || 0;
    const quantity = Number(line.quantity) || 1;
    const totalCapsules = Number(line.totalCapsules) || capsules * quantity;
    const unitPriceCents = pesosToCents(line.unitPrice);
    const subtotalCents = pesosToCents(line.subtotal ?? (Number(line.unitPrice) || 0) * quantity);
    const lineUnitCostCents = Number.isInteger(previous?.unit_cost_snapshot_cents)
      ? previous.unit_cost_snapshot_cents
      : unitCostCents;
    const costCents = totalCapsules * lineUnitCostCents;
    return {
      ...line,
      capsule_quantity: capsules,
      totalCapsules,
      unit_price_snapshot_cents: unitPriceCents,
      subtotal_snapshot_cents: subtotalCents,
      unit_cost_snapshot_cents: lineUnitCostCents,
      product_cost_snapshot_cents: costCents,
      gross_profit_snapshot_cents: subtotalCents - costCents,
    };
  });
}

export function createInventoryService(deps) {
  const db = deps.db;
  const store = deps.store;
  const audit = deps.audit ?? null;
  const timeZone = deps.timeZone ?? 'America/Santo_Domingo';
  const clock = deps.clock ?? (() => new Date());
  let inventoryQueue = Promise.resolve();

  async function withInventoryLock(work) {
    const previous = inventoryQueue;
    let release = () => {};
    inventoryQueue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async function settings() {
    const found = await db.findBy('products', 'product_id', PRODUCT_ID);
    if (found) return found;
    const now = clock().toISOString();
    const doc = {
      id: `prd_${PRODUCT_ID}`,
      product_id: PRODUCT_ID,
      name: 'Phytoemagry',
      base_unit: BASE_UNIT,
      current_unit_cost_cents: DEFAULT_UNIT_COST_CENTS,
      currency: 'DOP',
      created_at: now,
      updated_at: now,
    };
    await db.insert('products', doc);
    return doc;
  }

  async function movements() {
    return db.list('inventory_movements', { limit: 5000, by: 'created_at', order: 'asc' });
  }

  async function stock() {
    const rows = await movements();
    const current = stockFromRows(rows);
    return { current, initialized: rows.length > 0, movements: rows };
  }

  async function addMovementUnlocked(input) {
    const type = String(input.type ?? '').trim();
    if (!MOVEMENT_TYPES.has(type)) return { ok: false, error: 'invalid_type' };
    const quantity = type === 'COUNT_ADJUSTMENT' ? Math.abs(Number(input.quantityDelta) || 0) : positiveInt(input.quantity);
    if (!quantity) return { ok: false, error: 'invalid_quantity' };
    const unitCostCents = input.unitCostCents ?? (await settings()).current_unit_cost_cents;
    if (!Number.isInteger(unitCostCents) || unitCostCents < 0) return { ok: false, error: 'invalid_unit_cost' };
    const delta = movementQuantity(type, quantity, input);
    if (!Number.isInteger(delta) || delta === 0) return { ok: false, error: 'invalid_quantity' };
    const current = await stock();
    const quantityBefore = current.current;
    const quantityAfter = quantityBefore + delta;
    if (quantityAfter < 0) {
      return { ok: false, error: 'insufficient_stock', available: current.current, required: Math.abs(delta) };
    }
    const now = clock().toISOString();
    const doc = {
      id: newId('inv'),
      product_id: PRODUCT_ID,
      type,
      quantity_delta: delta,
      quantity_before: quantityBefore,
      quantity_after: quantityAfter,
      unit_cost_cents: unitCostCents,
      order_id: input.orderId ?? null,
      reference_type: input.referenceType ?? (input.orderId ? 'order' : null),
      reference_id: input.referenceId ?? input.orderId ?? null,
      reason: input.reason ?? null,
      expected_quantity: input.expectedQuantity ?? null,
      counted_quantity: input.countedQuantity ?? null,
      created_by: input.actor ?? input.actorName ?? 'panel',
      created_by_user_id: input.createdBy ?? null,
      created_by_display_name_snapshot: input.actorName ?? null,
      created_at: now,
      idempotency_key: input.idempotencyKey ?? null,
    };
    const result = await db.insert('inventory_movements', doc);
    if (result.duplicate) return { ok: true, duplicate: true, movement: await db.findBy('inventory_movements', 'idempotency_key', doc.idempotency_key) };
    await audit?.record({
      entity: 'inventory',
      entityId: doc.id,
      action: movementAction(type),
      actor: input.actorName ?? input.actor ?? null,
      summary: `${type} ${delta} cápsulas`,
      data: { product_id: PRODUCT_ID, quantity_delta: delta, order_id: doc.order_id },
      idempotencyKey: `audit:${doc.id}`,
    });
    return { ok: true, duplicate: false, movement: doc };
  }

  async function addMovement(input) {
    return withInventoryLock(() => addMovementUnlocked(input));
  }

  async function updateCost(value, actor = {}) {
    const cents = moneyToCents(value);
    if (cents === null) return { ok: false, error: 'invalid_unit_cost' };
    const current = await settings();
    const updated = await db.update('products', current.id, { current_unit_cost_cents: cents, updated_at: clock().toISOString() });
    await audit?.record({
      entity: 'inventory',
      entityId: PRODUCT_ID,
      action: 'product_cost_changed',
      actor: actor.actorName ?? null,
      summary: `Costo cápsula ${centsToMoney(current.current_unit_cost_cents)} → ${centsToMoney(cents)}`,
      data: { from: current.current_unit_cost_cents, to: cents },
    });
    return { ok: true, product: updated };
  }

  async function snapshotOrder(order, previousOrder = null) {
    const current = await settings();
    return { ...order, items: lineSnapshots(order, current.current_unit_cost_cents, previousOrder) };
  }

  function soldCapsulesForOrder(rows, orderId) {
    return rows
      .filter((row) => row.order_id === orderId && ['SALE', 'SALE_REVERSAL'].includes(row.type))
      .reduce((sum, row) => sum + -(Number(row.quantity_delta) || 0), 0);
  }

  async function syncSale(item, targetOrder = null, previousOrder = null, reason = null, options = {}) {
    const order = orderOf(item);
    if (!order && !targetOrder) return { ok: false, error: 'invalid_order' };
    return withInventoryLock(async () => {
      const current = await stock();
      const alreadySold = soldCapsulesForOrder(current.movements, item.id);
      const wantedOrder = targetOrder ?? order;
      const targetCapsules =
        Number(wantedOrder?.total_capsules) ||
        (wantedOrder?.items ?? []).reduce((sum, line) => sum + (Number(line.totalCapsules) || 0), 0);
      const delta = targetCapsules - alreadySold;
      if (current.initialized && delta > 0 && current.current < delta) {
        return { ok: false, error: 'insufficient_stock', available: current.current, required: delta };
      }
      const withSnapshots =
        wantedOrder && (wantedOrder.items ?? []).every((line) => Number.isInteger(line.product_cost_snapshot_cents))
          ? wantedOrder
          : wantedOrder
            ? await snapshotOrder(wantedOrder, previousOrder ?? order)
            : null;
      let move = { ok: true, skipped: true };
      if (current.initialized && delta !== 0) {
        const revision = current.movements.filter((row) => row.order_id === item.id && ['SALE', 'SALE_REVERSAL'].includes(row.type)).length + 1;
        move = await addMovementUnlocked({
          type: delta > 0 ? 'SALE' : 'SALE_REVERSAL',
          quantity: Math.abs(delta),
          unitCostCents: 0,
          orderId: item.id,
          reason: reason ?? `Venta ${wantedOrder?.order_number ?? item.id}`,
          createdBy: wantedOrder?.created_by_user_id ?? wantedOrder?.updated_by_user_id ?? null,
          actorName: wantedOrder?.created_by_display_name_snapshot ?? wantedOrder?.updated_by_display_name_snapshot ?? null,
          idempotencyKey: revision === 1 && delta > 0 ? `inv:sale:${item.id}` : `inv:sale-sync:${item.id}:${revision}:${targetCapsules}`,
        });
      }
      if (!move.ok) return move;
      if (options.persistOrder !== false && withSnapshots && store?.update) {
        await store.update(item.id, { orderJson: JSON.stringify(withSnapshots) });
      }
      return {
        ok: true,
        order: withSnapshots,
        movement: move.movement ?? null,
        delta,
        stockSkipped: move.skipped === true,
      };
    });
  }

  async function recordSale(item) {
    return syncSale(item);
  }

  async function reverseSale(item, reason = 'Reversión de venta') {
    return syncSale(item, { ...(orderOf(item) ?? {}), items: [], total_capsules: 0 }, orderOf(item), reason, {
      persistOrder: false,
    });
  }

  async function countStock(input = {}) {
    const counted = nonNegativeInt(input.countedQuantity ?? input.quantity ?? input.counted);
    if (counted === null) return { ok: false, error: 'invalid_quantity' };
    return withInventoryLock(async () => {
      const current = await stock();
      const delta = counted - current.current;
      if (delta === 0) {
        return {
          ok: true,
          skipped: true,
          current: current.current,
          counted,
          difference: 0,
          movement: null,
        };
      }
      return addMovementUnlocked({
        type: 'COUNT_ADJUSTMENT',
        quantityDelta: delta,
        unitCostCents: moneyToCents(input.unitCost) ?? (await settings()).current_unit_cost_cents,
        reason: input.reason ?? 'Recuento físico',
        expectedQuantity: current.current,
        countedQuantity: counted,
        referenceType: 'inventory_count',
        referenceId: input.referenceId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        createdBy: input.createdBy ?? null,
        actorName: input.actorName ?? null,
      });
    });
  }

  async function reconcileInventory() {
    const [product, rows] = await Promise.all([settings(), movements()]);
    const ledgerStock = stockFromRows(rows);
    const storedStock = ledgerStock;
    let expectedBefore = 0;
    const broken = [];
    let withBalance = 0;
    let withoutBalance = 0;
    for (const row of rows) {
      const delta = Number(row.quantity_delta) || 0;
      if (Number.isInteger(row.quantity_before) && Number.isInteger(row.quantity_after)) {
        withBalance += 1;
        if (row.quantity_before !== expectedBefore || row.quantity_after !== row.quantity_before + delta) {
          broken.push({
            movement_id: row.id,
            type: row.type,
            expected_before: expectedBefore,
            quantity_before: row.quantity_before,
            quantity_delta: delta,
            quantity_after: row.quantity_after,
          });
        }
        expectedBefore = row.quantity_after;
      } else {
        withoutBalance += 1;
        expectedBefore += delta;
      }
    }
    const difference = storedStock - ledgerStock;
    const negative = ledgerStock < 0;
    const status = difference === 0 && broken.length === 0 && !negative ? 'MATCH' : 'MISMATCH';
    return {
      generated_at: clock().toISOString(),
      totals: {
        products: 1,
        match: status === 'MATCH' ? 1 : 0,
        mismatch: status === 'MATCH' ? 0 : 1,
        negative: negative ? 1 : 0,
        without_ledger: rows.length === 0 ? 1 : 0,
        ledger_without_product: 0,
      },
      products: [
        {
          productId: PRODUCT_ID,
          productName: product.name,
          storedStock,
          ledgerStock,
          difference,
          status,
          movements: rows.length,
          movementsWithBalance: withBalance,
          legacyMovementsWithoutBalance: withoutBalance,
          brokenMovements: broken,
        },
      ],
    };
  }

  async function report(options = {}) {
    const period = rangeFor(options.period ?? 'hoy', clock(), timeZone, options);
    const inRange = (value) => {
      const day = dayIn(new Date(value), timeZone);
      return day >= period.startDay && day <= period.endDay;
    };
    const rows = store?.listAdmin ? await store.listAdmin({ limit: 5000 }) : [];
    const delivered = rows.filter((row) => row.type === 'order_intent' && isCompletedPurchaseStatus(row.status) && inRange(deliveredAtOf(row)));
    const sales = delivered.map((row) => {
      const order = orderOf(row);
      const lines = order?.items ?? [];
      const productRevenueCents = lines.reduce((sum, line) => sum + (line.subtotal_snapshot_cents ?? pesosToCents(line.subtotal)), 0);
      const costCents = lines.reduce((sum, line) => sum + (Number(line.product_cost_snapshot_cents) || 0), 0);
      const capsules = lines.reduce((sum, line) => sum + (Number(line.totalCapsules) || 0), 0);
      const deliveryCents = pesosToCents(order?.delivery_fee ?? order?.delivery?.fee ?? 0);
      return {
        id: row.id,
        date: deliveredAtOf(row),
        customer_id: row.customer_id,
        customer_name: row.name,
        order_number: order?.order_number ?? row.order_number,
        payment_method: order?.payment_method ?? null,
        payment_method_label: order?.payment_method ? { CASH: 'Efectivo', TRANSFER: 'Transferencia' }[order.payment_method] ?? order.payment_method : null,
        presentation: lines.map((line) => line.variantName ?? line.label).join(', '),
        capsules,
        product_revenue_cents: productRevenueCents,
        delivery_revenue_cents: deliveryCents,
        total_collected_cents: productRevenueCents + deliveryCents,
        product_cost_cents: costCents,
        gross_product_profit_cents: productRevenueCents - costCents,
        status: row.status,
        lines,
      };
    });
    const byPresentation = new Map();
    for (const sale of sales) {
      for (const line of sale.lines) {
        const key = String(line.variantId ?? line.variantName ?? 'legacy');
        const current = byPresentation.get(key) ?? {
          variant_id: key,
          presentation: line.variantName ?? line.label ?? key,
          units: 0,
          capsules: 0,
          product_revenue_cents: 0,
          product_cost_cents: 0,
          gross_product_profit_cents: 0,
        };
        current.units += Number(line.quantity) || 0;
        current.capsules += Number(line.totalCapsules) || 0;
        current.product_revenue_cents += Number(line.subtotal_snapshot_cents ?? pesosToCents(line.subtotal)) || 0;
        current.product_cost_cents += Number(line.product_cost_snapshot_cents) || 0;
        current.gross_product_profit_cents = current.product_revenue_cents - current.product_cost_cents;
        byPresentation.set(key, current);
      }
    }
    const summary = sales.reduce(
      (acc, sale) => {
        acc.product_revenue_cents += sale.product_revenue_cents;
        acc.delivery_revenue_cents += sale.delivery_revenue_cents;
        acc.total_collected_cents += sale.total_collected_cents;
        acc.product_cost_cents += sale.product_cost_cents;
        acc.gross_product_profit_cents += sale.gross_product_profit_cents;
        acc.capsules_sold += sale.capsules;
        acc.orders += 1;
        return acc;
      },
      { product_revenue_cents: 0, delivery_revenue_cents: 0, total_collected_cents: 0, product_cost_cents: 0, gross_product_profit_cents: 0, capsules_sold: 0, orders: 0 },
    );
    return { period, summary, byPresentation: [...byPresentation.values()], sales: sales.slice(0, options.limit ?? 100) };
  }

  return {
    settings,
    stock,
    catalog: async () => {
      const [product, currentStock] = await Promise.all([settings(), stock()]);
      return {
        product,
        stock: currentStock.current,
        initialized: currentStock.initialized,
        inventory_value_cents: currentStock.current * product.current_unit_cost_cents,
        presentations: catalogItems().map((item) => ({
          ...item,
          product_id: PRODUCT_ID,
          capsule_quantity: item.capsules,
          sale_price_cents: pesosToCents(item.price),
          active: item.available,
          current_unit_cost_cents: product.current_unit_cost_cents,
          presentation_cost_cents: item.capsules * product.current_unit_cost_cents,
        })),
      };
    },
    addStock: (input) =>
      addMovement({
        type: 'RESTOCK',
        quantity: input.quantity,
        unitCostCents: moneyToCents(input.unitCost) ?? DEFAULT_UNIT_COST_CENTS,
        reason: input.reason ?? 'Reposición',
        idempotencyKey: input.idempotencyKey ?? null,
        createdBy: input.createdBy ?? null,
        actorName: input.actorName ?? null,
      }),
    adjust: (input) =>
      addMovement({
        type: input.direction === 'out' ? 'ADJUSTMENT_OUT' : 'ADJUSTMENT_IN',
        quantity: input.quantity,
        unitCostCents: moneyToCents(input.unitCost) ?? DEFAULT_UNIT_COST_CENTS,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey ?? null,
        createdBy: input.createdBy ?? null,
        actorName: input.actorName ?? null,
      }),
    countStock,
    reconcileInventory,
    updateCost,
    snapshotOrder,
    recordSale,
    syncSale,
    reverseSale,
    report,
    computeOrderTotals,
  };
}
