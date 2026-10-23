import { STORE_REQUEST_STATUSES } from './store-accounts.mjs';
import { maskPhone, phoneRequirement } from './store-verifications.mjs';
import { publicProduct } from './store-public-routes.mjs';

const COOKIE = 'ft_store_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;

const fail = (code, message, status = 422) => Object.assign(new Error(message), { code, status });

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function secureRequest(req) {
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

function storeCookie(req, value, maxAge = SESSION_SECONDS) {
  return [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${value ? maxAge : 0}`,
    ...(secureRequest(req) ? ['Secure'] : []),
  ].join('; ');
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const hosts = [req.headers.host, req.headers['x-forwarded-host']]
      .filter(Boolean)
      .flatMap((value) => String(value).split(','))
      .map((value) => value.trim());
    return hosts.includes(originHost);
  } catch {
    return false;
  }
}

function readForm(req, maxBytes = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('body_too_large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
  });
}

function oauthStateCookie(req, value) {
  return [
    `ft_oauth_state=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${value ? 600 : 0}`,
    ...(secureRequest(req) ? ['Secure'] : []),
  ].join('; ');
}

/** Límite simple por IP: frena la fuerza bruta sin bloquear al cliente real. */
const attempts = new Map();
function throttle(req, key) {
  const id = `${key}:${req.socket?.remoteAddress ?? 'local'}`;
  const now = Date.now();
  const entry = attempts.get(id);
  if (entry && entry.until > now && entry.count >= 20) return false;
  attempts.set(id, { count: entry && entry.until > now ? entry.count + 1 : 1, until: now + 15 * 60 * 1000 });
  return true;
}

const publicOrderError = (error) => {
  if (error?.status) return { status: error.status, body: { ok: false, error: error.code ?? 'invalid', message: error.message } };
  console.error('[store-account] operation failed', { code: error?.code, name: error?.name });
  return { status: 500, body: { ok: false, error: 'account_error', message: 'No pudimos completar la operación. Inténtalo de nuevo.' } };
};

export async function handleStoreAccountRoute({ req, res, route, url, ctx, json, readJson }) {
  const accounts = ctx.storeAccounts;
  const accountRoute = route === '/api/store/account' || route.startsWith('/api/store/account/');
  const requestRoute = route === '/api/store/requests' || route.startsWith('/api/store/requests/');
  const orderRoute = route === '/api/store/orders';
  if (!accountRoute && !requestRoute && !orderRoute) return false;
  if (!accounts) {
    json(res, 503, { ok: false, error: 'accounts_unavailable', message: 'La cuenta estará disponible en breve.' });
    return true;
  }

  const token = readCookie(req, COOKIE);
  const current = token ? await accounts.session(token) : null;
  const send = (status, body, headers = {}) => {
    json(res, status, body, headers);
    return true;
  };
  const requireAccount = () => {
    if (!current) {
      json(res, 401, { ok: false, error: 'unauthorized', message: 'Inicia sesión para continuar.' });
      return null;
    }
    return current;
  };
  const stateChanging = req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE';
  const oauthCallback = /^\/api\/store\/account\/auth\/(google|apple)\/callback$/.test(route);
  if (stateChanging && !oauthCallback && !sameOrigin(req)) return send(403, { ok: false, error: 'cross_origin', message: 'No pudimos verificar la solicitud.' });

  /*
   * TELÉFONO OBLIGATORIO, VERIFICACIÓN NO.
   *
   * Para enviar un pedido o una solicitud el cliente necesita un número
   * GUARDADO en su cuenta. La confirmación por SMS está APLAZADA en la Fase 1:
   * no se pide código ni se marca nada como verificado.
   */
  const phoneGate = (session) => {
    const requirement = phoneRequirement(session.account);
    if (!requirement.ok) {
      return {
        ok: false,
        error: 'phone_required',
        message: requirement.message,
        phone_url: '/store/verify/',
      };
    }
    /*
     * El pedido se registra contra el cliente del CRM. Si el número guardado ya
     * tenía historial, la cuenta necesita la prueba de un pedido para enlazarse:
     * sin eso no se puede vender ni se enseña nada del historial ajeno.
     */
    if (!session.account.customer_id) {
      return {
        ok: false,
        error: 'phone_required',
        message: 'Ese teléfono ya tiene historial con nosotros. Escribe el número de un pedido anterior para enlazar tu cuenta.',
        phone_url: '/store/verify/',
      };
    }
    return null;
  };

  try {
    if (route === '/api/store/account/favorites' && req.method === 'GET') {
      const session = requireAccount();
      if (!session) return true;
      const ids = await accounts.favoriteIds(session.account.id);
      if (url.searchParams.get('ids') === '1') return send(200, { ok: true, ids }, { 'cache-control': 'no-store' });
      if (!ctx.storeCatalog) return send(503, { ok: false, message: 'El catálogo no está disponible. Intenta de nuevo.' });
      const products = (await ctx.storeCatalog.publicProducts()).filter(p => ids.includes(p.id)).map(publicProduct);
      products.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      return send(200, { ok: true, ids, products }, { 'cache-control': 'no-store' });
    }
    const favoriteMatch = /^\/api\/store\/account\/favorites\/([a-zA-Z0-9_-]{1,180})$/.exec(route);
    if (favoriteMatch && ['POST', 'DELETE'].includes(req.method)) {
      const session = requireAccount();
      if (!session) return true;
      if (req.method === 'POST') {
        if (!ctx.storeCatalog) return send(503, { ok: false, message: 'El catálogo no está disponible. Intenta de nuevo.' });
        if (!(await ctx.storeCatalog.publicProducts()).some(p => p.id === favoriteMatch[1])) return send(404, { ok: false, message: 'Este producto ya no está publicado.' });
      }
      const ids = await accounts.setFavorite(session.account.id, favoriteMatch[1], req.method === 'POST');
      return send(200, { ok: true, ids }, { 'cache-control': 'no-store' });
    }
    if (route === '/api/store/account/providers' && req.method === 'GET') {
      return send(200, {
        ok: true,
        providers: {
          password: true,
          google: Boolean(ctx.storeOAuth?.configured?.google),
          apple: Boolean(ctx.storeOAuth?.configured?.apple),
        },
      });
    }

    if (route === '/api/store/account/register' && req.method === 'POST') {
      if (!throttle(req, 'register')) return send(429, { ok: false, error: 'too_many_attempts', message: 'Demasiados intentos. Espera unos minutos.' });
      const body = await readJson(req, 40000);
      const result = await accounts.register(body);
      const session = await accounts.createSession(result.account.id);
      if (!session) throw fail('session_error', 'No pudimos iniciar tu sesión.', 500);
      return send(201, { ok: true, account: result.account }, { 'set-cookie': storeCookie(req, session.token) });
    }

    if (route === '/api/store/account/login' && req.method === 'POST') {
      if (!throttle(req, 'login')) return send(429, { ok: false, error: 'too_many_attempts', message: 'Demasiados intentos. Espera unos minutos.' });
      const body = await readJson(req, 20000);
      const result = await accounts.login(body);
      const session = await accounts.createSession(result.account.id);
      if (!session) throw fail('session_error', 'No pudimos iniciar tu sesión.', 500);
      return send(200, { ok: true, account: result.account }, { 'set-cookie': storeCookie(req, session.token) });
    }

    if (route === '/api/store/account/logout' && req.method === 'POST') {
      if (current) await accounts.revokeSession(current.tokenHash);
      return send(200, { ok: true }, { 'set-cookie': storeCookie(req, '') });
    }

    const startMatch = /^\/api\/store\/account\/auth\/(google|apple)\/start$/.exec(route);
    if (startMatch && req.method === 'GET') {
      const provider = startMatch[1];
      if (!ctx.storeOAuth?.configured?.[provider]) {
        return send(503, { ok: false, error: 'provider_not_configured', provider, message: 'Ese acceso todavía no está habilitado.' });
      }
      const state = ctx.storeOAuth.state();
      const redirect = ctx.storeOAuth.redirectUri(provider, req);
      res.writeHead(302, {
        location: ctx.storeOAuth.authorizeUrl(provider, { state, redirect }),
        'set-cookie': oauthStateCookie(req, `${provider}.${state}`),
        'cache-control': 'no-store',
      });
      res.end();
      return true;
    }

    const callbackMatch = /^\/api\/store\/account\/auth\/(google|apple)\/callback$/.exec(route);
    if (callbackMatch && (req.method === 'GET' || req.method === 'POST')) {
      const provider = callbackMatch[1];
      try {
        const params = req.method === 'POST' ? await readForm(req) : url.searchParams;
        const state = params.get('state') ?? '';
        const stored = readCookie(req, 'ft_oauth_state') ?? '';
        if (!state || stored !== `${provider}.${state}`) throw fail('invalid_state', 'No pudimos verificar el acceso. Inténtalo de nuevo.', 400);
        const identity = await ctx.storeOAuth.exchange(provider, {
          code: params.get('code'),
          redirect: ctx.storeOAuth.redirectUri(provider, req),
          user: params.get('user'),
        });
        const result = await accounts.oauthLogin(identity);
        if (result.pending) {
          res.writeHead(302, {
            location: `/store/#/account/complete?token=${encodeURIComponent(result.pendingToken)}`,
            'set-cookie': oauthStateCookie(req, ''),
            'cache-control': 'no-store',
          });
          res.end();
          return true;
        }
        const session = await accounts.createSession(result.account.id);
        res.writeHead(302, {
          location: '/store/#/account',
          'set-cookie': [oauthStateCookie(req, ''), storeCookie(req, session.token)],
          'cache-control': 'no-store',
        });
        res.end();
        return true;
      } catch (error) {
        console.error('[store-oauth] callback failed', { provider, code: error?.code });
        res.writeHead(302, { location: '/store/#/account?error=oauth', 'set-cookie': oauthStateCookie(req, ''), 'cache-control': 'no-store' });
        res.end();
        return true;
      }
    }

    if (route === '/api/store/account/complete' && req.method === 'POST') {
      const body = await readJson(req, 40000);
      const result = await accounts.completePendingLink(body.token, body);
      const session = await accounts.createSession(result.account.id);
      return send(200, { ok: true, account: result.account }, { 'set-cookie': storeCookie(req, session.token) });
    }

    if (route === '/api/store/account/me' && req.method === 'GET') {
      if (!current) return send(200, { ok: true, account: null, customer: null, orders_count: 0, requests_count: 0 });
      const session = requireAccount();
      if (!session) return true;
      const [orders, requests] = await Promise.all([accounts.ordersForCustomer(session.account.customer_id), accounts.listRequestsForCustomer(session.account.customer_id)]);
      const verification = ctx.storeVerifications ? await ctx.storeVerifications.phoneStatus(session.account.id, session.account.phone_e164) : null;
      const emailVerified = ctx.storeVerifications ? await ctx.storeVerifications.emailVerified(session.account) : false;
      return send(200, {
        ok: true,
        account: {
          ...accounts.viewAccount(session.account, session.customer),
          phone_saved: Boolean(session.account.phone_e164),
          phone_verified: verification ? verification.verified : false,
          phone_otp_enabled: Boolean(verification?.otp_enabled),
          phone_masked: verification?.masked ?? (session.account.phone_e164 ? maskPhone(session.account.phone_e164) : null),
        },
        customer: { id: session.customer?.id ?? null, name: session.customer?.name ?? '' },
        orders_count: orders.length,
        requests_count: requests.length,
        email_verified: emailVerified,
      });
    }

    if (route === '/api/store/account/me' && req.method === 'PATCH') {
      const session = requireAccount();
      if (!session) return true;
      const body = await readJson(req, 40000);
      const account = await accounts.updateProfile(session.account, body);
      return send(200, { ok: true, account });
    }

    if (route === '/api/store/account/orders' && req.method === 'GET') {
      const session = requireAccount();
      if (!session) return true;
      return send(200, { ok: true, orders: await accounts.ordersForCustomer(session.account.customer_id) });
    }

    if (route === '/api/store/account/requests' && req.method === 'GET') {
      const session = requireAccount();
      if (!session) return true;
      return send(200, { ok: true, requests: await accounts.listRequestsForCustomer(session.account.customer_id) });
    }

    if (route === '/api/store/orders' && req.method === 'POST') {
      const current = requireAccount();
      if (!current) return true;
      const blocked = await phoneGate(current);
      if (blocked) return send(403, blocked);
      if (typeof ctx.createStoreOrder !== 'function') {
        return send(503, { ok: false, error: 'orders_unavailable', message: 'Los pedidos de la tienda no están disponibles ahora mismo.' });
      }
      let body;
      try { body = await readJson(req, 30000); } catch { return send(400, { ok: false, error: 'invalid_body', message: 'No pudimos leer el pedido.' }); }
      const result = await ctx.createStoreOrder(current, body && typeof body === 'object' ? body : {});
      if (!result?.ok) {
        return send(result?.status ?? 422, {
          ok: false,
          error: result?.error ?? 'order_failed',
          message: result?.message ?? 'No pudimos registrar el pedido.',
        });
      }
      return send(201, { ok: true, duplicate: result.duplicate === true, order: result.order });
    }

    if (route === '/api/store/requests' && req.method === 'POST') {
      const session = requireAccount();
      if (!session) return true;
      const blocked = await phoneGate(session);
      if (blocked) return send(403, blocked);
      const body = await readJson(req, 4600000);
      const result = await accounts.createRequest(session.account, body);
      return send(result.duplicate ? 200 : 201, { ok: true, request: result.request, duplicate: result.duplicate });
    }

    const imageMatch = /^\/api\/store\/requests\/([a-zA-Z0-9_-]+)\/image\/(\d+)$/.exec(route);
    if (imageMatch && req.method === 'GET') {
      const session = requireAccount();
      if (!session) return true;
      const image = await accounts.requestImage(imageMatch[1], imageMatch[2], session.account);
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

    const decisionMatch = /^\/api\/store\/requests\/([a-zA-Z0-9_-]+)\/decision$/.exec(route);
    if (decisionMatch && req.method === 'POST') {
      const session = requireAccount();
      if (!session) return true;
      const body = await readJson(req, 20000);
      const request = await accounts.decideRequest(decisionMatch[1], session.account, body);
      return send(200, { ok: true, request });
    }

    /* El cliente reporta la transferencia del anticipo (no la confirma). */
    const transferMatch = /^\/api\/store\/requests\/([a-zA-Z0-9_-]+)\/transfer$/.exec(route);
    if (transferMatch && req.method === 'POST') {
      const session = requireAccount();
      if (!session) return true;
      const body = await readJson(req, 900000);
      const request = await accounts.reportTransfer(transferMatch[1], session.account, body);
      return send(200, { ok: true, request });
    }

    const requestMatch = /^\/api\/store\/requests\/([a-zA-Z0-9_-]+)$/.exec(route);
    if (requestMatch && req.method === 'GET') {
      const session = requireAccount();
      if (!session) return true;
      const request = await accounts.getRequest(requestMatch[1], session.account);
      if (!request) return send(404, { ok: false, error: 'not_found', message: 'La solicitud no existe.' });
      return send(200, { ok: true, request, statuses: STORE_REQUEST_STATUSES });
    }

    if (accountRoute || requestRoute) return send(404, { ok: false, error: 'not_found' });
    return false;
  } catch (error) {
    const { status, body } = publicOrderError(error);
    return send(status, body);
  }
}
