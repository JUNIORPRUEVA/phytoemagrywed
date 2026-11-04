/** Tarifa cobrada al cliente. Nunca se reutiliza como remuneración del repartidor. */
const cents = (value) => Number.isSafeInteger(value) && value >= 0;
const meters = (value) => Number.isSafeInteger(value) && value > 0;

export function normalizeCustomerDeliveryPolicy(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = String(raw.mode ?? '').toLowerCase();
  if (!['fixed', 'per_km', 'tiers'].includes(mode) || !meters(raw.max_meters)) return null;
  if (!cents(raw.minimum_cents ?? 0)) return null;
  if (mode === 'fixed' && !cents(raw.fixed_cents)) return null;
  if (mode === 'per_km' && (!cents(raw.base_cents) || !cents(raw.per_km_cents))) return null;
  if (mode === 'per_km' && raw.active === true && raw.per_km_cents === 0) return null;
  let tiers = [];
  if (mode === 'tiers') {
    if (!Array.isArray(raw.tiers) || !raw.tiers.length) return null;
    tiers = raw.tiers.map((row) => ({ up_to_meters: row.up_to_meters, fee_cents: row.fee_cents }));
    if (tiers.some((row, index) => !meters(row.up_to_meters) || !cents(row.fee_cents) ||
        (index > 0 && row.up_to_meters <= tiers[index - 1].up_to_meters)) ||
        tiers.at(-1).up_to_meters < raw.max_meters) return null;
  }
  const adjustments = Array.isArray(raw.zone_adjustments) ? raw.zone_adjustments : [];
  if (adjustments.some((row) => !String(row?.zone_id ?? '').trim() ||
      !Number.isSafeInteger(row.delta_cents))) return null;
  return { active: raw.active === true, mode, max_meters: raw.max_meters,
    minimum_cents: raw.minimum_cents ?? 0,
    fixed_cents: mode === 'fixed' ? raw.fixed_cents : null,
    base_cents: mode === 'per_km' ? raw.base_cents : null,
    per_km_cents: mode === 'per_km' ? raw.per_km_cents : null,
    tiers, zone_adjustments: adjustments.map((row) => ({ zone_id: String(row.zone_id).trim(),
      delta_cents: row.delta_cents })) };
}

export function quoteCustomerDelivery({ policy, route, zoneId = null } = {}) {
  const rule = normalizeCustomerDeliveryPolicy(policy);
  if (!rule?.active) return { ok: false, error: 'delivery_policy_unconfigured' };
  if (!route?.ok || !meters(route.meters) || !String(route.provider ?? '').trim())
    return { ok: false, error: 'road_route_required' };
  if (route.meters > rule.max_meters) return { ok: false, error: 'outside_coverage' };
  let fee = rule.mode === 'fixed' ? rule.fixed_cents
    : rule.mode === 'per_km' ? rule.base_cents + Math.ceil(route.meters * rule.per_km_cents / 1000)
      : rule.tiers.find((row) => route.meters <= row.up_to_meters)?.fee_cents;
  const adjustment = rule.zone_adjustments.find((row) => row.zone_id === zoneId);
  fee = Math.max(rule.minimum_cents, fee + (adjustment?.delta_cents ?? 0));
  if (!Number.isSafeInteger(fee)) return { ok: false, error: 'invalid_delivery_amount' };
  return { ok: true, fee_cents: fee, route: { meters: route.meters,
    duration_seconds: route.durationSeconds ?? null, provider: String(route.provider) },
    policy_snapshot: rule, zone_id: zoneId };
}
