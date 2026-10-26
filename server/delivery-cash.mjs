/*
 * LIBRO DE CUSTODIA DEL EFECTIVO (Fase financiera).
 *
 * REGLA CENTRAL: el dinero cobrado al cliente NO es ganancia del repartidor.
 *
 *   · `charge`      → efectivo que el repartidor recibió y debe rendir (custodia).
 *   · `remittance`  → dinero que el repartidor ENTREGA a administración.
 *   · `adjustment`  → corrección autorizada (con motivo obligatorio).
 *
 * El libro es APPEND-ONLY: nunca se borra ni se reescribe un movimiento. Un error se
 * compensa con otro movimiento. Cada asiento lleva `idempotency_key` única, así que
 * reintentar una operación no duplica dinero.
 *
 * `pending = charges - remittances + adjustments`. Nunca se reduce por una declaración
 * del repartidor: solo cuando administración registra la rendición.
 */

export const CASH_COLLECTION = 'delivery_cash_ledger';
export const CASH_KINDS = Object.freeze(['charge', 'remittance', 'adjustment']);
import { randomUUID } from 'node:crypto';
import { companyOfCashRow } from './logistics-tenancy.mjs';

const cents = (value) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.round(number) : 0;
};

/** Resumen por repartidor: lo cobrado, lo rendido y lo que sigue en su poder. */
export function custodySummary(rows, courierAccountId) {
  const own = (Array.isArray(rows) ? rows : []).filter(
    (row) => !courierAccountId || row.courier_account_id === courierAccountId,
  );
  let charged = 0;
  let remitted = 0;
  let adjustments = 0;
  const orders = new Set();
  for (const row of own) {
    const amount = cents(row.amount_cents);
    if (row.kind === 'charge') {
      charged += amount;
      if (row.order_id) orders.add(row.order_id);
    } else if (row.kind === 'remittance') {
      remitted += amount;
    } else if (row.kind === 'adjustment') {
      adjustments += amount;
    }
  }
  return {
    charged_cents: charged,
    remitted_cents: remitted,
    adjustments_cents: adjustments,
    pending_cents: charged - remitted + adjustments,
    orders_count: orders.size,
  };
}

/** Agrupa por repartidor para el panel. */
export function custodyByCourier(rows, couriers) {
  const out = [];
  for (const courier of couriers) {
    const summary = custodySummary(rows, courier.id);
    if (summary.charged_cents === 0 && summary.remitted_cents === 0) continue;
    out.push({
      courier_id: courier.id,
      courier_name: courier.display_name ?? courier.id,
      kind: courier.kind ?? null,
      ...summary,
    });
  }
  return out;
}

/**
 * Valida una rendición ANTES de escribir.
 * No se acepta rendir más de lo que se debe, ni cero, ni negativos.
 */
export function validateRemittance(summary, amountCents) {
  const amount = cents(amountCents);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'invalid_amount', message: 'El importe debe ser mayor que cero.' };
  }
  if (amount > summary.pending_cents) {
    return {
      ok: false,
      error: 'amount_exceeds_pending',
      message: `Solo hay ${summary.pending_cents} centavos pendientes de rendir.`,
      pending: summary.pending_cents,
    };
  }
  return { ok: true, amount };
}

/** Una rendición nunca consume el saldo de otra empresa, ni dos peticiones el mismo saldo. */
export async function recordRemittanceAtomic({ db, handle, courierId, companyId,
  amountCents, idempotencyKey, actor, note, ordersById = new Map(), now = new Date().toISOString() }) {
  // Materializar esquema/índices ANTES de abrir la transacción propia.
  await db.list(CASH_COLLECTION, { limit: 1 });
  const table = 'phytoemagry_delivery_cash_ledger';
  const amount = cents(amountCents);
  const makeDoc = () => ({ id: `cash_${randomUUID().replaceAll('-', '')}`,
    order_id: null, courier_account_id: courierId, company_id: companyId,
    kind: 'remittance', amount_cents: amount, note, idempotency_key: idempotencyKey,
    actor, created_at: now });
  const decide = (allRows) => {
    const prior = allRows.find((row) => row.idempotency_key === idempotencyKey);
    const own = allRows.filter((row) => row.courier_account_id === courierId &&
      companyOfCashRow(row, ordersById) === companyId);
    if (prior) {
      if (prior.courier_account_id !== courierId || prior.company_id !== companyId ||
          prior.amount_cents !== amount || prior.kind !== 'remittance') {
        return { ok: false, status: 409, error: 'idempotency_scope_conflict' };
      }
      return { ok: true, duplicate: true, summary: custodySummary(own, courierId) };
    }
    // La empresa de una rendición histórica sin pedido no es demostrable.
    // Se bloquean asientos NUEVOS de este repartidor hasta conciliación manual;
    // nunca se descuenta esa rendición de otro saldo por suposición.
    if (allRows.some((row) => row.courier_account_id === courierId &&
        companyOfCashRow(row, ordersById) === null)) {
      return { ok: false, status: 409, error: 'historical_custody_unresolved',
        message: 'La custodia histórica de este repartidor requiere conciliación manual.' };
    }
    const check = validateRemittance(custodySummary(own, courierId), amount);
    if (!check.ok) return { ...check, status: 422 };
    const doc = makeDoc();
    return { ok: true, duplicate: false, doc,
      summary: custodySummary([...own, doc], courierId) };
  };
  if (db.kind === 'postgres') {
    const client = await handle.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cash:${courierId}:${companyId}`]);
      const allRows = (await client.query(`SELECT doc FROM ${table}`)).rows.map((row) => row.doc);
      const result = decide(allRows);
      if (!result.ok || result.duplicate) { await client.query('ROLLBACK'); return result; }
      const doc = result.doc;
      const inserted = await client.query(`INSERT INTO ${table}
        (id, doc, order_id, courier_account_id, company_id, kind, idempotency_key, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [doc.id, JSON.stringify(doc), null, courierId, companyId, doc.kind, idempotencyKey, now]);
      if (inserted.rowCount !== 1) { await client.query('ROLLBACK');
        return { ok: false, status: 409, error: 'idempotency_scope_conflict' }; }
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  if (db.kind === 'sqlite') {
    handle.exec('BEGIN IMMEDIATE');
    try {
      const allRows = handle.prepare(`SELECT doc FROM ${table}`).all().map((row) => JSON.parse(row.doc));
      const result = decide(allRows);
      if (!result.ok || result.duplicate) { handle.exec('ROLLBACK'); return result; }
      const doc = result.doc;
      const inserted = handle.prepare(`INSERT OR IGNORE INTO ${table}
        (id, doc, order_id, courier_account_id, company_id, kind, idempotency_key, created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(doc.id, JSON.stringify(doc), null, courierId,
          companyId, doc.kind, idempotencyKey, now);
      if (inserted.changes !== 1) { handle.exec('ROLLBACK');
        return { ok: false, status: 409, error: 'idempotency_scope_conflict' }; }
      handle.exec('COMMIT');
      return result;
    } catch (error) { handle.exec('ROLLBACK'); throw error; }
  }
  return { ok: false, status: 503, error: 'atomic_storage_required' };
}

/**
 * Configuración de la tarifa del repartidor. Si no hay tarifa aprobada NO se calcula
 * ninguna ganancia: se dice «pendiente de configurar».
 */
export function earningsFor({ deliveredCount = 0, rateCents = null } = {}) {
  const rate = rateCents === null || rateCents === undefined ? null : cents(rateCents);
  if (rate === null || rate <= 0) {
    return { configured: false, rate_cents: null, earned_cents: null, delivered_count: deliveredCount };
  }
  return {
    configured: true,
    rate_cents: rate,
    earned_cents: rate * Math.max(0, cents(deliveredCount)),
    delivered_count: deliveredCount,
  };
}
