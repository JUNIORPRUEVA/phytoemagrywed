/**
 * GENERADOR DEL SISTEMA DE ICONOS DEL STOREFRONT
 *
 * Fuente: `lucide-static` instalado como devDependency (licencia ISC).
 * Salida:
 *   · public/store/icons.js          → registro único que usa la PWA
 *   · public/store/icons/<name>.svg   → SVG sueltos reutilizables (Futuro Flutter)
 *   · public/store/icons/manifest.json→ nombres, grupo, fuente, versión y licencia
 *
 * Uso:  node scripts/build-store-icons.mjs
 *       npm run icons:store
 *
 * No hay dependencia en tiempo de ejecución: el SVG queda inline en el registro.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LUCIDE_DIR = path.join(ROOT, 'node_modules', 'lucide-static');
const OUT_JS = path.join(ROOT, 'public', 'store', 'icons.js');
const OUT_SVG_DIR = path.join(ROOT, 'public', 'store', 'icons');
const OUT_MANIFEST = path.join(OUT_SVG_DIR, 'manifest.json');
/* Material Symbols Rounded ya descargados con scripts/fetch-material-symbols.mjs */
const MSR_DIR = path.join(ROOT, 'public', 'store', 'assets', 'icons', 'material-symbols');
const MSR_MANIFEST = path.join(MSR_DIR, 'manifest.json');

/**
 * Familia PRINCIPAL de la interfaz: Material Symbols Rounded (Apache-2.0).
 * Se lee del manifiesto ya descargado; nunca se llama a la API en tiempo de uso.
 */
function readMaterialSymbols() {
  if (!existsSync(MSR_MANIFEST)) return null;
  const manifest = JSON.parse(readFileSync(MSR_MANIFEST, 'utf8'));
  const byConcept = new Map();
  for (const icon of manifest.icons) {
    const file = path.join(MSR_DIR, `${icon.name}.svg`);
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, 'utf8');
    const inner = raw.replace(/<!--[\s\S]*?-->/g, '').match(/<svg[^>]*>([\s\S]*)<\/svg>/);
    if (!inner) continue;
    const body = inner[1].replace(/\s+/g, ' ').trim();
    const entry = byConcept.get(icon.concept) ?? {};
    entry[icon.variant] = body;
    byConcept.set(icon.concept, entry);
  }
  return { manifest, byConcept };
}


/**
 * CONJUNTO CURADO. Solo lo que la tienda usa de verdad: navegación, categorías,
 * compra, cuenta y entrega. `nombre en la app` → `archivo de Lucide`.
 * Añadir un icono aquí es lo único necesario; el generador hace el resto.
 */
const REGISTRY = {
  navegacion: {
    home: 'house',
    categories: 'layout-grid',
    search: 'search',
    menu: 'menu',
  },
  compra: {
    cart: 'shopping-cart',
    heart: 'heart',
    plus: 'plus',
    minus: 'minus',
    close: 'x',
    'arrow-right': 'arrow-right',
    'chevron-right': 'chevron-right',
  },
  cuenta: {
    user: 'user',
    bell: 'bell',
    orders: 'clipboard-list',
    support: 'headset',
    settings: 'settings',
  },
  entrega: {
    truck: 'truck',
    'map-pin': 'map-pin',
    package: 'package',
  },
  garantia: {
    'shield-check': 'shield-check',
  },
  categorias: {
    laptop: 'laptop',
    router: 'router',
    headphones: 'headphones',
    camera: 'camera',
  },
};

const readLucideVersion = () => {
  const pkg = JSON.parse(readFileSync(path.join(LUCIDE_DIR, 'package.json'), 'utf8'));
  return { name: pkg.name, version: pkg.version, license: pkg.license };
};

/** Extrae el contenido interno del SVG de Lucide y limpia lo que no hace falta. */
function innerOf(lucideName) {
  const file = path.join(LUCIDE_DIR, 'icons', `${lucideName}.svg`);
  if (!existsSync(file)) throw new Error(`Lucide no tiene el icono "${lucideName}"`);
  const raw = readFileSync(file, 'utf8');
  const inner = raw.replace(/<!--[\s\S]*?-->/g, '').match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  if (!inner) throw new Error(`SVG inválido: ${lucideName}`);
  return inner[1]
    .replace(/\sclass="[^"]*"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .replace(/\s*\/>/g, '/>')
    .trim();
}

const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function build() {
  const source = readLucideVersion();
  const groups = {};
  const flat = [];

  for (const [group, entries] of Object.entries(REGISTRY)) {
    groups[group] = Object.keys(entries);
    for (const [name, lucideName] of Object.entries(entries)) {
      flat.push({ name, group, lucide: lucideName, body: innerOf(lucideName) });
    }
  }

  const names = flat.map((i) => i.name);
  const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
  if (duplicates.length) throw new Error(`Nombres duplicados: ${duplicates.join(', ')}`);

  // 1) SVG sueltos (reutilizables fuera de la web, p. ej. Flutter)
  rmSync(OUT_SVG_DIR, { recursive: true, force: true });
  mkdirSync(OUT_SVG_DIR, { recursive: true });
  for (const item of flat) {
    const svg = `<!-- FULLTECH Store · icono "${item.name}" · lucide ${source.version} · ${source.license} -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${item.body}</svg>\n`;
    writeFileSync(path.join(OUT_SVG_DIR, `${item.name}.svg`), svg, 'utf8');
  }

  // 2) Registro que consume la PWA
  const paths = flat.map((i) => `  '${i.name}': '${i.body}',`).join('\n');
  const groupLines = Object.entries(groups)
    .map(([group, list]) => `  ${group}: [${list.map((n) => `'${n}'`).join(', ')}],`)
    .join('\n');
  const lucideLines = flat.map((i) => `  '${i.name}': '${i.lucide}',`).join('\n');

  const js = `/**
 * SISTEMA DE ICONOS DE FULLTECH STORE — ARCHIVO GENERADO
 *
 * No lo edites a mano: se reescribe con \`npm run icons:store\`.
 * Generador: scripts/build-store-icons.mjs
 * Fuente:    ${source.name} v${source.version} · licencia ${source.license}
 * Iconos:    ${flat.length} (solo los que la tienda usa)
 *
 * Reglas: viewBox 24×24, trazo 1.75, \`currentColor\`, sin dependencias en runtime.
 */
export const ICON_SOURCE = Object.freeze({
  library: '${source.name}',
  version: '${source.version}',
  license: '${source.license}',
  licenseUrl: 'https://github.com/lucide-icons/lucide/blob/main/LICENSE',
  generator: 'scripts/build-store-icons.mjs',
});

export const ICON_GROUPS = Object.freeze({
${groupLines}
});

/** Nombre en la app → nombre original en Lucide (para auditar o actualizar). */
export const ICON_LUCIDE_NAMES = Object.freeze({
${lucideLines}
});

const PATHS = {
${paths}
};

export const ICON_NAMES = Object.freeze(Object.keys(PATHS));

/** Lista los iconos de un grupo (o todos si se omite). */
export function iconNames(group) {
  if (!group) return [...ICON_NAMES];
  return [...(ICON_GROUPS[group] ?? [])];
}

/**
 * Dibuja un icono inline.
 * @param {string} name clave del registro
 * @param {string} [extraClass]
 * @param {{size?: number, strokeWidth?: number, label?: string}} [options]
 */
export function icon(name, extraClass = '', options = {}) {
  const body = PATHS[name] ?? PATHS.package;
  const size = options.size ?? 24;
  const stroke = options.strokeWidth ?? 1.75;
  const label = options.label
    ? \`role="img" aria-label="\${escapeAttr(options.label)}"\`
    : 'aria-hidden="true"';
  return \`<svg class="ft-icon \${extraClass}" viewBox="0 0 24 24" width="\${size}" height="\${size}" fill="none" stroke="currentColor" stroke-width="\${stroke}" stroke-linecap="round" stroke-linejoin="round" \${label}>\${body}</svg>\`;
}

/** Icono representativo de una categoría real del catálogo. */
export function categoryIcon(name) {
  const key = String(name ?? '').toLowerCase();
  if (/pc|comput|laptop|portátil|portatil/.test(key)) return 'laptop';
  if (/red|router|wifi|network/.test(key)) return 'router';
  if (/audio|sonido|parlante|bocina/.test(key)) return 'headphones';
  if (/segur|cámara|camara|cctv/.test(key)) return 'shield-check';
  if (/hogar|casa/.test(key)) return 'home';
  if (/cámara|camara|foto/.test(key)) return 'camera';
  if (/accesorio/.test(key)) return 'package';
  return 'categories';
}

/**
 * Rellena en el HTML los SVG marcados con \`data-icon\`.
 * Permite que la cabecera y la barra inferior compartan el mismo registro
 * sin repetir trazados en el HTML.
 */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((node) => {
    const name = node.getAttribute('data-icon');
    const size = Number(node.getAttribute('data-icon-size')) || 24;
    const stroke = Number(node.getAttribute('data-icon-stroke')) || 1.75;
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('width', String(size));
    node.setAttribute('height', String(size));
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', String(stroke));
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.innerHTML = PATHS[name] ?? PATHS.package;
  });
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
`;

  /* ---------------------------------------------------------------------------
   * FAMILIA PRINCIPAL: Material Symbols Rounded (descargada, Apache-2.0).
   * Se incrusta el trazado real; no hay peticiones de red en tiempo de uso.
   * ------------------------------------------------------------------------- */
  const msr = readMaterialSymbols();
  let msrBlock = '';
  if (msr) {
    const entries = [...msr.byConcept.entries()];
    const lines = entries.map(([concept, v]) => {
      const outline = v.outline ?? v.filled ?? '';
      const filled = v.filled ?? v.outline ?? '';
      return `  '${concept}': {\n    outline: '${outline}',\n    filled: '${filled}',\n  },`;
    });
    msrBlock = `
/* ------------------------------------------------------------------ Material */
export const MSR_SOURCE = Object.freeze({
  library: 'material-symbols',
  provider: 'Iconify API',
  license: '${msr.manifest.license}',
  version: '${String(msr.manifest.downloadedAt).slice(0, 10)}',
  upstream: 'Google Material Symbols · Rounded',
});

const MSR_PATHS = {
${lines.join('\n')}
};

export const MSR_NAMES = Object.freeze(Object.keys(MSR_PATHS));

/** Alias semánticos usados por la app. */
const MSR_ALIAS = { user: 'account', bell: 'notification', orders: 'package', shield: 'security' };
const msrEntry = (name) => MSR_PATHS[MSR_ALIAS[name] ?? name] ?? MSR_PATHS.package;

/**
 * Icono Material Symbols Rounded.
 * @param {string} name clave semántica (home, categories, cart, user, …)
 * @param {{size?: number, variant?: 'outline'|'filled', className?: string, label?: string}} [options]
 */
export function materialIcon(name, options = {}) {
  const entry = msrEntry(name);
  const body = options.variant === 'filled' ? entry.filled : entry.outline;
  const size = options.size ?? 24;
  const className = options.className ? \`micon \${options.className}\` : 'micon';
  const label = options.label ? \`role="img" aria-label="\${escapeAttr(options.label)}"\` : 'aria-hidden="true"';
  return \`<svg class="\${className}" viewBox="0 0 24 24" width="\${size}" height="\${size}" fill="currentColor" \${label}>\${body}</svg>\`;
}

/** Rellena un <svg> existente con el trazado de Material Symbols. */
export function paintMaterialIcon(node, name, options = {}) {
  if (!node) return;
  const entry = msrEntry(name);
  const size = options.size ?? (Number(node.getAttribute('data-msr-size')) || 24);
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  node.setAttribute('fill', 'currentColor');
  node.setAttribute('aria-hidden', 'true');
  node.innerHTML = options.variant === 'filled' ? entry.filled : entry.outline;
}

/** Hidrata los <svg data-msr="…"> del HTML estático. */
export function hydrateMaterialIcons(root = document) {
  root.querySelectorAll('[data-msr]').forEach((node) => {
    paintMaterialIcon(node, node.getAttribute('data-msr'), {
      variant: node.getAttribute('data-msr-variant') || 'outline',
    });
  });
}

/** Categoría real del catálogo → icono Material Symbols compatible. */
export function materialCategoryIcon(name) {
  const key = String(name ?? '').toLowerCase();
  if (/pc|comput|laptop|portátil|portatil/.test(key)) return 'laptop';
  if (/red|router|wifi|network/.test(key)) return 'router';
  if (/audio|sonido|parlante|bocina/.test(key)) return 'headphones';
  if (/segur|cámara|camara|cctv/.test(key)) return 'security';
  if (/hogar|casa/.test(key)) return 'home';
  if (/cámara|camara|foto/.test(key)) return 'camera';
  if (/accesorio/.test(key)) return 'package';
  return 'categories';
}
`;
  }

  writeFileSync(OUT_JS, `${js}${msrBlock}`, 'utf8');

  // 3) Manifiesto (auditoría, futuras plataformas, Flutter)
  const manifest = {
    source,
    generator: 'scripts/build-store-icons.mjs',
    grid: { viewBox: '0 0 24 24', strokeWidth: 1.75, sizes: [20, 24], color: 'currentColor' },
    count: flat.length,
    groups,
    icons: flat.map((i) => ({ name: i.name, group: i.group, lucide: i.lucide, file: `${i.name}.svg` })),
  };
  writeFileSync(OUT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const bytes = flat.reduce((n, i) => n + Buffer.byteLength(i.body, 'utf8'), 0);
  const hash = createHash('sha256').update(JSON.stringify(flat.map((i) => i.body))).digest('hex').slice(0, 12);

  console.log(`iconos generados: ${flat.length}`);
  Object.entries(groups).forEach(([g, list]) => console.log(`  ${g.padEnd(12)} ${list.length}  ${list.join(' ')}`));
  console.log(`SVG en ${path.relative(ROOT, OUT_SVG_DIR)}: ${readdirSync(OUT_SVG_DIR).length} archivos`);
  console.log(`peso total de trazados: ${(bytes / 1024).toFixed(1)} KB · huella ${hash}`);
}

build();
