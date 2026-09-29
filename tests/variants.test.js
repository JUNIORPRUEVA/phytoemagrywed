/**
 * PRESENTACIONES: precios reales, totales y coherencia de configuración.
 *
 * Los totales son la parte crítica del negocio: una cápsula mal contada o un
 * precio mal multiplicado se convierte en un pedido equivocado.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { productConfig } from '../src/config/product.config.js';
import { formatPrice } from '../src/lib/format.js';
import {
  buildVariants,
  cheapestVariant,
  findVariant,
  normalizeVariant,
  validateVariants,
  variantTotals,
} from '../src/lib/variants.js';
import { makeShopView } from './helpers.js';

/** Precios oficiales facilitados por el negocio. */
const OFFICIAL_PRICES = {
  5: 1250,
  7: 1750,
  10: 2500,
  15: 3750,
  20: 5000,
  30: 6000,
  60: 10000,
};

describe('configuración real de presentaciones', () => {
  const view = makeShopView();
  const variants = view.pricing.variants;

  it('hay exactamente 7 presentaciones, de menos a más cápsulas', () => {
    expect(variants).toHaveLength(7);
    expect(variants.map((variant) => variant.capsules)).toEqual([5, 7, 10, 15, 20, 30, 60]);
  });

  it('cada presentación tiene su precio oficial exacto', () => {
    for (const variant of variants) {
      expect(variant.price, `precio de ${variant.name}`).toBe(OFFICIAL_PRICES[variant.capsules]);
    }
  });

  it('formatea los precios en pesos dominicanos tal como los escribe el negocio', () => {
    expect(formatPrice(1250, { currency: 'DOP', locale: 'es-DO' })).toBe('RD$1,250');
    expect(formatPrice(1750, { currency: 'DOP', locale: 'es-DO' })).toBe('RD$1,750');
    expect(formatPrice(2500, { currency: 'DOP', locale: 'es-DO' })).toBe('RD$2,500');
    expect(formatPrice(3750, { currency: 'DOP', locale: 'es-DO' })).toBe('RD$3,750');
    expect(formatPrice(5000, { currency: 'DOP', locale: 'es-DO' })).toBe('RD$5,000');
    expect(formatPrice(6000, { currency: 'DOP', locale: 'es-DO' })).toBe('RD$6,000');
    expect(formatPrice(10000, { currency: 'DOP', locale: 'es-DO' })).toBe('RD$10,000');
  });

  it('identifica el frasco completo sin etiquetas comerciales engañosas', () => {
    const complete = variants.filter((variant) => variant.completeBottle);
    expect(complete).toHaveLength(1);
    expect(complete[0].capsules).toBe(60);
    expect(complete[0].price).toBe(10000);
    expect(view.content.selector.completeBottleLabel).toBe('Frasco completo');
  });

  it('el "Desde" usa la presentación más económica real', () => {
    expect(cheapestVariant(variants).capsules).toBe(5);
    expect(view.pricing.fromLabel).toBe('RD$1,250');
  });

  it('no hay descuentos ni precios tachados inventados', () => {
    expect(productConfig.compareAtPrice).toBeNull();
    expect(view.pricing.compareAt).toBeNull();
    expect(Object.keys(productConfig)).not.toContain('price');
  });

  it('la configuración de presentaciones es coherente', () => {
    expect(validateVariants(buildVariants(productConfig, { currency: 'DOP', locale: 'es-DO' }))).toEqual([]);
  });
});

describe('fotos de los frascos (tarjetas del carrusel)', () => {
  const view = makeShopView();

  it('cada frasco declara su propia foto real', () => {
    // Una tarjeta sin foto propia o con la ruta de otro frasco es un error visible.
    for (const variant of view.pricing.variants) {
      expect(variant.image, `foto de ${variant.name}`).not.toBeNull();
      expect(variant.image.base).toBe(`/assets/img/frascos/frasco-${variant.capsules}`);
      expect(variant.image.alt).toBe(`Phytoemagry — ${variant.name}`);
    }
    const bases = view.pricing.variants.map((variant) => variant.image.base);
    expect(new Set(bases).size).toBe(bases.length);
  });

  it('las 7 fotos son cuadradas y del mismo tamaño declarado', () => {
    for (const variant of view.pricing.variants) {
      expect(variant.image.width).toBe(productConfig.images.variantWidth);
      expect(variant.image.height).toBe(productConfig.images.variantHeight);
      expect(variant.image.width).toBe(variant.image.height);
      expect(variant.image.widths).toEqual(productConfig.images.variantWidths);
    }
  });

  it('existen los archivos generados (AVIF y WebP de cada ancho + JPG de reserva)', () => {
    // Se comprueba en `public/`: si falta un archivo, la tarjeta queda rota.
    // Se generan con: `npm run images:frascos`.
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
    for (const variant of view.pricing.variants) {
      for (const width of variant.image.widths) {
        for (const ext of ['avif', 'webp']) {
          const file = path.join(dir, variant.image.file(width, ext));
          expect(existsSync(file), `falta ${variant.image.file(width, ext)}`).toBe(true);
        }
      }
      expect(existsSync(path.join(dir, variant.image.fallback())), `falta ${variant.image.fallback()}`).toBe(true);
    }
  });
});

describe('cálculo de totales: presentación × unidades', () => {
  const view = makeShopView();
  const total = (variantId, quantity) => view.pricing.forVariant(variantId, quantity);

  it('1 unidad de cada presentación vale su precio', () => {
    for (const [capsules, price] of Object.entries(OFFICIAL_PRICES)) {
      const totals = total(`capsules_${capsules}`, 1);
      expect(totals.total, `${capsules} cápsulas × 1`).toBe(price);
      expect(totals.unitPrice).toBe(price);
    }
  });

  it('multiplica correctamente: 10 × 2 = RD$5,000', () => {
    const totals = total('capsules_10', 2);
    expect(totals.unitPrice).toBe(2500);
    expect(totals.quantity).toBe(2);
    expect(totals.total).toBe(5000);
    expect(totals.totalLabel).toBe('RD$5,000');
    // 2 unidades de la presentación de 10 cápsulas = 20 cápsulas
    expect(totals.totalCapsules).toBe(20);
  });

  it('multiplica correctamente: 30 × 2 = RD$12,000', () => {
    const totals = total('capsules_30', 2);
    expect(totals.total).toBe(12000);
    expect(totals.totalLabel).toBe('RD$12,000');
    expect(totals.totalCapsules).toBe(60);
  });

  it('multiplica correctamente: 60 × 2 = RD$20,000', () => {
    const totals = total('capsules_60', 2);
    expect(totals.total).toBe(20000);
    expect(totals.totalLabel).toBe('RD$20,000');
    expect(totals.totalCapsules).toBe(120);
  });

  it('las cápsulas NUNCA se mezclan con la cantidad de unidades', () => {
    const totals = total('capsules_60', 3);
    expect(totals.capsules).toBe(60);
    expect(totals.quantity).toBe(3);
    expect(totals.total).toBe(30000);
    expect(totals.totalCapsules).toBe(180);
  });

  it('acota la cantidad al rango permitido por la configuración', () => {
    expect(total('capsules_5', 0).quantity).toBe(1);
    expect(total('capsules_5', 99).quantity).toBe(10);
    expect(total('capsules_5', 'dos').quantity).toBe(1);
  });

  it('no inventa precio si la presentación no existe', () => {
    const totals = total('capsules_999', 1);
    // findVariant no la encuentra: se usa la presentación de referencia (comportamiento seguro)
    expect(totals.total).toBe(1250);
    // Y sin frasco elegido no hay precio en absoluto (el resumen arranca vacío).
    const empty = variantTotals(null, 2, { currency: 'DOP', locale: 'es-DO' });
    expect(empty.total).toBeNull();
    expect(empty.totalLabel).toBeNull();
    expect(empty.hasPrice).toBe(false);
    expect(empty.totalCapsules).toBeNull();
  });
});

describe('normalización de presentaciones', () => {
  it('descarta presentaciones sin precio o sin cápsulas (nunca se muestran)', () => {
    expect(normalizeVariant({ capsules: 10, price: null })).toBeNull();
    expect(normalizeVariant({ capsules: 10 })).toBeNull();
    expect(normalizeVariant({ price: 2500 })).toBeNull();
    expect(normalizeVariant({ capsules: 0, price: 2500 })).toBeNull();
    expect(normalizeVariant(null)).toBeNull();
  });

  it('deriva id y nombre cuando no se indican', () => {
    const variant = normalizeVariant({ capsules: 12, price: 3000 });
    expect(variant.id).toBe('capsules_12');
    expect(variant.name).toBe('12 cápsulas');
    expect(variant.priceLabel).toBe('RD$3,000');
  });

  it('respeta la disponibilidad y las fotos reales', () => {
    const hidden = normalizeVariant({ capsules: 5, price: 1250, available: false });
    expect(hidden.available).toBe(false);
    const withImage = normalizeVariant({ capsules: 10, price: 2500, image: '/assets/img/frasco-10' });
    expect(withImage.image).toBe('/assets/img/frasco-10');
    expect(normalizeVariant({ capsules: 10, price: 2500 }).image).toBeNull();
  });

  it('detecta configuraciones incoherentes', () => {
    const problems = validateVariants(
      buildVariants(
        {
          variants: [
            { id: 'a', capsules: 10, price: 2500, completeBottle: true },
            { id: 'a', capsules: 5, price: 1250 },
            { capsules: 60, price: 10000, completeBottle: true },
          ],
        },
        { currency: 'DOP', locale: 'es-DO', dedupe: false },
      ),
    );
    const text = problems.join(' ');
    expect(text).toMatch(/duplicada/i);
    expect(text).toMatch(/frasco completo/i);
    expect(text).toMatch(/ordenadas/i);
  });

  it('el render siempre deduplica aunque la validación conserve los duplicados', () => {
    const product = { variants: [{ id: 'a', capsules: 10, price: 2500 }, { id: 'a', capsules: 10, price: 2500 }] };
    expect(buildVariants(product, { dedupe: false })).toHaveLength(2);
    expect(buildVariants(product)).toHaveLength(1);
  });

  it('findVariant devuelve null con identificadores desconocidos', () => {
    const variants = buildVariants(productConfig, { currency: 'DOP', locale: 'es-DO' });
    expect(findVariant(variants, 'capsules_10')?.capsules).toBe(10);
    expect(findVariant(variants, 'no-existe')).toBeNull();
    expect(findVariant(variants, '')).toBeNull();
  });
});
