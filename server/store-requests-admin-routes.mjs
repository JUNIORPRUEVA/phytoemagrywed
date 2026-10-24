export async function handleStoreRequestsAdminRoute({ req, res, route, ctx, actor, json, readJson, can }) {
  if (!route.startsWith('/api/admin/store/requests')) return false;
  const accounts = ctx.storeAccounts;
  if (!accounts) {
    json(res, 503, { ok: false, error: 'accounts_unavailable', message: 'Las solicitudes necesitan almacenamiento SQL.' });
    return true;
  }
  const send = (status, body, headers = {}) => {
    json(res, status, body, headers);
    return true;
  };
  if (!can('orders.read')) return send(403, { ok: false, error: 'forbidden' });
  if (req.method !== 'GET') return send(410,{ok:false,error:'sourcing_retired',message:'Archivo histórico de solo lectura. El servicio de solicitudes fue retirado.'});
  try {
    if (route === '/api/admin/store/requests' && req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const status = String(url.searchParams.get('status') ?? '');
      const q = String(url.searchParams.get('q') ?? '');
      const requests = await accounts.adminListRequests({ status, q });
      const customers = new Map();
      for (const request of requests) {
        if (!request.customer_id || customers.has(request.customer_id)) continue;
        customers.set(request.customer_id, await ctx.customers.get(request.customer_id));
      }
      return send(200, {
        ok: true,
        requests: requests.map((request) => ({ ...request, customer: customers.get(request.customer_id) ?? null })),
        canManage: false,
      });
    }

    const imageMatch = /^\/api\/admin\/store\/requests\/([a-zA-Z0-9_-]+)\/image\/(\d+)$/.exec(route);
    if (imageMatch && req.method === 'GET') {
      const image = await accounts.requestImage(imageMatch[1], imageMatch[2], null);
      if (!image) {
        res.writeHead(404, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end();
        return true;
      }
      res.writeHead(200, {
        'content-type': image.mime,
        'cache-control': 'private, max-age=0, must-revalidate',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      });
      res.end(Buffer.from(image.data, 'base64'));
      return true;
    }

    const match = /^\/api\/admin\/store\/requests\/([a-zA-Z0-9_-]+)$/.exec(route);
    if (match && req.method === 'GET') {
      const request = await accounts.getRequest(match[1]);
      if (!request) return send(404, { ok: false, error: 'not_found' });
      const customer = request.customer_id ? await ctx.customers.get(request.customer_id) : null;
      return send(200, { ok: true, request: { ...request, admin_notes: request.admin_notes ?? '' }, customer, canManage: false });
    }

    if (match && req.method === 'PATCH') {
      if (actor?.role !== 'ADMIN') return send(403, { ok: false, error: 'forbidden' });
      const body = await readJson(req, 60000);
      const request = await accounts.adminUpdateRequest(match[1], body);
      await ctx.audit?.record({
        entity: 'store_request',
        entityId: request.id,
        action: 'store.request_updated',
        actor: actor?.display_name ?? null,
        summary: `Solicitud ${request.id} · ${request.status}`,
        data: { status: request.status, quote: request.quote ?? null },
      });
      return send(200, { ok: true, request });
    }

    return send(404, { ok: false, error: 'not_found' });
  } catch (error) {
    if (error?.status) return send(error.status, { ok: false, error: error.code ?? 'invalid', message: error.message });
    console.error('[store-requests] operation failed', { code: error?.code, name: error?.name });
    return send(500, { ok: false, error: 'request_error', message: 'No se pudo completar la operación.' });
  }
}
