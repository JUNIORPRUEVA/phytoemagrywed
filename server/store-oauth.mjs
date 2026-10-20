import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';

const text = (value) => String(value ?? '').trim();
const b64url = (value) => Buffer.from(value).toString('base64url');
const b64urlJson = (value) => b64url(JSON.stringify(value));
const decodeJson = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

const fail = (message) => Object.assign(new Error(message), { code: 'oauth_failed', status: 502 });

/**
 * OAuth de cliente para Google y Apple.
 *
 * No hay dependencias nuevas: el flujo de autorización, el secreto de cliente de
 * Apple (ES256) y la verificación del `id_token` contra las claves públicas de
 * Apple se hacen con `node:crypto`. Si faltan credenciales, el proveedor queda
 * apagado y la tienda ofrece el acceso con teléfono y contraseña.
 */
export function createStoreOAuth({ config = {}, fetchImpl = fetch, clock = () => new Date() } = {}) {
  const google = {
    clientId: text(config.google?.clientId),
    clientSecret: text(config.google?.clientSecret),
    redirectUri: text(config.google?.redirectUri),
  };
  const apple = {
    clientId: text(config.apple?.clientId),
    teamId: text(config.apple?.teamId),
    keyId: text(config.apple?.keyId),
    privateKey: text(config.apple?.privateKey).replace(/\\n/g, '\n'),
    redirectUri: text(config.apple?.redirectUri),
  };
  const configured = {
    google: Boolean(google.clientId && google.clientSecret),
    apple: Boolean(apple.clientId && apple.teamId && apple.keyId && apple.privateKey),
  };

  const state = () => randomBytes(24).toString('base64url');

  function redirectUri(provider, req) {
    const explicit = provider === 'apple' ? apple.redirectUri : google.redirectUri;
    if (explicit) return explicit;
    const proto = String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim() || (req?.socket?.encrypted ? 'https' : 'http');
    const host = req?.headers?.host ?? 'localhost';
    return `${proto}://${host}/api/store/account/auth/${provider}/callback`;
  }

  function authorizeUrl(provider, { state: value, redirect }) {
    if (!configured[provider]) throw Object.assign(new Error('provider_not_configured'), { code: 'provider_not_configured', status: 503 });
    if (provider === 'google') {
      const params = new URLSearchParams({
        client_id: google.clientId, redirect_uri: redirect, response_type: 'code',
        scope: 'openid email profile', state: value, prompt: 'select_account', access_type: 'online',
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    }
    const params = new URLSearchParams({
      client_id: apple.clientId, redirect_uri: redirect, response_type: 'code',
      scope: 'name email', state: value, response_mode: 'form_post',
    });
    return `https://appleid.apple.com/auth/authorize?${params}`;
  }

  async function postForm(url, body) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw fail(`provider_rejected_${response.status}`);
    return payload ?? {};
  }

  function appleClientSecret() {
    const now = Math.floor(clock().getTime() / 1000);
    const data = `${b64urlJson({ alg: 'ES256', kid: apple.keyId })}.${b64urlJson({
      iss: apple.teamId, iat: now, exp: now + 3000, aud: 'https://appleid.apple.com', sub: apple.clientId,
    })}`;
    const signature = sign('sha256', Buffer.from(data), { key: createPrivateKey(apple.privateKey), dsaEncoding: 'ieee-p1363' });
    return `${data}.${b64url(signature)}`;
  }

  async function verifyAppleIdToken(idToken) {
    const parts = String(idToken ?? '').split('.');
    if (parts.length !== 3) throw fail('invalid_id_token');
    const header = decodeJson(parts[0]);
    const payload = decodeJson(parts[1]);
    if (payload.iss !== 'https://appleid.apple.com') throw fail('invalid_issuer');
    if (payload.aud !== apple.clientId) throw fail('invalid_audience');
    if (!payload.sub) throw fail('missing_subject');
    if (Number(payload.exp) * 1000 <= clock().getTime()) throw fail('expired_id_token');
    const response = await fetchImpl('https://appleid.apple.com/auth/keys', { headers: { accept: 'application/json' } });
    const keys = await response.json().catch(() => null);
    const jwk = (keys?.keys ?? []).find((key) => key.kid === header.kid);
    if (!jwk) throw fail('unknown_signing_key');
    const valid = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    if (!valid) throw fail('invalid_signature');
    return payload;
  }

  async function exchange(provider, { code, redirect, user }) {
    if (!configured[provider]) throw Object.assign(new Error('provider_not_configured'), { code: 'provider_not_configured', status: 503 });
    if (!code) throw Object.assign(new Error('missing_code'), { code: 'missing_code', status: 400 });
    if (provider === 'google') {
      const token = await postForm('https://oauth2.googleapis.com/token', {
        code, client_id: google.clientId, client_secret: google.clientSecret,
        redirect_uri: redirect, grant_type: 'authorization_code',
      });
      const response = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' },
      });
      const info = await response.json().catch(() => null);
      if (!response.ok || !info?.sub) throw fail('google_userinfo_failed');
      return {
        provider: 'google', sub: info.sub, email: info.email ?? '', emailVerified: info.email_verified === true,
        name: text(info.name),
      };
    }
    const token = await postForm('https://appleid.apple.com/auth/token', {
      code, client_id: apple.clientId, client_secret: appleClientSecret(),
      redirect_uri: redirect, grant_type: 'authorization_code',
    });
    const payload = await verifyAppleIdToken(token.id_token);
    let name = '';
    if (user) {
      try {
        const parsed = typeof user === 'string' ? JSON.parse(user) : user;
        name = [parsed?.name?.firstName, parsed?.name?.lastName].filter(Boolean).join(' ').trim();
      } catch {
        /* el nombre es opcional: Apple solo lo envía la primera vez */
      }
    }
    return {
      provider: 'apple', sub: payload.sub, email: payload.email ?? '',
      emailVerified: payload.email_verified !== false, name,
    };
  }

  return { configured, providerFlags: { google: configured.google, apple: configured.apple }, state, redirectUri, authorizeUrl, exchange, appleClientSecret, verifyAppleIdToken };
}
