/**
 * DESCARGA REAL DE ICONOS · Material Symbols Rounded vía Iconify API
 *
 * Fuente oficial: https://api.iconify.design (documentada en iconify.design/docs/api)
 * Colección:      material-symbols (Google Material Symbols, Apache-2.0)
 *
 * No dibuja nada: guarda exactamente el SVG que devuelve la API y valida
 * respuesta HTTP, tipo MIME, XML, viewBox y huella SHA-256.
 *
 * Uso: node scripts/fetch-material-symbols.mjs
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'store', 'assets', 'icons', 'material-symbols');
const API = 'https://api.iconify.design/material-symbols';

/** 12 conceptos del storefront. `filled` puede faltar si la colección no lo tiene. */
export const CONCEPTS = [
  { key: 'home', outline: 'home-outline-rounded', filled: 'home-rounded' },
  { key: 'categories', outline: 'grid-view-outline', filled: 'grid-view-rounded' },
  { key: 'search', outline: 'search-rounded', filled: null },
  { key: 'cart', outline: 'shopping-cart-outline-rounded', filled: 'shopping-cart-rounded' },
  { key: 'account', outline: 'person-outline-rounded', filled: 'person-rounded' },
  { key: 'menu', outline: 'menu-rounded', filled: null },
  { key: 'notification', outline: 'notifications-outline-rounded', filled: 'notifications-rounded' },
  { key: 'heart', outline: 'favorite-outline-rounded', filled: 'favorite-rounded' },
  { key: 'truck', outline: 'local-shipping-outline-rounded', filled: 'local-shipping-rounded' },
  { key: 'security', outline: 'security-outline-rounded', filled: 'security-rounded' },
  { key: 'package', outline: 'inventory-2-outline-rounded', filled: 'inventory-2-rounded' },
  { key: 'settings', outline: 'settings-outline-rounded', filled: 'settings-rounded' },
  { key: 'arrow-right', outline: 'arrow-forward-rounded', filled: null },
  { key: 'chevron-right', outline: 'chevron-right-rounded', filled: null },
];

/* `--only=arrow-right,chevron-right` descarga solo lo que falte, sin tocar el resto. */
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1]?.split(',').filter(Boolean) ?? null;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function validate(name, svg) {
  const problems = [];
  if (!/^<\?xml|^<svg/.test(svg.trim())) problems.push('no empieza por <svg');
  if (!/<svg[^>]*viewBox="0 0 24 24"/.test(svg)) problems.push('viewBox distinto de 0 0 24 24');
  if (!/currentColor/.test(svg)) problems.push('no usa currentColor');
  if ((svg.match(/<svg/g) || []).length !== 1) problems.push('más de un <svg>');
  if (!/<(path|circle|rect|g)\b/.test(svg)) problems.push('sin geometría');
  if (problems.length) throw new Error(`SVG inválido ${name}: ${problems.join(' | ')}`);
  return true;
}

async function download(name) {
  const url = `${API}/${name}.svg`;
  const res = await fetch(url, { headers: { accept: 'image/svg+xml' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  const type = res.headers.get('content-type') || '';
  if (!type.includes('svg')) throw new Error(`Content-Type inesperado (${type}) en ${url}`);
  const svg = (await res.text()).trim();
  validate(name, svg);
  return { url, svg, type, bytes: Buffer.byteLength(svg, 'utf8'), sha256: sha256(svg) };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const previous = (() => {
    try {
      return JSON.parse(readFileSync(path.join(OUT_DIR, 'manifest.json'), 'utf8'));
    } catch {
      return null;
    }
  })();
  const manifest = {
    collection: 'material-symbols',
    provider: 'Iconify API',
    apiDocs: 'https://iconify.design/docs/api/',
    upstream: 'Google Material Symbols (Rounded)',
    upstreamDocs: 'https://fonts.google.com/icons',
    license: 'Apache-2.0',
    licenseUrl: 'https://github.com/google/material-design-icons/blob/master/LICENSE',
    downloadedAt: new Date().toISOString(),
    grid: { viewBox: '0 0 24 24', color: 'currentColor' },
    icons: ONLY && previous ? previous.icons.filter((i) => !ONLY.includes(i.concept)) : [],
    missingVariants: ONLY && previous ? (previous.missingVariants ?? []).filter((m) => !ONLY.includes(m.concept)) : [],
    failures: [],
  };

  const concepts = ONLY ? CONCEPTS.filter((c) => ONLY.includes(c.key)) : CONCEPTS;
  if (!concepts.length) throw new Error(`--only no coincide con ningún concepto: ${ONLY}`);

  for (const concept of concepts) {
    for (const variant of ['outline', 'filled']) {
      const name = concept[variant];
      if (!name) {
        (manifest.missingVariants ??= []).push({ concept: concept.key, variant, reason: 'la colección no publica esta variante' });
        continue;
      }
      try {
        const file = `${name}.svg`;
        const data = await download(name);
        writeFileSync(path.join(OUT_DIR, file), `${data.svg}\n`, 'utf8');
        manifest.icons.push({
          concept: concept.key,
          variant,
          name,
          file: `material-symbols/${file}`,
          url: data.url,
          contentType: data.type,
          bytes: data.bytes,
          sha256: data.sha256,
          license: 'Apache-2.0',
        });
        console.log(`✓ ${concept.key.padEnd(13)} ${variant.padEnd(7)} ${name.padEnd(32)} ${String(data.bytes).padStart(5)} B  ${data.sha256.slice(0, 12)}`);
      } catch (error) {
        manifest.failures.push({ concept: concept.key, variant, name, reason: error.message });
        console.error(`✗ ${concept.key} ${variant} ${name}: ${error.message}`);
      }
    }
  }

  writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`\ndescargados: ${manifest.icons.length} · fallos: ${manifest.failures.length}`);
  if (manifest.failures.length) process.exitCode = 1;
}

await main();


