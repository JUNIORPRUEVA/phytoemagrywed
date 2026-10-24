// @vitest-environment node
/**
 * PAGO AL FINALIZAR LA ENTREGA — reglas puras.
 *
 * Lo importante que se demuestra aquí:
 *  - la custodia es SOLO el efectivo declarado y nunca más que el saldo;
 *  - una transferencia declarada no es dinero verificado ni custodia;
 *  - «no pagado» deja deuda y puede estar bloqueado por política;
 *  - el estado financiero es independiente del logístico.
 */
import { describe, expect, it } from 'vitest';

import { FINANCIAL_STATE, applyTransferVerification, planDeliveryPayment } from '../server/delivery-payment.mjs';

const DUE = 250000; // RD$2.500

describe('efectivo', () => {
  it('completo: custodia por el total y queda pagado', () => {
    const plan = planDeliveryPayment({ method: 'cash', dueCents: DUE, cashDeclaredCents: DUE });
    expect(plan.ok).toBe(true);
    expect(plan.custodyCents).toBe(DUE);
    expect(plan.transferPendingCents).toBe(0);
    expect(plan.stillDueCents).toBe(0);
    expect(plan.financialState).toBe(FINANCIAL_STATE.PAID);
  });

  it('parcial con motivo: custodia solo por lo recibido y queda saldo', () => {
    const plan = planDeliveryPayment({ method: 'cash', dueCents: DUE, cashDeclaredCents: 200000, reason: 'Cliente pagó parte' });
    expect(plan.ok).toBe(true);
    expect(plan.custodyCents).toBe(200000);
    expect(plan.stillDueCents).toBe(50000);
    expect(plan.financialState).toBe(FINANCIAL_STATE.PARTIAL);
  });

  it('parcial sin motivo se rechaza', () => {
    const plan = planDeliveryPayment({ method: 'cash', dueCents: DUE, cashDeclaredCents: 200000 });
    expect(plan.ok).toBe(false);
    expect(plan.error).toBe('difference_reason_required');
    expect(plan.difference_cents).toBe(50000);
  });

  it('sin importe declarado se rechaza', () => {
    expect(planDeliveryPayment({ method: 'cash', dueCents: DUE }).error).toBe('cash_amount_required');
    expect(planDeliveryPayment({ method: 'transfer', dueCents: DUE }).error).toBe('amount_required');
  });

  it('importe negativo o no numérico se rechaza', () => {
    expect(planDeliveryPayment({ method: 'cash', dueCents: DUE, cashDeclaredCents: -1 }).error).toBe('invalid_amount');
    expect(planDeliveryPayment({ method: 'cash', dueCents: DUE, cashDeclaredCents: 'mucho' }).error).toBe('cash_amount_required');
  });

  it('efectivo mayor al saldo: la custodia se topa al saldo y el resto es cambio', () => {
    const plan = planDeliveryPayment({ method: 'cash', dueCents: DUE, cashDeclaredCents: 300000 });
    expect(plan.ok).toBe(true);
    expect(plan.custodyCents).toBe(DUE);
    expect(plan.payment.cash_change_cents).toBe(50000);
  });
});

describe('transferencia', () => {
  it('declarada: sin custodia y pendiente de verificación', () => {
    const plan = planDeliveryPayment({ method: 'transfer', dueCents: DUE, transferDeclaredCents: DUE });
    expect(plan.ok).toBe(true);
    expect(plan.custodyCents).toBe(0);
    expect(plan.transferPendingCents).toBe(DUE);
    expect(plan.financialState).toBe(FINANCIAL_STATE.TRANSFER_PENDING);
    expect(plan.stillDueCents).toBe(0);
  });

  it('parcial con motivo', () => {
    const plan = planDeliveryPayment({ method: 'transfer', dueCents: DUE, transferDeclaredCents: 100000, reason: 'Transfirió la mitad' });
    expect(plan.ok).toBe(true);
    expect(plan.custodyCents).toBe(0);
    expect(plan.stillDueCents).toBe(150000);
  });
});

describe('mixto', () => {
  it('divide: custodia por el efectivo y el resto por verificar', () => {
    const plan = planDeliveryPayment({ method: 'mixed', dueCents: DUE, cashDeclaredCents: 100000, transferDeclaredCents: 150000 });
    expect(plan.ok).toBe(true);
    expect(plan.custodyCents).toBe(100000);
    expect(plan.transferPendingCents).toBe(150000);
    expect(plan.stillDueCents).toBe(0);
    expect(plan.financialState).toBe(FINANCIAL_STATE.TRANSFER_PENDING);
  });

  it('mixto parcial deja saldo y exige motivo', () => {
    const plan = planDeliveryPayment({ method: 'mixed', dueCents: DUE, cashDeclaredCents: 50000, transferDeclaredCents: 50000, reason: 'Falta el resto' });
    expect(plan.stillDueCents).toBe(150000);
    expect(plan.custodyCents).toBe(50000);
    expect(plan.financialState).toBe(FINANCIAL_STATE.PARTIAL);
  });

  it('los dos importes cero se rechazan', () => {
    expect(planDeliveryPayment({ method: 'mixed', dueCents: DUE }).error).toBe('amount_required');
  });
});

describe('no ha pagado', () => {
  it('autorizado: deuda visible, sin custodia', () => {
    const plan = planDeliveryPayment({ method: 'unpaid', dueCents: DUE, unpaidReason: 'Cliente acordó pagar mañana' });
    expect(plan.ok).toBe(true);
    expect(plan.custodyCents).toBe(0);
    expect(plan.stillDueCents).toBe(DUE);
    expect(plan.financialState).toBe(FINANCIAL_STATE.PENDING);
  });

  it('exige motivo', () => {
    expect(planDeliveryPayment({ method: 'unpaid', dueCents: DUE }).error).toBe('unpaid_reason_required');
  });

  it('bloqueado por política (prepago) aunque haya motivo', () => {
    const plan = planDeliveryPayment({ method: 'unpaid', dueCents: DUE, unpaidReason: 'no paga ahora', allowUnpaid: false });
    expect(plan.ok).toBe(false);
    expect(plan.error).toBe('unpaid_not_allowed');
    expect(plan.status).toBe(409);
  });
});

describe('casos de borde', () => {
  it('método inválido', () => {
    expect(planDeliveryPayment({ method: 'bitcoin', dueCents: DUE }).error).toBe('invalid_payment_method');
  });

  it('saldo cero: ya estaba pagado, no se pide nada', () => {
    const plan = planDeliveryPayment({ method: 'cash', dueCents: 0 });
    expect(plan.ok).toBe(true);
    expect(plan.custodyCents).toBe(0);
    expect(plan.financialState).toBe(FINANCIAL_STATE.PAID);
  });

  it('usa centavos enteros', () => {
    const plan = planDeliveryPayment({ method: 'cash', dueCents: 250000, cashDeclaredCents: 249999.6 });
    expect(plan.custodyCents).toBe(250000);
  });
});

describe('verificación por administración', () => {
  const order = {
    delivery: { cash_expected_cents: DUE, cash_declared_cents: 100000, transfer_declared_cents: 150000 },
  };

  it('verificada: el saldo baja y queda pagado', () => {
    const result = applyTransferVerification({ order, decision: 'verified', reference: 'TRX-1', actor: 'admin' });
    expect(result.ok).toBe(true);
    expect(result.transferVerifiedCents).toBe(150000);
    expect(result.stillDueCents).toBe(0);
    expect(result.financialState).toBe(FINANCIAL_STATE.PAID);
    expect(result.record.actor).toBe('admin');
  });

  it('rechazada: vuelve a quedar pendiente', () => {
    const result = applyTransferVerification({ order, decision: 'rejected' });
    expect(result.ok).toBe(true);
    expect(result.transferVerifiedCents).toBe(0);
    expect(result.stillDueCents).toBe(150000);
    expect(result.financialState).toBe(FINANCIAL_STATE.PARTIAL);
  });

  it('no se puede verificar dos veces el mismo pago', () => {
    const once = applyTransferVerification({ order, decision: 'verified' });
    const twice = applyTransferVerification({
      order: { delivery: { ...order.delivery, transfer_verified_cents: once.transferVerifiedCents } },
      decision: 'verified',
    });
    expect(twice.ok).toBe(false);
    expect(twice.error).toBe('transfer_already_verified');
  });

  it('pedido sin transferencia declarada', () => {
    expect(applyTransferVerification({ order: { delivery: {} }, decision: 'verified' }).error).toBe('no_transfer_declared');
  });

  it('decisión inválida', () => {
    expect(applyTransferVerification({ order, decision: 'quizas' }).error).toBe('invalid_decision');
  });
});
