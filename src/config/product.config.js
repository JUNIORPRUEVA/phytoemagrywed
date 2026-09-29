/**
 * ============================================================================
 *  PHYTOEMAGRY — FICHA DEL PRODUCTO
 * ============================================================================
 *
 *  ⚠️ TODO lo de este archivo debe venir de información OFICIAL y APROBADA del
 *  producto. Mientras un campo esté en `null`, la web lo oculta y la sección
 *  correspondiente no se renderiza (no se muestra información inventada ni
 *  "cifras pendientes" en producción).
 *
 *  Prohibido rellenar con: beneficios médicos, enfermedades tratadas, kg/libras,
 *  plazos de resultados, ingredientes no confirmados, registros sanitarios,
 *  certificaciones, testimonios, garantías de resultados o cifras de éxito.
 *
 *  `npm run check:content` imprime la lista exacta de lo que falta.
 * ============================================================================
 */

export const productConfig = {
  /** Identificador interno estable (no visible). Se envía al CRM. */
  id: 'phytoemagry-v1',

  /** Nombre comercial. */
  name: 'Phytoemagry',

  /** Nombre corto para botones/etiquetas (si es null se usa `name`). */
  shortName: null,

  /** Bajada/subtítulo de una línea. PENDIENTE: usar texto aprobado. */
  subtitle: null,

  /** Descripción corta (hero). Opcional: el hero ya comunica con la portada. */
  shortDescription: null,

  /**
   * Descripción larga (sección "¿Qué es Phytoemagry?").
   * Texto facilitado y aprobado por el negocio. Sin beneficios ni resultados.
   */
  description:
    'Phytoemagry es un producto fitoterápico en cápsulas, diseñado para incorporarse fácilmente a tu rutina diaria.',

  /**
   * Información aprobada adicional, un párrafo por entrada.
   * Ejemplo de forma (NO completar sin fuente oficial):
   *   ['Texto aprobado 1.', 'Texto aprobado 2.']
   */
  approvedInfo: [],

  /** ---------------------------------------------------------- PRESENTACIONES */
  /**
   * PRESENTACIONES REALES (variantes). Cada una tiene su propio precio unitario.
   *
   * MUY IMPORTANTE: las cápsulas son la PRESENTACIÓN, no la cantidad del pedido.
   * Un cliente puede pedir 2 unidades de la presentación de 10 cápsulas
   * (2 × RD$2,500 = RD$5,000): la cantidad de unidades se elige aparte.
   *
   * Reglas:
   *   - `capsules` y `price` son obligatorios (si falta uno, la presentación NO
   *     se muestra).
   *   - `completeBottle: true` solo en el frasco completo (se etiqueta como
   *     "Frasco completo", nunca como "mejor oferta" o "más vendido").
   *   - `image`: ruta base de la foto REAL de esa presentación (null mientras no
   *     exista; nunca se inventa una foto que no corresponda).
   *   - `available: false` oculta la presentación del selector.
   *
   *  Las fotos viven en `assets/fasco <N> capsula.png` y se generan con
   *  `npm run images:frascos` en `public/assets/img/frascos/frasco-<N>-<ancho>.*`
   *  (AVIF + WebP y JPG de reserva). El frasco completo se recorta al centro a
   *  cuadrado para que las 7 tarjetas del carrusel midan lo mismo.
   */
  variants: [
    { id: 'capsules_5', capsules: 5, price: 1250, image: '/assets/img/frascos/frasco-5' },
    { id: 'capsules_7', capsules: 7, price: 1750, image: '/assets/img/frascos/frasco-7' },
    { id: 'capsules_10', capsules: 10, price: 2500, image: '/assets/img/frascos/frasco-10' },
    { id: 'capsules_15', capsules: 15, price: 3750, image: '/assets/img/frascos/frasco-15' },
    { id: 'capsules_20', capsules: 20, price: 5000, image: '/assets/img/frascos/frasco-20' },
    { id: 'capsules_30', capsules: 30, price: 6000, image: '/assets/img/frascos/frasco-30' },
    { id: 'capsules_60', capsules: 60, price: 10000, image: '/assets/img/frascos/frasco-60', completeBottle: true },
  ],
  /** Presentación preseleccionada en el selector (debe existir en `variants`). */
  defaultVariantId: 'capsules_10',

  /** ------------------------------------------------------------------ FORMATO */
  /** Presentación comercial principal (null => se usa el nombre de la variante). */
  presentation: null,
  /** Contenido/cantidad, ej: '60 cápsulas' / '500 ml'. PENDIENTE. */
  contents: null,
  /** Peso/medida si aplica. PENDIENTE. */
  netWeight: null,
  /** Modo de uso aprobado (texto literal de la etiqueta). */
  usage: '1 cápsula al día después del desayuno.',
  /** Advertencias aprobadas de etiqueta. PENDIENTE. */
  warnings: null,

  /** -------------------------------------------------------------- COMPOSICIÓN */
  /** Ingredientes (texto aprobado). PENDIENTE. */
  ingredients: null,
  /** Información nutricional / tabla si aplica. PENDIENTE. */
  nutrition: null,

  /** ------------------------------------------------------------------- PRECIO */
  /**
   * Precio anterior tachado. NO se usa mientras no sea un precio real y vigente:
   * el proyecto prohíbe los descuentos artificiales.
   */
  compareAtPrice: null,
  /** 'in_stock' | 'preorder' | 'out_of_stock' | null (null => no se muestra nada). */
  availability: null,

  /** ------------------------------------------------------------------ IMÁGENES */
  images: {
    /**
     * PORTADA PRINCIPAL: panorama con la línea completa de frascos
     * (5, 7, 10, 15, 20, 30 y 60 cápsulas).
     *
     * Original en `assets/portadaprincipal.png` (1672x941) y versiones web
     * generadas con `python scripts/optimize-hero-image.py` en
     * `public/assets/img/portada-principal-<ancho>.{avif,webp}` + fallback JPG.
     *
     * Se declaran las dimensiones reales para que el render ponga `width`/`height`
     * explícitos (sin CLS) y el `sizes` correcto por breakpoint.
     */
    hero: '/assets/img/portada-principal',
    heroWidth: 1672,
    heroHeight: 941,
    heroWidths: [480, 768, 1200, 1672],
    heroAlt:
      'Frascos de Phytoemagry Composto disponibles en diferentes cantidades de cápsulas.',
    /**
     * FOTOS DE CADA FRASCO (tarjetas del carrusel de "Elige tu frasco").
     *
     * Las 7 fotos son cuadradas (recorte central uniforme) para que ninguna
     * tarjeta quede más alta que otra. Se declaran las dimensiones reales para
     * que el render ponga `width`/`height` explícitos (sin CLS) y el `sizes` de
     * una tarjeta, no el de la pantalla completa.
     */
    variantWidth: 480,
    variantHeight: 480,
    variantWidths: [320, 480],
    /** Imagen de la ficha de producto (sección "producto"). PENDIENTE. */
    presentation: null,
    /**
     * Galería adicional (array de rutas sin extensión). Solo se renderiza si
     * hay archivos: no se rellenan huecos con fotos de otras presentaciones.
     */
    gallery: [],
    /** Texto alternativo por defecto de las demás imágenes. */
    alt: 'Phytoemagry',
  },

  /** ------------------------------------------------------- INFO REGULATORIA */
  /** Registro sanitario / autorización. PENDIENTE (texto literal). */
  regulatory: null,
  /** Fabricante / titular. PENDIENTE. */
  manufacturer: null,
  /** País de origen. PENDIENTE. */
  origin: null,
  /** Certificaciones reales (vacío => no se muestra). */
  certifications: [],
  /** Avísale al consumidor aprobado (disclaimer legal). PENDIENTE. */
  disclaimer: null,
};

export default productConfig;
