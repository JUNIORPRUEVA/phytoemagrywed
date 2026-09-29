/**
 * ============================================================================
 *  PHYTOEMAGRY — CONFIGURACIÓN CENTRAL DEL SITIO
 * ============================================================================
 *
 *  Este es el ÚNICO archivo donde se define:
 *    - marca y datos comerciales
 *    - WhatsApp (número + mensaje)
 *    - SEO / metadatos
 *    - endpoint del mini-CRM
 *    - analítica y Pixel
 *    - datos legales (placeholders hasta tener los reales)
 *
 *  ⚠️ REGLA DEL PROYECTO: si un valor está en `null`, vacío o marcado como
 *  "PENDIENTE", la web NO lo muestra. Nunca se inventa información.
 *
 *  Los valores que empiezan por `env(...)` se pueden sobreescribir con
 *  variables de build del archivo `.env` (ver `.env.example`), para no
 *  tocar código al desplegar.
 *
 *  Ejecuta `npm run check:content` para ver la lista de datos pendientes.
 * ============================================================================
 */

import { envString, isDev } from '../lib/env.js';

export const siteConfig = {
  /** ------------------------------------------------------------------ MARCA */
  brand: {
    name: 'Phytoemagry',
    /** Claim corto. PENDIENTE: solo si existe un texto aprobado. */
    tagline: null,
    /** Ruta a un logo propio (SVG/WebP). Si es null se usa el nombre en texto. */
    logo: null,
    logoAlt: 'Phytoemagry',
    /** Color de marca para meta theme-color (debe coincidir con --pe-brand-700). */
    themeColor: '#0B6B4F',
  },

  /** -------------------------------------------------------------------- SEO */
  seo: {
    /** Dominio final sin barra final. PENDIENTE de confirmar (ej: https://phytoemagry.com). */
    siteUrl: envString('SEO_SITE_URL'),
    /** Título por defecto de la home. Editable. */
    title: 'Phytoemagry | Información del producto y compra directa',
    /** Plantilla de título para páginas internas. */
    titleTemplate: '%s | Phytoemagry',
    /** Meta description (sin claims médicos ni promesas). */
    description:
      'Información de Phytoemagry: presentación, disponibilidad, formas de compra y contacto directo por WhatsApp.',
    /** Imagen Open Graph 1200×630 (ruta en /assets/img). */
    ogImage: '/assets/img/og-phytoemagry.png',
    /** Cuenta de Twitter/X (con @) o null. */
    twitterSite: null,
    locale: 'es',
    /** Si es true añade `noindex` (útil mientras el contenido no está aprobado). */
    noindex: false,
  },

  /** --------------------------------------------------------------- CONTACTO */
  contact: {
    whatsapp: {
      /** SOLO dígitos con código de país, ej: '56912345678'. Vacío => se ocultan los botones de WhatsApp. */
      number: envString('PHYTO_WHATSAPP_NUMBER'),
      /** Mensaje inicial (sin información médica). */
      defaultMessage: 'Hola, estoy interesado/a en recibir información sobre Phytoemagry.',
      /** Adjunta `Ref: <campaña>` al mensaje para identificar el origen del contacto. */
      includeRefInMessage: true,
      /** Horario de atención mostrado junto al CTA (null => no se muestra). */
      hours: null,
      /**
       * Cómo se escribe el número para el visitante (null => solo "WhatsApp").
       * Enseñar el número a la vista da confianza (hay alguien detrás).
       * Debe tener LOS MISMOS dígitos que `number`: `npm run check` lo verifica
       * para que nunca se publique un número distinto del que recibe los pedidos.
       */
      displayNumber: '+1 829 785 3794',
    },
    /** Email comercial visible (null => no se muestra). */
    email: envString('CONTACT_EMAIL'),
  },

  /** --------------------------------------------------------- MINI-CRM / API */
  crm: {
    /**
     * Endpoint público que recibirá `lead` y `order_intent`.
     * Vacío => modo "cola local": los datos se guardan en el navegador y no
     * salen a ningún servidor. Ver docs/CRM-CONTRACT.md.
     */
    endpoint: envString('PHYTO_CRM_ENDPOINT'),
    timeoutMs: 8000,
    /** Ruta de la página de privacidad usada en el consentimiento. */
    consentTextVersion: 'v1',
  },

  /** -------------------------------------------------------------- ANALÍTICA */
  tracking: {
    /** Meta Pixel ID. Vacío => no se carga NINGÚN script de Meta. */
    metaPixelId: envString('PHYTO_META_PIXEL_ID'),
    /** Empuja eventos a window.dataLayer (GTM). Requiere consentimiento. */
    dataLayer: false,
    /** Log en consola de cada evento (solo en build de desarrollo). */
    debug: isDev(),
    /** Guarda una copia local del plan de medición para depurar (últimos 100 eventos). */
    keepLocalLog: true,
  },

  /** ------------------------------------------------------- PRIVACIDAD/LEGAL */
  privacy: {
    /** Páginas legales generadas por el build. */
    privacyPath: '/privacidad.html',
    termsPath: '/terminos.html',
    /** Datos de la empresa. NINGUNO se inventa: los placeholders aparecen marcados como [PENDIENTE]. */
    company: {
      legalName: null,
      taxId: null,
      address: null,
      country: null,
      contactEmail: envString('CONTACT_EMAIL'),
      /** Enlace al aviso legal definitivo (si ya existe externo). */
      policyUrl: null,
    },
    /** Días de conservación de datos indicados en la política (null => texto pendiente). */
    retentionDays: null,
  },

  /** ------------------------------------------------------------- COMERCIO */
  commerce: {
    /** Métodos de pago REALES aceptados (vacío => no se muestra nada). */
    paymentMethods: [],
    /** Información real de entrega/despacho (null => se oculta el bloque). */
    delivery: null,
    /**
     * ENTREGAS — preparado para Higüey y zonas aledañas.
     * NO inventar plazos ni costos: se rellena cuando el negocio lo confirme.
     */
    /** Zonas reales donde se entrega (vacío => no se muestra). */
    deliveryAreas: [],
    /** Mensaje neutral sobre la coordinación de la entrega (null => no se muestra). */
    deliveryMessage: null,
    /** ¿Hay entrega en el punto de venta? true | false | null (null = sin confirmar). */
    pickupAvailable: null,
    /** ¿Hay envío a otras zonas? true | false | null (null = sin confirmar). */
    shippingAvailable: null,
    /** Nota de cobertura/zonas (null => se oculta). */
    deliveryCoverage: null,
    /** Condiciones de cambio/devolución reales (null => se oculta). */
    returns: null,
    /** Moneda e idioma de formato (República Dominicana). */
    currency: 'DOP',
    locale: 'es-DO',
  },

  /** --------------------------------------------------------------- COMUNIDAD */
  /**
   * Grupos de WhatsApp del negocio.
   *
   * ⚠️ DECISIÓN DEL NEGOCIO (2026-09): los grupos NO se publican en la web.
   * El motivo es comercial: cuando el grupo está en la página, el visitante entra
   * al grupo en lugar de escribir directamente, y así se pierde su número de
   * teléfono. Toda la atención va al WhatsApp 1:1 (que sí deja el contacto).
   *
   * Con `enabled: false` la landing NO muestra la sección de comunidad, ni el
   * enlace de la zona de compra, ni la pregunta de la FAQ, ni el acceso en el
   * menú (todo se oculta solo). Los grupos quedan configurados por si se decide
   * reactivar: basta con poner `enabled: true`.
   *
   * status: 'available' | 'almost_full' | 'full' | 'disabled'
   *   - available   → puede recibir gente (es el que se mostraría)
   *   - almost_full → casi lleno (no se muestra automáticamente)
   *   - full        → lleno (no se muestra)
   *   - disabled    → desactivado
   *
   * PENDIENTE (negocio): actualizar `status` a medida que los grupos se llenan.
   */
  community: {
    /** Desactivado a propósito: la comunidad no se publica. */
    enabled: false,
    /**
     * Afirmación sobre el tamaño de la comunidad. El negocio ha comentado que
     * existen "más de 4.000 clientes" repartidos en los grupos, pero es un dato
     * SIN verificar: la landing NO lo publica mientras
     * `memberClaimVerified` no sea exactamente `true`.
     *
     * ⚠️ Nunca se muestra una cifra de clientes/personas ni una promesa de
     * resultados derivada de ella (lo bloquean `content-safety` y los tests).
     *
     * Cuando exista documentación que lo respalde, poner aquí la formulación
     * FACTUAL aprobada y cambiar `memberClaimVerified` a `true`.
     */
    memberClaim: null,
    memberClaimVerified: false,
    groups: [
      {
        id: 'group_1',
        name: 'Comunidad Phytoemagry 1',
        url: 'https://chat.whatsapp.com/DzhnvGqRxwq38CHJc05bGz?mode=gi_t',
        active: true,
        priority: 1,
        status: 'available',
      },
      {
        id: 'group_2',
        name: 'Comunidad Phytoemagry 2',
        url: 'https://chat.whatsapp.com/CrB5NoaCBdIIKBO35bKfrz?mode=ac_t',
        active: true,
        priority: 2,
        status: 'available',
      },
      {
        id: 'group_3',
        name: 'Comunidad Phytoemagry 3',
        url: 'https://chat.whatsapp.com/H4p1nmI1w9x0rGjQ8MvLRK',
        active: true,
        priority: 3,
        status: 'available',
      },
      {
        id: 'group_4',
        name: 'Comunidad Phytoemagry 4',
        url: 'https://chat.whatsapp.com/GWHAEb67e2JA59cQ0H8qRV',
        active: true,
        priority: 4,
        status: 'available',
      },
      {
        id: 'group_5',
        name: 'Comunidad Phytoemagry 5',
        url: 'https://chat.whatsapp.com/Da9M4Zml4p3Kxc3lME8JqC?s=cl&p=a&mlu=4',
        active: true,
        priority: 5,
        status: 'available',
      },
    ],
  },

  /** -------------------------------------------------------- CONFIANZA (claims) */
  /**
   * Afirmación de confianza que SÍ se publica (redactada y aprobada por el
   * negocio). Sustituye a la comunidad como elemento de prueba social.
   *
   * Reglas:
   *  - Solo se muestra si `claimVerified === true`; si se pone en `false`, la
   *    línea desaparece de la web (sin tocar el diseño).
   *  - Solo puede contenerla ESTE campo: si la misma frase se escribe en
   *    cualquier otro texto de la configuración, el detector de afirmaciones
   *    (`npm run check` y los tests) la bloquea.
   *  - ⚠️ No se puede añadir aquí nada sobre resultados, salud o plazos: eso lo
   *    bloquea el detector siempre. Solo una afirmación factual de uso/adopción.
   *
   * Recomendación: poder demostrar la cifra (facturas, base de clientes, CRM)
   * por si una plataforma publicitaria o un consumidor la cuestiona.
   */
  trust: {
    claim: 'Miles de personas ya cuentan con Phytoemagry.',
    claimVerified: true,
  },

  /** ------------------------------------------------------- COMPORTAMIENTO UI */
  features: {
    /** Si no hay precio configurado se muestra "Consultar precio" en lugar de una cifra. */
    showPriceWhenUnknown: true,
    /** Barra fija inferior con CTA en móvil (recomendado para tráfico pagado). */
    showMobileCtaBar: true,
    /** Scroll suave a anclas (respeta prefers-reduced-motion). */
    smoothScroll: true,
    /** Cantidad máxima de unidades por pedido. */
    maxQuantity: 10,
    /** Cantidad mínima de unidades por pedido. */
    minQuantity: 1,

    /**
     * QUÉ BLOQUES SE PUBLICAN.
     *
     * La web debe ser lo más ligera posible: el cliente ve la información del
     * producto y pasa a comprar, sin bloques que repitan lo mismo.
     *
     * Cada bloque se enciende/apaga aquí (no hay que tocar código):
     *   true  → se publica
     *   false → no se renderiza (desaparece el bloque y su enlace del menú)
     *
     * Contenido actual, y por qué:
     *  - product   : qué es el producto + modo de uso + confianza. IMPRESCINDIBLE.
     *  - frascos   : los 7 tamaños con su precio y el paso a la compra. IMPRESCINDIBLE.
     *  - faq       : objeciones reales con datos reales. IMPRESCINDIBLE.
     *  - leadForm  : deja el contacto quien todavía no quiere pedir (captura el
     *                número). Recomendado.
     *  - finalCta  : cierre de página con los dos CTA. Recomendado.
     *  - howToBuy  : los 4 pasos. DESACTIVADO: el proceso ya se explica en el
     *                propio selector ("elige tu frasco → Comprar/WhatsApp →
     *                confirma") y en la FAQ, así que solo añadía carga visual.
     */
    sections: {
      product: true,
      frascos: true,
      faq: true,
      leadForm: true,
      finalCta: true,
      howToBuy: false,
    },
  },
};

export default siteConfig;
