/**
 * GOOGLE SEARCH CONSOLE — integración de SOLO LECTURA (módulo aislado).
 *
 * No conoce el CRM, ni el catálogo, ni Express: recibe `fetchImpl` y `clock`
 * inyectables para poder probarse entero con credenciales simuladas. El servidor
 * solo lo usaría desde un script o una ruta protegida.
 *
 * Contrato de autenticación (ver docs/SEARCH-CONSOLE.md):
 *   · Modo `service_account`: firma un JWT RS256 con la clave privada del service
 *     account y lo canjea por un access token de corta duración. La clave nunca
 *     se envía a Google, nunca se registra y nunca sale de memoria.
 *   · Modo `mock`: mismo cliente, mismo código de red, pero con transporte falso.
 *     Sirve para desarrollo y pruebas sin credenciales reales.
 *   · Modo `disabled`: todo falla cerrado con `gsc_disabled`.
 *
 * Escrituras: SOLO existe `submitSitemap()`, y está bloqueada salvo que el
 * entorno active DOS interruptores explícitos
 * (`PHYTO_GSC_ALLOW_SITEMAP_SUBMIT=1` y `PHYTO_GSC_SEO_AUDIT_OK=1`). Sin ellos
 * la integración es estrictamente de lectura.
 */
import { createSign } from 'node:crypto';

export const GSC_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GSC_WEBMASTERS_API = 'https://www.googleapis.com/webmasters/v3';
export const GSC_INSPECTION_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
/** Alcance mínimo: leer propiedades, sitemaps y datos de rendimiento. */
export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

const DEFAULT_TIMEOUT_MS = 15000;
const TOKEN_SAFETY_SECONDS = 60;
const MAX_ROWS = 25000;

const fail = (code, message, status = 502) =>
  Object.assign(new Error(message), { code, status });

const b64url = (value) => Buffer.from(value).toString('base64url');
const text = (value, max = 300) => String(value ?? '').trim().slice(0, max);

export function cleanOrigin(value) {
  const raw = text(value, 240);
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ red */

function abortable(fetchImpl, url, options, timeoutMs) {
  if (typeof AbortController !== 'function') return fetchImpl(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  return fetchImpl(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

const headerValue = (headers, name) => {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) ?? '');
  return String(headers[name] ?? headers[name.toLowerCase()] ?? '');
};

/* ------------------------------------------- token del service account */

/**
 * Canjea la credencial del service account por un access token cacheado.
 * @param {{credentials?: {client_email?: string, private_key?: string, private_key_id?: string, token_uri?: string}, fetchImpl?: typeof fetch, clock?: () => Date, timeoutMs?: number}} options
 */
export function createServiceAccountTokenProvider({
  credentials,
  fetchImpl = fetch,
  clock = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const email = text(credentials?.client_email, 320);
  /* La clave puede venir con `\n` escapados (JSON dentro de una variable de entorno). */
  const privateKey = String(credentials?.private_key ?? '').replace(/\\n/g, '\n').trim();
  const tokenUri = text(credentials?.token_uri, 240) || GSC_TOKEN_URL;
  if (!email || !privateKey) {
    throw fail('gsc_credentials_invalid', 'La credencial del service account está incompleta.', 500);
  }
  if (!privateKey.includes('BEGIN PRIVATE KEY') || !privateKey.includes('END PRIVATE KEY')) {
    throw fail('gsc_credentials_invalid', 'La clave privada no está en formato PEM PKCS#8.', 500);
  }

  let cached = { token: '', expiresAt: 0 };

  async function issue() {
    const now = Math.floor(clock().getTime() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    if (credentials?.private_key_id) header.kid = text(credentials.private_key_id, 120);
    const claims = {
      iss: email,
      scope: GSC_SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    };
    const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    let assertion;
    try {
      const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url');
      assertion = `${unsigned}.${signature}`;
    } catch {
      /* Nunca se incluye el error de cripto: podría arrastrar parte de la clave. */
      throw fail('gsc_credentials_invalid', 'No pudimos firmar la solicitud con la credencial configurada.', 500);
    }
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString();
    let response;
    try {
      response = await abortable(fetchImpl, tokenUri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
      }, timeoutMs);
    } catch (cause) {
      throw Object.assign(fail('gsc_token_network', 'No pudimos contactar con Google para autenticar la integración.'), { cause });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.access_token) {
      throw fail(
        'gsc_token_rejected',
        'Google rechazó la credencial del service account. Revisa que la clave exista, esté activa y corresponda a la cuenta configurada.',
      );
    }
    const lifetime = Number(payload.expires_in) > 0 ? Number(payload.expires_in) : 3600;
    cached = { token: String(payload.access_token), expiresAt: clock().getTime() + Math.max(30, lifetime - TOKEN_SAFETY_SECONDS) * 1000 };
    return cached.token;
  }

  return {
    email,
    async token(force = false) {
      if (!force && cached.token && cached.expiresAt > clock().getTime()) return cached.token;
      return issue();
    },
  };
}

/** Token falso y contador de llamadas: modo mock sin tocar OAuth. */
export function createMockTokenProvider({ token = 'mock-access-token' } = {}) {
  const state = { calls: 0 };
  return {
    email: 'mock@service-account.invalid',
    state,
    async token() {
      state.calls += 1;
      return token;
    },
  };
}

/* ------------------------------------------------------------- cliente */

/**
 * @param {{siteUrl?: string, tokenProvider?: any, fetchImpl?: typeof fetch, timeoutMs?: number, allowSitemapSubmit?: boolean, submitBlockedReason?: string}} options
 */
export function createSearchConsole({
  siteUrl = '',
  tokenProvider,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowSitemapSubmit = false,
  submitBlockedReason = 'La escritura de sitemaps está bloqueada hasta auditar robots.txt, noindex, canonical y el sitemap.',
} = {}) {
  const site = text(siteUrl, 320);
  if (!site) throw fail('gsc_not_configured', 'Falta la propiedad de Search Console (PHYTO_GSC_SITE_URL).', 500);
  if (!tokenProvider?.token) throw fail('gsc_not_configured', 'Falta el proveedor de credenciales de Search Console.', 500);

  const sitePath = encodeURIComponent(site);

  async function call(url, { method = 'GET', body } = {}) {
    const accessToken = await tokenProvider.token();
    let response;
    try {
      response = await abortable(fetchImpl, url, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }, timeoutMs);
    } catch (cause) {
      throw Object.assign(fail('gsc_network', 'No pudimos contactar con Google Search Console.'), { cause });
    }
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    const status = Number(response.status) || 0;
    if (status === 401) throw fail('gsc_unauthorized', 'El token de Google no es válido o caducó.', 401);
    if (status === 403) {
      const message = text(payload?.error?.message, 200);
      throw fail(
        'gsc_forbidden',
        /insufficient permission|permission/i.test(message)
          ? 'La cuenta de servicio no tiene acceso a esta propiedad de Search Console.'
          : 'Google rechazó la operación: la cuenta de servicio no está autorizada.',
        403,
      );
    }
    if (status === 404) throw fail('gsc_not_found', 'La propiedad o el recurso no existe en Search Console.', 404);
    if (status === 429) {
      const retry = Number(headerValue(response.headers, 'retry-after')) || 0;
      throw Object.assign(fail('gsc_quota', 'Search Console limitó las peticiones. Inténtalo más tarde.', 429), { retryAfter: retry });
    }
    throw fail('gsc_api_error', `Search Console respondió ${status || 'con un error'}.`, 502);
  }

  return {
    siteUrl: site,
    allowSitemapSubmit: allowSitemapSubmit === true,
    submitBlockedReason,
    describe() {
      return { siteUrl: site, sitemapSubmitAllowed: allowSitemapSubmit === true, submitBlockedReason };
    },
    /** Propiedades visibles para la cuenta de servicio. */
    async listSites() {
      const payload = await call(`${GSC_WEBMASTERS_API}/sites`);
      return (payload?.siteEntry ?? []).map((entry) => ({
        siteUrl: String(entry?.siteUrl ?? ''),
        permissionLevel: String(entry?.permissionLevel ?? ''),
      }));
    },
    /** Comprueba que la propiedad configurada existe y con qué permiso. */
    async verifyAccess() {
      const sites = await this.listSites();
      const found = sites.find((entry) => entry.siteUrl === site) ?? null;
      return {
        siteUrl: site,
        ok: Boolean(found),
        permissionLevel: found?.permissionLevel ?? null,
        pending: /unverified|pending/i.test(found?.permissionLevel ?? ''),
        sitesVisible: sites.length,
      };
    },
    /** Rendimiento de búsqueda (clics, impresiones, CTR y posición media). */
    async searchAnalytics({ startDate, endDate, dimensions = ['query'], rowLimit = 25 } = {}) {
      const from = text(startDate, 10);
      const to = text(endDate, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        throw fail('gsc_invalid_range', 'Las fechas deben tener formato AAAA-MM-DD.', 400);
      }
      const limit = Math.min(Math.max(Number(rowLimit) || 25, 1), MAX_ROWS);
      const payload = await call(`${GSC_WEBMASTERS_API}/sites/${sitePath}/searchAnalytics/query`, {
        method: 'POST',
        body: { startDate: from, endDate: to, dimensions, rowLimit: limit },
      });
      return {
        startDate: from,
        endDate: to,
        rows: (payload?.rows ?? []).map((row) => ({
          keys: row?.keys ?? [],
          clicks: Number(row?.clicks ?? 0),
          impressions: Number(row?.impressions ?? 0),
          ctr: Number(row?.ctr ?? 0),
          position: Number(row?.position ?? 0),
        })),
      };
    },
    /** Estado de los sitemaps enviados (sin enviar nada). */
    async listSitemaps() {
      const payload = await call(`${GSC_WEBMASTERS_API}/sites/${sitePath}/sitemaps`);
      return (payload?.sitemap ?? []).map((entry) => ({
        path: String(entry?.path ?? ''),
        lastSubmitted: entry?.lastSubmitted ?? null,
        lastDownloaded: entry?.lastDownloaded ?? null,
        isPending: entry?.isPending === true,
        isSitemapsIndex: entry?.isSitemapsIndex === true,
        type: String(entry?.type ?? ''),
        errors: Number(entry?.errors ?? 0),
        warnings: Number(entry?.warnings ?? 0),
      }));
    },
    /** Inspección de una URL concreta (indexación, canonical de Google, rastreo). */
    async inspectUrl(inspectionUrl, { languageCode = 'es' } = {}) {
      const target = text(inspectionUrl, 2048);
      if (!/^https?:\/\//i.test(target)) {
        throw fail('gsc_invalid_url', 'La URL a inspeccionar debe empezar por http:// o https://.', 400);
      }
      const payload = await call(GSC_INSPECTION_URL, {
        method: 'POST',
        body: { inspectionUrl: target, siteUrl: site, languageCode: text(languageCode, 8) || 'es' },
      });
      const result = payload?.inspectionResult?.indexStatusResult ?? {};
      return {
        inspectionUrl: target,
        verdict: String(result.verdict ?? ''),
        coverageState: String(result.coverageState ?? ''),
        robotsTxtState: String(result.robotsTxtState ?? ''),
        indexingState: String(result.indexingState ?? ''),
        pageFetchState: String(result.pageFetchState ?? ''),
        googleCanonical: String(result.googleCanonical ?? ''),
        userCanonical: String(result.userCanonical ?? ''),
        lastCrawlTime: result.lastCrawlTime ?? null,
      };
    },
    /**
     * ÚNICA escritura de la integración. Bloqueada por defecto: exige el permiso
     * explícito del cliente (que a su vez depende de dos variables de entorno).
     */
    async submitSitemap(feedUrl) {
      if (allowSitemapSubmit !== true) throw fail('gsc_sitemap_locked', submitBlockedReason, 403);
      const feed = text(feedUrl, 2048);
      if (!/^https?:\/\//i.test(feed)) throw fail('gsc_invalid_url', 'El sitemap debe ser una URL absoluta.', 400);
      const payload = await call(`${GSC_WEBMASTERS_API}/sites/${sitePath}/sitemaps/${encodeURIComponent(feed)}`, { method: 'PUT' });
      return { submitted: feed, response: payload ?? {} };
    },
  };
}

/* --------------------------------------------------------- configuración */

/**
 * Lee el entorno SIN exponer secretos. Devuelve el diagnóstico que usa el CLI y
 * que sirve para decidir si la integración puede activarse.
 */
export function readSearchConsoleConfig(env = {}) {
  const mode = text(env.PHYTO_GSC_AUTH_MODE, 32).toLowerCase() || 'disabled';
  const siteUrl = text(env.PHYTO_GSC_SITE_URL, 320);
  const serviceAccountEmail = text(env.PHYTO_GSC_SERVICE_ACCOUNT_EMAIL, 320);
  const keyFile = text(env.PHYTO_GSC_KEY_FILE, 400);
  const keyJson = text(env.PHYTO_GSC_KEY_JSON, 20000);
  const timeoutMs = Math.min(Math.max(Number(env.PHYTO_GSC_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, 2000), 60000);
  const sitemapSubmitAllowed = text(env.PHYTO_GSC_ALLOW_SITEMAP_SUBMIT, 4) === '1';
  const seoAuditOk = text(env.PHYTO_GSC_SEO_AUDIT_OK, 4) === '1';

  const problems = [];
  if (!['disabled', 'service_account', 'mock'].includes(mode)) problems.push('PHYTO_GSC_AUTH_MODE debe ser disabled, service_account o mock.');
  if (mode !== 'disabled' && !siteUrl) problems.push('Falta PHYTO_GSC_SITE_URL (por ejemplo sc-domain:ejemplo.com).');
  if (mode === 'service_account' && !keyFile && !keyJson) problems.push('Falta la credencial: PHYTO_GSC_KEY_FILE o PHYTO_GSC_KEY_JSON.');
  if (mode === 'service_account' && keyFile && keyJson) problems.push('Hay dos credenciales configuradas; deja solo una (el archivo tiene prioridad).');
  if (keyJson && /"private_key"\s*:/.test(keyJson) === false) problems.push('PHYTO_GSC_KEY_JSON no parece un JSON de service account.');

  const submitBlockedReason = sitemapSubmitAllowed
    ? seoAuditOk
      ? ''
      : 'PHYTO_GSC_SEO_AUDIT_OK=1 es obligatorio: audita robots.txt, noindex, canonical y sitemap antes de enviar.'
    : 'PHYTO_GSC_ALLOW_SITEMAP_SUBMIT=1 es obligatorio para escribir en Search Console.';

  return {
    mode,
    siteUrl,
    serviceAccountEmail,
    keyFile,
    hasInlineKey: Boolean(keyJson),
    timeoutMs,
    sitemapSubmitAllowed,
    seoAuditOk,
    submitAllowed: sitemapSubmitAllowed && seoAuditOk,
    submitBlockedReason,
    problems,
    ready: problems.length === 0 && mode !== 'disabled',
  };
}

/**
 * Lee la credencial del service account. El archivo montado gana al JSON en
 * variable de entorno (una variable de entorno acaba en `docker inspect` y en
 * los volcados de proceso; un archivo con permisos 0400 no).
 */
export async function loadServiceAccountCredentials({ keyFile = '', keyJson = '', readFileImpl } = {}) {
  if (keyFile) {
    const readFile = readFileImpl ?? (await import('node:fs/promises')).readFile;
    let raw;
    try {
      raw = await readFile(keyFile, 'utf8');
    } catch {
      throw fail('gsc_key_unreadable', 'No pudimos leer el archivo de credencial configurado en PHYTO_GSC_KEY_FILE.', 500);
    }
    return parseServiceAccountJson(raw, 'PHYTO_GSC_KEY_FILE');
  }
  if (keyJson) return parseServiceAccountJson(keyJson, 'PHYTO_GSC_KEY_JSON');
  throw fail('gsc_credentials_missing', 'Falta la credencial del service account (PHYTO_GSC_KEY_FILE o PHYTO_GSC_KEY_JSON).', 500);
}

function parseServiceAccountJson(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw fail('gsc_key_invalid', `${source} no contiene un JSON válido.`, 500);
  }
  if (parsed?.type !== 'service_account' || !parsed?.client_email || !parsed?.private_key) {
    throw fail('gsc_key_invalid', `${source} no es una clave de service account de Google Cloud.`, 500);
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key, private_key_id: parsed.private_key_id, token_uri: parsed.token_uri };
}

/**
 * Construye el cliente a partir del entorno. Modo `disabled` cuando no hay
 * configuración: la integración no se activa sola nunca.
 * @param {{env?: Record<string,string>, fetchImpl?: typeof fetch, clock?: () => Date, readFileImpl?: (path: string, encoding: string) => Promise<string>}} options
 */
export async function createSearchConsoleFromEnv({ env = process.env, fetchImpl = fetch, clock, readFileImpl } = {}) {
  const config = readSearchConsoleConfig(env);
  if (config.mode === 'disabled') {
    return { config, client: null, disabled: true, reason: 'Integración desactivada (PHYTO_GSC_AUTH_MODE=disabled).' };
  }
  if (config.mode === 'mock') {
    /* El modo mock usa SIEMPRE su propio transporte: nunca la red real. */
    const { client, transport } = createMockSearchConsole({ siteUrl: config.siteUrl || 'sc-domain:ejemplo.com' });
    return { config, client, disabled: false, transport, mock: true };
  }
  if (!config.ready) {
    return { config, client: null, disabled: true, reason: config.problems.join(' ') };
  }
  const credentials = await loadServiceAccountCredentials({ keyFile: config.keyFile, keyJson: text(env.PHYTO_GSC_KEY_JSON, 20000), readFileImpl });
  if (config.serviceAccountEmail && credentials.client_email !== config.serviceAccountEmail) {
    throw fail(
      'gsc_key_mismatch',
      'La clave cargada pertenece a otra cuenta de servicio que la indicada en PHYTO_GSC_SERVICE_ACCOUNT_EMAIL.',
      500,
    );
  }
  const client = createSearchConsole({
    siteUrl: config.siteUrl,
    tokenProvider: createServiceAccountTokenProvider({ credentials, fetchImpl, clock, timeoutMs: config.timeoutMs }),
    fetchImpl,
    timeoutMs: config.timeoutMs,
    allowSitemapSubmit: config.submitAllowed,
    submitBlockedReason: config.submitBlockedReason || undefined,
  });
  return { config, client, disabled: false, mock: false };
}

/* --------------------------------------------------------------- mock */
const ok = (data) => ({
  ok: true,
  status: 200,
  headers: { get: () => '' },
  async json() {
    return data;
  },
});

function errorResponse(status, message) {
  return {
    ok: false,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'retry-after' ? '30' : '') },
    async json() {
      return { error: { code: status, message } };
    },
  };
}

/**
 * Transporte falso con respuestas REALISTAS de Search Console. Existe para poder
 * desarrollar y probar todo el flujo sin credenciales y sin tocar la propiedad.
 */
export function createMockFetch({ siteUrl = 'sc-domain:fulltechrd.com', sitemapUrl = 'https://fulltechrd.com/store/sitemap.xml' } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: String(options.method ?? 'GET'), body: options.body ? JSON.parse(String(options.body)) : null });
    const target = String(url);
    if (target === GSC_TOKEN_URL) return errorResponse(400, 'mock: no se canjean tokens reales');
    if (target.endsWith('/webmasters/v3/sites')) {
      return ok({ siteEntry: [{ siteUrl, permissionLevel: 'siteFullUser' }] });
    }
    if (target.includes('/searchAnalytics/query')) {
      return ok({
        rows: [
          { keys: ['router doble banda'], clicks: 42, impressions: 610, ctr: 0.0689, position: 7.4 },
          { keys: ['cámara ip'], clicks: 17, impressions: 320, ctr: 0.0531, position: 11.2 },
        ],
        responseAggregationType: 'byPage',
      });
    }
    if (target.includes('/sitemaps/')) {
      return ok({ submitted: sitemapUrl });
    }
    if (target.endsWith('/sitemaps')) {
      return ok({ sitemap: [{ path: sitemapUrl, lastSubmitted: '2026-10-01T12:00:00.000Z', lastDownloaded: '2026-10-02T03:10:00.000Z', isPending: false, isSitemapsIndex: false, type: 'sitemap', errors: 0, warnings: 0 }] });
    }
    if (target === GSC_INSPECTION_URL) {
      return ok({
        inspectionResult: {
          indexStatusResult: {
            verdict: 'PASS',
            coverageState: 'Enviada e indexada',
            robotsTxtState: 'ALLOWED',
            indexingState: 'INDEXING_ALLOWED',
            pageFetchState: 'SUCCESSFUL',
            googleCanonical: 'https://fulltechrd.com/store/p/capsules_5',
            userCanonical: 'https://fulltechrd.com/store/p/capsules_5',
            lastCrawlTime: '2026-10-18T09:00:00.000Z',
          },
        },
      });
    }
    return errorResponse(404, 'mock: ruta no simulada');
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** Cliente listo para usar en modo mock (mismas rutas y validaciones que el real). */
export function createMockSearchConsole({ siteUrl = 'sc-domain:fulltechrd.com', fetchImpl } = {}) {
  const transport = fetchImpl ?? createMockFetch({ siteUrl });
  const client = createSearchConsole({
    siteUrl,
    tokenProvider: createMockTokenProvider(),
    fetchImpl: transport,
    allowSitemapSubmit: false,
    submitBlockedReason: 'Modo mock: la escritura está desactivada por diseño.',
  });
  return { client, transport };
}

/* ----------------------------------------------- auditoría SEO previa */

function robotsBlocksEverything(robots) {
  const lines = String(robots ?? '').split(/\r?\n/).map((line) => line.replace(/#.*$/, '').trim());
  let currentAgents = [];
  for (const line of lines) {
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === 'user-agent') {
      if (currentAgents.includes('__rules__')) currentAgents = [];
      currentAgents.push(value.toLowerCase());
      continue;
    }
    if (field === 'disallow' && value === '/') {
      if (currentAgents.length === 0 || currentAgents.includes('*')) return true;
    }
    if (field === 'allow' || field === 'disallow') currentAgents.push('__rules__');
  }
  return false;
}

/**
 * Auditoría mínima y honesta ANTES de permitir cualquier envío de sitemap:
 * robots.txt, sitemap real, noindex y canonical de una URL de muestra.
 */
export async function auditSeoReadiness({ origin, samplePath = '/store/', sitemapPath = '/store/sitemap.xml', fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = cleanOrigin(origin);
  const checks = [];
  const record = (id, passed, detail) => checks.push({ id, ok: passed, detail });

  if (!base) {
    record('origin', false, 'Origen inválido: usa https://dominio.');
    return { origin: '', ok: false, checks };
  }
  record('origin', true, base);

  const get = async (path) => {
    try {
      const response = await abortable(fetchImpl, `${base}${path}`, { headers: { accept: '*/*' } }, timeoutMs);
      return { status: Number(response.status) || 0, body: await response.text().catch(() => '') };
    } catch {
      return { status: 0, body: '' };
    }
  };

  const robots = await get('/robots.txt');
  record('robots_status', robots.status === 200, robots.status === 200 ? 'robots.txt responde 200' : `robots.txt respondió ${robots.status || 'sin conexión'}`);
  const blocked = robotsBlocksEverything(robots.body);
  record('robots_allows_crawl', robots.status === 200 && !blocked, blocked ? 'robots.txt bloquea todo el sitio (Disallow: /)' : 'robots.txt permite el rastreo');
  record('robots_has_sitemap', /sitemap\s*:/i.test(robots.body), /sitemap\s*:/i.test(robots.body) ? 'robots.txt anuncia un sitemap' : 'robots.txt no anuncia ningún sitemap');

  const sitemap = await get(sitemapPath);
  const locs = [...String(sitemap.body).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => match[1]);
  record('sitemap_status', sitemap.status === 200 && /<urlset|<sitemapindex/i.test(sitemap.body), sitemap.status === 200 ? 'sitemap.xml responde 200 y es XML' : `sitemap.xml respondió ${sitemap.status || 'sin conexión'}`);
  record('sitemap_has_urls', locs.length > 0, `${locs.length} URL(s) en el sitemap`);
  const foreign = locs.filter((loc) => cleanOrigin(loc) !== base);
  record('sitemap_same_origin', foreign.length === 0, foreign.length ? `URLs de otro origen: ${foreign.slice(0, 3).join(', ')}` : 'todas las URL son del dominio');

  const page = await get(samplePath);
  const html = page.body;
  const noindex = /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html);
  record('sample_page_status', page.status === 200, `${samplePath} respondió ${page.status || 'sin conexión'}`);
  record('sample_page_indexable', !noindex, noindex ? 'La página de muestra lleva noindex' : 'La página de muestra es indexable');
  const canonical = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html)?.[1] ?? '';
  const expected = `${base}${samplePath}`;
  record('sample_page_canonical', canonical.replace(/\/$/, '') === expected.replace(/\/$/, ''), canonical ? `canonical: ${canonical}` : 'La página no declara canonical');

  return { origin: base, ok: checks.every((check) => check.ok), checks };
}
