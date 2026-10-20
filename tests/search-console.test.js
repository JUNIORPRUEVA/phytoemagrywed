/**
 * GOOGLE SEARCH CONSOLE — pruebas con credenciales SIMULADAS.
 *
 * Regla de oro: aquí no hay ninguna clave real. El par RSA se genera en memoria
 * en cada ejecución, así que el repositorio nunca contiene material sensible.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GSC_INSPECTION_URL,
  GSC_SCOPE,
  GSC_TOKEN_URL,
  GSC_WEBMASTERS_API,
  auditSeoReadiness,
  createMockFetch,
  createMockSearchConsole,
  createSearchConsole,
  createSearchConsoleFromEnv,
  createServiceAccountTokenProvider,
  readSearchConsoleConfig,
} from '../server/search-console.mjs';

const SITE = 'sc-domain:fulltechrd.com';

function serviceAccount() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    publicKey,
    credentials: {
      type: 'service_account',
      client_email: 'fulltech-seo@imprimerapido-cloud.iam.gserviceaccount.com',
      private_key: privateKey,
      private_key_id: 'kid-prueba',
      token_uri: GSC_TOKEN_URL,
    },
  };
}

const jsonResponse = (status, data, { retryAfter = '' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => (String(name).toLowerCase() === 'retry-after' ? retryAfter : '') },
  async json() {
    return data;
  },
});

function transportWith({ token = 'access-token-prueba', api = () => jsonResponse(200, {}) } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    const isJson = String(options.headers?.['content-type'] ?? '').includes('application/json');
    const rawBody = options.body ? String(options.body) : '';
    const parsed = {
      url: target,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      body: isJson && rawBody ? JSON.parse(rawBody) : null,
    };
    calls.push(parsed);
    if (target === GSC_TOKEN_URL) {
      const form = new URLSearchParams(rawBody);
      parsed.form = Object.fromEntries(form.entries());
      return jsonResponse(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
    }
    return api(parsed);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

describe('Search Console · credencial del service account', () => {
  it('firma un JWT RS256 con las reclamaciones correctas y sin filtrar la clave', async () => {
    const { publicKey, credentials } = serviceAccount();
    const fetchImpl = transportWith();
    const provider = createServiceAccountTokenProvider({ credentials, fetchImpl, clock: () => new Date('2026-10-20T10:00:00Z') });

    const token = await provider.token();
    expect(token).toBe('access-token-prueba');

    const exchange = fetchImpl.calls[0];
    expect(exchange.url).toBe(GSC_TOKEN_URL);
    expect(exchange.method).toBe('POST');
    expect(exchange.form.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

    const [header, payload, signature] = exchange.form.assertion.split('.');
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    const decodedPayload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    expect(decodedHeader).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid-prueba' });
    const issued = Math.floor(Date.parse('2026-10-20T10:00:00Z') / 1000);
    expect(decodedPayload).toMatchObject({
      iss: 'fulltech-seo@imprimerapido-cloud.iam.gserviceaccount.com',
      scope: GSC_SCOPE,
      aud: GSC_TOKEN_URL,
      iat: issued,
      exp: issued + 3600,
    });

    const verified = createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, signature, 'base64url');
    expect(verified).toBe(true);
    expect(JSON.stringify(exchange)).not.toContain('PRIVATE KEY');
  });

  it('reutiliza el token hasta acercarse a su caducidad', async () => {
    const { credentials } = serviceAccount();
    const fetchImpl = transportWith();
    let now = new Date('2026-10-20T10:00:00Z');
    const provider = createServiceAccountTokenProvider({ credentials, fetchImpl, clock: () => now });

    await provider.token();
    await provider.token();
    expect(fetchImpl.calls).toHaveLength(1);

    now = new Date('2026-10-20T11:00:30Z');
    await provider.token();
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('rechaza credenciales incompletas o que no son PKCS#8 sin exponer detalles', () => {
    expect(() => createServiceAccountTokenProvider({ credentials: { client_email: 'x@y.z' }, fetchImpl: transportWith() })).toThrowError(/incompleta/);
    let error;
    try {
      createServiceAccountTokenProvider({ credentials: { client_email: 'x@y.z', private_key: 'no-es-pem' }, fetchImpl: transportWith() });
    } catch (thrown) {
      error = thrown;
    }
    expect(error.code).toBe('gsc_credentials_invalid');
    expect(error.message).not.toContain('no-es-pem');
  });

  it('falla cerrado si Google rechaza el canje del token', async () => {
    const { credentials } = serviceAccount();
    const fetchImpl = async () => jsonResponse(400, { error: 'invalid_grant' });
    const provider = createServiceAccountTokenProvider({ credentials, fetchImpl });
    await expect(provider.token()).rejects.toMatchObject({ code: 'gsc_token_rejected' });
  });
});

describe('Search Console · lectura', () => {
  const buildClient = (api) => {
    const { credentials } = serviceAccount();
    const fetchImpl = transportWith({ api });
    return {
      fetchImpl,
      client: createSearchConsole({
        siteUrl: SITE,
        tokenProvider: createServiceAccountTokenProvider({ credentials, fetchImpl }),
        fetchImpl,
      }),
    };
  };

  it('codifica la propiedad en la ruta de la API', async () => {
    const { client, fetchImpl } = buildClient(() => jsonResponse(200, { siteEntry: [{ siteUrl: SITE, permissionLevel: 'siteFullUser' }] }));
    const result = await client.verifyAccess();
    expect(result).toMatchObject({ ok: true, permissionLevel: 'siteFullUser', sitesVisible: 1 });
    expect(fetchImpl.calls[1].url).toBe(`${GSC_WEBMASTERS_API}/sites`);
    expect(fetchImpl.calls[1].headers.authorization).toBe('Bearer access-token-prueba');
  });

  it('avisa cuando la propiedad no está entre las visibles', async () => {
    const { client } = buildClient(() => jsonResponse(200, { siteEntry: [{ siteUrl: 'https://otro.example/', permissionLevel: 'siteFullUser' }] }));
    await expect(client.verifyAccess()).resolves.toMatchObject({ ok: false, permissionLevel: null });
  });

  it('consulta rendimiento con fechas validadas', async () => {
    const rows = [{ keys: ['router'], clicks: 5, impressions: 90, ctr: 0.05, position: 6.1 }];
    const { client, fetchImpl } = buildClient(() => jsonResponse(200, { rows }));
    const result = await client.searchAnalytics({ startDate: '2026-09-22', endDate: '2026-10-19', dimensions: ['query'], rowLimit: 10 });
    expect(result.rows).toEqual(rows);
    const request = fetchImpl.calls[1];
    expect(request.url).toBe(`${GSC_WEBMASTERS_API}/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`);
    expect(request.body).toEqual({ startDate: '2026-09-22', endDate: '2026-10-19', dimensions: ['query'], rowLimit: 10 });
    await expect(client.searchAnalytics({ startDate: 'ayer', endDate: '2026-10-19' })).rejects.toMatchObject({ code: 'gsc_invalid_range' });
  });

  it('lista sitemaps sin enviarlos', async () => {
    const sitemap = { path: 'https://fulltechrd.com/store/sitemap.xml', lastDownloaded: '2026-10-02T03:00:00Z', isPending: false, errors: 0, warnings: 1 };
    const { client, fetchImpl } = buildClient(() => jsonResponse(200, { sitemap: [sitemap] }));
    const rows = await client.listSitemaps();
    expect(rows[0]).toMatchObject({ path: sitemap.path, warnings: 1 });
    expect(fetchImpl.calls[1].method).toBe('GET');
    expect(fetchImpl.calls[1].url).toBe(`${GSC_WEBMASTERS_API}/sites/${encodeURIComponent(SITE)}/sitemaps`);
  });

  it('inspecciona una URL y devuelve el veredicto de Google', async () => {
    const inspection = { indexStatusResult: { verdict: 'PASS', coverageState: 'Enviada e indexada', googleCanonical: 'https://fulltechrd.com/store/p/x', userCanonical: 'https://fulltechrd.com/store/p/x' } };
    const { client, fetchImpl } = buildClient(() => jsonResponse(200, { inspectionResult: inspection }));
    const result = await client.inspectUrl('https://fulltechrd.com/store/p/x');
    expect(result).toMatchObject({ verdict: 'PASS', googleCanonical: 'https://fulltechrd.com/store/p/x' });
    expect(fetchImpl.calls[1].url).toBe(GSC_INSPECTION_URL);
    expect(fetchImpl.calls[1].body).toEqual({ inspectionUrl: 'https://fulltechrd.com/store/p/x', siteUrl: SITE, languageCode: 'es' });
    await expect(client.inspectUrl('ftp://no')).rejects.toMatchObject({ code: 'gsc_invalid_url' });
  });

  it('traduce 403 y 429 a errores claros sin filtrar el token', async () => {
    const forbidden = buildClient(() => jsonResponse(403, { error: { message: 'Insufficient Permission' } }));
    await expect(forbidden.client.listSites()).rejects.toMatchObject({ code: 'gsc_forbidden', status: 403 });
    const quota = buildClient(() => jsonResponse(429, { error: { message: 'Quota exceeded' } }, { retryAfter: '30' }));
    const error = await quota.client.listSites().catch((thrown) => thrown);
    expect(error.code).toBe('gsc_quota');
    expect(error.retryAfter).toBe(30);
    expect(String(error.message)).not.toContain('access-token-prueba');
  });
});

describe('Search Console · escritura bloqueada', () => {
  it('no permite enviar sitemaps por defecto', async () => {
    const { client } = buildClientForSubmit(false);
    await expect(client.submitSitemap('https://fulltechrd.com/store/sitemap.xml')).rejects.toMatchObject({ code: 'gsc_sitemap_locked' });
  });

  it('solo envía cuando el cliente recibe permiso explícito', async () => {
    const { client, fetchImpl } = buildClientForSubmit(true);
    const result = await client.submitSitemap('https://fulltechrd.com/store/sitemap.xml');
    expect(result.submitted).toBe('https://fulltechrd.com/store/sitemap.xml');
    expect(fetchImpl.calls[1].method).toBe('PUT');
    expect(fetchImpl.calls[1].url).toBe(`${GSC_WEBMASTERS_API}/sites/${encodeURIComponent(SITE)}/sitemaps/${encodeURIComponent('https://fulltechrd.com/store/sitemap.xml')}`);
  });

  function buildClientForSubmit(allowed) {
    const { credentials } = serviceAccount();
    const fetchImpl = transportWith({ api: () => jsonResponse(200, {}) });
    return {
      fetchImpl,
      client: createSearchConsole({
        siteUrl: SITE,
        tokenProvider: createServiceAccountTokenProvider({ credentials, fetchImpl }),
        fetchImpl,
        allowSitemapSubmit: allowed,
      }),
    };
  }
});

describe('Search Console · configuración por entorno', () => {
  it('queda desactivada sin configuración y no inventa credenciales', async () => {
    const config = readSearchConsoleConfig({});
    expect(config.mode).toBe('disabled');
    expect(config.ready).toBe(false);
    const built = await createSearchConsoleFromEnv({ env: {} });
    expect(built.disabled).toBe(true);
    expect(built.client).toBeNull();
  });

  it('service_account exige propiedad y credencial', () => {
    const config = readSearchConsoleConfig({ PHYTO_GSC_AUTH_MODE: 'service_account', PHYTO_GSC_SERVICE_ACCOUNT_EMAIL: 'fulltech-seo@imprimerapido-cloud.iam.gserviceaccount.com' });
    expect(config.problems).toEqual([
      'Falta PHYTO_GSC_SITE_URL (por ejemplo sc-domain:ejemplo.com).',
      'Falta la credencial: PHYTO_GSC_KEY_FILE o PHYTO_GSC_KEY_JSON.',
    ]);
    expect(JSON.stringify(config)).not.toContain('private_key');
  });

  it('solo permite enviar sitemaps con los DOS interruptores', () => {
    const base = { PHYTO_GSC_AUTH_MODE: 'mock', PHYTO_GSC_SITE_URL: SITE };
    expect(readSearchConsoleConfig(base).submitAllowed).toBe(false);
    expect(readSearchConsoleConfig({ ...base, PHYTO_GSC_ALLOW_SITEMAP_SUBMIT: '1' }).submitAllowed).toBe(false);
    expect(readSearchConsoleConfig({ ...base, PHYTO_GSC_SEO_AUDIT_OK: '1' }).submitAllowed).toBe(false);
    const both = readSearchConsoleConfig({ ...base, PHYTO_GSC_ALLOW_SITEMAP_SUBMIT: '1', PHYTO_GSC_SEO_AUDIT_OK: '1' });
    expect(both.submitAllowed).toBe(true);
    expect(both.submitBlockedReason).toBe('');
  });

  it('carga la credencial desde un archivo y detecta una cuenta distinta', async () => {
    const { credentials } = serviceAccount();
    const readFileImpl = vi.fn(async () => JSON.stringify(credentials));
    const ok = await createSearchConsoleFromEnv({
      env: {
        PHYTO_GSC_AUTH_MODE: 'service_account',
        PHYTO_GSC_SITE_URL: SITE,
        PHYTO_GSC_SERVICE_ACCOUNT_EMAIL: credentials.client_email,
        PHYTO_GSC_KEY_FILE: '/run/secrets/gsc.json',
      },
      fetchImpl: transportWith(),
      readFileImpl,
    });
    expect(readFileImpl).toHaveBeenCalledWith('/run/secrets/gsc.json', 'utf8');
    expect(ok.client.siteUrl).toBe(SITE);
    expect(JSON.stringify(ok)).not.toContain('PRIVATE KEY');

    await expect(
      createSearchConsoleFromEnv({
        env: {
          PHYTO_GSC_AUTH_MODE: 'service_account',
          PHYTO_GSC_SITE_URL: SITE,
          PHYTO_GSC_SERVICE_ACCOUNT_EMAIL: 'otra@cuenta.invalid',
          PHYTO_GSC_KEY_FILE: '/run/secrets/gsc.json',
        },
        fetchImpl: transportWith(),
        readFileImpl,
      }),
    ).rejects.toMatchObject({ code: 'gsc_key_mismatch' });
  });
});

describe('Search Console · modo mock', () => {
  it('recorre todas las lecturas sin credenciales reales', async () => {
    const { client, transport } = createMockSearchConsole({ siteUrl: SITE });
    expect((await client.verifyAccess()).ok).toBe(true);
    expect((await client.searchAnalytics({ startDate: '2026-10-01', endDate: '2026-10-19' })).rows.length).toBeGreaterThan(0);
    expect((await client.listSitemaps())[0].path).toContain('sitemap.xml');
    expect((await client.inspectUrl('https://fulltechrd.com/store/')).verdict).toBe('PASS');
    await expect(client.submitSitemap('https://fulltechrd.com/store/sitemap.xml')).rejects.toMatchObject({ code: 'gsc_sitemap_locked' });
    expect(transport.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('el transporte simulado no llama a Google', async () => {
    const fetchImpl = createMockFetch({ siteUrl: SITE });
    const response = await fetchImpl(`${GSC_WEBMASTERS_API}/sites`);
    expect((await response.json()).siteEntry[0].siteUrl).toBe(SITE);
    expect(fetchImpl.calls[0].url).not.toContain('googleapis.com/token');
  });
});

describe('Auditoría SEO previa (puerta del sitemap)', () => {
  const page = (canonical, { noindex = false } = {}) => `<!doctype html><html><head><link rel="canonical" href="${canonical}"><meta name="robots" content="${noindex ? 'noindex,nofollow' : 'index,follow'}"></head><body>ok</body></html>`;

  const transport = (map) => {
    const calls = [];
    const fetchImpl = async (url) => {
      const target = String(url);
      calls.push(target);
      const body = map[target];
      return { ok: Boolean(body), status: body ? 200 : 404, async text() { return body ?? ''; } };
    };
    fetchImpl.calls = calls;
    return fetchImpl;
  };

  it('aprueba un sitio listo para Search Console', async () => {
    const origin = 'https://fulltechrd.com';
    const fetchImpl = transport({
      [`${origin}/robots.txt`]: 'User-agent: *\nAllow: /\nSitemap: https://fulltechrd.com/store/sitemap.xml\n',
      [`${origin}/store/sitemap.xml`]: '<?xml version="1.0"?><urlset><url><loc>https://fulltechrd.com/store/p/x</loc></url></urlset>',
      [`${origin}/store/`]: page('https://fulltechrd.com/store/'),
    });
    const result = await auditSeoReadiness({ origin, fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);
  });

  it('bloquea cuando robots.txt cierra todo, la página lleva noindex o el canonical apunta a otro sitio', async () => {
    const origin = 'https://fulltechrd.com';
    const fetchImpl = transport({
      [`${origin}/robots.txt`]: 'User-agent: *\nDisallow: /\n',
      [`${origin}/store/sitemap.xml`]: '<?xml version="1.0"?><urlset><url><loc>http://127.0.0.1:8790/store/p/x</loc></url></urlset>',
      [`${origin}/store/`]: page('https://otro.example/store/', { noindex: true }),
    });
    const result = await auditSeoReadiness({ origin, fetchImpl });
    expect(result.ok).toBe(false);
    const failing = result.checks.filter((check) => !check.ok).map((check) => check.id);
    expect(failing).toEqual(expect.arrayContaining(['robots_allows_crawl', 'sitemap_same_origin', 'sample_page_indexable', 'sample_page_canonical']));
  });

  it('no confunde un Disallow dirigido a otro user-agent con un bloqueo global', async () => {
    const origin = 'https://fulltechrd.com';
    const fetchImpl = transport({
      [`${origin}/robots.txt`]: 'User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nAllow: /\nSitemap: https://fulltechrd.com/store/sitemap.xml\n',
      [`${origin}/store/sitemap.xml`]: '<?xml version="1.0"?><urlset><url><loc>https://fulltechrd.com/store/p/x</loc></url></urlset>',
      [`${origin}/store/`]: page('https://fulltechrd.com/store/'),
    });
    const result = await auditSeoReadiness({ origin, fetchImpl });
    expect(result.checks.find((check) => check.id === 'robots_allows_crawl').ok).toBe(true);
  });
});
