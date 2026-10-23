/**
 * RUTAS DE IDENTIDAD DE LA TIENDA — teléfono verificado, correo y Google.
 *
 * Vive en su propio archivo para no mezclar cambios con el catálogo, el carrito
 * o los pedidos (otra línea de trabajo toca esos módulos).
 *
 * Contrato público (todo bajo `/api/store/account/`):
 *   GET  verification        → estado de teléfono/correo y capacidades activas
 *   GET  auth-config         → client_id público de Google (para GIS)
 *   POST phone               → guarda el número (estado NO verificado)
 *   POST phone/send          → envía un código (APAGADO en la Fase 1)
 *   POST phone/verify        → confirma el código (APAGADO en la Fase 1)
 *   GET  phone/outbox        → SOLO UAT: dónde queda el código de prueba
 *   POST google/credential   → entra con el `credential` de Google Identity
 *   POST email/send          → envía el enlace de confirmación de correo
 *   POST email/confirm       → confirma el correo
 *   POST recover             → pide recuperación (respuesta siempre genérica)
 *   POST recover/confirm     → crea la contraseña nueva
 *
 * Las escrituras exigen mismo origen (CSRF). Nunca se devuelven códigos,
 * tokens internos ni detalles de autenticación en los mensajes de error.
 */
import { maskPhone, normalizeDnPhone } from './store-verifications.mjs';
import { bindRequestTrust, trustOf } from './http-trust.mjs';

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

/* HTTPS real: la cabecera del proxy solo cuenta si el proxy es de confianza. */
function secureRequest(req) {
  return trustOf(req).isSecure(req);
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

/** Límite por ruta e IP: frena el abuso sin castigar al cliente legítimo. */
const attempts = new Map();
function throttle(req, key, max = 20, windowMs = 15 * 60 * 1000) {
  /* Por CLIENTE real, no por socket: detrás de nginx todos llegan de 127.0.0.1. */
  const id = `${key}:${trustOf(req).clientIp(req)}`;
  const now = Date.now();
  const entry = attempts.get(id);
  if (entry && entry.until > now && entry.count >= max) return false;
  attempts.set(id, { count: entry && entry.until > now ? entry.count + 1 : 1, until: now + windowMs });
  return true;
}

const publicError = (error) => {
  if (error?.status) return { status: error.status, body: { ok: false, error: error.code ?? 'invalid', message: error.message } };
  console.error('[store-auth] operation failed', { code: error?.code, name: error?.name });
  return { status: 500, body: { ok: false, error: 'auth_error', message: 'No pudimos completar la operación. Inténtalo de nuevo.' } };
};

export async function handleStoreAuthRoute({ req, res, route, url, ctx, json, readJson }) {
  const ROUTES = new Set([
    '/api/store/account/verification',
    '/api/store/account/auth-config',
    '/api/store/account/phone',
    '/api/store/account/phone/send',
    '/api/store/account/phone/verify',
    '/api/store/account/phone/outbox',
    '/api/store/account/google/credential',
    '/api/store/account/email/send',
    '/api/store/account/email/confirm',
    '/api/store/account/recover',
    '/api/store/account/recover/confirm',
  ]);
  if (!ROUTES.has(route)) return false;

  /* Confianza de proxy de ESTA petición (la resuelve `crm-server`). */
  bindRequestTrust(req, ctx.requestTrust);
  const accounts = ctx.storeAccounts;
  const verifications = ctx.storeVerifications;
  if (!accounts) {
    json(res, 503, { ok: false, error: 'accounts_unavailable', message: 'La cuenta estará disponible en breve.' });
    return true;
  }

  const send = (status, body, headers = {}) => {
    json(res, status, body, headers);
    return true;
  };

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return send(405, { ok: false, error: 'method_not_allowed' });
  }
  if (req.method === 'POST' && !sameOrigin(req)) {
    return send(403, { ok: false, error: 'cross_origin', message: 'No pudimos verificar la solicitud.' });
  }

  try {
    const token = readCookie(req, COOKIE);
    const current = token ? await accounts.session(token) : null;
    const requireSession = () => {
      if (!current) {
        json(res, 401, { ok: false, error: 'unauthorized', message: 'Inicia sesión para continuar.' });
        return null;
      }
      return current;
    };

    if (route === '/api/store/account/auth-config' && req.method === 'GET') {
      const google = ctx.googleId ?? null;
      return send(200, {
        ok: true,
        google: {
          enabled: Boolean(google?.enabled),
          client_id: google?.enabled ? google.clientId : null,
        },
        sms: Boolean(verifications?.sms?.configured),
        mail: Boolean(verifications?.mail?.configured),
      });
    }

    if (route === '/api/store/account/verification' && req.method === 'GET') {
      if (!current) return send(200, { ok: true, account: null, phone: null });
      if (!verifications) {
        return send(200, {
          ok: true,
          phone: { otp_enabled: false, saved: Boolean(current.account.phone_e164), verified: false, masked: current.account.phone_e164 ? maskPhone(current.account.phone_e164) : null, pending: false },
          email_verified: false,
        });
      }
      const [phone, emailVerified] = await Promise.all([
        verifications.phoneStatus(current.account.id, current.account.phone_e164),
        verifications.emailVerified(current.account),
      ]);
      return send(200, { ok: true, phone, email_verified: emailVerified });
    }

    /*
     * GUARDAR TELÉFONO (sin código). Es lo único necesario para pedir o
     * solicitar en la Fase 1. El número queda como `unverified`.
     */
    if (route === '/api/store/account/phone' && req.method === 'POST') {
      if (!throttle(req, 'phone-save', 20)) return send(429, { ok: false, error: 'too_many_attempts', message: 'Demasiados intentos. Espera unos minutos.' });
      const session = requireSession();
      if (!session) return true;
      const body = await readJson(req, 8000);
      const parsed = normalizeDnPhone(body?.phone);
      if (!parsed.ok) {
        throw fail(
          'invalid_phone',
          parsed.reason === 'not_dr'
            ? 'Escribe un número de República Dominicana (809, 829 o 849).'
            : 'Escribe un número de teléfono válido, por ejemplo 809 000 0000.',
        );
      }
      const updated = await accounts.setPhone(session.account.id, parsed.e164);
      const link = await accounts.ensureCustomerForPhone(updated, String(body?.orderNumber ?? '').trim().slice(0, 60));
      if (verifications) await verifications.markPhoneUnverified(updated, parsed.e164);
      return send(200, {
        ok: true,
        linked: link.linked === true,
        needs_proof: link.reason === 'needs_proof',
        phone_masked: maskPhone(parsed.e164),
        verified: false,
        ...(link.reason === 'needs_proof'
          ? { message: 'Guardamos tu número. Ese teléfono ya tiene historial con nosotros: para ver esos pedidos necesitamos el número de uno de ellos.' }
          : {}),
      });
    }

    if (route === '/api/store/account/phone/send' && req.method === 'POST') {
      if (!verifications) return send(503, { ok: false, error: 'verification_unavailable', message: 'La verificación todavía no está disponible.' });
      if (!throttle(req, 'phone-send', 12)) return send(429, { ok: false, error: 'too_many_attempts', message: 'Demasiados intentos. Espera unos minutos.' });
      const session = requireSession();
      if (!session) return true;
      const body = await readJson(req, 8000);
      const result = await verifications.requestPhoneCode({
        account: session.account,
        phone: body?.phone,
        ip: req.socket?.remoteAddress ?? '',
      });
      return send(200, { ok: true, ...result });
    }

    if (route === '/api/store/account/phone/verify' && req.method === 'POST') {
      if (!verifications) return send(503, { ok: false, error: 'verification_unavailable', message: 'La verificación todavía no está disponible.' });
      if (!throttle(req, 'phone-verify', 30)) return send(429, { ok: false, error: 'too_many_attempts', message: 'Demasiados intentos. Espera unos minutos.' });
      const session = requireSession();
      if (!session) return true;
      const body = await readJson(req, 8000);
      const result = await verifications.confirmPhoneCode({ account: session.account, code: body?.code });
      return send(200, result);
    }

    if (route === '/api/store/account/phone/outbox' && req.method === 'GET') {
      if (!verifications?.sms?.exposesCodes) return send(404, { ok: false, error: 'not_available' });
      const session = requireSession();
      if (!session) return true;
      return send(200, { ok: true, ...(await verifications.peekLastCode(session.account.id)) });
    }

    if (route === '/api/store/account/google/credential' && req.method === 'POST') {
      const verifier = ctx.googleId;
      if (!verifier?.enabled) return send(503, { ok: false, error: 'provider_not_configured', message: 'El acceso con Google todavía no está activo.' });
      if (!throttle(req, 'google-credential', 20)) return send(429, { ok: false, error: 'too_many_attempts', message: 'Demasiados intentos. Espera unos minutos.' });
      const body = await readJson(req, 12000);
      /*
       * CONTROL DE CSRF PROPIO DEL FLUJO: Google Identity Services deja una
       * cookie `g_csrf_token` en el origen y repite el valor en el cuerpo. Si la
       * cookie existe, DEBEN coincidir; si no existe, la petición no viene del
       * botón de Google y se rechaza (fail-closed cuando el flujo está activo).
       */
      const csrfCookie = readCookie(req, 'g_csrf_token');
      const csrfBody = String(body?.g_csrfToken ?? '');
      if (csrfCookie !== null && csrfCookie !== csrfBody) {
        return send(403, { ok: false, error: 'cross_origin', message: 'No pudimos verificar la solicitud.' });
      }
      if (csrfCookie === null && ctx.storeGoogleCsrfRequired === true) {
        return send(403, { ok: false, error: 'cross_origin', message: 'No pudimos verificar la solicitud.' });
      }
      const identity = await verifier.verify(body?.credential);
      const result = await accounts.oauthLogin(identity);
      if (result.pending) {
        /*
         * `needs_proof: 'password'` = ese correo ya tiene una cuenta con
         * contraseña: para enlazar Google hay que demostrar que es suya. El
         * navegador lo usa para pedir la contraseña en vez del teléfono.
         */
        return send(200, { ok: true, pending: true, pending_token: result.pendingToken, needs_proof: result.needsProof ?? null });
      }
      const session = await accounts.createSession(result.account.id);
      if (!session) throw fail('session_error', 'No pudimos iniciar tu sesión.', 500);
      return send(200, { ok: true, account: result.account }, { 'set-cookie': storeCookie(req, session.token) });
    }

    if (route === '/api/store/account/email/send' && req.method === 'POST') {
      if (!verifications) return send(503, { ok: false, error: 'verification_unavailable', message: 'La verificación todavía no está disponible.' });
      if (!throttle(req, 'email-send', 8)) return send(429, { ok: false, error: 'too_many_attempts', message: 'Demasiados intentos. Espera unos minutos.' });
      const session = requireSession();
      if (!session) return true;
      return send(200, await verifications.requestEmailVerification(session.account));
    }

    if (route === '/api/store/account/email/confirm' && req.method === 'POST') {
      if (!verifications) return send(503, { ok: false, error: 'verification_unavailable', message: 'La verificación todavía no está disponible.' });
      if (!throttle(req, 'email-confirm', 20)) return send(429, { ok: false, error: 'too_many_attempts', message: 'Demasiados intentos. Espera unos minutos.' });
      const body = await readJson(req, 8000);
      return send(200, await verifications.confirmEmailVerification(body?.token));
    }

    if (route === '/api/store/account/recover' && req.method === 'POST') {
      if (!throttle(req, 'recover', 8)) return send(429, { ok: false, error: 'too_many_attempts', message: 'Demasiados intentos. Espera unos minutos.' });
      const body = await readJson(req, 8000);
      /* Respuesta SIEMPRE genérica: no se revela si el correo existe. */
      if (!verifications) {
        return send(200, { ok: true, message: 'Si el dato coincide con una cuenta, te enviamos un enlace para recuperar el acceso.' });
      }
      return send(200, await verifications.requestPasswordReset({ identifier: body?.identifier }));
    }

    if (route === '/api/store/account/recover/confirm' && req.method === 'POST') {
      if (!verifications) return send(503, { ok: false, error: 'verification_unavailable', message: 'La recuperación todavía no está disponible.' });
      if (!throttle(req, 'recover-confirm', 12)) return send(429, { ok: false, error: 'too_many_attempts', message: 'Demasiados intentos. Espera unos minutos.' });
      const body = await readJson(req, 8000);
      return send(200, await verifications.resetPassword(body?.token, body?.password));
    }

    return send(404, { ok: false, error: 'not_found' });
  } catch (error) {
    const { status, body } = publicError(error);
    const headers = error?.retryAfter ? { 'retry-after': String(error.retryAfter) } : {};
    return send(status, body, headers);
  }
}
