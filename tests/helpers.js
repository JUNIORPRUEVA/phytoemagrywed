/**
 * Helpers de test: construyen configuraciones controladas para renderizar la
 * landing sin depender del `.env` de la máquina.
 */

import { siteConfig } from '../src/config/site.config.js';
import { productConfig } from '../src/config/product.config.js';
import { contentConfig } from '../src/config/content.config.js';
import { buildView } from '../src/render/view.js';

/**
 * @param {object} [options]
 * @param {string|null} [options.whatsapp]
 * @param {number|null} [options.price]
 * @param {string|null} [options.siteUrl]
 * @param {string|null} [options.pixelId]
 * @param {boolean} [options.dataLayer]
 * @param {string|null} [options.email]
 * @param {object} [options.product]  overrides de ficha
 * @param {object} [options.site]     overrides de sitio
 * @param {object} [options.content]  overrides de copy
 */
export function makeView(options = {}) {
  const {
    whatsapp = null,
    siteUrl = null,
    pixelId = null,
    dataLayer = false,
    email = null,
    product = {},
    site = {},
    content = {},
  } = options;

  const mergedSite = {
    ...siteConfig,
    ...site,
    brand: { ...siteConfig.brand, ...(site.brand ?? {}) },
    seo: { ...siteConfig.seo, siteUrl, ...(site.seo ?? {}) },
    contact: {
      ...siteConfig.contact,
      ...(site.contact ?? {}),
      email,
      whatsapp: { ...siteConfig.contact.whatsapp, number: whatsapp, ...(site.contact?.whatsapp ?? {}) },
    },
    commerce: { ...siteConfig.commerce, ...(site.commerce ?? {}) },
    tracking: { ...siteConfig.tracking, metaPixelId: pixelId, dataLayer, ...(site.tracking ?? {}) },
    crm: { ...siteConfig.crm, ...(site.crm ?? {}) },
    privacy: { ...siteConfig.privacy, ...(site.privacy ?? {}), company: { ...siteConfig.privacy.company, ...(site.privacy?.company ?? {}) } },
    features: { ...siteConfig.features, ...(site.features ?? {}) },
  };

  const mergedProduct = {
    ...productConfig,
    ...product,
    images: { ...productConfig.images, ...(product.images ?? {}) },
  };

  const mergedContent = {
    ...contentConfig,
    ...content,
    features: { ...contentConfig.features, ...(content.features ?? {}) },
    testimonials: { ...contentConfig.testimonials, ...(content.testimonials ?? {}) },
    faq: { ...contentConfig.faq, ...(content.faq ?? {}) },
    howToBuy: { ...contentConfig.howToBuy, ...(content.howToBuy ?? {}) },
  };

  return buildView({ site: mergedSite, product: mergedProduct, content: mergedContent });
}

/** Datos de producto completos (para probar que las secciones SÍ aparecen). */
export const fullProduct = {
  // Fotos reales de cada frasco (`npm run images:frascos`) para que los tests
  // cubran la tarjeta completa: imagen + nombre + cápsulas + precio + pedido.
  variants: [
    { id: 'capsules_5', capsules: 5, price: 1250, image: '/assets/img/frascos/frasco-5' },
    { id: 'capsules_7', capsules: 7, price: 1750, image: '/assets/img/frascos/frasco-7' },
    { id: 'capsules_10', capsules: 10, price: 2500, image: '/assets/img/frascos/frasco-10' },
    { id: 'capsules_15', capsules: 15, price: 3750, image: '/assets/img/frascos/frasco-15' },
    { id: 'capsules_20', capsules: 20, price: 5000, image: '/assets/img/frascos/frasco-20' },
    { id: 'capsules_30', capsules: 30, price: 6000, image: '/assets/img/frascos/frasco-30' },
    { id: 'capsules_60', capsules: 60, price: 10000, image: '/assets/img/frascos/frasco-60', completeBottle: true },
  ],
  defaultVariantId: 'capsules_10',
  presentation: 'Frasco de 60 cápsulas',
  contents: '60 cápsulas',
  shortDescription: 'Descripción corta aprobada.',
  // Textos aprobados reales (los mismos que se publican).
  description: productConfig.description,
  usage: productConfig.usage,
  ingredients: 'Ingredientes aprobados.',
  regulatory: 'Registro aprobado',
  manufacturer: 'Fabricante aprobado',
  availability: 'in_stock',
  images: {
    // La portada real se toma de `productConfig` (no se duplica aquí) para que
    // los tests validen exactamente la configuración que se publica.
    hero: productConfig.images.hero,
    heroWidth: productConfig.images.heroWidth,
    heroHeight: productConfig.images.heroHeight,
    heroWidths: productConfig.images.heroWidths,
    heroAlt: productConfig.images.heroAlt,
    presentation: '/assets/img/producto-presentacion',
    gallery: [],
    alt: 'Phytoemagry',
  },
};

/**
 * Vista con las 7 presentaciones reales (configuración de producción).
 * @param {Parameters<typeof makeView>[0]} [options]
 */
export function makeShopView(options = {}) {
  return makeView({ ...options, product: { ...fullProduct, ...(options.product ?? {}) } });
}
