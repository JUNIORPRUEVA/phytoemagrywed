import { expect, it } from 'vitest';
import { normalizeCustomerDeliveryPolicy, quoteCustomerDelivery } from '../server/delivery-customer-policy.mjs';

it('no inventa tarifa ni acepta distancia sin fuente vial', () => {
  const policy = { active: true, mode: 'per_km', max_meters: 10000,
    minimum_cents: 5000, base_cents: 3000, per_km_cents: 1000 };
  expect(quoteCustomerDelivery({ route: { ok: true, meters: 1500, provider: 'osrm' } }).error)
    .toBe('delivery_policy_unconfigured');
  expect(quoteCustomerDelivery({ policy, route: { ok: true, meters: 1500 } }).error)
    .toBe('road_route_required');
  expect(quoteCustomerDelivery({ policy, route: { ok: true, meters: 10001, provider: 'osrm' } }).error)
    .toBe('outside_coverage');
  expect(normalizeCustomerDeliveryPolicy({ mode: 'fixed', max_meters: 10000 })).toBeNull();
  expect(normalizeCustomerDeliveryPolicy({ active: true, mode: 'per_km', max_meters: 10000,
    base_cents: 0, per_km_cents: 0 })).toBeNull();
});

it('cotiza kilómetros, mínimo, tramos y ajuste de zona en centavos', () => {
  const road = { ok: true, meters: 2500, provider: 'osrm', durationSeconds: 700 };
  const perKm = { active: true, mode: 'per_km', max_meters: 10000,
    minimum_cents: 8000, base_cents: 3000, per_km_cents: 1000 };
  expect(quoteCustomerDelivery({ policy: perKm, route: road }).fee_cents).toBe(8000);
  const tiers = { active: true, mode: 'tiers', max_meters: 10000, minimum_cents: 0,
    tiers: [{ up_to_meters: 3000, fee_cents: 10000 }, { up_to_meters: 10000, fee_cents: 15000 }],
    zone_adjustments: [{ zone_id: 'higuey', delta_cents: -2000 }] };
  const quote = quoteCustomerDelivery({ policy: tiers, route: road, zoneId: 'higuey' });
  expect(quote.fee_cents).toBe(8000);
  expect(quote.route).toEqual({ meters: 2500, duration_seconds: 700, provider: 'osrm' });
});
