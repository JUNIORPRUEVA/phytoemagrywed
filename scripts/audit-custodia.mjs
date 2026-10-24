/*
 * AUDITORÍA DE CONCILIACIÓN — pedidos entregados vs. libro de custodia.
 *
 * SOLO LEE. No crea, no corrige y no borra nada.
 *
 * Comprueba, sobre una base real (UAT o copia), las cuatro cosas que pueden
 * descuadrar la caja sin que nadie lo note:
 *   1. entrega cobrada en efectivo SIN cargo en el libro   -> falta dinero
 *   2. cargo en el libro SIN pedido entregado que lo explique -> cargo huérfano
 *   3. cargo duplicado del MISMO pedido y evento            -> doble cobro
 *   4. cargo distinto del efectivo DECLARADO por el repartidor -> cifra inventada
 *
 * Uso: node scripts/audit-custodia.mjs [ruta.sqlite]
 * Sin argumento usa ./uat-integracion.sqlite
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const file = process.argv[2] ?? path.join(process.cwd(), 'uat-integracion.sqlite');
if (!existsSync(file)) {
  console.error(`No existe la base: ${file}`);
  process.exit(2);
}

const db = new DatabaseSync(file, { readOnly: true });
const tableExists = (name) =>
  Boolean(db.prepare("select 1 as ok from sqlite_master where type='table' and name=?").get(name));

const ORDERS = ['items', 'phytoemagry_items'].find((name) => tableExists(name));
const CASH = 'phytoemagry_delivery_cash_ledger';
if (!ORDERS || !tableExists(CASH)) {
  console.error(`Faltan tablas de pedidos o de custodia: la base no es de este CRM.`);
  process.exit(2);
}

const parse = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const orders = db.prepare(`select id, order_json from ${ORDERS} where type = 'order_intent'`).all();
const ledger = db.prepare(`select id, order_id, kind, idempotency_key, doc from ${CASH}`).all();

const delivered = [];
for (const row of orders) {
  const order = parse(row.order_json);
  if (!order) continue;
  const lifecycle = String(order?.delivery?.lifecycle ?? '').toUpperCase();
  const status = String(order?.status ?? '').toLowerCase();
  if (lifecycle !== 'DELIVERED' && status !== 'entregado') continue;
  const dueCents = Number(order?.delivery?.cash_expected_cents ?? order?.delivery?.amount_to_collect_cents ?? 0) || 0;
  const declaredCents = Number(order?.delivery?.cash_declared_cents ?? 0) || 0;
  if (dueCents <= 0 && declaredCents <= 0) continue;
  delivered.push({ id: row.id, dueCents, declaredCents, lifecycle: lifecycle || `status:${status}` });
}

const charges = [];
for (const row of ledger) {
  const doc = parse(row.doc) ?? {};
  const kind = String(doc.kind ?? row.kind ?? '');
  if (kind !== 'charge') continue;
  charges.push({
    id: row.id,
    orderId: doc.order_id ?? row.order_id ?? null,
    amountCents: Number(doc.amount_cents ?? 0) || 0,
    idempotencyKey: doc.idempotency_key ?? row.idempotency_key ?? null,
    courierId: doc.courier_account_id ?? null,
  });
}

const problems = [];
const chargesByOrder = new Map();
for (const charge of charges) {
  const key = String(charge.orderId ?? `sin-pedido:${charge.id}`);
  chargesByOrder.set(key, [...(chargesByOrder.get(key) ?? []), charge]);
}

for (const order of delivered) {
  const rows = chargesByOrder.get(order.id) ?? [];
  if (!rows.length) {
    problems.push({ kind: 'entrega_sin_cargo', orderId: order.id, detail: `esperado ${order.dueCents} cts, cargo 0` });
    continue;
  }
  const keys = new Set(rows.map((row) => row.idempotencyKey ?? `${row.orderId}`));
  if (keys.size !== rows.length) {
    problems.push({ kind: 'cargo_duplicado', orderId: order.id, detail: `${rows.length} cargos con ${keys.size} claves` });
  }
  const charged = rows.reduce((sum, row) => sum + row.amountCents, 0);
  const declared = order.declaredCents || order.dueCents;
  if (charged !== declared) {
    problems.push({ kind: 'cargo_distinto_declarado', orderId: order.id, detail: `cargo ${charged} vs declarado ${declared}` });
  }
}

const deliveredIds = new Set(delivered.map((order) => order.id));
for (const [orderId, rows] of chargesByOrder) {
  if (deliveredIds.has(orderId)) continue;
  problems.push({ kind: 'cargo_sin_entrega', orderId, detail: `${rows.length} cargo(s) sin pedido entregado` });
}

const chargedTotal = charges.reduce((sum, row) => sum + row.amountCents, 0);
const deliveredTotal = delivered.reduce((sum, order) => sum + (order.declaredCents || order.dueCents), 0);

console.log(`Base: ${file}`);
console.log(`Pedidos entregados con efectivo: ${delivered.length}`);
console.log(`Cargos en el libro: ${charges.length} (${chargedTotal} cts)`);
console.log(`Efectivo declarado/esperado: ${deliveredTotal} cts`);
console.log(`Diferencia global: ${chargedTotal - deliveredTotal} cts`);
if (!problems.length) {
  console.log('CONCILIACIÓN: sin discrepancias.');
  process.exit(0);
}
console.log(`CONCILIACIÓN: ${problems.length} discrepancia(s).`);
for (const problem of problems) console.log(`  - ${problem.kind} · ${problem.orderId} · ${problem.detail}`);
process.exit(1);
