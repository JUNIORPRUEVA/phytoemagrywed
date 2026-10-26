// @vitest-environment node
/**
 * CONCILIACIÓN DE CUSTODIA — reglas puras (sin base, sin servidor).
 *
 * Lo que se prueba: que la conciliación DETECTA y DESCRIBE, y que no toca nada.
 * El servicio recibe copias de los datos y devuelve un informe: si mutara las
 * entradas, la prueba de inmutabilidad de abajo fallaría.
 */
import { describe, expect, it } from 'vitest';

import { reconcileDeliveryCash, reconcileDeliveryCashByCompany } from '../server/delivery-reconciliation.mjs';

const deliveredOrder = (id, { expected = 500000, declared = 500000 } = {}) => ({
  id,
  status: 'entregado',
  delivery: {
    lifecycle: 'DELIVERED',
    cash_expected_cents: expected,
    cash_declared_cents: declared,
  },
});

const charge = (orderId, amount, { key = `charge:${orderId}`, courier = 'courier_a', id = `cash_${orderId}` } = {}) => ({
  id,
  kind: 'charge',
  order_id: orderId,
  courier_account_id: courier,
  amount_cents: amount,
  idempotency_key: key,
  created_at: '2026-10-24T10:00:00.000Z',
});

const remittance = (amount, { courier = 'courier_a', key = `remittance:${courier}:${amount}`, id = `cash_rem_${amount}` } = {}) => ({
  id,
  kind: 'remittance',
  order_id: null,
  courier_account_id: courier,
  amount_cents: amount,
  idempotency_key: key,
  created_at: '2026-10-24T11:00:00.000Z',
});

it('conciliación empresarial conserva saldos separados y pone rendiciones históricas ambiguas en revisión', () => {
  const orders = [
    { ...deliveredOrder('phyto'), company_id: 'phytoemagry' },
    { ...deliveredOrder('tech'), company_id: 'fulltech', origin: 'FULLTECH_STORE' },
  ];
  const ledger = [
    { ...charge('phyto', 500000), company_id: 'phytoemagry' },
    { ...charge('tech', 500000), company_id: 'fulltech' },
    { ...remittance(200000), company_id: 'fulltech' },
    remittance(100000, { id: 'ambiguous_legacy', key: 'legacy:unknown' }),
  ];
  const before = JSON.stringify({ orders, ledger });
  const result = reconcileDeliveryCashByCompany({ orders, ledger, companies: ['phytoemagry', 'fulltech'] });
  expect(result.by_company.phytoemagry.totals.pendingCents).toBe(500000);
  expect(result.by_company.fulltech.totals.pendingCents).toBe(300000);
  expect(result.unresolved_movements.map((row) => row.id)).toEqual(['ambiguous_legacy']);
  expect(JSON.stringify({ orders, ledger })).toBe(before);
});

describe('conciliación correcta', () => {
  it('un pedido entregado con su cargo y su rendición no genera incidencias', () => {
    const result = reconcileDeliveryCash({
      orders: [deliveredOrder('ped_1')],
      ledger: [charge('ped_1', 500000), remittance(200000), remittance(300000)],
    });
    expect(result.ok).toBe(true);
    expect(result.incidents).toEqual([]);
    expect(result.totals).toMatchObject({ chargedCents: 500000, remittedCents: 500000, pendingCents: 0, differenceCents: 0 });
    expect(result.balances).toEqual([{ courierId: 'courier_a', chargedCents: 500000, remittedCents: 500000, pendingCents: 0 }]);
  });

  it('usa el efectivo DECLARADO, no el esperado, como base de custodia', () => {
    const result = reconcileDeliveryCash({
      orders: [deliveredOrder('ped_1', { expected: 250000, declared: 200000 })],
      ledger: [charge('ped_1', 200000)],
    });
    expect(result.ok).toBe(true);
    expect(result.totals.chargedCents).toBe(200000);
  });

  it('un pedido sin efectivo no entra en la conciliación', () => {
    const result = reconcileDeliveryCash({
      orders: [{ id: 'ped_2', status: 'entregado', delivery: { lifecycle: 'DELIVERED' } }],
      ledger: [],
    });
    expect(result.ok).toBe(true);
    expect(result.totals.deliveredWithCash).toBe(0);
  });
});

describe('detecciones', () => {
  it('pedido entregado con efectivo y SIN cargo', () => {
    const result = reconcileDeliveryCash({ orders: [deliveredOrder('ped_1')], ledger: [] });
    expect(result.ok).toBe(false);
    expect(result.incidents.map((row) => row.type)).toEqual(['delivered_without_charge']);
    expect(result.totals.declaredWithoutChargeCents).toBe(500000);
  });

  it('cargo duplicado del mismo pedido', () => {
    const result = reconcileDeliveryCash({
      orders: [deliveredOrder('ped_1')],
      ledger: [charge('ped_1', 500000, { id: 'c1', key: 'charge:ped_1' }), charge('ped_1', 500000, { id: 'c2', key: 'charge:ped_1' })],
    });
    expect(result.incidents.map((row) => row.type)).toContain('duplicate_charge');
    expect(result.incidents.map((row) => row.type)).toContain('charge_mismatch');
  });

  it('cargo distinto del efectivo declarado', () => {
    const result = reconcileDeliveryCash({
      orders: [deliveredOrder('ped_1', { expected: 250000, declared: 200000 })],
      ledger: [charge('ped_1', 250000)],
    });
    expect(result.incidents.map((row) => row.type)).toEqual(['charge_mismatch']);
    expect(result.incidents[0].amountCents).toBe(50000);
  });

  it('cargo huérfano: pedido no entregado', () => {
    const result = reconcileDeliveryCash({
      orders: [{ id: 'ped_9', status: 'enviado', delivery: { lifecycle: 'EN_ROUTE' } }],
      ledger: [charge('ped_9', 100000)],
    });
    expect(result.incidents.map((row) => row.type)).toEqual(['orphan_charge']);
  });

  it('cargo sin pedido asociado', () => {
    const result = reconcileDeliveryCash({ orders: [], ledger: [charge(null, 100000)] });
    expect(result.incidents.map((row) => row.type)).toEqual(['charge_without_order']);
  });

  it('saldo negativo: se rindió más de lo cargado', () => {
    const result = reconcileDeliveryCash({
      orders: [deliveredOrder('ped_1', { expected: 100000, declared: 100000 })],
      ledger: [charge('ped_1', 100000), remittance(300000)],
    });
    expect(result.incidents.map((row) => row.type)).toEqual(['negative_balance']);
    expect(result.totals.pendingCents).toBe(-200000);
  });
});

describe('sin efectos secundarios', () => {
  it('no modifica los pedidos ni el libro que recibe', () => {
    const orders = [deliveredOrder('ped_1')];
    const ledger = [charge('ped_1', 500000), remittance(500000)];
    const ordersSnapshot = JSON.stringify(orders);
    const ledgerSnapshot = JSON.stringify(ledger);

    reconcileDeliveryCash({ orders, ledger });

    expect(JSON.stringify(orders)).toBe(ordersSnapshot);
    expect(JSON.stringify(ledger)).toBe(ledgerSnapshot);
  });

  it('los importes se tratan como centavos enteros', () => {
    const result = reconcileDeliveryCash({
      orders: [deliveredOrder('ped_1', { expected: 250000, declared: 250000 })],
      ledger: [charge('ped_1', 249999.6)],
    });
    expect(result.totals.chargedCents).toBe(250000);
  });
});
