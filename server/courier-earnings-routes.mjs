import { adminCompanyScope, courierCompanies, scopeSeesCompany, validCompanyId } from './logistics-tenancy.mjs';
import { EARNINGS_COLLECTION, PAYOUTS_COLLECTION, earningsSummary, ledgerRows,
  recordPayoutAtomic, settlePayoutAtomic } from './courier-earnings.mjs';

/** Libro de ganancias y liquidaciones, independiente de la custodia del cliente. */
export async function handleCourierEarningsRoutes({ req, res, route, ctx, actor, json, readJson, can }) {
  const payoutMatch = /^\/api\/admin\/courier-payouts\/([a-zA-Z0-9_-]+)\/(settle|fail)$/.exec(route);
  if (!['/api/admin/courier-earnings', '/api/admin/courier-payouts'].includes(route) && !payoutMatch) return false;
  const send = (status, body) => { json(res, status, body); return true; };
  if (!can('admin.full')) return send(403, { ok: false, error: 'forbidden' });
  const scope = await adminCompanyScope(ctx.db, actor, can);
  const companyId = req.method === 'GET'
    ? new URL(req.url, 'http://local').searchParams.get('companyId') : null;
  if (req.method === 'GET') {
    if (!validCompanyId(companyId) || !scopeSeesCompany(scope, companyId))
      return send(403, { ok: false, error: 'company_forbidden' });
    const earnings = await ctx.db.list(EARNINGS_COLLECTION, { limit: 20000 });
    const payouts = await ctx.db.list(PAYOUTS_COLLECTION, { limit: 20000 });
    if (route === '/api/admin/courier-earnings') {
      const rows = ledgerRows(earnings, payouts, { companyId });
      return send(200, { ok: true, company_id: companyId, rows, summary: earningsSummary(rows) });
    }
    return send(200, { ok: true, company_id: companyId,
      payouts: payouts.filter((row) => row.company_id === companyId) });
  }
  if (req.method !== 'POST' || route === '/api/admin/courier-earnings')
    return send(405, { ok: false, error: 'method_not_allowed' });
  const body = await readJson(req, 20000);
  const selectedCompany = String(body.company_id ?? body.companyId ?? '').trim();
  if (!validCompanyId(selectedCompany) || !scopeSeesCompany(scope, selectedCompany))
    return send(403, { ok: false, error: 'company_forbidden' });
  const now = (ctx.clock?.() ?? new Date()).toISOString();
  if (payoutMatch) {
    const result = await settlePayoutAtomic({ db: ctx.db, handle: ctx.store.handle,
      payoutId: payoutMatch[1], companyId: selectedCompany, action: payoutMatch[2],
      reference: body.reference, note: body.note, idempotencyKey: body.idempotencyKey,
      actor: actor?.id, now });
    return send(result.status ?? (result.ok ? 200 : 422), result);
  }
  const courierId = String(body.courier_account_id ?? body.courierId ?? '').trim();
  const account = courierId ? await ctx.db.get('courier_accounts', courierId) : null;
  if (!account || !(await courierCompanies(ctx.db, account)).includes(selectedCompany))
    return send(422, { ok: false, error: 'courier_company_mismatch' });
  const key = String(body.idempotencyKey ?? body.idempotency_key ?? '').trim();
  if (key.length < 8 || key.length > 120) return send(422, { ok: false, error: 'idempotency_key_required' });
  const result = await recordPayoutAtomic({ db: ctx.db, handle: ctx.store.handle,
    courierId, companyId: selectedCompany, method: body.method,
    reference: body.reference, note: body.note, allocations: body.allocations,
    idempotencyKey: key, state: 'initiated', actor: actor?.id, now });
  return send(result.status ?? (result.ok ? 201 : 422), result);
}
