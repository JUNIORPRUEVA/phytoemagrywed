import { describe, expect, it } from 'vitest';

import {
  baseCompensationCents,
  computeCourierCompensation,
  normalizePolicy,
  productIncentives,
} from '../server/courier-compensation.mjs';

const order = (overrides = {}) => ({
  status: 'assigned',
  delivery_fee: 150,
  delivery: { fee: 150, city: 'Higüey' },
  items: [],
  ...overrides,
});

describe('normalizePolicy', () => {
  it('rechaza políticas inexistentes o con modelo desconocido', () => {
    expect(normalizePolicy(null)).toBeNull();
    expect(normalizePolicy({ base_model: 'INVENTADO' })).toBeNull();
  });

  it('acepta los tres modelos soportados', () => {
    for (const base of ['DELIVERY_FEE', 'FIXED', 'ZONE']) {
      expect(normalizePolicy({ base_model: base })).not.toBeNull();
    }
  });
});

describe('sin política no se inventan importes', () => {
  it('devuelve null para que la app muestre «pendiente»', () => {
    expect(computeCourierCompensation({ order: order(), policy: null })).toBeNull();
    expect(
      computeCourierCompensation({
        order: order(),
        policy: { base_model: 'DELIVERY_FEE', active: false },
      }),
    ).toBeNull();
  });
});

describe('base por modelo', () => {
  it('DELIVERY_FEE paga la tarifa de envío completa', () => {
    const policy = normalizePolicy({ base_model: 'DELIVERY_FEE' });
    expect(baseCompensationCents(order({ delivery_fee: 150 }), policy)).toBe(15000);
  });

  it('FIXED paga el importe fijo de la empresa, no la tarifa del cliente', () => {
    const policy = normalizePolicy({ base_model: 'FIXED', fixed_fee_cents: 20000 });
    expect(baseCompensationCents(order({ delivery_fee: 500 }), policy)).toBe(20000);
  });

  it('ZONE paga según la zona configurada', () => {
    const policy = normalizePolicy({
      base_model: 'ZONE',
      zones: [{ match: 'HIGUEY', fee_cents: 12000 }],
    });
    expect(baseCompensationCents(order({ delivery: { city: 'Higüey' } }), policy)).toBe(12000);
  });

  it('ZONE sin coincidencia paga 0, no un valor adivinado', () => {
    const policy = normalizePolicy({
      base_model: 'ZONE',
      zones: [{ match: 'SANTO DOMINGO', fee_cents: 25000 }],
    });
    expect(baseCompensationCents(order({ delivery: { city: 'Higüey' } }), policy)).toBe(0);
  });

  it('DISTANCE usa solo una ruta vial identificada y conserva metros e importe', () => {
    const policy = { base_model: 'DISTANCE', distance_base_cents: 5000,
      distance_per_km_cents: 1200, distance_min_cents: 6000 };
    expect(computeCourierCompensation({ order: order(), policy })).toBeNull();
    const routed = order({ delivery: { route: { meters: 2500, provider: 'osrm' } } });
    const result = computeCourierCompensation({ order: routed, policy });
    expect(result.base_cents).toBe(8000);
    expect(result.breakdown.policy_snapshot.route).toEqual({ meters: 2500, provider: 'osrm' });
  });
});

describe('incentivos por producto', () => {
  const policy = normalizePolicy({
    base_model: 'DELIVERY_FEE',
    incentives: { product_fixed: { enabled: true }, product_percent: { enabled: true } },
  });

  it('FIXED por unidad multiplica por cantidad', () => {
    const result = productIncentives(
      order({
        items: [{ label: 'Cápsulas', quantity: 3, unitPrice: 500, courier_incentive: { type: 'FIXED', value: 10 } }],
      }),
      policy,
    );
    expect(result.cents).toBe(3000);
  });

  it('FIXED por pedido no multiplica', () => {
    const result = productIncentives(
      order({
        items: [
          { label: 'Cápsulas', quantity: 3, unitPrice: 500, courier_incentive: { type: 'FIXED', value: 10, per_unit: false } },
        ],
      }),
      policy,
    );
    expect(result.cents).toBe(1000);
  });

  it('PERCENTAGE se calcula sobre la línea, no sobre el total del pedido', () => {
    const result = productIncentives(
      order({
        delivery_fee: 999,
        items: [{ label: 'Cápsulas', quantity: 2, unitPrice: 1000, courier_incentive: { type: 'PERCENTAGE', value: 5 } }],
      }),
      policy,
    );
    /* 2 × 1000 = 2000 × 5 % = 100 → 10000 centavos. El envío no entra. */
    expect(result.cents).toBe(10000);
  });

  it('respeta el descuento de la línea', () => {
    const result = productIncentives(
      order({
        items: [
          {
            label: 'Cápsulas',
            quantity: 2,
            unitPrice: 1000,
            discount: 500,
            courier_incentive: { type: 'PERCENTAGE', value: 10 },
          },
        ],
      }),
      policy,
    );
    /* (2000 − 500) × 10 % = 150 → 15000 */
    expect(result.cents).toBe(15000);
  });

  it('ignora líneas canceladas o devueltas', () => {
    const result = productIncentives(
      order({
        items: [
          { label: 'A', quantity: 1, unitPrice: 1000, cancelled: true, courier_incentive: { type: 'PERCENTAGE', value: 10 } },
          { label: 'B', quantity: 1, unitPrice: 1000, refunded: true, courier_incentive: { type: 'PERCENTAGE', value: 10 } },
        ],
      }),
      policy,
    );
    expect(result.cents).toBe(0);
  });

  it('respeta el tope por producto', () => {
    const result = productIncentives(
      order({
        items: [
          { label: 'A', quantity: 50, unitPrice: 100, courier_incentive: { type: 'FIXED', value: 10, max_amount: 100 } },
        ],
      }),
      policy,
    );
    expect(result.cents).toBe(10000);
  });

  it('no paga incentivo si el tipo está desactivado en la política', () => {
    const onlyFixed = normalizePolicy({
      base_model: 'DELIVERY_FEE',
      incentives: { product_fixed: { enabled: false }, product_percent: { enabled: true } },
    });
    const result = productIncentives(
      order({ items: [{ label: 'A', quantity: 1, unitPrice: 100, courier_incentive: { type: 'FIXED', value: 10 } }] }),
      onlyFixed,
    );
    expect(result.cents).toBe(0);
  });
});

describe('cálculo completo', () => {
  it('la comisión opcional usa productos netos y excluye envío, descuentos e impuesto', () => {
    const result = computeCourierCompensation({
      policy: { base_model: 'FIXED', fixed_fee_cents: 0, product_sale_percent: 3 },
      order: order({ delivery_fee: 999, discount: 150,
        items: [{ quantity: 2, unitPrice: 1000, lineDiscountCents: 25000, tax_cents: 10000 }] }),
    });
    expect(result.breakdown.product_sale_base_cents).toBe(150000);
    expect(result.breakdown.product_sale_commission_cents).toBe(4500);
    expect(result.total_cents).toBe(4500);
  });
  it('suma base + incentivos + bono y marca la estimación', () => {
    const policy = normalizePolicy({
      base_model: 'FIXED',
      fixed_fee_cents: 15000,
      delivery_bonus_cents: 2500,
      incentives: { product_fixed: { enabled: true } },
    });
    const result = computeCourierCompensation({
      order: order({
        items: [{ label: 'Cápsulas', quantity: 2, courier_incentive: { type: 'FIXED', value: 25 } }],
      }),
      policy,
    });
    expect(result.base_cents).toBe(15000);
    expect(result.incentive_cents).toBe(5000);
    expect(result.bonus_cents).toBe(2500);
    expect(result.total_cents).toBe(22500);
    expect(result.estimated).toBe(true);
  });

  it('marca la compensación como confirmada cuando la entrega está validada', () => {
    const policy = normalizePolicy({ base_model: 'DELIVERY_FEE' });
    const result = computeCourierCompensation({
      order: order({ status: 'delivered' }),
      policy,
      confirmed: true,
    });
    expect(result.estimated).toBe(false);
  });

  it('aplica el tope global de incentivos sin tocar la base', () => {
    const policy = normalizePolicy({
      base_model: 'DELIVERY_FEE',
      max_incentive_cents: 3000,
      incentives: { product_fixed: { enabled: true } },
    });
    const result = computeCourierCompensation({
      order: order({
        items: [{ label: 'A', quantity: 10, courier_incentive: { type: 'FIXED', value: 10 } }],
      }),
      policy,
    });
    expect(result.base_cents).toBe(15000);
    expect(result.incentive_cents).toBe(3000);
    expect(result.breakdown.incentive_capped).toBe(true);
  });

  it('es determinista: mismas entradas, mismo resultado', () => {
    const policy = normalizePolicy({
      base_model: 'DELIVERY_FEE',
      incentives: { product_percent: { enabled: true } },
    });
    const input = {
      order: order({ items: [{ label: 'A', quantity: 2, unitPrice: 750, courier_incentive: { type: 'PERCENTAGE', value: 4 } }] }),
      policy,
    };
    expect(computeCourierCompensation(input)).toEqual(computeCourierCompensation(input));
  });
});
