/**
 * Ensamblado de documentos HTML completos (build-time).
 *
 * Los tokens `__CSS__` y `__JS__` los sustituye `scripts/build.mjs` por las
 * rutas finales con hash de contenido (cache-busting). En tests/desarrollo se
 * usan las rutas sin hash por defecto.
 */

import { escapeHtml, join } from './html.js';
import { HERO_SIZES } from './media.js';
import { renderConsentBanner, renderCheckoutDialog, renderFooter, renderHeader, renderMobileBar, renderSkipLink } from './parts.js';
import {
  renderCommunity,
  renderFaq,
  renderFeatures,
  renderFinalCta,
  renderHero,
  renderHowToBuy,
  renderLeadForm,
  renderProductInfo,
  renderTestimonials,
  renderVariantSelector,
} from './sections.js';

export const DEFAULT_ASSETS = Object.freeze({ css: '/assets/main.css', js: '/assets/main.js' });

/**
 * @param {object} input
 * @param {ReturnType<import('./view.js').buildView>} input.view
 * @param {{ css: string, js: string }} [input.assets]
 * @param {string} input.title
 * @param {string|null} input.description
 * @param {string} input.canonicalPath
 * @param {string} input.body
 * @param {boolean} [input.noindex]
 */
function document({ view, assets = DEFAULT_ASSETS, title, description, canonicalPath, body, noindex = false }) {
  const { site } = view;
  const canonical = view.seo.canonicalFor(canonicalPath);
  const ogImage = view.seo.ogImageUrl;
  const robots = noindex || site.seo.noindex ? 'noindex, nofollow' : 'index, follow';

  const head = join(
    '<meta charset="utf-8">',
    // viewport-fit=cover activa env(safe-area-inset-*) en móviles con notch;
    // interactive-widget=resizes-content hace que el teclado reduzca el layout
    // (así el botón de "Continuar pedido" no queda tapado al escribir).
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">',
    `<title>${escapeHtml(title)}</title>`,
    description ? `<meta name="description" content="${escapeHtml(description)}">` : '',
    `<meta name="robots" content="${robots}">`,
    canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : '<!-- canonical: configura SEO_SITE_URL para activarlo -->',
    `<meta name="theme-color" content="${escapeHtml(site.brand.themeColor)}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${escapeHtml(site.brand.name)}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    description ? `<meta property="og:description" content="${escapeHtml(description)}">` : '',
    canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}">` : '',
    ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}">` : '',
    ogImage ? '<meta property="og:image:width" content="1200">' : '',
    ogImage ? '<meta property="og:image:height" content="630">' : '',
    `<meta property="og:locale" content="${escapeHtml(site.seo.locale === 'es' ? 'es_ES' : site.seo.locale)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    site.seo.twitterSite ? `<meta name="twitter:site" content="${escapeHtml(site.seo.twitterSite)}">` : '',
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    description ? `<meta name="twitter:description" content="${escapeHtml(description)}">` : '',
    ogImage ? `<meta name="twitter:image" content="${escapeHtml(ogImage)}">` : '',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="/assets/img/apple-touch-icon.png">',
    heroImagePreload(view),
    `<link rel="preload" as="style" href="${escapeHtml(assets.css)}">`,
    `<link rel="stylesheet" href="${escapeHtml(assets.css)}">`,
    `<script type="module" src="${escapeHtml(assets.js)}" defer></script>`,
    jsonLd(view),
  );

  return `<!DOCTYPE html>
<html lang="es">
<head>
${head
  .split('\n')
  .map((line) => (line.trim() ? `  ${line}` : ''))
  .join('\n')}
</head>
<body class="pe-body">
${renderSkipLink(view)}
${renderHeader(view)}
${body}
${renderFooter(view)}
${renderMobileBar(view)}
${renderCheckoutDialog(view)}
${renderConsentBanner(view)}
</body>
</html>`;
}

/**
 * Precarga de la portada.
 *
 * Es la imagen visible al cargar (candidata a LCP), así que se precarga el AVIF
 * —el primer `<source>` del `<picture>`— con su `imagesrcset`/`imagesizes`
 * idénticos a los del HTML. Los navegadores sin AVIF ignoran esta línea y usan
 * el WebP del propio `<picture>` (una sola descarga en cualquier caso).
 */
function heroImagePreload(view) {
  const hero = view.images?.hero;
  if (!hero) return '';
  return `<link rel="preload" as="image" type="image/avif" imagesrcset="${escapeHtml(hero.srcset('avif'))}" imagesizes="${escapeHtml(HERO_SIZES)}" fetchpriority="high">`;
}

/** Datos estructurados: solo lo que existe y es verificable. Nunca ratings. */
function jsonLd(view) {
  const { site, product, seo } = view;
  /** @type {Record<string, any>[]} */
  const graph = [];

  if (seo.siteUrl) {
    graph.push({
      '@type': 'WebSite',
      '@id': `${seo.siteUrl}/#website`,
      url: seo.siteUrl,
      name: site.brand.name,
      inLanguage: 'es',
    });
    if (site.privacy.company.legalName) {
      graph.push({
        '@type': 'Organization',
        '@id': `${seo.siteUrl}/#organization`,
        name: site.privacy.company.legalName,
        url: seo.siteUrl,
      });
    }
  }

  if (view.flags.variants) {
    const prices = view.pricing.variants.map((variant) => variant.price);
    graph.push({
      '@type': 'Product',
      name: product.name,
      description: product.shortDescription ?? product.description ?? undefined,
      image: view.images.hero ? `${seo.siteUrl ?? ''}${view.images.hero.fallback()}` : undefined,
      offers: {
        // Rango real de precios de las presentaciones disponibles.
        '@type': 'AggregateOffer',
        priceCurrency: site.commerce.currency,
        lowPrice: Math.min(...prices),
        highPrice: Math.max(...prices),
        offerCount: prices.length,
        availability:
          product.availability === 'out_of_stock'
            ? 'https://schema.org/OutOfStock'
            : product.availability === 'preorder'
              ? 'https://schema.org/PreOrder'
              : 'https://schema.org/InStock',
        ...(seo.siteUrl ? { url: seo.siteUrl } : {}),
      },
    });
  }

  if (graph.length === 0) return '';
  return `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c')}</script>`;
}

/** Página principal. */
export function renderIndexPage(view, options = {}) {
  const body = `<main id="contenido" class="pe-main">
${[
  // Recorrido comercial: producto → frascos y precios → cómo comprar → dudas →
  // comunidad (confianza para quien no está listo) → contacto y CTA final.
  renderHero(view),
  renderProductInfo(view),
  renderFeatures(view),
  renderVariantSelector(view),
  renderHowToBuy(view),
  renderFaq(view),
  renderCommunity(view),
  renderTestimonials(view),
  renderLeadForm(view),
  renderFinalCta(view),
]
  .filter(Boolean)
  .join('\n')}
</main>`;

  return document({
    view,
    assets: options.assets,
    title: view.site.seo.title,
    description: view.site.seo.description,
    canonicalPath: '/',
    body,
    noindex: options.noindex === true,
  });
}

/** Marcador de dato pendiente (visible a propósito en páginas legales). */
function pending(view, label = 'Dato pendiente') {
  return `<mark class="pe-pending" title="${escapeHtml(label)}">${escapeHtml(view.content.legal.pendingLabel)}</mark>`;
}

function legalBody(view, kind) {
  const { content, site, product } = view;
  const company = site.privacy.company;
  const isPrivacy = kind === 'privacy';
  const intro = isPrivacy ? content.legal.privacyIntro : content.legal.termsIntro;
  const thirdParties = [
    site.tracking.metaPixelId ? 'Meta Platforms (Meta Pixel) — medir resultados de publicidad' : null,
    view.flags.whatsapp ? 'WhatsApp (Meta) — canal de contacto elegido por el usuario' : null,
  ].filter(Boolean);

  const sections = isPrivacy
    ? [
        {
          title: '1. Responsable del tratamiento',
          text: `${company.legalName ?? pending(view, 'Razón social')} — RUT/NIF: ${company.taxId ?? pending(view, 'Identificación tributaria')} — Dirección: ${company.address ?? pending(view, 'Domicilio')} — País: ${company.country ?? pending(view, 'País')}`,
        },
        {
          title: '2. Datos que recogemos',
          text: 'Nombre, teléfono/WhatsApp, ciudad o país (opcional) y la cantidad del producto si realizas un pedido. Además guardamos datos técnicos de atribución: parámetros UTM, fbclid, URL de llegada, referrer y fecha/hora del primer contacto.',
        },
        {
          title: '3. Finalidad',
          text: 'Contactarte para enviarte información del producto, confirmar tu pedido y coordinar el pago y la entrega. No usamos tus datos para finalidades distintas sin tu autorización.',
        },
        {
          title: '4. Base legal',
          text: 'Tu consentimiento expreso, otorgado al marcar la casilla del formulario o al iniciar el pedido.',
        },
        {
          title: '5. Conservación',
          text: company.retentionDays
            ? `Conservamos los datos durante ${company.retentionDays} días, salvo obligación legal de conservarlos más tiempo.`
            : `${pending(view, 'Plazo de conservación')} — definir el plazo de conservación de datos.`,
        },
        {
          title: '6. Destinatarios y terceros',
          text:
            thirdParties.length > 0
              ? `No cedemos tus datos a terceros con fines publicitarios. Usamos: ${thirdParties.join('; ')}.`
              : 'No cedemos tus datos a terceros. Actualmente no se carga ningún servicio de medición publicitaria.',
        },
        {
          title: '7. Tus derechos',
          text: `Puedes solicitar acceso, rectificación, eliminación u oposición al tratamiento escribiendo a ${company.contactEmail ?? pending(view, 'Email de contacto')}.`,
        },
        {
          title: '8. Cookies y medición',
          text: !site.tracking.metaPixelId
            ? 'No se instalan cookies de medición publicitaria en esta web.'
            : site.tracking.consentRequired === false
              ? 'Usamos cookies de medición publicitaria (Meta) para saber qué anuncio trae clientes. Se instalan al entrar en la web, sin aviso previo; puedes bloquearlas o borrarlas cuando quieras desde tu navegador y la web sigue funcionando igual.'
              : 'Usamos cookies de medición publicitaria únicamente después de que aceptes el aviso correspondiente. Puedes rechazarlas y la web sigue funcionando con normalidad.',
        },
      ]
    : [
        {
          title: '1. Titular',
          text: `${company.legalName ?? pending(view, 'Razón social')} — ${company.address ?? pending(view, 'Domicilio')}.`,
        },
        {
          title: '2. Producto',
          text: `${product.name}${product.presentation ? ` — ${product.presentation}` : ''}. La información publicada corresponde a ${product.regulatory ?? pending(view, 'Registro sanitario / autorización')}.`,
        },
        {
          title: '3. Proceso de compra',
          text: 'Esta web no procesa pagos. El pedido se confirma por WhatsApp, donde se acuerdan disponibilidad, forma de pago y entrega.',
        },
        {
          title: '4. Precios y disponibilidad',
          text: 'Los precios y la disponibilidad se informan en esta web cuando están confirmados; si no lo están, se indican como “a consultar” y se confirman por WhatsApp.',
        },
        {
          title: '5. Entrega y devoluciones',
          text: site.commerce.delivery
            ? `${site.commerce.delivery}. ${site.commerce.returns ?? ''}`.trim()
            : `${pending(view, 'Condiciones de entrega')} — definir plazos, cobertura y política de devolución.`,
        },
        {
          title: '6. Uso del producto',
          text: product.usage ?? `${pending(view, 'Modo de uso aprobado')} — incluir el texto literal de la etiqueta.`,
        },
        {
          title: '7. Legislación aplicable',
          text: `${company.country ?? pending(view, 'País')} — definir jurisdicción aplicable.`,
        },
      ];

  const list = sections
    .map(
      (section) => `<section class="pe-legal__section">
        <h2>${escapeHtml(section.title)}</h2>
        <p>${section.text}</p>
      </section>`,
    )
    .join('');

  return `<main id="contenido" class="pe-main">
      <div class="pe-container pe-container--narrow pe-legal">
        <h1 class="pe-legal__title">${escapeHtml(isPrivacy ? content.legal.privacyTitle : content.legal.termsTitle)}</h1>
        <p class="pe-note pe-note--warn">${escapeHtml(intro)}</p>
        <p class="pe-legal__updated">Última actualización: ${escapeHtml(new Date().toISOString().slice(0, 10))}</p>
        ${list}
      </div>
    </main>`;
}

/** Página legal (privacidad o términos). */
export function renderLegalPage(view, options = {}) {
  const kind = options.kind === 'terms' ? 'terms' : 'privacy';
  const { content } = view;
  const isPrivacy = kind === 'privacy';
  const title = isPrivacy ? content.legal.privacyTitle : content.legal.termsTitle;

  return document({
    view,
    assets: options.assets,
    title: view.site.seo.titleTemplate
      ? String(view.site.seo.titleTemplate).replace('%s', title)
      : `${title} | ${view.site.brand.name}`,
    description: isPrivacy
      ? 'Cómo tratamos los datos de contacto y la medición de esta web.'
      : 'Condiciones de compra y uso de esta web.',
    canonicalPath: isPrivacy ? view.site.privacy.privacyPath : view.site.privacy.termsPath,
    body: legalBody(view, kind),
    // Mientras haya placeholders legales sin completar, estas páginas no deben indexarse.
    noindex: true,
  });
}
