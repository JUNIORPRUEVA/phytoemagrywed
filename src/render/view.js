/**
 * VIEW MODEL — datos derivados que comparten el render (build) y el cliente.
 *
 * Toda decisión de "¿esto se muestra?" se toma AQUÍ, en un solo sitio, para que
 * el HTML estático y el JS del navegador nunca discrepen.
 */

import { siteConfig } from '../config/site.config.js';
import { productConfig } from '../config/product.config.js';
import { contentConfig } from '../config/content.config.js';
import { isPlaceholderPhone, isPlaceholderUrl, isSet, textOrNull } from '../lib/config-helpers.js';
import { formatPrice } from '../lib/format.js';
import { buildGroups, resolveGroup } from '../lib/community.js';
import { buildVariants, cheapestVariant, findVariant, variantTotals } from '../lib/variants.js';
import { normalizeWhatsAppNumber } from '../lib/whatsapp.js';
import { IMAGE_WIDTHS, resolveImage } from './media.js';

/** Une una lista en lenguaje natural: "a, b y c". */
function joinNatural(list) {
  const items = list.filter(Boolean).map(String);
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/** "5, 7, 10, 15, 20, 30 y 60" (a partir de los frascos reales). */
export function capsulesList(variants) {
  return joinNatural(variants.map((variant) => variant.capsules));
}

/**
 * "Frasco de 5 cápsulas: RD$1,250 · Frasco de 10 cápsulas: RD$2,500 · …"
 * (precios reales; el prefijo sale del copy para no duplicar textos).
 * @param {{ capsules: number, name: string, priceLabel: string|null }[]} variants
 * @param {string} [prefix]
 */
export function pricesList(variants, prefix = '') {
  const lead = typeof prefix === 'string' && prefix.trim() !== '' ? `${prefix.trim()} ` : '';
  return variants
    .map((variant) => `${lead}${variant.name}: ${variant.priceLabel}`)
    .join(' · ');
}

/**
 * Normaliza la URL pública del sitio.
 *
 * Devuelve `null` si no es una URL absoluta con host real: así un valor a medias
 * (`https://`, `tudominio.com`, `https://$(PRIMARY_DOMAIN)` sin sustituir) no
 * genera un `canonical` ni un `og:url` rotos. Nunca se publica una URL mala.
 *
 * @param {unknown} raw
 * @returns {string|null} URL sin barra final, o null si no es utilizable
 */
export function normalizeSiteUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // Sin host real (p. ej. "https://") no sirve para canonical ni para OG.
  if (!parsed.hostname || !parsed.hostname.includes('.')) return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * Frase de zonas de entrega. Devuelve '' mientras el negocio no confirme zonas:
 * nunca se inventan plazos, costos ni coberturas.
 */function deliveryAreasSentence(site) {
  const areas = (Array.isArray(site.commerce?.deliveryAreas) ? site.commerce.deliveryAreas : []).filter(
    (area) => isSet(area),
  );
  if (areas.length === 0) return '';
  return ` Zonas de entrega: ${joinNatural(areas)}.`;
}

/**
 * FAQ final: primero las generadas con datos reales (frascos, precios,
 * cantidad, comunidad, entrega) y después las estáticas del negocio.
 */
export function buildFaqItems({ content, variants, site, hasCommunity }) {
  const generated = content.faq?.generated ?? {};
  const bottlePrefix = content.selector?.cardPrefix ?? '';
  /** @type {{ question: string, answer: string }[]} */
  const items = [];

  if (variants.length > 0 && isSet(generated.presentations?.question)) {
    items.push({
      question: generated.presentations.question,
      answer: String(generated.presentations.answer).replace('{list}', capsulesList(variants)),
    });
  }
  if (variants.length > 0 && isSet(generated.price?.question)) {
    items.push({
      question: generated.price.question,
      answer: String(generated.price.answer).replace('{prices}', pricesList(variants, bottlePrefix)),
    });
  }
  if (variants.length > 1 && isSet(generated.quantity?.question)) {
    items.push({ question: generated.quantity.question, answer: generated.quantity.answer });
  }
  if (hasCommunity && isSet(generated.community?.question)) {
    items.push({ question: generated.community.question, answer: generated.community.answer });
  }
  if (isSet(generated.delivery?.question)) {
    items.push({
      question: generated.delivery.question,
      answer: String(generated.delivery.answer).replace('{areas}', deliveryAreasSentence(site)),
    });
  }

  const staticItems = (Array.isArray(content.faq?.items) ? content.faq.items : []).filter(
    (item) => item && isSet(item.question) && isSet(item.answer),
  );

  return [...items, ...staticItems];
}

/**
 * @param {{ site?: any, product?: any, content?: any }} [overrides]
 */
export function buildView(overrides = {}) {
  const site = overrides.site ?? siteConfig;
  const product = overrides.product ?? productConfig;
  const content = overrides.content ?? contentConfig;

  const { currency, locale } = site.commerce;
  const waNumber = normalizeWhatsAppNumber(site.contact.whatsapp.number);
  const waEnabled = waNumber !== null;
  const bounds = {
    min: site.features?.minQuantity ?? 1,
    max: site.features?.maxQuantity ?? 10,
  };

  // ---------------------------------------------------------------- VARIANTES
  const altBase = product.images?.alt ?? product.name;
  /**
   * Foto de cada frasco (tarjeta del carrusel). Las dimensiones y los anchos
   * salen de configuración: un cuadrado uniforme para todas las tarjetas, así
   * ninguna queda más alta que otra.
   */
  const variantImage = {
    width: Number(product.images?.variantWidth) || 1024,
    height: Number(product.images?.variantHeight) || 1024,
    widths:
      Array.isArray(product.images?.variantWidths) && product.images.variantWidths.length > 0
        ? product.images.variantWidths
        : [...IMAGE_WIDTHS],
  };
  const variants = buildVariants(product, { currency, locale }).map((variant) => ({
    ...variant,
    /** Foto REAL de esa presentación (null mientras no exista el archivo). */
    image: resolveImage(variant.image, { alt: `${altBase} — ${variant.name}`, ...variantImage }),
  }));
  const defaultVariant = findVariant(variants, product.defaultVariantId) ?? variants[0] ?? null;
  const fromVariant = cheapestVariant(variants);

  // ---------------------------------------------------------------- COMUNIDAD
  /**
   * La comunidad se puede desactivar desde configuración (`community.enabled`).
   * Desactivada = no se resuelve ningún grupo, así que la sección, el enlace de
   * la zona de compra, la pregunta de la FAQ y el acceso del menú desaparecen
   * solos (no queda ningún hueco en el diseño).
   */
  const communityEnabled = site.community?.enabled !== false;
  const groups = communityEnabled ? buildGroups(site.community?.groups) : [];
  const activeGroup = resolveGroup(groups);
  /**
   * Cifra de comunidad ("más de 4.000 clientes"): el negocio la ha comentado,
   * pero la landing NO la publica hasta que esté verificada en configuración.
   * Mientras `memberClaimVerified !== true`, esto es `null` y no se renderiza.
   */
  const memberClaim =
    site.community?.memberClaimVerified === true ? textOrNull(site.community?.memberClaim) : null;

  // --------------------------------------------------------- CONFIANZA (claims)
  /**
   * Afirmación factual aprobada por el negocio ("Miles de personas ya cuentan
   * con Phytoemagry."). Solo se publica si está marcada como verificada y solo
   * desde este campo: si la misma frase aparece en otro texto de configuración,
   * el detector de afirmaciones la bloquea.
   */
  const trustClaim =
    site.trust?.claimVerified === true ? textOrNull(site.trust?.claim) : null;

  const images = {
    /**
     * Portada principal: panorama con la línea completa de frascos.
     * Las dimensiones y los anchos salen de configuración para que el `<picture>`
     * genere el `srcset` real (sin CLS y sin descargar más de lo necesario).
     */
    hero: resolveImage(product.images?.hero, {
      alt: product.images?.heroAlt ?? product.images?.alt ?? product.name,
      width: Number(product.images?.heroWidth) || 1024,
      height: Number(product.images?.heroHeight) || 1024,
      widths:
        Array.isArray(product.images?.heroWidths) && product.images.heroWidths.length > 0
          ? product.images.heroWidths
          : [...IMAGE_WIDTHS],
    }),
    presentation: resolveImage(product.images?.presentation, {
      alt: `${product.images?.alt ?? product.name} — ${product.presentation ?? ''}`.trim(),
      width: 1024,
      height: 1024,
    }),
    gallery: (Array.isArray(product.images?.gallery) ? product.images.gallery : [])
      .map((base, index) =>
        resolveImage(base, { alt: `${product.images?.alt ?? product.name} ${index + 1}`, width: 1024, height: 1024 }),
      )
      .filter(Boolean),
  };

  const features = (Array.isArray(content.features?.items) ? content.features.items : []).filter(
    (item) => item && isSet(item.title),
  );
  const testimonials = (Array.isArray(content.testimonials?.items) ? content.testimonials.items : []).filter(
    (item) => item && isSet(item.text),
  );
  const steps = (Array.isArray(content.howToBuy?.steps) ? content.howToBuy.steps : []).filter(
    (step) => step && isSet(step.title),
  );
  const blocks = (Array.isArray(content.product?.blocks) ? content.product.blocks : []).filter(
    (block) => block && isSet(block.text),
  );
  const communityCards = (Array.isArray(content.community?.cards) ? content.community.cards : []).filter(
    (card) => card && isSet(card.title),
  );

  /**
   * Qué bloques se publican (site.config.js → features.sections).
   * `false` = el bloque no se renderiza ni ocupa espacio (la web queda más ligera).
   * Cualquier bloque sin declarar se publica.
   */
  const sections = {
    product: site.features?.sections?.product !== false,
    frascos: site.features?.sections?.frascos !== false,
    faq: site.features?.sections?.faq !== false,
    leadForm: site.features?.sections?.leadForm !== false,
    finalCta: site.features?.sections?.finalCta !== false,
    howToBuy: site.features?.sections?.howToBuy !== false,
  };

  const availabilityLabel =
    product.availability && content.presentation?.availability?.[product.availability]
      ? content.presentation.availability[product.availability]
      : null;

  const showPriceWhenUnknown = site.features?.showPriceWhenUnknown !== false;
  const priceOnRequestLabel =
    content.hero?.labels?.priceOnRequest ?? content.checkout?.labels?.priceOnRequest ?? 'Consultar precio';

  const faqItems = buildFaqItems({
    content,
    variants,
    site,
    hasCommunity: activeGroup !== null,
  });

  /**
   * URL del sitio (canonical, sitemap y `og:url`).
   *
   * Se valida de verdad: los paneles (Easypanel, Dokploy…) permiten escribir
   * `SEO_SITE_URL=https://$(PRIMARY_DOMAIN)` y, si el dominio todavía no está
   * configurado, la variable queda en `https://` — sin host. Eso produciría un
   * canonical roto (`https:///`) y una vista previa sin imagen al compartir el
   * enlace: mejor no publicar ninguna URL que publicar una mala.
   */
  const siteUrl = normalizeSiteUrl(site.seo?.siteUrl);
  const flags = {
    whatsapp: waEnabled,
    /** Hay al menos una presentación con precio real. */
    variants: variants.length > 0,
    pricing: Boolean(defaultVariant),
    priceOnRequest: !defaultVariant && showPriceWhenUnknown,
    compareAt: false,
    availability: Boolean(availabilityLabel),
    community: activeGroup !== null,
    /** Sección de comunidad publicada (interruptor + grupos disponibles). */
    communitySection: activeGroup !== null,
    /** Afirmación factual aprobada y publicable. */
    trustClaim: trustClaim !== null,
    /** Bloques publicables según `features.sections` (ver `sections`). */
    sections,
    productInfo: sections.product,
    leadForm: sections.leadForm,
    finalCta: sections.finalCta,
    communityCards: communityCards.length > 0,
    /** Cifra de comunidad publicable: solo con verificación explícita. */
    communityClaim: memberClaim !== null,
    deliveryAreas: Array.isArray(site.commerce?.deliveryAreas) && site.commerce.deliveryAreas.length > 0,
    deliveryMessage: isSet(site.commerce?.deliveryMessage),
    pickup: site.commerce?.pickupAvailable === true,
    shipping: site.commerce?.shippingAvailable === true,
    features: features.length > 0,
    testimonials: testimonials.length > 0,
    faq: faqItems.length > 0 && sections.faq,
    steps: steps.length > 0 && sections.howToBuy,
    blocks: blocks.length > 0,
    heroImage: images.hero !== null,
    presentationImage: images.presentation !== null,
    gallery: images.gallery.length > 0,
    payments: Array.isArray(site.commerce?.paymentMethods) && site.commerce.paymentMethods.length > 0,
    delivery: isSet(site.commerce?.delivery),
    returns: isSet(site.commerce?.returns),
    email: isSet(site.contact?.email),
    mobileCtaBar: site.features?.showMobileCtaBar !== false,
    consentBanner: Boolean(textOrNull(site.tracking?.metaPixelId) || site.tracking?.dataLayer === true),
    /** El formulario de compra necesita WhatsApp para poder "continuar el pedido". */
    checkoutWhatsApp: waEnabled,
  };

  const name = product.name ?? 'Producto';
  const shortName = textOrNull(product.shortName) ?? name;

  return {
    site,
    product,
    content,
    name,
    shortName,
    currency,
    locale,
    pricing: {
      currency,
      locale,
      bounds,
      variants,
      defaultVariantId: defaultVariant?.id ?? null,
      hasPrice: Boolean(defaultVariant),
      unitPrice: defaultVariant?.price ?? null,
      unitPriceLabel: defaultVariant?.priceLabel ?? null,
      /** "Desde RD$1,250" — presentación más económica disponible. */
      fromLabel: fromVariant ? formatPrice(fromVariant.price, { currency, locale }) : null,
      fromVariantId: fromVariant?.id ?? null,
      onRequestLabel: priceOnRequestLabel,
      /** El proyecto prohíbe descuentos artificiales: nunca hay precio tachado. */
      compareAt: null,
      availabilityLabel,
      /**
       * Totales de una presentación concreta × cantidad de UNIDADES.
       * @param {unknown} variantId
       * @param {unknown} quantity
       */
      forVariant: (variantId, quantity) =>
        variantTotals(findVariant(variants, variantId) ?? defaultVariant, quantity, {
          currency,
          locale,
          ...bounds,
        }),
      /** Atajo: totales de la presentación por defecto. */
      forQuantity: (quantity) =>
        variantTotals(defaultVariant, quantity, { currency, locale, ...bounds }),
    },
    community: {
      groups,
      active: activeGroup,
      enabled: communityEnabled && activeGroup !== null,
      /**
       * Cifra de clientes/miembros. SOLO se publica si el negocio la ha
       * verificado en configuración (`memberClaimVerified === true`).
       */
      memberClaim,
    },
    /** Afirmación de confianza publicada (o null => no se muestra la línea). */
    trust: { claim: trustClaim },
    whatsapp: {
      enabled: waEnabled,
      number: waNumber,
      /** true si el número parece de ejemplo (aviso en build/check:content). */
      looksLikePlaceholder: waEnabled ? isPlaceholderPhone(site.contact?.whatsapp?.number) : false,
      /** Número escrito para el visitante (null => solo se muestra "WhatsApp"). */
      displayNumber: waEnabled ? textOrNull(site.contact?.whatsapp?.displayNumber) : null,
      hours: textOrNull(site.contact?.whatsapp?.hours),
      defaultMessage: content.whatsapp?.general ?? site.contact?.whatsapp?.defaultMessage ?? '',
      labels: content.whatsapp?.labels ?? {},
      includeRef: site.contact?.whatsapp?.includeRefInMessage !== false,
    },
    images,
    lists: { features, testimonials, faqItems, steps, blocks, communityCards },
    flags,
    seo: {
      siteUrl,
      looksLikePlaceholder: siteUrl ? isPlaceholderUrl(siteUrl) : false,
      canonicalFor: (path) => (siteUrl ? `${siteUrl}${path.startsWith('/') ? path : `/${path}`}` : null),
      ogImageUrl: siteUrl && isSet(site.seo?.ogImage) ? `${siteUrl}${site.seo.ogImage}` : null,
    },
    maxQuantity: site.features?.maxQuantity ?? 10,
  };
}

export const view = buildView();

export default view;
