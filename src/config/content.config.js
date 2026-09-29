/**
 * ============================================================================
 *  PHYTOEMAGRY — TEXTOS EDITABLES (copy)
 * ============================================================================
 *
 *  Aquí vive TODO el texto visible: navegación, títulos, botones, formularios,
 *  pasos de compra, FAQ y mensajes de error.
 *
 *  Criterio aplicado en los valores por defecto:
 *   - Solo se ha escrito copy de PROCESO (cómo comprar, cómo contactar).
 *   - Nada de claims médicos, resultados, plazos, ingredientes ni testimonios.
 *   - Las listas que requieren información aprobada (`features`, `testimonials`,
 *     `faq` de producto) están VACÍAS: no se muestran hasta que exista el dato.
 *
 *  Para cambiar cualquier frase basta con editar este archivo y volver a
 *  ejecutar `npm run build`.
 * ============================================================================
 */

export const contentConfig = {
  /** --------------------------------------------------------------- NAVEGACIÓN */
  nav: {
    links: [
      { label: 'Información', href: '#producto' },
      { label: 'Frascos', href: '#frascos' },
      /**
       * `requires: 'steps'` = el enlace solo aparece si el bloque "Cómo comprar"
       * se publica (`site.config.js` → features.sections.howToBuy).
       */
      { label: 'Cómo comprar', href: '#como-comprar', requires: 'steps' },
      { label: 'Preguntas', href: '#preguntas' },
      /**
       * `requires: 'community'` = el enlace solo aparece si esa sección se
       * publica. La comunidad está desactivada en `site.config.js`
       * (`community.enabled: false`), así que este enlace no se muestra; al
       * reactivarla vuelve solo.
       */
      { label: 'Comunidad', href: '#comunidad', requires: 'community' },
      { label: 'Contacto', href: '#contacto' },
    ],
    /** Etiqueta del botón del header (siempre visible). */
    cta: 'Comprar',
    menuLabel: 'Abrir menú',
  },

  /** -------------------------------------------------------------------- HERO */
  /**
   * La portada es la IMAGEN (panorámica con la línea completa de frascos), que
   * ya incluye el nombre del producto y los tamaños. Por eso aquí solo va el
   * copy comercial mínimo: una frase, el precio inicial y dos CTA.
   */
  hero: {
    /**
     * Nombre del producto. Se usa en el `<h1>` para SEO y lectores de pantalla,
     * pero NO se muestra: el nombre ya está dentro de la imagen.
     */
    title: 'Phytoemagry',
    /** Frase corta bajo la portada (una línea, sin promesas). */
    lead: 'Encuentra el frasco que mejor se adapte a lo que buscas.',
    /** CTA principal: baja a la sección "Elige tu frasco". */
    ctaPrimary: 'Ver frascos y precios',
    /** CTA secundario: abre WhatsApp (también es la etiqueta por defecto). */
    ctaSecondary: 'Consultar por WhatsApp',
    /** Etiquetas usadas por el bloque de precio. */
    labels: {
      from: 'Desde',
      priceOnRequest: 'Consultar precio',
      presentation: 'Frasco',
      presentations: 'Frascos',
      price: 'Precio',
      availability: 'Disponibilidad',
      contents: 'Contenido',
    },
  },

  /** ------------------------------------------------------- SELECTOR DE FRASCOS */
  selector: {
    title: 'Elige tu frasco',
    subtitle:
      'Desliza las fotos, mira el precio de cada frasco y pide el tuyo por WhatsApp.',
    /**
     * Ayuda de deslizamiento del carrusel horizontal. Se muestra solo en móvil
     * (en escritorio se ven varias tarjetas a la vez y hay flechas).
     */
    swipeHint: 'Desliza para ver los frascos',
    /** Etiquetas de accesibilidad de las flechas del carrusel. */
    carousel: {
      prev: 'Ver los frascos anteriores',
      next: 'Ver los siguientes frascos',
    },
    /**
     * Etiqueta del frasco completo. Marca neutra de identificación: NO es
     * "mejor oferta", "más vendido" ni "recomendado".
     */
    completeBottleLabel: 'Frasco completo',
    /** Prefijo de cada tarjeta: "Frasco de" + "10 cápsulas" + precio. */
    cardPrefix: 'Frasco de',
    /**
     * Botón de cada tarjeta: manda a WhatsApp el pedido completo de ESE frasco
     * (producto, frasco, cantidad, precio y total). Es el botón principal del
     * carrusel, por eso no se usa un texto genérico.
     */
    cardCta: 'Pedir por WhatsApp',
    /** Etiqueta cuando un frasco no tiene precio público. */
    priceOnRequest: 'Consultar precio',
    /** Se muestra en el resumen mientras el visitante no ha elegido frasco. */
    notChosen: 'Elige tu frasco',
    /** Aviso cuando pulsa Comprar (o pedir) sin haber elegido frasco. */
    chooseFirst: 'Elige primero tu frasco: toca la foto del que quieras.',
    /** Recordatorio bajo el resumen vacío. */
    orderEmpty: 'Toca el frasco que quieras para ver su precio y el total.',
    labels: {
      selected: 'Frasco elegido',
      unitPrice: 'Precio por frasco',
      quantity: 'Cantidad de frascos',
      quantityHint: (max) => `Máximo ${max} frascos por pedido.`,
      totalCapsules: 'Cápsulas en total',
      total: 'Total',
      capsules: 'cápsulas',
      decrease: 'Quitar un frasco',
      increase: 'Añadir un frasco',
    },
    ctaBuy: 'Comprar / Consultar',
    ctaWhatsApp: 'Pedir por WhatsApp',
    /**
     * Nota bajo el resumen del pedido: deja claro que la web solo prepara el
     * pedido y que el pedido se FINALIZA en WhatsApp (ahí se confirma y se paga).
     */
    note:
      'El pedido se finaliza por WhatsApp: al pulsar «Comprar» se abre el chat con tu frasco, la cantidad y el total ya escritos. No se realiza ningún cobro en esta página.',
    /**
     * Enlace discreto a la comunidad junto a la zona de compra: engancha al
     * visitante que todavía no está listo para comprar (no es un Lead).
     */
    communityLink: {
      lead: '¿Todavía tienes preguntas?',
      label: 'Conoce la comunidad',
      href: '#comunidad',
    },
    /**
     * Camino de CLIENTE POTENCIAL junto a la compra: quien no quiere pedir hoy
     * puede dejar su contacto y se le escribe por WhatsApp. Es la diferencia
     * entre perder la visita y tener un contacto al que dar seguimiento.
     */
    contactLink: {
      lead: '¿Todavía no estás seguro?',
      label: 'Déjanos tu contacto y te escribimos',
      href: '#contacto',
    },
  },

  /** --------------------------------------------------------------- COMUNIDAD */
  community: {
    /** Etiqueta pequeña sobre el título. */
    eyebrow: 'Comunidad de WhatsApp',
    title: '¿Todavía tienes preguntas? Conoce nuestra comunidad',
    text: 'Antes de decidir, puedes unirte a uno de nuestros grupos de WhatsApp, conocer experiencias compartidas por miembros de la comunidad y hacer las preguntas que necesites.',
    secondText: 'Es un espacio donde puedes informarte, conversar y conocer de primera mano lo que otros miembros deciden compartir sobre su experiencia.',
    cta: 'Unirme al grupo de WhatsApp',
    /** Microcopy bajo el CTA. */
    ctaNote: 'Puedes entrar, conocer la comunidad y realizar tus preguntas.',
    /**
     * Tarjetas de apoyo (icono + texto). Hablan del ESPACIO, nunca de
     * resultados ni de propiedades del producto.
     */
    cards: [
      {
        icon: 'help',
        title: 'Haz tus preguntas',
        text: 'Pregunta lo que necesites antes de decidir.',
      },
      {
        icon: 'chat',
        title: 'Conversa con la comunidad',
        text: 'Conoce lo que otros miembros comparten sobre su experiencia.',
      },
      {
        icon: 'users',
        title: 'Información y acompañamiento',
        text: 'Un espacio para informarte y conversar con calma.',
      },
    ],
    /**
     * Aviso obligatorio: la comunidad no es evidencia médica ni garantiza nada.
     * No eliminar mientras no exista una revisión legal diferente.
     */
    disclaimer:
      'La comunidad es un espacio de conversación entre clientes: no sustituye la información médica ni garantiza resultados.',
  },

  /** -------------------------------------------------------- INFO DEL PRODUCTO */
  product: {
    title: '¿Qué es Phytoemagry?',
    /** Texto de apoyo cuando aún no hay descripción oficial aprobada. */
    pendingNotice: 'Estamos completando la información oficial de este producto.',    /**
     * Etiqueta accesible de la línea de confianza (icono + afirmación).
     * El texto de la afirmación vive en `site.config.js` → `trust.claim`.
     */
    trustLabel: 'Confianza',    /** Bloques de información aprobada (título + texto). Vacío => oculto. */
    blocks: [],
  },

  /** ----------------------------------------------------------- CARACTERÍSTICAS */
  features: {
    title: 'Información relevante',
    subtitle: null,
    /**
     * ⚠️ VACÍO A PROPÓSITO.
     * Solo rellenar con información APROBADA (formato, contenido, modo de uso,
     * conservación, origen...). Nunca con beneficios médicos o resultados.
     * Forma: { title: 'Texto', text: 'Detalle aprobado.', icon: 'leaf' }
     */
    items: [],
    /** Iconos disponibles: leaf, shield, package, truck, clock, heart, check, info */
  },

  /** -------------------------------------------------------------- PRESENTACIÓN */
  presentation: {
    title: 'Frasco',
    cta: 'Comprar este frasco',
    /** Etiquetas de la ficha técnica. Los valores salen de `product.config.js`. */
    labels: {
      presentation: 'Frasco',
      contents: 'Contenido',
      netWeight: 'Peso neto',
      usage: 'Modo de uso',
      ingredients: 'Ingredientes',
      origin: 'Origen',
      manufacturer: 'Fabricante',
      regulatory: 'Registro sanitario',
      availability: 'Disponibilidad',
      price: 'Precio',
      priceOnRequest: 'Consultar precio',
    },
    /** Estado de stock legible por clave de `productConfig.availability`. */
    availability: {
      in_stock: 'Disponible',
      preorder: 'Preventa',
      out_of_stock: 'Sin stock por ahora',
    },
  },

  /** ------------------------------------------------------------- CÓMO COMPRAR */
  howToBuy: {
    title: 'Cómo comprar',
    subtitle: 'Cuatro pasos, sin registros ni formularios largos.',
    steps: [
      { title: 'Elige tu frasco', text: 'Mira la información del producto y el precio de cada frasco.' },
      { title: 'Pulsa Comprar o WhatsApp', text: 'Elige la cantidad de frascos o escríbenos directamente.' },
      { title: 'Confirma tu pedido', text: 'Te pedimos solo tu nombre, teléfono y ubicación.' },
      { title: 'Coordinamos pago y entrega', text: 'Confirmamos disponibilidad, forma de pago y entrega.' },
    ],
    note: 'No se realiza ningún cobro en esta página.',
  },

  /** --------------------------------------------------------------------- FAQ */
  faq: {
    title: 'Preguntas frecuentes',
    subtitle: null,
    /**
     * Preguntas GENERADAS con datos reales (precios y frascos salen de
     * `productConfig.variants`, no se escriben a mano).
     */
    generated: {
      presentations: {
        question: '¿Qué frascos están disponibles?',
        /** {list} = "5, 7, 10, 15, 20, 30 y 60" */
        answer: 'Están disponibles estos frascos: {list} cápsulas.',
      },
      price: {
        question: '¿Cuál es el precio?',
        /** {prices} = "Frasco de 5 cápsulas: RD$1,250 · Frasco de 10 cápsulas: RD$2,500 · …" */
        answer: 'Estos son los precios por frasco: {prices}. El precio final se confirma por WhatsApp al coordinar tu pedido.',
      },
      quantity: {
        question: '¿Puedo pedir más de un frasco?',
        answer:
          'Sí. Puedes elegir el frasco y la cantidad de frascos que necesites (por ejemplo, 2 frascos de 10 cápsulas). El total se calcula automáticamente en el selector.',
      },
      community: {
        question: '¿Tienen comunidad de apoyo?',
        answer:
          'Sí. Mantenemos grupos de WhatsApp como espacio de información, preguntas y conversación entre clientes. Puedes unirte desde la sección “Conoce nuestra comunidad”.',
      },
      delivery: {
        question: '¿Cómo se coordina la entrega?',
        /** {areas} (si hay zonas configuradas) o texto neutral de coordinación. */
        answer: 'Al confirmar tu pedido coordinamos el pago y la entrega por WhatsApp.{areas}',
      },
    },
    /**
     * Preguntas estáticas: SOLO el proceso de compra (no requieren información
     * del producto).
     *
     * Se mantiene UNA: es la que explica cómo pedir ahora que el bloque de
     * "Cómo comprar" está desactivado (la web debe ser lo menos cargada posible).
     * Las otras (datos necesarios, cobros, pago y entrega) repetían lo que ya
     * dicen el propio selector, el modal y la nota de "no se realiza ningún
     * cobro", así que se retiraron.
     */
    items: [
      {
        question: '¿Cómo realizo mi pedido?',
        answer:
          'Elige tu frasco en la sección “Elige tu frasco”, pulsa “Comprar / Consultar”, deja tu nombre, teléfono y ubicación, y confirma. Continuamos por WhatsApp para coordinar el pago y la entrega. En esta página no se realiza ningún cobro.',
      },
    ],
  },

  /** -------------------------------------------------------------- TESTIMONIOS */
  testimonials: {
    title: 'Opiniones de clientes',
    subtitle: null,
    /**
     * ⚠️ SOLO testimonios reales y con consentimiento explícito.
     * Forma: { name: 'María G.', text: 'Comentario real.', date: '2026-05-10', photo: '/assets/img/x.webp' }
     * Prohibido incluir afirmaciones médicas o resultados.
     */
    items: [],
    /**
     * Aviso obligatorio cuando se muestran testimonios (evita interpretaciones
     * como promesa de resultados). Editable por el responsable legal.
     */
    disclaimer: null,
  },

  /** --------------------------------------------------------------- FORMULARIO */
  leadForm: {
    title: '¿Quieres que te enviemos la información?',
    subtitle: 'Déjanos tu contacto y te escribimos por WhatsApp. Sin compromiso.',
    labels: {
      name: 'Nombre',
      phone: 'WhatsApp o teléfono',
      location: 'Ubicación (ciudad/país)',
      locationOptional: 'opcional',
      consent:
        'Autorizo que Phytoemagry me contacte por WhatsApp o teléfono para enviarme información del producto.',
      submit: 'Quiero recibir información',
      privacyPrefix: 'He leído y acepto la',
      privacyLink: 'política de privacidad',
      honeypot: 'No rellenar este campo',
    },
    placeholders: {
      name: 'Ej: María González',
      phone: 'Ej: 809 123 4567',
      location: 'Ej: Higüey, La Altagracia',
    },
    success: {
      title: '¡Gracias! Recibimos tus datos.',
      text: 'Te contactaremos por WhatsApp al número que nos dejaste.',
      /**
       * Botón de WhatsApp tras enviar el formulario: lleva el contacto del
       * visitante ya escrito (nombre, teléfono y ubicación). Si el navegador
       * bloqueó la pestaña automática, este botón es el camino para que el
       * mensaje llegue igual.
       */
      cta: 'Enviar mis datos por WhatsApp',
      fallbackNote: '¿No se abrió WhatsApp? Pulsa el botón y te llegará con tus datos escritos.',
    },
    errorSummary: 'Revisa los campos marcados.',
    /**
     * Camino directo para quien prefiere preguntar ANTES de dejar sus datos.
     * Muestra el número real a la vista: es la señal de confianza más simple
     * (detrás de la web hay una persona que responde).
     */
    direct: {
      lead: '¿Prefieres preguntar antes?',
      cta: 'Escribir por WhatsApp',
    },
  },

  /** --------------------------------------------------------- MODAL DE COMPRA */
  checkout: {
    title: 'Hacer tu pedido',
    closeLabel: 'Cerrar',
    /** Una sola frase: lo mínimo y qué pasa después. */
    intro: 'Escribe tu nombre y seguimos en WhatsApp para confirmar tu pedido.',
    /** Se muestra cuando no hay ningún frasco elegido. */
    needVariant: 'Elige tu frasco antes de continuar.',
    labels: {
      name: 'Tu nombre',
      product: 'Producto',
      presentation: 'Frasco',
      unitPrice: 'Precio por frasco',
      quantity: 'Cantidad de frascos',
      totalCapsules: 'Cápsulas en total',
      total: 'Total',
      priceOnRequest: 'A confirmar por WhatsApp',
      notChosen: 'Sin elegir',
      changeVariant: 'Cambiar frasco',
      /**
       * Aviso informativo (sin casilla): el pedido se cierra en WhatsApp y es
       * la propia persona quien inicia la conversación.
       */
      consent:
        'Al continuar se abre WhatsApp con tu pedido escrito: allí lo confirmamos y coordinamos pago y entrega.',
    },
    quantityHint: (max) => `Máximo ${max} frascos por pedido.`,
    submit: 'Continuar el pedido en WhatsApp',
    submitFallback: 'Enviar solicitud',
    note: 'El pedido se finaliza por WhatsApp. En esta página no se realiza ningún cobro.',
    /** Texto mostrado cuando no hay número de WhatsApp configurado. */
    whatsappUnavailable: 'Número de WhatsApp pendiente de configurar.',
    successTitle: 'Pedido preparado',
    successMessage: 'Envíalo por WhatsApp: ahí confirmamos disponibilidad, pago y entrega.',
  },

  /** ------------------------------------------------------------ CTA FINAL */
  finalCta: {
    title: 'Compra Phytoemagry',
    text: 'Elige tu frasco y confirma tu pedido, o consulta por WhatsApp.',
    ctaPrimary: 'Comprar / Consultar',
    ctaSecondary: 'Escribir por WhatsApp',
    /** Enlace secundario al selector de frascos. */
    linkToSelector: 'Ver los 7 frascos',
  },

  /** --------------------------------------------------------------- FOOTER */
  footer: {
    about: null, // Texto corto de la empresa. PENDIENTE si no existe.
    contactTitle: 'Contacto',
    legalTitle: 'Legal',
    commerceTitle: 'Pago y entrega',
    rights: `© ${new Date().getFullYear()} Phytoemagry. Todos los derechos reservados.`,
    /** Aviso obligatorio de producto (PENDIENTE: texto aprobado). */
    disclaimer: null,
  },

  /** ----------------------------------------------------- BANNER DE COOKIES */
  consent: {
    title: 'Medición publicitaria',
    text: 'Usamos cookies de medición para saber qué anuncio funciona. Puedes rechazarlas y la web seguirá funcionando igual.',
    accept: 'Aceptar',
    reject: 'Rechazar',
    privacyLink: 'Política de privacidad',
  },

  /** --------------------------------------------------------- MENSAJES DE ERROR */
  errors: {
    name_required: 'Escribe tu nombre.',
    name_too_short: 'El nombre es demasiado corto.',
    phone_required: 'Escribe un número de WhatsApp o teléfono.',
    phone_invalid: 'Ese número no parece válido.',
    phone_too_short: 'El número es demasiado corto (incluye el código de país).',
    phone_too_long: 'El número es demasiado largo.',
    location_required: 'Indica tu ciudad o país para coordinar la entrega.',
    consent_required: 'Necesitamos tu autorización para poder contactarte.',
    quantity_required: 'Indica una cantidad.',
    quantity_too_low: 'La cantidad mínima es 1.',
    quantity_too_high: 'La cantidad supera el máximo permitido.',
    generic: 'No pudimos procesar el envío, pero tus datos se guardaron. Escríbenos por WhatsApp.',
  },

  /** -------------------------------------------------- MENSAJES DE WHATSAPP */
  whatsapp: {
    /** Mensaje del CTA general (hero, footer, barra móvil). */
    general: 'Hola, estoy interesado/a en Phytoemagry.',
    /**
     * Mensaje de TODOS los botones de pedido (cada tarjeta del carrusel y el
     * resumen): es texto + los datos del pedido que añade `lib/whatsapp.js`.
     */
    checkout: 'Hola, quiero confirmar este pedido de Phytoemagry.',
    /**
     * Mensaje cuando alguien deja sus datos en el formulario: así el contacto
     * llega al WhatsApp del negocio con nombre, teléfono y ubicación.
     */
    lead: 'Hola, quiero recibir información sobre Phytoemagry.',
    /** Mensaje del CTA de comunidad (los grupos NO son un canal de pedidos). */
    community: 'Hola, quiero unirme a la comunidad de Phytoemagry.',
    labels: {
      product: 'Producto',
      presentation: 'Frasco',
      capsules: 'Cápsulas',
      quantity: 'Cantidad',
      units: 'frascos',
      unitPrice: 'Precio por frasco',
      total: 'Total',
      name: 'Nombre',
      phone: 'WhatsApp o teléfono',
      location: 'Ubicación',
      ref: 'Ref',
    },
  },

  /** -------------------------------------------------------------- ACCESIBILIDAD */
  a11y: {
    skipToContent: 'Saltar al contenido principal',
    priceOnRequestAria: 'Precio a consultar por WhatsApp',
    externalLink: '(se abre en una pestaña nueva)',
  },

  /** ------------------------------------------------------------------- LEGAL */
  legal: {
    privacyTitle: 'Política de privacidad',
    termsTitle: 'Términos y condiciones',
    /** Marca visual de los datos que faltan por completar. */
    pendingLabel: '[PENDIENTE]',
    privacyIntro:
      'Esta página es una plantilla. Los apartados marcados como [PENDIENTE] deben ser completados y validados antes de publicar la web.',
    termsIntro:
      'Esta página es una plantilla. Los apartados marcados como [PENDIENTE] deben ser completados y validados antes de publicar la web.',
  },
};

export default contentConfig;
