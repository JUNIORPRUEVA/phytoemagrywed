/*
 * LIBRO DE GANANCIAS DEL REPARTIDOR Y LIQUIDACIONES.
 *
 * REGLAS CENTRALES (no negociables):
 *
 *   1. El EFECTIVO DEL CLIENTE no es ganancia. Vive en `delivery_cash_ledger`
 *      (`delivery-cash.mjs`) y NO se toca desde aquí. Ganancia y custodia son
 *      dos libros distintos y nunca se compensan automáticamente.
 *   2. Solo se registra ganancia cuando la entrega está COMPLETADA y validada.
 *      Lo estimado de la oferta no es una deuda.
 *   3. El libro es APPEND-ONLY: un error se corrige con un asiento de ajuste
 *      autorizado, nunca reescribiendo el histórico.
 *   4. `idempotency_key` es ÚNICA: completar dos veces la misma entrega no
 *      duplica la ganancia, y confirmar dos veces el mismo pago no paga doble.
 *   5. Lo que se ha pagado NO se guarda mutando el asiento: se deriva de las
 *      asignaciones de cada liquidación (`payout.allocations`). Así el libro de
 *      ganancias queda intacto y la traza es completa.
 *
 * Tipos de asiento (`courier_earnings`):
 *   · `earning`    → ganancia confirmada de una entrega (importe ≥ 0).
 *   · `adjustment` → corrección autorizada (puede ser negativa). Motivo obligatorio.
 *   · `reversal`   → anulación total de una ganancia (importe negativo).
 *
 * Estado derivado de cada asiento: EARNED · PARTIALLY_PAID · PAID · REVERSED.
 */

import { randomUUID } from 'node:crypto';

export const EARNINGS_COLLECTION = 'courier_earnings';
export const PAYOUTS_COLLECTION = 'courier_payouts';
export const EARNING_KINDS = Object.freeze(['earning', 'adjustment', 'reversal']);
export const PAYOUT_METHODS = Object.freeze(['cash', 'transfer', 'other']);
/**
 * Estados de una liquidación (los tres del negocio):
 *
 *   · `initiated` → declarada/ordenada. RESERVA el saldo pero **no** lo paga.
 *   · `settled`   → administración confirma que el dinero salió. Aquí y solo
 *                   aquí la ganancia del repartidor baja.
 *   · `failed`    → falló o se canceló. LIBERA la reserva (nadie pagó nada).
 *
 * Un documento antiguo sin `state` se interpreta como `settled`: es lo que
 * significaba cuando se creó, y no se reescribe su historia.
 */
export const PAYOUT_STATES = Object.freeze(['initiated', 'settled', 'failed']);

/** Estado efectivo de una liquidación guardada. */
export function payoutStateOf(payout) {
  const raw = String(payout?.state ?? '').trim().toLowerCase();
  return PAYOUT_STATES.includes(raw) ? raw : 'settled';
}

const cents = (value) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.round(number) : 0;
};
const txt = (value, max = 300) => {
  const raw = String(value ?? '').trim();
  return raw ? raw.slice(0, max) : null;
};

/** Estado de un asiento a partir de su importe y lo ya pagado. */
export function earningStatusFor(amountCents, paidCents, kind = 'earning') {
  const amount = cents(amountCents);
  const paid = cents(paidCents);
  if (kind === 'reversal' || amount === 0) return 'REVERSED';
  if (paid <= 0) return 'EARNED';
  if (paid >= amount) return 'PAID';
  return 'PARTIALLY_PAID';
}

/**
 * Cruza asientos con liquidaciones y devuelve filas con `paid_cents`,
 * `reserved_cents`, `outstanding_cents` y `available_cents`.
 *
 *   · `paid_cents`      → asignaciones de liquidaciones CONFIRMADAS.
 *   · `reserved_cents`  → asignaciones de transferencias aún no confirmadas.
 *   · `outstanding_cents` → lo que la empresa debe (importe − pagado).
 *   · `available_cents` → lo que todavía se puede pagar (pendiente − reservado).
 *
 * Una transferencia iniciada NO reduce la deuda: solo impide volver a pagar el
 * mismo saldo. Si falla, la reserva se libera sola (el estado deja de contar).
 */
export function ledgerRows(earnings, payouts, { courierId = null, companyId = null } = {}) {
  const entries = (Array.isArray(earnings) ? earnings : []).filter(
    (row) =>
      (!courierId || row.courier_account_id === courierId) &&
      (!companyId || row.company_id === companyId),
  );
  const paidByEntry = new Map();
  const reservedByEntry = new Map();
  for (const payout of Array.isArray(payouts) ? payouts : []) {
    if (courierId && payout.courier_account_id !== courierId) continue;
    if (companyId && payout.company_id !== companyId) continue;
    const state = payoutStateOf(payout);
    if (state === 'failed') continue;
    const bucket = state === 'settled' ? paidByEntry : reservedByEntry;
    for (const allocation of Array.isArray(payout.allocations) ? payout.allocations : []) {
      const key = String(allocation?.earning_id ?? '');
      if (!key) continue;
      bucket.set(key, (bucket.get(key) ?? 0) + cents(allocation.amount_cents));
    }
  }
  return entries
    .map((row) => {
      const amount = cents(row.amount_cents);
      const paid = paidByEntry.get(String(row.id)) ?? 0;
      const reserved = reservedByEntry.get(String(row.id)) ?? 0;
      /*
       * Un ajuste negativo RESTA deuda: su saldo es negativo a propósito, para
       * que la suma de saldos dé el pendiente real del repartidor. Una ganancia
       * nunca queda por debajo de cero.
       */
      const outstanding =
        row.kind === 'earning' ? Math.max(0, amount - paid) : amount - paid;
      const status =
        row.kind === 'reversal'
          ? 'REVERSED'
          : row.kind === 'adjustment'
            ? 'ADJUSTED'
            : earningStatusFor(amount, paid, row.kind);
      return {
        ...row,
        amount_cents: amount,
        paid_cents: paid,
        reserved_cents: reserved,
        outstanding_cents: outstanding,
        available_cents: Math.max(0, outstanding - reserved),
        status,
      };
    })
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
}

/**
 * Totales del panel. `pending_cents` es lo que la empresa debe y aún no ha pagado:
 * suma de saldos pendientes, no el total menos pagos (un ajuste negativo ya resta).
 */
export function earningsSummary(rows) {
  let earned = 0;
  let paid = 0;
  let reserved = 0;
  let outstanding = 0;
  let incentives = 0;
  let bonuses = 0;
  let base = 0;
  let deliveries = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.kind === 'earning') {
      earned += cents(row.amount_cents);
      base += cents(row.base_cents);
      incentives += cents(row.incentive_cents);
      bonuses += cents(row.bonus_cents);
      deliveries += 1;
    } else if (row.kind === 'adjustment') {
      earned += cents(row.amount_cents);
    }
    paid += cents(row.paid_cents);
    reserved += cents(row.reserved_cents);
    outstanding += cents(row.outstanding_cents);
  }
  return {
    earned_cents: earned,
    paid_cents: paid,
    /* Reservado por transferencias sin confirmar: ni pagado ni disponible. */
    reserved_cents: reserved,
    pending_cents: outstanding,
    available_cents: Math.max(0, outstanding - reserved),
    base_cents: base,
    incentive_cents: incentives,
    bonus_cents: bonuses,
    deliveries_count: deliveries,
    average_cents: deliveries > 0 ? Math.round(earned / deliveries) : 0,
  };
}

/** Agrupa los totales por repartidor (para la tabla del panel). */
export function summaryByCourier(rows, nameOf = (id) => id) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row.courier_account_id ?? '');
    if (!groups.has(key)) {
      groups.set(key, { courier_id: key, courier_name: nameOf(key), rows: [] });
    }
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].map((group) => ({
    courier_id: group.courier_id,
    courier_name: group.courier_name,
    ...earningsSummary(group.rows),
  }));
}

/**
 * Documento de ganancia a partir del cálculo de compensación.
 * Devuelve `null` si no hay importe que registrar: NUNCA se crea un asiento en 0
 * por una política ausente (eso sería inventar una deuda).
 */
export function buildEarningDocument({
  order,
  compensation,
  companyId,
  courierId,
  now = new Date().toISOString(),
  actor = null,
}) {
  if (!compensation || !Number.isFinite(Number(compensation.total_cents))) return null;
  const total = cents(compensation.total_cents);
  if (total <= 0) return null;
  const orderId = String(order?.id ?? order?.order_id ?? '').trim();
  if (!orderId) return null;
  return {
    id: `earn_${randomUUID().replace(/-/g, '')}`,
    kind: 'earning',
    company_id: companyId,
    courier_account_id: courierId,
    order_id: orderId,
    order_number: txt(order?.order_number ?? order?.code, 60),
    delivery_id: txt(order?.delivery?.delivery_id ?? orderId, 80),
    amount_cents: total,
    base_cents: cents(compensation.base_cents),
    incentive_cents: cents(compensation.incentive_cents),
    bonus_cents: cents(compensation.bonus_cents),
    currency: 'DOP',
    policy_snapshot: compensation.breakdown?.policy_snapshot ?? null,
    incentive_lines: compensation.breakdown?.incentive_lines ?? [],
    /* `estimated:false` en el cálculo original → este asiento es definitivo. */
    estimated: false,
    idempotency_key: `earning:${orderId}`,
    actor,
    created_at: now,
  };
}

/**
 * Escribe el asiento de ganancia de forma ATÓMICA e idempotente.
 * La clave única la garantiza la base (`unique: ['idempotency_key']`), no solo
 * la comprobación en memoria: dos peticiones simultáneas no crean dos filas.
 */
export async function recordEarningAtomic({ db, handle, doc }) {
  if (!doc) return { ok: false, status: 422, error: 'invalid_earning' };
  await db.list(EARNINGS_COLLECTION, { limit: 1 });
  const table = 'phytoemagry_courier_earnings';
  if (db.kind === 'postgres') {
    const client = await handle.connect();
    try {
      const inserted = await client.query(
        `INSERT INTO ${table}
          (id, doc, company_id, courier_account_id, order_id, kind, idempotency_key, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [doc.id, JSON.stringify(doc), doc.company_id, doc.courier_account_id,
          doc.order_id, doc.kind, doc.idempotency_key, doc.created_at],
      );
      return { ok: true, duplicate: inserted.rowCount !== 1, doc };
    } finally {
      client.release();
    }
  }
  if (db.kind === 'sqlite') {
    handle.exec('BEGIN IMMEDIATE');
    try {
      const inserted = handle.prepare(`INSERT OR IGNORE INTO ${table}
        (id, doc, company_id, courier_account_id, order_id, kind, idempotency_key, created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(doc.id, JSON.stringify(doc), doc.company_id,
        doc.courier_account_id, doc.order_id, doc.kind, doc.idempotency_key, doc.created_at);
      handle.exec('COMMIT');
      return { ok: true, duplicate: inserted.changes !== 1, doc };
    } catch (error) {
      handle.exec('ROLLBACK');
      throw error;
    }
  }
  const inserted = await db.insert(EARNINGS_COLLECTION, doc);
  return { ok: true, duplicate: inserted?.duplicate === true, doc };
}

/** Valida una liquidación ANTES de escribir nada. */
export function validatePayout({ rows, allocations, method }) {
  const kind = String(method ?? 'cash').trim().toLowerCase();
  if (!PAYOUT_METHODS.includes(kind)) {
    return { ok: false, status: 422, error: 'invalid_method', message: 'Forma de pago no válida.' };
  }
  const requested = Array.isArray(allocations) ? allocations : [];
  if (requested.length === 0) {
    return { ok: false, status: 422, error: 'no_allocations', message: 'Selecciona al menos una ganancia.' };
  }
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const clean = [];
  let total = 0;
  for (const item of requested) {
    const id = String(item?.earning_id ?? '').trim();
    const row = byId.get(id);
    if (!row) {
      return { ok: false, status: 422, error: 'earning_not_found', message: `GANANCIA_INEXISTENTE:${id}` };
    }
    const amount = cents(item?.amount_cents);
    if (amount <= 0) {
      return { ok: false, status: 422, error: 'invalid_amount', message: 'Cada importe debe ser mayor que cero.' };
    }
    if (amount > row.available_cents) {
      return {
        ok: false,
        status: 422,
        error: 'amount_exceeds_outstanding',
        message: `SALDO_INSUFICIENTE:${row.order_number ?? row.order_id}:${row.available_cents}`,
        outstanding_cents: row.available_cents,
        reserved_cents: cents(row.reserved_cents),
      };
    }
    clean.push({ earning_id: id, amount_cents: amount });
    total += amount;
  }
  const available = rows.reduce((sum, row) => sum + cents(row.available_cents), 0);
  if (total > available) {
    return { ok: false, status: 422, error: 'amount_exceeds_outstanding', message: 'El pago supera el saldo confirmado.' };
  }
  return { ok: true, allocations: clean, total_cents: total, method: kind };
}

/**
 * Registra una liquidación de forma atómica.
 *
 * Bloquea por `payout:<repartidor>:<empresa>` para que dos administradores no
 * paguen el mismo saldo a la vez, y usa la clave de idempotencia única: repetir
 * la misma petición devuelve la original en vez de pagar dos veces.
 */
export async function recordPayoutAtomic({
  db,
  handle,
  courierId,
  companyId,
  method,
  reference = null,
  note = null,
  allocations,
  idempotencyKey,
  state = 'settled',
  actor = null,
  now = new Date().toISOString(),
}) {
  await db.list(EARNINGS_COLLECTION, { limit: 1 });
  await db.list(PAYOUTS_COLLECTION, { limit: 1 });
  const earningsTable = 'phytoemagry_courier_earnings';
  const payoutsTable = 'phytoemagry_courier_payouts';
  /*
   * Una liquidación NACE en `initiated` (reserva) o en `settled` (efectivo
   * entregado en el acto). Nunca nace `failed`: eso solo ocurre al fallar una
   * transferencia ya iniciada.
   */
  const payoutState = String(state ?? '').trim().toLowerCase() === 'initiated' ? 'initiated' : 'settled';

  const decide = (earningDocs, payoutDocs) => {
    const prior = payoutDocs.find((row) => row.idempotency_key === idempotencyKey);
    if (prior) {
      if (
        prior.courier_account_id !== courierId ||
        prior.company_id !== companyId ||
        cents(prior.total_cents) !== totalOf(allocations)
      ) {
        return { ok: false, status: 409, error: 'idempotency_scope_conflict' };
      }
      return { ok: true, duplicate: true, payout: prior };
    }
    const rows = ledgerRows(earningDocs, payoutDocs, { courierId, companyId });
    const check = validatePayout({ rows, allocations, method });
    if (!check.ok) return check;
    const payout = {
      id: `pay_${randomUUID().replace(/-/g, '')}`,
      company_id: companyId,
      courier_account_id: courierId,
      method: check.method,
      state: payoutState,
      reference: txt(reference, 120),
      note: txt(note, 300),
      total_cents: check.total_cents,
      currency: 'DOP',
      allocations: check.allocations,
      idempotency_key: idempotencyKey,
      actor,
      created_at: now,
      /* Una transferencia NO queda conciliada sola: la confirma administración. */
      settled_at: payoutState === 'settled' ? now : null,
    };
    return { ok: true, duplicate: false, payout };
  };

  if (db.kind === 'postgres') {
    const client = await handle.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payout:${courierId}:${companyId}`]);
      const earningDocs = (await client.query(`SELECT doc FROM ${earningsTable}`)).rows.map((row) => row.doc);
      const payoutDocs = (await client.query(`SELECT doc FROM ${payoutsTable}`)).rows.map((row) => row.doc);
      const result = decide(earningDocs, payoutDocs);
      if (!result.ok || result.duplicate) {
        await client.query('ROLLBACK');
        return result;
      }
      const payout = result.payout;
      const inserted = await client.query(
        `INSERT INTO ${payoutsTable}
          (id, doc, company_id, courier_account_id, idempotency_key, created_at)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [payout.id, JSON.stringify(payout), companyId, courierId, idempotencyKey, now],
      );
      if (inserted.rowCount !== 1) {
        await client.query('ROLLBACK');
        return { ok: false, status: 409, error: 'idempotency_scope_conflict' };
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  if (db.kind === 'sqlite') {
    handle.exec('BEGIN IMMEDIATE');
    try {
      const earningDocs = handle.prepare(`SELECT doc FROM ${earningsTable}`).all().map((row) => JSON.parse(row.doc));
      const payoutDocs = handle.prepare(`SELECT doc FROM ${payoutsTable}`).all().map((row) => JSON.parse(row.doc));
      const result = decide(earningDocs, payoutDocs);
      if (!result.ok || result.duplicate) {
        handle.exec('ROLLBACK');
        return result;
      }
      const payout = result.payout;
      const inserted = handle.prepare(`INSERT OR IGNORE INTO ${payoutsTable}
        (id, doc, company_id, courier_account_id, idempotency_key, created_at)
        VALUES (?,?,?,?,?,?)`).run(payout.id, JSON.stringify(payout), companyId,
        courierId, idempotencyKey, now);
      if (inserted.changes !== 1) {
        handle.exec('ROLLBACK');
        return { ok: false, status: 409, error: 'idempotency_scope_conflict' };
      }
      handle.exec('COMMIT');
      return result;
    } catch (error) {
      handle.exec('ROLLBACK');
      throw error;
    }
  }
  return { ok: false, status: 503, error: 'atomic_storage_required' };
}

function totalOf(allocations) {
  return (Array.isArray(allocations) ? allocations : []).reduce(
    (sum, item) => sum + cents(item?.amount_cents),
    0,
  );
}

/**
 * CONFIRMAR (o fallar) una liquidación ya registrada.
 *
 * - Bloquea por `payout-settle:<id>`: dos administradores confirmando la misma
 *   transferencia a la vez no pueden dejarla en dos estados distintos.
 * - El importe y las asignaciones NO se tocan nunca: solo cambia el estado y se
 *   **añade** un registro a `settlements[]`/`failures[]` (historial completo).
 * - Repetir la confirmación con la misma clave devuelve el mismo resultado
 *   (idempotente). Con otra clave responde 409 `already_settled`: no se confirma
 *   dos veces lo mismo.
 * - Al fallar se libera la reserva: el saldo vuelve a estar disponible.
 */
export async function settlePayoutAtomic({
  db,
  handle,
  payoutId,
  companyId,
  action = 'settle',
  reference = null,
  note = null,
  idempotencyKey = null,
  actor = null,
  now = new Date().toISOString(),
}) {
  await db.list(PAYOUTS_COLLECTION, { limit: 1 });
  const table = 'phytoemagry_courier_payouts';
  const target = String(action ?? '').toLowerCase() === 'fail' ? 'failed' : 'settled';
  const key = idempotencyKey ?? `${target}:${payoutId}`;

  const decide = (payouts) => {
    const payout = payouts.find((row) => String(row.id) === String(payoutId));
    if (!payout) return { ok: false, status: 404, error: 'not_found' };
    /* Una liquidación de otra empresa no existe para quien la pide. */
    if (companyId && payout.company_id !== companyId) {
      return { ok: false, status: 404, error: 'not_found' };
    }
    const state = payoutStateOf(payout);
    const history = Array.isArray(payout.settlements) ? payout.settlements : [];
    const failures = Array.isArray(payout.failures) ? payout.failures : [];
    const priorEntry = [...history, ...failures].find(
      (row) => String(row.idempotency_key) === String(key),
    );
    if (priorEntry) {
      return { ok: true, duplicate: true, payout, state };
    }
    if (state === 'settled') {
      return {
        ok: false,
        status: 409,
        error: 'already_settled',
        message: 'Esa liquidación ya está confirmada.',
        payout,
      };
    }
    if (state === 'failed') {
      return {
        ok: false,
        status: 409,
        error: 'payout_failed',
        message: 'Esa liquidación está anulada: registra una nueva.',
        payout,
      };
    }
    if (target === 'settled' && !txt(reference, 120)) {
      return {
        ok: false,
        status: 422,
        error: 'reference_required',
        message: 'Escribe la referencia de la transferencia para confirmarla.',
      };
    }
    const entry = {
      idempotency_key: key,
      at: now,
      actor,
      reference: txt(reference, 120),
      note: txt(note, 300),
    };
    const next = target === 'settled'
      ? {
          ...payout,
          state: 'settled',
          settled_at: now,
          settled_by: actor,
          settlement_reference: entry.reference ?? payout.reference ?? null,
          reference: entry.reference ?? payout.reference ?? null,
          settlements: [...history, entry],
          updated_at: now,
        }
      : {
          ...payout,
          state: 'failed',
          failed_at: now,
          failed_by: actor,
          failure_reason: entry.note,
          failures: [...failures, entry],
          updated_at: now,
        };
    return { ok: true, duplicate: false, payout: next, previous: payout, state: target };
  };

  const persist = async (client) => {
    const payouts = client
      ? (await client.query(`SELECT doc FROM ${table}`)).rows.map((row) => row.doc)
      : handle.prepare(`SELECT doc FROM ${table}`).all().map((row) => JSON.parse(row.doc));
    const decision = decide(payouts);
    if (!decision.ok || decision.duplicate) return decision;
    const doc = decision.payout;
    if (client) {
      await client.query(`UPDATE ${table} SET doc = $1 WHERE id = $2`, [JSON.stringify(doc), doc.id]);
    } else {
      handle.prepare(`UPDATE ${table} SET doc = ? WHERE id = ?`).run(JSON.stringify(doc), doc.id);
    }
    return decision;
  };

  if (db.kind === 'postgres') {
    const client = await handle.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payout-settle:${payoutId}`]);
      const result = await persist(client);
      if (!result.ok || result.duplicate) {
        await client.query('ROLLBACK');
        return result;
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  if (db.kind === 'sqlite') {
    handle.exec('BEGIN IMMEDIATE');
    try {
      const result = await persist(null);
      if (!result.ok || result.duplicate) {
        handle.exec('ROLLBACK');
        return result;
      }
      handle.exec('COMMIT');
      return result;
    } catch (error) {
      handle.exec('ROLLBACK');
      throw error;
    }
  }
  return { ok: false, status: 503, error: 'atomic_storage_required' };
}

/**
 * Ajuste o reverso autorizado sobre una ganancia existente.
 *
 * Nunca borra ni reescribe el asiento original: añade uno nuevo con motivo.
 * El importe de un ajuste puede ser negativo (descuento) pero no puede dejar el
 * saldo pendiente por debajo de cero.
 */
export function buildAdjustmentDocument({
  earning,
  amountCents,
  reason,
  companyId,
  courierId,
  kind = 'adjustment',
  actor = null,
  now = new Date().toISOString(),
}) {
  const reasonText = txt(reason, 300);
  if (!earning || !reasonText) return null;
  const amount = cents(amountCents);
  if (amount === 0) return null;
  const type = kind === 'reversal' ? 'reversal' : 'adjustment';
  return {
    id: `${type === 'reversal' ? 'rev' : 'adj'}_${randomUUID().replace(/-/g, '')}`,
    kind: type,
    company_id: companyId,
    courier_account_id: courierId,
    order_id: earning.order_id ?? null,
    order_number: earning.order_number ?? null,
    delivery_id: earning.delivery_id ?? null,
    amount_cents: type === 'reversal' ? -Math.abs(amount) : amount,
    base_cents: 0,
    incentive_cents: 0,
    bonus_cents: 0,
    currency: 'DOP',
    reason: reasonText,
    adjustment_of: earning.id,
    policy_snapshot: earning.policy_snapshot ?? null,
    incentive_lines: [],
    estimated: false,
    idempotency_key: `${type}:${earning.id}:${randomUUID().replace(/-/g, '')}`,
    actor,
    created_at: now,
  };
}
