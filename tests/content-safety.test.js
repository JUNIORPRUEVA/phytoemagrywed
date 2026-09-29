/**
 * SEGURIDAD DE CONTENIDO.
 *
 * Dos direcciones:
 *  1. El detector DEBE marcar las afirmaciones prohibidas (pierde libras, plazos,
 *     garantías, curas, presión corporal…).
 *  2. El detector NO DEBE marcar texto legítimo (avisos legales, protección de
 *     datos, plazos de conservación).
 *
 * Además se audita la configuración real y la página renderizada.
 */

import { describe, expect, it } from 'vitest';

import { contentConfig } from '../src/config/content.config.js';
import { productConfig } from '../src/config/product.config.js';
import { siteConfig } from '../src/config/site.config.js';
import { FORBIDDEN_PATTERNS, auditConfigs, findClaims } from '../src/lib/content-safety.js';
import { renderIndexPage } from '../src/render/pages.js';
import { makeShopView, makeView } from './helpers.js';

/** Frases que el negocio ha pedido bloquear expresamente. */
const MUST_FLAG = [
  'Pierde 5-15 libras en 5 días',
  'Resultados en 5 días',
  'Resultados garantizados',
  'Te hará rebajar',
  'Elimina grasa',
  'Sin efectos secundarios',
  'Cura la diabetes',
  'Tratamiento para la obesidad',
  'Antes y después',
  '100% natural y seguro',
  'Aprobado por la FDA',
  'Más de 4000 clientes satisfechos',
  'Únete a miles de personas que ya tuvieron resultados',
  'Comprueba los resultados',
  'Personas que ya rebajaron',
  'Resultados comprobados',
  'Resultados reales garantizados',
  'más de 4,000 clientes',
  'miles de clientes',
  'miles de personas obtuvieron resultados',
  'Últimas unidades disponibles',
  'Precio válido solo por hoy',
  'Clínicamente probado',
];

/** Frases legítimas que NO deben bloquearse. */
const MUST_NOT_FLAG = [
  'La comunidad no sustituye la información médica ni garantiza resultados.',
  'Este producto no es un medicamento ni está destinado a tratar enfermedades.',
  'Conservamos los datos durante 365 días desde la última compra.',
  'Responsable del tratamiento de datos: Phytoemagry.',
  'La finalidad del tratamiento de datos personales es contactarte.',
  'No se realiza ningún cobro en esta página ni se piden datos de tarjeta.',
  'Puedes unirte a nuestra comunidad de WhatsApp para hacer tus preguntas.',
];

describe('detector de afirmaciones prohibidas', () => {
  it('marca todas las frases que el negocio quiere bloquear', () => {
    const notDetected = MUST_FLAG.filter((text) => findClaims(text).length === 0);
    expect(notDetected).toEqual([]);
  });

  it('no bloquea avisos legales ni protección de datos', () => {
    /** @type {{ text: string, hits: string[] }[]} */
    const falsePositives = [];
    for (const text of MUST_NOT_FLAG) {
      const violations = findClaims(text);
      if (violations.length > 0) falsePositives.push({ text, hits: violations.map((v) => v.id) });
    }
    expect(falsePositives).toEqual([]);
  });

  it('cada patrón prohibido tiene identificador y descripción', () => {
    expect(FORBIDDEN_PATTERNS.length).toBeGreaterThanOrEqual(12);
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(pattern.id).toBeTruthy();
      expect(pattern.label).toBeTruthy();
      expect(pattern.pattern).toBeInstanceOf(RegExp);
    }
  });

  it('una cifra solo se permite desde el campo aprobado y verificado', () => {
    const approved = 'Miles de personas ya cuentan con Phytoemagry.';
    // 1) Aprobada y verificada en su campo: se acepta.
    expect(
      auditConfigs({ site: { trust: { claim: approved, claimVerified: true } } }),
    ).toEqual([]);
    // 2) La misma frase fuera de su campo: se bloquea.
    const fueraDeSitio = auditConfigs({
      site: { trust: { claim: approved, claimVerified: true } },
      content: { hero: { lead: approved } },
    });
    expect(fueraDeSitio.map((v) => v.path)).toContain('content.hero.lead');
    // 3) Sin verificar: no se aprueba nada.
    const sinVerificar = auditConfigs({
      site: { trust: { claim: approved, claimVerified: false } },
    });
    expect(sinVerificar.map((v) => v.id)).toContain('social-proof-figures');
  });

  it('la afirmación de confianza del proyecto es la aprobada y no promete resultados', () => {
    expect(siteConfig.trust.claimVerified).toBe(true);
    expect(siteConfig.trust.claim).toBe('Miles de personas ya cuentan con Phytoemagry.');
    expect(findClaims(siteConfig.trust.claim)).toHaveLength(1); // es una cifra: por eso requiere aprobación
    expect(siteConfig.trust.claim).not.toMatch(/resultado|adelgaz|libras|garantiz|salud|m[eé]dic/i);
  });

  it('informa de la ruta exacta donde está el problema', () => {
    const [violation] = findClaims('Resultados garantizados', { path: 'content.hero.ctaNote' });
    expect(violation.path).toBe('content.hero.ctaNote');
    expect(violation.excerpt).toContain('garantizados');
  });
});

describe('configuración real del proyecto', () => {
  const violations = auditConfigs({ site: siteConfig, product: productConfig, content: contentConfig });

  it('no contiene ninguna afirmación prohibida', () => {
    expect(violations).toEqual([]);
  });

  it('los datos del producto que requieren información oficial siguen vacíos', () => {
    expect(productConfig.ingredients).toBeNull();
    expect(productConfig.regulatory).toBeNull();
    expect(productConfig.manufacturer).toBeNull();
    expect(productConfig.disclaimer).toBeNull();
    expect(productConfig.certifications).toEqual([]);
    expect(productConfig.approvedInfo).toEqual([]);
  });

  it('los datos ya aportados por el negocio son los aprobados y sin claims', () => {
    // Portada y modo de uso: textos facilitados y aprobados por el negocio.
    expect(productConfig.images.hero).toBe('/assets/img/portada-principal');
    expect(productConfig.usage).toBe('1 cápsula al día después del desayuno.');
    expect(productConfig.description).toBe(
      'Phytoemagry es un producto fitoterápico en cápsulas, diseñado para incorporarse fácilmente a tu rutina diaria.',
    );
    // Aun siendo textos aprobados, se comprueba que no contienen afirmaciones prohibidas.
    expect(findClaims(productConfig.usage ?? '')).toEqual([]);
    expect(findClaims(productConfig.description ?? '')).toEqual([]);
    expect(findClaims(productConfig.images.heroAlt ?? '')).toEqual([]);
  });

  it('solo hay precios reales, sin descuentos ni ahorros inventados', () => {
    expect(productConfig.compareAtPrice).toBeNull();
    expect(JSON.stringify(productConfig)).not.toMatch(/descuento|ahorro|antes de|precio anterior|oferta/i);
  });

  it('no hay testimonios ni características inventadas', () => {
    expect(contentConfig.testimonials.items).toEqual([]);
    expect(contentConfig.features.items).toEqual([]);
  });

  it('no se declaran métodos de pago, entregas ni datos de empresa sin confirmar', () => {
    expect(siteConfig.commerce.paymentMethods).toEqual([]);
    expect(siteConfig.commerce.delivery).toBeNull();
    expect(siteConfig.commerce.deliveryAreas).toEqual([]);
    expect(siteConfig.commerce.pickupAvailable).toBeNull();
    expect(siteConfig.commerce.shippingAvailable).toBeNull();
    expect(siteConfig.privacy.company.legalName).toBeNull();
    expect(siteConfig.privacy.company.taxId).toBeNull();
  });

  it('los mensajes de WhatsApp no prometen nada', () => {
    for (const message of Object.values(contentConfig.whatsapp)) {
      if (typeof message !== 'string') continue;
      for (const { pattern } of FORBIDDEN_PATTERNS) expect(pattern.test(message)).toBe(false);
    }
  });
});

describe('página renderizada', () => {
  const html = renderIndexPage(makeShopView());

  it('no incluye afirmaciones prohibidas', () => {
    const hits = MUST_FLAG.filter((text) => html.toLowerCase().includes(text.toLowerCase()));
    expect(hits).toEqual([]);
  });

  it('no etiqueta ninguna presentación como oferta', () => {
    expect(html).not.toMatch(/mejor (oferta|precio)|m[aá]s vendido|recomendado|oferta especial|descuento/i);
    expect(html).toContain('Frasco completo');
  });

  it('no muestra descuentos ni precios tachados', () => {
    expect(html).not.toContain('pe-price__compare');
    expect(html).not.toMatch(/<s[ >]/);
    expect(html).not.toMatch(/<del[ >]/);
  });

  it('no muestra estrellas, valoraciones ni cifras de clientes', () => {
    expect(html).not.toMatch(/\u2b50|\u2605{3,}|aggregateRating|reviewCount|m[aá]s de \d+\s*clientes/i);
  });

  it('no muestra escasez ni urgencia artificial', () => {
    expect(html).not.toMatch(/[uú]ltimas unidades|solo (por )?hoy|quedan \d+|se acaba/i);
  });

  it('los únicos importes visibles son los precios oficiales', () => {
    const amounts = [...html.matchAll(/RD\$([\d,]+(?:\.\d+)?)/g)].map((match) => match[1]);
    expect(amounts.length).toBeGreaterThan(0);
    const allowed = new Set(['1,250', '1,750', '2,500', '3,750', '5,000', '6,000', '10,000', '12,000', '20,000']);
    for (const amount of amounts) expect(allowed.has(amount), `importe inesperado: RD$${amount}`).toBe(true);
  });

  it('la comunidad está retirada: no hay enlaces ni avisos de comunidad en la página', () => {
    expect(html).not.toContain('chat.whatsapp.com');
    expect(html).not.toContain('Unirme al grupo');
    // El aviso sigue existiendo en la configuración, por si se reactiva.
    expect(contentConfig.community.disclaimer).toContain('no sustituye la información médica');
  });

  it('publica la afirmación de confianza aprobada y ninguna otra cifra', () => {
    // La única cifra de personas permitida es la aprobada en `site.trust`.
    expect(html).toContain('Miles de personas ya cuentan con Phytoemagry.');
    expect(html).not.toMatch(/\d[\d.,]*\s*(clientes|personas|usuarios)/i);
    expect(html).not.toMatch(/resultados?/i);
  });
});

describe('sin frascos configurados', () => {
  const view = makeView({ product: { variants: [] } });
  const html = renderIndexPage(view);

  it('oculta el selector y no muestra precios', () => {
    expect(view.pricing.variants).toHaveLength(0);
    expect(html).not.toContain('id="frascos"');
    expect(html).not.toMatch(/RD\$\d/);
  });

  it('muestra "Consultar precio" en lugar de una cifra', () => {
    expect(html).toContain('Consultar precio');
  });
});
