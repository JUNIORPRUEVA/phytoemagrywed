/**
 * `npm run check` — revisión previa a publicar (no modifica nada).
 *
 * Comprueba, en este orden:
 *   1. AFIRMACIONES PROHIBIDAS en la configuración (bloquea la publicación).
 *   2. COHERENCIA DE LOS FRASCOS (precios, duplicados, frasco completo).
 *   3. COMUNIDAD: si está activada y qué grupo se publicará realmente.
 *   4. INFORMACIÓN PENDIENTE (campos vacíos y su efecto en la web).
 *   5. VALORES DE EJEMPLO que no deben publicarse.
 *
 * Sale con código 1 si hay afirmaciones prohibidas o datos incoherentes.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, ROOT } from './build.mjs';
import { isPlaceholderPhone, isPlaceholderUrl } from '../src/lib/config-helpers.js';
import { auditConfigs } from '../src/lib/content-safety.js';
import { buildGroups, groupSummary, resolveGroup } from '../src/lib/community.js';
import { normalizeBase } from '../src/render/media.js';
import { buildVariants, validateVariants } from '../src/lib/variants.js';

// Vista de PRODUCCIÓN: `.env.local` no cuenta (no entra en el build publicable).
await loadEnv();

const configUrl = (file) => pathToFileURL(path.join(ROOT, 'src', 'config', file)).href;
const { siteConfig } = await import(configUrl('site.config.js'));
const { productConfig } = await import(configUrl('product.config.js'));
const { contentConfig } = await import(configUrl('content.config.js'));

const pad = (text, size) => String(text).padEnd(size, ' ');
const { currency, locale } = siteConfig.commerce;

// ---------------------------------------------------------------------------
// 1) Afirmaciones prohibidas
// ---------------------------------------------------------------------------
const claimViolations = auditConfigs({ site: siteConfig, product: productConfig, content: contentConfig });

// ---------------------------------------------------------------------------
// 2) Frascos
// ---------------------------------------------------------------------------
const variants = buildVariants(productConfig, { currency, locale, dedupe: false });
const variantProblems = validateVariants(variants);
const usableVariants = variants.filter((variant) => variant.available);

// ---------------------------------------------------------------------------
// 3) Comunidad
// ---------------------------------------------------------------------------
const groups = buildGroups(siteConfig.community.groups);
const communityInfo = groupSummary(groups);
const activeGroup = resolveGroup(groups);

// ---------------------------------------------------------------------------
// 3-bis) Fotos de los frascos (tarjetas del carrusel)
//
// Cada tarjeta pide SU frasco y muestra SU foto: si falta un archivo generado,
// la tarjeta queda rota en producción. Se revisa antes de publicar.
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(ROOT, 'public');
const photoProblems = [];
let photoBytes = 0;

for (const variant of usableVariants) {
  const base = normalizeBase(variant.image);
  if (!base) {
    photoProblems.push(`${variant.name}: sin foto configurada (product.config.js → variants[].image)`);
    continue;
  }
  const widths = productConfig.images?.variantWidths ?? [];
  const files = [
    ...widths.flatMap((width) => [`${base}-${width}.avif`, `${base}-${width}.webp`]),
    `${base}-${Math.max(...(widths.length > 0 ? widths : [0]))}.jpg`,
  ];
  for (const relative of files) {
    const file = path.join(PUBLIC_DIR, relative);
    if (!existsSync(file)) {
      photoProblems.push(`${variant.name}: falta ${relative} (genera con: npm run images:frascos)`);
    } else {
      photoBytes += statSync(file).size;
    }
  }
}

// ---------------------------------------------------------------------------
// 4) Información pendiente
// ---------------------------------------------------------------------------
const set = (value) =>
  value !== null &&
  value !== undefined &&
  !(typeof value === 'string' && value.trim() === '') &&
  !(Array.isArray(value) && value.length === 0);

/** @type {{ label: string, value: any, file: string, field: string, impact: string }[]} */
const checklist = [
  { label: 'Nombre del producto', value: productConfig.name, file: 'product.config.js', field: 'name', impact: 'Título y hero' },
  { label: 'Descripción corta (hero)', value: productConfig.shortDescription, file: 'product.config.js', field: 'shortDescription', impact: 'Hero sin bajada' },
  { label: 'Descripción larga', value: productConfig.description, file: 'product.config.js', field: 'description', impact: 'Sección "¿Qué es?" con aviso de pendiente' },
  { label: 'Portada principal (panorámica)', value: productConfig.images.hero, file: 'product.config.js', field: 'images.hero', impact: 'Marcador de imagen pendiente' },
  { label: 'Modo de uso', value: productConfig.usage, file: 'product.config.js', field: 'usage', impact: 'Ficha técnica' },
  { label: 'Ingredientes', value: productConfig.ingredients, file: 'product.config.js', field: 'ingredients', impact: 'Ficha técnica' },
  { label: 'Registro sanitario', value: productConfig.regulatory, file: 'product.config.js', field: 'regulatory', impact: 'Ficha + términos' },
  { label: 'Fabricante', value: productConfig.manufacturer, file: 'product.config.js', field: 'manufacturer', impact: 'Ficha técnica' },
  { label: 'Aviso al consumidor', value: productConfig.disclaimer, file: 'product.config.js', field: 'disclaimer', impact: 'CTA final' },
  { label: 'WhatsApp', value: siteConfig.contact.whatsapp.number, file: '.env', field: 'PHYTO_WHATSAPP_NUMBER', impact: 'Se ocultan TODOS los CTA de WhatsApp' },
  { label: 'URL del sitio', value: siteConfig.seo.siteUrl, file: '.env', field: 'SEO_SITE_URL', impact: 'Sin canonical, sin sitemap y SIN imagen al compartir el enlace (WhatsApp/Facebook/ads)' },
  { label: 'Título SEO', value: siteConfig.seo.title, file: 'site.config.js', field: 'seo.title', impact: 'Meta title' },
  { label: 'Meta description', value: siteConfig.seo.description, file: 'site.config.js', field: 'seo.description', impact: 'SEO' },
  { label: 'Email de contacto', value: siteConfig.contact.email, file: '.env', field: 'CONTACT_EMAIL', impact: 'No aparece en footer ni legal' },
  { label: 'Mensaje de entrega', value: siteConfig.commerce.deliveryMessage, file: 'site.config.js', field: 'commerce.deliveryMessage', impact: 'Se explica por WhatsApp' },
  { label: 'Zonas de entrega', value: siteConfig.commerce.deliveryAreas, file: 'site.config.js', field: 'commerce.deliveryAreas', impact: 'El visitante no sabe si le llega: tiene que preguntarlo' },
  { label: 'Entrega en punto de venta', value: siteConfig.commerce.pickupAvailable, file: 'site.config.js', field: 'commerce.pickupAvailable', impact: 'Sin confirmar' },
  { label: 'Envíos', value: siteConfig.commerce.shippingAvailable, file: 'site.config.js', field: 'commerce.shippingAvailable', impact: 'Sin confirmar' },
  { label: 'Métodos de pago', value: siteConfig.commerce.paymentMethods, file: 'site.config.js', field: 'commerce.paymentMethods', impact: 'El visitante no sabe cómo se paga: se lo tiene que preguntar (frena a quien no conoce el negocio)' },
  { label: 'Razón social (legal)', value: siteConfig.privacy.company.legalName, file: 'site.config.js', field: 'privacy.company.legalName', impact: 'Páginas legales con [PENDIENTE]' },
  { label: 'Identificación tributaria', value: siteConfig.privacy.company.taxId, file: 'site.config.js', field: 'privacy.company.taxId', impact: 'Legal' },
  { label: 'Domicilio', value: siteConfig.privacy.company.address, file: 'site.config.js', field: 'privacy.company.address', impact: 'Legal' },
  { label: 'País', value: siteConfig.privacy.company.country, file: 'site.config.js', field: 'privacy.company.country', impact: 'Legal' },
  { label: 'Plazo de conservación de datos', value: siteConfig.privacy.retentionDays, file: 'site.config.js', field: 'privacy.retentionDays', impact: 'Política de privacidad' },
  { label: 'Características', value: contentConfig.features.items, file: 'content.config.js', field: 'features.items', impact: 'Sección oculta' },
  { label: 'Testimonios aprobados', value: contentConfig.testimonials.items, file: 'content.config.js', field: 'testimonials.items', impact: 'Sin opiniones reales: es la prueba que más convence y no se puede inventar' },
  { label: 'Aviso de testimonios', value: contentConfig.testimonials.disclaimer, file: 'content.config.js', field: 'testimonials.disclaimer', impact: 'Obligatorio si hay testimonios' },
  { label: 'Texto del footer', value: contentConfig.footer.about, file: 'content.config.js', field: 'footer.about', impact: 'Footer sin descripción' },
  { label: 'Endpoint del CRM', value: siteConfig.crm.endpoint, file: '.env', field: 'PHYTO_CRM_ENDPOINT', impact: 'Los pedidos NO llegan a la base de datos: el panel sale vacío' },
  { label: 'Meta Pixel', value: siteConfig.tracking.metaPixelId, file: '.env', field: 'PHYTO_META_PIXEL_ID', impact: 'Sin medición publicitaria (opcional)' },
];

const missing = checklist.filter((item) => !set(item.value));
const ready = checklist.filter((item) => set(item.value));

/** @type {{ label: string, value: any, file: string, field: string }[]} */
const suspicious = [];
if (set(siteConfig.contact.whatsapp.number) && isPlaceholderPhone(siteConfig.contact.whatsapp.number)) {
  suspicious.push({ label: 'Número de WhatsApp', value: siteConfig.contact.whatsapp.number, file: '.env', field: 'PHYTO_WHATSAPP_NUMBER' });
}
if (set(siteConfig.seo.siteUrl) && isPlaceholderUrl(siteConfig.seo.siteUrl)) {
  suspicious.push({ label: 'URL del sitio', value: siteConfig.seo.siteUrl, file: '.env', field: 'SEO_SITE_URL' });
}

// ---------------------------------------------------------------------------
// 5-bis) Número de atención: los pedidos tienen que caer donde dice la web
//
// El número que se enseña al visitante (`displayNumber`) debe tener los MISMOS
// dígitos que el que recibe los pedidos (`PHYTO_WHATSAPP_NUMBER`). Si no, la web
// publicaría un teléfono que no atiende: es el error más caro posible aquí.
// ---------------------------------------------------------------------------
const waDigits = String(siteConfig.contact.whatsapp.number ?? '').replace(/\D/g, '');
const displayDigits = String(siteConfig.contact.whatsapp.displayNumber ?? '').replace(/\D/g, '');
const phoneProblems = [];
if (displayDigits && waDigits && displayDigits !== waDigits) {
  phoneProblems.push(
    `site.config.js → contact.whatsapp.displayNumber ("${siteConfig.contact.whatsapp.displayNumber}") no coincide con PHYTO_WHATSAPP_NUMBER (${waDigits})`,
  );
}

// ---------------------------------------------------------------------------
// Informe
// ---------------------------------------------------------------------------
console.log('\n🔎 REVISIÓN PREVIA A PUBLICAR — Phytoemagry\n');

console.log('  AFIRMACIONES PROHIBIDAS');
if (claimViolations.length === 0) {
  console.log('   ✔ ninguna detectada');
} else {
  for (const item of claimViolations) {
    console.log(`   ✗ [${item.id}] ${item.label} → ${item.path}`);
    console.log(`     "${item.excerpt}"`);
  }
}

console.log(`\n  FRASCOS (${usableVariants.length} visibles de ${variants.length})`);for (const variant of variants) {
  const flag = variant.available ? '✔' : '✗';
  const extra = variant.completeBottle ? ' · frasco completo' : '';
  console.log(`   ${flag} ${pad(variant.name, 14)} ${pad(variant.priceLabel ?? 'sin precio', 12)}${extra}`);
}
if (variantProblems.length > 0) {
  for (const problem of variantProblems) console.log(`   ✗ ${problem}`);
} else {
  console.log('   ✔ precios y cápsulas coherentes');
}

console.log('\n  WHATSAPP (atención y pedidos)');
if (!waDigits) {
  console.log('   ✗ sin número: TODOS los CTA de WhatsApp quedan ocultos');
  console.log('     efecto: no se puede pedir ni consultar por WhatsApp');
} else if (phoneProblems.length > 0) {
  for (const problem of phoneProblems) console.log(`   ✗ ${problem}`);
} else {
  console.log(`   ✔ todos los pedidos y consultas llegan a https://wa.me/${waDigits}`);
  console.log(
    siteConfig.contact.whatsapp.displayNumber
      ? `     el visitante ve el número: ${siteConfig.contact.whatsapp.displayNumber}`
      : '     el visitante solo ve el botón "WhatsApp" (sin número a la vista)',
  );
  const paths = ['hero', 'cada frasco', 'resumen', 'final', 'barra móvil', 'footer', 'sección de contacto'];
  console.log(`     caminos de contacto: ${paths.join(', ')}`);
}

console.log('\n  FOTOS DE LOS FRASCOS (carrusel)');
if (photoProblems.length === 0) {
  console.log(`   ✔ ${usableVariants.length} frascos con sus archivos AVIF/WebP/JPG (${Math.round(photoBytes / 1024)} kB en total)`);
  console.log(
    `     cada tarjeta carga solo el ancho que necesita (${(productConfig.images?.variantWidths ?? []).map((w) => `${w} px`).join(' o ')})`,
  );
} else {
  for (const problem of photoProblems) console.log(`   ✗ ${problem}`);
}

console.log('\n  COMUNIDAD');
const communityEnabled = siteConfig.community.enabled !== false;
console.log(`   grupos configurados: ${communityInfo.total} · activos: ${communityInfo.active} · disponibles: ${communityInfo.available}`);
if (!communityEnabled) {
  console.log('   ⚠️ DESACTIVADA en configuración (community.enabled: false)');
  console.log('      La web NO muestra la sección de comunidad, ni el enlace de compra,');
  console.log('      ni la pregunta de la FAQ, ni el acceso del menú.');
  console.log('      Motivo: la atención va al WhatsApp 1:1 y así se captura el número.');
  console.log('      Para volver a publicarla: community.enabled = true');
} else if (activeGroup) {
  console.log(`   ✔ se publicará: ${activeGroup.id} (${activeGroup.name})`);
  console.log(`     ${activeGroup.url}`);
  if (communityInfo.available > 1) {
    console.log('     (los demás quedan como reserva por si este se llena)');
  }
} else {
  console.log('   ✗ NINGÚN grupo disponible: el CTA de comunidad quedará OCULTO');
}

console.log('\n  CONFIANZA (claim aprobado)');
if (siteConfig.trust?.claimVerified === true && siteConfig.trust?.claim) {
  console.log(`   ✔ se publica en la información del producto: "${siteConfig.trust.claim}"`);
  console.log('     (solo desde site.config.js → trust.claim; en cualquier otro campo se bloquea)');
} else {
  console.log('   · sin afirmación publicada (trust.claimVerified no es true)');
}

console.log(`\n  DEFINIDO (${ready.length}/${checklist.length})`);
for (const item of ready) console.log(`   ✔ ${pad(item.label, 34)} ${item.file} → ${item.field}`);

console.log(`\n  PENDIENTE (${missing.length})`);
if (missing.length === 0) {
  console.log('   — nada pendiente —');
} else {
  for (const item of missing) {
    console.log(`   ✗ ${pad(item.label, 34)} ${item.file} → ${item.field}`);
    console.log(`     ${pad('', 3)}efecto: ${item.impact}`);
  }
}

if (suspicious.length > 0) {
  console.log(`\n  ⚠️  VALORES DE EJEMPLO (existen pero NO son reales) (${suspicious.length})`);
  for (const item of suspicious) {
    console.log(`   ! ${pad(item.label, 34)} ${item.file} → ${item.field} = "${item.value}"`);
  }
  console.log('     Reemplázalos antes de publicar la web.');
}

const blocking = claimViolations.length > 0 || variantProblems.length > 0 || photoProblems.length > 0 || phoneProblems.length > 0;
console.log(
  blocking
    ? '\n❌ Hay problemas que impiden publicar (afirmaciones prohibidas, frascos incoherentes, fotos que faltan o número de atención incoherente).\n'
    : '\n✅ Sin afirmaciones prohibidas ni incoherencias de precios.\n  Recuerda: la web nunca muestra información que no esté configurada.\n',
);

process.exitCode = blocking ? 1 : 0;
