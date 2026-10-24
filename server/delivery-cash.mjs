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
