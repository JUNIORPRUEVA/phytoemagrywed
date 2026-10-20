/**
 * GOOGLE IDENTITY SERVICES — verificación de `id_token` en el servidor.
 *
 * El navegador solo aporta el `credential` (un JWT firmado por Google). Aquí se
 * comprueba la FIRMA contra las claves públicas de Google y TODAS las
 * reclamaciones relevantes antes de mirar el correo:
 *
 *   · firma RS256 con la clave `kid` publicada por Google (caché de 1 hora)
 *   · `iss` es Google, `aud` es NUESTRO client_id, `exp` no ha vencido
 *   · `iat` no está en el futuro, `sub` existe (identidad estable)
 *
 * Nunca se acepta el correo tal cual lo envíe el frontend: sin firma válida no
 * hay identidad. Sin `clientId` configurado el verificador queda apagado.
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto';

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const VALID_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CLOCK_SKEW_SECONDS = 300;

const fail = (code, message, status = 401) => Object.assign(new Error(message), { code, status });

const decodeSegment = (segment) => JSON.parse(Buffer.from(String(segment), 'base64url').toString('utf8'));

/**
 * @param {{clientId?: string, fetchImpl?: typeof fetch, clock?: () => Date, cacheMs?: number}} options
 */
export function createGoogleIdVerifier({ clientId = '', fetchImpl = fetch, clock = () => new Date(), cacheMs = 60 * 60 * 1000 } = {}) {
  const id = String(clientId ?? '').trim();
  /** @type {{at:number, keys:Map<string, any>}} */
  let cache = { at: 0, keys: new Map() };

  async function keys() {
    const now = clock().getTime();
    if (cache.keys.size && now - cache.at < cacheMs) return cache.keys;
    const response = await fetchImpl(GOOGLE_CERTS_URL, { headers: { accept: 'application/json' } });
    if (!response.ok) throw fail('google_keys_unavailable', 'No pudimos verificar tu acceso con Google.', 502);
    const payload = await response.json().catch(() => null);
    const map = new Map();
    for (const jwk of payload?.keys ?? []) if (jwk?.kid) map.set(jwk.kid, jwk);
    if (!map.size) throw fail('google_keys_unavailable', 'No pudimos verificar tu acceso con Google.', 502);
    cache = { at: now, keys: map };
    return map;
  }

  /**
   * Verifica el `credential` y devuelve la identidad verificada.
   * @param {string} credential
   */
  async function verify(credential) {
    if (!id) throw fail('provider_not_configured', 'El acceso con Google todavía no está activo.', 503);
    const parts = String(credential ?? '').split('.');
    if (parts.length !== 3) throw fail('invalid_credential', 'No pudimos verificar tu acceso con Google.');
    let header;
    let payload;
    try {
      header = decodeSegment(parts[0]);
      payload = decodeSegment(parts[1]);
    } catch {
      throw fail('invalid_credential', 'No pudimos verificar tu acceso con Google.');
    }
    if (header.alg !== 'RS256') throw fail('invalid_credential', 'No pudimos verificar tu acceso con Google.');
    if (!VALID_ISSUERS.has(payload.iss)) throw fail('invalid_issuer', 'No pudimos verificar tu acceso con Google.');
    if (payload.aud !== id) throw fail('invalid_audience', 'No pudimos verificar tu acceso con Google.');
    const nowSeconds = Math.floor(clock().getTime() / 1000);
    if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= nowSeconds) throw fail('expired_credential', 'Tu sesión de Google caducó. Inténtalo de nuevo.');
    if (Number(payload.iat) > nowSeconds + CLOCK_SKEW_SECONDS) throw fail('invalid_credential', 'No pudimos verificar tu acceso con Google.');
    if (!payload.sub) throw fail('missing_subject', 'No pudimos verificar tu acceso con Google.');

    const jwk = (await keys()).get(header.kid);
    if (!jwk) throw fail('unknown_signing_key', 'No pudimos verificar tu acceso con Google.');
    let signatureOk = false;
    try {
      signatureOk = verifySignature(
        'RSA-SHA256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key: jwk, format: 'jwk' }),
        Buffer.from(parts[2], 'base64url'),
      );
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) throw fail('invalid_signature', 'No pudimos verificar tu acceso con Google.');

    return {
      provider: 'google',
      sub: String(payload.sub),
      email: String(payload.email ?? '').trim().toLowerCase(),
      emailVerified: payload.email_verified === true,
      name: String(payload.name ?? '').trim().slice(0, 120),
      picture: typeof payload.picture === 'string' ? payload.picture : '',
    };
  }

  return { enabled: Boolean(id), clientId: id, verify };
}
