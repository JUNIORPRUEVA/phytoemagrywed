import { computeCourierCompensation } from './courier-compensation.mjs';
import { companyOfOrder } from './logistics-tenancy.mjs';
import { pickupStoreIds } from './suppliers.mjs';

/** Fija la regla económica al asignar; cambios posteriores no reprician el pedido. */
export async function compensationAtAssignment(db, order, now = new Date()) {
  const existing = order?.delivery?.courier_compensation_snapshot;
  if (existing) return { ok: true, snapshot: existing };
  const companyId = companyOfOrder(order);
  if (!companyId) return { ok: false, status: 409, error: 'order_company_required' };
  const rows = await db.list('courier_compensation_policies', { limit: 500 });
  const policy = rows.find((row) => row.company_id === companyId && row.active === true);
  // Se conserva la operación histórica sin tarifa. Los pedidos con tienda nueva
  // requieren una regla explícita antes de comprometer un pago al repartidor.
  if (!policy && pickupStoreIds(order?.items).length === 0) return { ok: true, snapshot: null };
  if (!policy) return { ok: false, status: 409, error: 'compensation_policy_required' };
  const calculated = computeCourierCompensation({ order, policy, confirmed: false });
  if (!calculated) return { ok: false, status: 409, error: 'compensation_route_or_policy_invalid' };
  return { ok: true, snapshot: {
    company_id: companyId,
    policy_id: policy.id,
    policy_updated_at: policy.updated_at ?? null,
    calculated_at: now.toISOString(),
    base_cents: calculated.base_cents,
    incentive_cents: calculated.incentive_cents,
    bonus_cents: calculated.bonus_cents,
    total_cents: calculated.total_cents,
    breakdown: calculated.breakdown,
  } };
}
