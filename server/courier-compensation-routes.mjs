import { randomUUID } from 'node:crypto';
import { normalizePolicy } from './courier-compensation.mjs';
import { activeLogisticsCompany, adminCompanyScope, scopeSeesCompany, validCompanyId } from './logistics-tenancy.mjs';

const validCents = (value) => Number.isSafeInteger(value) && value >= 0;

function checkedPolicy(body) {
  const input = body?.policy ?? body;
  if (!input || typeof input !== 'object') return null;
  const base = String(input.base_model ?? '').toUpperCase();
  if (base === 'DELIVERY_FEE' &&
      (!Number.isFinite(Number(input.fee_percent)) || Number(input.fee_percent) < 0 || Number(input.fee_percent) > 100)) return null;
  if (base === 'FIXED' && !validCents(input.fixed_fee_cents)) return null;
  if (base === 'DISTANCE' &&
      (!validCents(input.distance_base_cents) || !validCents(input.distance_per_km_cents) ||
       !validCents(input.distance_min_cents ?? 0) ||
       (input.active === true && input.distance_per_km_cents === 0))) return null;
  if (base === 'ZONE' && (!Array.isArray(input.zones) || !input.zones.length ||
      input.zones.some((zone) => !String(zone?.match ?? '').trim() || !validCents(zone.fee_cents)))) return null;
  if (!validCents(input.delivery_bonus_cents ?? 0)) return null;
  const normalized = normalizePolicy(input);
  if (!normalized) return null;
  return {
    active: input.active === true,
    base_model: normalized.base,
    fee_percent: normalized.feePercent,
    fixed_fee_cents: normalized.fixedFeeCents,
    distance_base_cents: normalized.distanceBaseCents,
    distance_per_km_cents: normalized.distancePerKmCents,
    distance_min_cents: normalized.distanceMinimumCents,
    zones: normalized.zones,
    delivery_bonus_cents: normalized.bonusCents,
    product_sale_percent: normalized.productSalePercent,
    incentives: { product_fixed: { enabled: normalized.productFixedEnabled },
      product_percent: { enabled: normalized.productPercentEnabled } },
    max_incentive_cents: normalized.maxIncentiveCents,
    require_pickup: normalized.requirePickup,
    shift_require_approval: normalized.shiftRequireApproval,
    shift_require_zero_custody: normalized.shiftRequireZeroCustody,
  };
}

/** Política de pago del repartidor, separada de la tarifa cobrada al cliente. */
export async function handleCourierCompensationRoutes({ req, res, route, ctx, actor, json, readJson, can }) {
  if (route !== '/api/admin/courier-compensation') return false;
  const send = (status, body) => { json(res, status, body); return true; };
  if (!can('admin.full')) return send(403, { ok: false, error: 'forbidden' });
  const scope = await adminCompanyScope(ctx.db, actor, can);
  if (req.method === 'GET') {
    const rows = await ctx.db.list('courier_compensation_policies', { limit: 500 });
    return send(200, { ok: true, policies: rows.filter((row) => scopeSeesCompany(scope, row.company_id)) });
  }
  if (req.method !== 'POST') return send(405, { ok: false, error: 'method_not_allowed' });
  const body = await readJson(req, 20000);
  const companyId = String(body.company_id ?? body.companyId ?? '').trim();
  if (!validCompanyId(companyId) || !(await activeLogisticsCompany(ctx.db, companyId)))
    return send(422, { ok: false, error: 'invalid_company' });
  if (!scopeSeesCompany(scope, companyId)) return send(403, { ok: false, error: 'company_forbidden' });
  const rows = await ctx.db.list('courier_compensation_policies', { limit: 500 });
  const existing = rows.find((row) => row.company_id === companyId);
  const input = body?.policy ?? body;
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'base_model'))
    return send(422, { ok: false, error: 'invalid_policy' });
  const policy = checkedPolicy({ policy: existing
    ? { ...existing, ...input, incentives: input?.incentives ?? existing.incentives,
      zones: input?.zones ?? existing.zones }
    : input });
  if (!policy) return send(422, { ok: false, error: 'invalid_policy', message: 'Completa la política sin importes implícitos.' });
  const now = (ctx.clock?.() ?? new Date()).toISOString();
  const doc = { ...policy, company_id: companyId, updated_at: now };
  const saved = existing
    ? await ctx.db.update('courier_compensation_policies', existing.id, doc)
    : await ctx.db.insert('courier_compensation_policies', {
        ...doc, id: `ccp_${randomUUID().replaceAll('-', '')}`, created_at: now,
      });
  await ctx.audit?.record({ action: 'courier.compensation_policy_saved', entity: 'courier_compensation_policies',
    entityId: existing?.id ?? saved?.doc?.id ?? saved?.id, actor,
    summary: `Política de compensación guardada (${companyId})`, data: { company_id: companyId } });
  return send(200, { ok: true, policy: saved?.doc ?? saved });
}
