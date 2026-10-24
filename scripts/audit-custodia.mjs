/*
 * AUDITORÍA DE CONCILIACIÓN — pedidos entregados vs. libro de custodia.
 *
 * SOLO LEE. No crea, no corrige y no borra nada.
 * Las reglas NO viven aquí: se importan del servicio compartido
 * `server/delivery-reconciliation.mjs`, el mismo que usa el panel.
 *
 * Uso: node scripts/audit-custodia.mjs [ruta.sqlite]
 * Sin argumento usa ./uat-integracion.sqlite
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { reconcileDeliveryCash } from '../server/delivery-reconciliation.mjs';

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
  console.error('Faltan tablas de pedidos o de custodia: la base no es de este CRM.');
  process.exit(2);
}

const parse = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const orders = [];
for (const row of db.prepare(`select id, order_json from ${ORDERS} where type = 'order_intent'`).all()) {
  const order = parse(row.order_json);
  if (order) orders.push({ ...order, id: row.id });
}

const ledger = db
  .prepare(`select id, order_id, courier_account_id, kind, idempotency_key, created_at, doc from ${CASH}`)
  .all()
  .map((row) => {
    const doc = parse(row.doc) ?? {};
    return {
      id: row.id,
      kind: doc.kind ?? row.kind,
      order_id: doc.order_id ?? row.order_id,
      courier_account_id: doc.courier_account_id ?? row.courier_account_id,
      amount_cents: Number(doc.amount_cents) || 0,
      idempotency_key: doc.idempotency_key ?? row.idempotency_key,
      created_at: doc.created_at ?? row.created_at,
    };
  });

const result = reconcileDeliveryCash({ orders, ledger });

console.log(`Base: ${file}`);
console.log(`Pedidos entregados con efectivo: ${result.totals.deliveredWithCash}`);
console.log(`Cargos: ${result.totals.chargedCents} cts · Rendido: ${result.totals.remittedCents} cts · Pendiente: ${result.totals.pendingCents} cts`);
console.log(`Cobrado en el móvil sin cargo: ${result.totals.declaredWithoutChargeCents} cts`);
console.log(`Diferencia global (cargado - declarado): ${result.totals.differenceCents} cts`);
console.log(`Repartidores con saldo: ${result.balances.filter((row) => row.pendingCents !== 0).length}`);

if (result.ok) {
  console.log('CONCILIACIÓN: sin discrepancias.');
  process.exit(0);
}
console.log(`CONCILIACIÓN: ${result.incidents.length} discrepancia(s).`);
for (const incident of result.incidents) {
  const ref = incident.orderId ?? incident.courierId ?? '—';
  console.log(`  - ${incident.type} · ${ref} · ${incident.amountCents} cts · ${incident.action}`);
}
process.exit(1);
