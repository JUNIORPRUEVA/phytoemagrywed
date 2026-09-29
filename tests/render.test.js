/**
 * RENDER de la landing: selector de frascos, precios reales, comunidad,
 * FAQ generada, accesibilidad, SEO y escapado.
 */

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderSitemap } from '../src/render/seo-files.js';
import { renderIndexPage, renderLegalPage } from '../src/render/pages.js';
import { buildGroups } from '../src/lib/community.js';
import { siteConfig } from '../src/config/site.config.js';
import { makeShopView, makeView } from './helpers.js';

/**
 * CSS real del proyecto.
 *
 * OJO: bajo el entorno `jsdom` de vitest, `new URL('../x.css', import.meta.url)`
 * NO resuelve al archivo (el `URL` global es el de jsdom): hay que partir de
 * `fileURLToPath(import.meta.url)`. Con la versión anterior, este helper leía el
 * propio archivo de test y las comprobaciones de CSS pasaban siempre.
 * @param {string} file
 */
const css = (file) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', file), 'utf8');

/** @param {string} html */
function parse(html) {
  return new JSDOM(html).window.document;
}

const WHATSAPP = '18095551234';
const PRICES = ['RD$1,250', 'RD$1,750', 'RD$2,500', 'RD$3,750', 'RD$5,000', 'RD$6,000', 'RD$10,000'];

describe('configuración sin datos (producto sin frascos)', () => {
  const view = makeView({ product: { variants: [] } });
  const doc = parse(renderIndexPage(view));

  it('oculta los CTA de WhatsApp si no hay número', () => {
    expect(doc.querySelectorAll('[data-action="whatsapp"]')).toHaveLength(0);
    expect(doc.body.textContent).not.toContain('wa.me');
  });

  it('no muestra precios ni secciones de frascos', () => {
    expect(doc.querySelector('#frascos')).toBeNull();
    expect(doc.querySelector('.pe-price--on-request')).not.toBeNull();
  });

  it('no publica datos estructurados sin precios reales', () => {
    expect(doc.querySelector('script[type="application/ld+json"]')).toBeNull();
  });

  it('oculta testimonios y características sin contenido aprobado', () => {
    expect(doc.querySelector('#opiniones')).toBeNull();
    expect(doc.querySelector('#caracteristicas')).toBeNull();
  });

  it('no genera canonical ni sitemap sin SEO_SITE_URL', () => {
    expect(doc.querySelector('link[rel="canonical"]')).toBeNull();
    expect(renderSitemap(view)).toBeNull();
  });
});

describe('landing con los 7 frascos reales', () => {
  const view = makeShopView({ whatsapp: WHATSAPP, siteUrl: 'https://phytoemagry.example' });
  const html = renderIndexPage(view);
  const doc = parse(html);

  it('ordena las secciones segun el recorrido comercial', () => {
    const ids = [...doc.querySelectorAll('main > section')].map((section) => section.id);
    // Página ligera: sin comunidad (decisión de negocio) ni "Cómo comprar"
    // (duplicaba el proceso que ya explica el selector y la FAQ).
    expect(ids).toEqual(['inicio', 'producto', 'frascos', 'preguntas', 'contacto', 'comprar']);
    expect(ids.indexOf('frascos')).toBeLessThan(ids.indexOf('preguntas'));
    expect(ids).not.toContain('comunidad');
    expect(ids).not.toContain('como-comprar');
    expect(ids).not.toContain('presentacion');
  });

  it('el menú no muestra enlaces a bloques que no se publican', () => {
    const menu = [...doc.querySelectorAll('.pe-nav__link')].map((link) => link.textContent.trim());
    expect(menu).toEqual(['Información', 'Frascos', 'Preguntas', 'Contacto']);
    for (const href of [...doc.querySelectorAll('.pe-nav__link')].map((l) => l.getAttribute('href'))) {
      expect(doc.querySelector(href), `ancla rota: ${href}`).not.toBeNull();
    }
  });

  it('la página ligera no repite el proceso en un bloque de pasos', () => {
    expect(doc.querySelector('#como-comprar')).toBeNull();
    const faq = doc.querySelector('.pe-faq');
    // 4 preguntas generadas con datos reales + la de cómo pedir.
    expect(faq.querySelectorAll('details')).toHaveLength(5);
  });

  it('renderiza los 7 frascos con su precio exacto', () => {
    const cards = [...doc.querySelectorAll('[data-variant-card]')];
    expect(cards).toHaveLength(7);
    const rendered = cards.map((card) => {
      const clone = card.cloneNode(true);
      clone.querySelectorAll('.pe-sr-only').forEach((node) => node.remove());
      return {
        id: card.getAttribute('data-variant-card'),
        capsules: clone.querySelector('.pe-variant__capsules').textContent.trim(),
        price: clone.querySelector('.pe-variant__price').textContent.trim(),
      };
    });
    expect(rendered.map((item) => item.capsules)).toEqual([
      '5 cápsulas',
      '7 cápsulas',
      '10 cápsulas',
      '15 cápsulas',
      '20 cápsulas',
      '30 cápsulas',
      '60 cápsulas',
    ]);
    expect(rendered.map((item) => item.id)).toEqual([
      'capsules_5',
      'capsules_7',
      'capsules_10',
      'capsules_15',
      'capsules_20',
      'capsules_30',
      'capsules_60',
    ]);
    expect(rendered.map((item) => item.price)).toEqual(PRICES);
  });

  it('son radios agrupados en un fieldset accesible (funcionan sin JS)', () => {
    const fieldset = doc.querySelector('fieldset.pe-variants');
    expect(fieldset).not.toBeNull();
    expect(fieldset.querySelector('legend').textContent.trim()).toBe('Elige tu frasco');
    const inputs = [...fieldset.querySelectorAll('input[type="radio"]')];
    expect(inputs).toHaveLength(7);
    for (const input of inputs) {
      expect(input.getAttribute('name')).toBe('pe-variant');
      expect(input.closest('label')).not.toBeNull();
    }
    // Solo una preseleccionada
    expect(inputs.filter((input) => input.hasAttribute('checked'))).toHaveLength(1);
    expect(inputs.find((input) => input.hasAttribute('checked')).value).toBe('capsules_10');
  });

  it('marca el frasco completo con una etiqueta neutra y una sola vez', () => {
    const badges = [...doc.querySelectorAll('.pe-variant__badge')];
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent.trim()).toBe('Frasco completo');
    expect(badges[0].closest('[data-variant-card]').getAttribute('data-variant-card')).toBe('capsules_60');
  });

  it('cada tarjeta dice "Frasco de" + cápsulas + precio', () => {
    for (const card of doc.querySelectorAll('[data-variant-card]')) {
      expect(card.querySelector('.pe-variant__prefix').textContent.trim()).toBe('Frasco de');
    }
  });

  it('la portada es la imagen panorámica, completa y con dimensiones explícitas', () => {
    const hero = doc.querySelector('#inicio');
    const picture = hero.querySelector('picture.pe-hero__picture');
    expect(picture).not.toBeNull();

    const img = picture.querySelector('img');
    // Mismas dimensiones que el archivo real: sin CLS y sin deformación.
    expect(Number(img.getAttribute('width'))).toBe(1672);
    expect(Number(img.getAttribute('height'))).toBe(941);
    expect(img.getAttribute('alt')).toBe(
      'Frascos de Phytoemagry Composto disponibles en diferentes cantidades de cápsulas.',
    );
    // Imagen visible al cargar: NO se carga en diferido y va con prioridad alta.
    expect(img.getAttribute('loading')).toBe('eager');
    expect(img.getAttribute('fetchpriority')).toBe('high');

    // `srcset` con todos los anchos reales en AVIF y WebP + fallback JPG.
    const sources = [...picture.querySelectorAll('source')].map((s) => s.getAttribute('type'));
    expect(sources).toEqual(['image/avif', 'image/webp']);
    for (const width of [480, 768, 1200, 1672]) {
      expect(picture.innerHTML).toContain(`portada-principal-${width}.avif ${width}w`);
      expect(picture.innerHTML).toContain(`portada-principal-${width}.webp ${width}w`);
    }
    expect(img.getAttribute('src')).toBe('/assets/img/portada-principal-1672.jpg');
  });

  it('precarga la portada una sola vez y con el mismo tamaño declarado', () => {
    const preload = doc.querySelector('link[rel="preload"][as="image"]');
    expect(preload).not.toBeNull();
    expect(preload.getAttribute('type')).toBe('image/avif');
    expect(preload.getAttribute('imagesrcset')).toContain('portada-principal-1672.avif 1672w');
    // El `sizes` del preload debe coincidir con el del <picture>.
    const pictureSizes = doc.querySelector('picture.pe-hero__picture source').getAttribute('sizes');
    expect(preload.getAttribute('imagesizes')).toBe(pictureSizes);
  });

  it('el h1 sigue existiendo para SEO aunque el nombre ya esté en la imagen', () => {
    const h1 = doc.querySelector('h1');
    expect(h1.textContent.trim()).toBe('Phytoemagry');
    expect(h1.classList.contains('pe-sr-only')).toBe(true);
  });

  it('la portada no repite nombres de frascos ni la lista de precios', () => {
    const hero = doc.querySelector('#inicio');
    const texto = hero.textContent;
    expect(texto).toContain('Encuentra el frasco que mejor se adapte a lo que buscas.');
    // Solo el precio inicial; los 7 precios viven en "Elige tu frasco".
    expect(texto).toContain('RD$1,250');
    for (const price of PRICES.slice(1)) expect(texto).not.toContain(price);
    // Sin repetir los nombres de los frascos dentro del hero.
    expect(texto).not.toMatch(/Frasco de \d+ cápsulas/);
  });

  it('el hero ofrece los dos caminos: frascos y WhatsApp', () => {
    const hero = doc.querySelector('#inicio');
    expect(hero.querySelector('.pe-price__from').textContent.trim()).toBe('Desde');
    expect(hero.querySelector('.pe-price').textContent.trim()).toBe('RD$1,250');
    const ctaPrimary = hero.querySelector('[data-action="scroll-to-variants"]');
    expect(ctaPrimary.getAttribute('href')).toBe('#frascos');
    expect(ctaPrimary.textContent).toContain('Ver frascos y precios');
    const wa = hero.querySelector('[data-action="whatsapp"]');
    expect(wa.textContent).toContain('Consultar por WhatsApp');
    expect(hero.textContent).not.toMatch(/más vendido|mejor opción|recomendado|oferta|ahorras/i);
  });

  it('el resumen del pedido parte de la presentación preseleccionada', () => {
    const order = doc.querySelector('[data-order]');
    expect(order.querySelector('[data-summary-variant]').textContent.trim()).toBe('10 cápsulas');
    expect(order.querySelector('[data-summary-unit]').textContent.trim()).toBe('RD$2,500');
    expect(order.querySelector('[data-qty-input]').getAttribute('max')).toBe('10');
    expect(order.querySelector('[data-summary-total]').textContent.trim()).toBe('RD$2,500');
  });

  it('la tarjeta de frasco no repite el nombre con texto oculto', () => {
    for (const card of doc.querySelectorAll('[data-variant-card]')) {
      const texto = card.querySelector('.pe-variant__capsules').textContent.trim();
      // "10 cápsulas" y no "10 cápsulas — cápsulas"
      expect(texto).toMatch(/^\d+ cápsulas$/);
    }
  });

  it('el resumen del modal va ANTES de los campos (visible al abrirlo en móvil)', () => {
    const dlg = doc.querySelector('#pe-checkout');
    const body = dlg.querySelector('.pe-dialog__body');
    const summary = body.querySelector('[data-summary]');
    const firstField = body.querySelector('.pe-field');
    const children = [...body.children];

    expect(summary).not.toBeNull();
    expect(firstField).not.toBeNull();
    // El resumen del pedido es el primer bloque de contenido del modal
    expect(children.indexOf(summary)).toBeLessThan(children.indexOf(firstField));
    expect(children.indexOf(summary)).toBeLessThanOrEqual(1);
    // Y contiene todo lo que el cliente está confirmando
    for (const selector of ['[data-summary-variant]', '[data-summary-unit]', '[data-summary-qty]', '[data-summary-capsules]', '[data-summary-total]']) {
      expect(summary.querySelector(selector)).not.toBeNull();
    }
    // El resumen no queda fuera del cuerpo desplazable
    expect(body.contains(summary)).toBe(true);
  });

  it('explica que la cantidad son frascos y cuenta las cápsulas aparte', () => {
    const order = doc.querySelector('[data-order]');
    expect(order.textContent).toContain('Cantidad de frascos');
    expect(order.textContent).toContain('Máximo 10 frascos por pedido.');
    expect(order.textContent).toContain('Cápsulas en total');
  });

  it('el enlace de WhatsApp del resumen ya lleva el frasco por defecto (sin JS)', () => {
    const link = doc.querySelector('[data-order] [data-action="whatsapp-order"]');
    const url = new URL(link.getAttribute('href'));
    expect(url.origin + url.pathname).toBe(`https://wa.me/${WHATSAPP}`);
    const text = url.searchParams.get('text');
    expect(text).toContain('Frasco: 10 cápsulas');
    expect(text).toContain('Cantidad: 1');
    expect(text).toContain('Total: RD$2,500');
  });

  it('cada tarjeta del carrusel pide SU frasco con el pedido completo (sin JS)', () => {
    const cards = [...doc.querySelectorAll('[data-variant-card]')];
    expect(cards).toHaveLength(7);

    cards.forEach((card, index) => {
      const id = card.getAttribute('data-variant-card');
      const capsules = id.replace('capsules_', '');
      const link = card.querySelector('[data-action="whatsapp-order"]');

      // Cada frasco tiene su propio botón de pedido dentro de la tarjeta.
      expect(link).not.toBeNull();
      expect(link.textContent.trim()).toBe('Pedir por WhatsApp');
      expect(link.getAttribute('data-variant')).toBe(id);
      expect(link.getAttribute('data-source')).toBe('frascos');
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
      // El botón NO está dentro del <label>: pulsar "pedir" no cambia la selección
      // al saltar el enlace, solo al elegir el frasco.
      expect(link.closest('label')).toBeNull();

      // Y el mensaje sale completo desde el HTML: producto, frasco, cantidad, total.
      const url = new URL(link.getAttribute('href'));
      expect(url.origin + url.pathname).toBe(`https://wa.me/${WHATSAPP}`);
      const text = url.searchParams.get('text');
      expect(text).toContain('Producto: Phytoemagry');
      expect(text).toContain(`Frasco: ${capsules} cápsulas`);
      expect(text).toContain('Cantidad: 1');
      expect(text).toContain(`Total: ${PRICES[index]}`);
    });
  });

  it('el carrusel es horizontal y las flechas son mejora progresiva', () => {
    const fieldset = doc.querySelector('fieldset.pe-variants');
    expect(fieldset.hasAttribute('data-carousel')).toBe(true);

    // Sin JS no se muestran flechas que no harían nada.
    const nav = doc.querySelector('.pe-carousel__nav');
    expect(nav.hasAttribute('hidden')).toBe(true);
    const buttons = [...nav.querySelectorAll('button')];
    expect(buttons).toHaveLength(2);
    expect(doc.querySelector('[data-carousel-prev]').getAttribute('aria-label')).toBe('Ver los frascos anteriores');
    expect(doc.querySelector('[data-carousel-next]').getAttribute('aria-label')).toBe('Ver los siguientes frascos');

    // Empieza por el frasco más económico: la primera tarjeta es la de menos cápsulas.
    expect(fieldset.querySelector('[data-variant-card]').getAttribute('data-variant-card')).toBe('capsules_5');
    expect(doc.querySelector('.pe-carousel__hint').textContent.trim()).toBe('Desliza para ver los frascos');
  });

  it('el CSS del carrusel se desliza en horizontal y no deforma las fotos', () => {
    const estilos = css('components.css');
    // Las reglas se localizan ancladas al inicio de línea: si no, el primer
    // selector de una lista agrupada también encajaría.
    const scroller = estilos.match(/\n\.pe-variants \{[^}]*\}/)?.[0] ?? '';
    expect(scroller).toContain('overflow-x: auto');
    expect(scroller).toContain('scroll-snap-type: x mandatory');
    // La tarjeta no se estira ni se encoge: el deslizamiento es del contenedor.
    const tarjeta = estilos.match(/\n\.pe-variant \{[^}]*\}/)?.[0] ?? '';
    expect(tarjeta).toContain('flex: 0 0 auto');
    // Caja cuadrada para las 7 fotos cuadradas: misma altura en todas las tarjetas.
    const foto = estilos.match(/\n\.pe-variant__picture img \{[^}]*\}/)?.[0] ?? '';
    expect(foto).toContain('aspect-ratio: 1 / 1');
    expect(foto).toContain('object-fit: cover');
  });

  it('la FAQ incluye frascos y precios reales', () => {
    const faq = doc.querySelector('.pe-faq').textContent;
    expect(faq).toContain('¿Qué frascos están disponibles?');
    expect(faq).toContain('5, 7, 10, 15, 20, 30 y 60 cápsulas');
    expect(faq).toContain('¿Cuál es el precio?');
    expect(faq).toContain('Frasco de 10 cápsulas: RD$2,500');
    expect(faq).toContain('RD$10,000');
    expect(faq).toContain('¿Puedo pedir más de un frasco?');
    // La pregunta de comunidad ya no aplica: la comunidad no se publica.
    expect(faq).not.toContain('¿Tienen comunidad de apoyo?');
  });

  it('publica la afirmación de confianza aprobada, sin badges ni presión', () => {
    const section = doc.querySelector('#producto');
    expect(section.textContent).toContain('Miles de personas ya cuentan con Phytoemagry.');
    expect(section.querySelector('.pe-trust')).not.toBeNull();
    expect(doc.body.textContent).not.toMatch(/más vendido|mejor opción|recomendado|oferta|ahorras/i);
  });

  it('no publica ningún enlace de comunidad ni su bloque', () => {
    expect(doc.querySelector('#comunidad')).toBeNull();
    expect(html).not.toContain('chat.whatsapp.com');
    expect(doc.querySelector('[data-order] [data-action="scroll-to-community"]')).toBeNull();
  });

  it('la comunidad (si se activa) es un bloque de confianza con un solo enlace', () => {
    // Capacidad del componente, con la comunidad activada explícitamente.
    const conComunidad = parse(
      renderIndexPage(
        makeShopView({
          whatsapp: WHATSAPP,
          site: { community: { ...siteConfig.community, enabled: true } },
        }),
      ),
    );
    const section = conComunidad.querySelector('#comunidad');
    expect(section).not.toBeNull();
    const links = [...section.querySelectorAll('a[href^="https://chat.whatsapp.com"]')];
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toContain('Unirme al grupo de WhatsApp');
    expect(links[0].getAttribute('rel')).toContain('noopener');
    expect(links[0].getAttribute('data-group')).toBe('group_1');
    expect(links[0].getAttribute('data-group-name')).toBeTruthy();
    expect(links[0].getAttribute('data-source-section')).toBe('comunidad');
    expect(section.textContent).toContain('¿Todavía tienes preguntas? Conoce nuestra comunidad');
    // Espacio de conversación, no promesa de resultados
    expect(section.textContent).toContain('no sustituye la información médica');
    // Sin avatares ni fotos que aparenten clientes reales
    expect(section.querySelectorAll('img')).toHaveLength(0);
    expect(section.querySelectorAll('.pe-community__card')).toHaveLength(3);
  });

  it('la zona de compra ya no enlaza a la comunidad (retirada a propósito)', () => {
    expect(doc.querySelector('[data-order] [data-action="scroll-to-community"]')).toBeNull();
  });

  it('el CSS de la portada nunca recorta ni deforma la imagen panorámica', () => {
    // Regresión: hubo reglas que forzaban alto fijo en móvil y `cover` cuadrado
    // en escritorio, y recortaban la foto. La portada debe usar `contain`.
    const estilos = `${css('layout.css')}\n${css('components.css')}`;
    const bloqueHero = estilos
      .split('\n')
      .filter((linea) => /hero/i.test(linea))
      .join('\n');
    expect(bloqueHero).not.toMatch(/aspect-ratio:\s*1\s*\/\s*1/);
    expect(estilos).toContain('object-fit: contain');
    // La altura fija antigua solo puede quedar para el marcador, no para la foto.
    const reglasHero = estilos.match(/\.pe-hero__picture[^{]*\{[^}]*\}/g) ?? [];
    expect(reglasHero.join('\n')).not.toMatch(/object-fit:\s*cover/);
    expect(reglasHero.join('\n')).not.toMatch(/height:\s*var\(--pe-hero-media-h\)/);
  });

  it('explica qué es el producto con el texto aprobado y su modo de uso', () => {
    const section = doc.querySelector('#producto');
    expect(section.querySelector('h2').textContent.trim()).toBe('¿Qué es Phytoemagry?');
    expect(section.textContent).toContain(
      'Phytoemagry es un producto fitoterápico en cápsulas, diseñado para incorporarse fácilmente a tu rutina diaria.',
    );
    expect(section.textContent).toContain('Modo de uso');
    expect(section.textContent).toContain('1 cápsula al día después del desayuno.');
    // Sin afirmaciones adicionales ni beneficios inventados.
    expect(section.textContent).not.toMatch(/beneficio|resultado|adelgaz|pierde|garantiz|recomendado por/i);
  });

  it('las tarjetas de frasco están preparadas para recibir imagen, nombre, cápsulas, precio e id', () => {
    // Configuración de ejemplo: foto propia de cada frasco (como en producción).
    const withImages = makeShopView({
      whatsapp: WHATSAPP,
      product: {
        variants: [
          { id: 'capsules_5', capsules: 5, price: 1250, image: '/assets/img/frascos/frasco-5' },
          { id: 'capsules_60', capsules: 60, price: 10000, completeBottle: true, image: '/assets/img/frascos/frasco-60' },
        ],
        defaultVariantId: 'capsules_5',
      },
    });
    const cards = [...parse(renderIndexPage(withImages)).querySelectorAll('[data-variant-card]')];
    expect(cards).toHaveLength(2);

    const [first, second] = cards;
    expect(first.getAttribute('data-variant-card')).toBe('capsules_5');
    expect(first.getAttribute('data-selected')).toBe('true');
    expect(first.querySelector('.pe-variant__prefix').textContent.trim()).toBe('Frasco de');
    expect(first.querySelector('.pe-variant__capsules').textContent.trim()).toBe('5 cápsulas');
    expect(first.querySelector('.pe-variant__price').textContent.trim()).toBe('RD$1,250');

    const img = first.querySelector('.pe-variant__media img');
    expect(img).not.toBeNull();
    // Dimensiones reales del archivo: la tarjeta no salta al cargar la foto.
    expect(Number(img.getAttribute('width'))).toBe(480);
    expect(Number(img.getAttribute('height'))).toBe(480);
    expect(img.getAttribute('src')).toBe('/assets/img/frascos/frasco-5-480.jpg');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('alt')).toBe('Phytoemagry — 5 cápsulas');

    // AVIF → WebP con los dos anchos generados, y solo el ancho de la tarjeta.
    expect([...first.querySelectorAll('source')].map((source) => source.getAttribute('type'))).toEqual([
      'image/avif',
      'image/webp',
    ]);
    const avif = first.querySelector('source[type="image/avif"]');
    expect(avif.getAttribute('srcset')).toBe(
      '/assets/img/frascos/frasco-5-320.avif 320w, /assets/img/frascos/frasco-5-480.avif 480w',
    );
    // El `sizes` es el ancho REAL de la tarjeta (no el de la pantalla).
    expect(avif.getAttribute('sizes')).toBe('(min-width: 1024px) 232px, 240px');

    // Cada tarjeta lleva su propio pedido por WhatsApp.
    expect(second.querySelector('[data-action="whatsapp-order"]').getAttribute('data-variant')).toBe('capsules_60');
  });

  it('publica un rango de precios en datos estructurados', () => {
    const jsonLd = JSON.parse(doc.querySelector('script[type="application/ld+json"]').textContent);
    const product = jsonLd['@graph'].find((node) => node['@type'] === 'Product');
    expect(product.offers['@type']).toBe('AggregateOffer');
    expect(product.offers.lowPrice).toBe(1250);
    expect(product.offers.highPrice).toBe(10000);
    expect(product.offers.priceCurrency).toBe('DOP');
    expect(product.offers.offerCount).toBe(7);
    expect(JSON.stringify(jsonLd)).not.toMatch(/aggregateRating|reviewCount/);
  });

  it('genera canonical y sitemap', () => {
    expect(doc.querySelector('link[rel="canonical"]').getAttribute('href')).toBe('https://phytoemagry.example/');
    expect(renderSitemap(view)).toContain('<loc>https://phytoemagry.example/</loc>');
  });

  it('no deja ningún importe sin los 7 frascos', () => {
    for (const price of PRICES) expect(html).toContain(price);
  });
});

describe('página ligera: bloques activables desde configuración', () => {
  it('con la configuración real no se publican los bloques desactivados', () => {
    const html = renderIndexPage(makeShopView());
    expect(html).not.toContain('id="como-comprar"');
    expect(html).not.toContain('Cuatro pasos');
    expect(html).not.toContain('¿Realizan cobros en esta página?');
    expect(html).not.toContain('¿Qué datos necesitan para mi pedido?');
    expect(html).not.toContain('¿Cómo se coordina el pago y la entrega?');
  });

  it('activar "Cómo comprar" devuelve el bloque y su enlace del menú', () => {
    const html = renderIndexPage(
      makeShopView({ site: { features: { ...siteConfig.features, sections: { ...siteConfig.features.sections, howToBuy: true } } } }),
    );
    expect(html).toContain('id="como-comprar"');
    expect(html).toContain('Cuatro pasos');
    expect(html).toContain('href="#como-comprar"');
  });

  it('cada bloque se puede apagar por separado', () => {
    const only = (sections) =>
      [...parse(renderIndexPage(makeShopView({ site: { features: { ...siteConfig.features, sections } } }))).querySelectorAll('main > section')].map(
        (section) => section.id,
      );

    expect(only({ product: false, faq: false, leadForm: false, finalCta: false, howToBuy: false })).toEqual([
      'inicio',
      'frascos',
    ]);
    expect(only({ product: false, faq: false, leadForm: false, finalCta: false, howToBuy: true })).toEqual([
      'inicio',
      'frascos',
      'como-comprar',
    ]);
  });
});

describe('accesibilidad del render', () => {
  const doc = parse(renderIndexPage(makeShopView({ whatsapp: WHATSAPP })));

  it('un solo h1 y jerarquía coherente', () => {
    expect(doc.querySelectorAll('h1')).toHaveLength(1);
    expect(doc.querySelector('h1').textContent.trim()).toBe('Phytoemagry');
  });

  it('cada sección está etiquetada por su encabezado', () => {
    for (const section of doc.querySelectorAll('main > section')) {
      const id = section.getAttribute('aria-labelledby');
      expect(id, `sección ${section.id} sin aria-labelledby`).toBeTruthy();
      expect(doc.getElementById(id)).not.toBeNull();
    }
  });

  it('todos los campos tienen etiqueta', () => {
    for (const input of doc.querySelectorAll('form input')) {
      const id = input.getAttribute('id');
      const hasExplicit = id && doc.querySelector(`label[for="${id}"]`);
      const hasWrapped = input.closest('label');
      expect(Boolean(hasExplicit || hasWrapped), `input ${id} sin label`).toBe(true);
    }
  });

  it('los controles de cantidad tienen nombre accesible', () => {
    const order = doc.querySelector('[data-order]');
    expect(order.querySelector('[data-qty-increase]').getAttribute('aria-label')).toBe('Añadir un frasco');
    expect(order.querySelector('[data-qty-decrease]').getAttribute('aria-label')).toBe('Quitar un frasco');
    expect(order.querySelector('[data-qty-input]').getAttribute('aria-label')).toBe('Cantidad de frascos');
  });

  it('el modal tiene título asociado y campos etiquetados', () => {
    const dialog = doc.querySelector('#pe-checkout');
    expect(dialog.getAttribute('aria-labelledby')).toBe('pe-checkout-title');
    expect(dialog.querySelector('#pe-checkout-title')).not.toBeNull();
  });

  it('skip link y enlaces externos seguros', () => {
    expect(doc.querySelector('a.pe-skip')).not.toBeNull();
    for (const link of doc.querySelectorAll('a[target="_blank"]')) {
      expect(link.getAttribute('rel')).toContain('noopener');
    }
  });
});

describe('seguridad del render', () => {  it('escapa HTML procedente de la configuración', () => {
    const view = makeShopView({ product: { name: '<script>alert(1)</script>Phyto' } });
    const doc = parse(renderIndexPage(view));
    const inline = [...doc.querySelectorAll('script')].filter((script) => !script.getAttribute('src'));
    expect(inline.filter((script) => script.type !== 'application/ld+json')).toHaveLength(0);
    expect(doc.body.textContent).toContain('<script>alert(1)</script>Phyto');
  });

  it('noindex se propaga a robots y metadatos', () => {
    const doc = parse(renderIndexPage(makeShopView({ site: { seo: { noindex: true } } })));
    expect(doc.querySelector('meta[name="robots"]').getAttribute('content')).toBe('noindex, nofollow');
  });
});

describe('páginas legales', () => {
  const view = makeShopView({ siteUrl: 'https://phytoemagry.example' });

  it('mantiene placeholders identificados y no se indexan', () => {
    const doc = parse(renderLegalPage(view, { kind: 'privacy' }));
    expect(doc.querySelectorAll('.pe-pending').length).toBeGreaterThan(2);
    expect(doc.querySelector('meta[name="robots"]').getAttribute('content')).toBe('noindex, nofollow');
  });

  it('menciona la medición publicitaria solo si está configurada', () => {
    expect(parse(renderLegalPage(view, { kind: 'privacy' })).body.textContent).toContain(
      'No se instalan cookies de medición publicitaria',
    );
    const conPixel = parse(renderLegalPage(makeShopView({ pixelId: '999' }), { kind: 'privacy' }));
    expect(conPixel.body.textContent).toContain('únicamente después de que aceptes');
  });

  it('los términos describen el proceso real de compra', () => {
    const doc = parse(renderLegalPage(view, { kind: 'terms' }));
    expect(doc.body.textContent).toContain('no procesa pagos');
    expect(doc.body.textContent).toMatch(/a consultar|precios de cada presentación/i);
  });
});

describe('grupos de comunidad por configuración', () => {
  it('los 5 grupos siguen configurados (por si se reactivan)', () => {
    expect(buildGroups(siteConfig.community.groups)).toHaveLength(5);
    // Pero la comunidad está desactivada: no se publica ningún enlace.
    const html = renderIndexPage(makeShopView());
    expect(html).not.toContain('chat.whatsapp.com');
  });
});

describe('despliegue: el Dockerfile y la config de nginx no se separan', () => {
  const repo = (file) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', file), 'utf8');
  const dockerfile = repo('Dockerfile');
  const nginxConf = repo(path.join('nginx', 'phytoemagry.conf'));

  /**
   * Directivas reales de una config de nginx: sin comentarios y con las
   * diferencias a propósito entre contenedor y servidor normalizadas (el
   * contenedor escucha en el puerto que le da el panel: `${PORT}`).
   */
  const directives = (text) =>
    text
      .replaceAll('${PORT}', '80')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.split('  #')[0].trimEnd())
      .map((line) => line.replace(/^server_name .*/, 'server_name X').replace(/^root .*/, 'root X'));

  /** Config de nginx escrita dentro del Dockerfile (heredoc de la etapa 2). */
  const inlineConfig = () => {
    const start = dockerfile.indexOf("<<'NGINX_TEMPLATE'");
    if (start === -1) return '';
    const end = dockerfile.indexOf('\nNGINX_TEMPLATE', start);
    return dockerfile.slice(dockerfile.indexOf('\n', start) + 1, end);
  };

  it('el Dockerfile trae dentro la misma config que nginx/phytoemagry.conf', () => {
    const inline = inlineConfig();
    // Sin esto, cambiar una y olvidar la otra publicaría dos comportamientos.
    expect(inline).toContain('listen ${PORT};');
    expect(directives(inline)).toEqual(directives(nginxConf));
    expect(nginxConf).toContain('root /var/www/phytoemagry;');
    expect(inline).toContain('root /usr/share/nginx/html;');
  });

  it('el puerto de escucha se puede ajustar desde el panel (PORT), con 80 por defecto', () => {
    // Easypanel y otros paneles definen PORT en tiempo de ejecución: si la
    // plantilla no lo usara, el proxy apuntaría a un puerto donde nadie escucha.
    expect(dockerfile).toContain('ENV PORT=80');
    expect(dockerfile).toContain('/etc/nginx/templates/default.conf.template');
    expect(dockerfile).toContain('EXPOSE 80');
  });

  it('la imagen compila, verifica y sirve solo los archivos generados', () => {
    expect(dockerfile).toContain('RUN npm run verify');
    expect(dockerfile).toContain('COPY --from=build /app/dist /usr/share/nginx/html');
    expect(dockerfile).toContain('HEALTHCHECK');
  });

  it('el número de atención tiene valor por defecto: una imagen no sale sin WhatsApp', () => {
    const arg = dockerfile.match(/ARG PHYTO_WHATSAPP_NUMBER="(\d+)"/);
    expect(arg).not.toBeNull();
    expect(arg[1].length).toBeGreaterThanOrEqual(10);
    expect(siteConfig.contact.whatsapp.displayNumber.replace(/\D/g, '')).toBe(arg[1]);
  });
});

describe('atención por WhatsApp: un solo número para todo', () => {
  /** Número de atención (República Dominicana) y cómo se le enseña al visitante. */
  const NUMBER = '18297853794';
  const DISPLAY = '+1 829 785 3794';
  const view = makeShopView({
    whatsapp: NUMBER,
    site: { contact: { whatsapp: { number: NUMBER, displayNumber: DISPLAY } } },
  });
  const html = renderIndexPage(view);
  const doc = parse(html);

  it('TODOS los enlaces de WhatsApp llevan el mismo número de atención', () => {
    const links = [...doc.querySelectorAll('a[href^="https://wa.me/"]')];
    // Hero, cada frasco (7), resumen, CTA final, barra móvil, footer y contacto.
    expect(links.length).toBeGreaterThanOrEqual(8);
    for (const link of links) {
      const href = link.getAttribute('href');
      expect(href.startsWith(`https://wa.me/${NUMBER}?text=`), `revisa ${link.textContent.trim()}`).toBe(true);
    }
    // Y no queda ningún número escrito a mano en el HTML.
    expect(html.replaceAll(NUMBER, '')).not.toMatch(/wa\.me\/\d/);
  });

  it('el número se ve a la vista: da confianza y se puede guardar', () => {
    // Footer (columna de contacto).
    expect(doc.querySelector('#pie').textContent).toContain(DISPLAY);
    // Y en la sección del formulario, como camino directo.
    const contacto = doc.querySelector('#contacto');
    expect(contacto.textContent).toContain(DISPLAY);
    const directo = contacto.querySelector('.pe-direct a[data-action="whatsapp"]');
    expect(directo).not.toBeNull();
    expect(directo.getAttribute('data-source')).toBe('contacto');
    expect(directo.textContent).toContain(DISPLAY);
  });

  it('el número configurado no parece de ejemplo', () => {
    expect(view.whatsapp.enabled).toBe(true);
    expect(view.whatsapp.displayNumber).toBe(DISPLAY);
    expect(view.whatsapp.looksLikePlaceholder).toBe(false);
  });

  it('sin número no aparece ningún CTA de WhatsApp (ni el número visible)', () => {
    const sinNumero = makeShopView({ whatsapp: null });
    const sinDoc = parse(renderIndexPage(sinNumero));
    expect(sinNumero.whatsapp.enabled).toBe(false);
    expect(sinNumero.whatsapp.displayNumber).toBeNull();
    expect(sinDoc.querySelectorAll('a[href^="https://wa.me/"]')).toHaveLength(0);
    expect(sinDoc.querySelector('.pe-direct')).toBeNull();
    expect(sinDoc.body.textContent).not.toContain(DISPLAY);
  });
});
