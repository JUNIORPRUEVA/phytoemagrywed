/**
 * PAGO AL FINALIZAR LA ENTREGA — reglas puras, sin base de datos.
 *
 * Separa definitivamente dos conceptos que antes vivían en un solo campo:
 *   - ESTADO LOGÍSTICO  (lo lleva `delivery-lifecycle.mjs`: entregado, en ruta…)
 *   - ESTADO FINANCIERO (lo calcula este módulo: pagado, parcial, por verificar…)
 *
 * Reglas que no se negocian:
 *   1. La custodia en efectivo es SOLO el efectivo realmente declarado, y nunca
 *      más de lo que se debía cobrar (el cambio no es custodia).
 *   2. Una transferencia declarada por el repartidor NO es dinero verificado: no
 *      genera custodia y deja el pedido «por verificar» hasta que administración
 *      la confirme.
 *   3. «No ha pagado» deja deuda visible y no inventa cobros; puede estar
 *      bloqueado por política del pedido (prepago / sin crédito).
 *   4. Dinero en centavos enteros. Nada de coma flotante.
 */

export const DELIVERY_PAYMENT = Object.freeze({
  CASH: 'cash',
  TRANSFER: 'transfer',
  MIXED: 'mixed',
  UNPAID: 'unpaid',
});

export const FINANCIAL_STATE = Object.freeze({
  PAID: 'paid',
  PARTIAL: 'partial',
  TRANSFER_PENDING: 'transfer_pending',
  PENDING: 'pending',
});

const cents = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
};

const clampToDue = (amount, due) => Math.max(0, Math.min(amount, due));

/**
 * @param {object} input
 * @param {string} input.method           cash | transfer | mixed | unpaid
 * @param {number} input.dueCents         saldo realmente pendiente (autoridad: servidor)
 * @param {number} [input.cashDeclaredCents]
 * @param {number} [input.transferDeclaredCents]
 * @param {string} [input.reason]         motivo de la diferencia (si no cubre el saldo)
 * @param {string} [input.unpaidReason]   motivo cuando no se cobra nada
 * @param {boolean} [input.allowUnpaid]   la política del pedido permite entregar sin pagar
 * @param {boolean} [input.alreadyPaid]   el pedido ya estaba pagado antes de la entrega
 */
export function planDeliveryPayment({
  method,
  dueCents,
  cashDeclaredCents = 0,
  transferDeclaredCents = 0,
  reason = null,
  unpaidReason = null,
  allowUnpaid = true,
  alreadyPaid = false,
} = {}) {
  const due = Math.max(0, cents(dueCents) ?? 0);
  const kind = String(method ?? '').trim().toLowerCase();

  if (!Object.values(DELIVERY_PAYMENT).includes(kind)) {
    return { ok: false, status: 422, error: 'invalid_payment_method', message: 'Elige cómo pagó el cliente: efectivo, transferencia, mixto o no pagó.' };
  }

  /* Nada que cobrar: el pago ya se había verificado antes de la entrega. */
  if (due === 0) {
    return {
      ok: true,
      payment: { method: kind, cash_cents: 0, transfer_cents: 0, still_due_cents: 0, reason: null, unpaid_reason: null },
      custodyCents: 0,
      transferPendingCents: 0,
      stillDueCents: 0,
      financialState: FINANCIAL_STATE.PAID,
      alreadyPaid: true || alreadyPaid,
    };
  }

  const cashRaw = cents(cashDeclaredCents);
  const transferRaw = cents(transferDeclaredCents);
  if ((cashRaw !== null && cashRaw < 0) || (transferRaw !== null && transferRaw < 0)) {
    return { ok: false, status: 422, error: 'invalid_amount', message: 'Los importes no pueden ser negativos.' };
  }

  if (kind === DELIVERY_PAYMENT.UNPAID) {
    if (!allowUnpaid) {
      return {
        ok: false,
        status: 409,
        error: 'unpaid_not_allowed',
        message: 'Este pedido exige pago al entregar: no se puede cerrar sin cobrar. Cobra o cancela con administración.',
        due_cents: due,
      };
    }
    const why = String(unpaidReason ?? '').trim();
    if (why.length < 4) {
      return {
        ok: false,
        status: 422,
        error: 'unpaid_reason_required',
        message: 'Explica por qué se entrega sin cobrar (el pedido queda con deuda).',
        due_cents: due,
      };
    }
    return {
      ok: true,
      payment: { method: kind, cash_cents: 0, transfer_cents: 0, still_due_cents: due, reason: null, unpaid_reason: why.slice(0, 300) },
      custodyCents: 0,
      transferPendingCents: 0,
      stillDueCents: due,
      financialState: FINANCIAL_STATE.PENDING,
    };
  }

  /* Efectivo y transferencia declarados por el repartidor. */
  const cashAsked = kind === DELIVERY_PAYMENT.TRANSFER ? 0 : Math.max(0, cashRaw ?? 0);
  const transferAsked = kind === DELIVERY_PAYMENT.CASH ? 0 : Math.max(0, transferRaw ?? 0);
  const cash = clampToDue(cashAsked, due);
  const transfer = clampToDue(transferAsked, due - cash);
  const declaredTotal = cash + transfer;
  const stillDue = due - declaredTotal;

  if (declaredTotal === 0) {
    return {
      ok: false,
      status: 422,
      /* Compatibilidad: el móvil ya conoce `cash_amount_required` para efectivo. */
      error: kind === DELIVERY_PAYMENT.CASH ? 'cash_amount_required' : 'amount_required',
      message: kind === DELIVERY_PAYMENT.CASH
        ? 'Indica cuánto efectivo recibiste del cliente.'
        : 'Indica cuánto te transfirió el cliente.',
      due_cents: due,
    };
  }

  const why = String(reason ?? '').trim();
  if (stillDue > 0 && why.length < 4) {
    return {
      ok: false,
      status: 422,
      error: 'difference_reason_required',
      message: 'El importe no cubre el saldo: escribe el motivo.',
      due_cents: due,
      declared_cents: declaredTotal,
      difference_cents: stillDue,
    };
  }

  const financialState =
    stillDue > 0
      ? FINANCIAL_STATE.PARTIAL
      : transfer > 0
        ? FINANCIAL_STATE.TRANSFER_PENDING
        : FINANCIAL_STATE.PAID;

  return {
    ok: true,
    payment: {
      method: kind,
      cash_cents: cash,
      transfer_cents: transfer,
      still_due_cents: stillDue,
      /* Lo que excedía el saldo se devolvió como cambio: no es custodia. */
      cash_change_cents: Math.max(0, cashAsked - cash),
      transfer_excess_cents: Math.max(0, transferAsked - transfer),
      reason: why ? why.slice(0, 300) : null,
      unpaid_reason: null,
      transfer_pending: transfer > 0,
    },
    /* SOLO el efectivo entra a custodia. La transferencia no. */
    custodyCents: cash,
    transferPendingCents: transfer,
    stillDueCents: stillDue,
    financialState,
  };
}

/**
 * Transición del ESTADO FINANCIERO cuando administración verifica o rechaza una
 * transferencia declarada. No toca el estado logístico.
 */
export function applyTransferVerification({ order, decision, reference = null, actor = null, now = new Date().toISOString() } = {}) {
  const delivery = order?.delivery ?? {};
  const declared = Math.max(0, cents(delivery.transfer_declared_cents) ?? 0);
  const verifiedBefore = Math.max(0, cents(delivery.transfer_verified_cents) ?? 0);
  if (declared <= 0) {
    return { ok: false, status: 409, error: 'no_transfer_declared', message: 'Este pedido no tiene transferencia declarada.' };
  }
  if (verifiedBefore > 0) {
    /* Verificada anteriormente: no se vuelve a registrar el mismo pago. */
    return { ok: false, status: 409, error: 'transfer_already_verified', message: 'La transferencia de este pedido ya estaba verificada.' };
  }
  const answer = String(decision ?? '').toLowerCase();
  if (!['verified', 'rejected'].includes(answer)) {
    return { ok: false, status: 422, error: 'invalid_decision', message: 'Decide si la transferencia se recibió o no.' };
  }
  const verified = answer === 'verified' ? declared : 0;
  const due = Math.max(0, cents(delivery.cash_expected_cents) ?? 0);
  const cash = Math.max(0, cents(delivery.cash_declared_cents) ?? 0);
  const stillDue = Math.max(0, due - cash - verified);
  const financialState =
    answer === 'rejected'
      ? (cash > 0 ? FINANCIAL_STATE.PARTIAL : FINANCIAL_STATE.PENDING)
      : stillDue > 0
        ? FINANCIAL_STATE.PARTIAL
        : FINANCIAL_STATE.PAID;
  return {
    ok: true,
    financialState,
    stillDueCents: stillDue,
    transferVerifiedCents: verified,
    record: {
      decision: answer,
      amount_cents: answer === 'verified' ? declared : 0,
      declared_cents: declared,
      reference: reference ? String(reference).trim().slice(0, 120) : null,
      actor: actor ?? null,
      at: now,
    },
  };
}
