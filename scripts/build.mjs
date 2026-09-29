/**
 * Build de producción.
 *
 *  1. Carga `.env` (sin sobreescribir variables ya presentes).
 *  2. Compila JS y CSS con esbuild (nombres con hash de contenido).
 *  3. Renderiza el HTML estático (index + legales) con las rutas con hash.
 *  4. Copia `public/` a `dist/`.
 *  5. Genera robots.txt y sitemap.xml.
 *  6. Avisa de la información pendiente.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

export const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
/** Carpeta publicable (solo la genera `npm run build`). */
export const DIST = path.join(ROOT, 'dist');
/** Carpeta del servidor de desarrollo: nunca se despliega. */
export const DIST_DEV = path.join(ROOT, 'dist-dev');
const SRC = path.join(ROOT, 'src');
const PUBLIC_DIR = path.join(ROOT, 'public');

const ENV_KEYS = [
  'PHYTO_WHATSAPP_NUMBER',
  'PHYTO_CRM_ENDPOINT',
  'PHYTO_META_PIXEL_ID',
  'SEO_SITE_URL',
  'CONTACT_EMAIL',
  'APP_ENV',
];

/**
 * Lee la configuración de entorno.
 *
 * REGLA: `.env.local` (overrides de desarrollo) se ignora SIEMPRE en el build
 * de producción, de modo que un valor de prueba local no puede acabar en `dist/`.
 * Solo lo usan `npm run dev` y `npm run preview`.
 *
 * @param {{ includeLocal?: boolean }} [options]
 */
export async function loadEnv(options = {}) {
  const { includeLocal = false } = options;
  const files = [path.join(ROOT, '.env'), ...(includeLocal ? [path.join(ROOT, '.env.local')] : [])];
  /** @type {Record<string,string>} */
  const parsed = {};
  for (const file of files) {
    if (!existsSync(file)) continue;
    const isLocal = file.endsWith('.env.local');
    const raw = await readFile(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
      if (isLocal) {
        // `.env.local` sobreescribe siempre (solo en desarrollo).
        parsed[key] = value;
        process.env[key] = value;
      } else if (process.env[key] === undefined) {
        parsed[key] = value;
        process.env[key] = value;
      }
    }
  }
  return parsed;
}

/** Objeto público inyectado en el bundle. */
export function envObject() {
  /** @type {Record<string,string>} */
  const out = {};
  for (const key of ENV_KEYS) out[key] = process.env[key] ?? '';
  if (!out.APP_ENV) out.APP_ENV = 'production';
  return out;
}

/** @param {string} dir */
async function listFiles(dir) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}

/**
 * @param {{ minify?: boolean, sourcemap?: boolean }} [options]
 * @param {string} [outDir]
 * @returns {Promise<{ css: string, js: string, sizes: Record<string, number> }>}
 */
export async function buildAssets(options = {}, outDir = DIST) {
  const { minify = true, sourcemap = false } = options;
  const define = { __PHYTO_ENV__: JSON.stringify(envObject()) };
  const assetsDir = path.join(outDir, 'assets');
  await mkdir(assetsDir, { recursive: true });

  const common = {
    bundle: true,
    minify,
    sourcemap,
    target: ['es2020', 'chrome100', 'firefox100', 'safari15', 'edge100'],
    define,
    logLevel: 'warning',
    legalComments: 'none',
  };

  const jsResult = await esbuild.build({
    ...common,
    entryPoints: [path.join(SRC, 'client', 'main.js')],
    outdir: assetsDir,
    entryNames: '[name].[hash]',
    format: 'esm',
    metafile: true,
  });

  const cssResult = await esbuild.build({
    ...common,
    entryPoints: [path.join(SRC, 'styles', 'main.css')],
    outdir: assetsDir,
    entryNames: '[name].[hash]',
    metafile: true,
  });

  const pick = (result, ext) => {
    const key = Object.keys(result.metafile.outputs).find((file) => file.endsWith(ext));
    if (!key) throw new Error(`No se generó ningún archivo ${ext}`);
    const absolute = path.resolve(ROOT, key);
    const sizes = result.metafile.outputs[key].bytes;
    return { url: `/${path.relative(outDir, absolute).split(path.sep).join('/')}`, sizes };
  };

  const js = pick(jsResult, '.js');
  const css = pick(cssResult, '.css');

  return {
    css: css.url,
    js: js.url,
    sizes: { [css.url]: css.sizes, [js.url]: js.sizes },
  };
}

/** Copia `public/` en la carpeta destino (la usan build y dev server). */
export async function copyPublic(outDir) {
  if (!existsSync(PUBLIC_DIR)) return;
  await cp(PUBLIC_DIR, outDir, { recursive: true });
}

/** Escribe todas las páginas + robots + sitemap. */
export async function buildPages(assets, outDir = DIST) {
  // Import dinámico: la configuración lee process.env al cargarse, por eso
  // primero hay que cargar `.env`.
  const { renderSite } = await import(pathToFileURL(path.join(SRC, 'render', 'index.js')).href);
  const site = renderSite({ assets });

  await mkdir(outDir, { recursive: true });
  await copyPublic(outDir);

  for (const page of site.pages) {
    await writeFile(path.join(outDir, page.path), page.html, 'utf8');
  }
  await writeFile(path.join(outDir, 'robots.txt'), site.robots, 'utf8');
  if (site.sitemap) await writeFile(path.join(outDir, 'sitemap.xml'), site.sitemap, 'utf8');

  return site;
}

/**
 * Genera el valor de la cabecera CSP a partir de los scripts inline reales
 * (JSON-LD). Así el sitio puede llevar una CSP sin 'unsafe-inline'.
 * @param {string[]} htmls
 * @param {{ crmEndpoint?: string|null, pixelId?: string|null }} [options]
 */
export function buildCsp(htmls, options = {}) {
  const hashes = new Set();
  const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  for (const html of htmls) {
    for (const match of html.matchAll(inlineScript)) {
      const digest = createHash('sha256').update(match[1], 'utf8').digest('base64');
      hashes.add(`'sha256-${digest}'`);
    }
  }

  /** @type {string[]} */
  const scriptSrc = ["'self'", ...hashes];
  /** @type {string[]} */
  const connectSrc = ["'self'"];
  /** @type {string[]} */
  const imgSrc = ["'self'", 'data:'];

  if (options.pixelId) {
    scriptSrc.push('https://connect.facebook.net');
    connectSrc.push('https://connect.facebook.net', 'https://www.facebook.com');
    imgSrc.push('https://www.facebook.com');
  }
  if (options.crmEndpoint) {
    try {
      connectSrc.push(new URL(options.crmEndpoint).origin);
    } catch {
      /* endpoint inválido: se ignora */
    }
  }

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    `style-src 'self'${options.pixelId ? " 'unsafe-inline'" : ''}`,
    `img-src ${imgSrc.join(' ')}`,
    `connect-src ${connectSrc.join(' ')}`,
    "font-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** @param {string[]} paths */
function pendingChecklist(view) {
  const pending = [];
  if (!view.whatsapp.enabled) pending.push('PHYTO_WHATSAPP_NUMBER (sin número los CTA de WhatsApp no se muestran)');
  if (view.whatsapp.looksLikePlaceholder) pending.push('PHYTO_WHATSAPP_NUMBER parece un número de EJEMPLO (reemplázalo por el real)');
  if (!view.seo.siteUrl) pending.push('SEO_SITE_URL (canonical + sitemap desactivados)');
  if (view.seo.looksLikePlaceholder) pending.push('SEO_SITE_URL parece un dominio de EJEMPLO (reemplázalo por el real)');
  if (!view.flags.variants) pending.push('productConfig.variants (sin frascos se muestra "Consultar precio")');
  if (view.flags.variants && view.pricing.variants.length < 7) {
    pending.push(`productConfig.variants: solo ${view.pricing.variants.length} frascos visibles`);
  }
  if (!view.product.shortDescription) pending.push('productConfig.shortDescription (hero sin bajada)');
  if (!view.product.description) pending.push('productConfig.description (sección producto con aviso)');
  if (!view.images.hero) pending.push('productConfig.images.hero (placeholder visible)');
  if (view.lists.features.length === 0) pending.push('contentConfig.features.items');
  if (view.lists.testimonials.length === 0) pending.push('contentConfig.testimonials.items');
  if (!view.site.commerce.deliveryMessage) pending.push('siteConfig.commerce.deliveryMessage');
  if (!view.site.privacy.company.legalName) pending.push('siteConfig.privacy.company (páginas legales con [PENDIENTE])');
  if (!view.product.regulatory) pending.push('productConfig.regulatory');
  if (!view.community.enabled) {
    // No es un dato pendiente: es una decisión de negocio (evita perder el número
    // del cliente). Solo se avisa si hay grupos configurados sin usar.
    if (view.site.community?.groups?.length > 0 && view.site.community?.enabled !== false) {
      pending.push('siteConfig.community.groups (sin grupo disponible se oculta la sección de comunidad)');
    }
  }
  return pending;
}

async function main() {
  const started = Date.now();
  // Build publicable: NO se leen los overrides locales (.env.local).
  await loadEnv();
  if (existsSync(path.join(ROOT, '.env.local'))) {
    console.log('ℹ️  .env.local existe pero NO se aplica al build de producción (solo afecta a `npm run dev`).');
  }

  await rm(DIST, { recursive: true, force: true });
  const assets = await buildAssets({ minify: true, sourcemap: false });
  const site = await buildPages(assets);

  await copyPublic(DIST);

  // Cabecera CSP lista para usar (hashes reales de los scripts inline).
  const csp = buildCsp(site.pages.map((page) => page.html), {
    crmEndpoint: site.view.site.crm.endpoint,
    pixelId: site.view.site.tracking.metaPixelId,
  });
  await writeFile(
    path.join(DIST, 'csp-header.txt'),
    [
      '# Cabecera recomendada (nginx):',
      '#   add_header Content-Security-Policy "<valor de abajo>" always;',
      '# Se regenera en cada build; se calcula con los hashes reales de los',
      '# scripts inline (JSON-LD), así no hace falta usar \'unsafe-inline\'.',
      '',
      csp,
      '',
    ].join('\n'),
    'utf8',
  );

  const files = await listFiles(DIST);
  let total = 0;
  for (const file of files) total += (await stat(file)).size;

  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
  const pending = pendingChecklist(site.view);

  console.log(`\n✅ Build completado en ${Date.now() - started} ms`);
  console.log(`   dist/ → ${files.length} archivos, ${kb(total)} en total`);
  console.log(`   JS  ${assets.js} (${kb(assets.sizes[assets.js])})`);
  console.log(`   CSS ${assets.css} (${kb(assets.sizes[assets.css])})`);
  console.log('   Páginas: ' + site.pages.map((page) => page.path).join(', '));
  console.log(`   WhatsApp: ${site.view.whatsapp.enabled ? 'configurado' : 'NO configurado'}`);
  console.log(
    `   Precios: ${site.view.pricing.variants.length} frascos · desde ${site.view.pricing.fromLabel ?? '—'}`,
  );
  console.log(`   Comunidad: ${site.view.site.community?.enabled === false ? 'no publicada (decisión de negocio)' : site.view.community.active?.id ?? 'sin grupo disponible'}`);
  if (site.view.trust?.claim) console.log(`   Confianza: "${site.view.trust.claim}"`);
  console.log(`   Pixel: ${site.view.site.tracking.metaPixelId ? 'sí' : 'no'} | CRM: ${site.view.site.crm.endpoint ? 'sí' : 'no (cola local)'}`);
  console.log('   CSP: dist/csp-header.txt');

  if (pending.length > 0) {
    console.log(`\n⚠️  Información pendiente (${pending.length}):`);
    for (const item of pending) console.log(`   - ${item}`);
    console.log('   Detalle: `npm run check:content` y docs/PENDIENTE.md\n');
  } else {
    console.log('\n🎉 No queda información pendiente marcada.\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('❌ Error en el build:', error);
    process.exit(1);
  });
}
