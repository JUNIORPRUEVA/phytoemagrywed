import { describe, expect, it } from 'vitest';

import {
  buildAdjustmentDocument,
  buildEarningDocument,
  earningStatusFor,
  earningsSummary,
  ledgerRows,
  recordEarningAtomic,
  recordPayoutAtomic,
  settlePayoutAtomic,
  summaryByCourier,
  validatePayout,
} from '../server/courier-earnings.mjs';

const compensation = (base, incentive = 0, bonus = 0) => ({
  base_cents: base,
  incentive_cents: incentive,
  bonus_cents: bonus,
  total_cents: base + incentive + bonus,
  estimated: true,
  breakdown: {
    base_model: 'DELIVERY_FEE',
    incentive_lines: [],
    policy_snapshot: { base_model: 'DELIVERY_FEE' },
  },
});

const order = (overrides = {}) => ({
  id: 'ord_1',
  order_number: 'PE-1',
  status: 'entregado',
  delivery_fee: 150,
  delivery: { fee: 150 },
  items: [],
  ...overrides,
});

const earning = (overrides = {}) => ({
  id: 'earn_a',
  kind: 'earning',
  company_id: 'phytoemagry',
  courier_account_id: 'cur_1',
  order_id: 'ord_1',
  order_number: 'PE-1',
  amount_cents: 20000,
  base_cents: 15000,
  incentive_cents: 5000,
  bonus_cents: 0,
  created_at: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

describe('estado de un asiento', () => {
  it('EARNED sin pagos, PARTIALLY_PAID con pago parcial y PAID al cubrirlo', () => {
    expect(earningStatusFor(20000, 0)).toBe('EARNED');
    expect(earningStatusFor(20000, 5000)).toBe('PARTIALLY_PAID');
    expect(earningStatusFor(20000, 20000)).toBe('PAID');
  });

  it('un reverso queda REVERSED aunque no tenga pagos', () => {
    expect(earningStatusFor(-20000, 0, 'reversal')).toBe('REVERSED');
  });
});

describe('ledgerRows', () => {
  it('deriva lo pagado y el saldo desde las asignaciones de las liquidaciones', () => {
    const payouts = [{ company_id: 'phytoemagry', courier_account_id: 'cur_1', allocations: [
      { earning_id: 'earn_a', amount_cents: 5000 },
    ] }];
    const [row] = ledgerRows([earning()], payouts, { companyId: 'phytoemagry' });
    expect(row.paid_cents).toBe(5000);
    expect(row.outstanding_cents).toBe(15000);
    expect(row.status).toBe('PARTIALLY_PAID');
  });

  it('no mezcla ganancias de otra empresa ni de otro repartidor', () => {
    const rows = [
      earning(),
      earning({ id: 'earn_b', company_id: 'fulltech' }),
      earning({ id: 'earn_c', courier_account_id: 'cur_2' }),
    ];
    const filtered = ledgerRows(rows, [], { companyId: 'phytoemagry', courierId: 'cur_1' });
    expect(filtered.map((row) => row.id)).toEqual(['earn_a']);
  });
});

describe('earningsSummary', () => {
  it('suma ganado, pagado y pendiente, y separa base de incentivos', () => {
    const rows = ledgerRows(
      [earning(), earning({ id: 'earn_b', amount_cents: 10000, base_cents: 10000, incentive_cents: 0 })],
      [{ company_id: 'phytoemagry', courier_account_id: 'cur_1', allocations: [
        { earning_id: 'earn_a', amount_cents: 20000 },
      ] }],
      { companyId: 'phytoemagry' },
    );
    const summary = earningsSummary(rows);
    expect(summary.earned_cents).toBe(30000);
    expect(summary.paid_cents).toBe(20000);
    expect(summary.pending_cents).toBe(10000);
    expect(summary.deliveries_count).toBe(2);
    expect(summary.base_cents).toBe(25000);
    expect(summary.incentive_cents).toBe(5000);
    expect(summary.average_cents).toBe(15000);
  });

  it('un ajuste negativo reduce lo ganado y lo pendiente', () => {
    const rows = ledgerRows(
      [
        earning(),
        earning({ id: 'adj_1', kind: 'adjustment', amount_cents: -2000, base_cents: 0, incentive_cents: 0 }),
      ],
      [],
      { companyId: 'phytoemagry' },
    );
    const summary = earningsSummary(rows);
    expect(summary.earned_cents).toBe(18000);
    expect(summary.pending_cents).toBe(18000);
  });
});

describe('summaryByCourier', () => {
  it('agrupa por repartidor', () => {
    const rows = ledgerRows(
      [earning(), earning({ id: 'earn_d', courier_account_id: 'cur_2' })],
      [],
      { companyId: 'phytoemagry' },
    );
    const groups = summaryByCourier(rows);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.earned_cents === 20000)).toBe(true);
  });
});

describe('validatePayout', () => {
  const rows = ledgerRows([earning()], [], { companyId: 'phytoemagry' });

  it('rechaza sin asignaciones y con forma de pago desconocida', () => {
    expect(validatePayout({ rows, allocations: [], method: 'cash' }).error).toBe('no_allocations');
    expect(
      validatePayout({ rows, allocations: [{ earning_id: 'earn_a', amount_cents: 1000 }], method: 'bitcoin' })
        .error,
    ).toBe('invalid_method');
  });

  it('rechaza pagar más que el saldo confirmado', () => {
    const result = validatePayout({
      rows,
      allocations: [{ earning_id: 'earn_a', amount_cents: 25000 }],
      method: 'cash',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('amount_exceeds_outstanding');
    expect(result.outstanding_cents).toBe(20000);
  });

  it('acepta un pago parcial correcto', () => {
    const result = validatePayout({
      rows,
      allocations: [{ earning_id: 'earn_a', amount_cents: 8000 }],
      method: 'transfer',
    });
    expect(result.ok).toBe(true);
    expect(result.total_cents).toBe(8000);
  });
});

describe('buildEarningDocument', () => {
  it('devuelve null sin importe: jamás una deuda en cero', () => {
    expect(buildEarningDocument({ order: order(), compensation: null, companyId: 'x', courierId: 'y' })).toBeNull();
    expect(
      buildEarningDocument({ order: order(), compensation: compensation(0), companyId: 'x', courierId: 'y' }),
    ).toBeNull();
  });

  it('guarda el desglose y una clave de idempotencia por pedido', () => {
    const doc = buildEarningDocument({
      order: order(),
      compensation: compensation(15000, 5000),
      companyId: 'phytoemagry',
      courierId: 'cur_1',
    });
    expect(doc.amount_cents).toBe(20000);
    expect(doc.incentive_cents).toBe(5000);
    expect(doc.idempotency_key).toBe('earning:ord_1');
    expect(doc.estimated).toBe(false);
    expect(doc.policy_snapshot.base_model).toBe('DELIVERY_FEE');
  });
});

describe('buildAdjustmentDocument', () => {
  it('exige motivo', () => {
    expect(
      buildAdjustmentDocument({ earning: earning(), amountCents: -1000, reason: '', companyId: 'x', courierId: 'y' }),
    ).toBeNull();
  });

  it('un reverso siempre es negativo y apunta al asiento original', () => {
    const doc = buildAdjustmentDocument({
      earning: earning(),
      amountCents: 20000,
      reason: 'entrega anulada',
      companyId: 'phytoemagry',
      courierId: 'cur_1',
      kind: 'reversal',
    });
    expect(doc.amount_cents).toBe(-20000);
    expect(doc.adjustment_of).toBe('earn_a');
  });
});

/* ------------------------------------------------------------------ */
/* INTEGRACIÓN CON SQLITE: idempotencia REAL en la base                */
/* ------------------------------------------------------------------ */

describe('libro persistente (sqlite)', () => {
  const openStore = async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { createCollections } = await import('../server/collections.mjs');
    const handle = new DatabaseSync(':memory:');
    const db = await createCollections({ backend: 'sqlite', handle, prefix: 'phytoemagry_' });
    return { db, handle };
  };

  it('completar la misma entrega dos veces NO duplica la ganancia', async () => {
    const { db, handle } = await openStore();
    const doc = buildEarningDocument({
      order: order(),
      compensation: compensation(15000, 5000),
      companyId: 'phytoemagry',
      courierId: 'cur_1',
    });
    const first = await recordEarningAtomic({ db, handle, doc });
    const second = await recordEarningAtomic({ db, handle, doc: { ...doc, id: 'earn_otro' } });
    expect(first.ok).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    const rows = await db.list('courier_earnings', { limit: 100 });
    expect(rows).toHaveLength(1);
  });

  it('un pago duplicado se rechaza y un segundo pago no puede superar el saldo', async () => {
    const { db, handle } = await openStore();
    await recordEarningAtomic({
      db,
      handle,
      doc: buildEarningDocument({
        order: order(),
        compensation: compensation(15000, 5000),
        companyId: 'phytoemagry',
        courierId: 'cur_1',
      }),
    });
    const earnings = await db.list('courier_earnings', { limit: 100 });
    const earningId = earnings[0].id;
    const allocations = [{ earning_id: earningId, amount_cents: 8000 }];

    const first = await recordPayoutAtomic({
      db, handle, courierId: 'cur_1', companyId: 'phytoemagry', method: 'cash',
      allocations, idempotencyKey: 'pay:1', actor: 'admin',
    });
    expect(first.ok).toBe(true);
    expect(first.payout.total_cents).toBe(8000);

    /* Misma clave → devuelve la original, no paga otra vez. */
    const again = await recordPayoutAtomic({
      db, handle, courierId: 'cur_1', companyId: 'phytoemagry', method: 'cash',
      allocations, idempotencyKey: 'pay:1', actor: 'admin',
    });
    expect(again.duplicate).toBe(true);

    /* Saldo restante 12000: pagar 15000 más es imposible. */
    const tooMuch = await recordPayoutAtomic({
      db, handle, courierId: 'cur_1', companyId: 'phytoemagry', method: 'cash',
      allocations: [{ earning_id: earningId, amount_cents: 15000 }],
      idempotencyKey: 'pay:2', actor: 'admin',
    });
    expect(tooMuch.ok).toBe(false);
    expect(tooMuch.error).toBe('amount_exceeds_outstanding');

    /* Pagar el resto sí se permite; queda RESERVADO hasta confirmarlo. */
    const rest = await recordPayoutAtomic({
      db, handle, courierId: 'cur_1', companyId: 'phytoemagry', method: 'transfer',
      allocations: [{ earning_id: earningId, amount_cents: 12000 }],
      idempotencyKey: 'pay:3', actor: 'admin', state: 'initiated',
    });
    expect(rest.ok).toBe(true);
    expect(rest.payout.state).toBe('initiated');

    /*
     * Una transferencia INICIADA no paga nada: el saldo sigue debiéndose y lo
     * único que hace es reservarlo para que nadie más lo pague.
     */
    const beforeSettle = ledgerRows(
      await db.list('courier_earnings', { limit: 100 }),
      await db.list('courier_payouts', { limit: 100 }),
      { companyId: 'phytoemagry' },
    );
    expect(beforeSettle[0].paid_cents).toBe(8000);
    expect(beforeSettle[0].outstanding_cents).toBe(12000);
    expect(beforeSettle[0].reserved_cents).toBe(12000);
    expect(beforeSettle[0].available_cents).toBe(0);
    expect(beforeSettle[0].status).toBe('PARTIALLY_PAID');

    /* No se puede volver a pagar lo reservado. */
    const doubleBook = await recordPayoutAtomic({
      db, handle, courierId: 'cur_1', companyId: 'phytoemagry', method: 'cash',
      allocations: [{ earning_id: earningId, amount_cents: 12000 }],
      idempotencyKey: 'pay:4', actor: 'admin',
    });
    expect(doubleBook.ok).toBe(false);
    expect(doubleBook.error).toBe('amount_exceeds_outstanding');

    /* Al confirmar la transferencia, el saldo baja de verdad. */
    const settled = await settlePayoutAtomic({
      db, handle, payoutId: rest.payout.id, companyId: 'phytoemagry',
      action: 'settle', reference: 'TRF-123', actor: 'admin',
    });
    expect(settled.ok).toBe(true);
    expect(settled.payout.state).toBe('settled');

    /* Confirmar dos veces con otra clave se rechaza. */
    const twice = await settlePayoutAtomic({
      db, handle, payoutId: rest.payout.id, companyId: 'phytoemagry',
      action: 'settle', reference: 'TRF-123', idempotencyKey: 'otra', actor: 'admin',
    });
    expect(twice.ok).toBe(false);
    expect(twice.error).toBe('already_settled');

    const allEarnings = await db.list('courier_earnings', { limit: 100 });
    const allPayouts = await db.list('courier_payouts', { limit: 100 });
    const rows = ledgerRows(allEarnings, allPayouts, { companyId: 'phytoemagry' });
    expect(rows[0].paid_cents).toBe(20000);
    expect(rows[0].outstanding_cents).toBe(0);
    expect(rows[0].status).toBe('PAID');
  });

  it('una transferencia fallida libera la reserva y no paga nada', async () => {
    const { db, handle } = await openStore();
    await recordEarningAtomic({
      db, handle,
      doc: buildEarningDocument({
        order: order(), compensation: compensation(10000), companyId: 'phytoemagry', courierId: 'cur_1',
      }),
    });
    const earnings = await db.list('courier_earnings', { limit: 100 });
    const earningId = earnings[0].id;
    const created = await recordPayoutAtomic({
      db, handle, courierId: 'cur_1', companyId: 'phytoemagry', method: 'transfer',
      allocations: [{ earning_id: earningId, amount_cents: 10000 }],
      idempotencyKey: 'pay:t1', state: 'initiated',
    });
    expect(created.ok).toBe(true);

    const failed = await settlePayoutAtomic({
      db, handle, payoutId: created.payout.id, companyId: 'phytoemagry',
      action: 'fail', note: 'rechazada por el banco',
    });
    expect(failed.ok).toBe(true);
    expect(failed.payout.state).toBe('failed');
    expect(failed.payout.total_cents).toBe(10000);
    /* El importe y las asignaciones NO se tocan: solo cambia el estado. */
    expect(failed.payout.allocations).toEqual(created.payout.allocations);

    const rows = ledgerRows(
      await db.list('courier_earnings', { limit: 100 }),
      await db.list('courier_payouts', { limit: 100 }),
      { companyId: 'phytoemagry' },
    );
    expect(rows[0].paid_cents).toBe(0);
    expect(rows[0].reserved_cents).toBe(0);
    expect(rows[0].outstanding_cents).toBe(10000);
    expect(rows[0].available_cents).toBe(10000);

    /* Un pago anulado no se puede confirmar después. */
    const settleFailed = await settlePayoutAtomic({
      db, handle, payoutId: created.payout.id, companyId: 'phytoemagry',
      action: 'settle', reference: 'X',
    });
    expect(settleFailed.ok).toBe(false);
    expect(settleFailed.error).toBe('payout_failed');
  });

  it('confirmar exige referencia y respeta el alcance de empresa', async () => {
    const { db, handle } = await openStore();
    await recordEarningAtomic({
      db, handle,
      doc: buildEarningDocument({
        order: order(), compensation: compensation(5000), companyId: 'phytoemagry', courierId: 'cur_1',
      }),
    });
    const earnings = await db.list('courier_earnings', { limit: 100 });
    const created = await recordPayoutAtomic({
      db, handle, courierId: 'cur_1', companyId: 'phytoemagry', method: 'transfer',
      allocations: [{ earning_id: earnings[0].id, amount_cents: 5000 }],
      idempotencyKey: 'pay:r1', state: 'initiated',
    });
    const noRef = await settlePayoutAtomic({
      db, handle, payoutId: created.payout.id, companyId: 'phytoemagry', action: 'settle',
    });
    expect(noRef.ok).toBe(false);
    expect(noRef.error).toBe('reference_required');

    const otherCompany = await settlePayoutAtomic({
      db, handle, payoutId: created.payout.id, companyId: 'fulltech',
      action: 'settle', reference: 'TRF-9',
    });
    expect(otherCompany.ok).toBe(false);
    expect(otherCompany.error).toBe('not_found');
  });

  it('no toca el libro de custodia al pagar', async () => {
    const { db, handle } = await openStore();
    await recordEarningAtomic({
      db, handle,
      doc: buildEarningDocument({
        order: order(), compensation: compensation(10000), companyId: 'phytoemagry', courierId: 'cur_1',
      }),
    });
    const earnings = await db.list('courier_earnings', { limit: 100 });
    await recordPayoutAtomic({
      db, handle, courierId: 'cur_1', companyId: 'phytoemagry', method: 'cash',
      allocations: [{ earning_id: earnings[0].id, amount_cents: 10000 }],
      idempotencyKey: 'pay:x',
    });
    expect(await db.list('delivery_cash_ledger', { limit: 100 })).toHaveLength(0);
  });
});
