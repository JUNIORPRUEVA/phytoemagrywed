/**
 * CLI de Google Search Console — SOLO LECTURA por defecto.
 *
 *   node scripts/search-console.mjs config
 *   node scripts/search-console.mjs access
 *   node scripts/search-console.mjs analytics --days 28 --limit 10
 *   node scripts/search-console.mjs sitemaps
 *   node scripts/search-console.mjs inspect --url https://fulltechrd.com/store/
 *   node scripts/search-console.mjs audit --origin https://fulltechrd.com
 *   node scripts/search-console.mjs submit-sitemap --sitemap https://fulltechrd.com/store/sitemap.xml
 *
 * `--env-file .env` lee variables de un archivo con formato KEY=VALOR (el entorno
 * real siempre gana). `--mock` usa respuestas simuladas y no habla con Google.
 * El envío de sitemap exige además PHYTO_GSC_ALLOW_SITEMAP_SUBMIT=1 y
 * PHYTO_GSC_SEO_AUDIT_OK=1; si falta cualquiera, el comando se niega.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  auditSeoReadiness,
  createSearchConsoleFromEnv,
  readSearchConsoleConfig,
} from '../server/search-console.mjs';

function parseEnv(source) {
  const out = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'env-file': { type: 'string' },
    mock: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    days: { type: 'string' },
    limit: { type: 'string' },
    url: { type: 'string' },
    origin: { type: 'string' },
    sitemap: { type: 'string' },
    'sample-path': { type: 'string' },
  },
});

const fileEnv = values['env-file'] ? parseEnv(await readFile(path.resolve(values['env-file']), 'utf8')) : {};
const env = values.mock
  ? { ...fileEnv, ...process.env, PHYTO_GSC_AUTH_MODE: 'mock', PHYTO_GSC_SITE_URL: (fileEnv.PHYTO_GSC_SITE_URL ?? process.env.PHYTO_GSC_SITE_URL ?? 'sc-domain:ejemplo.com') }
  : { ...fileEnv, ...process.env };

const command = (positionals[0] ?? 'config').toLowerCase();
const print = (payload) => console.log(JSON.stringify(payload, null, 2));

function siteOrigin(siteUrl) {
  if (siteUrl.startsWith('sc-domain:')) return `https://${siteUrl.slice('sc-domain:'.length)}`;
  return siteUrl.replace(/\/+$/, '');
}

function isoDaysAgo(days) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function exit(message, code = 1) {
  throw Object.assign(new Error(message), { exitCode: code, cli: true });
}

async function run() {
  if (command === 'config') {
    const config = readSearchConsoleConfig(env);
    print({
      modo: config.mode,
      propiedad: config.siteUrl || '(sin configurar)',
      cuenta_servicio: config.serviceAccountEmail || '(sin configurar)',
      credencial: config.keyFile ? `archivo: ${config.keyFile}` : config.hasInlineKey ? 'JSON en variable de entorno' : '(ninguna)',
      escritura_sitemap: config.submitAllowed ? 'PERMITIDA' : `BLOQUEADA — ${config.submitBlockedReason}`,
      problemas: config.problems,
      listo: config.ready,
    });
    if (config.problems.length) exit('La configuración tiene problemas; revisa la lista anterior.', 2);
    return;
  }

  /* La auditoría es HTTP pública: no necesita credencial de Google. */
  if (command === 'audit') {
    const configOnly = readSearchConsoleConfig(env);
    const origin = values.origin ?? (configOnly.siteUrl ? siteOrigin(configOnly.siteUrl) : '');
    if (!origin) exit('Indica --origin https://dominio (no hay PHYTO_GSC_SITE_URL configurada).', 2);
    const result = await auditSeoReadiness({ origin, samplePath: values['sample-path'] || '/store/' });
    print(result);
    if (!result.ok) exit('La auditoría SEO no pasa: NO envíes el sitemap todavía.', 1);
    return;
  }

  const { client, disabled, reason, config, mock } = await createSearchConsoleFromEnv({ env });
  if (disabled || !client) exit(`${reason ?? 'Integración no disponible.'} Revisa \`node scripts/search-console.mjs config\`.`, 2);
  if (!values.json) console.log(`· ${mock ? 'MODO MOCK (datos simulados)' : 'Search Console real'} · ${config.siteUrl}\n`);

  if (command === 'access') {
    const result = await client.verifyAccess();
    print(result);
    if (!result.ok) exit('La cuenta de servicio no ve la propiedad configurada.', 1);
    return;
  }
  if (command === 'analytics') {
    const days = Math.min(Math.max(Number(values.days) || 28, 1), 480);
    const result = await client.searchAnalytics({
      startDate: isoDaysAgo(days),
      endDate: isoDaysAgo(1),
      dimensions: ['query'],
      rowLimit: Math.min(Math.max(Number(values.limit) || 25, 1), 250),
    });
    print({ ...result, consultas: result.rows.length });
    return;
  }
  if (command === 'sitemaps') {
    print({ propiedad: config.siteUrl, sitemaps: await client.listSitemaps() });
    return;
  }
  if (command === 'inspect') {
    const url = values.url ?? `${siteOrigin(config.siteUrl)}/store/`;
    if (!/^https?:\/\//i.test(url)) exit('Indica --url https://… para inspeccionar.', 2);
    print(await client.inspectUrl(url));
    return;
  }
  if (command === 'submit-sitemap') {
    if (!client.describe().sitemapSubmitAllowed) exit(client.describe().submitBlockedReason, 2);
    const sitemap = values.sitemap;
    if (!sitemap) exit('Indica --sitemap https://…/store/sitemap.xml.', 2);
    print(await client.submitSitemap(sitemap));
    return;
  }
  exit(`Comando desconocido: ${command}. Usa config|access|analytics|sitemaps|inspect|audit|submit-sitemap.`, 2);
}

try {
  await run();
} catch (error) {
  console.error(`\n✖ ${error?.message ?? 'Error desconocido'}${error?.code ? ` [${error.code}]` : ''}`);
  process.exitCode = Number(error?.exitCode) || 1;
}
