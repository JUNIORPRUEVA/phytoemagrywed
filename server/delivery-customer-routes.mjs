import { randomUUID } from 'node:crypto';
import { normalizeCustomerDeliveryPolicy, quoteCustomerDelivery } from './delivery-customer-policy.mjs';
import { activeLogisticsCompany, adminCompanyScope, scopeSeesCompany, validCompanyId } from './logistics-tenancy.mjs';

const validPoint = (latitude, longitude) => typeof latitude === 'number' && Number.isFinite(latitude) &&
  latitude >= -90 && latitude <= 90 && typeof longitude === 'number' && Number.isFinite(longitude) &&
  longitude >= -180 && longitude <= 180;

export async function handleDeliveryCustomerRoutes({ req, res, route, ctx, actor, json, readJson, can }) {
  if (!['/api/admin/delivery-rules/customer', '/api/admin/delivery-rules/quote'].includes(route)) return false;
  const send = (status, body) => { json(res, status, body); return true; };
  if (!can('orders.read')) return send(403, { ok: false, error: 'forbidden' });
  const scope = await adminCompanyScope(ctx.db, actor, can);
  if (route === '/api/admin/delivery-rules/customer' && req.method === 'GET') {
    const companyId = new URL(req.url, 'http://local').searchParams.get('companyId');
    if (!validCompanyId(companyId) || !scopeSeesCompany(scope, companyId))
      return send(403, { ok: false, error: 'company_forbidden' });
    const policies = await ctx.db.list('delivery_customer_policies', { limit: 500 });
    return send(200, { ok: true, policy: policies.find((row) => row.company_id === companyId) ?? null });
  }
  if (req.method !== 'POST') return send(405, { ok: false, error: 'method_not_allowed' });
  const body = await readJson(req, 20000);
  const companyId = String(body.company_id ?? body.companyId ?? '').trim();
  if (!validCompanyId(companyId) || !(await activeLogisticsCompany(ctx.db, companyId)))
    return send(422, { ok: false, error: 'invalid_company' });
  if (!scopeSeesCompany(scope, companyId)) return send(403, { ok: false, error: 'company_forbidden' });
  const now = ctx.clock?.() ?? new Date();
  if (route === '/api/admin/delivery-rules/customer') {
    if (!can('admin.full')) return send(403, { ok: false, error: 'forbidden' });
    const normalized = normalizeCustomerDeliveryPolicy(body.policy);
    if (!normalized) return send(422, { ok: false, error: 'invalid_delivery_policy' });
    const rows = await ctx.db.list('delivery_customer_policies', { limit: 500 });
    const existing = rows.find((row) => row.company_id === companyId);
    const doc = { ...normalized, company_id: companyId, updated_at: now.toISOString() };
    const saved = existing
      ? await ctx.db.update('delivery_customer_policies', existing.id, doc)
      : await ctx.db.insert('delivery_customer_policies', {
          ...doc, id: `dcp_${randomUUID().replaceAll('-', '')}`, created_at: now.toISOString(),
        });
    return send(200, { ok: true, policy: saved?.doc ?? saved });
  }
  if (body.destinationConfirmed !== true) return send(422, { ok: false, error: 'destination_confirmation_required' });
  const supplierId = String(body.supplier_id ?? body.supplierId ?? '').trim();
  const supplier = supplierId ? await ctx.db.get('suppliers', supplierId) : null;
  if (!supplier || supplier.company_id !== companyId || supplier.active === false)
    return send(422, { ok: false, error: 'invalid_pickup_store' });
  if (!validPoint(supplier.lat, supplier.lng)) return send(422, { ok: false, error: 'pickup_location_required' });
  const destination = body.destination;
  if (!validPoint(destination?.latitude, destination?.longitude))
    return send(422, { ok: false, error: 'destination_location_required' });
  const policies = await ctx.db.list('delivery_customer_policies', { limit: 500 });
  const policy = policies.find((row) => row.company_id === companyId && row.active === true);
  if (!policy) return send(409, { ok: false, error: 'delivery_policy_unconfigured' });
  if (policy.zone_adjustments?.length) return send(409, { ok: false, error: 'zone_resolution_required' });
  const router = ctx.deliveryRoadRouter;
  if (!router?.configured) return send(503, { ok: false, error: 'routing_unconfigured' });
  const routeResult = await router.route({ latitude: supplier.lat, longitude: supplier.lng }, destination);
  const calculated = quoteCustomerDelivery({ policy, route: routeResult });
  if (!calculated.ok) return send(409, calculated);
  const quote = {
    id: `dq_${randomUUID().replaceAll('-', '')}`, company_id: companyId,
    supplier_id: supplierId, destination: { latitude: destination.latitude, longitude: destination.longitude },
    pickup: { supplier_id: supplierId, name: supplier.name, address: supplier.address,
      reference: supplier.references ?? '', latitude: supplier.lat, longitude: supplier.lng },
    fee_cents: calculated.fee_cents, route: calculated.route,
    policy_id: policy.id, policy_updated_at: policy.updated_at,
    policy_snapshot: calculated.policy_snapshot, created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 5 * 60000).toISOString(),
  };
  await ctx.db.insert('delivery_quotes', quote);
  const { policy_snapshot, ...publicQuote } = quote;
  return send(201, { ok: true, quote: publicQuote });
}
