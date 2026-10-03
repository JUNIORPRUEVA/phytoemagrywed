/*
 * Panel de Phytoemagry (mini-CRM) — lógica del panel.
 *
 * Sin framework y sin dependencias: un archivo, servido desde el propio dominio.
 * Todo pasa por `/api/admin/*` (con la cookie de sesión) y funciona con el
 * service worker: si el móvil se queda sin datos, el panel abre con la última
 * copia y los cambios se envían solos al recuperar la conexión.
 */

(() => {
  'use strict';

  const SNAPSHOT_KEY = 'pe_crm_snapshot';
  const OUTBOX_KEY = 'pe_crm_outbox';
  const TAB_KEY = 'pe_crm_tab';
  const WA_NOTIFY_KEY = 'pe_wa_notify';
  const WA_SOUND_KEY = 'pe_wa_sound';
  const NOTICE_DISMISSED_KEY = 'pe_notice_dismissed';
  /*
   * MAPA DE PEDIDOS: la última vista del mapa y los últimos puntos vistos se
   * guardan en el teléfono. Así el mapa se pinta AL INSTANTE al abrir la pantalla
   * (aunque la señal sea mala) y se refresca solo cuando llega la respuesta.
   */
  const MAPS_VIEW_KEY = 'pe_orders_map_view';
  const MAPS_CACHE_KEY = 'pe_orders_map_points';
  const MAPS_POLL_MS = 15000;
  const DELIVERY_TILE_PREFETCH_ENABLED = false;
  const DELIVERY_TILE_PREFETCH_REASON =
    'Neither the OSM nor the Esri tile service allows automatic area prefetch; caching visited tiles is fine.';
  const DELIVERY_TILE_SLOW_MS = 4500;
  const NEGOCIO = 'Phytoemagry';
  const BUSINESS_TIME_ZONE = 'America/Santo_Domingo';

  /** Estado en memoria del panel. */
  const state = {
    items: [],
    messages: [],
    // Clientes unificados (una persona = un cliente, venga de donde venga).
    customers: [],
    conversations: [],
    followups: null,
    hoy: null,
    catalog: [],
    inventory: null,
    salesReport: null,
    salesReportPeriod: 'hoy',
    whatsapp: null,
    templates: [],
    stats: null,
    statuses: [],
    // Ventas (S4/S5/S6): cola de programados, ajustes, estados y auditoría.
    scheduled: null,
    settings: null,
    commercial: null,
    orderStatuses: [],
    paymentMethods: [],
    customerStages: [],
    customerTags: [],
    audit: null,
    media: null,
    deliveryTracking: [],
    deliveryUsers: [],
    /* Largo mínimo de contraseña: lo manda el servidor para que la regla sea UNA. */
    minPasswordLength: 6,
    deliveryOrders: [],
    notifications: [],
    push: null,
    deliveryEvents: null,
    deliveryPollTimer: null,
    deliveryWatchId: null,
    deliveryActiveSessionId: null,
    deliveryActiveOrderId: null,
    deliveryLastSentAt: 0,
    deliveryLastSentPoint: null,
    deliveryWatchStartedAt: 0,
    /*
     * EL MAPA ES UNO SOLO (pantalla «Mapa y entregas»).
     *
     * `ordersMap` manda: su instancia de Leaflet, los puntos de pedidos y
     * ubicaciones guardadas, la medición de distancias y el punto de referencia.
     * `deliveryMap` son los marcadores EN VIVO (repartidor, destino y la línea
     * entre ambos) que se dibujan SOBRE ese mismo mapa: así una entrega en curso,
     * los pedidos y las ubicaciones se ven juntos sin cambiar de pantalla.
     */
    ordersMap: {
      map: null,
      markers: new Map(),
      filter: 'todo',
      measuring: false,
      measurePoints: [],
      measureLine: null,
      measureMarkers: [],
      /*
       * EL AVISO DEL MAPA ES UNO SOLO, así que cada cosa que quiere hablar guarda
       * su texto y `refreshOrdersMapNotice()` decide cuál se ve (por prioridad).
       * `measureText` es el resultado de medir: lo que la persona acaba de pedir.
       */
      measureText: '',
      noticeText: '',
      refPoint: null,
      refMarker: null,
      focus: null,
      fitted: false,
      loading: false,
      error: false,
      updatedAt: null,
      pollTimer: null,
      panelOpen: false,
      layers: { orders: true, locations: true, live: true, labels: mapLabelsPref() },
      baseLayer: null,
      // Se resuelve al montar el mapa (`ordersMapBaseKey`): la elección se recuerda.
      base: null,
      // Techo de imagen real de la zona que se está mirando, y la comprobación en curso.
      nativeZoom: null,
      zone: null,
      probing: null,
      probeTimer: null,
      labelLayer: null,
      labelReady: false,
      zoomHint: '',
    },
    deliveryMap: {
      sessionId: null,
      destinationKey: null,
      customerMarker: null,
      deliveryMarker: null,
      routeLine: null,
      fitDone: false,
      autoFollow: true,
      userPanned: false,
      tileLoading: 0,
      tileError: false,
      slowTimer: null,
    },
    auth: null,
    users: [],
    metrics: null,
    metricsPeriod: '30d',
    orderId: null,
    previousTab: null,
    customerProfile: null,
    customerProfileLoading: false,
    customerProfileOrderId: null,
    tab: 'hoy',
    filter: 'todos',
    q: '',
    clientSearchOpen: false,
    // Filtro de la lista de pedidos, por ESTADO OPERATIVO (pendiente, en camino…).
    pedidosFilter: 'todo',
    // Datos de la factura abierta (los usa el menú de su botón flotante).
    receiptContext: null,
    openId: null,
    customerId: null,
    chat: null,
    // Bandeja de WhatsApp: conversación abierta, filtros y estado de la carga.
    wa: {
      selectedId: null,
      filter: 'todos',
      date: { mode: 'all', from: '', to: '' },
      q: '',
      searchOpen: false,
      chat: null,
      draft: '',
      listSig: null,
      chatSig: null,
      counts: null,
      selected: new Set(),
      notify: localStorage.getItem(WA_NOTIFY_KEY) === '1',
      sound: localStorage.getItem(WA_SOUND_KEY) === '1',
      seenMessages: new Set(),
      loadingFor: null,
      followupId: null,
      listError: false,
      threadError: false,
    },
    online: navigator.onLine,
    syncedAt: null,
    drawer: false,
  };

  const DELIVERY_MAP_PROVIDER = 'Leaflet';
  /*
   * CÓMO SE VE EL TERRENO (capas base del mapa).
   *
   * Lo que pidió el negocio es VER LA TIERRA: las casas, los patios, los caminos.
   * Eso es imagen de satélite/foto aérea, y la que mejor cubre República Dominicana
   * SIN llave ni cuota es la de Esri (imágenes Maxar/DigitalGlobe, las mismas que
   * usan otros mapas grandes). Comprobado tile a tile (2026-10-02):
   *
   *   - Higüey y alrededores: imagen propia hasta el nivel de zoom 18.
   *   - Santo Domingo, Bávaro y Punta Cana: hasta el 19.
   *   - El nivel 20 ya NO tiene imagen en RD: se AMPLÍA la del 18 y se avisa en
   *     la pantalla (más cerca se ve, pero no gana detalle, y no se inventa).
   *
   * Las etiquetas de calles y nombres van en una capa APARTE y transparente encima
   * de la foto (si no, la imagen sola no dice dónde está qué). Y el mapa dibujado
   * de toda la vida (OpenStreetMap) sigue estando para quien lo prefiera: pesa
   * mucho menos y va mejor con datos móviles malos.
   */
  const MAPS_BASE_KEY = 'pe_orders_map_base';
  const MAPS_LABELS_KEY = 'pe_orders_map_labels';
  /**
   * ¿Calles y nombres encima de la foto? Por defecto sí (una foto sola no dice
   * dónde está qué), pero se recuerda si el negocio los apagó a propósito.
   * Se lee con la cadena a pelo: `state` se crea ANTES que estas constantes.
   */
  function mapLabelsPref() {
    try {
      return localStorage.getItem('pe_orders_map_labels') !== '0';
    } catch {
      return true;
    }
  }
  const MAP_BASE_LAYERS = {
    satelite: {
      label: 'Satélite',
      detail: 'Foto real del terreno: se ven las casas, los patios y los caminos',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Imágenes &copy; Esri, Maxar, Earthstar Geographics',
      provider: 'Esri World Imagery',
      maxNativeZoom: 18,
      maxZoom: 20,
      labels: true,
      /*
       * Este proveedor sirve unos niveles en unas zonas y en otras no: el techo se
       * COMPRUEBA por zona (`probeOrdersMapNative`) en vez de darlo por hecho.
       */
      probe: true,
    },
    calles: {
      label: 'Mapa (calles)',
      detail: 'Dibujo de calles y nombres: más ligero para datos móviles',
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; OpenStreetMap contributors',
      provider: 'OpenStreetMap',
      maxNativeZoom: 19,
      maxZoom: 20,
      labels: false,
      probe: false,
    },
  };
  const MAP_DEFAULT_BASE = 'satelite';
  /** Calles y nombres ENCIMA de la foto (capa transparente del mismo proveedor). */
  const MAP_LABEL_LAYER = {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Calles y nombres &copy; Esri',
    maxNativeZoom: 18,
    maxZoom: 20,
  };
  /*
   * El navegador pide los tiles de uno en uno; esto los pide por lotes y solo
   * cuando el mapa está quieto (mover el dedo no dispara 40 peticiones).
   */
  const MAP_TILE_TUNING = { keepBuffer: 3, updateWhenIdle: true, updateWhenZooming: false, crossOrigin: true };

  /*
   * TECHO REAL DE LA IMAGEN, ZONA POR ZONA (sin inventar un píxel).
   *
   * Medido tile a tile el 2026-10-02 sobre Esri World Imagery:
   *
   *   - El nivel 18 tiene imagen propia en las 20 zonas de RD comprobadas.
   *   - El nivel 19 solo la tiene en algunas (Verón, Bávaro, Punta Cana, Santo
   *     Domingo y Santiago) y NO en otras (Higüey, La Romana, Puerto Plata…).
   *   - Donde no la tiene, en vez de dar error el servidor devuelve SIEMPRE el
   *     mismo PNG gris de 2.521 bytes (sha 1660d86a87f5, idéntico en todo el país
   *     y también en z20) con HTTP 200: Leaflet no se entera (no hay `tileerror`)
   *     y el mapa se pondría gris si se pidiera ese nivel.
   *
   * Por eso el techo por defecto es 18 (seguro en todo el país) y se SUBE a 19
   * solo después de comprobar, una vez por zona, que el tile del 19 es imagen de
   * verdad (más de 4 KB, cuando el relleno pesa 2,5 KB y la foto real más pequeña
   * medida pesa 5,4 KB). Y z20 no se pide nunca: no existe en ninguna zona medida.
   * Más allá del techo, acercarse está permitido pero es AMPLIACIÓN, y se dice.
   */
  const MAP_IMAGE_ZONE_ZOOM = 15; // celda de comprobación (~1,2 km): la imagen cambia por zona, no por calle
  const MAP_MIN_REAL_TILE_BYTES = 4000; // relleno 2.521 B · foto real más pequeña medida 5.462 B
  const MAP_NATIVE_DEFAULT_ZOOM = 18; // techo seguro sin dato (imagen real garantizada)
  const MAP_NATIVE_MAX_ZOOM = 19; // techo comprobable en RD (el 20 no existe)
  const MAP_NATIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // la imagen cambia con los años: se vuelve a comprobar
  const MAP_NATIVE_STORE_KEY = 'pe_map_native_zoom';
  const MAP_NATIVE_STORE_MAX = 300; // zonas recordadas a la vez

  // ------------------------------------------------------------------ helpers

  /*
   * `document` deja de existir cuando la página se descarga (o cuando un UAT
   * cierra la ventana con sondeos todavía en vuelo). Sin documento no hay nada
   * que pintar: se devuelve null/[] y el trabajo tardío termina en paz en vez de
   * reventar con «Cannot read properties of undefined (reading 'querySelector')».
   */
  const $ = (selector, root) =>
    (root ?? (typeof document === 'undefined' ? null : document))?.querySelector(selector) ?? null;
  const $$ = (selector, root) => {
    const scope = root ?? (typeof document === 'undefined' ? null : document);
    return scope?.querySelectorAll ? [...scope.querySelectorAll(selector)] : [];
  };

  /**
   * ¿Sigue existiendo la página? Una petición en vuelo puede resolverse DESPUÉS
   * de descargarse la pestaña (o de que un UAT cierre la ventana): entonces no
   * hay nada que pintar y seguir renderizando solo produce errores invisibles.
   */
  const domAlive = () => typeof document !== 'undefined' && Boolean(document?.body);

  const escapeHtml = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');

  /*
   * ICONOS — UN solo sistema visual: trazos SVG de 24x24 (nada de emojis
   * mezclados con iconos, nada de estilos distintos por pantalla).
   *
   * Los que viven en el HTML estático se pintan al arrancar con `paintIcons()`:
   * así la forma de cada icono se define UNA vez, aquí.
   */
  const svg = (paths) =>
    `<svg class="svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" `+
    `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

  const ICONS = {
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>'),
    chat: svg('<path d="M21 11.6a8 8 0 0 1-8 8H8.2L3 22.5l1.3-4.4A8 8 0 1 1 21 11.6z"/>'),
    users: svg('<path d="M15.5 20v-1.4a4 4 0 0 0-4-4H7.2a4 4 0 0 0-4 4V20"/><circle cx="9.3" cy="7.6" r="3.1"/><path d="M17.4 15.4a3.9 3.9 0 0 1 2.6 3.7V20M15.8 4.6a3.1 3.1 0 0 1 0 6"/>'),
    box: svg('<path d="M20.5 8.4v7.2L12 20.4l-8.5-4.8V8.4L12 3.6z"/><path d="M3.5 8.4 12 13l8.5-4.6M12 13v7.4"/>'),
    inventory: svg('<path d="M5.2 5.4h13.6v14H5.2z"/><path d="M8.2 5.4V3.8h7.6v1.6M8.4 10.2h7.2M8.4 14.2h7.2"/>'),
    chart: svg('<path d="M4 19.5h16"/><path d="M7 16v-5M12 16V6.5M17 16v-8"/>'),
    bell: svg('<path d="M18 15.2V10a6 6 0 1 0-12 0v5.2L4 18.6h16z"/><path d="M10 21.4h4"/>'),
    note: svg('<path d="M8 3.5h8a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z"/><path d="M9.2 8h5.6M9.2 12h5.6M9.2 16h3.4"/>'),
    /* Ajustes = mandos que se deslizan (un engranaje aquí se confundía con el sol de Hoy). */
    gear: svg('<path d="M4 7.4h9M17.4 7.4H20M4 16.6h2.6M11 16.6h9"/><circle cx="15.2" cy="7.4" r="2.2"/><circle cx="8.8" cy="16.6" r="2.2"/>'),
    close: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
    back: svg('<path d="M19.5 12H4.7"/><path d="M11 5.3 4.3 12l6.7 6.7"/>'),
    /* «⋮» de verdad: tres puntos RELLENOS (con trazo quedaban huecos y no se veían). */
    more: svg('<circle cx="12" cy="5.2" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="18.8" r="1.9" fill="currentColor" stroke="none"/>'),
    search: svg('<circle cx="10.8" cy="10.8" r="5.8"/><path d="m15.2 15.2 4.6 4.6"/>'),
    calendar: svg('<rect x="4" y="5.4" width="16" height="14.6" rx="2.4"/><path d="M8 3.8v3.4M16 3.8v3.4M4 10h16"/>'),
    plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
    mic: svg('<rect x="9.2" y="2.8" width="5.6" height="10.8" rx="2.8"/><path d="M5.8 11.2a6.2 6.2 0 0 0 12.4 0"/><path d="M12 17.4V21M9.4 21h5.2"/>'),
    send: svg('<path d="M4.6 12 20 4.6l-7.3 15-1.9-6.3z"/><path d="M10.8 13.3 20 4.6"/>'),
    spark: svg('<path d="M11.4 3.6l1.8 4.9 4.9 1.8-4.9 1.8-1.8 4.9-1.8-4.9L4.7 10.3l4.9-1.8z"/><path d="M18.4 15.6l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z"/>'),
    bag: svg('<path d="M4.6 7.4h14.8l-1.2 11.9a2 2 0 0 1-2 1.8H7.8a2 2 0 0 1-2-1.8z"/><path d="M8.8 7.4V5.8a3.2 3.2 0 0 1 6.4 0v1.6"/>'),
    clock: svg('<circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3 1.9"/>'),
    lock: svg('<rect x="5.5" y="10" width="13" height="10" rx="2"/><path d="M8.5 10V7.6a3.5 3.5 0 0 1 7 0V10"/>'),
    person: svg('<circle cx="12" cy="7.9" r="3.9"/><path d="M4.8 20.4c1.3-3.3 4-4.9 7.2-4.9s5.9 1.6 7.2 4.9"/>'),
    userCog: svg('<circle cx="10" cy="7.8" r="3.4"/><path d="M3.8 19.4c1.1-3 3.4-4.5 6.2-4.5 1.1 0 2.1.2 3 .7"/><circle cx="17.6" cy="16.8" r="2.1"/><path d="M17.6 13.5v1M17.6 18.9v1M14.7 15.1l.9.5M19.6 18l.9.5M14.7 18.5l.9-.5M19.6 15.6l.9-.5"/>'),
    image: svg('<rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2.6"/><circle cx="9" cy="10" r="1.6"/><path d="M3.6 17.2l4.9-4.9 4.4 4.4 2.8-2.7 4.7 4.6"/>'),
    audio: svg('<path d="M4 13.6v-3.2M8 17V7M12 20V4M16 16.4v-8.8M20 13.4v-2.8"/>'),
    doc: svg('<path d="M7.2 3.4h6.3l5 5V20.6H7.2z"/><path d="M13.2 3.4v5.2h5.3"/>'),
    video: svg('<rect x="3.2" y="6.2" width="11.6" height="11.6" rx="2.6"/><path d="M15 11.2l5.8-3.4v8.4L15 12.8z"/>'),
    tagIcon: svg('<path d="M4.4 12.6V5.2a.8.8 0 0 1 .8-.8h7.4l7.2 7.2-8.2 8.2z"/><circle cx="8.7" cy="8.7" r="1.3"/>'),
    pin: svg('<path d="M12 20.8s6.2-5.8 6.2-10.6a6.2 6.2 0 1 0-12.4 0C5.8 15 12 20.8 12 20.8z"/><circle cx="12" cy="10" r="2.3"/>'),
    retry: svg('<path d="M19.6 12a7.6 7.6 0 1 1-2.5-5.6"/><path d="M19.8 4.4v4.2h-4.2"/>'),
    /* Marcar leído (un trazo) y «seleccionar» (círculo con visto): dos gestos
       distintos no pueden compartir el mismo dibujo. */
    check: svg('<path d="M5 12.6l4.4 4.4L19 6.8"/>'),
    checkCircle: svg('<circle cx="12" cy="12" r="8.6"/><path d="M8.3 12.2l2.6 2.6 4.8-5.1"/>'),
    phone: svg('<path d="M6.4 3.6h3.1l1.5 3.6-2 1.5a11.7 11.7 0 0 0 5.8 5.8l1.5-2 3.6 1.5v3.1a1.7 1.7 0 0 1-1.9 1.7A15.9 15.9 0 0 1 4.7 5.5 1.7 1.7 0 0 1 6.4 3.6Z"/>'),
    /* Ojo abierto y ojo tachado: ver / ocultar la contraseña que se está escribiendo. */
    eye: svg('<path d="M2.8 12S6.4 5.8 12 5.8 21.2 12 21.2 12 17.6 18.2 12 18.2 2.8 12 2.8 12Z"/><circle cx="12" cy="12" r="2.9"/>'),
    eyeOff: svg('<path d="M4.4 8.4C3.3 9.7 2.8 12 2.8 12S6.4 18.2 12 18.2c1.5 0 2.8-.4 4-1M9.2 6.2A7.6 7.6 0 0 1 12 5.8c5.6 0 9.2 6.2 9.2 6.2a17 17 0 0 1-3 3.6"/><path d="M4.6 4.6l14.8 14.8"/><path d="M9.9 9.9a2.9 2.9 0 0 0 4.2 4.2"/>'),
    chevron: svg('<path d="M9.6 5.4l6.6 6.6-6.6 6.6"/>'),
  };

  /** Pinta los iconos declarados en el HTML (`data-icon="..."`). */
  function paintIcons(root = document) {
    $$('[data-icon]', root).forEach((slot) => {
      const art = ICONS[slot.dataset.icon];
      if (art) slot.innerHTML = art;
    });
  }

  /** Fecha-hora corta en español (la del teléfono es la del negocio). */
  const fmtWhen = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const diff = Date.now() - date.getTime();
    const minutes = Math.round(diff / 60000);
    if (minutes < 1) return 'ahora';
    if (minutes < 60) return `hace ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `hace ${hours} h`;
    const days = Math.round(hours / 24);
    if (days === 1) return 'ayer';
    if (days < 7) return `hace ${days} días`;
    return new Intl.DateTimeFormat('es-DO', { day: 'numeric', month: 'short' }).format(date);
  };

  function businessDayISO(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: BUSINESS_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const part = (type) => parts.find((entry) => entry.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  /** `YYYY-MM-DD` de hoy en la zona horaria del negocio. */
  const todayISO = () => businessDayISO();

  function addDaysToISO(day, days) {
    const [year, month, date] = String(day).split('-').map(Number);
    const value = new Date(Date.UTC(year, month - 1, date + Number(days || 0), 12));
    return businessDayISO(value);
  };

  const addDaysISO = (days) => {
    return addDaysToISO(todayISO(), days);
  };

  const fmtDay = (day) => {
    if (!day) return '';
    const [year, month, date] = day.split('-').map(Number);
    const value = new Date(year, month - 1, date);
    const label = new Intl.DateTimeFormat('es-DO', { weekday: 'short', day: 'numeric', month: 'short' }).format(value);
    const today = todayISO();
    if (day === today) return `hoy · ${label}`;
    if (day < today) return `vencido · ${label}`;
    return label;
  };

  const money = (value, currency = 'DOP') =>
    value === null || value === undefined
      ? '—'
      : `${currency} ${new Intl.NumberFormat('es-DO', { maximumFractionDigits: 0 }).format(value)}`;

  const digits = (phone) => String(phone ?? '').replace(/\D/g, '');

  let toastTimer = null;
  function toast(message) {
    const box = $('#toast');
    if (!box) return; // sin documento (página cerrándose) no hay nada que avisar
    box.textContent = message;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      box.hidden = true;
    }, 3200);
  }

  // ---------------------------------------------------------------------- API

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      credentials: 'same-origin',
    });

    // La respuesta puede NO ser JSON: si el CRM no está en marcha, delante
    // contesta el servidor de ficheros y devuelve un 404 en HTML. Sin mirar el
    // texto, el panel decía "No se pudo entrar." sin ninguna pista.
    const raw = await response.text();
    let body = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { message: disconnectedMessage(response) };
      }
    }

    if (response.status === 401) {
      showLogin(body.message ?? 'Tu sesión ha caducado. Vuelve a entrar.');
      throw Object.assign(new Error('unauthorized'), { body });
    }
    if (!response.ok) throw Object.assign(new Error(body.message ?? 'error'), { body });
    return body;
  }

  /**
   * Qué contestar cuando el CRM no contesta.
   *
   * @param {Response} response
   * @returns {string}
   */
  function disconnectedMessage(response) {
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return 'El CRM no está encendido. Arráncalo con «npm run crm» (o con el botón del servidor) y vuelve a intentarlo.';
    }
    return `El panel no está conectado con el CRM (respuesta ${response.status}). Comprueba que el API responda en /api/health.`;
  }

  // ------------------------------------------------------- copia local (offline)

  function saveSnapshot() {
    try {
      localStorage.setItem(
        SNAPSHOT_KEY,
        JSON.stringify({
          items: state.items,
          messages: state.messages,
          customers: state.customers,
          conversations: state.conversations,
          followups: state.followups,
          hoy: state.hoy,
          catalog: state.catalog,
          inventory: state.inventory,
          whatsapp: state.whatsapp,
          stats: state.stats,
          deliveryTracking: state.deliveryTracking,
          deliveryUsers: state.deliveryUsers,
          deliveryOrders: state.deliveryOrders,
          notifications: state.notifications,
          push: state.push,
          at: Date.now(),
        }),
      );
    } catch {
      /* sin espacio: el panel sigue funcionando en línea */
    }
  }

  function readSnapshot() {
    try {
      const raw = localStorage.getItem(SNAPSHOT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  const readOutbox = () => {
    try {
      return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]');
    } catch {
      return [];
    }
  };

  const writeOutbox = (list) => {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(list));
    renderOutboxBanner();
  };

  /** Cambio que no se pudo enviar (sin red): se aplica en pantalla y se reintenta. */
  function queuePatch(id, patch) {
    const outbox = readOutbox().filter((entry) => entry.id !== id);
    const previous = readOutbox().find((entry) => entry.id === id)?.patch ?? {};
    outbox.push({ id, patch: { ...previous, ...patch }, at: Date.now() });
    writeOutbox(outbox);
  }

  async function flushOutbox() {
    const outbox = readOutbox();
    if (outbox.length === 0 || !state.online) return;
    const pending = [];
    for (const entry of outbox) {
      try {
        await api(`/api/admin/items/${encodeURIComponent(entry.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(entry.patch),
        });
      } catch (error) {
        if (error.message !== 'unauthorized') pending.push(entry);
      }
    }
    writeOutbox(pending);
    if (pending.length === 0) toast('Cambios enviados');
    else return;
    await load({ keepTab: true });
  }

  // ------------------------------------------------------------------ sesión

  function hideSplash() {
    const splash = $('#splash');
    if (!splash) return;
    splash.classList.add('splash--hide');
    setTimeout(() => {
      splash.hidden = true;
    }, 260);
  }

  function showLogin(message = '') {
    $('#app').hidden = true;
    $('#login').hidden = false;
    hideSplash();
    $('#login-error').hidden = !message;
    $('#login-error').textContent = message;
    ($('#login-username') ?? $('#login-token')).focus({ preventScroll: true });
  }

  function showApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    hideSplash();
    setTab(state.tab, { silent: true });
  }

  async function checkSession() {
    try {
      const response = await fetch('/api/admin/session', { credentials: 'same-origin' });
      const body = await response.json().catch(() => ({}));
      if (body.ok) state.auth = { user: body.user ?? null, legacy: body.legacy === true };
      return Boolean(body.ok);
    } catch {
      // Sin red no se puede preguntar: no significa que la sesión no valga.
      return false;
    }
  }

  function loginErrorMessage(error) {
    if (error.body?.message) return error.body.message;
    if (error.body?.error === 'too_many_attempts') return 'Demasiados intentos seguidos. Espera 15 minutos.';
    if (error.body?.error === 'invalid_credentials') {
      return error.body?.storage === 'sqlite'
        ? 'Usuario o contraseña incorrectos. Ojo: este CRM local está usando SQLite; si esperabas Postgres/producción, reinicia el CRM con esa configuración.'
        : 'Usuario o contraseña incorrectos.';
    }
    if (error.body?.error === 'invalid_token') return 'La clave no es correcta.';
    return error.message === 'unauthorized' ? 'Usuario o contraseña incorrectos.' : 'No se pudo entrar: no hay conexión con el CRM.';
  }

  // -------------------------------------------------------------------- datos

  async function load(options = {}) {
    try {
      const data = await api('/api/admin/data');
      state.items = data.items ?? [];
      state.messages = data.messages ?? [];
      state.customers = data.customers ?? [];
      state.conversations = data.conversations ?? [];
      state.wa.counts = data.conversationCounts ?? state.wa.counts;
      for (const row of state.conversations) {
        if (row.last_message?.direction === 'inbound') state.wa.seenMessages.add(`${row.id}:${row.last_message.at ?? row.last_message_at ?? ''}`);
      }
      state.followups = data.followups ?? null;
      state.hoy = data.hoy ?? null;
      state.catalog = data.catalog ?? [];
      state.inventory = data.inventory ?? null;
      state.whatsapp = data.whatsapp ?? null;
      state.stats = data.stats ?? null;
      state.statuses = data.statuses ?? [];
      state.meta = data.meta ?? null;
      state.scheduled = data.scheduled ?? null;
      state.settings = data.settings ?? null;
      state.commercial = data.commercial ?? null;
      state.orderStatuses = data.orderStatuses ?? [];
      state.paymentMethods = data.paymentMethods ?? [];
      state.customerStages = data.customerStages ?? [];
      state.customerTags = data.customerTags ?? [];
      state.audit = data.audit ?? null;
      state.media = data.media ?? null;
      state.deliveryTracking = data.deliveryTracking ?? [];
      state.deliveryUsers = data.deliveryUsers ?? [];
      state.minPasswordLength = Number(data.minPasswordLength) > 0 ? Number(data.minPasswordLength) : 6;
      state.deliveryOrders = data.deliveryOrders ?? [];
      state.notifications = data.notifications ?? [];
      state.push = data.push ?? null;
      state.auth = data.auth ?? null;
      state.templates = (await api('/api/admin/wa-templates').catch(() => ({ templates: state.templates ?? [] }))).templates ?? [];
      state.syncedAt = Date.now();
      saveSnapshot();
      render();
      autoSyncCrmPush();
      if (!options.keepTab) await flushOutbox();
    } catch (error) {
      if (error.message === 'unauthorized') return;
      const snapshot = readSnapshot();
      if (snapshot) {
        state.items = snapshot.items ?? [];
        state.messages = snapshot.messages ?? [];
        state.customers = snapshot.customers ?? [];
        state.conversations = snapshot.conversations ?? [];
        for (const row of state.conversations) {
          if (row.last_message?.direction === 'inbound') state.wa.seenMessages.add(`${row.id}:${row.last_message.at ?? row.last_message_at ?? ''}`);
        }
        state.followups = snapshot.followups ?? null;
        state.hoy = snapshot.hoy ?? null;
        state.catalog = snapshot.catalog ?? [];
        state.inventory = snapshot.inventory ?? null;
        state.whatsapp = snapshot.whatsapp ?? null;
        state.stats = snapshot.stats ?? null;
        state.scheduled = snapshot.scheduled ?? null;
        state.settings = snapshot.settings ?? null;
        state.deliveryTracking = snapshot.deliveryTracking ?? [];
        state.deliveryUsers = snapshot.deliveryUsers ?? [];
        state.deliveryOrders = snapshot.deliveryOrders ?? [];
        state.notifications = snapshot.notifications ?? [];
        state.push = snapshot.push ?? null;
        state.orderStatuses = snapshot.orderStatuses ?? [];
        state.paymentMethods = snapshot.paymentMethods ?? [];
        state.customerStages = snapshot.customerStages ?? [];
        state.customerTags = snapshot.customerTags ?? [];
        state.syncedAt = snapshot.at ?? null;
        toast('Sin conexión: datos guardados en el teléfono');
        render();
      } else {
        // Sin copia guardada: la bandeja tiene que decir que FALLÓ, no “no hay nada”.
        state.wa.listError = true;
        toast('No se pudieron cargar los datos');
        render();
      }
    }
  }

  /**
   * El API habla `nextActionAt`; el panel pinta `next_action_at`. Traducir aquí
   * evita el fallo clásico: guardar bien en el servidor y no verse en pantalla.
   */
  const STATE_FIELDS = {
    status: 'status',
    notes: 'notes',
    nextActionAt: 'next_action_at',
    lastContactAt: 'last_contact_at',
  };

  function toStatePatch(patch) {
    const out = {};
    for (const [key, value] of Object.entries(patch)) {
      const field = STATE_FIELDS[key];
      if (field) out[field] = value;
    }
    if (patch.contacted) out.last_contact_at = new Date().toISOString();
    return out;
  }

  /** Cambios pendientes aplicados en pantalla (mientras no hay red). */
  function applyOutbox(items) {
    const outbox = readOutbox();
    if (outbox.length === 0) return items;
    return items.map((item) => {
      const entry = outbox.find((candidate) => candidate.id === item.id);
      return entry ? { ...item, ...toStatePatch(entry.patch) } : item;
    });
  }

  async function patchItem(id, patch, message) {
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item) return;
    Object.assign(item, toStatePatch(patch));
    render();
    try {
      await api(`/api/admin/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (message) toast(message);
      saveSnapshot();
    } catch (error) {
      if (error.message === 'unauthorized') return;
      queuePatch(id, patch);
      toast('Se enviará cuando vuelva la conexión');
    }
    if (state.openId === id) renderSheet();
    await refreshStats();
    /*
     * La venta se manda a Meta DESPUÉS de responder (para no hacer esperar al
     * panel), así que el resultado se recoge un momento más tarde: si no, el
     * negocio vería "pendiente" para siempre.
     */
    if (state.meta?.configured && patch.status === state.meta.purchaseStatus) {
      setTimeout(() => {
        load({ keepTab: true }).catch(() => {});
      }, 1800);
    }
  }

  /** Recalcula los contadores en el cliente (respuesta inmediata al tocar). */
  async function refreshStats() {
    const items = state.items;
    const today = todayISO();
    const open = items.filter((item) => !['entregado', 'perdido'].includes(item.status ?? 'nuevo'));
    const conRecordatorio = open.filter((item) => item.next_action_at);
    state.stats = {
      ...(state.stats ?? {}),
      total: items.length,
      nuevos: items.filter((item) => (item.status ?? 'nuevo') === 'nuevo').length,
      hoy: conRecordatorio.filter((item) => item.next_action_at <= today).length,
      atrasados: conRecordatorio.filter((item) => item.next_action_at < today).length,
      pedidos: open.filter((item) => item.type === 'order_intent').length,
      entregados: items.filter((item) => item.status === 'entregado').length,
      valorAbierto: open.reduce((sum, item) => sum + (Number(item.total) || 0), 0),
      valorCobrado: items
        .filter((item) => item.status === 'entregado')
        .reduce((sum, item) => sum + (Number(item.total) || 0), 0),
    };
    renderStats();
    updateBadge();
  }

  // -------------------------------------------------------------- plantillas

  function fillTemplate(body, item) {
    const values = {
      nombre: item?.name ?? 'cliente',
      // Un contacto sin frasco no debe leer "el frasco de nuestros frascos".
      frasco: item?.variant_name ?? 'Phytoemagry',
      cantidad: item?.quantity ?? '',
      total: item?.total ? money(item.total, item.currency) : '',
      negocio: NEGOCIO,
    };
    // `{telefono}` solo existe si HAY teléfono: sin dato, la variable se queda
    // escrita tal cual en vez de rellenarse con un «null» o con algo inventado.
    if (item?.phone) values.telefono = String(item.phone);
    return String(body)
      .replaceAll(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
      .replace(/\s*\(\s*\)/g, '') // "()" de un dato que no existe
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  const waTemplateStatus = (template) => String(template?.status ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const waTemplateApproved = (template) => waTemplateStatus(template) === 'APPROVED' && template?.sendable === true;
  const waTemplateLabel = (template) => template?.friendly_name || template?.friendlyName || template?.name || 'Plantilla';
  const waTemplateMetaSynced = (template) => template?.source === 'meta' || Boolean(template?.last_synced_at);

  function whatsappUrl(item, body) {
    const phone = digits(item.phone);
    const text = encodeURIComponent(fillTemplate(body, item));
    return phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;
  }

  /** Abre WhatsApp en una pestaña nueva (con `<a>`: los bloqueadores no lo cortan). */
  function openWhatsApp(item, body) {
    const link = document.createElement('a');
    link.href = whatsappUrl(item, body);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.append(link);
    link.click();
    link.remove();
    // Escribir ES contactar: queda registrado para los recordatorios.
    const patch = { contacted: true };
    if (item.type !== 'order_intent' && (!item.status || item.status === 'nuevo')) patch.status = 'contactado';
    patchItem(item.id, patch);
  }

  // ------------------------------------------------------------------ render

  function render() {
    renderMobileHeader();
    renderStats();
    renderHoy();
    renderWhatsapp();
    renderClientes();
    renderOrdersMap();
    renderPedidos();
    renderProductos();
    renderReportes();
    renderSeguimientos();
    renderMensajes();
    renderAjustes();
    renderCurrentUser();
    renderUsuarios();
    renderPerfil();
    renderCustomerProfile();
    updateBadge();
    renderOutboxBanner();
  }

  const label = (type) => (type === 'order_intent' ? 'Pedido' : 'Contacto');
  const statusLabel = (value) => state.statuses.find((entry) => entry.value === value)?.label ?? value;
  const paymentMethodLabel = (value) => state.paymentMethods.find((entry) => entry.value === value)?.label ?? value ?? '—';
  const customerStageOf = (customerOrRow) =>
    customerOrRow?.customerStage ?? customerOrRow?.customer_stage ?? customerOrRow?.customer?.customerStage ?? customerOrRow?.customer?.customer_stage ?? 'PROSPECT';
  const customerStageLabel = (value) => state.customerStages.find((entry) => entry.value === value)?.label ?? ({
    PROSPECT: 'Prospecto',
    INTERESTED: 'Interesado',
    CUSTOMER: 'Cliente',
    INACTIVE: 'Inactivo',
  }[value] ?? value ?? 'Prospecto');
  const customerTagsOf = (customerOrRow) => {
    const tags = customerOrRow?.tags ?? customerOrRow?.customer?.tags ?? [];
    return Array.isArray(tags) ? tags : [];
  };
  const moneyCents = (value) => money((Number(value) || 0) / 100);

  const currentUser = () => state.auth?.user ?? null;
  const isAdmin = () => currentUser()?.role === 'ADMIN' || state.auth?.legacy === true;
  const permissions = () => state.auth?.permissions ?? [];
  const hasPermission = (permission) => isAdmin() || permissions().includes('*') || permissions().includes(permission);
  const roleLabel = (role) =>
    role === 'ADMIN'
      ? 'Administrador'
      : role === 'DELIVERY'
        ? 'Delivery'
        : role === 'OPERADOR'
          ? 'Operador'
            : role === 'AGENT'
              ? 'Agente'
              : 'Sesión';

  function readDismissedNotices() {
    try {
      const list = JSON.parse(localStorage.getItem(NOTICE_DISMISSED_KEY) ?? '[]');
      return new Set(Array.isArray(list) ? list : []);
    } catch {
      return new Set();
    }
  }

  async function syncWaTemplates(button = null) {
    await working(button, 'Sincronizando…', async () => {
      try {
        const result = await api('/api/admin/wa-templates/sync', { method: 'POST', body: JSON.stringify({}) });
        state.templates = result.templates ?? state.templates;
        renderAjustes();
        const sync = result.sync ?? {};
        toast(`${sync.foundFromMeta ?? sync.found ?? 0} en Meta · ${sync.approved ?? 0} aprobadas`);
      } catch (error) {
        if (error.message !== 'unauthorized') {
          toast(error.body?.message ?? 'No se pudo consultar Meta. Revisa la configuración de WhatsApp.');
        }
      }
    });
  }

  function writeDismissedNotices(list) {
    try {
      localStorage.setItem(NOTICE_DISMISSED_KEY, JSON.stringify([...list].slice(-200)));
    } catch {
      /* Si Storage falla, solo se pierde el descarte visual. */
    }
  }

  function dismissNotice(key) {
    const list = readDismissedNotices();
    list.add(key);
    writeDismissedNotices(list);
    renderMobileHeader();
    renderHoy();
    openNotificationsSheet();
  }

  function localNoticeRows() {
    const dismissed = readDismissedNotices();
    const rows = [];
    const failedCount = Number(state.hoy?.mensajesFallidos ?? 0);
    if (failedCount > 0) {
      const key = `wa-failed:${failedCount}`;
      if (!dismissed.has(key)) {
        rows.push({
          key,
          title: `WhatsApp rechazó ${failedCount} mensaje${failedCount === 1 ? '' : 's'}`,
          body: 'Revisa el número y vuelve a intentarlo desde la conversación.',
          meta: 'WhatsApp',
          tone: 'warn',
        });
      }
    }
    for (const row of state.scheduled?.problems ?? []) {
      const key = `scheduled-problem:${row.id}:${row.status}:${row.error_message ?? row.blocked_message ?? ''}`;
      if (dismissed.has(key)) continue;
      const customer = customerById(row.customer_id);
      const conversation = conversationForCustomer(row.customer_id);
      rows.push({
        key,
        title: row.status === 'BLOCKED' ? 'Mensaje programado bloqueado' : 'Mensaje programado falló',
        body:
          row.status === 'BLOCKED'
            ? row.blocked_message ?? 'No se pudo enviar automáticamente.'
            : row.error_message ?? 'WhatsApp rechazó el envío.',
        meta: `${customer?.name ?? customer?.phone_e164 ?? 'Cliente'} · ${fmtDay(String(row.scheduled_at).slice(0, 10))}`,
        tone: 'warn',
        conversationId: conversation?.id ?? '',
        scheduledId: row.id,
      });
    }
    return rows;
  }

  const unreadNotificationCount = () =>
    (state.notifications ?? []).filter((row) => row.status !== 'read').length + localNoticeRows().length;

  function currentViewTitle() {
    if (state.tab === 'perfil-cliente' && state.customerProfile?.customer) return customerName(state.customerProfile.customer);
    return VIEW_SUBTITLE[state.tab] ?? 'CRM';
  }

  function renderMobileHeader() {
    const box = $('#mobile-header');
    if (!box) return;
    if (state.tab === 'hoy') {
      const unreadNotifications = unreadNotificationCount();
      box.innerHTML = `<div class="dashboard-head">
        <button class="dashboard-head__menu" data-open-drawer type="button" aria-label="Abrir menú">
          <img class="drawer-menu-icon" src="/admin/icon-menu.png" alt="" aria-hidden="true" width="26" height="26" />
        </button>
        <div class="dashboard-head__title">
          <strong>Phytoemagry</strong>
          <span>CRM</span>
        </div>
        <div class="dashboard-head__actions">
          <button class="dashboard-head__quick" data-dashboard-profile type="button" aria-label="Abrir perfil">${ICONS.person}</button>
          <button class="dashboard-head__quick ${unreadNotifications ? 'dashboard-head__quick--alert' : ''}" data-dashboard-notifications type="button" aria-label="${
            unreadNotifications ? `${unreadNotifications} notificación(es)` : 'Sin notificaciones'
          }">
            ${ICONS.bell}
            ${unreadNotifications ? `<span class="dashboard-head__badge">${unreadNotifications > 99 ? '99+' : unreadNotifications}</span>` : ''}
          </button>
        </div>
      </div>`;
      return;
    }
    if (state.tab === 'whatsapp') {
      if (state.wa.searchOpen) {
        box.innerHTML = `<div class="wa-appbar wa-appbar--search">
          <button class="wa-appbar__back" data-wa-search-close type="button" aria-label="Cerrar búsqueda">${ICONS.back}</button>
          <input class="wa-appbar__search" id="wa-appbar-search" type="search" value="${escapeHtml(
            state.wa.q,
          )}" placeholder="Buscar conversación" aria-label="Buscar conversación" autocomplete="off" />
          <button class="wa-appbar__icon" data-wa-search-clear type="button" aria-label="Cerrar búsqueda">${ICONS.close}</button>
        </div>`;
        return;
      }
      box.innerHTML = `<div class="wa-appbar">
        <button class="wa-appbar__back" data-simple-back type="button" aria-label="Regresar">${ICONS.back}</button>
        <div class="wa-appbar__title">
          <strong>WhatsApp</strong>
          <span>Conversaciones</span>
        </div>
        <div class="wa-appbar__actions">
          <button class="wa-appbar__icon" data-wa-search-open type="button" aria-label="Buscar conversación">${ICONS.search}</button>
        </div>
      </div>`;
      return;
    }
    if (state.tab === 'clientes') {
      if (state.clientSearchOpen) {
        box.innerHTML = `<div class="wa-appbar wa-appbar--search client-appbar client-appbar--search">
          <button class="wa-appbar__back" data-client-search-close type="button" aria-label="Cerrar búsqueda">${ICONS.back}</button>
          <input class="wa-appbar__search" id="client-appbar-search" type="search" value="${escapeHtml(
            state.q,
          )}" placeholder="Buscar cliente" aria-label="Buscar cliente" autocomplete="off" />
          <button class="wa-appbar__icon" data-client-search-clear type="button" aria-label="Cerrar búsqueda">${ICONS.close}</button>
        </div>`;
        return;
      }
      box.innerHTML = `<div class="wa-appbar client-appbar">
        <button class="wa-appbar__back" data-simple-back type="button" aria-label="Regresar">${ICONS.back}</button>
        <div class="wa-appbar__title">
          <strong>Clientes</strong>
          <span>Lista de clientes</span>
        </div>
        <div class="wa-appbar__actions">
          <button class="wa-appbar__icon" data-client-search-open type="button" aria-label="Buscar cliente">${ICONS.search}</button>
        </div>
      </div>`;
      return;
    }
    box.innerHTML = `<div class="simple-head">
      <button class="simple-head__back" data-simple-back type="button" aria-label="Regresar">${ICONS.back}</button>
      <strong>${escapeHtml(currentViewTitle())}</strong>
    </div>`;
  }

  function renderCurrentUser() {
    const user = currentUser();
    const box = $('#drawer-user');
    if (box) {
      const name = user?.display_name ?? (state.auth?.legacy ? 'Panel legacy' : '');
      box.hidden = !name;
      // El bloque de usuario ES la puerta a «Mi perfil»: se toca y se entra.
      box.innerHTML = name
        ? `<button class="drawer__user-btn" id="drawer-user-go" type="button" aria-label="Abrir mi perfil">
             <span class="avatar avatar--sm">${escapeHtml(waInitials(name))}</span>
             <span class="drawer__user-body"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(
               roleLabel(user?.role ?? 'ADMIN'),
             )}</small></span>
             <span class="drawer__user-go" aria-hidden="true">${ICONS.chevron}</span>
           </button>`
        : '';
      $('#drawer-user-go')?.addEventListener('click', () => setTab('perfil'));
    }
    $$('[data-admin-only]').forEach((node) => {
      node.hidden = !isAdmin();
    });
    $$('[data-permission]').forEach((node) => {
      node.hidden = !hasPermission(node.dataset.permission);
    });
  }

  function renderStats() {
    const hoy = state.hoy ?? {};
    /*
     * HOY es un centro OPERATIVO: los contadores son trabajo que hacer ahora
     * (contestar, seguir, resolver un mensaje que no salió), no gráficas. Cada
     * tarjeta lleva a la lista donde se resuelve.
     */
    const cards = [
      {
        label: 'Sin responder',
        value: hoy.sinResponder ?? 0,
        alert: (hoy.sinResponder ?? 0) > 0,
        goto: 'whatsapp',
        icon: ICONS.chat,
        tone: 'blue',
      },
      { label: 'Seguimientos hoy', value: hoy.seguimientosHoy ?? 0, goto: 'seguimientos', icon: ICONS.users, tone: 'green' },
      {
        label: 'Seguimientos vencidos',
        value: hoy.seguimientosVencidos ?? 0,
        alert: (hoy.seguimientosVencidos ?? 0) > 0,
        goto: 'seguimientos',
        icon: ICONS.clock,
        tone: 'amber',
      },
      { label: 'Pedidos abiertos', value: hoy.pedidosPendientes ?? 0, goto: 'pedidos', icon: ICONS.box, tone: 'purple' },
    ];
    $('#stats').innerHTML = cards
      .map(
        (card) => `<button class="stat stat--${card.tone} ${card.alert ? 'stat--alert' : ''}" data-goto="${card.goto}" type="button">
            <span class="stat__icon" aria-hidden="true">${card.icon}</span>
            <span class="stat__value">${card.value}</span>
            <span class="stat__label">${escapeHtml(card.label)}</span>
            <span class="stat__arrow" aria-hidden="true">${ICONS.chevron}</span>
          </button>`,
      )
      .join('');
  }

  function renderProductos() {
    const box = $('#inventory-view');
    if (!box) return;
    const inv = state.inventory;
    if (!inv) {
      box.innerHTML = '<div class="card"><p class="card__text">Cargando inventario…</p></div>';
      if (!state.inventoryLoading && state.online) loadInventory().catch(() => {});
      return;
    }
    const movements = inv.movements ?? [];
    const canSeeCost = hasPermission('cost.view');
    const stockCapsules = Number(inv.stock ?? 0);
    const unitCostCents = Number(inv.product?.current_unit_cost_cents ?? 0);
    const inventoryValueCents = Number(inv.inventory_value_cents ?? stockCapsules * unitCostCents);
    box.innerHTML = `
      ${
        canSeeCost
          ? `<section class="inventory-summary" aria-label="Recuento de inventario">
              <span class="inventory-summary__label">Invertido en producto</span>
              <strong class="inventory-summary__value">${moneyCents(inventoryValueCents)}</strong>
              <span class="inventory-summary__meta">${escapeHtml(stockCapsules)} cápsulas × ${moneyCents(unitCostCents)} por cápsula</span>
            </section>`
          : ''
      }
      <div class="card">
        <p class="card__title">${escapeHtml(inv.product?.name ?? 'Phytoemagry')}</p>
        <dl class="facts">
          <div class="fact"><dt>Stock</dt><dd>${escapeHtml(stockCapsules)} cápsulas</dd></div>
          ${canSeeCost ? `<div class="fact"><dt>Costo vigente</dt><dd>${moneyCents(unitCostCents)} / cápsula</dd></div>` : ''}
          <div class="fact"><dt>Control activo</dt><dd>${inv.initialized ? 'sí' : 'sin inventario inicial'}</dd></div>
        </dl>
      </div>
      <div class="card">
        <p class="card__title">Presentaciones</p>
        <dl class="facts">
          ${(inv.presentations ?? [])
            .map(
              (item) => `<div class="fact"><dt>${escapeHtml(item.name)}</dt><dd>${money(item.price)} · ${escapeHtml(
                item.capsule_quantity,
              )} cáps.${canSeeCost ? ` · costo ${moneyCents(item.presentation_cost_cents)}` : ''}</dd></div>`,
            )
            .join('')}
        </dl>
      </div>
      ${
        canSeeCost
          ? `<form class="card" id="inventory-restock">
        <p class="card__title">Agregar inventario</p>
        <label class="field"><span class="field__label">Cápsulas</span><input class="field__input" name="quantity" type="number" min="1" step="1" required /></label>
        <label class="field"><span class="field__label">Costo unitario</span><input class="field__input" name="unitCost" type="number" min="0" step="0.01" value="${escapeHtml(
          ((inv.product?.current_unit_cost_cents ?? 0) / 100).toFixed(2),
        )}" required /></label>
        <label class="field"><span class="field__label">Motivo</span><input class="field__input" name="reason" value="Reposición" /></label>
        <button class="btn btn--primary btn--block" type="submit">Agregar stock</button>
      </form>
      <form class="card" id="inventory-cost">
        <p class="card__title">Costo vigente</p>
        <label class="field"><span class="field__label">Costo por cápsula</span><input class="field__input" name="unitCost" type="number" min="0" step="0.01" value="${escapeHtml(
          ((inv.product?.current_unit_cost_cents ?? 0) / 100).toFixed(2),
        )}" required /></label>
        <button class="btn btn--ghost btn--block" type="submit">Actualizar costo</button>
      </form>
      <form class="card" id="inventory-adjust">
        <p class="card__title">Ajuste manual</p>
        <label class="field"><span class="field__label">Tipo</span><select class="field__select" name="direction"><option value="in">Entrada</option><option value="out">Salida</option></select></label>
        <label class="field"><span class="field__label">Cápsulas</span><input class="field__input" name="quantity" type="number" min="1" step="1" required /></label>
        <label class="field"><span class="field__label">Motivo</span><input class="field__input" name="reason" value="Ajuste manual" /></label>
        <button class="btn btn--ghost btn--block" type="submit">Guardar ajuste</button>
      </form>
      <form class="card" id="inventory-count">
        <p class="card__title">Recuento físico</p>
        <label class="field"><span class="field__label">Cápsulas contadas</span><input class="field__input" name="countedQuantity" type="number" min="0" step="1" required /></label>
        <label class="field"><span class="field__label">Motivo</span><input class="field__input" name="reason" value="Recuento físico" /></label>
        <button class="btn btn--ghost btn--block" type="submit">Guardar recuento</button>
      </form>`
          : ''
      }
      <div class="card">
        <p class="card__title">Movimientos recientes</p>
        <dl class="facts">
          ${
            movements.length
              ? movements
                  .slice(0, 12)
                  .map(
                    (row) =>
                      `<div class="fact"><dt>${escapeHtml(fmtWhen(row.created_at))} · ${escapeHtml(row.type)}</dt><dd>${escapeHtml(
                        row.quantity_delta,
                      )} cápsulas${row.reason ? ` · ${escapeHtml(row.reason)}` : ''}</dd></div>`,
                  )
                  .join('')
              : '<div class="fact"><dt>Sin movimientos</dt><dd>Agrega inventario para activar control estricto de stock.</dd></div>'
          }
        </dl>
      </div>`;
  }

  function renderReportes() {
    const box = $('#sales-report-view');
    if (!box) return;
    if (!hasPermission('reports.profit.view')) {
      box.innerHTML = '';
      return;
    }
    $('#sales-report-period')
      ?.querySelectorAll('[data-report-period]')
      .forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.reportPeriod === state.salesReportPeriod)));
    const report = state.salesReport;
    if (!report) {
      box.innerHTML = '<div class="card"><p class="card__text">Cargando reporte…</p></div>';
      if (!state.salesReportLoading && state.online) loadSalesReport(state.salesReportPeriod).catch(() => {});
      return;
    }
    const s = report.summary ?? {};
    box.innerHTML = `
      <div class="card">
        <p class="card__title">Utilidad</p>
        <dl class="facts">
          <div class="fact"><dt>Ventas entregadas</dt><dd>${escapeHtml(s.orders ?? 0)}</dd></div>
          <div class="fact"><dt>Ingresos productos</dt><dd>${moneyCents(s.product_revenue_cents)}</dd></div>
          <div class="fact"><dt>Delivery cobrado</dt><dd>${moneyCents(s.delivery_revenue_cents)}</dd></div>
          <div class="fact"><dt>Total cobrado</dt><dd>${moneyCents(s.total_collected_cents)}</dd></div>
          <div class="fact"><dt>Costo producto</dt><dd>${moneyCents(s.product_cost_cents)}</dd></div>
          <div class="fact"><dt>Utilidad bruta producto</dt><dd>${moneyCents(s.gross_product_profit_cents)}</dd></div>
          <div class="fact"><dt>Cápsulas vendidas</dt><dd>${escapeHtml(s.capsules_sold ?? 0)}</dd></div>
        </dl>
      </div>
      <div class="card">
        <p class="card__title">Por presentación</p>
        <dl class="facts">
          ${
            (report.byPresentation ?? []).length
              ? report.byPresentation
                  .map(
                    (row) =>
                      `<div class="fact"><dt>${escapeHtml(row.presentation)}</dt><dd>${escapeHtml(row.units)} frasco(s) · ${escapeHtml(
                        row.capsules,
                      )} cáps. · utilidad ${moneyCents(row.gross_product_profit_cents)}</dd></div>`,
                  )
                  .join('')
              : '<div class="fact"><dt>Sin ventas</dt><dd>No hay entregas en este período.</dd></div>'
          }
        </dl>
      </div>
      <div class="card">
        <p class="card__title">Ventas</p>
        <dl class="facts">
          ${
            (report.sales ?? []).length
              ? report.sales
                  .slice(0, 20)
                  .map(
                    (row) =>
                      `<div class="fact"><dt>${escapeHtml(row.order_number ?? row.id)} · ${escapeHtml(fmtWhen(row.date))}</dt><dd>${escapeHtml(
                        row.presentation,
                      )} · ${escapeHtml(row.payment_method_label ?? paymentMethodLabel(row.payment_method))} · cobrado ${moneyCents(row.total_collected_cents)} · utilidad ${moneyCents(
                        row.gross_product_profit_cents,
                      )}</dd></div>`,
                  )
                  .join('')
              : '<div class="fact"><dt>Sin ventas</dt><dd>No hay detalle para mostrar.</dd></div>'
          }
        </dl>
      </div>`;
  }

  function itemCard(item) {
    const today = todayISO();
    const vencido = item.next_action_at && item.next_action_at <= today && !['entregado', 'perdido'].includes(item.status);
    const cerrado = ['entregado', 'perdido'].includes(item.status);
    const phone = digits(item.phone);
    return `<article class="item ${item.type === 'order_intent' ? 'item--pedido' : ''} ${
      vencido ? 'item--hoy' : ''
    } ${cerrado ? 'item--cerrado' : ''}" data-open="${escapeHtml(item.id)}">
        <div class="item__top">
          <div>
            <p class="item__name">${escapeHtml(item.name ?? 'Sin nombre')}</p>
            <span class="tag tag--${escapeHtml(item.status ?? 'nuevo')}">${escapeHtml(statusLabel(item.status ?? 'nuevo'))}</span>
            ${item.type === 'order_intent' ? '<span class="tag">Pedido</span>' : '<span class="tag">Contacto</span>'}
            ${
              item.next_action_at
                ? `<span class="tag tag--recordatorio">${escapeHtml(fmtDay(item.next_action_at))}</span>`
                : ''
            }
          </div>
          <span class="item__when">${escapeHtml(fmtWhen(item.received_at))}</span>
        </div>
        <p class="item__meta">
          ${item.order_number ? `${escapeHtml(item.order_number)} · ` : ''}
          ${item.variant_name ? `${escapeHtml(item.variant_name)}${item.quantity ? ` ×${item.quantity}` : ''} · ` : ''}
          ${item.total ? `${money(item.total, item.currency)} · ` : ''}
          ${item.phone ? escapeHtml(item.phone) : 'sin teléfono'}
          ${item.location ? ` · ${escapeHtml(item.location)}` : ''}
        </p>
        ${item.notes ? `<p class="item__notes">📝 ${escapeHtml(item.notes)}</p>` : ''}
        <div class="item__actions">
          ${
            phone
              ? `<button class="btn btn--whatsapp btn--sm" data-wa="${escapeHtml(item.id)}" type="button">Escribir por WhatsApp</button>`
              : '<button class="btn btn--ghost btn--sm" type="button" disabled>Cliente escribió primero</button>'
          }
          ${
            item.type === 'order_intent'
              ? `<button class="btn btn--ghost btn--sm" data-receipt="${escapeHtml(item.id)}" type="button">Comprobante</button>`
              : ''
          }
          <button class="btn btn--ghost btn--sm" data-open="${escapeHtml(item.id)}" type="button">Abrir ficha</button>
        </div>
      </article>`;
  }

  function dashboardLeadRow(item) {
    const name = item.name ?? 'Sin nombre';
    const summary = [
      item.variant_name ? `${item.variant_name}${item.quantity ? ` ×${item.quantity}` : ''}` : null,
      item.phone || 'sin teléfono',
    ]
      .filter(Boolean)
      .join(' · ');
    return `<article class="dash-row" data-open="${escapeHtml(item.id)}">
      <span class="avatar dash-row__avatar" aria-hidden="true">${escapeHtml(waInitials(name))}</span>
      <span class="dash-row__body">
        <span class="dash-row__top">
          <strong>${escapeHtml(name)}</strong>
          <small>${escapeHtml(fmtWhen(item.received_at))}</small>
        </span>
        <span class="dash-row__chips">
          <span class="tag tag--${escapeHtml(item.status ?? 'nuevo')}">Nuevo</span>
          <span class="tag">Contacto</span>
        </span>
        <span class="dash-row__summary">${escapeHtml(summary)}</span>
      </span>
      <button class="btn btn--ghost btn--sm dash-row__action" data-open="${escapeHtml(item.id)}" type="button">Abrir ficha</button>
    </article>`;
  }

  const emptyState = (text) => `<p class="empty">${escapeHtml(text)}</p>`;

  // ------------------------------------------- clientes, WhatsApp, seguimiento

  const customerById = (id) => state.customers.find((row) => row.id === id) ?? null;

  const conversationForCustomer = (customerId) =>
    state.conversations.find((row) => row.customer_id === customerId) ?? null;

  /**
   * El cliente de un pedido.
   *
   * El pedido lo trae casi siempre, pero los pedidos que llegan por la web pueden
   * no traerlo (o venir de una prueba sin teléfono): se busca por su conversación y,
   * si no, por el teléfono entre los clientes que el panel ya conoce. Sin esto, un
   * pedido sin `customer_id` se quedaba sin las acciones de cliente (ver ficha,
   * seguimiento, mensaje programado) sin decir por qué.
   */
  function customerIdForItem(item) {
    if (!item) return null;
    if (item.customer_id) return item.customer_id;
    const conversacion = (state.conversations ?? []).find((row) => row.id === item.conversation_id);
    if (conversacion?.customer_id) return conversacion.customer_id;
    const phone = digits(item.phone);
    if (!phone) return null;
    const cliente = (state.customers ?? []).find(
      (row) => digits(row.phone_e164) === phone || digits(row.phone) === phone,
    );
    return cliente?.id ?? null;
  }

  /** Todas las tareas pendientes (vencidas + hoy + próximas), de la más cercana a la más lejana. */
  const pendingFollowups = () =>
    [...(state.followups?.overdue ?? []), ...(state.followups?.today ?? []), ...(state.followups?.upcoming ?? [])].sort(
      (a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)),
    );

  const nextFollowupFor = (customerId) => pendingFollowups().find((row) => row.customer_id === customerId) ?? null;

  /** Última compra ENTREGADA del cliente (el dinero que de verdad entró). */
  const lastPurchase = (customerId) =>
    state.items
      .filter((item) => item.customer_id === customerId && item.status === 'entregado')
      .sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)))[0] ?? null;

  const ordersForCustomer = (customerId) =>
    state.items
      .filter((item) => item.customer_id === customerId && item.type === 'order_intent')
      .sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)));

  /**
   * PEDIDOS VIVOS del cliente: ni entregados ni cancelados.
   *
   * Se usa para las dos cosas que pide el negocio: avisar de que ya tiene un
   * pedido abierto antes de crearle otro, y saber a cuáles se les puede colgar un
   * dato nuevo (por ejemplo la ubicación que acaba de mandar).
   */
  function liveOrdersForCustomer(customerId) {
    return ordersNewestFirst(ordersForCustomer(customerId)).filter((item) => {
      const estado = getOrderOperationalStatus(itemOrder(item), deliverySessionForOrder(item.id));
      return estado !== 'ENTREGADO' && estado !== 'CANCELADO';
    });
  }

  /** «¿Cuál es el pedido más reciente?», con el MISMO criterio que el servidor. */
  const orderRecency = (item) => String(item?.updated_at ?? item?.created_at ?? item?.received_at ?? '');
  const ordersNewestFirst = (rows) =>
    rows.slice().sort((a, b) => orderRecency(b).localeCompare(orderRecency(a)));

  const orderPaymentMethodOf = (item) => itemOrder(item)?.payment_method ?? item?.payment_method ?? null;
  const orderTotalOf = (item) => {
    const order = itemOrder(item) ?? {};
    const total = order.total ?? item?.total ?? null;
    return total === null || total === undefined || total === ''
      ? ''
      : money(total, order.currency ?? item?.currency);
  };

  /**
   * PREFERENCIAS DE PEDIDO del cliente: lo que se repite en CADA pedido (frasco,
   * cantidad, forma de pago, ubicación de entrega y una nota).
   *
   * Si el negocio las guardó, mandan. Si no, se deducen del ÚLTIMO pedido: así el
   * formulario viene relleno desde el primer día, sin configurar nada.
   */
  function customerOrderPrefs(customerId) {
    const customer = customerById(customerId) ?? null;
    const guardadas = customer?.orderPrefs ?? customer?.order_prefs ?? null;
    const ultimo = ordersNewestFirst(ordersForCustomer(customerId))[0] ?? null;
    return {
      variant_id: guardadas?.variant_id ?? ultimo?.variant_id ?? null,
      quantity: Number(guardadas?.quantity ?? ultimo?.quantity ?? 0) || null,
      payment_method: guardadas?.payment_method ?? orderPaymentMethodOf(ultimo),
      location_id: guardadas?.location_id ?? null,
      note: guardadas?.note ?? null,
      saved: Boolean(guardadas),
    };
  }

  /** Una línea con lo que el CRM reutilizará de este cliente. */
  function orderPrefsSummary(prefs, locations = []) {
    if (!prefs) return '';
    const variante = (state.catalog ?? []).find((row) => row.id === prefs.variant_id);
    return [
      variante ? `${variante.label}${prefs.quantity ? ` ×${prefs.quantity}` : ''}` : null,
      prefs.payment_method ? paymentMethodLabel(prefs.payment_method) : null,
      prefs.location_id ? locationTitle(locations.find((row) => row.id === prefs.location_id)) : null,
      prefs.note ? `«${prefs.note}»` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  /**
   * Ubicación de entrega que el CRM da por buena: la guardada en las preferencias
   * y, si no, la del último pedido; y si tampoco, la última que COMPARTIÓ el
   * cliente (nunca una que le hayamos enviado nosotros).
   */
  function preferredDeliveryLocation(customerId, locations = []) {
    const prefs = customerOrderPrefs(customerId);
    if (prefs.location_id) {
      const guardada = locations.find((row) => row.id === prefs.location_id);
      if (guardada) return guardada;
    }
    const ultimo = ordersNewestFirst(ordersForCustomer(customerId))[0] ?? null;
    const delPedido = ultimo ? itemOrder(ultimo)?.delivery?.location?.source_location_id ?? null : null;
    return (
      (delPedido ? locations.find((row) => row.id === delPedido) : null) ??
      locations.find((row) => String(row.source ?? '') === 'whatsapp_inbound') ??
      null
    );
  }

  /** Compras del cliente: cuántas, cuánto ha invertido y cuál fue la última. */
  function customerPurchaseStats(customerId) {
    const orders = ordersForCustomer(customerId);
    const delivered = orders.filter((row) => row.status === 'entregado');
    const invested = delivered.reduce((sum, row) => sum + (Number(row.total) || 0), 0);
    return { orders, count: orders.length, delivered: delivered.length, invested, last: ordersNewestFirst(orders)[0] ?? null };
  }

  function customerSalesSummary(customer) {
    const orders = ordersForCustomer(customer.id);
    const delivered = orders.filter((row) => row.status === 'entregado');
    const total = delivered.reduce((sum, row) => sum + (Number(row.total) || 0), 0);
    const latest = orders[0] ?? null;
    return { orders, delivered, total, latest };
  }

  function customerSegment(customer) {
    const summary = customerSalesSummary(customer);
    const commercial = customer.commercial_state ?? 'NUEVO';
    if (summary.delivered.length > 0 || customer.has_purchase === true) return 'cliente';
    if (['INTERESADO', 'PEDIDO_CREADO', 'CONFIRMADO', 'SEGUIMIENTO'].includes(commercial) || summary.orders.length > 0) {
      return 'interesado';
    }
    return 'prospecto';
  }

  const customerSegmentLabel = (segment, summary) =>
    segment === 'cliente'
      ? summary.delivered.length >= 2
        ? 'Cliente frecuente'
        : 'Cliente'
      : segment === 'interesado'
        ? 'Interesado'
        : 'Prospecto';

  const FOLLOWUP_LABELS = {
    thanks: 'Agradecimiento',
    checkin: '¿Cómo va?',
    education: 'Información',
    reorder: 'Recompra',
    alert: 'Aviso',
    manual: 'Manual',
  };
  const followupLabel = (type) => FOLLOWUP_LABELS[type] ?? type ?? 'Seguimiento';

  /** Tarjeta de una tarea de seguimiento: dice a QUIÉN y para CUÁNDO. */
  function followupCard(row) {
    const customer = row.customer ?? customerById(row.customer_id);
    const conversation = conversationForCustomer(row.customer_id);
    const late = row.scheduled_at < todayISO();
    return `<article class="item ${late ? 'item--hoy' : ''}">
        <div class="item__top">
          <div>
            <p class="item__name">${escapeHtml(customer?.name ?? customer?.phone_e164 ?? 'Cliente')}</p>
            <span class="tag tag--recordatorio">${escapeHtml(fmtDay(row.scheduled_at))}</span>
            <span class="tag">${escapeHtml(followupLabel(row.type))}</span>
            ${row.origin === 'manual' ? '<span class="tag">Manual</span>' : ''}
          </div>
        </div>
        <p class="item__meta">${escapeHtml(row.reason ?? 'Seguimiento')}</p>
        <div class="item__actions">
          ${
            conversation
              ? `<button class="btn btn--whatsapp btn--sm" data-chat="${escapeHtml(conversation.id)}" data-followup="${
                  escapeHtml(row.id)
                }" type="button">Escribir ahora</button>`
              : ''
          }
          <button class="btn btn--ghost btn--sm" data-followup-done="${escapeHtml(row.id)}" type="button">Hecho</button>
          <button class="btn btn--ghost btn--sm" data-followup-postpone="${escapeHtml(row.id)}" type="button">+3 días</button>
          <button class="btn btn--ghost btn--sm" data-followup-cancel="${escapeHtml(row.id)}" type="button">Cancelar</button>
          ${customer ? `<button class="btn btn--ghost btn--sm" data-customer="${escapeHtml(customer.id)}" type="button">Ficha</button>` : ''}
        </div>
      </article>`;
  }

  /** Tarjeta de una conversación de WhatsApp. */
  function conversationCard(row) {
    const customer = row.customer ?? customerById(row.customer_id);
    const unread = Number(row.unread_count) || 0;
    const next = nextFollowupFor(row.customer_id);
    const purchase = lastPurchase(row.customer_id);
    const needsHuman = row.status === 'HUMAN_REQUIRED';
    return `<article class="item ${unread > 0 ? 'item--hoy' : ''}" data-chat="${escapeHtml(row.id)}">
        <div class="item__top">
          <div>
            <p class="item__name">${escapeHtml(customer?.name ?? customer?.phone_e164 ?? 'Cliente')}</p>
            ${unread > 0 ? `<span class="tag tag--nuevo">${unread} sin leer</span>` : ''}
            ${needsHuman ? '<span class="tag tag--recordatorio">Necesita una persona</span>' : ''}
            ${customer?.do_not_contact ? '<span class="tag tag--perdido">No contactar</span>' : ''}
            ${next ? `<span class="tag tag--recordatorio">${escapeHtml(fmtDay(next.scheduled_at))}</span>` : ''}
          </div>
          <span class="item__when">${row.last_message_at ? escapeHtml(fmtWhen(row.last_message_at)) : ''}</span>
        </div>
        <p class="item__meta">
          ${
            row.last_message
              ? `${row.last_message.direction === 'inbound' ? 'Cliente: ' : 'Tú: '}${escapeHtml(
                  String(row.last_message.body ?? '').slice(0, 90),
                )}`
              : 'Sin mensajes todavía'
          }
        </p>
        ${
          purchase
            ? `<p class="item__meta">Última compra: ${escapeHtml(purchase.variant_name ?? '')} ${money(
                purchase.total,
                purchase.currency,
              )} · ${escapeHtml(fmtWhen(purchase.received_at))}</p>`
            : '<p class="item__meta">Sin compras entregadas todavía</p>'
        }
        <div class="item__actions">
          <button class="btn btn--whatsapp btn--sm" data-chat="${escapeHtml(row.id)}" type="button">Abrir chat</button>
          <button class="btn btn--ghost btn--sm" data-customer="${escapeHtml(customer?.id ?? '')}" type="button">Ficha</button>
          <button class="btn btn--ghost btn--sm" data-purchase="${escapeHtml(customer?.id ?? '')}" type="button">Registrar compra</button>
        </div>
      </article>`;
  }

  const section = (title, count, html) =>
    `<h2 class="view__title">${escapeHtml(title)}${count ? ` (${count})` : ''}</h2><div class="list">${html}</div>`;

  function renderHoy() {
    const today = todayISO();
    const followups = state.followups ?? { today: [], overdue: [], upcoming: [] };
    const hoy = state.hoy ?? {};

    const pendientes = state.items
      .filter(
        (item) =>
          item.next_action_at &&
          item.next_action_at <= today &&
          !['entregado', 'perdido'].includes(item.status ?? 'nuevo'),
      )
      .sort((a, b) => String(a.next_action_at).localeCompare(String(b.next_action_at)));

    // Los que ya salen arriba no se repiten abajo (ver al mismo cliente dos veces
    // en la misma pantalla hace dudar de si son dos cosas distintas).
    const yaListados = new Set(pendientes.map((item) => item.id));
    const nuevos = state.items
      .filter((item) => (item.status ?? 'nuevo') === 'nuevo' && !yaListados.has(item.id))
      .slice(0, 5);

    // Conversaciones: lo que no se ha leído y lo que pide una persona. Una
    // conversación que necesita una persona se lista UNA vez.
    // “Sin contestar” = el último mensaje lo escribió el cliente y todavía no le
    // hemos respondido. NO se apaga por abrir la conversación: solo al responder.
    const sinLeer = state.conversations.filter((row) => row.awaiting_reply === true);
    const humano = state.conversations.filter(
      (row) => row.status === 'HUMAN_REQUIRED' && !sinLeer.some((other) => other.id === row.id),
    );

    const pedidosAbiertos = state.items.filter(
      (item) => item.type === 'order_intent' && !['entregado', 'perdido'].includes(item.status ?? 'nuevo'),
    );

    const bloques = [
      followups.overdue?.length
        ? section('Seguimientos vencidos', followups.overdue.length, followups.overdue.map(followupCard).join(''))
        : '',
      followups.today?.length
        ? section('Seguimientos de hoy', followups.today.length, followups.today.map(followupCard).join(''))
        : '',
      humano.length
        ? section('Necesitan una persona', humano.length, humano.map(conversationCard).join(''))
        : '',
      sinLeer.length
        ? section('Esperando respuesta', sinLeer.length, sinLeer.map(conversationCard).join(''))
        : '',
      pendientes.length
        ? section('Recordatorios de hoy', pendientes.length, pendientes.map(itemCard).join(''))
        : '',
      nuevos.length
        ? `<div class="dash-section">
            <div class="dash-section__head">
              <h2>Sin contactar (${nuevos.length})</h2>
              <button class="dash-section__link" data-dashboard-tab="clientes" type="button">Ver todos ${ICONS.chevron}</button>
            </div>
            <div class="dash-list">${nuevos.map(dashboardLeadRow).join('')}</div>
          </div>`
        : '',
      pedidosAbiertos.length
        ? section('Pedidos sin cerrar', pedidosAbiertos.length, pedidosAbiertos.slice(0, 5).map(itemCard).join(''))
        : '',
    ]
      .filter(Boolean)
      .join('');

    $('#list-hoy').innerHTML =
      bloques || emptyState('Todo al día 👌 Nada pendiente y ningún mensaje sin contestar.');
  }

  function renderWhatsapp() {
    const wa = state.whatsapp ?? { configured: false };
    /*
     * En WhatsApp NO se anuncia "conectado" ni se repite el número del negocio:
     * es SU número y la pantalla ya dice dónde estamos. Solo se avisa cuando hay
     * algo que hacer de verdad: que WhatsApp no esté configurado en el servidor.
     */
    $('#wa-status').innerHTML = wa.configured
      ? ''
      : `<p class="rule rule--warn">WhatsApp todavía no está configurado en el servidor. Puedes registrar
         clientes y compras y ver sus fichas, pero el panel no envía ni recibe mensajes. Faltan las
         variables del servidor (ver docs/WHATSAPP_INTEGRATION.md).</p>`;

    const filters = $('#wa-filters');
    if (filters) {
      filters.innerHTML = WA_FILTERS.map(
        ([value, text]) => {
          const count = waFilterCount(value);
          const label = Number.isFinite(Number(count)) && Number(count) > 0 ? `${text} ${count}` : text;
          return (
          `<button class="chip" data-wa-filter="${value}" aria-pressed="${
            value === state.wa.filter
          }" type="button">${label}</button>`
          );
        },
      ).join('') + `<button class="chip" id="wa-notify" type="button">${
        state.wa.notify ? 'Notificaciones activas' : 'Activar notificaciones'
      }</button><button class="chip" id="wa-sound" aria-pressed="${state.wa.sound}" type="button">Sonido ${
        state.wa.sound ? 'sí' : 'no'
      }</button>${waDateChipHtml()}`;
    }
    const search = $('#wa-search');
    if (search && search.value !== state.wa.q) search.value = state.wa.q;

    renderWaList();
    renderWaChat();
  }
  function filteredItems() {
    const { filter, q } = state;
    const today = todayISO();
    let items = state.items.slice();
    if (filter === 'nuevos') items = items.filter((item) => (item.status ?? 'nuevo') === 'nuevo');
    if (filter === 'pedidos') items = items.filter((item) => item.type === 'order_intent');
    if (filter === 'recordatorio') items = items.filter((item) => item.next_action_at);
    if (filter === 'hoy') items = items.filter((item) => item.next_action_at && item.next_action_at <= today);
    if (filter === 'entregados') items = items.filter((item) => item.status === 'entregado');
    if (q) {
      const needle = q.toLowerCase();
      items = items.filter((item) =>
        [item.name, item.phone, item.location, item.variant_name, item.notes]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle),
      );
    }
    return items;
  }

  function filteredCustomers() {
    const { filter, q } = state;
    let rows = state.customers.slice();
    if (filter === 'clientes') rows = rows.filter((customer) => customerSegment(customer) === 'cliente');
    if (filter === 'interesados') rows = rows.filter((customer) => customerSegment(customer) === 'interesado');
    if (filter === 'prospectos') rows = rows.filter((customer) => customerSegment(customer) === 'prospecto');
    if (filter === 'seguimiento') rows = rows.filter((customer) => Boolean(nextFollowupFor(customer.id) || customer.next_followup));
    if (q) {
      const needle = q.toLowerCase();
      rows = rows.filter((customer) =>
        [
          customer.name,
          customer.phone,
          customer.phone_e164,
          customer.location,
          customer.city,
          customer.email,
          customer.document,
          customer.cedula,
          customer.commercial_state,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle),
      );
    }
    return rows.sort((a, b) => {
      const sa = customerSalesSummary(a);
      const sb = customerSalesSummary(b);
      const aa = a.last_contact_at ?? sa.latest?.received_at ?? a.updated_at ?? a.created_at ?? '';
      const bb = b.last_contact_at ?? sb.latest?.received_at ?? b.updated_at ?? b.created_at ?? '';
      return String(bb).localeCompare(String(aa));
    });
  }

  function customerRow(customer) {
    const summary = customerSalesSummary(customer);
    const segment = customerSegment(customer);
    const conversation = conversationForCustomer(customer.id);
    const next = nextFollowupFor(customer.id) ?? customer.next_followup ?? null;
    const latestAt = customer.last_contact_at ?? summary.latest?.received_at ?? customer.updated_at ?? customer.created_at;
    const sales =
      summary.delivered.length > 0
        ? `${summary.delivered.length} compra${summary.delivered.length === 1 ? '' : 's'} · ${money(summary.total)}`
        : summary.orders.length > 0
          ? `${summary.orders.length} pedido${summary.orders.length === 1 ? '' : 's'} en proceso`
          : 'Sin compra';
    const reference = summary.latest?.order_number ?? summary.latest?.id ?? '';
    return `<article class="client-row client-row--${escapeHtml(segment)}">
      <button class="client-row__main" data-customer="${escapeHtml(customer.id)}" type="button" aria-label="Abrir perfil de ${escapeHtml(
        customerName(customer),
      )}">
        ${avatarHtml(customer, customerName(customer), 'client-row__avatar')}
        <span class="client-row__body">
          <span class="client-row__topline">
            <strong>${escapeHtml(customerName(customer))}</strong>
            <span class="client-row__when">${latestAt ? escapeHtml(fmtWhen(latestAt)) : ''}</span>
          </span>
          <span class="client-row__meta">
            <span class="tag client-row__tag">${escapeHtml(customerSegmentLabel(segment, summary))}</span>
            ${customer.do_not_contact ? '<span class="tag tag--perdido client-row__tag">No contactar</span>' : ''}
            ${next ? `<span class="tag tag--recordatorio client-row__tag">${escapeHtml(fmtDay(next.scheduled_at ?? next))}</span>` : ''}
            <span>${escapeHtml(customer.phone_e164 ?? customer.phone ?? 'sin teléfono')}</span>
          </span>
          <span class="client-row__sales">
            <span>${escapeHtml(sales)}</span>
            ${reference ? `<span>Ref. ${escapeHtml(reference)}</span>` : ''}
            ${summary.latest?.variant_name ? `<span>${escapeHtml(summary.latest.variant_name)}</span>` : ''}
          </span>
        </span>
      </button>
      <div class="client-row__actions">
        ${conversation ? `<button class="icon-btn client-row__icon" data-chat="${escapeHtml(conversation.id)}" type="button" aria-label="Abrir chat">${ICONS.chat}</button>` : ''}
        <button class="icon-btn client-row__icon" data-order-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversation?.id ?? '',
        )}" type="button" aria-label="Crear pedido">${ICONS.bag}</button>
      </div>
    </article>`;
  }

  function renderClientes() {
    const customers = filteredCustomers();
    $('#clientes-count').textContent = `${customers.length} de ${state.customers.length} clientes`;
    $('#list-clientes').innerHTML = customers.length
      ? customers.map(customerRow).join('')
      : emptyState('No hay clientes con este filtro.');
  }

  /** Los filtros de la lista de pedidos, con el estado operativo (no el técnico). */
  const ORDER_FILTERS = [
    ['todo', 'Todo'],
    ['pendiente', 'Pendientes'],
    ['en-camino', 'En camino'],
    ['entregado', 'Entregados'],
    ['cancelado', 'Cancelados'],
  ];

  /** «en-camino» (URL) → «EN_CAMINO» (estado operativo). */
  const orderFilterValue = (filter) => String(filter ?? '').replace(/-/g, '_').toUpperCase();

  /** Estado operativo ya resuelto del pedido (una sola vez por fila). */
  const orderOperational = (item) =>
    getOrderOperationalStatus(itemOrder(item), deliverySessionForOrder(item.id));

  /**
   * UNA FILA DE PEDIDO: dos líneas de datos y una tercera corta con el contacto y
   * quién lo atiende.
   *
   * De un vistazo: quién es el cliente (nombre y teléfono), cuánto y en qué estado,
   * y quién lo atendió. Los botones grandes (WhatsApp, comprobante, ficha) viven en
   * la ficha del pedido, que se abre tocando la fila: en una lista larga, eso es la
   * diferencia entre leerla y no leerla.
   */
  function orderRow(item) {
    const estado = orderOperational(item);
    const order = itemOrder(item) ?? {};
    const agente = orderAgent(item);
    const entregado = ['ENTREGADO', 'CANCELADO'].includes(estado);
    const repartidor = order.delivery?.delivery_user_name_snapshot ?? null;
    const meta = [
      item.order_number ?? order.order_number ?? null,
      item.variant_name ? `${item.variant_name}${item.quantity ? ` ×${item.quantity}` : ''}` : null,
      orderTotalOf(item) || null,
    ].filter(Boolean);
    /*
     * La referencia dice quién es el cliente (teléfono), quién atiende y si el
     * pedido TODAVÍA NO tiene repartidor: es el dato que se necesita para pasarlo
     * a delivery, y hasta ahora había que adivinarlo mirando el mapa.
     */
    const referencia = [
      item.phone ?? null,
      `Atendido por ${agente.label}`,
      entregado ? null : repartidor ? `Delivery ${repartidor}` : 'sin delivery',
    ]
      .filter(Boolean)
      .join(' · ');
    return `<button class="order-row order-row--${escapeHtml(
      estado.toLowerCase(),
    )}" data-open="${escapeHtml(item.id)}" type="button">
      <span class="order-row__top">
        <strong class="order-row__name">${escapeHtml(item.name ?? 'Sin nombre')}</strong>
        <span class="order-row__when">${escapeHtml(fmtWhen(item.received_at))}</span>
      </span>
      <span class="order-row__bottom">
        <span class="order-row__meta">${escapeHtml(meta.join(' · '))}</span>
        <span class="order-row__status">${escapeHtml(operationalStatusLabel(estado))}</span>
      </span>
      <span class="order-row__ref">${escapeHtml(referencia)}</span>
    </button>`;
  }

  /** Pedidos y compras (menú lateral): lo que entró por la web o se apuntó a mano. */
  /**
   * QUIÉN ATENDIÓ EL PEDIDO.
   *
   * Lo dicen los datos del propio pedido (quien lo creó y quien lo tocó por última
   * vez) y, si no hay nada, la conversación que lo atiende. No se inventa nada: sin
   * datos se dice «Sin asignar», que es justo lo que hay que ver para repartir el
   * trabajo.
   */
  function orderAgent(item) {
    const order = itemOrder(item) ?? {};
    const conversacion = item?.customer_id ? conversationForCustomer(item.customer_id) : null;
    const asignado = conversacion?.assigned_display_name_snapshot ?? null;
    const creador = order.created_by_display_name_snapshot ?? null;
    const ultimo = order.updated_by_display_name_snapshot ?? null;
    return { asignado, creador, ultimo, label: asignado ?? ultimo ?? creador ?? 'Sin asignar' };
  }

  function renderPedidos() {
    const box = $('#list-pedidos');
    if (!box) return;
    const items = ordersNewestFirst(applyOutbox(state.items.filter((item) => item.type === 'order_intent')));
    const filter = state.pedidosFilter ?? 'todo';
    const byFilter = (value) =>
      value === 'todo' ? items : items.filter((item) => orderOperational(item) === orderFilterValue(value));
    const visibles = byFilter(filter);
    // Cada chip lleva su cuenta: se ve cuántos hay sin abrir el filtro.
    $$('#pedidos-filtros [data-order-filter]').forEach((chip) => {
      const value = chip.dataset.orderFilter;
      const total = byFilter(value).length;
      const base = ORDER_FILTERS.find(([known]) => known === value)?.[1] ?? 'Pedidos';
      chip.textContent = total ? `${base} ${total}` : base;
      chip.setAttribute('aria-pressed', String(value === filter));
    });
    const count = $('#pedidos-count');
    if (count) {
      count.textContent = !items.length
        ? ''
        : visibles.length === items.length
          ? `${items.length} ${items.length === 1 ? 'pedido' : 'pedidos'}`
          : `${visibles.length} de ${items.length} pedidos`;
    }
    box.innerHTML = visibles.length
      ? visibles.map(orderRow).join('')
      : emptyState(
          items.length ? 'Ningún pedido con ese estado.' : 'Todavía no hay pedidos registrados.',
        );
  }

  function itemOrder(item) {
    const raw = item?.order_json ?? item?.orderJson;
    if (raw) {
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (parsed) return parsed;
      } catch {
        /* cae al resumen desde columnas */
      }
    }
    return item?.type === 'order_intent'
      ? {
          id: item.id,
          order_number: item.order_number ?? item.orderNumber,
          customer_id: item.customer_id,
          conversation_id: item.conversation_id,
          status: item.status,
          delivery: { location: null, fee: 0 },
          total: item.total,
          currency: item.currency,
        }
      : null;
  }

  function deliverySessionForOrder(orderId) {
    return (state.deliveryTracking ?? []).find((row) => row.order_id === orderId && row.status === 'ACTIVE') ?? null;
  }

  function getOrderOperationalStatus(order, session = null) {
    const status = String(order?.status ?? '').trim();
    if (status === 'cancelado' || status === 'perdido') return 'CANCELADO';
    if (status === 'entregado') return 'ENTREGADO';
    if (session?.status === 'ACTIVE' || status === 'enviado' || order?.delivery?.delivery_status === 'IN_TRANSIT') return 'EN_CAMINO';
    return 'PENDIENTE';
  }

  function operationalStatusLabel(value) {
    return {
      PENDIENTE: 'Pendiente',
      EN_CAMINO: 'En camino',
      ENTREGADO: 'Entregado',
      CANCELADO: 'Cancelado',
    }[value] ?? 'Pendiente';
  }

  function manualOrderStatusOptions(current) {
    return [
      ['PENDIENTE', 'Pendiente'],
      ['EN_CAMINO', 'En camino'],
      ['ENTREGADO', 'Entregado'],
      ['CANCELADO', 'Cancelado'],
    ]
      .map(([value, label]) => `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`)
      .join('');
  }

  function deliveryGpsLabel(session) {
    const position = session?.last_position;
    if (!session || session.status !== 'ACTIVE') return '';
    if (!position) return 'GPS activo · esperando posición';
    const accuracy = Number(position.accuracy);
    const age = position.recorded_at ? fmtWhen(position.recorded_at) : 'sin hora';
    if (position.stale) return `Ubicación sin actualizar · ${age}`;
    if (Number.isFinite(accuracy) && accuracy > 80) return `GPS débil · ±${Math.round(accuracy)} m`;
    return `GPS activo · ${age}`;
  }

  function deliveryAccuracyMeta(position) {
    const accuracy = Number(position?.accuracy);
    if (!Number.isFinite(accuracy)) {
      return { label: 'Precisión no disponible', short: 'sin precisión', level: 'unknown', warning: '' };
    }
    const meters = Math.round(accuracy);
    if (meters <= 20) return { label: `Buena precisión · ±${meters} m`, short: `±${meters} m`, level: 'good', warning: '' };
    if (meters <= 50) return { label: `Precisión moderada · ±${meters} m`, short: `±${meters} m`, level: 'moderate', warning: '' };
    return { label: `Baja precisión GPS · ±${meters} m`, short: `±${meters} m`, level: 'low', warning: 'Baja precisión GPS' };
  }

  function selectedDeliverySession() {
    const active = (state.deliveryTracking ?? []).filter((row) => row.status === 'ACTIVE');
    return active.find((row) => row.id === state.deliveryActiveSessionId) ?? active[0] ?? null;
  }

  function deliverySessionOrder(session) {
    if (!session) return null;
    const match = state.items.find((item) => item.id === session.order_id);
    return match ? itemOrder(match) : null;
  }

  function deliveryPopupHtml(title, lines = []) {
    return `<strong>${escapeHtml(title)}</strong>${lines
      .filter(Boolean)
      .map((line) => `<br>${escapeHtml(line)}`)
      .join('')}`;
  }

  function deliveryLatLng(point) {
    const lat = Number(point?.latitude);
    const lng = Number(point?.longitude);
    return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
  }

  function deliveryMarkerIcon(kind, stale = false) {
    if (!window.L) return null;
    return window.L.divIcon({
      className: `delivery-leaflet-marker delivery-leaflet-marker--${kind}${stale ? ' delivery-leaflet-marker--stale' : ''}`,
      html: `<span>${kind === 'customer' ? ICONS.pin : ICONS.send}</span>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
      popupAnchor: [0, -18],
    });
  }

  function resetDeliveryMap() {
    // El mapa es uno solo: aquí solo se limpia la capa EN VIVO (repartidor y ruta).
    if (state.deliveryMap.slowTimer) clearTimeout(state.deliveryMap.slowTimer);
    state.deliveryMap.customerMarker?.remove();
    state.deliveryMap.deliveryMarker?.remove();
    state.deliveryMap.routeLine?.remove();
    state.deliveryMap = {
      sessionId: null,
      destinationKey: null,
      customerMarker: null,
      deliveryMarker: null,
      routeLine: null,
      fitDone: false,
      autoFollow: true,
      userPanned: false,
      tileLoading: 0,
      tileError: false,
      slowTimer: null,
    };
  }

  /**
   * EL AVISO DEL MAPA, CON ORDEN DE PRIORIDAD.
   *
   * Por el mismo sitio quieren hablar tres cosas: la MEDICIÓN (lo que la persona
   * acaba de pedir), el aviso de AMPLIACIÓN y lo que va diciendo la carga de
   * teselas. Sin un orden explícito, la carga de teselas BORRABA la distancia
   * recién medida: se tocaban los dos puntos y el número no aparecía (fallo real,
   * visto en el navegador con el mapa de satélite, que carga teselas a cada rato).
   *
   *   1) medición  →  2) ampliado  →  3) estado del mapa (cargando, lento, falló)
   */
  function refreshOrdersMapNotice() {
    const node = $('#orders-map-notice');
    if (!node) return;
    const medido = state.ordersMap.measuring ? state.ordersMap.measureText : '';
    const texto = medido || state.ordersMap.zoomHint || state.ordersMap.noticeText || '';
    node.textContent = texto;
    node.hidden = !texto;
  }

  /** Aviso de ESTADO del mapa (cargando, lento, falló): el de menor prioridad. */
  function setDeliveryMapNotice(text = '') {
    // Un solo mapa, un solo aviso: el de la pantalla «Mapa y entregas».
    state.ordersMap.noticeText = text ?? '';
    refreshOrdersMapNotice();
  }

  function startDeliveryTileSlowTimer() {
    if (state.deliveryMap.slowTimer) clearTimeout(state.deliveryMap.slowTimer);
    state.deliveryMap.slowTimer = setTimeout(() => {
      if (state.deliveryMap.tileLoading > 0 && !state.deliveryMap.tileError) {
        setDeliveryMapNotice('Mapa base lento. El GPS sigue activo.');
      }
    }, DELIVERY_TILE_SLOW_MS);
  }

  function stopDeliveryTileSlowTimer() {
    if (state.deliveryMap.slowTimer) clearTimeout(state.deliveryMap.slowTimer);
    state.deliveryMap.slowTimer = null;
  }

  function maybePrefetchDeliveryTiles(reason) {
    if (!DELIVERY_TILE_PREFETCH_ENABLED) return { skipped: true, reason: DELIVERY_TILE_PREFETCH_REASON, trigger: reason };
    return { skipped: true, reason: 'No tile prefetch provider configured.', trigger: reason };
  }

  function currentDeliveryLatLngs(session = selectedDeliverySession()) {
    const order = deliverySessionOrder(session);
    const destination = deliveryLatLng(session?.destination ?? order?.delivery?.location ?? null);
    const current = deliveryLatLng(session?.last_position);
    return { destination, current };
  }

  function fitDeliveryBounds(session = selectedDeliverySession()) {
    const map = state.ordersMap.map;
    if (!map || !window.L) return;
    const { destination, current } = currentDeliveryLatLngs(session);
    const points = [destination, current].filter(Boolean);
    if (points.length >= 2) map.fitBounds(window.L.latLngBounds(points).pad(0.22), { padding: [34, 96], maxZoom: 17 });
    else if (points[0]) map.setView(points[0], 16);
    state.deliveryMap.autoFollow = false;
    updateDeliveryFloatingState();
  }

  function centerDelivery(kind) {
    const map = state.ordersMap.map;
    if (!map) return;
    const { destination, current } = currentDeliveryLatLngs();
    const target = kind === 'customer' ? destination : current;
    if (target) map.setView(target, Math.max(map.getZoom(), 16), { animate: true });
    if (kind === 'driver') state.deliveryMap.autoFollow = true;
    updateDeliveryFloatingState();
  }

  function updateDeliveryFloatingState() {
    const follow = $('#delivery-follow');
    if (follow) follow.hidden = state.deliveryMap.autoFollow || !selectedDeliverySession()?.last_position;
  }

  function updateDeliveryStatusPanel(session = selectedDeliverySession()) {
    const active = (state.deliveryTracking ?? []).filter((row) => row.status === 'ACTIVE');
    const count = $('#delivery-active-count');
    if (count) count.textContent = `${active.length} entrega${active.length === 1 ? '' : 's'} activa${active.length === 1 ? '' : 's'} · GPS solo durante entrega.`;
    const set = (name, value) => {
      const node = $(`[data-delivery-fact="${name}"]`);
      if (node) node.textContent = value;
    };
    if (!session) {
      set('delivery', 'Sin entrega activa');
      set('distance', 'Sin distancia');
      set('eta', 'Sin ETA');
      set('gps', 'esperando entrega');
      set('updated', '—');
      set('accuracy', '—');
      set('route', 'Distancia aproximada');
      return;
    }
    const position = session.last_position;
    const accuracy = deliveryAccuracyMeta(position);
    const gps = position?.stale ? 'Ubicación desactualizada' : position ? 'GPS activo' : 'esperando posición';
    set('delivery', session.delivery_user_name ?? 'Delivery');
    set('distance', session.distance_label ?? 'Sin distancia');
    set('eta', session.eta_label ?? 'Sin ETA');
    set('gps', gps);
    set('updated', position?.recorded_at ? fmtWhen(position.recorded_at) : '—');
    set('accuracy', accuracy.label);
    set('route', session.route_provider === 'haversine_fallback' ? 'Distancia aproximada' : 'Ruta');
    const badge = $('#delivery-accuracy-badge');
    if (badge) {
      badge.textContent = position?.stale ? 'Ubicación desactualizada' : accuracy.warning || accuracy.label;
      badge.dataset.level = position?.stale ? 'stale' : accuracy.level;
      badge.hidden = !position;
    }
  }

  function updateDeliveryMap(session = selectedDeliverySession()) {
    const map = ensureDeliveryMap();
    if (!map) return;
    if (!session) {
      if (state.deliveryMap.customerMarker) state.deliveryMap.customerMarker.remove();
      if (state.deliveryMap.deliveryMarker) state.deliveryMap.deliveryMarker.remove();
      if (state.deliveryMap.routeLine) state.deliveryMap.routeLine.remove();
      state.deliveryMap.customerMarker = null;
      state.deliveryMap.deliveryMarker = null;
      state.deliveryMap.routeLine = null;
      state.deliveryMap.sessionId = null;
      state.deliveryMap.destinationKey = null;
      state.deliveryMap.fitDone = false;
      updateDeliveryStatusPanel(null);
      return;
    }
    const order = deliverySessionOrder(session);
    const destination = session.destination ?? order?.delivery?.location ?? null;
    const destinationLatLng = deliveryLatLng(destination);
    const currentLatLng = deliveryLatLng(session.last_position);
    const destinationKey = destinationLatLng ? `${destinationLatLng.join(',')}:${destination?.name ?? ''}:${session.order_id}` : '';
    const sessionChanged = state.deliveryMap.sessionId !== session.id;
    if (sessionChanged) {
      state.deliveryMap.sessionId = session.id;
      state.deliveryMap.fitDone = false;
    }
    if (destinationLatLng && state.deliveryMap.destinationKey !== destinationKey) {
      if (state.deliveryMap.customerMarker) state.deliveryMap.customerMarker.remove();
      state.deliveryMap.customerMarker = window.L.marker(destinationLatLng, { icon: deliveryMarkerIcon('customer') })
        .addTo(map)
        .bindPopup(
          deliveryPopupHtml('Cliente', [
            order?.order_number ?? session.order_id,
            destination.name ?? null,
            destination.address ?? null,
          ]),
        );
      state.deliveryMap.destinationKey = destinationKey;
      maybePrefetchDeliveryTiles('destination-available');
    }
    if (currentLatLng) {
      const accuracy = deliveryAccuracyMeta(session.last_position);
      const popup = deliveryPopupHtml(session.delivery_user_name ?? 'Delivery', [
        session.last_position?.recorded_at ? `Última actualización: ${fmtWhen(session.last_position.recorded_at)}` : null,
        accuracy.label,
      ]);
      if (!state.deliveryMap.deliveryMarker) {
        state.deliveryMap.deliveryMarker = window.L.marker(currentLatLng, {
          icon: deliveryMarkerIcon('delivery', session.last_position?.stale),
        })
          .addTo(map)
          .bindPopup(popup);
      } else {
        state.deliveryMap.deliveryMarker.setLatLng(currentLatLng);
        state.deliveryMap.deliveryMarker.setIcon(deliveryMarkerIcon('delivery', session.last_position?.stale));
        state.deliveryMap.deliveryMarker.setPopupContent(popup);
      }
      if (state.deliveryMap.autoFollow && state.deliveryMap.fitDone) {
        map.panTo(currentLatLng, { animate: true, duration: 0.35 });
      }
      maybePrefetchDeliveryTiles('delivery-position-available');
    }
    if (destinationLatLng && currentLatLng) {
      const points = [currentLatLng, destinationLatLng];
      if (!state.deliveryMap.routeLine) {
        state.deliveryMap.routeLine = window.L.polyline(points, {
          color: '#0b6b4f',
          weight: 4,
          opacity: 0.68,
          dashArray: '8 8',
        }).addTo(map);
      } else {
        state.deliveryMap.routeLine.setLatLngs(points);
      }
      if (!state.deliveryMap.fitDone) {
        map.fitBounds(window.L.latLngBounds(points).pad(0.25), { animate: false, maxZoom: 16 });
        state.deliveryMap.fitDone = true;
      }
    } else if (destinationLatLng && !state.deliveryMap.fitDone) {
      map.setView(destinationLatLng, 15);
      state.deliveryMap.fitDone = true;
    } else if (currentLatLng && !state.deliveryMap.fitDone) {
      map.setView(currentLatLng, 15);
      state.deliveryMap.fitDone = true;
    }
    updateDeliveryStatusPanel(session);
    updateDeliveryFloatingState();
  }

  /**
   * LA ENTREGA EN VIVO, FLOTANDO SOBRE EL MAPA.
   *
   * Es la tarjeta de la entrega seleccionada: quién la lleva, a cuánto está, en
   * cuánto llega y con qué precisión, más las acciones de siempre (centrar,
   * seguir, detener, marcar entregado). Antes esto era una pantalla entera
   * («Delivery»); ahora es una tarjeta dentro de la pantalla única del mapa, así
   * que se ve la entrega Y los pedidos Y las ubicaciones a la vez.
   */
  function renderMapLive() {
    const box = $('#mapa-live');
    if (!box) return;
    const active = (state.deliveryTracking ?? []).filter((row) => row.status === 'ACTIVE');
    const selected = selectedDeliverySession();
    state.deliveryActiveSessionId = selected?.id ?? state.deliveryActiveSessionId;
    const sub = $('#mapa-sub');
    if (sub) {
      sub.textContent = active.length
        ? `${active.length} entrega${active.length === 1 ? '' : 's'} en vivo · GPS solo durante la entrega`
        : 'Pedidos, ubicaciones y GPS en vivo';
    }
    if (!selected) {
      box.hidden = true;
      box.innerHTML = '';
      updateDeliveryStatusPanel(null);
      updateDeliveryMap(null);
      return;
    }
    const order = deliverySessionOrder(selected);
    const nombre = order?.customer?.name ?? selected.customer?.name ?? selected.delivery_user_name ?? 'Entrega';
    box.hidden = false;
    box.innerHTML = `
      <div class="map-live__head">
        <strong>${escapeHtml(nombre)}</strong>
        <small>
          <span data-delivery-fact="distance">${escapeHtml(selected.distance_label ?? 'Sin distancia')}</span> ·
          <span data-delivery-fact="eta">${escapeHtml(selected.eta_label ?? 'Sin ETA')}</span> ·
          <span data-delivery-fact="gps">${escapeHtml(deliveryGpsLabel(selected) || 'esperando posición')}</span>
        </small>
      </div>
      <div class="map-live__tools">
        <button class="icon-btn" data-delivery-center="driver" type="button" aria-label="Centrar en el repartidor">${ICONS.send}</button>
        <button class="icon-btn" data-delivery-center="customer" type="button" aria-label="Centrar en el cliente">${ICONS.pin}</button>
        <button class="icon-btn" data-delivery-center="both" type="button" aria-label="Ver repartidor y cliente">${ICONS.search}</button>
        <button class="icon-btn" id="delivery-follow" data-delivery-center="driver" type="button" aria-label="Volver a seguir" hidden>${ICONS.retry}</button>
      </div>
      <details class="map-live__more">
        <summary>Detalles</summary>
        <dl class="facts">
          <div class="fact"><dt>Delivery</dt><dd data-delivery-fact="delivery">${escapeHtml(selected.delivery_user_name ?? 'Delivery')}</dd></div>
          <div class="fact"><dt>Última señal</dt><dd data-delivery-fact="updated">—</dd></div>
          <div class="fact"><dt>Precisión</dt><dd data-delivery-fact="accuracy">—</dd></div>
          <div class="fact"><dt>Línea del mapa</dt><dd data-delivery-fact="route">Distancia aproximada</dd></div>
        </dl>
      </details>
      <p class="delivery-accuracy" id="delivery-accuracy-badge" hidden></p>
      <div class="map-live__actions">
        <button class="btn btn--ghost btn--sm" data-delivery-stop="${escapeHtml(selected.id)}" type="button">Detener</button>
        <button class="btn btn--primary btn--sm" data-delivery-complete="${escapeHtml(selected.id)}" type="button">Marcar entregado</button>
      </div>`;
    updateDeliveryStatusPanel(selected);
    setTimeout(() => updateDeliveryMap(selected), 0);
  }

  const esPantallaMovil = () => window.matchMedia?.('(max-width: 979px)')?.matches === true;

  /**
   * LA LISTA DEBAJO DEL MAPA.
   *
   * En el teléfono el mapa ocupa la pantalla completa, así que la lista entra y
   * sale como panel desde el botón flotante. En pantalla grande ya está a la
   * vista: el botón simplemente baja hasta ella.
   */
  function toggleMapPanel(force = null) {
    const abierto = force === null ? !state.ordersMap.panelOpen : force;
    state.ordersMap.panelOpen = abierto && esPantallaMovil();
    document.body.dataset.mapPanel = state.ordersMap.panelOpen ? 'open' : 'closed';
    const panel = $('#mapa-panel');
    if (!state.ordersMap.panelOpen && panel && typeof panel.scrollIntoView === 'function') {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /**
   * ACCIONES DEL MAPA (el botón flotante).
   *
   * Todo lo que se hace desde aquí, en un solo sitio: la lista, medir distancias,
   * ir a tu ubicación, encuadrar, seguir la entrega en vivo, actualizar y las
   * capas que se ven. Es lo que pidió el negocio para el móvil: el mapa limpio y
   * los botones flotando.
   */
  function openMapActions() {
    const activas = (state.deliveryTracking ?? []).filter((row) => row.status === 'ACTIVE');
    const capas = state.ordersMap.layers;
    const fila = (accion, icono, titulo, texto, extra = '') => `
      <button class="menu-item" data-map-action="${accion}" type="button" ${extra}>
        <span class="menu-item__icon">${icono}</span>
        <span><strong>${titulo}</strong><small>${texto}</small></span>
      </button>`;
    const capa = (nombre, icono, titulo, texto) => `
      <button class="menu-item" data-map-layer="${nombre}" type="button" aria-pressed="${String(capas[nombre] === true)}">
        <span class="menu-item__icon">${icono}</span>
        <span><strong>${titulo}</strong><small>${texto}</small></span>
      </button>`;
    /*
     * CÓMO SE VE EL TERRENO: satélite (foto real) o el mapa dibujado de siempre.
     * Es lo primero que se toca cuando el negocio quiere «ver la tierra».
     */
    const base = ordersMapBaseConfig();
    const baseRow = (clave) => {
      const config = MAP_BASE_LAYERS[clave];
      const elegida = state.ordersMap.base === clave;
      const nativo = config.probe ? ordersMapNativeZoom(ordersMapCenterOf(state.ordersMap.map)) : config.maxNativeZoom;
      const detalle = config.probe
        ? `${config.detail}. Aquí hay imagen real hasta el nivel ${nativo}`
        : config.detail;
      return `
      <button class="menu-item" data-map-base="${clave}" type="button" aria-pressed="${String(elegida)}">
        <span class="menu-item__icon">${clave === 'satelite' ? ICONS.pin : ICONS.search}</span>
        <span><strong>${config.label}${elegida ? ' ✓' : ''}</strong><small>${detalle}</small></span>
      </button>`;
    };
    openSheet(
      'Acciones del mapa',
      `
      <p class="view__hint">Cómo se ve el terreno</p>
      <div class="menu-list">
        ${baseRow('satelite')}
        ${baseRow('calles')}
        ${
          base.labels
            ? capa(
                'labels',
                ICONS.search,
                capas.labels ? 'Quitar calles y nombres' : 'Poner calles y nombres',
                'Calles, barrios y nombres de sitios encima de la foto',
              )
            : ''
        }
      </div>
      <p class="view__hint">Qué se ve en el mapa</p>
      <div class="menu-list">
        ${capa('orders', ICONS.box, 'Pedidos con ubicación', 'Dónde hay que entregar')}
        ${capa('locations', ICONS.pin, 'Ubicaciones de clientes', 'Los puntos que han mandado por WhatsApp')}
        ${capa('live', ICONS.send, 'Entregas en vivo', 'El GPS del repartidor mientras reparte')}
      </div>
      <p class="view__hint">Herramientas</p>
      <div class="menu-list">
        ${fila('lista', ICONS.box, 'Pedidos y ubicaciones', 'Abre la lista (con distancias y acciones)')}
        ${fila(
          'medir',
          ICONS.pin,
          state.ordersMap.measuring ? 'Terminar de medir' : 'Medir distancia',
          'Toca dos puntos y te digo a cuánto están (línea recta)',
          `aria-pressed="${String(state.ordersMap.measuring)}"`,
        )}
        ${fila('aqui', ICONS.send, 'Ir a mi ubicación', 'Fija tu punto y ordena todo por cercanía')}
        ${fila('ajustar', ICONS.search, 'Ver todo', 'Encuadra todos los puntos del mapa')}
        ${activas.length ? fila('seguir', ICONS.retry, 'Seguir la entrega en vivo', `${activas.length} en camino: centra en el repartidor`) : ''}
        ${fila('actualizar', ICONS.retry, 'Actualizar ahora', 'Vuelve a pedir pedidos, ubicaciones y GPS')}
      </div>
      <button class="btn btn--ghost btn--block" data-delivery-push type="button">${ICONS.bell} ${escapeHtml(pushPermissionLabel())}</button>
      <button class="btn btn--ghost btn--block" data-close-sheet type="button">Cerrar</button>
      `,
    );
  }

  /** Cómo se lee el último envío (y el resultado de la última prueba, si la hay). */
  const PUSH_JOB_LABEL = {
    sent: 'enviado',
    failed: 'falló',
    expired: 'el teléfono ya no acepta avisos',
    not_configured: 'sin llaves en el servidor',
    skipped: 'ya enviado antes',
  };

  function pushLastLine(job, resultado) {
    if (resultado) return `Servidor: ${resultado.servidor} · ${resultado.local}`;
    if (!job) return 'Sin pruebas recientes · pulsa Probar';
    return `Último envío: ${PUSH_JOB_LABEL[job.status] ?? job.status} · ${fmtWhen(job.created_at)}`;
  }

  function openNotificationsSheet() {
    $('#sheet-title').textContent = 'Notificaciones';
    const rows = state.notifications ?? [];
    const localRows = localNoticeRows();
    const pushPermission = pushPermissionLabel();
    const pushActive = Number(state.push?.activeSubscriptions ?? 0) > 0 || state.push?.subscribed === true;
    const lastPushJob = state.push?.recentJobs?.[0] ?? null;
    const resultado = state.pushResult ?? null;
    /*
     * El estado tiene que decir QUÉ hacer. «Teléfono sin conectar · Activadas» se
     * leía como si estuviera todo bien cuando en realidad este teléfono no estaba
     * registrado: sin registro el servidor no tiene a dónde mandar el aviso.
     */
    const pushStatusText = !state.push?.configured
      ? 'El servidor no tiene llaves push configuradas'
      : pushActive
        ? `Teléfono conectado · ${pushPermission}`
        : pushPermission === 'Activadas'
          ? 'Teléfono sin conectar: pulsa Activar para recibir los avisos aquí'
          : pushPermission === 'No disponible'
            ? 'Este navegador no admite push (en iPhone hay que añadir el panel a la pantalla de inicio)'
            : `Teléfono sin conectar · ${pushPermission}`;
    /*
     * Fila compacta: en esta lista el contenido manda y los botones son pequeños.
     * «Probar» manda la prueba real desde el servidor Y muestra un aviso en este
     * teléfono, así el resultado se ve aquí (antes no pasaba nada visible).
     */
    const pushCard = `<article class="notice notice--push">
      <div class="notice__main">
        <strong>Notificaciones del teléfono</strong>
        <p>${escapeHtml(pushStatusText)}</p>
        <small data-push-result>${escapeHtml(pushLastLine(lastPushJob, resultado))}</small>
      </div>
      <div class="notice__actions">
        <button class="btn btn--primary btn--xs" data-push-test type="button">Probar</button>
        <button class="btn btn--ghost btn--xs" data-push-enable type="button">${pushActive ? 'Revisar' : 'Activar'}</button>
      </div>
    </article>`;
    const html = [
      pushCard,
      resultado
        ? '<p class="notice-hint">Salen dos avisos: uno lo manda el servidor y otro lo muestra este teléfono. Si dice «enviado» y no ves el del servidor, revisa los avisos de Chrome en los ajustes del teléfono y quita el ahorro de batería.</p>'
        : '',
      ...localRows.map(
        (row) => `<article class="notice notice--nueva">
          <div class="notice__main">
            <strong>${escapeHtml(row.title)}</strong>
            <p>${escapeHtml(row.body)}</p>
            <small>${escapeHtml(row.meta ?? 'Pendiente')}</small>
          </div>
          <div class="notice__actions">
            ${row.conversationId ? `<button class="btn btn--whatsapp btn--xs" data-chat="${escapeHtml(row.conversationId)}" type="button">Abrir</button>` : ''}
            ${row.scheduledId ? `<button class="btn btn--ghost btn--xs" data-scheduled-cancel="${escapeHtml(row.scheduledId)}" type="button">Cancelar</button>` : ''}
            <button class="btn btn--ghost btn--xs" data-notice-dismiss="${escapeHtml(row.key)}" type="button">Entendido</button>
          </div>
        </article>`,
      ),
      ...rows.map(
        (row) => `<article class="notice ${row.status !== 'read' ? 'notice--nueva' : ''}">
          <div class="notice__main">
            <strong>${escapeHtml(row.title ?? 'Notificación')}</strong>
            <p>${escapeHtml(row.body ?? '')}</p>
            <small>${escapeHtml(fmtWhen(row.created_at))}${row.status === 'read' ? ' · leída' : ' · nueva'}</small>
          </div>
          ${
            row.deep_link
              ? `<div class="notice__actions"><button class="btn btn--primary btn--xs" data-notification-open="${escapeHtml(row.id)}" data-notification-entity="${escapeHtml(row.entity_id ?? '')}" type="button">Abrir</button></div>`
              : ''
          }
        </article>`,
      ),
    ].join('');
    $('#sheet-body').innerHTML = html
      ? `<div class="notice-list">
          ${html}
        </div>`
      : emptyState('No hay notificaciones.');
    $('#sheet').hidden = false;
  }

  async function openDeliveryOrderFromNotification(notificationId, orderId) {
    if (notificationId) {
      await api(`/api/admin/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'POST', body: '{}' }).catch(() => {});
    }
    if (orderId) {
      state.deliveryActiveOrderId = orderId;
      setTab('delivery');
      await api(`/api/admin/delivery/orders/${encodeURIComponent(orderId)}${notificationId ? `?notification=${encodeURIComponent(notificationId)}` : ''}`).catch(() => null);
      await load({ keepTab: true });
      setTab('delivery', { silent: true });
    }
    closeSheet();
  }

  async function openNotificationTarget(notificationId, entityId) {
    const row = state.notifications.find((candidate) => candidate.id === notificationId) ?? null;
    if (row?.entity_type === 'conversation' || row?.data?.conversation_id) {
      if (notificationId) {
        await api(`/api/admin/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'POST', body: '{}' }).catch(() => {});
      }
      const conversationId = row.entity_id || row.data?.conversation_id;
      await openChat(conversationId);
      await load({ keepTab: true }).catch(() => {});
      closeSheet();
      return;
    }
    if (row?.deep_link) {
      if (notificationId) {
        await api(`/api/admin/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'POST', body: '{}' }).catch(() => {});
      }
      await applyDeepLink(new URL(row.deep_link, location.origin).searchParams);
      await load({ keepTab: true }).catch(() => {});
      closeSheet();
      return;
    }
    await openDeliveryOrderFromNotification(notificationId, entityId);
  }

  function stopDeliveryWatch() {
    if (state.deliveryWatchId !== null && navigator.geolocation?.clearWatch) {
      navigator.geolocation.clearWatch(state.deliveryWatchId);
    }
    state.deliveryWatchId = null;
    state.deliveryActiveSessionId = null;
    state.deliveryLastSentAt = 0;
    state.deliveryLastSentPoint = null;
    state.deliveryWatchStartedAt = 0;
  }

  function applyDeliverySession(session) {
    if (!session?.id) return;
    const index = state.deliveryTracking.findIndex((row) => row.id === session.id);
    if (index >= 0) state.deliveryTracking[index] = session;
    else state.deliveryTracking.unshift(session);
  }

  async function refreshDeliveryTracking(options = {}) {
    const data = await api('/api/admin/delivery-tracking');
    state.deliveryTracking = data.sessions ?? [];
    // Sin mapa creado todavía (o si se pide) se repinta la pantalla entera; con el
    // mapa vivo basta con mover la capa EN VIVO (nada de parpadeos cada 8 s).
    if (options.rebuild || !state.ordersMap.map) renderOrdersMap();
    else {
      renderMapLive();
      updateDeliveryMap(selectedDeliverySession());
    }
  }

  function stopDeliveryEvents() {
    if (state.deliveryEvents) state.deliveryEvents.close();
    state.deliveryEvents = null;
    if (state.deliveryPollTimer) clearInterval(state.deliveryPollTimer);
    state.deliveryPollTimer = null;
  }

  function deliveryPollTick() {
    if (state.tab !== 'mapa' || document.visibilityState !== 'visible') return;
    refreshDeliveryTracking().catch(() => {});
  }

  function startDeliveryPollTimer() {
    if (!state.deliveryPollTimer) state.deliveryPollTimer = setInterval(deliveryPollTick, 8000);
  }

  function startDeliveryEvents() {
    if (state.deliveryEvents || state.deliveryPollTimer || state.tab !== 'mapa') return;
    if (typeof EventSource === 'function') {
      const source = new EventSource('/api/admin/delivery-tracking/events');
      source.addEventListener('delivery.tracking_started', (event) => {
        applyDeliverySession(JSON.parse(event.data).session);
        renderOrdersMap();
      });
      source.addEventListener('delivery.location_updated', (event) => {
        // Solo se mueve el marcador del repartidor: repintar toda la pantalla en
        // cada punto del GPS haría parpadear el mapa.
        applyDeliverySession(JSON.parse(event.data).session);
        updateDeliveryMap(selectedDeliverySession());
      });
      source.addEventListener('delivery.tracking_stopped', (event) => {
        applyDeliverySession(JSON.parse(event.data).session);
        renderOrdersMap();
      });
      source.addEventListener('delivery.completed', (event) => {
        applyDeliverySession(JSON.parse(event.data).session);
        renderOrdersMap();
      });
      source.onerror = () => {
        source.close();
        state.deliveryEvents = null;
        startDeliveryPollTimer();
      };
      state.deliveryEvents = source;
      return;
    }
    startDeliveryPollTimer();
  }

  function shouldSendDeliveryPoint(point) {
    const now = Date.now();
    if (!state.deliveryLastSentPoint) return true;
    if (now - state.deliveryLastSentAt >= 7000) return true;
    const dx = Number(point.latitude) - Number(state.deliveryLastSentPoint.latitude);
    const dy = Number(point.longitude) - Number(state.deliveryLastSentPoint.longitude);
    return Math.sqrt(dx * dx + dy * dy) > 0.00012;
  }

  async function sendDeliveryPoint(sessionId, coords, options = {}) {
    const point = {
      lat: coords.latitude,
      lng: coords.longitude,
      accuracy: coords.accuracy,
      heading: coords.heading,
      speed: coords.speed,
      timestamp: new Date().toISOString(),
    };
    if (!options.force && !shouldSendDeliveryPoint({ latitude: point.lat, longitude: point.lng })) return;
    const data = await api(`/api/admin/delivery-tracking/${encodeURIComponent(sessionId)}/location`, {
      method: 'POST',
      body: JSON.stringify(point),
    });
    state.deliveryLastSentAt = Date.now();
    state.deliveryLastSentPoint = { latitude: point.lat, longitude: point.lng };
    applyDeliverySession(data.session);
    updateDeliveryMap(selectedDeliverySession());
  }

  function getInitialDeliveryPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation?.getCurrentPosition) {
        reject(new Error('geolocation_unavailable'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
    });
  }

  async function rollbackDeliveryStart({ sessionId, orderId, previousStatus }) {
    try {
      await api(`/api/admin/delivery-tracking/${encodeURIComponent(sessionId)}/stop`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (previousStatus && previousStatus !== 'enviado') {
        await api(`/api/admin/items/${encodeURIComponent(orderId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: previousStatus }),
        });
      }
      await load({ keepTab: true });
      setTab('delivery', { silent: true });
    } catch {
      await refreshDeliveryTracking({ rebuild: true }).catch(() => {});
    }
  }

  function startDeliveryWatch(sessionId, rollback = null) {
    if (!navigator.geolocation?.watchPosition) {
      toast('Este navegador no puede dar GPS');
      return;
    }
    stopDeliveryWatch();
    state.deliveryActiveSessionId = sessionId;
    state.deliveryWatchStartedAt = Date.now();
    let watchConfirmed = false;
    state.deliveryWatchId = navigator.geolocation.watchPosition(
      (position) => {
        watchConfirmed = true;
        sendDeliveryPoint(sessionId, position.coords).catch((error) => {
          if (error.message !== 'unauthorized') toast('No se pudo enviar GPS');
        });
      },
      (error) => {
        const immediate = Date.now() - state.deliveryWatchStartedAt <= 5000 && !watchConfirmed;
        toast(error?.code === 1 ? 'Permiso de GPS denegado' : 'GPS sin actualización');
        if (immediate && rollback?.sessionId) {
          stopDeliveryWatch();
          rollbackDeliveryStart(rollback).then(() => toast('No se inició la entrega porque el GPS falló.')).catch(() => {});
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
    );
    toast('GPS activo durante esta entrega');
  }

  async function startDelivery(orderId) {
    let initialPosition;
    try {
      initialPosition = await getInitialDeliveryPosition();
    } catch (error) {
      toast(error?.code === 1 ? 'Necesitas permitir acceso a tu ubicación para iniciar la entrega.' : 'No se pudo obtener tu GPS para iniciar la entrega.');
      return;
    }
    const currentOrder = itemOrder(state.items.find((item) => item.id === orderId));
    const previousStatus = currentOrder?.status ?? state.items.find((item) => item.id === orderId)?.status ?? 'nuevo';
    const data = await api(`/api/admin/orders/${encodeURIComponent(orderId)}/delivery/start`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    applyDeliverySession(data.session);
    try {
      await sendDeliveryPoint(data.session.id, initialPosition.coords, { force: true });
    } catch (error) {
      await rollbackDeliveryStart({ sessionId: data.session.id, orderId, previousStatus });
      toast(error?.body?.message ?? 'No se pudo iniciar la entrega con GPS válido.');
      return;
    }
    startDeliveryWatch(data.session.id, { sessionId: data.session.id, orderId, previousStatus });
    await load({ keepTab: true });
    setTab('delivery', { silent: true });
  }

  async function stopDelivery(sessionId, complete = false) {
    const data = await api(`/api/admin/delivery-tracking/${encodeURIComponent(sessionId)}/${complete ? 'complete' : 'stop'}`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    stopDeliveryWatch();
    applyDeliverySession(data.session);
    renderOrdersMap();
    await load({ keepTab: true });
    toast(complete ? 'Entrega completada' : 'Tracking detenido');
  }

  /** Seguimientos (menú lateral): vencidos, de hoy y los que vienen. */
  function renderSeguimientos() {
    const box = $('#list-seguimientos');
    if (!box) return;
    const followups = state.followups ?? {};
    const bloque = (titulo, filas) =>
      filas?.length
        ? `<h2 class="view__title">${escapeHtml(titulo)} (${filas.length})</h2>${filas.map(followupCard).join('')}`
        : '';
    const html = [
      bloque('Vencidos', followups.overdue),
      bloque('Para hoy', followups.today),
      bloque('Próximos', followups.upcoming),
    ]
      .filter(Boolean)
      .join('');
    box.innerHTML = html || emptyState('No hay seguimientos pendientes. Se crean solos al entregar una compra.');
  }

  /** Plantilla marcada para borrar (segundo toque confirma). */
  let pendingDelete = null;
  /** Cliente marcado como "no contactar" (segundo toque confirma). */
  let pendingOptOut = null;

  function renderMensajes() {
    const list = state.messages.length
      ? state.messages
          .map(
            (message) => `<article class="item">
              <p class="item__name">${escapeHtml(message.name)}</p>
              <p class="item__meta">${escapeHtml(message.body)}</p>
              <div class="item__actions">
                <button class="btn btn--ghost btn--sm" data-edit-message="${escapeHtml(message.id)}" type="button">Editar</button>
                <button class="btn ${pendingDelete === message.id ? 'btn--danger' : 'btn--ghost'} btn--sm" data-del-message="${escapeHtml(
                  message.id,
                )}" type="button">${pendingDelete === message.id ? '¿Seguro? Toca otra vez' : 'Borrar'}</button>
              </div>
            </article>`,
          )
          .join('')
      : emptyState('No hay plantillas todavía.');
    $('#list-mensajes').innerHTML = list;
  }

  function renderAjustes() {
    const stats = state.stats ?? {};
    const outbox = readOutbox().length;
    const wa = state.whatsapp ?? {};
    $('#facts').innerHTML = [
      ['Registros', stats.total ?? state.items.length],
      ['Clientes', state.customers.length],
      ['Sin contactar', stats.nuevos ?? 0],
      ['Para hoy / atrasados', `${stats.hoy ?? 0} / ${stats.atrasados ?? 0}`],
      ['Seguimientos hoy / vencidos', `${state.hoy?.seguimientosHoy ?? 0} / ${state.hoy?.seguimientosVencidos ?? 0}`],
      ['Mensajes sin responder', state.hoy?.sinResponder ?? 0],
      ['Valor abierto', money(stats.valorAbierto ?? 0)],
      ['Valor entregado', money(stats.valorCobrado ?? 0)],
      ['Cambios pendientes', outbox],
      [
        'Última actualización',
        state.syncedAt ? new Intl.DateTimeFormat('es-DO', { timeStyle: 'short' }).format(state.syncedAt) : '—',
      ],
    ]
      .map(([key, value]) => `<div class="fact"><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`)
      .join('');

    // Estado de WhatsApp en palabras: lo que falta, dicho sin tecnicismos.
    $('#wa-config').innerHTML = wa.configured
      ? `<dl class="facts">
        <div class="fact"><dt>Envío y recepción</dt><dd>activos${wa.phoneNumber ? ` (${escapeHtml(wa.phoneNumber)})` : ''}</dd></div>
        <div class="fact"><dt>Webhooks</dt><dd>${wa.verifyTokenConfigured ? 'con token de verificación' : 'FALTA WHATSAPP_VERIFY_TOKEN'}</dd></div>
        <div class="fact"><dt>Firma de Meta</dt><dd>${wa.appSecretConfigured ? 'se comprueba' : 'FALTA META_APP_SECRET'}</dd></div>
      </dl>
      <p class="card__text">Nada se envía solo: cada mensaje lo escribes y lo envías tú desde la conversación.</p>`
      : `<p class="card__text">Todavía no está conectado. Puedes registrar clientes y compras, pero no
         enviar ni recibir mensajes. Hacen falta WHATSAPP_PHONE_NUMBER_ID y WHATSAPP_ACCESS_TOKEN en el
         servidor (ver docs/WHATSAPP_INTEGRATION.md).</p>`;
    const templates = state.templates ?? [];
    const metaTemplates = templates.filter(waTemplateMetaSynced);
    const approvedCount = metaTemplates.filter(waTemplateApproved).length;
    const localOnlyCount = templates.filter((template) => !waTemplateMetaSynced(template)).length;
    const lastSync = templates
      .map((template) => template.last_template_sync_at || template.last_synced_at)
      .filter(Boolean)
      .sort()
      .at(-1);
    const metaStatusLabel = (status) =>
      ({
        approved: 'Aprobada',
        pending: 'Pendiente',
        pending_approval: 'Pendiente',
        rejected: 'Rechazada',
        paused: 'Pausada',
        disabled: 'Desactivada',
        local_only: 'Solo local',
        not_found_in_meta: 'No existe en Meta',
      }[String(status ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? status ?? '—');
    $('#wa-templates-config').innerHTML = `<div class="item__actions">
        <button class="btn btn--primary" id="wa-sync-templates" type="button">Sincronizar con Meta</button>
      </div>
      <dl class="facts">
        <div class="fact"><dt>Encontradas en Meta</dt><dd>${metaTemplates.length}</dd></div>
        <div class="fact"><dt>Aprobadas</dt><dd>${approvedCount}</dd></div>
        <div class="fact"><dt>Solo locales</dt><dd>${localOnlyCount}</dd></div>
        <div class="fact"><dt>Último sync</dt><dd>${escapeHtml(lastSync ? new Date(lastSync).toLocaleString('es-DO') : '—')}</dd></div>
      </dl>
      ${
        templates.length
          ? `<div class="table-wrap"><table class="mini-table">
              <thead><tr><th>Nombre</th><th>Técnico</th><th>Categoría</th><th>Idioma</th><th>Estado Meta</th><th>Sendable</th><th>Botones</th></tr></thead>
              <tbody>${templates
                .map(
                  (template) => `<tr>
                    <td>${escapeHtml(waTemplateLabel(template))}</td>
                    <td><code>${escapeHtml(template.name)}</code></td>
                    <td>${escapeHtml(template.category ?? '—')}</td>
                    <td>${escapeHtml(template.language ?? '—')}</td>
                    <td>${escapeHtml(metaStatusLabel(template.status))}</td>
                    <td>${template.sendable === true ? 'Sí' : 'No'}</td>
                    <td>${escapeHtml((template.buttons ?? []).map((button) => button.text ?? button.title).filter(Boolean).join(', ') || '—')}</td>
                  </tr>`,
                )
                .join('')}</tbody>
            </table></div>`
          : '<p class="view__hint">Sin plantillas sincronizadas todavía.</p>'
      }`;
    $('#build-info').textContent = `${state.items.length} registros · ${
      state.online ? 'en línea' : 'sin conexión'
    } · v2`;

    // -------------------------------------------- seguimiento postventa (S5)
    const plan = state.followups?.plan ?? [];
    const enabled = state.followups?.enabled ?? state.settings?.followup ?? {};
    $('#followup-config').innerHTML = plan.length
      ? plan
          .map(
            (entry) => `<label class="toggle">
              <input type="checkbox" data-plan-toggle="${escapeHtml(entry.key)}" ${
                enabled[entry.key] !== false ? 'checked' : ''
              } />
              <span><strong>Día ${escapeHtml(entry.day)}</strong><small>${escapeHtml(entry.reason)}</small></span>
            </label>`,
          )
          .join('')
      : '<p class="card__text">No hay plan configurado.</p>';

    // ---------------------------------------------------- métricas (S6)
    const byPeriod = state.metrics?.byPeriod ?? null;
    const periodName = state.metrics?.period?.name ?? state.metricsPeriod;
    $('#metrics-period')
      ?.querySelectorAll('[data-metrics]')
      .forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.metrics === periodName)));
    $('#metrics').innerHTML = byPeriod
      ? [
          ['Leads nuevos', byPeriod.leadsNuevos],
          ['Conversaciones', byPeriod.conversaciones],
          ['Pedidos creados', byPeriod.pedidosCreados],
          ['Pedidos confirmados', byPeriod.pedidosConfirmados],
          ['Pedidos entregados', byPeriod.pedidosEntregados],
          ['Ventas', money(byPeriod.ventas)],
          ['Recompras', byPeriod.recompras],
          ['Pendientes de seguimiento', byPeriod.clientesPendientesDeSeguimiento],
          ['Pedidos cancelados', byPeriod.pedidosCancelados],
        ]
          .map(([key, value]) => `<div class="fact"><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`)
          .join('')
      : '<div class="fact"><dt>Período</dt><dd>cargando…</dd></div>';
    if (!state.metrics && !state.metricsLoading && state.online) {
      state.metricsLoading = true;
      loadMetrics(state.metricsPeriod).finally(() => {
        state.metricsLoading = false;
      });
    }

    // ---------------------------------------------------------- auditoría
    $('#audit').innerHTML = state.auditEntries?.length
      ? `<dl class="facts">${state.auditEntries
          .slice(0, 8)
          .map(
            (entry) =>
              `<div class="fact"><dt>${escapeHtml(fmtWhen(entry.created_at))} · ${escapeHtml(entry.action)}</dt><dd>${escapeHtml(
                entry.summary ?? '',
              )}</dd></div>`,
          )
          .join('')}</dl>`
      : `<p class="card__text">${
          state.audit?.total ? `${state.audit.total} operaciones registradas.` : 'Todavía no hay operaciones registradas.'
        }</p>`;
    if (!state.auditEntries && !state.auditLoading && state.online) {
      state.auditLoading = true;
      loadAuditEntries();
    }

    // ------------------------------------------------ multimedia (S3)
    const media = state.media ?? {};
    $('#media-config').innerHTML = media.enabled
      ? `<dl class="facts">
          <div class="fact"><dt>Imagen y audio</dt><dd>activos</dd></div>
          <div class="fact"><dt>Archivos</dt><dd>almacén privado (S3/R2)</dd></div>
          <div class="fact"><dt>Límites</dt><dd>imagen ${media.imageLimitMb ?? 5} MB · audio ${media.audioLimitMb ?? 16} MB</dd></div>
        </dl>
        <p class="card__text">Las fotos y los audios se piden al CRM con tu sesión: el almacén es privado y nadie
        de fuera puede abrir un archivo aunque tenga el enlace.</p>`
      : `<p class="card__text">Todavía no está activa: ${
          media.storageConfigured === false ? 'falta el almacén de archivos (R2). ' : ''
        }${
          media.graphConfigured === false ? 'faltan las credenciales de WhatsApp para descargar archivos. ' : ''
        }Los mensajes de texto, los pedidos y los comprobantes funcionan igual.</p>`;

    // Recuperación de envíos ambiguos: SOLO administración, nunca en el chat.
    const review = media.review ?? [];
    $('#media-review-card').hidden = review.length === 0;
    $('#media-review').innerHTML = review
      .map(
        (row) => `<div class="review-item">
          <p class="item__meta"><strong>${escapeHtml(row.media_type ?? 'archivo')}</strong> ·
            ${escapeHtml(row.send_status ?? '')}${row.http_status ? ` · HTTP ${escapeHtml(row.http_status)}` : ''}</p>
          <p class="item__meta">Intentado ${escapeHtml(fmtWhen(row.send_attempted_at ?? row.created_at))}${
            row.safe_code ? ` · ${escapeHtml(row.safe_code)}` : ''
          }</p>
          <label class="field">
            <span class="field__label">Identificador del mensaje en WhatsApp (si salió)</span>
            <input class="field__input" data-review-wamid="${escapeHtml(row.id)}" placeholder="wamid.…" />
          </label>
          <div class="item__actions">
            <button class="btn btn--ghost btn--sm" data-review="sent" data-review-id="${escapeHtml(
              row.id,
            )}" type="button">Sí salió</button>
            <button class="btn btn--primary btn--sm" data-review="not_sent" data-review-id="${escapeHtml(
              row.id,
            )}" type="button">No salió: reintentar</button>
          </div>
        </div>`,
      )
      .join('');
  }

  /**
   * Largo mínimo de contraseña (lo manda el servidor en `/api/admin/data`).
   *
   * El negocio pidió SEIS caracteres: se escribe en el mostrador, con el cliente
   * delante, y diez era una pelea. La regla de verdad está en el servidor; esto
   * solo la enseña y evita un viaje inútil.
   */
  const minPass = () => (Number(state.minPasswordLength) > 0 ? Number(state.minPasswordLength) : 6);

  /**
   * Campo de contraseña CON OJO.
   *
   * Escribir una clave a ciegas y no poder mirarla es lo que hace que la gente
   * repita el mismo error dos veces. El botón solo cambia el `type` del campo
   * que está justo encima: no copia la clave a ningún sitio.
   */
  function passFieldHtml({
    id = '',
    name = '',
    label = '',
    value = '',
    autocomplete = 'new-password',
    hint = '',
    required = false,
  } = {}) {
    return `<label class="field">
      <span class="field__label">${escapeHtml(label)}</span>
      <span class="pass">
        <input class="field__input" ${name ? `name="${escapeHtml(name)}" ` : ''}${
          id ? `id="${escapeHtml(id)}" ` : ''
        }type="password" value="${escapeHtml(value)}" autocomplete="${escapeHtml(
          autocomplete,
        )}" ${required ? 'required ' : ''}minlength="${minPass()}" />
        <button class="pass__eye" type="button" data-pass-eye aria-label="Ver la contraseña" aria-pressed="false">${
          ICONS.eye
        }</button>
      </span>
      ${hint ? `<span class="field__hint">${escapeHtml(hint)}</span>` : ''}
    </label>`;
  }

  /** Contraseña nueva de un usuario: hoja de verdad, con su ojo (antes era un `prompt` a ciegas). */
  function openUserPasswordSheet(userId, nombre) {
    openSheet(
      `Nueva contraseña · ${nombre}`,
      `
      <p class="view__hint">Al guardarla se cierran las sesiones abiertas de esta cuenta.</p>
      ${passFieldHtml({
        id: 'user-pass-new',
        label: 'Contraseña',
        autocomplete: 'new-password',
        hint: `Mínimo ${minPass()} caracteres.`,
      })}
      <button class="btn btn--primary btn--block" id="user-pass-save" type="button">Guardar contraseña</button>
      `,
    );
    $('#user-pass-save')?.addEventListener('click', async (event) => {
      const value = $('#user-pass-new')?.value ?? '';
      if (value.length < minPass()) {
        toast(`La contraseña necesita al menos ${minPass()} caracteres`);
        $('#user-pass-new')?.focus();
        return;
      }
      await working(event.currentTarget, 'Guardando…', async () => {
        try {
          await api(`/api/admin/users/${encodeURIComponent(userId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ password: value }),
          });
          await loadUsers();
          closeSheet();
          toast('Contraseña actualizada');
        } catch (error) {
          if (error.message !== 'unauthorized') {
            toast(error.body?.error === 'weak_password' ? `Mínimo ${minPass()} caracteres` : error.body?.message ?? 'No se pudo guardar');
          }
        }
      });
    });
  }

  function renderUsuarios() {
    const box = $('#users-view');
    if (!box) return;
    if (!isAdmin()) {
      box.innerHTML = emptyState('Esta sección es solo para administradores.');
      return;
    }
    if (!state.users?.length) {
      box.innerHTML = '<div class="card"><p class="card__text">Cargando usuarios…</p></div>';
      if (!state.usersLoading && state.online) loadUsers().catch(() => {});
      return;
    }
    box.innerHTML = state.users
      .map(
        (user) => `<article class="item">
          <p class="item__name">${escapeHtml(user.display_name)}</p>
          <p class="item__meta">${escapeHtml(user.username)} · ${escapeHtml(roleLabel(user.role))} · ${
            user.active === false ? 'Inactivo' : 'Activo'
          }${user.last_login_at ? ` · último acceso ${escapeHtml(fmtWhen(user.last_login_at))}` : ''}</p>
          <div class="item__actions">
            <button class="btn btn--ghost btn--sm" data-user-role="${escapeHtml(user.id)}" data-role="${
              user.role === 'ADMIN' ? 'AGENT' : 'ADMIN'
            }" type="button">${user.role === 'ADMIN' ? 'Hacer agente' : 'Hacer admin'}</button>
            <button class="btn btn--ghost btn--sm" data-user-active="${escapeHtml(user.id)}" data-active="${
              user.active === false ? 'true' : 'false'
            }" type="button">${user.active === false ? 'Activar' : 'Desactivar'}</button>
            <button class="btn btn--ghost btn--sm" data-user-password="${escapeHtml(user.id)}" type="button">Reset contraseña</button>
          </div>
        </article>`,
      )
      .join('');
  }

  async function loadUsers() {
    if (!isAdmin()) return;
    state.usersLoading = true;
    try {
      const result = await api('/api/admin/users');
      state.users = result.users ?? [];
      renderUsuarios();
    } finally {
      state.usersLoading = false;
    }
  }

  async function updateUser(id, patch) {
    try {
      await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      await loadUsers();
      toast('Usuario actualizado');
    } catch (error) {
      if (error.message !== 'unauthorized') {
        toast(error.body?.error === 'last_admin' ? 'Debe quedar al menos un administrador activo' : error.body?.message ?? 'No se pudo actualizar');
      }
    }
  }

  /*
   * ==========================================================================
   *  MI PERFIL (el usuario que tiene la sesión)
   * ==========================================================================
   *
   * El NOMBRE VISIBLE es el que se guarda con cada mensaje que envías, así que es
   * el nombre que se ve en el chat como autor. La CLAVE se cambia con la actual
   * delante y el servidor revoca todas las sesiones: por eso, tras cambiarla, se
   * vuelve a la pantalla de entrada en vez de dejar una sesión muerta en pantalla.
   */

  /** Firma de lo pintado: si nada cambió no se reescribe encima de lo que se escribe. */
  let profileSig = null;

  function profileErrorMessage(error) {
    if (error.body?.error === 'invalid_user') return 'El nombre visible no puede quedar vacío';
    if (error.body?.error === 'password_mismatch') return 'Las dos contraseñas nuevas no coinciden';
    if (error.body?.error === 'weak_password') return `La contraseña nueva necesita al menos ${minPass()} caracteres`;
    return error.body?.message ?? 'No se pudo actualizar el perfil';
  }

  function renderPerfil(force = false) {
    const box = $('#profile-view');
    if (!box) return;
    const user = currentUser();
    if (!user) {
      // Sesión con la clave del panel: no hay cuenta personal que configurar.
      profileSig = null;
      box.innerHTML = `<div class="card">
        <p class="card__title">Estás dentro con la clave del panel</p>
        <p class="card__text">
          La clave del panel no es una cuenta personal: no tiene un nombre ni una contraseña propios que
          cambiar. Entra con tu usuario y tu contraseña para tener tu perfil.
        </p>
        <button class="btn btn--ghost btn--block" id="profile-relogin" type="button">Cerrar sesión y entrar con usuario</button>
      </div>`;
      $('#profile-relogin')?.addEventListener('click', () => $('#logout').click());
      return;
    }
    const sig = [user.id, user.display_name ?? '', user.first_name ?? '', user.last_name ?? '', user.username ?? ''].join('|');
    if (!force && sig === profileSig) return;
    profileSig = sig;
    const name = user.display_name ?? user.username ?? '';
    box.innerHTML = `
      <article class="profile-account">
        <span class="avatar avatar--lg">${escapeHtml(waInitials(name))}</span>
        <span class="profile-account__body">
          <strong>${escapeHtml(name)}</strong>
          <small>${escapeHtml(user.username ?? '')} · ${escapeHtml(roleLabel(user.role))}</small>
        </span>
      </article>

      <div class="card">
        <p class="card__title">Datos personales</p>
        <p class="card__text">
          El <strong>nombre visible</strong> es el que aparece en el chat como autor de los mensajes que
          envías desde el panel.
        </p>
        <label class="field">
          <span class="field__label">Nombre visible</span>
          <input class="field__input" id="profile-name" value="${escapeHtml(user.display_name ?? '')}" maxlength="120" autocomplete="name" />
        </label>
        <label class="field">
          <span class="field__label">Nombre</span>
          <input class="field__input" id="profile-first" value="${escapeHtml(user.first_name ?? '')}" maxlength="80" autocomplete="given-name" />
        </label>
        <label class="field">
          <span class="field__label">Apellido</span>
          <input class="field__input" id="profile-last" value="${escapeHtml(user.last_name ?? '')}" maxlength="80" autocomplete="family-name" />
        </label>
        <label class="field">
          <span class="field__label">Usuario</span>
          <input class="field__input" id="profile-username" value="${escapeHtml(user.username ?? '')}" disabled />
        </label>
        <p class="view__hint">El usuario con el que entras no se cambia desde aquí.</p>
        <button class="btn btn--primary btn--block" id="profile-save" type="button">Guardar cambios</button>
      </div>

      <div class="card">
        <p class="card__title">Contraseña</p>
        <p class="card__text">
          Al cambiarla se cierran <strong>todas</strong> tus sesiones (esta también): tendrás que entrar de
          nuevo con la clave nueva.
        </p>
        <label class="field">
          <span class="field__label">Contraseña actual</span>
          <span class="pass">
            <input class="field__input" id="profile-current" type="password" autocomplete="current-password" />
            <button class="pass__eye" type="button" data-pass-eye aria-label="Ver la contraseña" aria-pressed="false">${ICONS.eye}</button>
          </span>
        </label>
        ${passFieldHtml({ id: 'profile-new', label: 'Contraseña nueva', autocomplete: 'new-password' })}
        ${passFieldHtml({ id: 'profile-confirm', label: 'Repite la contraseña nueva', autocomplete: 'new-password' })}
        <p class="view__hint">Mínimo ${minPass()} caracteres.</p>
        <button class="btn btn--ghost btn--block" id="profile-password" type="button">Cambiar contraseña</button>
      </div>`;

    $('#profile-save')?.addEventListener('click', async (event) => {
      const displayName = ($('#profile-name')?.value ?? '').trim();
      if (!displayName) {
        toast('El nombre visible no puede quedar vacío');
        $('#profile-name')?.focus();
        return;
      }
      await working(event.currentTarget, 'Guardando…', async () => {
        try {
          const result = await api('/api/admin/users/me', {
            method: 'PATCH',
            body: JSON.stringify({
              displayName,
              firstName: ($('#profile-first')?.value ?? '').trim(),
              lastName: ($('#profile-last')?.value ?? '').trim(),
            }),
          });
          state.auth = { ...state.auth, user: result.user ?? state.auth?.user ?? null };
          renderCurrentUser();
          renderPerfil(true);
          toast('Perfil actualizado: en el chat aparecerás así');
        } catch (error) {
          if (error.message !== 'unauthorized') toast(profileErrorMessage(error));
        }
      });
    });

    $('#profile-password')?.addEventListener('click', async (event) => {
      const currentPassword = $('#profile-current')?.value ?? '';
      const newPassword = $('#profile-new')?.value ?? '';
      const confirmPassword = $('#profile-confirm')?.value ?? '';
      // El servidor lo vuelve a comprobar; esto solo evita un viaje inútil.
      if (!currentPassword || !newPassword) {
        toast('Rellena la contraseña actual y la nueva');
        return;
      }
      if (newPassword.length < minPass()) {
        toast(`La contraseña nueva necesita al menos ${minPass()} caracteres`);
        return;
      }
      if (newPassword !== confirmPassword) {
        toast('Las dos contraseñas nuevas no coinciden');
        return;
      }
      await working(event.currentTarget, 'Cambiando…', async () => {
        try {
          await api('/api/admin/users/me/password', {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
          });
          // El servidor revocó la sesión: se vuelve a entrar con la clave nueva.
          state.auth = null;
          profileSig = null;
          showLogin('Contraseña cambiada. Entra de nuevo con la clave nueva.');
        } catch (error) {
          if (error.message !== 'unauthorized') toast(profileErrorMessage(error));
        }
      });
    });
  }

  /** Relee el usuario de la sesión (pudo cambiar en otro dispositivo) y repinta. */
  async function refreshProfile() {
    try {
      const result = await api('/api/admin/auth/me');
      state.auth = { user: result.user ?? null, legacy: result.legacy === true };
      renderCurrentUser();
      renderPerfil(true);
    } catch (error) {
      if (error.message !== 'unauthorized') renderPerfil(true);
    }
  }

  /**
   * Reconcilia un envío ambiguo: es la ÚNICA salida y la decide una persona que
   * ya miró WhatsApp. No llama a Meta; solo corrige el estado local y queda en la
   * auditoría (quién, cuándo, qué archivo y qué se eligió).
   */
  async function reconcileMedia(mediaId, outcome) {
    const waMessageId = outcome === 'sent' ? ($(`[data-review-wamid="${cssEscape(mediaId)}"]`)?.value ?? '').trim() : '';
    if (outcome === 'sent' && !waMessageId) {
      toast('Escribe el identificador del mensaje (wamid.…) o elige «No salió»');
      return;
    }
    try {
      const query = new URLSearchParams({ outcome });
      if (waMessageId) query.set('wa_message_id', waMessageId);
      await api(`/api/admin/media/retry/${encodeURIComponent(mediaId)}?${query.toString()}`, { method: 'POST' });
      toast(outcome === 'sent' ? 'Marcado como enviado' : 'Marcado como no enviado: se puede reintentar');
      await load({ keepTab: true });
    } catch (error) {
      if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo reconciliar');
    }
  }

  /**
   * Auditoría reciente (lista corta). Se pide por separado porque NO cambia con
   * cada refresco del panel y así la carga principal sigue siendo una sola llamada.
   */
  async function loadAuditEntries() {
    try {
      const body = await api('/api/admin/audit?limit=10');
      state.auditEntries = body.entries ?? [];
    } catch {
      /* sin auditoría el panel sigue funcionando */
    } finally {
      state.auditLoading = false;
      renderAjustes();
    }
  }

  // ------------------------------------------------------------------ ficha

  function renderSheet() {
    const item = state.items.find((candidate) => candidate.id === state.openId);
    if (!item) {
      $('#sheet').hidden = true;
      return;
    }
    const phone = digits(item.phone);
    const reminders = [
      { label: 'Hoy', days: 0 },
      { label: 'Mañana', days: 1 },
      { label: '3 días', days: 3 },
      { label: '1 semana', days: 7 },
    ];
    $('#sheet-title').textContent = item.name ?? label(item.type);
    $('#sheet-body').innerHTML = `
      <div>
        <span class="tag tag--${escapeHtml(item.status ?? 'nuevo')}">${escapeHtml(statusLabel(item.status ?? 'nuevo'))}</span>
        <span class="tag">${escapeHtml(label(item.type))}</span>
        ${item.next_action_at ? `<span class="tag tag--recordatorio">${escapeHtml(fmtDay(item.next_action_at))}</span>` : ''}
      </div>

      <dl class="facts">
        ${item.order_number ? `<div class="fact"><dt>Pedido</dt><dd>${escapeHtml(item.order_number)}</dd></div>` : ''}
        ${
          item.type === 'order_intent'
            ? `<div class="fact"><dt>Atendido por</dt><dd>${escapeHtml(orderAgent(item).label)}</dd></div>`
            : ''
        }
        ${
          item.type === 'order_intent' && orderAgent(item).creador && orderAgent(item).creador !== orderAgent(item).label
            ? `<div class="fact"><dt>Pedido creado por</dt><dd>${escapeHtml(orderAgent(item).creador)}</dd></div>`
            : ''
        }
        ${
          item.customer_id
            ? `<div class="fact"><dt>Cliente</dt><dd>${escapeHtml(item.name ?? 'Sin nombre')}</dd></div>`
            : ''
        }
        ${item.phone ? `<div class="fact"><dt>Teléfono</dt><dd><a href="tel:${escapeHtml(phone)}">${escapeHtml(item.phone)}</a></dd></div>` : ''}
        ${item.location ? `<div class="fact"><dt>Ciudad</dt><dd>${escapeHtml(item.location)}</dd></div>` : ''}
        ${item.variant_name ? `<div class="fact"><dt>Frasco</dt><dd>${escapeHtml(item.variant_name)}</dd></div>` : ''}
        ${item.quantity ? `<div class="fact"><dt>Frascos</dt><dd>${escapeHtml(item.quantity)}</dd></div>` : ''}
        ${item.total ? `<div class="fact"><dt>Total</dt><dd>${money(item.total, item.currency)}</dd></div>` : ''}
        <div class="fact"><dt>Entrada</dt><dd>${escapeHtml(fmtWhen(item.received_at))}</dd></div>
        ${item.source ? `<div class="fact"><dt>Origen</dt><dd>${escapeHtml(item.source)}</dd></div>` : ''}
        ${
          item.last_contact_at
            ? `<div class="fact"><dt>Último contacto</dt><dd>${escapeHtml(fmtWhen(item.last_contact_at))}</dd></div>`
            : ''
        }
      </dl>

      <label class="field">
        <span class="field__label">Estado</span>
        <select class="field__select" id="sheet-status">
          ${state.statuses
            .map(
              (status) =>
                `<option value="${escapeHtml(status.value)}" ${
                  status.value === (item.status ?? 'nuevo') ? 'selected' : ''
                }>${escapeHtml(status.label)}</option>`,
            )
            .join('')}
        </select>
      </label>

      <div class="field">
        <span class="field__label">Recordatorio</span>
        <div class="item__actions" style="margin-top:0">
          ${reminders
            .map(
              (option) =>
                `<button class="chip" data-remind="${option.days}" data-id="${escapeHtml(item.id)}" type="button">${option.label}</button>`,
            )
            .join('')}
          <button class="chip" data-remind="clear" data-id="${escapeHtml(item.id)}" type="button">Quitar</button>
        </div>
        <input class="field__input" type="date" id="sheet-date" value="${escapeHtml(item.next_action_at ?? '')}" />
      </div>

      <label class="field">
        <span class="field__label">Notas</span>
        <textarea class="field__area" id="sheet-notes" placeholder="Qué dijo, cuándo pagar, a qué hora llamar…">${escapeHtml(item.notes ?? '')}</textarea>
      </label>
      <button class="btn btn--primary btn--block" id="sheet-save" type="button">Guardar notas</button>

      ${metaBlock(item)}

      ${
        item.type === 'order_intent'
          ? `<p class="view__hint">Factura, delivery, cliente, seguimiento y mensajes: en el botón <strong>✦</strong>, abajo a la derecha.</p>`
          : ''
      }

      ${sheetFabHtml(`data-item="${escapeHtml(item.id)}"`)}
    `;
    $('#sheet').hidden = false;

    $('#sheet-meta')?.addEventListener('click', async () => {
      const button = $('#sheet-meta');
      button.disabled = true;
      button.textContent = 'Enviando…';
      try {
        const result = await api(`/api/admin/items/${encodeURIComponent(item.id)}/meta-purchase`, { method: 'POST' });
        if (result.item) Object.assign(item, result.item);
        toast(result.ok ? 'Venta enviada a Meta' : 'Meta no aceptó el envío');
      } catch (error) {
        if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo enviar a Meta');
      }
      renderSheet();
      await refreshStats();
    });

    $('#sheet-status').addEventListener('change', (event) => {
      patchItem(item.id, { status: event.target.value }, `Estado: ${statusLabel(event.target.value)}`);
    });
    $('#sheet-date').addEventListener('change', (event) => {
      patchItem(item.id, { nextActionAt: event.target.value }, event.target.value ? 'Recordatorio guardado' : 'Recordatorio quitado');
    });
    $('#sheet-save').addEventListener('click', () => {
      patchItem(item.id, { notes: $('#sheet-notes').value }, 'Notas guardadas');
    });
    $$('[data-remind]', $('#sheet')).forEach((button) => {
      button.addEventListener('click', () => {
        const days = button.dataset.remind;
        const value = days === 'clear' ? '' : addDaysISO(Number(days));
        patchItem(item.id, { nextActionAt: value }, value ? `Recordatorio: ${fmtDay(value)}` : 'Recordatorio quitado');
      });
    });
  }

  /**
   * Bloque "Venta en Meta" de la ficha.
   *
   * Solo se enseña en pedidos y solo se puede reenviar cuando el negocio ya dio
   * el pedido por ENTREGADO (que es cuando de verdad hay una venta que contar).
   */
  function metaBlock(item) {
    if (item.type !== 'order_intent') return '';
    const venta = state.meta?.purchaseStatus ?? 'entregado';
    const enviada = Boolean(item.meta_purchase_sent_at);
    let texto;
    if (enviada) texto = `Venta enviada a Meta el ${fmtWhen(item.meta_purchase_sent_at)}.`;
    else if (item.meta_purchase_status === 'failed')
      texto = `Meta rechazó el envío (${item.meta_purchase_error ?? 'error'}). Se reintenta solo al reiniciar.`;
    else if (item.status === venta) texto = 'Enviando la venta a Meta…';
    else texto = `Al marcar el pedido como «${venta}» se envía la venta a Meta una sola vez.`;

    const canRetry = !enviada && item.status === venta;
    return `
      <div class="field">
        <span class="field__label">Venta en Meta</span>
        <p class="view__hint">${escapeHtml(texto)}</p>
        ${canRetry ? `<button class="btn btn--ghost btn--block" id="sheet-meta" type="button">${item.meta_purchase_status === 'failed' ? 'Reintentar envío' : 'Enviar a Meta'}</button>` : ''}
      </div>
    `;
  }

  // ------------------------------------------------ conversación y ficha 360

  /**
   * Abre la hoja. `variant: 'menu'` la convierte en popover en escritorio (un
   * menú no sube desde abajo en una pantalla grande); en el móvil es la misma
   * hoja de siempre.
   */
  function openSheet(title, html, { variant = '' } = {}) {
    $('#sheet-title').textContent = title;
    $('#sheet-body').innerHTML = html;
    const sheet = $('#sheet');
    if (variant) sheet.dataset.variant = variant;
    else delete sheet.dataset.variant;
    sheet.hidden = false;
  }

  function closeSheet() {
    // Nada de micrófono abierto ni temporizadores vivos al cerrar la hoja.
    try {
      closeSheetCleanup?.();
    } catch {
      /* el cierre nunca puede fallar por una limpieza */
    }
    closeSheetCleanup = null;
    state.openId = null;
    state.customerId = null;
    state.chat = null;
    pendingOptOut = null;
    $('#sheet').hidden = true;
  }

  /** Botón con estado "trabajando" (evita dos toques que envían dos mensajes). */
  async function working(button, label, task) {
    const original = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = label;
    }
    try {
      return await task();
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = original;
      }
    }
  }

  /**
   * Abre una conversación EN LA BANDEJA (desde Hoy, un seguimiento o la lista).
   * Ya no hay chat en ventana emergente: una sola pantalla, una sola fuente.
   */
  async function openChat(conversationId, options = {}) {
    if (!conversationId) return;
    state.openId = null;
    state.customerId = null;
    closeSheet();
    setTab('whatsapp', { silent: true });
    await selectConversation(conversationId, options);
    window.scrollTo({ top: 0 });
  }

  /**
   * Enlace directo del tipo `?v=whatsapp&conv=<id>`: abre ESA conversación.
   * Lo usa el aviso de mensaje nuevo («tienes un mensaje de Ana») y sirve para
   * compartir un chat concreto con otra persona del negocio.
   */
  async function applyDeepLink(query) {
    const conversationId = query?.get('conversation') || query?.get('conv');
    const orderId = query?.get('order');
    if (orderId) {
      state.deliveryActiveOrderId = orderId;
      setTab('delivery', { silent: true });
      try {
        await api(`/api/admin/delivery/orders/${encodeURIComponent(orderId)}${query?.get('notification') ? `?notification=${encodeURIComponent(query.get('notification'))}` : ''}`);
        await load({ keepTab: true });
        setTab('delivery', { silent: true });
      } catch {
        toast('No tienes acceso a ese pedido');
      }
      return;
    }
    if (!conversationId) return;
    try {
      await openChat(conversationId);
    } catch {
      /* el enlace apunta a algo que ya no existe: se queda en la bandeja */
    }
  }

  /** Un mensaje del hilo. Se distingue QUIÉN escribió: cliente, negocio o el sistema. */
  function bubble(message, grouped = false) {
    const inbound = message.direction === 'inbound';
    const auto = !inbound && message.actor_type === 'SYSTEM';
    /*
     * El cliente ve “Enviando / Enviado / Entregado / Leído / Fallido”, como en
     * WhatsApp. OJO: `sent` solo significa que WhatsApp ACEPTÓ el mensaje, no que
     * le haya llegado al cliente; en una plantilla (el primer contacto) se dice
     * «sin confirmar» para no prometer una entrega que Meta no ha confirmado.
     */
    const estado = inbound
      ? ''
      : isTemplateMessage(message) && message.status === 'sent'
        ? 'Enviado · sin confirmar'
        : WA_STATUS[message.status] ?? '';
    const media = message.media ?? null;
    const tipo = message.type ?? 'text';
    const mediaSrc = media?.id ? mediaUrl(media.id) : null;
    const mediaListo = media?.status === 'STORED';
    /*
     * Contenido: el texto se escapa SIEMPRE (nunca se pinta HTML de WhatsApp).
     * Multimedia: el archivo se pide al endpoint privado del CRM (con sesión) y se
     * muestra de verdad: imagen con miniatura y visor, audio con reproductor
     * propio. Si el servidor no lo tiene todavía se dice “descargando”, y si falló
     * se dice que falló y se ofrece reintentar. Nunca aparece “un objeto” ni un
     * corchete raro.
     */
    let cuerpo;
    /*
     * ¿El mensaje es SOLO el archivo? Entonces el archivo ES la burbuja (una
     * sola pieza visual, sin tarjeta dentro de tarjeta). Si además trae texto, la
     * burbuja hace de marco para la imagen + el pie de foto.
     */
    let soloArchivo = false;
    const templateName = message.template_name ? waTemplateLabel((state.templates ?? []).find((template) => template.name === message.template_name) ?? { name: message.template_name }) : null;
    if (isTemplateMessage(message) && message.status === 'failed') {
      const friendly = waFriendlyTemplateError(message);
      cuerpo = `<span class="template-fail">
        <strong>Plantilla no enviada</strong>
        ${templateName ? `<span>${escapeHtml(templateName)}</span>` : ''}
        <small>${escapeHtml(friendly)}</small>
        ${message.error_code ? `<code>#${escapeHtml(message.error_code)}</code>` : ''}
      </span>`;
    } else if (tipo === 'image' && mediaSrc && mediaListo) {
      soloArchivo = !message.body;
      cuerpo = `<button class="media-thumb" data-media-view="${escapeHtml(media.id)}" type="button" aria-label="Ver la imagen en grande"><img src="${escapeHtml(mediaSrc)}" alt="Imagen del cliente" loading="lazy" decoding="async" /></button>`;
      if (message.body) cuerpo += `<span class="media-caption">${escapeHtml(message.body)}</span>`;
    } else if ((tipo === 'audio' || tipo === 'voice') && mediaSrc && mediaListo) {
      soloArchivo = true;
      // Si el servidor ya sabe cuánto dura (Meta lo manda), se enseña desde el
      // principio: un reproductor que arranca en «--:--» parece roto.
      const duracion = Number(media?.durationMs) > 0 ? fmtSeconds(media.durationMs / 1000) : '--:--';
      cuerpo = `<span class="audio" data-audio="${escapeHtml(media.id)}">
          <button class="audio__play" data-audio-play="${escapeHtml(media.id)}" data-audio-src="${escapeHtml(
            mediaSrc,
          )}" type="button" aria-label="Reproducir">▶</button>
          <span class="audio__main">
            <input class="audio__seek" data-audio-seek="${escapeHtml(media.id)}" type="range" min="0" max="1000" value="0"
              aria-label="Posición del audio" />
            <span class="audio__times"><span data-audio-current>0:00</span><span data-audio-total>${duracion}</span></span>
          </span>
          <span class="audio__kind" aria-hidden="true">${tipo === 'voice' ? ICONS.mic : ICONS.audio}</span>
        </span>`;
    } else if (tipo === 'location') {
      /*
       * UBICACIÓN: una pieza visual propia (no pasa por multimedia). Si el mensaje
       * trae coordenadas legibles se puede abrir el mapa y reutilizarla; si no, se
       * dice sin inventar nada.
       */
      soloArchivo = true;
      cuerpo = message.location
        ? locationChip(message.location)
        : `<span class="loc loc--empty">
             <span class="loc__head"><span class="loc__pin" aria-hidden="true">📍</span>
               <span class="loc__title">Ubicación compartida</span></span>
             <span class="loc__meta">No se pudieron leer las coordenadas</span>
           </span>`;
    } else if (tipo !== 'text' && tipo !== 'button' && tipo !== 'interactive') {
      const falló = media?.status === 'FAILED' || Boolean(media?.errorCode);
      const cargando = Boolean(media) && !mediaListo && !falló;
      const icono = WA_KIND_ICON[tipo] ?? '📄';
      const nombre = WA_KIND_LABEL[tipo] ?? 'Archivo';
      if (falló) {
        cuerpo = `<span class="media-state media-state--failed"><span aria-hidden="true">${icono}</span>
            <span>No se pudo descargar el ${escapeHtml(nombre.toLowerCase())}</span></span>
          ${
            media?.id
              ? `<button class="btn btn--ghost btn--sm" data-media-retry="${escapeHtml(media.id)}" type="button">Reintentar</button>`
              : ''
          }`;
      } else if (cargando) {
        cuerpo = `<span class="media-state"><span aria-hidden="true">${icono}</span>
            <span>Descargando ${escapeHtml(nombre.toLowerCase())}…</span></span>`;
      } else {
        // Sin almacén (o mensaje antiguo): se describe, nunca se inventa el archivo.
        cuerpo = `<span class="media-fallback"><span aria-hidden="true">${icono}</span>${escapeHtml(
          `${nombre} recibido`,
        )}</span>`;
      }
      if (message.body && message.body !== `[${tipo}]`) cuerpo += escapeHtml(message.body);
    } else {
      cuerpo = escapeHtml(message.body ?? '');
      if (isTemplateMessage(message) && templateName) {
        cuerpo += `<span class="template-chip">${escapeHtml(templateName)}</span>`;
      }
    }
    const who = inbound
      ? 'Cliente'
      : message.actor_type === 'SYSTEM'
        ? 'Sistema'
        : message.sent_by_display_name_snapshot || (message.sent_by && message.sent_by !== 'panel' ? message.sent_by : '');
    /*
     * El HTML se arma PEGADO a propósito, sin saltos de línea ni sangría de
     * plantilla. La burbuja conserva los saltos que escribió una persona
     * (`white-space: pre-wrap`), así que cualquier espacio de la plantilla se
     * vería como líneas VACÍAS arriba y abajo del texto: eso era el aire que
     * dejaba el mensaje "suelto" en medio de la burbuja.
     */
    const quien = who && !grouped ? `<span class="bubble__who">${escapeHtml(who)}</span>` : '';
    const label = isTemplateMessage(message) && message.status !== 'failed' ? (templateName ? templateName : 'Plantilla') : null;
    const hora = `<span class="bubble__meta">${escapeHtml(fmtWhen(message.created_at))}${
      label ? ` · ${escapeHtml(label)}` : ''
    }${
      estado ? ` · ${escapeHtml(estado)}` : ''
    }${message.error_message && !isTemplateMessage(message) ? ` · ${escapeHtml(message.error_message)}` : ''}</span>`;
    const clases = [
      `bubble bubble--${inbound ? 'in' : 'out'}`,
      auto ? 'bubble--auto' : '',
      message.status === 'failed' ? 'bubble--failed' : '',
      grouped ? 'bubble--grouped' : '',
      soloArchivo ? 'bubble--media' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return `<div class="${clases}">${quien}${cuerpo}${hora}</div>`;
  }

  // --------------------------------------------------- bandeja de WhatsApp
  /*
   * Una sola pantalla, dos columnas: a la izquierda las conversaciones (con
   * búsqueda y filtros), a la derecha el hilo y el compositor. En el móvil se
   * ve la lista y, al abrir una, la conversación ocupa la pantalla con ← para
   * volver. Nada se envía solo: el botón Enviar es siempre un acto humano.
   */

  const WA_FILTERS = [
    ['todos', 'Todos'],
    ['mios', 'Míos'],
    ['sin-asignar', 'Sin asignar'],
    ['no-leidos', 'Nuevos'],
    ['pendientes', 'Pendientes'],
    ['clientes', 'Clientes'],
    ['seguimiento', 'Seguimiento'],
    ['archivados', 'Archivados'],
  ];

  const waFilterCount = (value) => {
    const counts = state.wa.counts ?? {};
    return {
      todos: counts.todos,
      mios: state.conversations.filter((row) => row.assigned_user_id === currentUser()?.id).length,
      'sin-asignar': counts.sin_asignar ?? state.conversations.filter((row) => !row.assigned_user_id).length,
      'no-leidos': counts.no_leidos,
      pendientes: counts.pendientes,
      clientes: counts.clientes,
      seguimiento: counts.seguimiento,
      archivados: counts.archivados,
    }[value];
  };

  /** Lo que ve una persona: nunca el `wa_message_id`. */
  const WA_STATUS = {
    pending: 'Preparando',
    queued: 'Preparando',
    sent: 'Enviado',
    delivered: 'Entregado',
    read: 'Leído',
    failed: 'Fallido',
  };

  const CONTACT_STATE = {
    NEW_CONTACT: 'NEW_CONTACT',
    WAITING_CUSTOMER_REPLY: 'WAITING_CUSTOMER_REPLY',
    OPEN_WINDOW: 'OPEN_WINDOW',
    CLOSED_WINDOW: 'CLOSED_WINDOW',
    TEMPLATE_FAILED: 'TEMPLATE_FAILED',
  };

  const isInboundMessage = (message) => message?.direction === 'inbound';
  const isTemplateMessage = (message) => message?.type === 'template' || Boolean(message?.template_name);
  const isSentTemplateStatus = (status) => ['sent', 'delivered', 'read'].includes(String(status ?? '').toLowerCase());

  function lastMessageWhere(messages, check) {
    for (let index = (messages ?? []).length - 1; index >= 0; index -= 1) {
      if (check(messages[index])) return messages[index];
    }
    return null;
  }

  function getConversationContactState(input = {}) {
    const messages = input.messages ?? input.conversation?.messages ?? [];
    const canSendFreeText = input.canSendFreeText === true;
    if (canSendFreeText) return CONTACT_STATE.OPEN_WINDOW;
    const lastInbound = lastMessageWhere(messages, isInboundMessage);
    const lastOutbound = lastMessageWhere(messages, (message) => message?.direction === 'outbound');
    /*
     * WhatsApp rechazó la última plantilla (p. ej. el número no tiene WhatsApp):
     * se DICE, no se disimula con un «inicia la conversación» como si no se
     * hubiera intentado nada. El motivo lo pinta el propio estado.
     */
    if (
      lastOutbound &&
      isTemplateMessage(lastOutbound) &&
      lastOutbound.status === 'failed' &&
      (!lastInbound || new Date(lastOutbound.created_at) > new Date(lastInbound.created_at))
    ) {
      return CONTACT_STATE.TEMPLATE_FAILED;
    }
    const lastSentTemplate = lastMessageWhere(
      messages,
      (message) => message?.direction === 'outbound' && isTemplateMessage(message) && isSentTemplateStatus(message.status),
    );
    if (lastSentTemplate && (!lastInbound || new Date(lastSentTemplate.created_at) > new Date(lastInbound.created_at))) {
      return CONTACT_STATE.WAITING_CUSTOMER_REPLY;
    }
    if (!lastInbound && !messages.length) return CONTACT_STATE.NEW_CONTACT;
    if (!lastInbound && messages.every((message) => message?.direction !== 'inbound')) return CONTACT_STATE.NEW_CONTACT;
    return CONTACT_STATE.CLOSED_WINDOW;
  }

  function waFriendlyTemplateError(message) {
    const text = String(message?.error_message ?? '');
    const code = String(message?.error_code ?? '');
    if (code === '132000' || /Number of parameters does not match/i.test(text)) {
      return 'Esta plantilla no pudo enviarse porque faltan o sobran datos requeridos.';
    }
    return text || 'WhatsApp rechazó el envío de la plantilla.';
  }

  const waAwaiting = (row) => row.awaiting_reply === true;
  const waCustomer = (row) => row.customer ?? customerById(row.customer_id);
  const waDisplayName = (row) => {
    const customer = waCustomer(row);
    return (customer?.name ?? '').trim() || customer?.phone_e164 || 'Cliente';
  };

  function waDateRange(filter = state.wa.date) {
    const today = todayISO();
    if (!filter || filter.mode === 'all') return { mode: 'all', from: '', to: '', label: 'Todas' };
    if (filter.mode === 'today') return { mode: 'today', from: today, to: today, label: 'Hoy' };
    if (filter.mode === 'yesterday') {
      const day = addDaysToISO(today, -1);
      return { mode: 'yesterday', from: day, to: day, label: 'Ayer' };
    }
    if (filter.mode === '7d') return { mode: '7d', from: addDaysToISO(today, -6), to: today, label: 'Últimos 7 días' };
    if (filter.mode === 'month') return { mode: 'month', from: `${today.slice(0, 7)}-01`, to: today, label: 'Este mes' };
    if (filter.mode === 'custom') {
      return {
        mode: 'custom',
        from: filter.from || '',
        to: filter.to || '',
        label: filter.from && filter.to ? `${filter.from.slice(8, 10)}/${filter.from.slice(5, 7)}–${filter.to.slice(8, 10)}/${filter.to.slice(5, 7)}` : 'Personalizado',
      };
    }
    return { mode: 'all', from: '', to: '', label: 'Todas' };
  }

  /*
   * EL FILTRO DE FECHA ES UN CHIP MÁS de la lista (no un botón con reloj pegado
   * al buscador): enseña el rango activo y se cambia desde el mismo sitio que el
   * resto de filtros, igual en el móvil que en el escritorio. Cuando no hay
   * ninguno puesto dice «Fecha», para no confundirse con el chip «Todos».
   */
  const waDateChipHtml = () => {
    const active = waDateRange();
    return `<button class="chip chip--date" data-wa-date-open type="button" aria-pressed="${Boolean(
      active.mode !== 'all',
    )}" aria-label="Filtrar conversaciones por fecha">${escapeHtml(
      active.mode === 'all' ? 'Fecha' : active.label,
    )}</button>`;
  };

  function rowInWaDateRange(row, range = waDateRange()) {
    if (range.mode === 'all') return true;
    if (!row.last_message_at) return false;
    const day = businessDayISO(row.last_message_at);
    if (range.from && day < range.from) return false;
    if (range.to && day > range.to) return false;
    return true;
  }

  function compareWaRowsRecent(a, b) {
    const byLast = String(b.last_message_at ?? '').localeCompare(String(a.last_message_at ?? ''));
    if (byLast) return byLast;
    const byUpdated = String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''));
    if (byUpdated) return byUpdated;
    const byCreated = String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
    if (byCreated) return byCreated;
    return String(a.id ?? '').localeCompare(String(b.id ?? ''));
  }

  /** Icono y nombre legible de cada tipo de contenido (mismo sistema de iconos). */
  const WA_KIND_ICON = {
    image: ICONS.image,
    audio: ICONS.audio,
    voice: ICONS.mic,
    document: ICONS.doc,
    video: ICONS.video,
    sticker: ICONS.tagIcon,
    location: ICONS.pin,
  };
  const WA_KIND_LABEL = {
    image: 'Imagen',
    audio: 'Audio',
    voice: 'Nota de voz',
    document: 'Documento',
    video: 'Video',
    sticker: 'Sticker',
    location: 'Ubicación',
  };

  const COMMERCIAL_HINTS = {
    NUEVO: 'Prospecto',
    EN_CONVERSACION: 'Prospecto',
    INTERESADO: 'Interesado',
    PEDIDO_CREADO: 'Pedido',
    CONFIRMADO: 'Confirmado',
    ENTREGADO: 'Cliente',
    SEGUIMIENTO: 'Seguimiento',
    RECOMPRA: 'Cliente',
    PERDIDO: 'Perdido',
  };

  /** Iniciales para el avatar cuando no hay foto de perfil. */
  const waInitials = (value) => {
    const parts = String(value ?? '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
  };

  const customerPhotoUrl = (customer) =>
    [
      customer?.photo_url,
      customer?.photoUrl,
      customer?.avatar_url,
      customer?.avatarUrl,
      customer?.profile_picture_url,
      customer?.profilePictureUrl,
      customer?.picture_url,
    ].find((value) => typeof value === 'string' && value.trim())?.trim() ?? '';

  function avatarHtml(customer, label, className = '', options = {}) {
    const name = label || customerName(customer ?? {}) || 'Cliente';
    const src = customerPhotoUrl(customer);
    const cls = ['avatar', className, src ? 'avatar--photo' : ''].filter(Boolean).join(' ');
    const attrs = options.attrs ? ` ${options.attrs}` : '';
    const content = src
      ? `<img src="${escapeHtml(src)}" alt="" loading="${options.loading ?? 'lazy'}" decoding="async" />`
      : escapeHtml(waInitials(name));
    return `<span class="${escapeHtml(cls)}"${attrs}>${content}</span>`;
  }

  function setAvatarContent(node, customer, label) {
    if (!node) return;
    const src = customerPhotoUrl(customer);
    node.classList.toggle('avatar--photo', Boolean(src));
    node.innerHTML = src
      ? `<img src="${escapeHtml(src)}" alt="" loading="eager" decoding="async" />`
      : escapeHtml(waInitials(label || customerName(customer ?? {})));
  }

  /*
   * FOTO DEL CLIENTE.
   *
   * WhatsApp no entrega la foto de perfil de los contactos por su API (solo el
   * nombre), así que la foto la pone el equipo: se elige del teléfono, el panel
   * la reduce a 192 px y se guarda con el cliente. A partir de ahí aparece en la
   * lista, en la cabecera del chat y en su ficha.
   */
  const CUSTOMER_PHOTO_MAX_PX = 192;
  const CUSTOMER_PHOTO_MAX_CHARS = 140000;

  /** Reduce la imagen elegida antes de subirla (y avisa si no se puede). */
  function reduceCustomerPhoto(file) {
    return new Promise((resolve) => {
      const lector = new FileReader();
      lector.onerror = () => resolve(null);
      lector.onload = () => {
        const dataUrl = String(lector.result ?? '');
        const pequena = dataUrl.length <= CUSTOMER_PHOTO_MAX_CHARS ? dataUrl : null;
        let contexto = null;
        try {
          const lienzo = document.createElement('canvas');
          contexto = lienzo.getContext ? lienzo.getContext('2d') : null;
        } catch {
          contexto = null;
        }
        // Sin lienzo (navegador viejo o entorno de pruebas) se sube tal cual si cabe.
        if (!contexto || typeof Image !== 'function') return resolve(pequena);
        const imagen = new Image();
        imagen.onerror = () => resolve(null);
        imagen.onload = () => {
          const lado = Math.max(imagen.width, imagen.height) || 1;
          const escala = Math.min(1, CUSTOMER_PHOTO_MAX_PX / lado);
          const lienzo = document.createElement('canvas');
          lienzo.width = Math.max(1, Math.round(imagen.width * escala));
          lienzo.height = Math.max(1, Math.round(imagen.height * escala));
          const ctx = lienzo.getContext('2d');
          if (!ctx) return resolve(pequena);
          ctx.drawImage(imagen, 0, 0, lienzo.width, lienzo.height);
          const reducida = lienzo.toDataURL('image/jpeg', 0.82);
          resolve(reducida.length <= CUSTOMER_PHOTO_MAX_CHARS ? reducida : null);
        };
        imagen.src = dataUrl;
      };
      lector.readAsDataURL(file);
    });
  }

  /** Guarda (o borra, con `null`) la foto del cliente y repinta la ficha. */
  async function saveCustomerPhoto(customerId, photoUrl) {
    await api(`/api/admin/customers/${encodeURIComponent(customerId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ photo_url: photoUrl }),
    });
    await load({ keepTab: true });
    await openCustomer(customerId);
  }

  /** «Hoy», «Ayer» o la fecha: el separador que ordena el hilo. */
  const waDayLabel = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    if (day === todayISO()) return 'Hoy';
    if (day === addDaysISO(-1)) return 'Ayer';
    return new Intl.DateTimeFormat('es-DO', { day: 'numeric', month: 'long' }).format(date);
  };

  /** Hilo completo: separadores por día y agrupación de mensajes seguidos. */
  function waThreadHtml(messages) {
    let html = '';
    let lastDay = '';
    let lastDirection = '';
    for (const message of messages) {
      const day = waDayLabel(message.created_at);
      if (day && day !== lastDay) {
        html += `<div class="day-sep">${escapeHtml(day)}</div>`;
        lastDay = day;
        lastDirection = '';
      }
      const grouped = message.direction === lastDirection;
      html += bubble(message, grouped);
      lastDirection = message.direction;
    }
    return html;
  }

  /** Firma del hilo: si no cambia, no se vuelve a pintar (y no se pierde lo escrito). */
  const waThreadSig = (data) => {
    const messages = data?.messages ?? [];
    const last = messages[messages.length - 1];
    const contactState = getConversationContactState(data);
    return [
      messages.length,
      last?.id ?? '',
      last?.status ?? '',
      last?.delivered_at ?? '',
      last?.read_at ?? '',
      data?.canSendFreeText ? 1 : 0,
      contactState,
    ].join('|');
  };

  /** Conversaciones visibles según el filtro y la búsqueda, la más reciente primero. */
  function waVisibleConversations() {
    const { filter, q } = state.wa;
    let rows = state.conversations.slice();
    if (filter === 'mios') rows = rows.filter((row) => row.assigned_user_id === currentUser()?.id);
    if (filter === 'sin-asignar') rows = rows.filter((row) => !row.assigned_user_id);
    if (filter === 'pendientes') rows = rows.filter(waAwaiting);
    if (filter === 'no-leidos') rows = rows.filter((row) => Number(row.unread_count) > 0);
    if (filter === 'clientes') rows = rows.filter((row) => row.has_purchase === true);
    if (filter === 'seguimiento') rows = rows.filter((row) => row.next_followup);
    if (filter === 'archivados') rows = rows.filter((row) => row.archived_at);
    if (filter !== 'archivados') rows = rows.filter((row) => !row.archived_at);
    const dateRange = waDateRange();
    rows = rows.filter((row) => rowInWaDateRange(row, dateRange));
    if (q) {
      const needle = q.toLowerCase();
      rows = rows.filter((row) => {
        const customer = waCustomer(row);
        return [customer?.name, customer?.phone_e164, row.last_message?.body]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle);
      });
    }
    return rows.sort(compareWaRowsRecent);
  }

  const WA_DATE_FILTERS = [
    ['all', 'Todas'],
    ['today', 'Hoy'],
    ['yesterday', 'Ayer'],
    ['7d', 'Últimos 7 días'],
    ['month', 'Este mes'],
    ['custom', 'Personalizado'],
  ];

  function daysBetweenISO(a, b) {
    const [ay, am, ad] = String(a).split('-').map(Number);
    const [by, bm, bd] = String(b).split('-').map(Number);
    return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
  }

  function formatWaTime(date) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: BUSINESS_TIME_ZONE,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  }

  function shortWeekday(date) {
    const label = new Intl.DateTimeFormat('es-DO', { timeZone: BUSINESS_TIME_ZONE, weekday: 'short' })
      .format(date)
      .replace('.', '');
    return label ? label[0].toUpperCase() + label.slice(1) : '';
  }

  function formatShortDate(day) {
    const [year, month, date] = String(day).split('-');
    return `${date}/${month}/${year}`;
  }

  /** Sello visible de la fila: fecha/hora real del último mensaje en la zona del negocio. */
  function waLastMessageStamp(iso) {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    const messageDay = businessDayISO(date);
    const today = todayISO();
    const diff = daysBetweenISO(today, messageDay);
    const time = formatWaTime(date);
    const label =
      diff === 0
        ? `Hoy · ${time}`
        : diff === 1
          ? `Ayer · ${time}`
          : diff > 1 && diff < 7
            ? `${shortWeekday(date)} · ${time}`
            : formatShortDate(messageDay);
    return {
      label,
      day: messageDay,
      completo: new Intl.DateTimeFormat('es-DO', {
        timeZone: BUSINESS_TIME_ZONE,
        dateStyle: 'medium',
        timeStyle: 'short',
        hour12: true,
      }).format(date),
    };
  }

  /** Una conversación de la lista (nombre o teléfono, nunca un id técnico). */
  function conversationAssignmentLabel(conversation) {
    return conversation?.assigned_user_id
      ? `Atiende ${conversation.assigned_display_name_snapshot ?? 'agente'}`
      : 'Sin asignar';
  }

  function conversationAssignmentKind(conversation) {
    if (!conversation?.assigned_user_id) return 'unassigned';
    return conversation.assigned_user_id === currentUser()?.id ? 'mine' : 'other';
  }

  function assignmentMenuHtml(conversation, options = {}) {
    const conversationId = conversation?.id ?? options.conversationId ?? '';
    const assignmentKind = conversationAssignmentKind(conversation);
    const assignedToMe = assignmentKind === 'mine';
    const assignedToOther = assignmentKind === 'other';
    const canTake = assignmentKind === 'unassigned' && currentUser() && hasPermission('chats.take_unassigned');
    const canRelease = conversation?.assigned_user_id && (assignedToMe || isAdmin());
    const canReassign = Boolean(conversation?.assigned_user_id) && isAdmin();
    /*
     * LA PRIMERA FILA ES LA QUE ASIGNA: dice quién atiende y al pulsarla se elige
     * responsable (a mí o a otra persona). Antes era un cartel que no hacía nada.
     */
    const canChooseResponsible = Boolean(currentUser()) && (canTake || isAdmin());
    const assignmentRow = canChooseResponsible
      ? `<button class="menu-item" data-conv-assign="${escapeHtml(conversationId)}" type="button"><span class="menu-item__icon" aria-hidden="true">${ICONS.users}</span><span><strong>${escapeHtml(conversationAssignmentLabel(conversation))}</strong><small>Asignar a una persona</small></span></button>`
      : `<div class="menu-item menu-item--static"><span class="menu-item__icon" aria-hidden="true">${ICONS.users}</span><span><strong>${escapeHtml(conversationAssignmentLabel(conversation))}</strong><small>Responsable de esta conversación</small></span></div>`;
    return `
        ${assignmentRow}
        ${canTake ? `<button class="menu-item" data-conv-take="${escapeHtml(conversationId)}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.checkCircle}</span>
          <span><strong>Tomar conversación</strong><small>Queda asignada a ti</small></span>
        </button>` : ''}
        ${canRelease ? `<button class="menu-item" data-conv-release="${escapeHtml(conversationId)}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.close}</span>
          <span><strong>Liberar conversación</strong><small>Vuelve a Sin asignar</small></span>
        </button>` : ''}
        ${canReassign ? `<button class="menu-item" data-conv-reassign="${escapeHtml(conversationId)}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.users}</span>
          <span><strong>Reasignar / transferir</strong><small>Pasar a otro agente</small></span>
        </button>` : ''}
        ${assignedToOther && !isAdmin() ? `<div class="menu-item menu-item--static">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.lock}</span>
          <span><strong>Asignada a otra persona</strong><small>Puedes ver la ficha, no tomarla.</small></span>
        </div>` : ''}`;
  }

  /**
   * ELEGIR RESPONSABLE: «Asignármela a mí» primero (un toque), luego el equipo y,
   * al final, dejarla sin asignar. El servidor recibe lo mismo de siempre
   * (`take` / `assign` / `release`): aquí solo cambia CÓMO se elige.
   */
  async function openAssignSheet(conversationId) {
    const id = conversationId || state.wa.selectedId || '';
    const conversation =
      state.wa.chat?.conversation?.id === id
        ? state.wa.chat.conversation
        : state.conversations.find((row) => row.id === id) ?? null;
    if (!conversation) {
      toast('No pudimos leer esa conversación');
      return;
    }
    const me = currentUser();
    const kind = conversationAssignmentKind(conversation);
    const mine = kind === 'mine';
    const canTake = Boolean(me) && !mine && (kind === 'unassigned' || isAdmin());
    const canRelease = Boolean(conversation.assigned_user_id) && (mine || isAdmin());
    // La lista del equipo la pide quien puede administrar (si no, sobra la llamada).
    if (isAdmin() && !(state.users ?? []).length) await loadUsers().catch(() => {});
    const agents = isAdmin() ? (state.users ?? []).filter((user) => user.active !== false) : [];
    const agentRow = (user) => {
      const current = conversation.assigned_user_id === user.id;
      return `<button class="menu-item" data-conv-assign-user="${escapeHtml(user.id)}" data-conversation="${escapeHtml(
        id,
      )}" type="button">
        <span class="menu-item__icon" aria-hidden="true">${current ? ICONS.checkCircle : ''}</span>
        <span><strong>${escapeHtml(user.display_name ?? 'Agente')}</strong><small>${escapeHtml(
          roleLabel(user.role),
        )}${current ? ' · al frente ahora' : ''}</small></span>
      </button>`;
    };
    openSheet(
      'Asignar conversación',
      `<div class="menu-list">
        ${
          canTake
            ? `<button class="menu-item" data-conv-assign-me="${escapeHtml(id)}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.checkCircle}</span>
          <span><strong>Asignármela a mí</strong><small>${escapeHtml(me?.display_name ?? 'Yo')} queda al frente</small></span>
        </button>`
            : ''
        }
        ${agents.map(agentRow).join('')}
        ${
          canRelease
            ? `<button class="menu-item" data-conv-release="${escapeHtml(id)}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.close}</span>
          <span><strong>Dejarla sin asignar</strong><small>Que la tome quien pueda</small></span>
        </button>`
            : ''
        }
      </div>
      ${
        !canTake && !agents.length && !canRelease
          ? '<p class="rule rule--warn">Tu usuario no puede cambiar el responsable de esta conversación.</p>'
          : ''
      }`,
      { variant: 'menu' },
    );
  }

  function waRow(row) {
    const unread = Number(row.unread_count) || 0;
    const awaiting = waAwaiting(row);
    const customer = waCustomer(row);
    const last = row.last_message;
    const tipo = last?.type ?? 'text';
    const kind = last && tipo !== 'text' ? WA_KIND_ICON[tipo] ?? '' : '';
    const texto = last
      ? tipo === 'text'
        ? String(last.body ?? '').slice(0, 80)
        : WA_KIND_LABEL[tipo] ?? 'Adjunto'
      : 'Sin mensajes';
    const nombre = waDisplayName(row);
    /*
     * En la fila, el seguimiento es una ETIQUETA, no una frase: sin día de la
     * semana (la fecha completa está dentro del chat) para que la línea de
     * estado quede pequeña y no robe ancho al nombre.
     */
    const followupDay = row.next_followup ? String(row.next_followup.scheduled_at).slice(0, 10) : null;
    const followupText = followupDay
      ? `${followupDay < todayISO() ? 'vencido · ' : ''}${followupDay.slice(8, 10)}/${followupDay.slice(5, 7)}`
      : null;
    const stage = customerStageOf(row);
    const activeOrder = row.active_order?.status ? `Pedido · ${statusLabel(row.active_order.status)}` : null;
    const assignment = conversationAssignmentLabel(row);
    const compactFlags = [customerStageLabel(stage), followupText, activeOrder].filter(Boolean).slice(0, 3);
    const flags =
      awaiting || row.status === 'HUMAN_REQUIRED' || compactFlags.length || assignment
        ? `<span class="conv__flags">
            ${awaiting ? '<span class="conv__await">Pendiente</span>' : ''}
            ${row.status === 'HUMAN_REQUIRED' ? '<span class="conv__await">Necesita una persona</span>' : ''}
            ${compactFlags.map((flag) => `<span class="conv__tag">${escapeHtml(flag)}</span>`).join('')}
            <span class="conv__assign ${row.assigned_user_id ? '' : 'conv__assign--empty'}">${escapeHtml(assignment)}</span>
          </span>`
        : '';
    const selected = state.wa.selected.has(row.id);
    const sello = waLastMessageStamp(row.last_message_at);
    return `<div class="conv-wrap ${selected ? 'conv-wrap--selected' : ''}">
      <button class="conv ${state.wa.selectedId === row.id ? 'conv--active' : ''} ${unread ? 'conv--unread' : ''}" data-conv="${escapeHtml(
        row.id,
      )}" type="button" aria-label="Abrir conversación con ${escapeHtml(nombre)}">
        ${
          selected
            ? `<span class="avatar conv__avatar conv__avatar--sel" aria-hidden="true">${ICONS.check}</span>`
            : avatarHtml(customer, nombre, 'conv__avatar conv__avatar--profile', {
                attrs: `data-customer="${escapeHtml(customer?.id ?? '')}" role="button" tabindex="0" aria-label="Ver perfil de ${escapeHtml(nombre)}"`,
              })
        }
        <span class="conv__body">
          <span class="conv__name">${escapeHtml(nombre)}</span>
          <span class="conv__preview">${kind ? `<span class="conv__kind" aria-hidden="true">${kind}</span>` : ''}<span>${escapeHtml(texto)}</span></span>
          ${flags}
        </span>
        <span class="conv__stamps"${sello ? ` title="${escapeHtml(sello.completo)}"` : ''}>${
          sello ? `<span class="conv__when">${escapeHtml(sello.label)}</span>` : ''
        }${unread ? `<span class="conv__unread" aria-label="${unread} mensaje${unread === 1 ? '' : 's'} sin leer">${ICONS.bell}<span>${unread}</span></span>` : ''}</span>
      </button>
      <button class="conv__more" data-conv-more="${escapeHtml(row.id)}" type="button" aria-label="Más acciones de la conversación con ${escapeHtml(
        nombre,
      )}">
        <img class="conv__more-icon" src="/admin/icon-more.png" alt="" aria-hidden="true" width="18" height="18" />
      </button>
    </div>`;
  }

  function playNewMessageSound() {
    if (!state.wa.sound) return;
    const asset = new Audio('/admin/assets/sounds/message-notification.wav');
    asset.volume = 0.42;
    asset.play().catch(() => {
      try {
        const audio = new AudioContext();
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.frequency.value = 740;
        gain.gain.value = 0.025;
        osc.connect(gain);
        gain.connect(audio.destination);
        osc.start();
        osc.stop(audio.currentTime + 0.08);
        setTimeout(() => audio.close().catch(() => {}), 180);
      } catch {
        /* sin audio: no pasa nada */
      }
    });
  }

  function notifyNewInbound(row) {
    if (!row?.last_message || row.last_message.direction !== 'inbound') return;
    const messageKey = `${row.id}:${row.last_message.at ?? row.last_message_at ?? ''}`;
    if (state.wa.seenMessages.has(messageKey)) return;
    state.wa.seenMessages.add(messageKey);
    toast(`Nuevo mensaje de ${waDisplayName(row)}`);
    playNewMessageSound();
  }

  /**
   * La barra de acciones de la selección. Vive en el sitio de la cabecera de la
   * lista, así que no hay dos barras compitiendo y el gesto es el de WhatsApp:
   * se eligen conversaciones y las acciones aparecen arriba.
   */
  function waBulkBar() {
    const count = state.wa.selected.size;
    if (!count) return '';
    const archived = state.wa.filter === 'archivados';
    const visibles = waVisibleConversations().length;
    const todas = visibles > 0 && count >= visibles;
    return `<div class="wa-bulk" role="toolbar" aria-label="Acciones de las conversaciones seleccionadas">
      <button class="wa-bulk__x" data-wa-sel-clear="1" type="button" aria-label="Cancelar la selección"><span aria-hidden="true">✕</span></button>
      <span class="wa-bulk__count">${count} seleccionada${count === 1 ? '' : 's'}</span>
      <button class="wa-bulk__btn" data-wa-sel-all="1" type="button" title="${
        todas ? 'Quitar la selección' : 'Seleccionar todas'
      }" aria-label="${todas ? 'Quitar la selección' : 'Seleccionar todas'}">${ICONS.users}</button>
      <button class="wa-bulk__btn" data-wa-bulk="mark_read" type="button" title="Marcar como leídas" aria-label="Marcar como leídas">${ICONS.check}</button>
      <button class="wa-bulk__btn" data-wa-bulk="${archived ? 'unarchive' : 'archive'}" type="button" title="${
        archived ? 'Desarchivar' : 'Archivar'
      }" aria-label="${archived ? 'Desarchivar' : 'Archivar'}">${ICONS.box}</button>
      <button class="wa-bulk__btn" data-wa-bulk="message_preview" type="button" title="Mensaje a varios" aria-label="Mensaje a varios">${ICONS.send}</button>
    </div>`;
  }

  /** Selecciona o quita una conversación (una sola vía, la use quien la use). */
  function toggleWaSelect(conversationId) {
    if (state.wa.selected.has(conversationId)) state.wa.selected.delete(conversationId);
    else state.wa.selected.add(conversationId);
    renderWaList();
  }

  /**
   * Mientras hay selección, la cabecera (buscador y filtros) se retira y su
   * sitio lo ocupa la barra de acciones. Se hace en un solo sitio, para que
   * cualquier camino que repinte la lista deje la pantalla coherente.
   */
  function renderWaSelectionUi() {
    const seleccionando = state.wa.selected.size > 0;
    const barra = $('#wa-sel');
    if (barra) {
      barra.hidden = !seleccionando;
      barra.innerHTML = seleccionando ? waBulkBar() : '';
    }
    const head = $('.wa__list-head');
    if (head) head.hidden = seleccionando;
    const chips = $('#wa-filters');
    if (chips) chips.hidden = seleccionando;
    const box = $('#wa-conversations');
    if (box) box.classList.toggle('wa__convs--sel', seleccionando);
  }

  /**
   * Acciones de UNA conversación sin tener que abrirla: es el «⋯» del final de la
   * fila. Solo se ofrecen cosas que existen de verdad (el mismo endpoint masivo,
   * con un solo id) y NINGUNA manda un mensaje por su cuenta.
   */
  function openConvMenu(conversationId) {
    const row = state.conversations.find((candidate) => candidate.id === conversationId);
    if (!row) return;
    const customerId = row.customer_id ?? '';
    const customer = customerId ? customerById(customerId) : null;
    const unread = Number(row.unread_count) || 0;
    const archived = Boolean(row.archived_at);
    const stages = state.customerStages.length
      ? state.customerStages
      : [
          { value: 'PROSPECT', label: 'Prospecto' },
          { value: 'INTERESTED', label: 'Interesado' },
          { value: 'CUSTOMER', label: 'Cliente' },
          { value: 'INACTIVE', label: 'Inactivo' },
        ];
    openSheet(
      customer ? customerName(customer) : waDisplayName(row),
      `<div class="menu-list">
        <button class="menu-item" data-conv-act="open" data-conv-id="${escapeHtml(conversationId)}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.chat}</span>
          <span><strong>Abrir conversación</strong></span>
        </button>
        ${assignmentMenuHtml(row, { conversationId })}
        ${
          customerId
            ? `<div class="menu-item menu-item--static">
                <span class="menu-item__icon" aria-hidden="true">${ICONS.person}</span>
                <span><strong>Etapa del cliente</strong><small>${escapeHtml(customerStageLabel(customerStageOf(row)))}</small></span>
              </div>
              ${stages
                .map(
                  (entry) => `<button class="menu-item" data-customer-stage="${escapeHtml(customerId)}" data-stage="${escapeHtml(
                    entry.value,
                  )}" type="button"><span></span><span>${escapeHtml(entry.label)}</span></button>`,
                )
                .join('')}
              <button class="menu-item" data-customer-tags="${escapeHtml(customerId)}" type="button">
                <span class="menu-item__icon" aria-hidden="true">${ICONS.tagIcon}</span>
                <span><strong>Etiquetas</strong><small>Administrar etiquetas</small></span>
              </button>
              <button class="menu-item" data-followup-new="${escapeHtml(customerId)}" data-conversation="${escapeHtml(
                conversationId,
              )}" type="button">
                <span class="menu-item__icon" aria-hidden="true">${ICONS.clock}</span>
                <span><strong>Seguimiento</strong><small>Crear/ver seguimiento</small></span>
              </button>`
            : ''
        }
        ${
          unread
            ? `<button class="menu-item" data-conv-act="mark_read" data-conv-id="${escapeHtml(conversationId)}" type="button">
                <span class="menu-item__icon" aria-hidden="true">${ICONS.checkCircle}</span>
                <span><strong>Marcar como leída</strong></span>
              </button>`
            : ''
        }
        <button class="menu-item" data-conv-act="${archived ? 'unarchive' : 'archive'}" data-conv-id="${escapeHtml(
          conversationId,
        )}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.box}</span>
          <span><strong>${archived ? 'Desarchivar' : 'Archivar'}</strong></span>
        </button>
        ${
          customerId
            ? `<button class="menu-item" data-scheduled-new="${escapeHtml(customerId)}" data-conversation="${escapeHtml(
                conversationId,
              )}" type="button">
                <span class="menu-item__icon" aria-hidden="true">${ICONS.send}</span>
                <span><strong>Programar mensaje</strong><small>Lo envía el sistema</small></span>
              </button>
              <button class="menu-item" data-customer="${escapeHtml(customerId)}" type="button">
                <span class="menu-item__icon" aria-hidden="true">${ICONS.person}</span>
                <span><strong>Abrir ficha</strong></span>
              </button>`
            : ''
        }
        <button class="menu-item" data-conv-act="select" data-conv-id="${escapeHtml(conversationId)}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.users}</span>
          <span><strong>Seleccionar varias</strong></span>
        </button>
      </div>`,
      { variant: 'menu' },
    );
  }

  /** Ejecuta una acción del menú «⋯» de una fila (nunca manda nada sola). */
  function runConvAction(action, conversationId) {
    closeSheet();
    if (action === 'open') {
      selectConversation(conversationId);
      return;
    }
    if (action === 'select') {
      if (!state.wa.selected.has(conversationId)) state.wa.selected.add(conversationId);
      renderWaList();
      return;
    }
    runWaBulk(action, [conversationId]);
  }

  async function changeCustomerStage(customerId, stage) {
    try {
      await api(`/api/admin/customers/${encodeURIComponent(customerId)}/stage`, {
        method: 'POST',
        body: JSON.stringify({ stage, reason: 'cambio desde panel' }),
      });
      closeSheet();
      toast('Etapa actualizada');
      await load({ keepTab: true });
      if (state.wa.selectedId) await selectConversation(state.wa.selectedId);
      if (state.customerProfile?.customer?.id === customerId) await openCustomer(customerId);
    } catch (error) {
      if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo cambiar la etapa');
    }
  }

  function openCustomerStageMenu(customerId) {
    const customer = customerById(customerId) ?? state.customerProfile?.customer ?? state.wa.chat?.customer ?? null;
    const stages = state.customerStages.length
      ? state.customerStages
      : [
          { value: 'PROSPECT', label: 'Prospecto' },
          { value: 'INTERESTED', label: 'Interesado' },
          { value: 'CUSTOMER', label: 'Cliente' },
          { value: 'INACTIVE', label: 'Inactivo' },
        ];
    openSheet(
      `Etapa · ${customer ? customerName(customer) : 'Cliente'}`,
      `<div class="menu-list">
        ${stages
          .map(
            (entry) => `<button class="menu-item" data-customer-stage="${escapeHtml(customerId)}" data-stage="${escapeHtml(
              entry.value,
            )}" type="button">
              <span class="menu-item__icon" aria-hidden="true">${entry.value === customerStageOf(customer) ? ICONS.check : ''}</span>
              <span><strong>${escapeHtml(entry.label)}</strong></span>
            </button>`,
          )
          .join('')}
      </div>`,
      { variant: 'menu' },
    );
  }

  async function openCustomerTags(customerId) {
    const customer = customerById(customerId) ?? state.customerProfile?.customer ?? state.wa.chat?.customer ?? null;
    try {
      const data = await api(`/api/admin/customers/${encodeURIComponent(customerId)}/tags`);
      const assigned = new Set((data.tags ?? []).map((tag) => tag.id));
      openSheet(
        `Etiquetas · ${customer ? customerName(customer) : 'Cliente'}`,
        `<div class="menu-list">
          ${(data.catalog ?? [])
            .map(
              (tag) => `<label class="menu-item">
                <span class="tag" style="border-color:${escapeHtml(tag.color ?? '#64748b')}">${escapeHtml(tag.label)}</span>
                <span><input type="checkbox" data-tag-toggle="${escapeHtml(tag.id)}" ${assigned.has(tag.id) ? 'checked' : ''} /></span>
              </label>`,
            )
            .join('')}
        </div>`,
        { variant: 'menu' },
      );
      $$('[data-tag-toggle]').forEach((input) => {
        input.addEventListener('change', async (event) => {
          const tagId = event.currentTarget.dataset.tagToggle;
          try {
            if (event.currentTarget.checked) {
              await api(`/api/admin/customers/${encodeURIComponent(customerId)}/tags`, {
                method: 'POST',
                body: JSON.stringify({ tagId }),
              });
            } else {
              await api(`/api/admin/customers/${encodeURIComponent(customerId)}/tags?tagId=${encodeURIComponent(tagId)}`, {
                method: 'DELETE',
              });
            }
            await load({ keepTab: true });
            if (state.customerProfile?.customer?.id === customerId) await openCustomer(customerId);
          } catch (error) {
            event.currentTarget.checked = !event.currentTarget.checked;
            if (error.message !== 'unauthorized') toast('No se pudo cambiar la etiqueta');
          }
        });
      });
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudieron cargar las etiquetas');
    }
  }

  function renderWaList() {
    const box = $('#wa-conversations');
    const error = $('#wa-error');
    if (!box || !error) return;

    // La barra de selección (si la hay) manda sobre la cabecera, siempre.
    renderWaSelectionUi();

    // Una caída del API NO puede parecer “no hay mensajes”.
    if (state.wa.listError) {
      error.hidden = false;
      error.innerHTML = `<span>No pudimos cargar las conversaciones.</span>
        <button class="btn btn--ghost btn--sm" id="wa-retry" type="button">Reintentar</button>`;
      box.innerHTML = '';
      return;
    }
    error.hidden = true;

    if (!state.conversations.length) {
      box.innerHTML = emptyState('Aún no hay conversaciones. Cuando un cliente escriba por WhatsApp, aparecerá aquí.');
      return;
    }
    const rows = waVisibleConversations();
    const empty = {
      'no-leidos': 'No tienes mensajes nuevos.',
      pendientes: 'No tienes mensajes pendientes.',
      clientes: 'Todavía no hay clientes con compra entregada en esta vista.',
      seguimiento: 'No hay seguimientos pendientes.',
      archivados: 'No hay conversaciones archivadas.',
    }[state.wa.filter] ?? 'No hay conversaciones con este filtro.';
    box.innerHTML = rows.length ? rows.map(waRow).join('') : emptyState(empty);
  }

  function openNewConversationSheet() {
    $('#sheet-title').textContent = 'Nuevo WhatsApp';
    $('#sheet-body').innerHTML = `
      <label class="field">
        <span class="field__label">Teléfono con WhatsApp</span>
        <input class="field__input" id="wa-start-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+1 809 555 1234" />
      </label>
      <label class="field">
        <span class="field__label">Nombre del cliente</span>
        <input class="field__input" id="wa-start-name" autocomplete="name" placeholder="Nombre opcional" />
      </label>
      <label class="field">
        <span class="field__label">Mensaje</span>
        <textarea class="field__area" id="wa-start-body" rows="4" placeholder="Hola, te escribo de ${NEGOCIO}..."></textarea>
      </label>
      <p class="rule">Se abrirá la conversación y el texto quedará listo para revisar. El envío se confirma desde el chat.</p>
      <button class="btn btn--whatsapp btn--block" id="wa-start-open" type="button">Abrir conversación</button>
    `;
    $('#sheet').hidden = false;
    $('#wa-start-phone')?.focus();
    $('#wa-start-open').addEventListener('click', async (event) => {
      const phone = $('#wa-start-phone').value.trim();
      const name = $('#wa-start-name').value.trim();
      const body = $('#wa-start-body').value.trim();
      if (!phone || digits(phone).length < 7) {
        toast('Escribe un teléfono válido');
        return;
      }
      await working(event.currentTarget, 'Abriendo...', async () => {
        try {
          const result = await api('/api/admin/conversations/start', {
            method: 'POST',
            body: JSON.stringify({ phone, name, body }),
          });
          closeSheet();
          await refreshWhatsapp();
          const conversationId = result.conversation?.id;
          if (!conversationId) {
            toast('No se pudo abrir la conversación');
            return;
          }
          await selectConversation(conversationId, { draft: body });
          toast(result.created ? 'Cliente creado' : 'Conversación abierta');
        } catch (error) {
          if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo abrir');
        }
      });
    });
  }

  function setWaDateFilter(mode, patch = {}) {
    const next = { mode, from: '', to: '', ...patch };
    if (next.mode === 'custom') {
      if (!next.from || !next.to) {
        toast('Elige desde y hasta');
        return false;
      }
      if (next.from > next.to) {
        toast('Desde no puede ser mayor que hasta');
        return false;
      }
    }
    state.wa.date = next;
    state.wa.selected.clear();
    state.wa.listSig = null;
    refreshWhatsapp().catch(() => renderWaList());
    renderMobileHeader();
    renderWhatsapp();
    return true;
  }

  function openWaDateMenu() {
    const active = waDateRange();
    const fixedButtons = WA_DATE_FILTERS.slice(0, 3).map(([mode, label]) => {
      return `<button class="menu-item" data-wa-date="${mode}" type="button">
        <span class="menu-item__icon" aria-hidden="true">${active.mode === mode ? ICONS.check : ''}</span>
        <span><strong>${label}</strong></span>
      </button>`;
    }).join('');
    const recentButtons = [2, 3, 4, 5].map((offset) => {
      const day = addDaysToISO(todayISO(), -offset);
      const label = shortWeekday(new Date(`${day}T12:00:00`));
      const selected = active.mode === 'custom' && active.from === day && active.to === day;
      return `<button class="menu-item" data-wa-date-day="${day}" type="button">
        <span class="menu-item__icon" aria-hidden="true">${selected ? ICONS.check : ''}</span>
        <span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(formatShortDate(day))}</small></span>
      </button>`;
    }).join('');
    const rangeButtons = WA_DATE_FILTERS.slice(3).map(([mode, label]) => {
      if (mode === 'custom') {
        return `<button class="menu-item" data-wa-date-custom="1" type="button">
          <span class="menu-item__icon" aria-hidden="true">${active.mode === mode ? ICONS.check : ICONS.clock}</span>
          <span><strong>${label}</strong><small>Elegir desde y hasta</small></span>
        </button>`;
      }
      return `<button class="menu-item" data-wa-date="${mode}" type="button">
        <span class="menu-item__icon" aria-hidden="true">${active.mode === mode ? ICONS.check : ''}</span>
        <span><strong>${label}</strong></span>
      </button>`;
    }).join('');
    const buttons = `${fixedButtons}${recentButtons}${rangeButtons}`;
    openSheet('Filtrar por fecha', `<div class="menu-list">${buttons}</div>`, { variant: 'menu' });
  }

  function openWaCustomDateSheet() {
    const current = waDateRange({ mode: 'custom', from: state.wa.date?.from, to: state.wa.date?.to });
    $('#sheet-title').textContent = 'Rango de conversaciones';
    $('#sheet-body').innerHTML = `
      <label class="field">
        <span class="field__label">Desde</span>
        <input class="field__input" id="wa-date-from" type="date" value="${escapeHtml(current.from || todayISO())}" />
      </label>
      <label class="field">
        <span class="field__label">Hasta</span>
        <input class="field__input" id="wa-date-to" type="date" value="${escapeHtml(current.to || todayISO())}" />
      </label>
      <p class="rule">El filtro usa la fecha del último mensaje en ${BUSINESS_TIME_ZONE}.</p>
      <button class="btn btn--primary btn--block" id="wa-date-apply" type="button">Aplicar rango</button>
    `;
    $('#sheet').hidden = false;
    $('#wa-date-apply')?.addEventListener('click', () => {
      const from = $('#wa-date-from')?.value ?? '';
      const to = $('#wa-date-to')?.value ?? '';
      if (setWaDateFilter('custom', { from, to })) closeSheet();
    });
  }

  /**
   * El compositor. Respeta la regla de las 24 h que aplica el servidor: dentro
   * de la ventana se escribe libre; fuera, solo plantillas APROBADAS de verdad.
   */
  function waContactStateHtml(contactState, customer, lastTemplate = null) {
    const name = (customer?.name ?? '').trim() || customer?.phone_e164 || 'el cliente';
    /*
     * «Enviado» NO es «entregado»: WhatsApp devuelve `sent` en cuanto acepta el
     * mensaje, y solo confirma la entrega con `delivered`/`read`. El estado lo
     * dice tal cual para que nadie dé por hecho que el cliente lo recibió.
     */
    const entregada = ['delivered', 'read'].includes(String(lastTemplate?.status ?? '').toLowerCase());
    const motivoFallo = waFriendlyTemplateError(lastTemplate);
    const codeFallo = lastTemplate?.error_code ? ` · #${lastTemplate.error_code}` : '';
    const copy = {
      [CONTACT_STATE.NEW_CONTACT]: {
        title: 'Iniciar conversación',
        body: 'Para contactar a este cliente por primera vez, envía una plantilla aprobada.',
        detail: 'Usa una plantilla aprobada para enviar el primer mensaje.',
        cta: 'Enviar plantilla',
        tone: 'info',
      },
      [CONTACT_STATE.WAITING_CUSTOMER_REPLY]: {
        title: entregada ? 'Plantilla entregada' : 'Plantilla enviada · sin confirmar',
        body: `Esperando respuesta de ${name} para continuar la conversación.`,
        detail: entregada
          ? 'Cuando el cliente responda, podrás escribir mensajes normales durante la ventana de atención.'
          : 'WhatsApp todavía no confirma la entrega. Si el cliente no responde, comprueba que su número tenga WhatsApp.',
        cta: 'Enviar otra plantilla',
        tone: entregada ? 'ok' : 'info',
      },
      [CONTACT_STATE.TEMPLATE_FAILED]: {
        title: 'La plantilla no se entregó',
        body: `WhatsApp rechazó el último envío a ${name}.`,
        detail: `${motivoFallo}${codeFallo}`,
        cta: 'Intentar otra vez',
        tone: 'warn',
      },
      [CONTACT_STATE.CLOSED_WINDOW]: {
        title: 'Ventana de atención finalizada',
        body: 'La ventana de atención de 24 horas terminó.',
        detail: 'Para volver a contactar al cliente, envía una plantilla aprobada.',
        cta: 'Enviar plantilla',
        tone: 'warn',
      },
      [CONTACT_STATE.OPEN_WINDOW]: {
        title: 'Conversación activa',
        body: 'Puedes escribir mensajes normales mientras la ventana de atención esté activa.',
        detail: '',
        cta: '',
        tone: 'ok',
      },
    }[contactState];
    if (!copy || contactState === CONTACT_STATE.OPEN_WINDOW) return '';
    return `<section class="wa-state wa-state--${escapeHtml(copy.tone)}" data-wa-contact-state="${escapeHtml(contactState)}">
      <div>
        <strong>${escapeHtml(copy.title)}</strong>
        <p>${escapeHtml(copy.body)}</p>
        ${copy.detail ? `<small>${escapeHtml(copy.detail)}</small>` : ''}
      </div>
      <button class="btn btn--whatsapp btn--sm" id="wa-open-template" type="button">${escapeHtml(copy.cta)}</button>
    </section>`;
  }

  /**
   * Pedido con el que el CRM completa una plantilla: el de ESTA conversación y,
   * si no hay, el último del cliente. Es el mismo criterio que usa el servidor.
   */
  function orderForConversation(customerId, conversationId = null) {
    const orders = (state.items ?? []).filter((item) => item.type === 'order_intent');
    const delCliente = orders.filter(
      (item) =>
        (conversationId && item.conversation_id === conversationId) ||
        (customerId && item.customer_id === customerId),
    );
    const deLaConversacion = conversationId
      ? delCliente.filter((item) => item.conversation_id === conversationId)
      : [];
    const pool = deLaConversacion.length ? deLaConversacion : delCliente;
    return ordersNewestFirst(pool)[0] ?? null;
  }

  /** Número de pedido tal como lo conoce el CRM (nunca inventado). */
  function orderNumberOf(item) {
    if (!item) return '';
    const order = itemOrder(item) ?? {};
    return String(order.order_number ?? item.order_number ?? order.id ?? item.id ?? '').trim();
  }

  /**
   * Texto que el CRM ya sabe poner en cada hueco de una plantilla.
   *
   * El número de pedido sale SOLO del pedido real de esta conversación (o del
   * último del cliente): nadie tiene que saberse el número de la factura.
   */
  function waTemplateAutoValues(customer, conversationId = null) {
    const nombre = (customer?.name ?? '').trim() || customer?.phone_e164 || 'cliente';
    const order = orderForConversation(customer?.id ?? null, conversationId);
    return {
      customer_name: nombre,
      nombre,
      phone: customer?.phone_e164 ?? '',
      order_number: orderNumberOf(order),
      // El total y la forma de pago salen del MISMO pedido: así la plantilla de
      // confirmación llega completa y sin que nadie tenga que copiar cifras.
      total: order ? orderTotalOf(order) : '',
      payment_method: order ? paymentMethodLabel(orderPaymentMethodOf(order)) : '',
    };
  }

  /**
   * Huecos de una plantilla (`{{1}}`, `{{2}}`…), alineados con el cuerpo REAL que
   * hay en Meta. Es el mismo criterio que usa el servidor para enviarla.
   */
  function waTemplateHuecos(template) {
    const declaradas = Array.isArray(template?.variables)
      ? template.variables.map((row) => String(row ?? '').trim())
      : [];
    const huecos = (String(template?.body ?? '').match(/\{\{\s*\d+\s*\}\}/g) ?? []).length;
    return Array.from({ length: huecos }, (_, index) => declaradas[index] || `param_${index + 1}`);
  }

  const WA_VAR_LABELS = {
    customer_name: 'Nombre del cliente',
    nombre: 'Nombre del cliente',
    mensaje: 'Tu mensaje',
    texto: 'Tu mensaje',
    order_number: 'Nº de pedido',
    total: 'Total',
    payment_method: 'Forma de pago',
    delivery_display_name: 'Delivery',
  };
  const waVariableLabel = (key, index) => WA_VAR_LABELS[key] ?? `Texto {{${index + 1}}}`;
  const waVariablePlaceholder = (key) => (WA_VAR_LABELS[key] ? '' : 'Escribe aquí lo que quieras decir…');
  /*
   * HUECO LIBRE de una plantilla.
   *
   * Fuera de la ventana de 24 h WhatsApp solo admite plantillas aprobadas y su
   * texto fijo NO se puede cambiar; sus huecos, sí. Escribiendo en el hueco que
   * el CRM declara libre (`variables: ['customer_name', 'mensaje']`), el mensaje
   * sale con las palabras del operador.
   */
  const WA_FREE_VAR_KEYS = ['mensaje', 'texto', 'mensaje_libre', 'libre', 'personalizado'];
  /** Plantilla aprobada con la que se pide la ubicación al cliente. */
  const LOCATION_TEMPLATE = 'phyto_ubicacion_entrega_v1';
  /** Plantilla con la que se le pide al cliente confirmar SU pedido. */
  const ORDER_CONFIRM_TEMPLATE = 'phyto_confirmacion_pedido_v1';
  function waTemplateFreeSlot(template) {
    const index = waTemplateHuecos(template).findIndex((key) =>
      WA_FREE_VAR_KEYS.includes(String(key ?? '').trim().toLowerCase()),
    );
    return index === -1 ? null : index;
  }
  /** Plantilla aprobada que admite un mensaje escrito a mano (la de «hello world»). */
  function waPersonalTemplate() {
    return (
      (state.templates ?? []).filter(waTemplateApproved).find((template) => waTemplateFreeSlot(template) !== null) ?? null
    );
  }

  /** Cómo queda el mensaje con los huecos ya rellenos: lo que se va a enviar. */
  function waRenderTemplatePreview(template, values) {
    let texto = String(template?.body ?? '');
    waTemplateHuecos(template).forEach((key, index) => {
      const valor = String(values[index] ?? '').trim();
      // Un hueco vacío se ve COMO hueco (con lo que falta), no como un `{{2}}`
      // que parece un error: si el CRM no lo sabe, hay que escribirlo.
      const relleno = valor || `⟨falta ${waVariableLabel(key, index)}⟩`;
      texto = texto.replace(new RegExp(`\\{\\{\\s*${index + 1}\\s*\\}\\}`, 'g'), relleno);
    });
    return texto;
  }

  function waTemplateSheetHtml(prefill = {}) {
    const approved = (state.templates ?? []).filter(waTemplateApproved);
    if (!approved.length) {
      return `<p class="rule rule--warn">No hay plantillas aprobadas sincronizadas.</p>
        <p class="view__hint">Ve a Ajustes > WhatsApp y pulsa Sincronizar con Meta.</p>`;
    }
    const elegida = approved.find((template) => template.name === prefill.templateName) ?? approved[0];
    return `<label class="field">
        <span class="field__label">Plantilla aprobada</span>
        <select class="field__select" id="wa-template">
          ${approved
            .map(
              (template) =>
                `<option value="${escapeHtml(template.name)}"${template.name === elegida.name ? ' selected' : ''}>${escapeHtml(
                  waTemplateLabel(template),
                )}</option>`,
            )
            .join('')}
        </select>
      </label>
      <div id="wa-template-fields"></div>
      <label class="field">
        <span class="field__label">Mensaje que se enviará</span>
        <p class="wa-template-preview" id="wa-template-preview"></p>
      </label>
      <button class="btn btn--whatsapp btn--block" id="wa-send-template" type="button">Enviar plantilla</button>
      <p class="rule">Para escribir a alguien por primera vez WhatsApp solo admite una plantilla aprobada: el texto fijo no se puede cambiar, pero los huecos sí. El número del pedido se pone solo con el pedido de esta conversación.</p>`;
  }

  /**
   * Rellena los huecos de la plantilla elegida: los que el CRM ya conoce (el nombre
   * del cliente) vienen puestos y se pueden corregir, y los demás se escriben aquí.
   * Así el operador pone SU mensaje dentro de la plantilla, que es lo único que
   * WhatsApp permite fuera de la ventana de 24 h.
   */
  function renderWaTemplateFields(prefill = {}) {
    const fields = $('#wa-template-fields');
    if (!fields) return;
    const template = (state.templates ?? []).find((row) => row.name === $('#wa-template')?.value) ?? null;
    const auto = waTemplateAutoValues(state.wa.chat?.customer ?? null, state.wa.selectedId ?? null);
    const huecos = waTemplateHuecos(template);
    const libre = waTemplateFreeSlot(template);
    const pidePedido = huecos.some((key) => String(key ?? '').trim().toLowerCase() === 'order_number');
    const sinPedido = pidePedido && !auto.order_number;
    state.wa.templateValues = {};
    fields.innerHTML = huecos.length
      ? huecos
          .map((key, index) => {
            // El hueco libre arranca con lo que se escribió en el compositor.
            const esLibre = index === libre;
            const valor = esLibre && prefill.freeText ? prefill.freeText : (auto[key] ?? '');
            return `<label class="field">
        <span class="field__label">${escapeHtml(waVariableLabel(key, index))}${esLibre ? ' · lo escribes tú' : ''}</span>
        <input class="field__input" type="text" data-wa-var="${index + 1}" value="${escapeHtml(valor)}"
          placeholder="${escapeHtml(esLibre ? 'Escribe aquí lo que quieras decirle…' : waVariablePlaceholder(key))}" />
      </label>`;
          })
          .join('')
      : '<p class="rule">Esta plantilla no tiene huecos: se envía tal cual está.</p>';
    if (sinPedido) {
      // Simple y honesto: si no hay pedido, se dice qué falta y cómo resolverlo.
      fields.insertAdjacentHTML(
        'beforeend',
        '<p class="rule rule--warn">Este cliente todavía no tiene pedidos y esta plantilla nombra su número. Crea el pedido (⋯ → Crear pedido) o escribe un número para enviarla.</p>',
      );
    }
    const recoger = () => {
      const values = {};
      for (const input of $$('#wa-template-fields [data-wa-var]')) {
        values[Number(input.dataset.waVar) - 1] = input.value.trim();
      }
      state.wa.templateValues = values;
      return values;
    };
    const pintar = () => {
      const preview = $('#wa-template-preview');
      if (preview) preview.textContent = waRenderTemplatePreview(template, recoger());
    };
    $$('#wa-template-fields [data-wa-var]').forEach((input) => input.addEventListener('input', pintar));
    pintar();
    // Si el texto venía del compositor, el cursor ya está donde hay que escribir.
    if (prefill.freeText && libre !== null) $$('#wa-template-fields [data-wa-var]')[libre]?.focus();
  }

  /**
   * Hoja de envío de plantilla.
   *
   * Si en el compositor había un mensaje escrito, se lleva DIRECTO al hueco libre
   * de la plantilla que lo admite: escribir y usar plantilla pasan a ser un solo
   * gesto (escribir → Enviar → Enviar plantilla), en vez de tener que copiar el
   * texto a mano en un hueco.
   */
  async function openWaTemplateSheet(options = {}) {
    const borrador = String(state.wa.draft ?? '').trim();
    openSheet('Enviar plantilla', '<p class="view__hint">Cargando plantillas aprobadas…</p>');
    try {
      const result = await api('/api/admin/wa-templates?sync=stale');
      state.templates = result.templates ?? state.templates;
    } catch {
      /* Si falla la consulta, se usa la última lista conocida y la hoja lo explica. */
    }
    const aprobadas = (state.templates ?? []).filter(waTemplateApproved);
    const personal = waPersonalTemplate();
    const prefill = { freeText: borrador };
    if (options.templateName) {
      // Se pidió una plantilla concreta (p. ej. «Solicitar ubicación»).
      prefill.templateName = options.templateName;
      if (!aprobadas.some((template) => template.name === options.templateName)) {
        prefill.nota = `La plantilla «${options.templateName}» no está aprobada o no está sincronizada: elige otra o pulsa Sincronizar con Meta en Ajustes.`;
      }
    } else if (borrador && personal) {
      prefill.templateName = personal.name;
    }
    if (borrador && !personal && !options.templateName) {
      prefill.nota =
        'Ninguna plantilla aprobada admite texto propio ahora mismo: elige una plantilla y rellena sus huecos a mano.';
    }
    $('#sheet-body').innerHTML = waTemplateSheetHtml(prefill);
    if (prefill.nota) $('#sheet-body').insertAdjacentHTML('afterbegin', `<p class="rule rule--warn">${escapeHtml(prefill.nota)}</p>`);
    renderWaTemplateFields(prefill);
    // Al cambiar de plantilla se mantiene el texto que se había escrito: es lo que
    // la persona quiere decir, y solo cambia la plantilla que lo transporta.
    $('#wa-template')?.addEventListener('change', () => renderWaTemplateFields({ freeText: borrador }));
    $('#wa-send-template')?.addEventListener('click', async (event) => {
      // Solo viajan los huecos RELLENOS: el resto los completa el servidor como
      // siempre (nombre del cliente, datos del pedido).
      const values = state.wa.templateValues ?? {};
      const templateValues = {};
      for (const [index, value] of Object.entries(values)) {
        if (String(value ?? '').trim()) templateValues[Number(index) + 1] = String(value).trim();
      }
      const sent = await sendWaMessage({ template: $('#wa-template')?.value || null, templateValues }, event.currentTarget);
      if (sent) closeSheet();
    });
  }

  /**
   * PEDIR LA UBICACIÓN desde el chat.
   *
   * WhatsApp solo deja texto libre dentro de la ventana de 24 h; para pedirla
   * siempre se usa la plantilla aprobada «Solicitar ubicación», que se abre ya
   * elegida (el nombre del cliente y el número de pedido los pone el CRM).
   */
  function askForLocation() {
    return openWaTemplateSheet({ templateName: LOCATION_TEMPLATE });
  }

  /**
   * Compositor de la VENTANA CERRADA (primer contacto y >24 h).
   *
   * Se escribe igual que en una conversación normal; al pulsar enviar, el texto
   * viaja al hueco libre de la plantilla aprobada y se ve el mensaje final antes
   * de mandarlo. Sin adjuntos: WhatsApp tampoco los admite fuera de la ventana.
   */
  function waClosedComposerHtml() {
    const personal = waPersonalTemplate();
    const aviso = personal
      ? `Lo que escribas se envía dentro de la plantilla «${escapeHtml(waTemplateLabel(personal))}».`
      : 'Fuera de la ventana de 24 h WhatsApp solo admite plantillas aprobadas: elige una para poder escribir.';
    return `<div class="composer-bar">
        <textarea id="wa-text" rows="1" placeholder="Escribe lo que quieras decirle…"
          aria-label="Mensaje que se enviará dentro de la plantilla"></textarea>
        <span class="composer-end">
          <button class="composer-btn composer-btn--send" id="wa-send" type="button"
            aria-label="Enviar con plantilla">${ICONS.send}</button>
        </span>
      </div>
      <p class="composer-rule">${aviso} Nada se envía solo.</p>`;
  }

  function waComposerHtml({ customer, canSendFreeText, contactState, lastTemplate = null }) {
    const wa = state.whatsapp ?? {};
    if (!wa.configured) {
      return '<p class="rule rule--warn">WhatsApp no está configurado en el servidor: se reciben mensajes, pero no se pueden enviar.</p>';
    }
    if (customer?.do_not_contact) {
      return '<p class="rule rule--warn">Este cliente pidió no recibir mensajes. Reactívalo solo si te lo pide él.</p>';
    }
    if (!canSendFreeText) {
      // El aviso dice POR QUÉ no se escribe libre, y debajo sigue habiendo dónde
      // escribir: el texto entra en el hueco libre de una plantilla aprobada.
      return `${waContactStateHtml(contactState, customer, lastTemplate)}${waClosedComposerHtml()}`;
    }
    const puedeAdjuntar = state.media?.enabled === true;
    const puedeGrabar = typeof window.MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
    /*
     * Un solo compositor: adjuntar · campo · (audio | enviar), todo dentro de la
     * misma superficie. El micro y el envío viven en la MISMA casilla, así que el
     * cambio de uno a otro no mueve nada de sitio.
     */
    return `<div class="composer-bar">
        <span class="composer-left">
          <button class="composer-btn" id="wa-attach" type="button" aria-label="Adjuntar imagen o audio"
            title="${
              puedeAdjuntar ? 'Adjuntar imagen o audio' : 'Adjuntar: la multimedia no está activa en el servidor'
            }">${ICONS.plus}</button>
          <button class="composer-btn" id="wa-template-open" type="button" aria-label="Enviar plantilla"
            title="Enviar una plantilla aprobada (puedes escribir sus huecos)">${ICONS.note}</button>
        </span>
        <textarea id="wa-text" rows="1" placeholder="Escribe un mensaje..." aria-label="Mensaje"></textarea>
        <span class="composer-end">
          <button class="composer-btn" id="wa-mic" type="button" aria-label="Grabar nota de voz"
            title="${
              puedeGrabar
                ? 'Grabar nota de voz'
                : 'Este navegador no permite grabar: usa + para adjuntar un audio'
            }">${puedeGrabar ? ICONS.mic : ICONS.audio}</button>
          <button class="composer-btn composer-btn--send" id="wa-send" type="button" aria-label="Enviar mensaje" hidden>${
            ICONS.send
          }</button>
        </span>
      </div>
      <p class="composer-rule">Enter envía · Shift+Enter salto de línea · Nada se envía solo.</p>`;
  }

  function renderWaChat() {
    const pane = $('#wa-chat-pane');
    const placeholder = $('#wa-placeholder');
    if (!pane || !placeholder) return;

    if (!state.wa.selectedId) {
      pane.hidden = true;
      placeholder.hidden = false;
      return;
    }
    pane.hidden = false;
    placeholder.hidden = true;

    const data = state.wa.chat;
    if (!data) {
      $('#wa-chat-name').textContent = 'Conversación';
      $('#wa-chat-meta').textContent = '';
      $('#thread').innerHTML = '<p class="view__hint">Cargando…</p>';
      $('#wa-composer').innerHTML = state.wa.threadError
        ? `<p class="rule rule--warn">No pudimos cargar esta conversación.</p>
           <button class="btn btn--ghost btn--block" id="wa-retry-thread" type="button">Reintentar</button>`
        : '';
      // Mientras no hay datos no se puede pedir ninguna acción comercial.
      const actionsLoading = $('#wa-actions');
      if (actionsLoading) actionsLoading.disabled = true;
      return;
    }

    const { customer, conversation, messages, canSendFreeText } = data;
    const contactState = getConversationContactState(data);
    $('#wa-chat-name').textContent = (customer?.name ?? '').trim() || customer?.phone_e164 || 'Conversación';
    const headerTags = customerTagsOf(customer).slice(0, 2).map((tag) => tag.label);
    $('#wa-chat-meta').textContent = [
      customer ? customerStageLabel(customerStageOf(customer)) : null,
      customer?.phone_e164,
      conversationAssignmentLabel(conversation),
      data.nextFollowup ? `Seguimiento ${fmtDay(data.nextFollowup.scheduled_at)}` : null,
      ...headerTags,
      conversation?.status === 'HUMAN_REQUIRED' ? 'Necesita una persona' : null,
      customer?.do_not_contact ? 'No contactar' : null,
    ]
      .filter(Boolean)
      .join(' · ');

    const viewCustomer = $('#wa-view-customer');
    if (viewCustomer) {
      viewCustomer.dataset.customer = customer?.id ?? '';
      viewCustomer.disabled = !customer?.id;
    }
    // El menú de acciones del chat (crear pedido, programar…) es una sola tecla
    // para no llenar el encabezado de botones en el móvil.
    const actions = $('#wa-actions');
    if (actions) {
      actions.dataset.customer = customer?.id ?? '';
      actions.dataset.conversation = conversation?.id ?? '';
      actions.disabled = !customer?.id;
      actions.setAttribute('aria-label', `Acciones de la conversación. ${conversationAssignmentLabel(conversation)}`);
    }

    const avatar = $('#wa-chat-avatar');
    if (avatar) {
      setAvatarContent(avatar, customer, (customer?.name ?? '').trim() || customer?.phone_e164);
      avatar.dataset.customer = customer?.id ?? '';
      avatar.disabled = !customer?.id;
      avatar.setAttribute(
        'aria-label',
        customer?.id ? `Ver perfil de ${((customer?.name ?? '').trim() || customer?.phone_e164 || 'cliente')}` : 'Perfil del cliente',
      );
    }

    const emptyThread =
      contactState === CONTACT_STATE.NEW_CONTACT
        ? '<div class="wa-empty"><strong>Todavía no has iniciado una conversación con este cliente.</strong><span>Usa una plantilla aprobada para enviar el primer mensaje.</span></div>'
        : '<p class="view__hint">Todavía no hay mensajes.</p>';
    $('#thread').innerHTML = messages.length ? waThreadHtml(messages) : emptyThread;

    $('#wa-composer').innerHTML = waComposerHtml({
      customer,
      canSendFreeText,
      contactState,
      lastTemplate: lastMessageWhere(
        messages,
        (message) => message?.direction === 'outbound' && isTemplateMessage(message),
      ),
    });
    const area = $('#wa-text');
    if (area) {
      area.value = state.wa.draft ?? '';
      const adjust = () => {
        area.style.height = 'auto';
        area.style.height = `${Math.min(area.scrollHeight, 132)}px`;
        // Sin texto: micrófono. Con texto: Enviar. (El envío nunca es automático.)
        const vacio = !area.value.trim();
        const mic = $('#wa-mic');
        const send = $('#wa-send');
        if (mic) mic.hidden = !vacio;
        if (send) send.hidden = vacio;
      };
      area.addEventListener('input', () => {
        state.wa.draft = area.value;
        adjust();
      });
      area.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          $('#wa-send')?.click();
        }
      });
      adjust();
    }
    /*
     * Abrir una conversación tiene que dejar a la vista lo ÚLTIMO. Las imágenes
     * entran con `loading="lazy"` y crecen cuando llegan, así que se vuelve al
     * final en el cuadro siguiente y cada vez que una imagen termina de cargar.
     */
    const thread = $('#thread');
    if (thread) {
      const irAlFinal = () => {
        thread.scrollTop = thread.scrollHeight;
      };
      irAlFinal();
      // `requestAnimationFrame` no existe en todos los entornos de prueba: si no
      // está, basta con el empujón de arriba.
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(irAlFinal);
      $$('img', thread).forEach((img) => img.addEventListener('load', irAlFinal, { once: true }));
    }

    $('#wa-send')?.addEventListener('click', (event) => {
      const body = ($('#wa-text')?.value ?? '').trim();
      if (!body) {
        toast('Escribe el mensaje');
        return;
      }
      /*
       * Fuera de la ventana de 24 h no existe el mensaje libre: lo escrito se
       * lleva al hueco libre de la plantilla y se revisa antes de enviar. Un solo
       * camino para «escribir» y «usar plantilla».
       */
      if (!canSendFreeText) {
        openWaTemplateSheet();
        return;
      }
      sendWaMessage({ body }, event.currentTarget);
    });
    $('#wa-open-template')?.addEventListener('click', () => openWaTemplateSheet());
  }

  // ------------------------------------------------------------- MULTIMEDIA
  /*
   * Imagen y audio, encima de la UI comercial (nada de esto cambia el menú ⋯ ni
   * el flujo de pedido). El archivo se pide SIEMPRE a `/api/admin/media/:id` con
   * la sesión del panel: el bucket es privado y el navegador nunca ve su
   * dirección, ni la clave del objeto, ni ningún token.
   *
   * El compositor tiene TRES estados y ninguno envía solo:
   *   elegir archivo → PREVISUALIZAR → (cancelar | ENVIAR)
   *   grabar         → DETENER      → PREVISUALIZAR → (borrar/regrabar | ENVIAR)
   */

  const mediaUrl = (id) => `/api/admin/media/${encodeURIComponent(id)}`;
  const mediaReady = () => state.media?.enabled === true;

  /** Tipos que el almacén y Meta aceptan hoy (coincide con `server/storage.mjs`). */
  const AUDIO_MIME_OK = ['audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/amr', 'audio/opus'];
  const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';
  const AUDIO_ACCEPT = 'audio/ogg,audio/mp4,audio/mpeg,audio/aac,audio/amr,audio/webm,audio/*';

  const fmtSeconds = (value) => {
    const total = Math.max(0, Math.floor(Number(value) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };
  const fmtBytes = (value) => {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };
  const uploadKey = (kind) =>
    `m:${kind}:${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).slice(0, 40)}`;

  /**
   * Escapa un valor para usarlo en un selector. `CSS.escape` existe en todos los
   * navegadores modernos, pero no en cualquier entorno: si falta, se usa un escape
   * mínimo equivalente para los identificadores que genera el CRM (letras, números,
   * guion y dos puntos).
   */
  const cssEscape = (value) => {
    const raw = String(value ?? '');
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(raw);
    return raw.replace(/[^A-Za-z0-9_-]/g, (character) => `\\${character}`);
  };

  /**
   * ¿Qué tipo puede grabar este navegador? Se pregunta de verdad con
   * `MediaRecorder.isTypeSupported` y se guarda lo que responde: no se supone
   * nada, porque grabar en un formato que Meta no acepta es prometer de más.
   */
  function detectSupportedRecordingType() {
    if (typeof window.MediaRecorder === 'undefined') return null;
    const candidates = [
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
      'audio/aac',
      'audio/webm;codecs=opus',
      'audio/webm',
    ];
    for (const candidate of candidates) {
      try {
        if (window.MediaRecorder.isTypeSupported?.(candidate)) return candidate;
      } catch {
        /* un navegador que lanza aquí no soporta: se sigue probando */
      }
    }
    return ''; // sin preferencia: el navegador decide (puede ser webm)
  }

  /** ¿Ese audio se puede enviar a WhatsApp hoy? (si no, se dice, no se finge) */
  const audioSendable = (mime) => AUDIO_MIME_OK.includes(String(mime ?? '').split(';')[0].trim());

  /**
   * Formatos que WhatsApp NO acepta tal cual pero que el SERVIDOR sabe convertir a
   * OGG/Opus antes de enviarlos (`server/audio-normalize.mjs`).
   *
   * Es el caso de Windows: el navegador graba en WebM, así que rechazarlo en el
   * panel era rechazar el audio de media plantilla. El servidor lo convierte.
   */
  const AUDIO_CONVERTIBLE = ['audio/webm', 'audio/wav', 'audio/x-wav'];
  const audioConvertible = (mime) =>
    AUDIO_CONVERTIBLE.includes(String(mime ?? '').split(';')[0].trim().toLowerCase());
  /** ¿Este servidor puede convertir? Lo dice `/api/admin/data` (`media.audioNormalize`). */
  const puedeConvertirAudio = () => state.media?.audioNormalize === true;

  // ------------------------------------------------- reproductor de audio
  /*
   * Un solo elemento de audio para toda la conversación: así, al reproducir otro,
   * el anterior se para (no suenan dos a la vez) y no hay autoplay: solo suena lo
   * que alguien pulsa.
   */
  let sharedAudio = null;
  let audioOwner = null;
  let audioBlocked = null;
  let ultimoAvisoAudio = 0;

  /**
   * El archivo no se pudo decodificar (descarga cortada, formato que el navegador
   * no entiende): el botón vuelve a «▶» en vez de quedarse en «❚❚» para siempre,
   * que haría creer que está sonando. Se avisa una sola vez por intento.
   */
  function audioNoReproducible() {
    audioBlocked = audioOwner;
    const row = audioOwner ? $(`[data-audio="${cssEscape(audioOwner)}"]`) : null;
    const play = row?.querySelector('[data-audio-play]');
    const current = row?.querySelector('[data-audio-current]');
    if (play) {
      play.textContent = '▶';
      play.setAttribute('aria-label', 'Reproducir');
    }
    if (current) current.textContent = '0:00';
    const ahora = Date.now();
    if (ahora - ultimoAvisoAudio > 1500) {
      ultimoAvisoAudio = ahora;
      toast('No se pudo reproducir el audio');
    }
  }

  function ensureAudio() {
    if (sharedAudio) return sharedAudio;
    sharedAudio = new Audio();
    sharedAudio.preload = 'metadata';
    sharedAudio.addEventListener('timeupdate', syncAudioPlayer);
    sharedAudio.addEventListener('loadedmetadata', () => {
      // El archivo SÍ se pudo leer: se levanta el bloqueo anterior.
      audioBlocked = null;
      syncAudioPlayer();
    });
    sharedAudio.addEventListener('pause', syncAudioPlayer);
    sharedAudio.addEventListener('play', syncAudioPlayer);
    sharedAudio.addEventListener('error', audioNoReproducible);
    sharedAudio.addEventListener('ended', () => {
      sharedAudio.currentTime = 0;
      syncAudioPlayer();
    });
    return sharedAudio;
  }

  function syncAudioPlayer() {
    const row = audioOwner ? $(`[data-audio="${cssEscape(audioOwner)}"]`) : null;
    if (!row || !sharedAudio) return;
    const seek = row.querySelector('[data-audio-seek]');
    const current = row.querySelector('[data-audio-current]');
    const total = row.querySelector('[data-audio-total]');
    const play = row.querySelector('[data-audio-play]');
    const duration = Number(sharedAudio.duration);
    if (current) current.textContent = fmtSeconds(sharedAudio.currentTime);
    if (total) total.textContent = Number.isFinite(duration) && duration > 0 ? fmtSeconds(duration) : '--:--';
    if (seek && Number.isFinite(duration) && duration > 0) {
      const avance = sharedAudio.currentTime / duration;
      seek.value = String(Math.round(avance * 1000));
      /* La barra se pinta con esta variable: el avance se ve sin repintar el hilo. */
      row.style.setProperty('--audio-progress', `${Math.round(avance * 100)}%`);
    }
    if (play) {
      // Sonando = de verdad suena: si el archivo no se pudo decodificar
      // (`error`), el botón NO puede quedarse en «pausar».
      const sonando = !sharedAudio.paused && !sharedAudio.error && audioBlocked !== audioOwner;
      play.textContent = sonando ? '❚❚' : '▶';
      play.setAttribute('aria-label', sonando ? 'Pausar' : 'Reproducir');
      row.classList.toggle('audio--playing', sonando);
    }
  }

  function toggleAudio(mediaId, src) {
    const audio = ensureAudio();
    if (audioOwner === mediaId && !audio.paused) {
      audio.pause();
      syncAudioPlayer();
      return;
    }
    if (audioOwner !== mediaId) {
      audioOwner = mediaId;
      audioBlocked = null;
      audio.src = src;
      audio.currentTime = 0;
    }
    audioBlocked = null; // si vuelve a fallar, el aviso y el «▶» vuelven solos
    audio.play().catch(() => {
      audio.pause?.();
      audioNoReproducible();
    });
    syncAudioPlayer();
  }

  function seekAudio(mediaId, ratio) {
    const audio = ensureAudio();
    if (audioOwner !== mediaId) return;
    const duration = Number(audio.duration);
    if (!Number.isFinite(duration) || duration <= 0) return;
    audio.currentTime = Math.min(duration, Math.max(0, duration * (Number(ratio) / 1000)));
    syncAudioPlayer();
  }

  // ------------------------------------------------------------- visor
  function openViewer(mediaId) {
    const viewer = $('#media-viewer');
    const image = $('#media-viewer-img');
    if (!viewer || !image) return;
    image.src = mediaUrl(mediaId);
    viewer.hidden = false;
  }

  function openImageViewer(src, alt = 'Imagen') {
    const viewer = $('#media-viewer');
    const image = $('#media-viewer-img');
    if (!viewer || !image || !src) return;
    image.src = src;
    image.alt = alt;
    viewer.hidden = false;
  }

  function closeViewer() {
    const viewer = $('#media-viewer');
    const image = $('#media-viewer-img');
    if (!viewer) return;
    viewer.hidden = true;
    if (image) {
      image.removeAttribute('src');
      image.alt = 'Imagen del cliente';
    }
  }

  // ------------------------------------------- subida desde el compositor
  /**
   * Manda los BYTES CRUDOS (sin multipart: el servidor decide el tipo mirando el
   * contenido, no la cabecera). La clave se genera AQUÍ y viaja en la petición:
   * repetir el envío con la misma clave no puede crear un segundo mensaje.
   */
  async function uploadMediaFile({ conversationId, kind, file, caption, key }) {
    const query = new URLSearchParams({ kind, key: key ?? uploadKey(kind) });
    if (caption) query.set('caption', caption);
    const response = await fetch(
      `/api/admin/conversations/${encodeURIComponent(conversationId)}/media?${query.toString()}`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': file.type || (kind === 'audio' ? 'audio/ogg' : 'image/png'),
          'x-phyto-filename': file.name || kind,
        },
        body: file,
      },
    );
    const raw = await response.text();
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      const error = new Error(body.message ?? 'No se pudo enviar el archivo');
      error.body = body;
      throw error;
    }
    return body;
  }

  /**
   * Cuando el envío queda AMBIGUO (pudo salir o no), desde el chat no se
   * reintenta NUNCA: se avisa, se cierra la hoja y se refrescan los datos para
   * que la cola de revisión de Ajustes esté al día (si no, el vendedor no vería
   * nada que revisar hasta la siguiente recarga).
   */
  async function avisoEnvioAmbiguo(error) {
    const ambiguo = error.body?.error === 'send_unknown';
    toast(
      ambiguo
        ? 'No se pudo confirmar si el mensaje salió. No se reintenta solo: míralo en Ajustes → «Envíos de archivo por revisar».'
        : error.body?.message ?? 'No se pudo enviar el archivo',
    );
    if (ambiguo) {
      closeSheet();
      await load({ keepTab: true });
    }
  }

  /** Elegir un archivo del teléfono y PREVISUALIZARLO (nunca se envía al elegir). */
  function openAttachSheet(conversationId) {
    if (!conversationId) return;
    /*
     * Una UBICACIÓN no necesita almacén de archivos: se puede enviar aunque la
     * multimedia esté apagada. El resto (imagen/audio) sí necesita R2.
     */
    const soloUbicacion = !mediaReady();
    openSheet(
      'Adjuntar',
      `
      ${
        soloUbicacion
          ? `<p class="rule rule--warn">La multimedia no está activa en el servidor: faltan las variables del
             almacén de archivos (R2) o las credenciales de WhatsApp. Los mensajes de texto y las ubicaciones siguen funcionando.</p>`
          : '<p class="view__hint">Nada se envía al elegir: primero lo ves y después lo mandas.</p>'
      }
      <div class="menu-list">
        ${
          soloUbicacion
            ? ''
            : `<button class="menu-item" id="attach-image" type="button">
                 <span class="menu-item__icon" aria-hidden="true">${ICONS.image}</span>
                 <span><strong>Imagen</strong><small>JPG, PNG o WebP · hasta 5 MB</small></span>
               </button>
               <button class="menu-item" id="attach-audio" type="button">
                 <span class="menu-item__icon" aria-hidden="true">${ICONS.audio}</span>
                 <span><strong>Audio</strong><small>Un archivo de audio · hasta 16 MB</small></span>
               </button>`
        }
        <button class="menu-item" id="attach-location" type="button">
          <span class="menu-item__icon" aria-hidden="true">📍</span>
          <span><strong>Ubicación</strong><small>Elegir, previsualizar y confirmar antes de enviar</small></span>
        </button>
      </div>
      <input id="attach-image-input" type="file" accept="${IMAGE_ACCEPT}" hidden />
      <input id="attach-audio-input" type="file" accept="${AUDIO_ACCEPT}" hidden />
      `,
      { variant: 'menu' },
    );

    $('#attach-location').addEventListener('click', () => {
      const customer = waCustomer(state.conversations.find((row) => row.id === conversationId) ?? {});
      closeSheet();
      openSendLocation({ conversationId, customerId: customer?.id ?? null });
    });

    if (soloUbicacion) return;

    const pick = (inputSelector, kind) => {
      const input = $(inputSelector);
      input.value = '';
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) openMediaPreview({ conversationId, kind, file });
      };
      input.click();
    };
    $('#attach-image').addEventListener('click', () => pick('#attach-image-input', 'image'));
    $('#attach-audio').addEventListener('click', () => pick('#attach-audio-input', 'audio'));
  }

  /** Previsualización de un archivo elegido, con ENVIAR explícito. */
  function openMediaPreview({ conversationId, kind, file, key, durationMs }) {
    const objectUrl = URL.createObjectURL(file);
    const mime = String(file.type || '').split(';')[0].trim();
    /*
     * ¿SE PUEDE ENVIAR? Lo decide el SERVIDOR, no el navegador.
     *
     * El servidor mira los BYTES (`sniffMime`) y es la única puerta de verdad; el
     * navegador, en cambio, muchas veces NO sabe qué tipo es un archivo: en
     * Windows un `.m4a` o un `.amr` llegan con `type` vacío. Bloquear aquí por lo
     * que dice el navegador dejaba al vendedor sin poder mandar un audio válido
     * (el botón se quedaba gris y no pasaba NADA al pulsarlo).
     *
     * Por eso solo se bloquea el caso que SÍ se conoce y no tiene arreglo posible
     * en el servidor: un WebM (lo que graba Windows) sin conversor instalado.
     * Todo lo demás se envía y, si no vale, el servidor lo dice con su mensaje.
     */
    const seConvierte = kind === 'audio' && audioConvertible(mime) && puedeConvertirAudio();
    const audioSinSalida = kind === 'audio' && audioConvertible(mime) && !puedeConvertirAudio();
    const puedeEnviar = !audioSinSalida;
    const aviso = audioSinSalida
      ? `<p class="rule rule--warn">Este audio está en <strong>${escapeHtml(mime)}</strong> y el servidor no tiene el
         conversor instalado (falta <strong>ffmpeg</strong>). Puedes oírlo aquí, pero para enviarlo adjunta un audio
         en <strong>M4A, MP3, AAC, AMR u OGG/Opus</strong> (esos no necesitan conversión).</p>`
      : seConvierte
        ? `<p class="view__hint">WhatsApp no acepta <strong>${escapeHtml(mime)}</strong>: se enviará convertido a
             <strong>OGG/Opus</strong> (voz, mono). No tienes que hacer nada.</p>`
        : kind === 'audio' && !mime
          ? `<p class="view__hint">El navegador no dice de qué tipo es este archivo: lo comprobará el servidor
               por su contenido al enviarlo (si no vale, te lo dirá sin enviar nada).</p>`
          : kind === 'image' && mime && !mime.startsWith('image/')
            ? `<p class="view__hint">El navegador dice <strong>${escapeHtml(mime)}</strong>: el servidor lo comprobará
                 por su contenido al enviarlo.</p>`
            : '';
    openSheet(
      kind === 'image' ? 'Enviar imagen' : 'Enviar audio',
      `
      <div class="attach-preview">
        ${
          kind === 'image'
            ? `<img src="${escapeHtml(objectUrl)}" alt="Previsualización" />`
            : `<audio src="${escapeHtml(objectUrl)}" controls preload="metadata"></audio>`
        }
        <p class="attach-preview__meta">
          <span>${escapeHtml(file.name || (kind === 'image' ? 'Imagen' : 'Audio'))}</span>
          <span>${escapeHtml(mime || 'tipo desconocido')} · ${fmtBytes(file.size)}${durationMs ? ` · ${fmtSeconds(durationMs / 1000)}` : ''}</span>
        </p>
      </div>
      ${aviso}
      ${
        kind === 'image'
          ? `<label class="field">
               <span class="field__label">Texto (opcional)</span>
               <input class="field__input" id="attach-caption" maxlength="400" placeholder="Mira, este es el frasco…" />
             </label>`
          : ''
      }
      <button class="btn btn--primary btn--block" id="attach-send" type="button" ${puedeEnviar ? '' : 'disabled'}>Enviar</button>
      <button class="btn btn--ghost btn--block" id="attach-cancel" type="button">Cancelar</button>
      `,
    );

    const cleanup = () => URL.revokeObjectURL(objectUrl);
    $('#attach-cancel').addEventListener('click', () => {
      cleanup();
      closeSheet();
    });
    $('#attach-send').addEventListener('click', async (event) => {
      await working(event.currentTarget, 'Enviando…', async () => {
        try {
          const caption = kind === 'image' ? ($('#attach-caption')?.value ?? '').trim() : '';
          await uploadMediaFile({ conversationId, kind, file, caption, key: key ?? uploadKey(kind) });
          cleanup();
          toast(kind === 'image' ? 'Imagen enviada' : 'Audio enviado');
          closeSheet();
          await load({ keepTab: true });
          await loadWaThread(conversationId, { force: true });
        } catch (error) {
          if (error.message !== 'unauthorized') {
            // Un envío AMBIGUO no se puede repetir desde aquí: se explica y se
            // resuelve en Ajustes (recuperación), nunca con un botón en el chat.
            await avisoEnvioAmbiguo(error);
          }
        }
      });
    });
  }

  /**
   * GRABAR una nota de voz: permiso → grabar (con contador) → DETENER →
   * PREVISUALIZAR → borrar/regrabar → ENVIAR. Nunca se envía al detener.
   */
  function openRecorder(conversationId) {
    if (!conversationId) return;
    const supportedType = detectSupportedRecordingType();
    if (!navigator.mediaDevices?.getUserMedia || supportedType === null) {
      openSheet(
        'Nota de voz',
        `<p class="rule rule--warn">Este navegador no permite grabar directamente. Puedes adjuntar un archivo
         de audio con el botón <strong>+</strong>.</p>
         <button class="btn btn--ghost btn--block" id="rec-attach" type="button">Adjuntar un audio</button>`,
      );
      $('#rec-attach').addEventListener('click', () => openAttachSheet(conversationId));
      return;
    }

    openSheet(
      'Nota de voz',
      `
      <p class="view__hint">Se graba con el micrófono del teléfono y <strong>no se envía hasta que tú lo mandes</strong>.</p>
      <div class="rec-status" id="rec-status"><span class="rec-dot" hidden></span><span id="rec-time">0:00</span></div>
      <div class="attach-preview" id="rec-preview" hidden></div>
      <button class="btn btn--primary btn--block" id="rec-start" type="button">Grabar</button>
      <button class="btn btn--danger btn--block" id="rec-stop" type="button" hidden>Detener</button>
      <button class="btn btn--ghost btn--block" id="rec-reset" type="button" hidden>Borrar y regrabar</button>
      <button class="btn btn--primary btn--block" id="rec-send" type="button" hidden>Enviar</button>
      <button class="btn btn--ghost btn--block" id="rec-attach" type="button">Adjuntar un audio en su lugar</button>
      `,
    );

    let recorder = null;
    let chunks = [];
    let blob = null;
    let objectUrl = null;
    let startedAt = 0;
    let timer = null;
    let stream = null;

    const preview = $('#rec-preview');
    const tick = () => {
      const seconds = (Date.now() - startedAt) / 1000;
      $('#rec-time').textContent = fmtSeconds(seconds);
      if (seconds >= 300) $('#rec-stop').click(); // tope de duración del audio
    };

    const reset = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      blob = null;
      preview.hidden = true;
      preview.innerHTML = '';
      $('#rec-time').textContent = '0:00';
      $('#rec-start').hidden = false;
      $('#rec-stop').hidden = true;
      $('#rec-reset').hidden = true;
      $('#rec-send').hidden = true;
      $('#rec-status').querySelector('.rec-dot').hidden = true;
    };

    const stopStream = () => {
      stream?.getTracks?.().forEach((track) => track.stop());
      stream = null;
    };

    $('#rec-start').addEventListener('click', async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        toast('No se pudo usar el micrófono (permiso denegado)');
        return;
      }
      chunks = [];
      // El tipo REAL lo dice el grabador; lo guardamos tal cual (sin suponer).
      recorder = new window.MediaRecorder(stream, supportedType ? { mimeType: supportedType } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunks.push(event.data);
      };
      recorder.onstop = () => {
        clearInterval(timer);
        const realType = recorder?.mimeType || chunks[0]?.type || supportedType || '';
        blob = new Blob(chunks, { type: realType });
        objectUrl = URL.createObjectURL(blob);
        preview.hidden = false;
        preview.innerHTML = `
          <audio src="${escapeHtml(objectUrl)}" controls preload="metadata"></audio>
          <p class="attach-preview__meta"><span>Nota de voz</span>
          <span>${escapeHtml(realType || 'tipo desconocido')} · ${fmtBytes(blob.size)}</span></p>`;
        $('#rec-status').querySelector('.rec-dot').hidden = true;
        $('#rec-start').hidden = true;
        $('#rec-stop').hidden = true;
        $('#rec-reset').hidden = false;
        $('#rec-send').hidden = false;
        /*
         * Si el navegador grabó en un formato que WhatsApp no acepta, hay dos
         * verdades distintas y no se mezclan:
         *   · el servidor sabe convertirlo → se puede enviar, y se dice que se
         *     convierte a OGG/Opus;
         *   · no sabe → no se deja enviar y se explica qué adjuntar.
         * Prometer compatibilidad sin comprobarla no es aceptable en ningún caso.
         */
        const seConvierte = audioConvertible(realType) && puedeConvertirAudio();
        if (!audioSendable(realType) && !seConvierte) {
          // No se finge compatibilidad: si el servidor no sabe convertirlo, no se
          // puede mandar. Y se dice la causa REAL (falta el conversor), no se
          // culpa al formato a secas: así se arregla de verdad (instalar ffmpeg).
          $('#rec-send').disabled = true;
          preview.insertAdjacentHTML(
            'beforeend',
            audioConvertible(realType)
              ? `<p class="rule rule--warn">El servidor no tiene el conversor instalado (falta <strong>ffmpeg</strong>),
                 y este navegador graba en <strong>${escapeHtml(realType)}</strong>. Mientras no se instale, adjunta un
                 audio en <strong>M4A, MP3, AAC, AMR u OGG/Opus</strong> con «Adjuntar un audio en su lugar».</p>`
              : `<p class="rule rule--warn">Tu navegador grabó en <strong>${escapeHtml(realType || 'un formato desconocido')}</strong>,
                 que WhatsApp todavía no acepta. Puedes oírlo y borrarlo, o adjuntar un audio en OGG, M4A o MP3.</p>`,
          );
        } else {
          $('#rec-send').disabled = false;
          if (!audioSendable(realType)) {
            preview.insertAdjacentHTML(
              'beforeend',
              `<p class="view__hint">Grabado en <strong>${escapeHtml(realType)}</strong>: al enviarlo se convierte a
               <strong>OGG/Opus</strong>.</p>`,
            );
          }
        }
        stopStream();
      };
      recorder.start();
      startedAt = Date.now();
      timer = setInterval(tick, 200);
      $('#rec-time').textContent = '0:00';
      $('#rec-status').querySelector('.rec-dot').hidden = false;
      $('#rec-start').hidden = true;
      $('#rec-stop').hidden = false;
      $('#rec-reset').hidden = true;
      $('#rec-send').hidden = true;
    });

    $('#rec-stop').addEventListener('click', () => {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    });

    $('#rec-reset').addEventListener('click', () => {
      reset();
    });

    $('#rec-send').addEventListener('click', async (event) => {
      if (!blob) return;
      const file = new File([blob], `nota-de-voz.${(blob.type || '').includes('ogg') ? 'ogg' : 'audio'}`, {
        type: blob.type || 'audio/ogg',
      });
      await working(event.currentTarget, 'Enviando…', async () => {
        try {
          await uploadMediaFile({ conversationId, kind: 'audio', file, key: uploadKey('audio') });
          toast('Nota de voz enviada');
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          closeSheet();
          await load({ keepTab: true });
          await loadWaThread(conversationId, { force: true });
        } catch (error) {
          if (error.message !== 'unauthorized') await avisoEnvioAmbiguo(error);
        }
      });
    });

    $('#rec-attach').addEventListener('click', () => openAttachSheet(conversationId));
    closeSheetCleanup = () => {
      clearInterval(timer);
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      stopStream();
    };
  }

  /** Al cerrar la hoja: nada de micrófono abierto ni temporizadores vivos. */
  let closeSheetCleanup = null;

  /** Reintentar la descarga de un archivo que quedó en Failed (era de Meta). */
  async function retryMedia(mediaId) {
    try {
      await api(`/api/admin/media/retry/${encodeURIComponent(mediaId)}`, { method: 'POST' });
      toast('Reintentando la descarga…');
      await sleep(600);
      if (state.wa.selectedId) await loadWaThread(state.wa.selectedId, { force: true });
    } catch (error) {
      if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo reintentar');
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function setWaView(view) {
    const box = $('#wa');
    if (box) box.dataset.view = view;
    /* La hoja de estilos necesita saberlo para el modo "conversación a pantalla
     * completa" (ahí no hay menú flotante: se vuelve con ←). */
    document.body.dataset.waView = view;
  }

  /** Abre una conversación: carga el hilo y apaga la insignia de no leído. */
  async function selectConversation(conversationId, options = {}) {
    if (!conversationId) return;
    state.wa.selectedId = conversationId;
    state.wa.followupId = options.followupId ?? null;
    state.wa.chat = null;
    state.wa.chatSig = null;
    state.wa.threadError = false;
    state.wa.draft = options.draft ?? '';
    setWaView('chat');
    renderWhatsapp();
    await loadWaThread(conversationId, { force: true });
    /*
     * Se puede pedir que, al abrir el chat, quede abierta una plantilla concreta:
     * así «Solicitar ubicación» (por ejemplo desde el delivery) deja el aviso
     * listo para enviar sin tener que buscarlo.
     */
    if (options.openTemplate && state.wa.selectedId === conversationId) {
      await openWaTemplateSheet({ templateName: options.openTemplate });
    }
  }

  async function loadWaThread(conversationId, options = {}) {
    // Evita peticiones duplicadas de la misma conversación.
    if (!options.force && state.wa.loadingFor === conversationId) return;
    state.wa.loadingFor = conversationId;
    try {
      const [data, templates] = await Promise.all([
        api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/messages`),
        api('/api/admin/wa-templates?sync=stale').catch(() => ({ templates: state.templates ?? [] })),
      ]);
      if (state.wa.selectedId !== conversationId) return; // se cambió mientras cargaba
      state.templates = templates.templates ?? [];
      state.wa.chat = data;
      state.wa.chatSig = waThreadSig(data);
      state.wa.threadError = false;
      renderWaChat();
      if (Number(data.conversation?.unread_count) > 0) {
        // Leído ≠ contestado: apaga la insignia de no leído, no la de “sin responder”.
        const row = state.conversations.find((candidate) => candidate.id === conversationId);
        if (row) row.unread_count = 0;
        renderWaList();
        api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/read`, { method: 'POST' }).catch(() => {});
      }
    } catch (error) {
      if (error.message === 'unauthorized') return;
      state.wa.chat = null;
      state.wa.threadError = true;
      renderWaChat();
    } finally {
      state.wa.loadingFor = null;
    }
  }

  /** Envío MANUAL: solo se llama desde el botón Enviar. */
  async function sendWaMessage(payload, button) {
    const conversationId = state.wa.selectedId;
    if (!conversationId) return false;
    let ok = false;
    await working(button, 'Enviando…', async () => {
      try {
        await api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/messages`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        state.wa.draft = '';
        toast('Mensaje enviado');
        const followupId = state.wa.followupId;
        state.wa.followupId = null;
        await load({ keepTab: true });
        await loadWaThread(conversationId, { force: true });
        if (followupId) toast('Seguimiento marcado como hecho');
        ok = true;
      } catch (error) {
        if (error.message !== 'unauthorized') {
          if (error.body?.message_record) {
            await loadWaThread(conversationId, { force: true });
            if (payload.template && !$('#sheet')?.hidden) closeSheet();
          }
          // El servidor explica la regla (24 h, no contactar, plantilla sin aprobar).
          toast(error.body?.message ?? 'No se pudo enviar');
        }
      }
    });
    return ok;
  }

  /**
   * Acciones sobre una o varias conversaciones. `explicitIds` permite lanzarla
   * para UNA sola fila (el menú «⋯») sin tocar la selección que haya abierta.
   */
  async function runWaBulk(action, explicitIds = null) {
    const ids = explicitIds?.length ? [...explicitIds] : [...state.wa.selected];
    if (!ids.length) return;
    try {
      const result = await api('/api/admin/conversations/bulk', {
        method: 'POST',
        body: JSON.stringify({ action, ids }),
      });
      if (action === 'message_preview') {
        const blocked = result.results.filter((row) => row.reason === 'do_not_contact').length;
        const free = result.results.filter((row) => row.reason === 'free_text_24h').length;
        const template = result.results.filter((row) => row.reason === 'template_required').length;
        openSheet(
          'Mensaje a varios',
          `<dl class="facts">
            <div class="fact"><dt>Seleccionados</dt><dd>${result.selected}</dd></div>
            <div class="fact"><dt>Elegibles 24 h</dt><dd>${free}</dd></div>
            <div class="fact"><dt>Requieren plantilla</dt><dd>${template}</dd></div>
            <div class="fact"><dt>Excluidos no contactar</dt><dd>${blocked}</dd></div>
          </dl>
          <p class="rule">Esta vista solo valida destinatarios. No se envía nada desde aquí.</p>`,
        );
        return;
      }
      toast(`${result.processed} procesados${result.failed ? `, ${result.failed} fallaron` : ''}`);
      if (!explicitIds) state.wa.selected.clear();
      await refreshWhatsapp();
    } catch (error) {
      if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo completar la acción');
    }
  }

  /**
   * Refresco ligero (lo usa el botón ⟳ y el sondeo). Solo vuelve a pintar lo que
   * de verdad ha cambiado, para no borrar lo que una persona está escribiendo.
   */
  async function refreshWhatsapp() {
    const params = new URLSearchParams();
    params.set('filter', state.wa.filter);
    if (state.wa.q) params.set('q', state.wa.q);
    const dateRange = waDateRange();
    if (dateRange.mode !== 'all') {
      if (dateRange.from) params.set('from', dateRange.from);
      if (dateRange.to) params.set('to', dateRange.to);
    }
    const list = await api(`/api/admin/conversations?${params.toString()}`);
    if (!domAlive()) return; // la pestaña se cerró mientras respondía el CRM
    const rows = list.conversations ?? [];
    state.wa.counts = list.counts ?? state.wa.counts;
    const listSig = JSON.stringify(
      rows.map((row) => [
        row.id,
        row.unread_count,
        row.last_message_at,
        row.status,
        row.awaiting_reply === true,
        row.archived_at ?? '',
        row.has_purchase === true,
        row.next_followup?.scheduled_at ?? '',
      ]),
    );
    if (listSig !== state.wa.listSig) {
      const previousKeys = new Set(
        state.conversations.map((row) => `${row.id}:${row.last_message?.at ?? row.last_message_at ?? ''}`),
      );
      state.wa.listSig = listSig;
      state.conversations = rows;
      state.wa.listError = false;
      for (const row of rows) {
        const key = `${row.id}:${row.last_message?.at ?? row.last_message_at ?? ''}`;
        if (!previousKeys.has(key)) notifyNewInbound(row);
      }
      renderWhatsapp();
    } else {
      renderWaList();
    }

    const conversationId = state.wa.selectedId;
    if (!conversationId) return;
    const data = await api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/messages`);
    if (!domAlive()) return; // la pestaña se cerró mientras respondía el CRM
    if (state.wa.selectedId !== conversationId) return;
    const sig = waThreadSig(data);
    if (sig === state.wa.chatSig) return;
    state.wa.chatSig = sig;
    state.wa.chat = data;
    state.wa.threadError = false;
    renderWaChat();
  }

  let waPolling = false;

  /** Un solo temporizador para todo el panel: nada de timers huérfanos. */
  function waPollTick() {
    const panel = $('#app');
    // Sin panel (sesión cerrada, pestaña oculta o DOM ya destruido) no se sondea.
    if (!panel || panel.hidden) return;
    if (state.tab !== 'whatsapp') return; // fuera de la pestaña no se gasta red
    if (document.visibilityState !== 'visible') return; // ni con la app en segundo plano
    if (waPolling) return; // ni dos peticiones a la vez
    waPolling = true;
    refreshWhatsapp()
      .catch((error) => {
        if (error.message === 'unauthorized') return;
        if (!state.conversations.length) {
          state.wa.listError = true;
          renderWaList();
        }
      })
      .finally(() => {
        waPolling = false;
      });
  }

  /** Ficha 360 del cliente: compras, chat, seguimiento y consentimiento. */
  async function openCustomer(customerId) {
    if (!customerId) return;
    state.openId = null;
    state.chat = null;
    state.customerId = customerId;
    state.customerProfileOrderId = null;
    state.previousTab = state.tab === 'perfil-cliente' ? state.previousTab : state.tab;
    const customer = customerById(customerId) ?? (state.wa.chat?.customer?.id === customerId ? state.wa.chat.customer : null);
    state.customerProfile = customer ? { customer, totals: {}, purchases: [], followups: [], scheduled: [], loadingBasic: true } : null;
    state.customerProfileLoading = true;
    setTab('perfil-cliente');
    renderCustomerProfile();
    try {
      const profile = await api(`/api/admin/customers/${encodeURIComponent(customerId)}`);
      renderCustomer(profile);
    } catch (error) {
      if (error.message === 'unauthorized') return;
      state.customerProfileLoading = false;
      renderCustomerProfile('<p class="rule rule--warn">No se pudo cargar la ficha.</p>');
    }
  }

  function profileFact(label, value) {
    const content = value === null || value === undefined || value === '' ? '—' : value;
    return `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${content}</dd></div>`;
  }

  function customerProfileSection(title, html, className = '') {
    return `<section class="profile-card ${escapeHtml(className)}">
      <h3>${escapeHtml(title)}</h3>
      ${html}
    </section>`;
  }

  function renderCustomerProfile(errorHtml = '') {
    renderMobileHeader();
    const box = $('#customer-profile');
    if (!box) return;
    const profile = state.customerProfile;
    if (!profile?.customer) {
      box.innerHTML = errorHtml || '<p class="view__hint">Selecciona un cliente para ver su perfil.</p>';
      return;
    }
    const { customer } = profile;
    const purchases = profile.purchases ?? [];
    const followups = profile.followups ?? [];
    const scheduled = profile.scheduled ?? [];
    const totals = profile.totals ?? {};
    const conversation = profile.conversation ?? conversationForCustomer(customer.id);
    const lastMessage = conversation?.last_message;
    const commercial = profile.commercial_state ?? customer.commercial_state ?? 'NUEVO';
    const stage = profile.customerStage ?? customerStageOf(customer);
    const customerTags = customerTagsOf(profile).length ? customerTagsOf(profile) : customerTagsOf(customer);
    const phone = digits(customer.phone_e164 ?? customer.phone);
    const lastPurchase = purchases.find((row) => row.status === 'entregado') ?? purchases[0] ?? null;
    const selectedOrder = purchases.find((row) => row.id === state.customerProfileOrderId) ?? null;
    const photo = customerPhotoUrl(customer);
    const tags = [
      customerStageLabel(stage),
      customer.do_not_contact ? 'No contactar' : null,
      ...customerTags.slice(0, 3).map((tag) => tag.label),
    ].filter(Boolean);
    const estado = {
      AUTOMATIC: 'Automático',
      HUMAN_REQUIRED: 'Necesita una persona',
      HUMAN_ACTIVE: 'Hablando con el negocio',
      PAUSED: 'En pausa',
      CLOSED: 'Cerrado',
    }[customer.automation_state] ?? customer.automation_state ?? '—';

    const header = `<header class="profile-hero ${photo ? 'profile-hero--photo' : 'profile-hero--fallback'}" ${
      photo ? `style="--profile-photo:url('${escapeHtml(photo)}')"` : ''
    }>
      <button class="profile-hero__media" ${
        photo ? `data-profile-photo="${escapeHtml(photo)}"` : ''
      } type="button" aria-label="Ver foto de ${escapeHtml(customerName(customer))}" ${photo ? '' : 'disabled'}>
        ${photo ? '' : `<span>${escapeHtml(waInitials(customerName(customer)))}</span>`}
      </button>
      <div class="profile-hero__main">
        <h2>${escapeHtml(customerName(customer))}</h2>
        <p>${escapeHtml(customer.phone_e164 ?? customer.phone ?? 'Sin teléfono')}</p>
        <div class="profile-tags">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
        <div class="profile-photo-actions">
          <button class="btn btn--ghost btn--sm" id="customer-photo-pick" type="button">${photo ? 'Cambiar foto' : 'Poner foto'}</button>
          ${photo ? '<button class="btn btn--ghost btn--sm" id="customer-photo-clear" type="button">Quitar foto</button>' : ''}
        </div>
        ${photo ? '' : '<p class="profile-photo-hint">WhatsApp no entrega la foto de perfil de los contactos: si la pones aquí, se ve en la lista, en el chat y en la ficha.</p>'}
      </div>
      <input class="profile-photo-file" id="customer-photo-file" type="file" accept="image/png,image/jpeg,image/webp" />
    </header>`;

    const personal = customerProfileSection(
      'Información Personal',
      `<dl class="facts profile-facts">
        ${profileFact('Nombre', escapeHtml(customer.name ?? '—'))}
        ${profileFact('Teléfono', phone ? `<a href="tel:${escapeHtml(phone)}">${escapeHtml(customer.phone_e164 ?? customer.phone ?? phone)}</a>` : '—')}
        ${profileFact('WhatsApp', customer.phone_e164 ? `<a href="https://wa.me/${escapeHtml(digits(customer.phone_e164))}" target="_blank" rel="noopener noreferrer">${escapeHtml(customer.phone_e164)}</a>` : '—')}
        ${profileFact('Email', escapeHtml(customer.email ?? '—'))}
        ${profileFact('Documento/Cédula', escapeHtml(customer.document ?? customer.document_id ?? customer.cedula ?? '—'))}
        ${profileFact('Dirección', escapeHtml(customer.address ?? customer.direccion ?? '—'))}
        ${profileFact('Ciudad/Provincia', escapeHtml(customer.city ?? customer.province ?? customer.location ?? '—'))}
        ${profileFact('Creación', customer.created_at ? escapeHtml(fmtWhen(customer.created_at)) : '—')}
        ${profileFact('Última actualización', customer.updated_at ? escapeHtml(fmtWhen(customer.updated_at)) : '—')}
      </dl>`,
    );

    const stages = state.customerStages.length
      ? state.customerStages
      : [
          { value: 'PROSPECT', label: 'Prospecto' },
          { value: 'INTERESTED', label: 'Interesado' },
          { value: 'CUSTOMER', label: 'Cliente' },
          { value: 'INACTIVE', label: 'Inactivo' },
        ];

    const stageHtml = customerProfileSection(
      'Etapa del Cliente',
      `<label class="field profile-field">
        <span class="field__label">Etapa</span>
        <select class="field__select" id="customer-stage">
          ${stages
            .map(
              (value) =>
                `<option value="${escapeHtml(value.value)}" ${stage === value.value ? 'selected' : ''}>${escapeHtml(value.label)}</option>`,
            )
            .join('')}
        </select>
      </label>
      <dl class="facts profile-facts">
        ${profileFact('Etapa actual', escapeHtml(customerStageLabel(stage)))}
        ${profileFact('Origen de etapa', escapeHtml(customer.customer_stage_source ?? profile.customer_stage_source ?? 'automático'))}
        ${profileFact('Estado comercial legacy', escapeHtml(commercialLabel(commercial)))}
        ${profileFact('Origen', escapeHtml(customer.source ?? '—'))}
        ${profileFact('Campaña/origen', escapeHtml(customer.campaign ?? customer.utm_campaign ?? customer.origin_campaign ?? '—'))}
      </dl>`,
    );

    const tagsHtml = customerProfileSection(
      'Etiquetas',
      `${
        customerTags.length
          ? `<div class="profile-tags">${customerTags.map((tag) => `<span class="tag">${escapeHtml(tag.label)}</span>`).join('')}</div>`
          : '<p class="view__hint">Sin etiquetas.</p>'
      }
      <button class="btn btn--ghost btn--block" data-customer-tags="${escapeHtml(customer.id)}" type="button">Administrar etiquetas</button>`,
    );

    const commercialHtml = customerProfileSection(
      'Conversación',
      `<dl class="facts profile-facts">
        ${profileFact('Vendedor/asignado', escapeHtml(conversation?.assigned_display_name_snapshot ?? customer.assigned_display_name ?? 'Sin asignar'))}
        ${profileFact('Estado conversación', escapeHtml(estado))}
        ${profileFact('Última conversación', conversation?.updated_at ? escapeHtml(fmtWhen(conversation.updated_at)) : '—')}
        ${profileFact('Último mensaje', escapeHtml(lastMessage?.body ?? (lastMessage?.type ? WA_KIND_LABEL[lastMessage.type] : '—') ?? '—'))}
        ${profileFact('Mensajes no leídos', escapeHtml(String(conversation?.unread_count ?? 0)))}
      </dl>`,
    );

    const commercialSummary = customerProfileSection(
      'Información Comercial',
      `<dl class="facts profile-facts">
        ${profileFact('Interés principal', escapeHtml(customer.product_interest ?? customer.interest ?? lastPurchase?.variant_name ?? '—'))}
        ${profileFact('Última compra', totals.last_purchase_at ? escapeHtml(fmtWhen(totals.last_purchase_at)) : '—')}
        ${profileFact('Total comprado', money(totals.total_spent ?? 0))}
      </dl>`,
    );

    const historyHtml = customerProfileSection(
      'Historial',
      (profile.stageHistory ?? []).length
        ? `<div class="profile-history">${profile.stageHistory
            .map(
              (row) =>
                `<div><strong>${escapeHtml(customerStageLabel(row.to_stage))}</strong><span>${escapeHtml(
                  row.timestamp ? fmtWhen(row.timestamp) : 'Sin fecha',
                )} · ${escapeHtml(row.changed_by_display_name ?? 'Sistema')}${row.reason ? ` · ${escapeHtml(row.reason)}` : ''}</span></div>`,
            )
            .join('')}</div>`
        : '<p class="view__hint">Sin cambios manuales de etapa.</p>',
    );

    const followupHtml = customerProfileSection(
      'Seguimiento',
      `<dl class="facts profile-facts">
        ${profileFact('Próximo seguimiento', profile.nextFollowup ? escapeHtml(fmtDay(profile.nextFollowup.scheduled_at)) : '—')}
        ${profileFact('Última gestión', followups[0]?.updated_at ? escapeHtml(fmtWhen(followups[0].updated_at)) : '—')}
      </dl>
      ${
        followups.length
          ? `<div class="profile-history">${followups
              .map(
                (row) =>
                  `<div><strong>${escapeHtml(fmtDay(row.scheduled_at))}</strong><span>${escapeHtml(
                    followupLabel(row.type),
                  )} · ${escapeHtml({ pending: 'pendiente', completed: 'hecho', cancelled: 'cancelado', skipped: 'omitido' }[row.status] ?? row.status)}</span></div>`,
              )
              .join('')}</div>`
          : '<p class="view__hint">Sin historial de seguimiento.</p>'
      }
      <label class="field profile-field">
        <span class="field__label">Notas</span>
        <textarea class="field__area" id="customer-notes">${escapeHtml(customer.notes ?? '')}</textarea>
      </label>
      <button class="btn btn--primary btn--block" id="customer-save" type="button">Guardar notas</button>`,
    );

    const orderDetail = (row) => `
      <div class="profile-order-detail">
        <div class="profile-order-detail__head">
          <strong>${escapeHtml(row.order_number ?? row.id ?? 'Pedido')}</strong>
          <button class="btn btn--ghost btn--sm" data-profile-order="" type="button">Volver a la lista</button>
        </div>
        <dl class="facts profile-facts">
          ${profileFact('Estado', escapeHtml(statusLabel(row.status ?? 'nuevo')))}
          ${profileFact('Fecha', row.received_at ? escapeHtml(fmtWhen(row.received_at)) : '—')}
          ${profileFact('Monto', money(row.total, row.currency))}
          ${profileFact('Producto', escapeHtml(row.variant_name ?? '—'))}
          ${profileFact('Cantidad', escapeHtml(String(row.quantity ?? '—')))}
          ${profileFact('Referencia', escapeHtml(row.reference ?? row.payment_reference ?? row.order_number ?? row.id ?? '—'))}
          ${profileFact('Canal', escapeHtml(row.channel ?? row.source ?? '—'))}
          ${profileFact('Origen', escapeHtml(sourceLabel(orderSourceOf(row))))}
          ${profileFact('Atribución', escapeHtml(sourceOriginLabel(orderSourceOriginOf(row), { ...row, ...orderJsonOf(row) })))}
          ${profileFact('Notas del pedido', escapeHtml(row.notes ?? '—'))}
        </dl>
        <div class="profile-order-actions">
          <button class="btn btn--primary btn--sm" data-receipt="${escapeHtml(row.id)}" type="button">Ver factura</button>
          <button class="btn btn--ghost btn--sm" data-order-edit="${escapeHtml(row.id)}" type="button">Modificar</button>
        </div>
      </div>`;

    /*
     * PREFERENCIAS Y COMPRAS DEL CLIENTE.
     *
     * Se guardan APARTE los datos que se repiten en cada pedido (frasco, cantidad,
     * forma de pago, ubicación de entrega y una nota) y se ven las compras hechas:
     * así el próximo pedido solo necesita confirmar la cantidad.
     */
    const prefs = customerOrderPrefs(customer.id);
    const stats = customerPurchaseStats(customer.id);
    const ubicaciones = profile.locations ?? [];
    const entregaPreferida = preferredDeliveryLocation(customer.id, ubicaciones);
    const prefsSection = customerProfileSection(
      'Preferencias del pedido',
      `<p class="view__hint">Lo que se repite en cada pedido. Al crear uno nuevo, el formulario ya viene con esto: solo confirmas la cantidad.</p>
       <label class="field">
         <span class="field__label">Frasco de siempre</span>
         <select class="field__select" id="prefs-variant">
           <option value="">Sin preferencia</option>
           ${(state.catalog ?? [])
             .map(
               (variant) =>
                 `<option value="${escapeHtml(variant.id)}" ${variant.id === prefs.variant_id ? 'selected' : ''}>${escapeHtml(
                   variant.label,
                 )} · ${money(variant.price, variant.currency)}</option>`,
             )
             .join('')}
         </select>
       </label>
       <label class="field">
         <span class="field__label">Cantidad de siempre</span>
         <input class="field__input" id="prefs-quantity" type="number" min="1" step="1" value="${prefs.quantity ?? 1}" />
       </label>
       <label class="field">
         <span class="field__label">Forma de pago</span>
         <select class="field__select" id="prefs-payment">
           <option value="">Sin preferencia</option>
           ${(state.paymentMethods ?? [])
             .map(
               (method) =>
                 `<option value="${escapeHtml(method.value)}" ${method.value === prefs.payment_method ? 'selected' : ''}>${escapeHtml(
                   method.label,
                 )}</option>`,
             )
             .join('')}
         </select>
       </label>
       <label class="field">
         <span class="field__label">Ubicación de entrega</span>
         <select class="field__select" id="prefs-location">
           <option value="">Sin preferencia</option>
           ${ubicaciones
             .map(
               (row) =>
                 `<option value="${escapeHtml(row.id)}" ${
                   row.id === (prefs.location_id ?? entregaPreferida?.id ?? '') ? 'selected' : ''
                 }>${escapeHtml(locationTitle(row))}</option>`,
             )
             .join('')}
         </select>
       </label>
       <label class="field">
         <span class="field__label">Nota de preferencia</span>
         <input class="field__input" id="prefs-note" value="${escapeHtml(prefs.note ?? '')}"
           placeholder="Entrega después de las 5 pm, preguntar por…" />
       </label>
       <div class="profile-order-actions">
         <button class="btn btn--primary btn--sm" id="prefs-save" type="button">Guardar preferencias</button>
       </div>
       <dl class="facts profile-facts">
         ${profileFact('Compras', stats.count ? `${stats.count} (${stats.delivered} entregadas)` : 'Ninguna todavía')}
         ${profileFact('Invertido', stats.invested ? money(stats.invested) : '—')}
         ${profileFact('Última compra', stats.last?.received_at ? escapeHtml(fmtWhen(stats.last.received_at)) : '—')}
         ${profileFact('Entrega de siempre', entregaPreferida ? escapeHtml(locationTitle(entregaPreferida)) : '—')}
       </dl>`,
    );

    const orders = customerProfileSection(
      'Pedidos / Ventas',
      purchases.length
        ? `<div class="profile-orders">${purchases
            .map(
              (row) => `<article class="profile-order ${selectedOrder?.id === row.id ? 'profile-order--open' : ''}">
                <div class="profile-order__main">
                  <button class="profile-order__title" data-profile-order="${escapeHtml(row.id)}" type="button">
                    <strong>${escapeHtml(row.order_number ?? row.id ?? 'Pedido')}</strong>
                    <span>${escapeHtml(row.variant_name ?? 'Producto')}</span>
                  </button>
                  <span class="tag tag--${escapeHtml(row.status ?? 'nuevo')}">${escapeHtml(statusLabel(row.status ?? 'nuevo'))}</span>
                </div>
                <div class="profile-order__meta">
                  <span>${row.received_at ? escapeHtml(fmtWhen(row.received_at)) : 'Sin fecha'}</span>
                  <span>${money(row.total, row.currency)}</span>
                  <span>${escapeHtml(sourceLabel(orderSourceOf(row)))}</span>
                  <span>Ref. ${escapeHtml(row.reference ?? row.payment_reference ?? row.order_number ?? row.id ?? '—')}</span>
                </div>
                <div class="profile-order-actions">
                  <button class="btn btn--ghost btn--sm" data-profile-order="${escapeHtml(row.id)}" type="button">Detalle</button>
                  <button class="btn btn--ghost btn--sm" data-receipt="${escapeHtml(row.id)}" type="button">Factura</button>
                </div>
                ${selectedOrder?.id === row.id ? orderDetail(row) : ''}
              </article>`,
            )
            .join('')}</div>`
        : '<p class="view__hint">Todavía no tiene pedidos registrados.</p>',
      'profile-card--wide',
    );

    const automation = customerProfileSection(
      'Acciones',
      `<div class="item__actions">
        ${phone ? `<a class="btn btn--ghost btn--sm" href="tel:${escapeHtml(phone)}">Llamar</a>` : ''}
        <button class="btn btn--ghost btn--sm" data-scheduled-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversation?.id ?? '',
        )}" type="button">Programar mensaje</button>
        ${
          customer.automation_state === 'PAUSED'
            ? `<button class="btn btn--ghost btn--sm" data-resume="${escapeHtml(customer.id)}" type="button">Reactivar</button>`
            : `<button class="btn btn--ghost btn--sm" data-pause="${escapeHtml(customer.id)}" type="button">Pausar</button>`
        }
        ${
          customer.do_not_contact
            ? `<button class="btn btn--ghost btn--sm" data-optin="${escapeHtml(customer.id)}" type="button">Volver a permitir mensajes</button>`
            : `<button class="btn btn--danger btn--sm" data-optout="${escapeHtml(customer.id)}" type="button">No contactar nunca más</button>`
        }
      </div>`,
    );

    box.innerHTML = `${state.customerProfileLoading ? '<p class="profile-loading">Actualizando datos...</p>' : ''}${errorHtml}${header}
      <div class="profile-grid">
        ${personal}
        ${prefsSection}
        ${stageHtml}
        ${tagsHtml}
        ${commercialHtml}
        ${commercialSummary}
        ${followupHtml}
        ${orders}
        ${historyHtml}
      </div>
      <button class="profile-fab" id="profile-actions" type="button" aria-label="Acciones del cliente" title="Acciones del cliente">
        <span class="ico" aria-hidden="true">${ICONS.spark}</span>
      </button>`;

    $('#customer-save')?.addEventListener('click', async (event) => {
      await working(event.currentTarget, 'Guardando…', async () => {
        try {
          await api(`/api/admin/customers/${encodeURIComponent(customer.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ notes: $('#customer-notes').value }),
          });
          toast('Notas guardadas');
          await load({ keepTab: true });
          await openCustomer(customer.id);
        } catch (error) {
          if (error.message !== 'unauthorized') toast('No se pudieron guardar las notas');
        }
      });
    });

    $('#customer-stage')?.addEventListener('change', (event) => changeCustomerStage(customer.id, event.target.value));

    // Foto del cliente: elegir del teléfono, reducirla y guardarla con el cliente.
    $('#customer-photo-pick')?.addEventListener('click', () => $('#customer-photo-file')?.click());
    $('#customer-photo-file')?.addEventListener('change', async (event) => {
      const archivo = event.target.files?.[0];
      if (!archivo) return;
      if (archivo.size > 6 * 1024 * 1024) {
        toast('Esa imagen pesa demasiado: usa una de menos de 6 MB');
        return;
      }
      const foto = await reduceCustomerPhoto(archivo);
      if (!foto) {
        toast('No se pudo preparar esa imagen: prueba con otra más pequeña');
        return;
      }
      try {
        await saveCustomerPhoto(customer.id, foto);
        toast('Foto guardada');
      } catch (error) {
        if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo guardar la foto');
      }
    });
    $('#customer-photo-clear')?.addEventListener('click', async () => {
      if (!window.confirm('¿Quitar la foto de este cliente?')) return;
      try {
        await saveCustomerPhoto(customer.id, null);
        toast('Foto quitada');
      } catch (error) {
        if (error.message !== 'unauthorized') toast('No se pudo quitar la foto');
      }
    });

    // Preferencias del pedido: se guardan con el cliente y las usa el formulario
    // de pedido para venir ya relleno.
    $('#prefs-save')?.addEventListener('click', async (event) => {
      await working(event.currentTarget, 'Guardando…', async () => {
        try {
          await api(`/api/admin/customers/${encodeURIComponent(customer.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({
              orderPrefs: {
                variantId: $('#prefs-variant').value || null,
                quantity: Number($('#prefs-quantity').value) || null,
                paymentMethod: $('#prefs-payment').value || null,
                locationId: $('#prefs-location').value || null,
                note: $('#prefs-note').value.trim() || null,
              },
            }),
          });
          toast('Preferencias guardadas');
          await load({ keepTab: true });
          await openCustomer(customer.id);
        } catch (error) {
          if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudieron guardar las preferencias');
        }
      });
    });
  }

  function renderCustomer(profile) {
    state.customerProfile = profile;
    state.customerProfileLoading = false;
    renderCustomerProfile();
    return;
    const { customer, totals, purchases, nextFollowup, followups, conversation, canSendFreeText } = profile;
    const scheduled = profile.scheduled ?? [];
    const commercial = profile.commercial_state ?? customer.commercial_state ?? 'NUEVO';
    const phone = digits(customer.phone_e164 ?? customer.phone);
    const conversationRow = conversation ?? conversationForCustomer(customer.id);
    const estado = {
      AUTOMATIC: 'Automático (puede recibir seguimiento)',
      HUMAN_REQUIRED: 'Necesita una persona',
      HUMAN_ACTIVE: 'Hablando con el negocio',
      PAUSED: 'En pausa',
      CLOSED: 'Cerrado',
    }[customer.automation_state] ?? customer.automation_state;

    openSheet(
      customer.name ?? customer.phone_e164,
      `
      <div>
        <span class="tag tag--recordatorio">${escapeHtml(commercialLabel(commercial))}</span>
        ${customer.do_not_contact ? '<span class="tag tag--perdido">No contactar</span>' : ''}
        <span class="tag">${escapeHtml(customer.source ?? 'origen desconocido')}</span>
        ${nextFollowup ? `<span class="tag tag--recordatorio">${escapeHtml(fmtDay(nextFollowup.scheduled_at))}</span>` : ''}
      </div>
      <div class="item__actions" style="margin-top:0">
        <button class="btn btn--primary btn--sm" data-order-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversationRow?.id ?? '',
        )}" type="button">Crear pedido</button>
        <button class="btn btn--ghost btn--sm" data-followup-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversationRow?.id ?? '',
        )}" type="button">Programar seguimiento</button>
        <button class="btn btn--ghost btn--sm" data-scheduled-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversationRow?.id ?? '',
        )}" type="button">Programar mensaje</button>
      </div>
      <label class="field">
        <span class="field__label">Estado comercial</span>
        <select class="field__select" id="customer-commercial">
          <option value="" ${customer.commercial_state_manual ? '' : 'selected'}>Automático (${escapeHtml(
            commercialLabel(commercial),
          )})</option>
          ${(state.commercial?.manual ?? ['INTERESADO', 'PERDIDO'])
            .map(
              (value) =>
                `<option value="${escapeHtml(value)}" ${
                  customer.commercial_state_manual === value ? 'selected' : ''
                }>${escapeHtml(commercialLabel(value))} (a mano)</option>`,
            )
            .join('')}
        </select>
        <p class="view__hint">El estado se deriva de los hechos. Solo «Interesado» y «Perdido» se fijan a mano.</p>
      </label>
      <dl class="facts">
        <div class="fact"><dt>Teléfono</dt><dd><a href="tel:${escapeHtml(phone)}">${escapeHtml(customer.phone_e164 ?? customer.phone ?? '—')}</a></dd></div>
        ${customer.location ? `<div class="fact"><dt>Ciudad</dt><dd>${escapeHtml(customer.location)}</dd></div>` : ''}
        <div class="fact"><dt>Compras entregadas</dt><dd>${totals.total_purchases}</dd></div>
        <div class="fact"><dt>Total entregado</dt><dd>${money(totals.total_spent)}</dd></div>
        <div class="fact"><dt>Última compra</dt><dd>${totals.last_purchase_at ? escapeHtml(fmtWhen(totals.last_purchase_at)) : '—'}</dd></div>
        <div class="fact"><dt>Pedidos sin cerrar</dt><dd>${totals.open_purchases}</dd></div>
        <div class="fact"><dt>Próximo seguimiento</dt><dd>${nextFollowup ? escapeHtml(fmtDay(nextFollowup.scheduled_at)) : 'ninguno'}</dd></div>
        <div class="fact"><dt>Consentimiento</dt><dd>${
          customer.do_not_contact ? 'pidió NO recibir mensajes' : customer.whatsapp_opt_in ? 'sí (dejó sus datos)' : 'sin confirmar'
        }</dd></div>
        <div class="fact"><dt>Estado</dt><dd>${escapeHtml(estado)}</dd></div>
        <div class="fact"><dt>Ventana de 24 h</dt><dd>${canSendFreeText ? 'abierta' : 'cerrada (solo plantillas)'}</dd></div>
      </dl>

      <div class="item__actions" style="margin-top:0">
        ${conversationRow ? `<button class="btn btn--whatsapp btn--sm" data-chat="${escapeHtml(conversationRow.id)}" type="button">Abrir chat</button>` : ''}
        <button class="btn btn--ghost btn--sm" data-purchase="${escapeHtml(customer.id)}" type="button">Registrar compra</button>
        <button class="btn btn--ghost btn--sm" data-followup-new="${escapeHtml(customer.id)}" type="button">Crear seguimiento</button>
        ${phone ? `<a class="btn btn--ghost btn--sm" href="tel:${escapeHtml(phone)}">Llamar</a>` : ''}
      </div>

      <div class="field">
        <span class="field__label">Compras</span>
        ${
          purchases.length
            ? `<dl class="facts">${purchases
                .map(
                  (row) => `<div class="fact"><dt>${escapeHtml(fmtWhen(row.received_at))} · ${escapeHtml(
                    row.variant_name ?? '',
                  )} ×${row.quantity ?? 1}</dt><dd>${escapeHtml(statusLabel(row.status ?? 'nuevo'))} · ${money(
                    row.total,
                    row.currency,
                  )}</dd></div>`,
                )
                .join('')}</dl>`
            : '<p class="view__hint">Todavía no tiene compras registradas.</p>'
        }
      </div>

      <div class="field">
        <span class="field__label">Pedidos</span>
        ${
          purchases.length
            ? `<div class="orders">${purchases
                .map(
                  (row) => `<article class="order-card">
                    <div class="order-card__top">
                      <strong>${escapeHtml(row.order_number ?? '—')}</strong>
                      <span class="tag tag--${escapeHtml(row.status ?? 'nuevo')}">${escapeHtml(
                        statusLabel(row.status ?? 'nuevo'),
                      )}</span>
                    </div>
                    <p class="item__meta">${escapeHtml(row.variant_name ?? '')}${
                      row.quantity ? ` ×${row.quantity}` : ''
                    } · ${money(row.total, row.currency)} · ${escapeHtml(fmtWhen(row.received_at))}</p>
                    <div class="item__actions">
                      <button class="btn btn--ghost btn--sm" data-receipt="${escapeHtml(
                        row.id,
                      )}" type="button">Ver comprobante</button>
                    </div>
                  </article>`,
                )
                .join('')}</div>`
            : '<p class="view__hint">Todavía no tiene pedidos registrados.</p>'
        }
      </div>

      <!--
        UBICACIONES del cliente: la última a la vista y el resto bajo «Ver historial».
        Es una sección discreta, no un sistema de direcciones (§13).
      -->
      <div class="field">
        <span class="field__label">Ubicaciones</span>
        <div id="customer-locations">${customerLocationsHtml(profile.locations ?? [])}</div>
      </div>

      <div class="field">
        <span class="field__label">Mensajes programados</span>
        ${
          scheduled.length
            ? `<dl class="facts">${scheduled
                .map(
                  (row) => `<div class="fact"><dt>${escapeHtml(
                    new Intl.DateTimeFormat('es-DO', { dateStyle: 'short', timeStyle: 'short' }).format(
                      new Date(row.scheduled_at),
                    ),
                  )}</dt><dd>${escapeHtml(
                    {
                      SCHEDULED: 'programado',
                      PROCESSING: 'enviando',
                      SENT: 'enviado',
                      DELIVERED: 'entregado',
                      READ: 'leído',
                      FAILED: 'falló',
                      CANCELLED: 'cancelado',
                      BLOCKED: 'bloqueado',
                    }[row.status] ?? row.status,
                  )}${
                    row.blocked_message ? ` · ${escapeHtml(row.blocked_message)}` : ''
                  }</dd></div>`,
                )
                .join('')}</dl>`
            : '<p class="view__hint">No hay mensajes programados. Programar un mensaje NO es un seguimiento: aquí el sistema intenta enviar.</p>'
        }
      </div>

      <div class="field">
        <span class="field__label">Seguimiento</span>
        ${
          followups.length
            ? `<dl class="facts">${followups
                .map(
                  (row) =>
                    `<div class="fact"><dt>${escapeHtml(fmtDay(row.scheduled_at))} · ${escapeHtml(
                      followupLabel(row.type),
                    )}</dt><dd>${escapeHtml(
                      { pending: 'pendiente', completed: 'hecho', cancelled: 'cancelado', skipped: 'omitido' }[
                        row.status
                      ] ?? row.status,
                    )}</dd></div>`,
                )
                .join('')}</dl>`
            : '<p class="view__hint">Sin tareas de seguimiento (se crean al entregar una compra).</p>'
        }
      </div>

      <div class="field">
        <span class="field__label">Automatización</span>
        <div class="item__actions" style="margin-top:0">
          ${
            customer.automation_state === 'PAUSED'
              ? `<button class="btn btn--ghost btn--sm" data-resume="${escapeHtml(customer.id)}" type="button">Reactivar</button>`
              : `<button class="btn btn--ghost btn--sm" data-pause="${escapeHtml(customer.id)}" type="button">Pausar</button>`
          }
          ${
            customer.do_not_contact
              ? `<button class="btn btn--ghost btn--sm" data-optin="${escapeHtml(customer.id)}" type="button">Volver a permitir mensajes</button>`
              : `<button class="btn btn--danger btn--sm" data-optout="${escapeHtml(customer.id)}" type="button">No contactar nunca más</button>`
          }
        </div>
        <p class="view__hint">Pausar detiene el seguimiento; «no contactar» además borra las tareas de marketing pendientes.</p>
      </div>

      <label class="field">
        <span class="field__label">Notas</span>
        <textarea class="field__area" id="customer-notes">${escapeHtml(customer.notes ?? '')}</textarea>
      </label>
      <button class="btn btn--primary btn--block" id="customer-save" type="button">Guardar notas</button>
      `,
    );

    $('#customer-save')?.addEventListener('click', async (event) => {
      await working(event.currentTarget, 'Guardando…', async () => {
        try {
          await api(`/api/admin/customers/${encodeURIComponent(customer.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ notes: $('#customer-notes').value }),
          });
          toast('Notas guardadas');
          await load({ keepTab: true });
          await openCustomer(customer.id);
        } catch (error) {
          if (error.message !== 'unauthorized') toast('No se pudieron guardar las notas');
        }
      });
    });

    // El estado comercial a mano (INTERESADO / PERDIDO) o de vuelta al derivado.
    $('#customer-commercial')?.addEventListener('change', async (event) => {
      try {
        await api(`/api/admin/customers/${encodeURIComponent(customer.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ commercialState: event.target.value || null }),
        });
        toast('Estado comercial actualizado');
        await load({ keepTab: true });
        await openCustomer(customer.id);
      } catch (error) {
        if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo cambiar el estado');
      }
    });
  }

  /**
   * Registrar una compra/pedido desde el panel.
   *
   * Hay UN solo formulario de pedido en todo el CRM (el mismo que se abre desde el
   * chat): antes era de una sola línea y cada pantalla tenía el suyo.
   */
  function openPurchaseForm(customerId) {
    openOrderForm({ customerId: customerId || null });
  }

  /**
   * Crear una tarea de seguimiento a mano (fuera del plan automático).
   *
   * Es una TAREA para una persona: el sistema no envía nada solo. Se puede crear
   * desde la ficha del cliente o desde la conversación (queda ligada a las dos).
   */
  function openFollowupForm(input) {
    const options = typeof input === 'string' ? { customerId: input } : (input ?? {});
    const customerId = options.customerId;
    const customer = customerById(customerId) ?? (state.wa.chat?.customer?.id === customerId ? state.wa.chat.customer : null);
    if (!customer) return;
    const MOTIVOS = [
      ['Responder consulta', 'Responder una consulta'],
      ['Confirmar pedido', 'Confirmar el pedido'],
      ['Confirmar entrega', 'Confirmar la entrega'],
      ['Seguimiento postventa', 'Seguimiento postventa'],
      ['Recompra', 'Recompra'],
      ['Otro', 'Otro motivo'],
    ];
    const QUICK = [
      ['Hoy', 0],
      ['Mañana', 1],
      ['En 3 días', 3],
      ['En 7 días', 7],
    ];
    openSheet(
      `Nuevo seguimiento · ${customerName(customer)}`,
      `
      <div class="field">
        <span class="field__label">Para cuándo</span>
        <div class="item__actions" style="margin-top:0">
          ${QUICK.map(
            ([text, days]) => `<button class="chip" data-fu-quick="${days}" type="button">${escapeHtml(text)}</button>`,
          ).join('')}
            <button class="chip" data-fu-quick="custom" type="button">Fecha personalizada</button>
        </div>
        <input class="field__input" id="fu-date" type="date" value="${addDaysISO(1)}" />
      </div>
      <label class="field">
        <span class="field__label">Motivo</span>
        <select class="field__select" id="fu-motivo">
          ${MOTIVOS.map(([value, text]) => `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`).join('')}
        </select>
      </label>
      <label class="field">
        <span class="field__label">Nota (opcional)</span>
        <textarea class="field__area" id="fu-reason" placeholder="Qué tengo que decirle o preguntarle…"></textarea>
      </label>
      <button class="btn btn--primary btn--block" id="fu-save" type="button">Crear seguimiento</button>
      <p class="view__hint">Es una TAREA para una persona: el sistema no envía nada solo. Aparecerá en HOY.</p>
      `,
    );
    const dateInput = $('#fu-date');
    $$('[data-fu-quick]').forEach((chip) =>
      chip.addEventListener('click', () => {
        if (chip.dataset.fuQuick === 'custom') {
          dateInput.focus();
          return;
        }
        dateInput.value = addDaysISO(Number(chip.dataset.fuQuick));
      }),
    );
    $('#fu-save').addEventListener('click', async (event) => {
      const motivo = $('#fu-motivo').value;
      const nota = $('#fu-reason').value.trim();
      await working(event.currentTarget, 'Guardando…', async () => {
        try {
          await api('/api/admin/followups', {
            method: 'POST',
            body: JSON.stringify({
              customerId: customer.id,
              conversationId: options.conversationId || undefined,
              orderId: options.orderId || undefined,
              scheduledAt: dateInput.value,
              reason: nota ? `${motivo} · ${nota}` : motivo,
            }),
          });
          toast('Seguimiento creado');
          await load({ keepTab: true });
          closeSheet();
        } catch (error) {
          if (error.message !== 'unauthorized') toast('No se pudo crear el seguimiento');
        }
      });
    });
  }

  /** Decidir una tarea: hecha, pospuesta o cancelada. */
  async function followupAction(id, action, payload = {}) {
    try {
      await api(`/api/admin/followups/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ action, ...payload }),
      });
      toast(
        { complete: 'Seguimiento hecho', postpone: 'Pospuesto 3 días', cancel: 'Seguimiento cancelado' }[action] ??
          'Seguimiento actualizado',
      );
      await load({ keepTab: true });
      if (state.chat) await openChat(state.chat.id);
      if (state.customerId) await openCustomer(state.customerId);
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudo actualizar el seguimiento');
    }
  }

  /** Pausar, reactivar, no contactar o volver a permitir mensajes. */
  async function customerAction(customerId, action) {
    const routes = {
      pause: ['/automation', { state: 'PAUSED' }],
      resume: ['/automation', { state: 'AUTOMATIC' }],
      optout: ['/opt-out', {}],
      optin: ['/opt-in', {}],
    };
    const [route, payload] = routes[action] ?? [];
    if (!route) return;
    try {
      const result = await api(`/api/admin/customers/${encodeURIComponent(customerId)}${route}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      toast(
        action === 'optout'
          ? `Marcado como no contactar${result.cancelled ? ` · ${result.cancelled} tarea(s) cancelada(s)` : ''}`
          : action === 'optin'
            ? 'Puede volver a recibir mensajes'
            : action === 'pause'
              ? 'Seguimiento en pausa'
              : 'Seguimiento reactivado',
      );
      await load({ keepTab: true });
      await openCustomer(customerId);
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudo actualizar el cliente');
    }
  }

  // --------------------------------------- acciones comerciales (S4 / S5)
  /*
   * El centro de ventas vive DENTRO de la conversación: una sola tecla abre las
   * acciones (crear pedido, programar seguimiento, programar mensaje, ver
   * cliente) sin llenar el encabezado de botones en el móvil.
   */

  const COMMERCIAL_LABELS = {
    NUEVO: 'Nuevo',
    EN_CONVERSACION: 'En conversación',
    INTERESADO: 'Interesado',
    PEDIDO_CREADO: 'Pedido creado',
    CONFIRMADO: 'Confirmado',
    ENTREGADO: 'Entregado',
    SEGUIMIENTO: 'En seguimiento',
    RECOMPRA: 'Recompra',
    PERDIDO: 'Perdido',
  };
  const commercialLabel = (value) => COMMERCIAL_LABELS[value] ?? value ?? '—';
  const orderStatusLabel = (value) => state.orderStatuses.find((entry) => entry.value === value)?.label ?? value;
  const SOURCE_LABELS = {
    META_ADS: 'Facebook / Instagram Ads',
    ORGANIC: 'Orgánico',
    REFERRAL: 'Referido',
    WHATSAPP: 'WhatsApp',
    MANUAL: 'Tienda / Manual',
    STORE: 'Tienda',
    OTHER: 'Otro',
  };
  const normalizeSourceValue = (value) => {
    const clean = String(value ?? '').trim().toUpperCase();
    if (clean === 'FACEBOOK' || clean === 'INSTAGRAM' || clean === 'META') return 'META_ADS';
    if (clean === 'ORGANICO') return 'ORGANIC';
    if (clean === 'REFERIDO') return 'REFERRAL';
    if (clean === 'OTRO') return 'OTHER';
    return clean;
  };
  const sourceLabel = (value) => SOURCE_LABELS[normalizeSourceValue(value)] ?? value ?? '—';
  const orderJsonOf = (row) => {
    try {
      return typeof row?.order_json === 'string' ? JSON.parse(row.order_json) : row?.orderJson ? JSON.parse(row.orderJson) : {};
    } catch {
      return {};
    }
  };
  const orderSourceOf = (row) => orderJsonOf(row).source ?? row?.sale_source ?? row?.source;
  const orderSourceOriginOf = (row) => orderJsonOf(row).source_origin ?? row?.source_origin;
  const sourceOriginLabel = (value, order = {}) =>
    value === 'AUTO'
      ? 'Detectado automáticamente'
      : order.source_updated_by_display_name_snapshot || order.created_by_display_name_snapshot
        ? `Marcado manualmente por ${order.source_updated_by_display_name_snapshot ?? order.created_by_display_name_snapshot}`
        : 'Marcado manualmente';
  const customerName = (customer) => (customer?.name ?? '').trim() || customer?.phone_e164 || 'Cliente';

  const catalogOf = (variantId) => state.catalog.find((entry) => entry.id === variantId) ?? null;

  /** Total del pedido calculado con el catálogo del SERVIDOR (no hay precios aquí). */
  function orderTotals(lines, discount = 0, deliveryFee = 0) {
    const items = lines
      .map((line) => {
        const variant = catalogOf(line.variantId);
        if (!variant) return null;
        const quantity = Math.max(1, Number(line.quantity) || 1);
        return { variant, quantity, subtotal: variant.price * quantity };
      })
      .filter(Boolean);
    const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
    const applied = Math.min(Math.max(0, Number(discount) || 0), subtotal);
    // El delivery es un importe APARTE (nunca una línea de producto falsa).
    const fee = Math.max(0, Math.trunc(Number(deliveryFee) || 0));
    return { items, subtotal, discount: applied, deliveryFee: fee, total: subtotal - applied + fee };
  }

  function openChatActions(customerId, conversationId) {
    const customer = customerById(customerId);
    if (!customer) return;
    const conversation =
      state.wa.chat?.conversation?.id === conversationId
        ? state.wa.chat.conversation
        : state.conversations.find((row) => row.id === conversationId) ?? null;
    const assignmentMenu = assignmentMenuHtml(conversation, { conversationId });
    /*
     * Acciones del cliente: icono + título corto, sin párrafos. La única que
     * lleva una nota es la que ENVÍA sola (una plantilla la manda el sistema): no
     * se puede confundir con una tarea para una persona.
     */
    openSheet(
      customerName(customer),
      `
      <div class="menu-list">
        ${assignmentMenu}
        <button class="menu-item" data-quick-replies="1" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.note}</span>
          <span><strong>Respuesta rápida</strong></span>
        </button>
        <button class="menu-item" data-wa-template="1" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.note}</span>
          <span><strong>Enviar plantilla</strong><small>Elige entre las aprobadas</small></span>
        </button>
        <button class="menu-item" data-wa-ask-location="1" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.pin}</span>
          <span><strong>Pedir ubicación</strong><small>Plantilla «Solicitar ubicación»</small></span>
        </button>
        <button class="menu-item" data-wa-confirm-order="1" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.check}</span>
          <span><strong>Pedir confirmación</strong><small>Plantilla del pedido, con sus datos</small></span>
        </button>
        <button class="menu-item" data-order-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversationId ?? '',
        )}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.bag}</span>
          <span><strong>Crear pedido</strong></span>
        </button>
        <button class="menu-item" data-followup-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversationId ?? '',
        )}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.clock}</span>
          <span><strong>Programar seguimiento</strong></span>
        </button>
        <button class="menu-item" data-scheduled-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversationId ?? '',
        )}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.send}</span>
          <span><strong>Programar mensaje</strong><small>Lo envía el sistema</small></span>
        </button>
        <button class="menu-item" data-customer="${escapeHtml(customer.id)}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.person}</span>
          <span><strong>Ver cliente</strong></span>
        </button>
        <button class="menu-item" data-customer-stage-menu="${escapeHtml(customer.id)}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.person}</span>
          <span><strong>Etapa del cliente</strong><small>${escapeHtml(customerStageLabel(customerStageOf(customer)))}</small></span>
        </button>
        <button class="menu-item" data-customer-tags="${escapeHtml(customer.id)}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.tagIcon}</span>
          <span><strong>Etiquetas</strong></span>
        </button>
      </div>
    `,
      { variant: 'menu' },
    );
  }

  function openClientsActions() {
    openSheet(
      'Clientes',
      `<div class="menu-list">
        <button class="menu-item" data-purchase="" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.bag}</span>
          <span><strong>Registrar compra</strong><small>Para cliente nuevo o existente</small></span>
        </button>
        <button class="menu-item" data-new-conversation="1" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.person}</span>
          <span><strong>Agregar cliente / WhatsApp</strong><small>Crear o buscar por teléfono</small></span>
        </button>
        <button class="menu-item" data-tab="pedidos" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.box}</span>
          <span><strong>Ver pedidos</strong><small>Historial comercial completo</small></span>
        </button>
      </div>`,
      { variant: 'menu' },
    );
  }

  function openProfileActions() {
    const profile = state.customerProfile;
    const customer = profile?.customer;
    if (!customer) return;
    const conversation = profile.conversation ?? conversationForCustomer(customer.id);
    const phone = digits(customer.phone_e164 ?? customer.phone);
    openSheet(
      customerName(customer),
      `<div class="menu-list">
        ${
          conversation
            ? `<button class="menu-item" data-chat="${escapeHtml(conversation.id)}" type="button">
                <span class="menu-item__icon" aria-hidden="true">${ICONS.chat}</span>
                <span><strong>Volver al chat</strong></span>
              </button>`
            : ''
        }
        <button class="menu-item" data-order-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversation?.id ?? '',
        )}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.bag}</span>
          <span><strong>Crear pedido</strong></span>
        </button>
        <button class="menu-item" data-followup-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversation?.id ?? '',
        )}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.clock}</span>
          <span><strong>Programar seguimiento</strong></span>
        </button>
        <button class="menu-item" data-customer-stage-menu="${escapeHtml(customer.id)}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.person}</span>
          <span><strong>Etapa del cliente</strong><small>${escapeHtml(customerStageLabel(customerStageOf(customer)))}</small></span>
        </button>
        <button class="menu-item" data-customer-tags="${escapeHtml(customer.id)}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.tagIcon}</span>
          <span><strong>Etiquetas</strong></span>
        </button>
        <button class="menu-item" data-scheduled-new="${escapeHtml(customer.id)}" data-conversation="${escapeHtml(
          conversation?.id ?? '',
        )}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.send}</span>
          <span><strong>Programar mensaje</strong><small>Lo envía el sistema</small></span>
        </button>
        ${phone ? `<a class="menu-item" href="tel:${escapeHtml(phone)}">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.person}</span>
          <span><strong>Llamar</strong><small>${escapeHtml(customer.phone_e164 ?? customer.phone ?? '')}</small></span>
        </a>` : ''}
        ${
          customer.automation_state === 'PAUSED'
            ? `<button class="menu-item" data-resume="${escapeHtml(customer.id)}" type="button">
                <span class="menu-item__icon" aria-hidden="true">${ICONS.retry}</span>
                <span><strong>Reactivar</strong></span>
              </button>`
            : `<button class="menu-item" data-pause="${escapeHtml(customer.id)}" type="button">
                <span class="menu-item__icon" aria-hidden="true">${ICONS.close}</span>
                <span><strong>Pausar seguimiento</strong></span>
              </button>`
        }
      </div>`,
      { variant: 'menu' },
    );
  }

  // ---------------------------------------------------- respuestas r?pidas
  /*
   * Las respuestas rápidas son los MISMOS textos guardados del panel (una sola
   * lista, un solo sitio donde viven): aquí se abren desde la conversación, para
   * no obligar a salir del chat ni a pasar por la pantalla de administración.
   *
   * LA REGLA QUE NO SE ROMPE: elegir una respuesta NUNCA envía nada. Solo deja el
   * texto escrito en el compositor, con el cursor puesto, para que una persona lo
   * revise, lo cambie (nombre, cantidad, precio…) y pulse Enviar. El envío sigue
   * pasando por las mismas reglas de siempre: ventana de 24 h, opt-out y
   * plantillas aprobadas. Una respuesta rápida NO es una plantilla de Meta.
   */
  const QR_PREVIEW = 92;
  let qrQuery = '';
  let qrMenuId = null;

  /** Orden estable y predecible: el que el negocio fijó con `position`. */
  const quickRepliesAll = () =>
    (state.messages ?? [])
      .slice()
      .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));

  const quickReplyById = (id) => (state.messages ?? []).find((row) => row.id === id) ?? null;

  /** Una línea como mucho: el texto largo no cabe en una fila compacta. */
  const qrPreview = (body) => {
    const flat = String(body ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > QR_PREVIEW ? `${flat.slice(0, QR_PREVIEW)}…` : flat;
  };

  /** Filtra por NOMBRE y por TEXTO: escribir "precio" encuentra lo que habla de precio. */
  function qrFiltered() {
    const needle = qrQuery.trim().toLowerCase();
    const rows = quickRepliesAll();
    if (!needle) return rows;
    return rows.filter((row) => `${row.name ?? ''} ${row.body ?? ''}`.toLowerCase().includes(needle));
  }

  function qrRowHtml(row) {
    const open = qrMenuId === row.id;
    const nombre = escapeHtml(row.name ?? '');
    return `<div class="qr__row${open ? ' qr__row--open' : ''}">
      <button class="qr__pick" data-qr-insert="${escapeHtml(row.id)}" type="button">
        <span class="qr__name">${nombre}</span>
        <span class="qr__text">${escapeHtml(qrPreview(row.body))}</span>
      </button>
      <button class="qr__more" data-qr-menu="${escapeHtml(row.id)}" type="button"
        aria-label="Opciones de ${nombre}" aria-expanded="${open ? 'true' : 'false'}">
        <span aria-hidden="true">⋯</span>
      </button>
      ${
        open
          ? `<div class="qr__menu">
        <button class="qr__menu-item" data-qr-edit="${escapeHtml(row.id)}" type="button">Editar</button>
        <button class="qr__menu-item qr__menu-item--danger" data-qr-del="${escapeHtml(
          row.id,
        )}" type="button">Eliminar</button>
      </div>`
          : ''
      }
    </div>`;
  }

  function renderQuickReplies() {
    const list = $('#qr-list');
    if (!list) return;
    const rows = qrFiltered();
    if (rows.length) {
      list.innerHTML = rows.map(qrRowHtml).join('');
      return;
    }
    // Vacío de verdad (no hay ninguna) o vacío por la búsqueda: se distinguen.
    list.innerHTML = (state.messages ?? []).length
      ? emptyState('Ninguna respuesta coincide con la búsqueda.')
      : `<div class="qr__empty">
          <p class="view__hint">Aún no tienes respuestas rápidas.</p>
          <button class="btn btn--primary btn--sm" data-qr-new type="button">+ Crear la primera</button>
        </div>`;
  }

  /** El selector: buscador, lista compacta y el «+» para crear. Nunca sale del chat. */
  function openQuickReplies({ keep = false } = {}) {
    if (!keep) {
      qrQuery = '';
      qrMenuId = null;
    }
    openSheet(
      'Respuestas rápidas',
      `<div class="qr">
        <div class="qr__top">
          <input class="field__input qr__search" id="qr-search" type="search" autocomplete="off"
            placeholder="Buscar respuestas" aria-label="Buscar respuestas" value="${escapeHtml(qrQuery)}" />
          <button class="icon-btn qr__new" data-qr-new type="button" aria-label="Crear respuesta rápida"
            title="Crear respuesta rápida">${ICONS.plus}</button>
        </div>
        <div class="qr__list" id="qr-list"></div>
      </div>`,
      { variant: 'menu' },
    );
    renderQuickReplies();
    /*
     * La lista se pinta AL INSTANTE con lo que hay en memoria y se refresca
     * detrás: si otra persona creó o borró una respuesta desde otro equipo, aquí
     * aparece sin recargar la página. Si el refresco falla, se queda la copia que
     * ya había (abrir el selector nunca puede quedarse en blanco por la red).
     */
    api('/api/admin/messages')
      .then((data) => {
        if (!Array.isArray(data?.messages)) return;
        state.messages = data.messages;
        renderQuickReplies();
      })
      .catch(() => {
        /* sin conexión: la lista que ya estaba se mantiene */
      });
    const search = $('#qr-search');
    search?.addEventListener('input', (event) => {
      qrQuery = event.target.value ?? '';
      qrMenuId = null;
      renderQuickReplies();
    });
    /*
     * En escritorio el foco entra en el buscador (se escribe y se filtra). En
     * móvil NO se abre el teclado al mirar la lista: el teclado aparece al
     * elegir la respuesta, que es cuando de verdad hace falta.
     */
    if (typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 900px)').matches) search?.focus();
  }

  /** Alta o edición, dentro de la MISMA hoja: el chat nunca se pierde de vista. */
  function openQuickReplyForm(id = null) {
    const row = id ? quickReplyById(id) : null;
    if (id && !row) {
      toast('Esa respuesta ya no existe');
      openQuickReplies();
      return;
    }
    openSheet(
      row ? 'Editar respuesta' : 'Nueva respuesta',
      `<label class="field">
        <span class="field__label">Nombre</span>
        <input class="field__input" id="qr-name" maxlength="60" value="${escapeHtml(
          row?.name ?? '',
        )}" placeholder="Modo de uso" />
      </label>
      <label class="field">
        <span class="field__label">Mensaje</span>
        <textarea class="field__area" id="qr-body" maxlength="1200" placeholder="Hola {nombre}, …">${escapeHtml(
          row?.body ?? '',
        )}</textarea>
      </label>
      <p class="view__hint">Variables: {nombre} y {telefono} se rellenan con los datos del cliente de ESTA conversación.</p>
      <div class="qr__form-actions">
        <button class="btn btn--ghost" data-qr-back type="button">Cancelar</button>
        <button class="btn btn--primary" id="qr-save" type="button">${row ? 'Guardar cambios' : 'Crear respuesta'}</button>
      </div>`,
      { variant: 'menu' },
    );
    $('#qr-name')?.focus();
    $('#qr-save')?.addEventListener('click', async (event) => {
      const name = $('#qr-name').value.trim();
      const texto = $('#qr-body').value.trim();
      if (!name || !texto) {
        toast('Hacen falta nombre y mensaje');
        return;
      }
      await working(event.currentTarget, 'Guardando…', async () => {
        try {
          const result = await api('/api/admin/messages', {
            method: 'POST',
            body: JSON.stringify({ id: row?.id, name, body: texto, position: row?.position }),
          });
          state.messages = result.messages ?? state.messages;
          renderMensajes();
          toast(row ? 'Respuesta actualizada' : 'Respuesta creada');
          openQuickReplies({ keep: true });
        } catch {
          toast('No se pudo guardar la respuesta');
        }
      });
    });
  }

  /** Borrar: confirmación corta y nada más. No toca mensajes, clientes ni pedidos. */
  function quickReplyDelete(id) {
    const row = quickReplyById(id);
    if (!row) {
      openQuickReplies();
      return;
    }
    openSheet(
      'Eliminar respuesta',
      `<p class="view__hint">¿Eliminar «${escapeHtml(
        row.name ?? '',
      )}»? Los mensajes que ya enviaste no se tocan.</p>
      <div class="qr__form-actions">
        <button class="btn btn--ghost" data-qr-back type="button">Cancelar</button>
        <button class="btn btn--danger" id="qr-delete" type="button">Eliminar</button>
      </div>`,
      { variant: 'menu' },
    );
    $('#qr-delete')?.addEventListener('click', async (event) => {
      await working(event.currentTarget, 'Eliminando…', async () => {
        try {
          const result = await api(`/api/admin/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
          state.messages = result.messages ?? state.messages;
          renderMensajes();
          toast('Respuesta eliminada');
          openQuickReplies();
        } catch {
          toast('No se pudo eliminar la respuesta');
        }
      });
    });
  }

  /**
   * Insertar la respuesta en el compositor. NO ENVÍA NADA: escribe el texto y
   * deja el cursor puesto. Si ya había algo escrito no se pisa nada: se inserta
   * donde estaba el cursor. El envío lo decide una persona con el botón Enviar.
   */
  function insertQuickReply(id) {
    const row = quickReplyById(id);
    if (!row) {
      toast('Esa respuesta ya no existe');
      closeSheet();
      return;
    }
    const area = $('#wa-text');
    if (!area) {
      // Sin compositor (cliente «no contactar» o WhatsApp sin configurar) no hay
      // ningún sitio donde colocar el texto: se avisa y no se inventa nada.
      toast('No se puede escribir en esta conversación');
      closeSheet();
      return;
    }
    const customer = state.wa?.chat?.customer ?? null;
    // Solo datos REALES de esta conversación: si no hay teléfono, `{telefono}` se
    // queda escrita tal cual en vez de rellenarse con algo inventado.
    const texto = fillTemplate(row.body, { name: customer?.name ?? null, phone: customer?.phone_e164 ?? null });
    const corte = typeof area.selectionStart === 'number' ? area.selectionStart : area.value.length;
    const fin = typeof area.selectionEnd === 'number' ? area.selectionEnd : area.value.length;
    const antes = area.value.slice(0, corte);
    const despues = area.value.slice(fin);
    const separador = antes && !antes.endsWith('\n') ? '\n' : '';
    const escrito = `${antes}${separador}${texto}`;
    area.value = `${escrito}${despues}`;
    state.wa.draft = area.value;
    // Se avisa al compositor como si lo hubiera escrito una persona: así decide
    // él si toca micrófono o Enviar y ajusta la altura.
    if (typeof window.Event === 'function') area.dispatchEvent(new window.Event('input'));
    closeSheet();
    area.focus();
    if (typeof area.setSelectionRange === 'function') area.setSelectionRange(escrito.length, escrito.length);
    toast('Respuesta lista para revisar y enviar');
  }

  /**
   * Formulario de pedido (nuevo o edición). El catálogo y los precios vienen del
   * servidor: el panel solo elige el frasco y la cantidad.
   */
  async function openOrderForm({ customerId, conversationId = '', orderId = null, order = null, location = null } = {}) {
    // Si no hay cliente, el formulario pinta id="order-phone"; desde chat, customer ? '' evita pedirlo.
    const customer = customerId
      ? customerById(customerId) ?? (state.wa.chat?.customer?.id === customerId ? state.wa.chat.customer : null)
      : null;
    const catalog = state.catalog ?? [];
    if (!catalog.length) {
      toast('El catálogo todavía no está disponible');
      return;
    }
    // Ubicaciones del cliente: se piden antes de pintar para poder ofrecerlas (§9).
    const customerLocations = customerId ? await fetchCustomerLocations(customerId) : [];
    /*
     * PREFERENCIAS DEL CLIENTE: frasco, cantidad, forma de pago y ubicación de
     * entrega. Con esto el formulario ya viene relleno y lo único que se confirma
     * es la cantidad, que es lo que cambia de un pedido a otro.
     */
    const prefs = customerId ? customerOrderPrefs(customerId) : null;
    const prefsLine = customerId ? orderPrefsSummary(prefs, customerLocations) : '';
    const prefsVariant =
      prefs?.variant_id && catalog.some((variant) => variant.id === prefs.variant_id) ? prefs.variant_id : null;
    /** @type {Array<{variantId: string, quantity: number}>} */
    let lines = order?.items?.map((line) => ({ variantId: line.variantId, quantity: line.quantity })) ?? [
      { variantId: prefsVariant ?? catalog[0].id, quantity: Math.max(1, Number(prefs?.quantity) || 1) },
    ];
    const defaultStatus = order?.status ?? 'nuevo';
    const methods = state.paymentMethods.length
      ? state.paymentMethods
      : [
          { value: 'CASH', label: 'Efectivo' },
          { value: 'TRANSFER', label: 'Transferencia' },
        ];
    const prefsPayment = methods.some((method) => method.value === prefs?.payment_method)
      ? prefs.payment_method
      : null;
    const defaultPayment = order?.payment_method ?? prefsPayment ?? methods[0]?.value ?? 'CASH';
    const sourceConversation = conversationId ? state.conversations.find((row) => row.id === conversationId) ?? state.wa.chat?.conversation ?? null : null;
    const defaultSource = order?.source ?? (sourceConversation?.source === 'META_ADS' ? 'META_ADS' : conversationId ? 'WHATSAPP' : 'MANUAL');
    const defaultCampaign =
      order?.meta_attribution_snapshot?.utm_campaign ??
      order?.meta_attribution_snapshot?.campaign_id ??
      sourceConversation?.meta_attribution?.utm_campaign ??
      sourceConversation?.meta_attribution?.campaign_id ??
      '';
    const defaultAd =
      order?.meta_attribution_snapshot?.utm_content ??
      order?.meta_attribution_snapshot?.ad_id ??
      sourceConversation?.meta_attribution?.utm_content ??
      sourceConversation?.meta_attribution?.ad_id ??
      '';
    /*
     * ¿YA TIENE UN PEDIDO ABIERTO? Se enseña ANTES de nada: un cliente con un
     * pedido en camino que hace otro suele ser un error (o una recompra que hay
     * que decidir), y descubrirlo después de guardar ya es tarde. El pedido no se
     * guarda hasta marcar la casilla.
     */
    const liveOrders = customer && !orderId ? liveOrdersForCustomer(customer.id) : [];
    const liveOrdersBlock = liveOrders.length
      ? `<div class="rule rule--warn" id="order-open-warning">
          <strong>${escapeHtml(customerName(customer))} ya tiene ${
            liveOrders.length === 1 ? 'un pedido sin cerrar' : `${liveOrders.length} pedidos sin cerrar`
          }.</strong>
          <ul class="rule__list">
            ${liveOrders
              .slice(0, 3)
              .map(
                (item) =>
                  `<li>${escapeHtml(item.order_number ?? item.id)} · ${escapeHtml(
                    statusLabel(item.status ?? 'nuevo'),
                  )}${orderTotalOf(item) ? ` · ${escapeHtml(orderTotalOf(item))}` : ''}${
                    item.received_at ? ` · ${escapeHtml(fmtWhen(item.received_at))}` : ''
                  }</li>`,
              )
              .join('')}
          </ul>
          <label class="loc-option">
            <input type="checkbox" id="order-open-ack" />
            <span class="loc-option__body"><strong>Sí, es un pedido nuevo</strong>
            <small>El anterior sigue abierto y se gestiona aparte.</small></span>
          </label>
        </div>`
      : '';

    openSheet(
      `${
        orderId
          ? `Modificar pedido · ${customer ? customerName(customer) : 'cliente'}`
          : customer
            ? `Pedido para ${customerName(customer)}`
            : 'Pedido para un cliente nuevo'
      }`,
      `
      ${liveOrdersBlock}
      ${
        customer
          ? ''
          : `<p class="view__hint">El teléfono identifica al cliente: si ya existe, el pedido se suma a su historial.</p>
             <label class="field">
               <span class="field__label">Teléfono del cliente</span>
               <input class="field__input" id="order-phone" type="tel" inputmode="tel" placeholder="809 555 1234" />
             </label>
             <label class="field">
               <span class="field__label">Nombre</span>
               <input class="field__input" id="order-name" placeholder="Nombre del cliente" />
             </label>`
      }
      ${
        customer
          ? `<div class="order-prefs">
              ${
                prefsLine
                  ? `<p class="view__hint"><strong>Lo de siempre:</strong> ${escapeHtml(prefsLine)}</p>`
                  : '<p class="view__hint">Sin preferencias guardadas todavía: se toman los datos del último pedido.</p>'
              }
              <label class="loc-option">
                <input type="checkbox" id="order-save-prefs" ${prefs?.saved ? '' : 'checked'} />
                <span class="loc-option__body"><strong>Guardar estos datos como sus preferencias</strong>
                <small>Frasco, cantidad, pago y ubicación para el próximo pedido.</small></span>
              </label>
            </div>`
          : ''
      }
      <div id="order-lines"></div>
      <button class="btn btn--ghost btn--sm" id="order-add" type="button">+ Añadir otro frasco</button>      <label class="field">
        <span class="field__label">Origen de la venta</span>
        <select class="field__select" id="order-source">
          ${['META_ADS', 'ORGANIC', 'REFERRAL', 'WHATSAPP', 'MANUAL', 'OTHER']
            .map(
              (value) =>
                `<option value="${escapeHtml(value)}" ${value === defaultSource ? 'selected' : ''}>${escapeHtml(sourceLabel(value))}</option>`,
            )
            .join('')}
        </select>
      </label>
      <div id="order-source-meta">
        <label class="field">
          <span class="field__label">Campaña (opcional)</span>
          <input class="field__input" id="order-source-campaign" value="${escapeHtml(defaultCampaign)}" placeholder="Nombre o ID si existe" />
        </label>
        <label class="field">
          <span class="field__label">Anuncio (opcional)</span>
          <input class="field__input" id="order-source-ad" value="${escapeHtml(defaultAd)}" placeholder="Nombre o ID si existe" />
        </label>
        <label class="field">
          <span class="field__label">Nota de origen (opcional)</span>
          <input class="field__input" id="order-source-note" value="${escapeHtml(order?.meta_attribution_snapshot?.note ?? '')}" />
        </label>
      </div>
      <label class="field">
        <span class="field__label">Descuento (opcional, RD$)</span>
        <input class="field__input" id="order-discount" type="number" min="0" step="1" value="${
          order?.discount ?? 0
        }" />
      </label>
      <div class="field">
        <span class="field__label">Ubicación de entrega (opcional)</span>
        <div id="order-loc"></div>
      </div>
      <label class="field">
        <span class="field__label">Costo de delivery (opcional, RD$)</span>
        <input class="field__input" id="order-fee" type="number" min="0" step="1" value="${
          order?.delivery_fee ?? order?.delivery?.fee ?? ''
        }" placeholder="0" />
      </label>
      <label class="field" ${orderId ? 'hidden' : ''}>
        <span class="field__label">Estado</span>
        <select class="field__select" id="order-status">
          ${(state.orderStatuses ?? [])
            .map(
              (status) =>
                `<option value="${escapeHtml(status.value)}" ${
                  status.value === defaultStatus ? 'selected' : ''
                }>${escapeHtml(status.label)}</option>`,
            )
            .join('')}
        </select>
      </label>
      ${
        orderId
          ? '<p class="view__hint">El estado del pedido se cambia desde “Cambiar estado”, con motivo y auditoría.</p>'
          : ''
      }
      <label class="field">
        <span class="field__label">Método de pago</span>
        <select class="field__select" id="order-payment">
          ${methods
            .map(
              (method) =>
                `<option value="${escapeHtml(method.value)}" ${
                  method.value === defaultPayment ? 'selected' : ''
                }>${escapeHtml(method.label)}</option>`,
            )
            .join('')}
        </select>
      </label>
      <label class="field">
        <span class="field__label">Notas</span>
        <textarea class="field__area" id="order-notes" placeholder="Pagó en efectivo, entrega el viernes…">${escapeHtml(
          order?.notes ?? '',
        )}</textarea>
      </label>
      <p class="view__hint" id="order-total"></p>
      <button class="btn btn--primary btn--block" id="order-save" type="button">${
        orderId ? 'Guardar cambios' : 'Guardar pedido'
      }</button>
      <p class="view__hint">
        Al marcarlo como «entregado» se envía la venta a Meta una sola vez y se crean las tareas de
        seguimiento del día 1, 3, 7, 14, 21 y 30 (según tus Ajustes).
      </p>
      `,
    );

    const linesBox = $('#order-lines');
    const renderLines = () => {
      linesBox.innerHTML = lines
        .map(
          (line, index) => `
        <div class="order-line">
          <label class="field">
            <span class="field__label">Frasco</span>
            <select class="field__select" data-line-variant="${index}">
              ${catalog
                .map(
                  (variant) =>
                    `<option value="${escapeHtml(variant.id)}" ${
                      variant.id === line.variantId ? 'selected' : ''
                    }>${escapeHtml(variant.label)} · ${money(variant.price, variant.currency)}</option>`,
                )
                .join('')}
            </select>
          </label>
          <label class="field order-line__qty">
            <span class="field__label">Cantidad</span>
            <input class="field__input" type="number" min="1" step="1" value="${line.quantity}" data-line-qty="${index}" />
          </label>
          ${
            lines.length > 1
              ? `<button class="icon-btn" data-line-remove="${index}" type="button" aria-label="Quitar frasco">✕</button>`
              : ''
          }
        </div>`,
        )
        .join('');
      refreshOrderTotal();
    };
    const refreshOrderTotal = () => {
      const totals = orderTotals(
        lines,
        Number($('#order-discount')?.value) || 0,
        Number($('#order-fee')?.value) || 0,
      );
      const box = $('#order-total');
      if (!box) return;
      const stock = state.inventory;
      const strictStock = stock?.initialized === true;
      const insufficient = strictStock && Number(stock.stock) < Number(totals.totalCapsules);
      box.innerHTML = totals.items.length
        ? `Productos ${money(totals.subtotal)}${totals.discount ? ` · Descuento −${money(totals.discount)}` : ''}${
            totals.deliveryFee ? ` · Delivery ${money(totals.deliveryFee)}` : ''
          } · <strong>Total ${money(totals.total)}</strong>${
            strictStock
              ? ` · Stock ${escapeHtml(stock.stock)} cápsulas${insufficient ? ' · insuficiente para entregar' : ''}`
              : ' · Stock sin inicializar'
          }`
        : 'Elige al menos un frasco del catálogo.';
    };

    /*
     * UBICACIÓN DE ENTREGA (opcional). Se elige DENTRO del propio formulario, sin
     * abrir otra hoja: así no se pierde lo que ya estaba escrito (§9, §10, §24).
     * Nunca se pide el permiso de ubicación al abrir: solo al pulsar el botón.
     */
    let chosenLocation = location && locationCoordsOk(location)
      ? { ...location }
      : order?.delivery?.location
        ? { ...order.delivery.location, id: order.delivery.location.source_location_id ?? null }
        : customerId
          ? preferredDeliveryLocation(customerId, customerLocations)
          : null;
    chosenLocation = chosenLocation && locationCoordsOk(chosenLocation) ? chosenLocation : null;
    const renderLocationBlock = () => {
      const box = $('#order-loc');
      if (!box) return;
      if (chosenLocation) {
        /*
         * La ubicación viene puesta (la de siempre), pero SIEMPRE con su edad a la
         * vista: un punto compartido hace meses puede estar ya caducado, y eso el
         * operador tiene que poder verlo antes de confirmar el pedido.
         */
        const edad = locationContext(chosenLocation).age;
        box.innerHTML = `${locationChip(chosenLocation, { withActions: false })}
          ${edad ? `<p class="view__hint">${escapeHtml(edad)}. Si este pedido va a otro sitio, quítala y elige otra.</p>` : ''}
          <button class="btn btn--ghost btn--sm" id="order-loc-clear" type="button">Quitar ubicación</button>`;
        $('#order-loc-clear').addEventListener('click', () => {
          chosenLocation = null;
          renderLocationBlock();
        });
        return;
      }
      const visible = customerLocations.slice(0, 3);
      const rest = customerLocations.slice(3);
      const option = (location) => `
        <label class="loc-option">
          <input type="radio" name="order-loc-pick" value="${escapeHtml(location.id)}" />
          <span class="loc-option__body"><strong>${escapeHtml(locationTitle(location))}</strong>
          <small>${escapeHtml(locationContext(location).address ?? 'Solo coordenadas')}${
            location.age_label ? ` · ${escapeHtml(location.age_label)}` : ''
          }</small></span>
          ${location.map_url ? `<a class="loc__link" href="${escapeHtml(location.map_url)}" target="_blank" rel="noopener noreferrer">Ver mapa</a>` : ''}
        </label>`;
      box.innerHTML = `
        <p class="view__hint">Puede ir sin ubicación: el pedido se guarda igual.</p>
        <label class="loc-option">
          <input type="radio" name="order-loc-pick" value="" checked />
          <span class="loc-option__body"><strong>Sin ubicación</strong><small>No hace falta dirección ni ciudad.</small></span>
        </label>
        ${visible.map(option).join('')}
        ${rest.length ? `<details class="loc-history"><summary>Ver historial (${rest.length})</summary>${rest.map(option).join('')}</details>` : ''}
        <button class="btn btn--ghost btn--sm" id="order-loc-current" type="button">Usar la ubicación de este dispositivo</button>`;
      $('#order-loc-current').addEventListener('click', async (event) => {
        await working(event.currentTarget, 'Buscando…', async () => {
          const found = await getBrowserLocation();
          if (!found.ok) {
            toast(found.message);
            return;
          }
          chosenLocation = found.location;
          renderLocationBlock();
        });
      });
      box.addEventListener('change', (event) => {
        const value = event.target.closest('[name="order-loc-pick"]')?.value ?? '';
        if (value) {
          chosenLocation = customerLocations.find((row) => row.id === value) ?? null;
          renderLocationBlock();
        }
      });
    };
    renderLocationBlock();

    linesBox.addEventListener('change', (event) => {
      const select = event.target.closest('[data-line-variant]');
      if (select) {
        lines[Number(select.dataset.lineVariant)].variantId = select.value;
        refreshOrderTotal();
      }
      const quantity = event.target.closest('[data-line-qty]');
      if (quantity) {
        lines[Number(quantity.dataset.lineQty)].quantity = Math.max(1, Number(quantity.value) || 1);
        refreshOrderTotal();
      }
    });
    linesBox.addEventListener('click', (event) => {
      const remove = event.target.closest('[data-line-remove]');
      if (!remove) return;
      lines = lines.filter((_, index) => index !== Number(remove.dataset.lineRemove));
      renderLines();
    });
    $('#order-add').addEventListener('click', () => {
      lines = [...lines, { variantId: catalog[0].id, quantity: 1 }];
      renderLines();
    });
    $('#order-discount').addEventListener('input', refreshOrderTotal);
    $('#order-fee').addEventListener('input', refreshOrderTotal);
    const refreshSourceFields = () => {
      const box = $('#order-source-meta');
      if (box) box.hidden = $('#order-source')?.value !== 'META_ADS';
    };
    $('#order-source')?.addEventListener('change', refreshSourceFields);
    refreshSourceFields();
    renderLines();

    $('#order-save').addEventListener('click', async (event) => {
      /*
       * El aviso de pedido abierto se confirma AQUÍ (no solo se enseña): sin
       * marcar la casilla no se guarda. Es la diferencia entre avisar y evitar.
       */
      if (liveOrders.length && $('#order-open-ack')?.checked !== true) {
        toast(`Confirma que es un pedido nuevo: ${customerName(customer)} ya tiene uno abierto`);
        return;
      }
      const totals = orderTotals(
        lines,
        Number($('#order-discount').value) || 0,
        Number($('#order-fee').value) || 0,
      );
      if (!totals.items.length) {
        toast('Elige al menos un frasco');
        return;
      }
      if (
        $('#order-status')?.value === 'entregado' &&
        state.inventory?.initialized === true &&
        Number(state.inventory.stock) < Number(totals.totalCapsules)
      ) {
        toast(`Stock insuficiente: hay ${state.inventory.stock} cápsulas y el pedido requiere ${totals.totalCapsules}`);
        return;
      }
      const typedPhone = customer ? null : $('#order-phone').value.trim();
      if (!customer && !typedPhone) {
        toast('Escribe el teléfono del cliente');
        return;
      }
      await working(event.currentTarget, 'Guardando…', async () => {
        try {
          const payload = {
            customerId: customer?.id,
            phone: customer?.phone_e164 ?? typedPhone,
            name: customer?.name ?? $('#order-name')?.value.trim(),
            conversationId: conversationId || undefined,
            channel: conversationId ? 'whatsapp' : 'panel',
            items: lines,
            discount: Number($('#order-discount').value) || 0,
            // Delivery OPCIONAL e independiente de la ubicación (§26).
            deliveryFee: Number($('#order-fee').value) || 0,
            /*
             * Ubicación: la elegida (por id si ya existía, o con sus coordenadas
             * si es la del dispositivo). `null` = «sin ubicación», y es válido.
             */
            deliveryLocation: chosenLocation
              ? chosenLocation.id
                ? chosenLocation.id
                : {
                    latitude: chosenLocation.latitude,
                    longitude: chosenLocation.longitude,
                    name: chosenLocation.name ?? null,
                    address: chosenLocation.address ?? null,
                    source: chosenLocation.source ?? 'browser_geolocation',
                  }
              : null,
            status: $('#order-status').value,
            paymentMethod: $('#order-payment').value,
            source: $('#order-source').value,
            utm_campaign: $('#order-source-campaign')?.value.trim() || undefined,
            utm_content: $('#order-source-ad')?.value.trim() || undefined,
            source_note: $('#order-source-note')?.value.trim() || undefined,
            notes: $('#order-notes').value,
          };
          const result = orderId
            ? await api(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
                method: 'PATCH',
                body: JSON.stringify({
                  items: lines,
                  discount: payload.discount,
                  deliveryFee: payload.deliveryFee,
                  deliveryLocation: payload.deliveryLocation,
                  paymentMethod: payload.paymentMethod,
                  source: payload.source,
                  utm_campaign: payload.utm_campaign,
                  utm_content: payload.utm_content,
                  source_note: payload.source_note,
                  notes: payload.notes,
                }),
              })
            : await api('/api/admin/orders', { method: 'POST', body: JSON.stringify(payload) });
          const savedId = orderId ?? result.item?.id;
          /*
           * GUARDAR LAS PREFERENCIAS: lo que se acaba de usar pasa a ser «lo de
           * siempre» de este cliente (frasco, cantidad, pago y ubicación), para
           * que el próximo pedido venga ya relleno. Si falla, el pedido YA está
           * guardado: no se rompe nada.
           */
          if (customer?.id && $('#order-save-prefs')?.checked && lines.length) {
            const previas = customerOrderPrefs(customer.id);
            await api(`/api/admin/customers/${encodeURIComponent(customer.id)}`, {
              method: 'PATCH',
              body: JSON.stringify({
                orderPrefs: {
                  variantId: lines[0].variantId,
                  quantity: Math.max(1, Number(lines[0].quantity) || 1),
                  paymentMethod: $('#order-payment').value,
                  locationId: chosenLocation?.id ?? null,
                  note: previas.note ?? null,
                },
              }),
            }).catch(() => {});
          }
          toast(orderId ? 'Pedido actualizado' : `Pedido ${result.order?.order_number ?? ''} guardado`);
          await load({ keepTab: true });
          if (savedId) await openReceipt(savedId);
        } catch (error) {
          if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo guardar el pedido');
        }
      });
    });
  }

  /*
   * ==========================================================================
   *  UBICACIONES GPS
   * ==========================================================================
   *
   * Reglas (las mismas que aplica el servidor):
   *   · la fuente de verdad son las coordenadas; el enlace de mapa se CALCULA;
   *   · una ubicación no es un archivo: no se sube a ningún sitio, se pinta;
   *   · nada sale por WhatsApp sin confirmación explícita (§19);
   *   · compartir con otro chat es una acción aparte, avisada y auditada (§21);
   *   · el permiso de ubicación del navegador SOLO se pide al pulsar el botón.
   */

  /** ¿Son coordenadas utilizables? (mismo criterio que el servidor). */
  const locationCoordsOk = (location) => {
    const lat = Number(location?.latitude);
    const lng = Number(location?.longitude);
    return (
      Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    );
  };

  /** Enlace de mapa a partir de las coordenadas (nunca se guarda una URL). */
  const locationMapUrl = (location) => {
    if (!locationCoordsOk(location)) return null;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${Number(location.latitude)},${Number(location.longitude)}`,
    )}`;
  };

  /** Título honesto: el nombre si lo hay, si no «Ubicación compartida». */
  const locationTitle = (location) => String(location?.name ?? '').trim() || 'Ubicación compartida';

  /** Línea de contexto: dirección y de dónde salió (nunca coordenadas crudas). */
  const locationContext = (location) => {
    const who = {
      whatsapp_inbound: 'Compartida por el cliente',
      whatsapp_outbound: 'Enviada al cliente',
      browser_geolocation: 'Ubicación de este dispositivo',
      manual_coordinates: 'Coordenadas escritas a mano',
      reused_location: 'Reutilizada de otra conversación',
    }[location?.source];
    return { address: String(location?.address ?? '').trim() || null, who: who ?? 'Ubicación', age: location?.age_label ?? null };
  };

  /**
   * Componente de ubicación: UNA pieza compacta (nada de tarjeta dentro de otra).
   * Va dentro de la burbuja, así que respeta la alineación de siempre: entrante a
   * la izquierda, saliente a la derecha (§35).
   */
  function locationChip(location, options = {}) {
    const url = locationMapUrl(location);
    const { address, who, age } = locationContext(location);
    const detalle = [address, age ? age.replace('Compartida', 'Compartida') : null].filter(Boolean).join(' · ');
    return `<span class="loc" data-location="${escapeHtml(location?.id ?? '')}">
        <span class="loc__head"><span class="loc__pin" aria-hidden="true">📍</span>
          <span class="loc__title">${escapeHtml(locationTitle(location))}</span></span>
        ${address ? `<span class="loc__address">${escapeHtml(address)}</span>` : ''}
        <span class="loc__meta">${escapeHtml(who)}${detalle && !address ? ` · ${escapeHtml(detalle)}` : ''}</span>
        <span class="loc__actions">
          ${
            url && options.withMap !== false
              ? `<button class="loc__link" data-open-map="${mapLocationAttr(location)}" data-map-title="${escapeHtml(
                  locationTitle(location),
                )}" type="button">Ver en mapa</button>`
              : ''
          }
          ${
            !url && options.withMap !== false ? '<span class="loc__link loc__link--off">Sin coordenadas legibles</span>' : ''
          }
          ${
            options.withActions !== false
              ? `<button class="loc__more" type="button" data-loc-menu="${escapeHtml(location?.id ?? '')}" aria-label="Más acciones de la ubicación">${ICONS.more}</button>`
              : ''
          }
        </span>
      </span>`;
  }

  /** Ubicaciones del cliente (historial). Se piden al abrir, nunca se cachean de más. */
  async function fetchCustomerLocations(customerId) {
    if (!customerId) return [];
    try {
      const data = await api(`/api/admin/customers/${encodeURIComponent(customerId)}/locations`);
      return Array.isArray(data.locations) ? data.locations : [];
    } catch {
      return [];
    }
  }

  /** Todas las ubicaciones del CRM (para poder compartir una entre chats). */
  async function fetchAllLocations() {
    const customers = state.customers ?? [];
    const lists = await Promise.all(customers.slice(0, 50).map((customer) => fetchCustomerLocations(customer.id)));
    return lists.flat();
  }

  /** Ubicación actual del dispositivo. SOLO se llama desde un clic (§15). */
  function getBrowserLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation?.getCurrentPosition) {
        resolve({ ok: false, error: 'unsupported', message: 'Este navegador no sabe dar la ubicación. Puedes adjuntarla o escribir las coordenadas.' });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) =>
          resolve({
            ok: true,
            location: {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              name: null,
              address: null,
              source: 'browser_geolocation',
            },
          }),
        (error) =>
          resolve({
            ok: false,
            error: error?.code === 1 ? 'denied' : 'unavailable',
            message:
              error?.code === 1
                ? 'No diste permiso para usar la ubicación. El pedido sigue funcionando sin ella.'
                : 'No pudimos obtener la ubicación del dispositivo. Puedes escribir las coordenadas o seguir sin ella.',
          }),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
      );
    });
  }

  /**
   * Selector de ubicación: lista las del cliente (con su edad) y ofrece la del
   * dispositivo o escribir coordenadas. Nunca envía nada: solo elige.
   */
  async function openLocationPicker({ customerId, conversationId = '', title = 'Ubicación de entrega' }) {
    const locations = await fetchCustomerLocations(customerId);
    const opciones = locations.length
      ? locations
          .map(
            (location) => `
        <label class="loc-option">
          <input type="radio" name="loc-pick" value="${escapeHtml(location.id)}" />
          <span class="loc-option__body">
            <strong>${escapeHtml(locationTitle(location))}</strong>
            <small>${escapeHtml(locationContext(location).address ?? 'Solo coordenadas')}${
              location.age_label ? ` · ${escapeHtml(location.age_label)}` : ''
            }</small>
          </span>
          ${
            location.map_url
              ? `<a class="loc__link" href="${escapeHtml(location.map_url)}" target="_blank" rel="noopener noreferrer">Ver mapa</a>`
              : ''
          }
        </label>`,
          )
          .join('')
      : `<p class="view__hint">Este cliente todavía no ha compartido ninguna ubicación.</p>`;
    return new Promise((resolve) => {
      openSheet(
        title,
        `
        <p class="view__hint">Elegir una ubicación no envía nada: primero se ve y después se confirma.</p>
        <label class="loc-option">
          <input type="radio" name="loc-pick" value="" checked />
          <span class="loc-option__body"><strong>Sin ubicación</strong><small>El pedido se guarda igual.</small></span>
        </label>
        ${opciones}
        ${
          locations.length > 1
            ? `<details class="loc-history"><summary>Ver historial completo (${locations.length})</summary>
                 <p class="view__hint">Las de arriba son todas, de la más reciente a la más antigua.</p></details>`
            : ''
        }
        <button class="btn btn--ghost btn--block" id="loc-current" type="button">Usar la ubicación de este dispositivo</button>
        <label class="field">
          <span class="field__label">…o escribir coordenadas (opcional)</span>
          <span class="loc-coords">
            <input class="field__input" id="loc-lat" inputmode="decimal" placeholder="Latitud" />
            <input class="field__input" id="loc-lng" inputmode="decimal" placeholder="Longitud" />
          </span>
        </label>
        <button class="btn btn--primary btn--block" id="loc-ok" type="button">Usar esta ubicación</button>
        <button class="btn btn--ghost btn--block" id="loc-cancel" type="button">Cancelar</button>
        `,
      );
      const close = (value) => {
        closeSheet();
        resolve(value);
      };
      $('#loc-cancel').addEventListener('click', () => close({ ok: false, cancelled: true }));
      $('#loc-current').addEventListener('click', async (event) => {
        await working(event.currentTarget, 'Buscando…', async () => {
          const found = await getBrowserLocation();
          if (!found.ok) {
            toast(found.message);
            return;
          }
          close({ ok: true, location: found.location });
        });
      });
      $('#loc-ok').addEventListener('click', () => {
        const chosen = document.querySelector('input[name="loc-pick"]:checked')?.value ?? '';
        if (chosen) {
          const found = locations.find((row) => row.id === chosen) ?? null;
          if (found) {
            close({ ok: true, location: found });
            return;
          }
        }
        const lat = Number($('#loc-lat').value);
        const lng = Number($('#loc-lng').value);
        const typed = $('#loc-lat').value.trim() !== '' || $('#loc-lng').value.trim() !== '';
        if (typed) {
          if (!locationCoordsOk({ latitude: lat, longitude: lng })) {
            toast('Esas coordenadas no son válidas (latitud −90…90, longitud −180…180).');
            return;
          }
          close({ ok: true, location: { latitude: lat, longitude: lng, name: null, address: null, source: 'manual_coordinates' } });
          return;
        }
        close({ ok: true, location: null });
      });
      void conversationId;
    });
  }

  /**
   * ENVIAR UNA UBICACIÓN por WhatsApp: elegir → previsualizar → CONFIRMAR (§18/§19).
   * El servidor exige `confirmed: true`, así que aquí no hay atajo posible.
   */
  async function openSendLocation({ conversationId, customerId }) {
    const elegida = await openLocationPicker({ customerId, conversationId, title: 'Enviar ubicación' });
    if (!elegida?.ok || !elegida.location) {
      if (elegida?.ok) toast('No se eligió ninguna ubicación');
      return;
    }
    const location = elegida.location;
    const url = locationMapUrl(location);
    openSheet(
      'Confirmar envío',
      `
      <p class="rule">Vas a enviar esta ubicación al cliente por WhatsApp. No se envía nada hasta que pulses «Enviar ubicación».</p>
      ${locationChip(location, { withActions: false })}
      ${url ? `<a class="btn btn--ghost btn--block" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Abrir en el mapa</a>` : ''}
      <button class="btn btn--primary btn--block" id="loc-send" type="button">Enviar ubicación</button>
      <button class="btn btn--ghost btn--block" id="loc-send-cancel" type="button">Cancelar</button>
      `,
    );
    $('#loc-send-cancel').addEventListener('click', () => closeSheet());
    $('#loc-send').addEventListener('click', async (event) => {
      await working(event.currentTarget, 'Enviando…', async () => {
        try {
          await api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/location`, {
            method: 'POST',
            body: JSON.stringify({
              locationId: location.id ?? undefined,
              latitude: location.latitude,
              longitude: location.longitude,
              name: location.name ?? undefined,
              address: location.address ?? undefined,
              source: location.source ?? 'browser_geolocation',
              confirmed: true,
              idempotencyKey: uploadKey('loc'),
            }),
          });
          toast('Ubicación enviada');
          closeSheet();
          await loadWaThread(conversationId, { force: true });
        } catch (error) {
          if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo enviar la ubicación');
        }
      });
    });
  }

  /**
   * COMPARTIR una ubicación con OTRA conversación (§20/§21).
   *
   * Deliberado y avisado: se dice con QUIÉN se comparte y se exige confirmación.
   * No se copia nada más del cliente original: solo la ubicación.
   *
   * Y SIEMPRE SE PUEDE. Dentro de la ventana de 24 h viaja como ubicación de
   * WhatsApp; fuera de ella WhatsApp ya no deja mandar ubicaciones, así que se
   * manda una plantilla aprobada con el enlace del mapa dentro. El panel dice
   * antes de enviar cuál de las dos cosas va a pasar.
   */
  async function openShareLocation({ locationId, location }) {
    const destinations = (state.conversations ?? []).filter((row) => row.id && row.customer);
    if (!destinations.length) {
      toast('No hay conversaciones con las que compartir');
      return;
    }
    // La ventana de 24 h se calcula con el último mensaje QUE ESCRIBIÓ el cliente.
    const ventanaAbierta = (row) => {
      const ultimo = Date.parse(row?.last_inbound_at ?? '');
      return Number.isFinite(ultimo) && Date.now() - ultimo < 24 * 60 * 60 * 1000;
    };
    openSheet(
      'Compartir ubicación',
      `
      <p class="rule rule--warn">Esta ubicación puede ser el domicilio de otra persona: solo se comparte la ubicación, nada más del cliente original.</p>
      ${locationChip(location, { withActions: false })}
      <label class="field">
        <span class="field__label">Compartir con</span>
        <select class="field__select" id="loc-share-to">
          ${destinations
            .map(
              (row) =>
                `<option value="${escapeHtml(row.id)}">${escapeHtml(waDisplayName(row))} · ${
                  ventanaAbierta(row) ? 'puede recibir la ubicación' : 'por plantilla (24 h cerradas)'
                }</option>`,
            )
            .join('')}
        </select>
      </label>
      <p class="view__hint" id="loc-share-warning"></p>
      <button class="btn btn--primary btn--block" id="loc-share-ok" type="button">Compartir ubicación</button>
      <button class="btn btn--ghost btn--block" id="loc-share-cancel" type="button">Cancelar</button>
      `,
    );
    const destinoElegido = () => destinations.find((candidate) => candidate.id === $('#loc-share-to').value) ?? null;
    const refreshWarning = () => {
      const row = destinoElegido();
      const boton = $('#loc-share-ok');
      const aviso = $('#loc-share-warning');
      if (!row) {
        if (aviso) aviso.textContent = 'Elige un destinatario.';
        return;
      }
      const dentro = ventanaAbierta(row);
      if (boton) boton.textContent = dentro ? 'Compartir ubicación' : 'Enviar por plantilla (enlace del mapa)';
      if (aviso) {
        aviso.textContent = dentro
          ? `Vas a compartir esta ubicación con ${waDisplayName(row)}. La recibirá como ubicación de WhatsApp.`
          : `${waDisplayName(row)} no ha escrito en las últimas 24 h: WhatsApp ya no deja enviar ubicaciones. Se le mandará una plantilla aprobada con el ENLACE del mapa.`;
      }
    };
    $('#loc-share-to').addEventListener('change', refreshWarning);
    refreshWarning();
    $('#loc-share-cancel').addEventListener('click', () => closeSheet());
    $('#loc-share-ok').addEventListener('click', async (event) => {
      const row = destinoElegido();
      const destination = row?.id ?? '';
      // Confirmación EXPLÍCITA con el nombre del destino (§21).
      if (!row || !window.confirm(`¿Compartir esta ubicación con ${waDisplayName(row)}?`)) return;
      const dentro = ventanaAbierta(row);
      await working(event.currentTarget, 'Compartiendo…', async () => {
        try {
          const result = await api(`/api/admin/locations/${encodeURIComponent(locationId)}/share`, {
            method: 'POST',
            body: JSON.stringify({
              conversationId: destination,
              confirmed: true,
              mode: dentro ? 'location' : 'template',
            }),
          });
          toast(result?.mode === 'template' ? 'Ubicación enviada por plantilla (enlace del mapa)' : 'Ubicación compartida');
          closeSheet();
          if (state.wa.selectedId) await loadWaThread(state.wa.selectedId, { force: true });
        } catch (error) {
          if (error.message === 'unauthorized') return;
          /*
           * La ventana pudo cerrarse entre la comprobación y el envío: el servidor
           * lo dice y aquí se cambia el botón para mandarlo por plantilla, en vez
           * de dejar al operador con un «no se pudo».
           */
          if (error.body?.canUseTemplate) {
            const boton = $('#loc-share-ok');
            if (boton) boton.textContent = 'Enviar por plantilla (enlace del mapa)';
            const aviso = $('#loc-share-warning');
            if (aviso) aviso.textContent = error.body.message;
            toast('Se puede mandar por plantilla: pulsa otra vez para enviarla con el enlace');
            return;
          }
          toast(error.body?.message ?? 'No se pudo compartir la ubicación');
        }
      });
    });
  }

  /** Acciones de una ubicación: lo esencial a la vista y el resto en «⋯» (§12). */
  function openLocationActions({ location, conversationId }) {
    const url = locationMapUrl(location);
    const dibujable = Boolean(mapLatLng(location));
    openSheet(
      'Ubicación',
      `
      ${locationChip(location, { withActions: false })}
      ${
        dibujable
          ? '<button class="btn btn--primary btn--block" id="loc-map" type="button">Ver el mapa</button>'
          : '<p class="rule rule--warn">Esta ubicación no trae coordenadas legibles.</p>'
      }
      <button class="btn btn--ghost btn--block" id="loc-use" type="button">Usar para un pedido</button>
      <button class="btn btn--ghost btn--block" id="loc-attach" type="button">Agregar a un pedido abierto</button>
      <button class="btn btn--ghost btn--block" id="loc-share" type="button">Compartir con otra conversación</button>
      ${
        url
          ? `<a class="btn btn--ghost btn--block" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Abrir en Google Maps</a>`
          : ''
      }
      <button class="btn btn--ghost btn--block" id="loc-close" type="button">Cerrar</button>
      `,
    );
    $('#loc-close').addEventListener('click', () => closeSheet());
    $('#loc-map')?.addEventListener('click', () => {
      closeSheet();
      openMapScreen({ location, title: 'Ubicación', conversationId: conversationId ?? state.wa.selectedId ?? '' });
    });
    $('#loc-use').addEventListener('click', () => {
      const customerId = state.wa.chat?.customer?.id ?? location?.customer_id ?? null;
      closeSheet();
      if (!customerId) {
        toast('Abre la conversación del cliente para crearle un pedido');
        return;
      }
      openOrderForm({ customerId, conversationId: conversationId ?? state.wa.selectedId ?? '', location });
    });
    $('#loc-attach')?.addEventListener('click', () => {
      const customerId = state.wa.chat?.customer?.id ?? location?.customer_id ?? null;
      closeSheet();
      openAttachLocationToOrder({ location, customerId });
    });
    $('#loc-share').addEventListener('click', () => {
      closeSheet();
      openShareLocation({ locationId: location.id, location });
    });
  }

  /**
   * COLGAR UN DATO (la ubicación) DE UN PEDIDO QUE YA EXISTE.
   *
   * El cliente manda la ubicación después de pedir, o la corrige: hay que poder
   * ponérsela al pedido que YA está en marcha, sin crear otro. Solo se ofrecen los
   * pedidos vivos (ni entregados ni cancelados): cambiar la dirección de un pedido
   * ya entregado sería reescribir la historia.
   */
  function openAttachLocationToOrder({ location, customerId }) {
    const id = customerId ?? location?.customer_id ?? state.wa.chat?.customer?.id ?? null;
    const pedidos = id ? liveOrdersForCustomer(id) : [];
    if (!pedidos.length) {
      toast('Ese cliente no tiene pedidos sin cerrar: créale uno con «Usar para un pedido»');
      return;
    }
    openSheet(
      'Agregar a un pedido',
      `
      ${locationChip(location, { withActions: false })}
      <div class="menu-list">
        ${pedidos
          .map(function (item) {
            const conUbicacion = Boolean(itemOrder(item)?.delivery?.location);
            return `<button class="menu-item" data-order-attach-loc="${escapeHtml(
              item.id,
            )}" data-attach-location="${escapeHtml(location?.id ?? '')}" type="button">
          <span class="menu-item__icon" aria-hidden="true">${ICONS.bag}</span>
          <span><strong>${escapeHtml(item.order_number ?? item.id)}</strong><small>${escapeHtml(
            statusLabel(item.status ?? 'nuevo'),
          )}${orderTotalOf(item) ? ` · ${escapeHtml(orderTotalOf(item))}` : ''} · ${
            conUbicacion ? 'ya tiene ubicación (se reemplaza)' : 'sin ubicación'
          }</small></span>
        </button>`;
          })
          .join('')}
      </div>`,
      { variant: 'menu' },
    );
  }

  /** Pone la ubicación en el pedido elegido: PATCH del pedido, sin crear otro. */
  async function attachLocationToOrder(orderId, locationId, button) {
    if (!orderId || !locationId) return;
    await working(button, 'Agregando…', async () => {
      try {
        await api(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ deliveryLocation: locationId }),
        });
        toast('Ubicación agregada al pedido');
        closeSheet();
        await load({ keepTab: true });
      } catch (error) {
        if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo agregar la ubicación');
      }
    });
  }

  /*
   * ============================ MAPAS DE UBICACIONES ==========================
   *
   * Lo que pidió el negocio, en tres piezas que van juntas:
   *
   *   1. EL MAPA SE ABRE AQUÍ DENTRO. Ver dónde está un cliente no puede sacarte
   *      del panel: la ubicación se dibuja en la propia app (misma hoja, mismo
   *      lenguaje visual que el mapa de reparto). Google Maps queda como enlace
   *      secundario, para compartir o para el navegador de siempre.
   *   2. LOS PUNTOS SE GUARDAN SOLOS. Cada ubicación que manda un cliente por
   *      WhatsApp queda guardada con su cliente y con su conversación (eso ya lo
   *      hacía el CRM), así que un pedido y su mapa se pueden volver a abrir
   *      siempre, sin depender del chat.
   *   3. «MAPA DE PEDIDOS»: una pantalla con TODOS los pedidos y TODAS las
   *      ubicaciones de los clientes, que se refresca sola cuando llega una
   *      ubicación nueva y sabe medir distancias.
   */

  /** Coordenadas numéricas de cualquier punto (ubicación, pedido o marcador). */
  function mapLatLng(point) {
    const lat = Number(point?.latitude ?? point?.lat);
    const lng = Number(point?.longitude ?? point?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
  }

  /**
   * Distancia en METROS entre dos puntos (línea recta, fórmula del haversine).
   *
   * Es la distancia REAL en línea recta, no la de la carretera: el panel lo dice
   * tal cual donde la enseña, porque prometer «12 min en coche» sin un servicio
   * de rutas sería inventarse un dato.
   */
  function metersBetween(a, b) {
    const uno = mapLatLng(a);
    const dos = mapLatLng(b);
    if (!uno || !dos) return null;
    const radio = 6371000;
    const rad = (grados) => (grados * Math.PI) / 180;
    const dLat = rad(dos[0] - uno[0]);
    const dLng = rad(dos[1] - uno[1]);
    const h =
      Math.sin(dLat / 2) ** 2 + Math.cos(rad(uno[0])) * Math.cos(rad(dos[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * radio * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** «850 m» / «12,4 km»: la distancia se lee como se habla, no como un decimal. */
  function fmtDistance(meters) {
    const value = Number(meters);
    if (!Number.isFinite(value)) return '';
    if (value < 1000) return `${Math.round(value)} m`;
    const km = value / 1000;
    return `${km < 10 ? km.toFixed(1).replace('.', ',') : String(Math.round(km))} km`;
  }

  /**
   * TIEMPO ESTIMADO de viaje, a partir de la distancia EN LÍNEA RECTA.
   *
   * Se calcula con una velocidad media A LA VISTA (25 km/h, una moto por ciudad) y
   * se dice cuál es: prometer «12 min» sin decir de dónde sale sería inventarse un
   * dato. La ruta real por carretera siempre es igual o más larga (y por tanto
   * más lenta) que la línea recta, así que el número es un PISO, no una promesa.
   */
  const MAP_AVG_SPEED_KMH = 25;

  function fmtEta(meters, speedKmh = MAP_AVG_SPEED_KMH) {
    const distancia = Number(meters);
    const velocidad = Number(speedKmh);
    if (!Number.isFinite(distancia) || !Number.isFinite(velocidad) || velocidad <= 0) return '';
    const minutos = (distancia / 1000 / velocidad) * 60;
    if (!Number.isFinite(minutos)) return '';
    if (minutos < 1) return 'menos de 1 min';
    if (minutos < 60) return `${Math.max(1, Math.round(minutos))} min`;
    const horas = Math.floor(minutos / 60);
    const resto = Math.round(minutos % 60);
    return resto ? `${horas} h ${resto} min` : `${horas} h`;
  }

  /** Marcador del mapa: mismo lenguaje visual que el mapa del reparto. */
  function mapMarkerIcon(kind) {
    if (!window.L) return null;
    const clase =
      kind === 'order'
        ? 'delivery'
        : kind === 'me'
          ? 'me'
          : kind === 'measure'
            ? 'measure'
            : kind === 'focus'
              ? 'focus'
              : 'customer';
    return window.L.divIcon({
      className: `delivery-leaflet-marker delivery-leaflet-marker--${clase}`,
      html: `<span>${kind === 'order' ? ICONS.box : ICONS.pin}</span>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
      popupAnchor: [0, -18],
    });
  }

  /** «hace un rato» de un punto, sin inventarse fechas. */
  const mapWhen = (value) => (value ? fmtWhen(value) : 'sin fecha');

  /**
   * Ubicación «viajera» dentro de un atributo: así cualquier hoja (la factura, la
   * ficha, el chat) puede abrir el mapa AQUÍ DENTRO sin volver a pedir los datos.
   */
  function mapLocationAttr(location) {
    if (!mapLatLng(location)) return '';
    return escapeHtml(
      JSON.stringify({
        id: location.id ?? null,
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
        name: location.name ?? null,
        address: location.address ?? null,
        source: location.source ?? null,
        customer_id: location.customer_id ?? null,
      }),
    );
  }

  function mapLocationFromAttr(value) {
    try {
      return JSON.parse(value ?? '');
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------- el mapa único

  /**
   * ABRIR UNA UBICACIÓN = IR A LA PANTALLA DEL MAPA, centrada en ese punto.
   *
   * Antes esto abría una hoja con su PROPIO mapa (dos mapas distintos en la app).
   * Ahora hay una sola pantalla de mapa y este atajo la usa: deja el mapa grande
   * centrado en el punto, con su ficha de acciones encima. Cualquier cosa que
   * necesite un mapa (el chat, la ficha, la factura) pasa por aquí.
   */
  function openMapScreen({ location = null, title = 'Ubicación', conversationId = '', onUse = null } = {}) {
    const coords = mapLatLng(location);
    destroySheetWork();
    state.previousTab = state.tab === 'mapa' ? state.previousTab : state.tab;
    if (coords) state.ordersMap.focus = { location, title, conversationId, onUse };
    setTab('mapa');
    renderOrdersMap();
    if (coords) focusOrdersMapPoint({ latitude: coords[0], longitude: coords[1], location, title });
    if (location) openMapPointSheet({ location, title, conversationId, onUse });
  }

  /** Si había otra hoja con trabajo vivo (una grabadora), se cierra bien. */
  function destroySheetWork() {
    try {
      closeSheetCleanup?.();
    } catch {
      /* la limpieza de la hoja anterior nunca puede impedir abrir el mapa */
    }
    closeSheetCleanup = null;
  }

  /** Centra el mapa en un punto (y lo marca) sin abrir nada. */
  function focusOrdersMapPoint({ latitude, longitude, location = null, title = '' }) {
    const map = state.ordersMap.map ?? ensureOrdersMap();
    if (!map || !window.L) return;
    if (state.ordersMap.focusMarker) state.ordersMap.focusMarker.remove();
    state.ordersMap.focusMarker = window.L
      .marker([latitude, longitude], { icon: mapMarkerIcon('focus') })
      .addTo(map)
      .bindPopup(`<strong>${escapeHtml(title || locationTitle(location))}</strong>`)
      .openPopup();
    map.setView([latitude, longitude], Math.max(map.getZoom(), 16), { animate: false });
    state.ordersMap.autoFollow = false;
  }

  /** La ficha del punto enfocado: qué es y qué se puede hacer con él. */
  function openMapPointSheet({ location, title = 'Ubicación', conversationId = '', onUse = null }) {
    const url = locationMapUrl(location);
    openSheet(
      title,
      `
      ${locationChip(location, { withActions: false, withMap: false })}
      <p class="view__hint">El mapa está centrado en este punto, aquí detrás.</p>
      <div class="map-actions">
        <button class="btn btn--ghost btn--block" data-map-action="aqui" type="button">¿A qué distancia estoy?</button>
        <button class="btn btn--ghost btn--block" id="map-point-measure" type="button">Medir distancia desde aquí</button>
        <button class="btn btn--ghost btn--block" id="map-point-use" type="button">Usar para un pedido</button>
        <button class="btn btn--ghost btn--block" id="map-point-share" type="button">Compartir con otra conversación</button>
        ${
          url
            ? `<a class="btn btn--ghost btn--block" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Abrir en Google Maps</a>`
            : ''
        }
        <button class="btn btn--primary btn--block" data-close-sheet type="button">Cerrar</button>
      </div>
      `,
    );
    $('#map-point-measure')?.addEventListener('click', () => {
      closeSheet();
      ordersMapMeasureTo(location);
    });
    $('#map-point-use')?.addEventListener('click', () => {
      if (typeof onUse === 'function') {
        onUse();
        return;
      }
      const customerId = state.wa.chat?.customer?.id ?? location?.customer_id ?? null;
      if (!customerId) {
        toast('Abre la conversación o la ficha del cliente para crearle un pedido');
        return;
      }
      closeSheet();
      openOrderForm({ customerId, conversationId: conversationId || state.wa.selectedId || '', location });
    });
    $('#map-point-share')?.addEventListener('click', () => {
      if (!location?.id) {
        toast('Esta ubicación no está guardada: no se puede compartir');
        return;
      }
      closeSheet();
      openShareLocation({ locationId: location.id, location });
    });
  }

  // ---------------------------------------------------------- mapa de pedidos

  /** Última vista del mapa (para volver donde estabas, igual que en reparto). */
  function ordersMapSavedView() {
    try {
      const value = JSON.parse(localStorage.getItem(MAPS_VIEW_KEY) ?? 'null');
      const lat = Number(value?.center?.[0]);
      const lng = Number(value?.center?.[1]);
      const zoom = Number(value?.zoom);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(zoom)) return null;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || zoom < 1 || zoom > 19) return null;
      return { center: [lat, lng], zoom };
    } catch {
      return null;
    }
  }

  function saveOrdersMapView() {
    const map = state.ordersMap.map;
    if (!map) return;
    try {
      const center = map.getCenter();
      const zoom = map.getZoom();
      if (!Number.isFinite(center?.lat) || !Number.isFinite(zoom)) return;
      localStorage.setItem(
        MAPS_VIEW_KEY,
        JSON.stringify({ center: [Number(center.lat.toFixed(6)), Number(center.lng.toFixed(6))], zoom }),
      );
    } catch {
      /* la vista es una comodidad: si Storage falla, el mapa sigue */
    }
  }

  function mapCachedLocations() {
    try {
      const raw = JSON.parse(localStorage.getItem(MAPS_CACHE_KEY) ?? 'null');
      return Array.isArray(raw?.locations) ? raw.locations : [];
    } catch {
      return [];
    }
  }

  function cacheMapLocations(locations) {
    try {
      localStorage.setItem(
        MAPS_CACHE_KEY,
        JSON.stringify({ at: new Date().toISOString(), locations: locations.slice(0, 300) }),
      );
    } catch {
      /* sin caché se sigue igual: solo se pierde el pintado instantáneo */
    }
  }

  /**
   * TODOS los puntos: la ubicación de entrega de cada pedido y cada ubicación que
   * ha mandado un cliente. Se deduplica por clave para que un pedido con la misma
   * ubicación del cliente no salga dos veces.
   */
  function ordersMapPoints() {
    const puntos = [];
    const vistos = new Set();
    /** El mismo punto dos veces (el pedido y la ubicación guardada) estorba: se marca. */
    const puntosDePedido = new Set();
    const clavePunto = (customerId, lat, lng) => `${customerId ?? ''}:${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
    for (const item of state.items ?? []) {
      if (item.type !== 'order_intent') continue;
      const order = itemOrder(item);
      const location = order?.delivery?.location ?? null;
      const coords = mapLatLng(location);
      if (!coords) continue;
      const clave = `order:${item.id}`;
      vistos.add(clave);
      puntosDePedido.add(clavePunto(item.customer_id ?? order?.customer_id, coords[0], coords[1]));
      const variante = order?.items?.[0]?.variant_name ?? order?.items?.[0]?.variantName ?? item.variant_name ?? '';
      const cantidad = Number(order?.items?.[0]?.quantity ?? item.quantity ?? 1);
      // Quien va a recibir el pedido: sin el nombre, un mapa de pedidos no sirve
      // para repartir nada.
      const cliente = (state.customers ?? []).find((row) => row.id === (item.customer_id ?? order?.customer_id)) ?? null;
      // La entrega EN CURSO de ese pedido (si la hay) viaja con el punto: así la
      // lista del mapa enseña el GPS, la distancia y las acciones de la entrega.
      const session = deliverySessionForOrder(item.id);
      puntos.push({
        key: clave,
        kind: 'order',
        item,
        order,
        session,
        operational: getOrderOperationalStatus(order, session),
        orderId: item.id,
        orderNumber: order?.order_number ?? item.order_number ?? null,
        status: order?.status ?? item.status ?? null,
        customerId: item.customer_id ?? order?.customer_id ?? null,
        conversationId: order?.conversation_id ?? item.conversation_id ?? null,
        location,
        latitude: coords[0],
        longitude: coords[1],
        at: order?.created_at ?? item.received_at ?? null,
        title: order?.order_number ?? item.order_number ?? 'Pedido',
        detail: [
          cliente ? customerName(cliente) : null,
          variante ? `${variante} × ${cantidad}` : null,
          money(order?.total ?? item.total, order?.currency ?? item.currency),
        ]
          .filter(Boolean)
          .join(' · '),
        address: location?.address ?? null,
      });
    }
    for (const location of state.ordersMap.locations ?? []) {
      const coords = mapLatLng(location);
      if (!coords) continue;
      // El punto ya está puesto por un pedido (la misma entrega): no se repite.
      if (vistos.has(`order:${location.order_id}`)) continue;
      if (puntosDePedido.has(clavePunto(location.customer_id, coords[0], coords[1]))) continue;
      vistos.add(`loc:${location.id}`);
      puntos.push({
        key: `loc:${location.id}`,
        kind: 'location',
        locationId: location.id,
        location,
        customerId: location.customer_id ?? null,
        conversationId: location.conversation_id ?? null,
        orderId: location.order_id ?? null,
        latitude: coords[0],
        longitude: coords[1],
        at: location.created_at ?? null,
        title: location.customer_name ?? locationTitle(location),
        detail: [locationTitle(location), location.age_label ?? mapWhen(location.created_at)]
          .filter(Boolean)
          .join(' · '),
        address: location.address ?? null,
      });
    }
    return puntos;
  }

  const MAPS_FILTER_LABEL = { todo: 'Todo', pedidos: 'Pedidos', envivo: 'En vivo', ubicaciones: 'Ubicaciones', hoy: 'De hoy' };

  /** ¿Ese pedido tiene una entrega EN CURSO ahora mismo? */
  function orderHasLiveSession(orderId) {
    return (state.deliveryTracking ?? []).some((row) => row.order_id === orderId && row.status === 'ACTIVE');
  }

  function ordersMapVisiblePoints() {
    const puntos = ordersMapPoints();
    const capas = state.ordersMap.layers ?? { orders: true, locations: true, live: true };
    const visibles = puntos.filter(
      (point) => (point.kind === 'order' ? capas.orders : capas.locations),
    );
    const filtro = state.ordersMap.filter ?? 'todo';
    if (filtro === 'pedidos') return visibles.filter((point) => point.kind === 'order');
    if (filtro === 'ubicaciones') return visibles.filter((point) => point.kind === 'location');
    if (filtro === 'envivo') return visibles.filter((point) => point.kind === 'order' && orderHasLiveSession(point.orderId));
    if (filtro === 'hoy') {
      const arranque = new Date();
      arranque.setHours(0, 0, 0, 0);
      return visibles.filter((point) => {
        const cuando = Date.parse(point.at ?? '');
        return Number.isFinite(cuando) && cuando >= arranque.getTime();
      });
    }
    return visibles;
  }

  /** Distancia de un punto al punto de referencia (si hay uno fijado). */
  function ordersMapDistance(point) {
    if (!state.ordersMap.refPoint) return null;
    return metersBetween(state.ordersMap.refPoint, point);
  }

  function ordersMapPopup(point) {
    const meters = ordersMapDistance(point);
    const partes = [
      `<strong>${escapeHtml(point.title)}</strong>`,
      point.detail ? escapeHtml(point.detail) : '',
      point.address ? escapeHtml(point.address) : '',
      point.at ? escapeHtml(mapWhen(point.at)) : '',
      meters !== null ? `A ${escapeHtml(fmtDistance(meters))} de ti (línea recta, unos ${escapeHtml(fmtEta(meters))})` : '',
    ].filter(Boolean);
    const acciones = [
      `<button class="btn btn--ghost btn--sm" data-map-open="${escapeHtml(point.key)}" type="button">Ver aquí dentro</button>`,
      `<button class="btn btn--ghost btn--sm" data-map-measure-point="${escapeHtml(point.key)}" type="button">Medir desde aquí</button>`,
      point.conversationId
        ? `<button class="btn btn--ghost btn--sm" data-map-chat="${escapeHtml(point.conversationId)}" type="button">Abrir el chat</button>`
        : '',
    ]
      .filter(Boolean)
      .join('');
    return `<div class="map-popup">${partes
      .map((linea) => `<span class="map-popup__line">${linea}</span>`)
      .join('')}<span class="map-popup__actions">${acciones}</span></div>`;
  }

  /**
   * EL MAPA DE LA PANTALLA (uno solo para todo).
   *
   * Antes había DOS instancias de Leaflet (la de Delivery y la del mapa de
   * pedidos). Ahora hay una y las entregas en vivo se dibujan ENCIMA: mismos
   * tiles, misma caché, un solo sitio donde mirar. `ensureDeliveryMap` sigue
   * existiendo porque es el nombre que usan los controles de entrega: devuelve
   * EXACTAMENTE este mismo mapa.
   */
  function ensureOrdersMap() {
    const el = $('#orders-map');
    /*
     * Sin Leaflet (o con la pantalla sin montar) no hay mapa posible: se dice en
     * el propio aviso de la pantalla en vez de dejar un hueco mudo. La lista de
     * pedidos y ubicaciones sigue funcionando igual, con sus distancias.
     */
    if (el && !window.L) setDeliveryMapNotice('No se pudo cargar el mapa');
    if (!el || !window.L) return null;
    if (el.closest('[hidden]')) return null; // la pantalla no está abierta: no se gasta memoria
    if (state.ordersMap.map && state.ordersMap.map.getContainer?.() === el) return state.ordersMap.map;
    if (state.ordersMap.map) resetOrdersMap();
    /*
     * Si el contenedor quedó a medio montar por un error anterior (p. ej. al
     * añadir la capa), Leaflet se niega a inicializarlo otra vez («Map container is
     * already initialized») y la pantalla se quedaba muerta para siempre. Se limpia
     * la marca y se reintenta UNA vez: un fallo puntual no puede matar el mapa.
     */
    const crearMapa = () => window.L.map(el, { zoomControl: true, attributionControl: true });
    let map;
    try {
      map = crearMapa();
    } catch {
      try {
        delete el._leaflet_id;
      } catch {
        /* el contenedor no admite la limpieza */
      }
      map = crearMapa();
    }
    /*
     * La capa base (satélite o mapa) con su aviso honesto: si los tiles tardan o
     * fallan se dice en la propia pantalla, y el GPS de las entregas sigue igual.
     * La VISTA se fija antes de montar la capa: así la capa ya sabe en qué zona
     * está (el techo de imagen real se decide por zona) y no se le pregunta el
     * centro a un mapa que todavía no tiene vista.
     */
    const vista = ordersMapSavedView();
    map.setView(vista?.center ?? [18.6157, -68.7071], vista?.zoom ?? 12);
    maybePrefetchDeliveryTiles('map-opened');
    addOrdersMapBase(map);
    map.on('moveend zoomend', saveOrdersMapView);
    map.on('zoomend', updateOrdersMapZoomHint);
    // Al parar de mover (o al acercarse) se comprueba el techo de la zona si es nueva.
    map.on('moveend', maybeProbeOrdersMapNative);
    map.on('zoomend', maybeProbeOrdersMapNative);
    map.on('click', (event) => ordersMapMapClick(event.latlng));
    // Al moverlo a mano se deja de seguir al repartidor (como en cualquier mapa).
    map.on('dragstart zoomstart', () => {
      state.deliveryMap.autoFollow = false;
      state.deliveryMap.userPanned = true;
      updateDeliveryFloatingState();
    });
    // El aviso del mapa (tiles lentos, medición…) vive en la propia pantalla.
    if (state.ordersMap.refPoint) addOrdersMapRefMarker();
    state.ordersMap.map = map;
    setTimeout(() => map.invalidateSize(), 0);
    // Primera comprobación de la zona que se abre (un tile, y ya).
    if (state.ordersMap.baseLayer?.options?.maxNativeZoom === MAP_NATIVE_DEFAULT_ZOOM) maybeProbeOrdersMapNative();
    return map;
  }

  function ensureDeliveryMap() {
    return ensureOrdersMap();
  }

  // ------------------------------------------------------- capas base del mapa

  /** Qué capa base está elegida (se recuerda en el teléfono). */
  function ordersMapBaseKey() {
    try {
      const guardada = localStorage.getItem(MAPS_BASE_KEY);
      if (guardada && MAP_BASE_LAYERS[guardada]) return guardada;
    } catch {
      /* sin almacén se usa la de por defecto */
    }
    return MAP_DEFAULT_BASE;
  }

  const ordersMapBaseConfig = (key = state.ordersMap.base) => MAP_BASE_LAYERS[key] ?? MAP_BASE_LAYERS[MAP_DEFAULT_BASE];

  // ------------------------------------------- techo real de imagen, zona por zona

  /** Coordenadas -> tile (fórmula estándar de teselas web). */
  const tileX = (lng, z) => Math.floor(((Number(lng) + 180) / 360) * 2 ** z);
  const tileY = (lat, z) => {
    const rad = (Number(lat) * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
  };

  /** Rellena una plantilla de tesela sin depender de las tripas de Leaflet. */
  function tileUrlFor(template, z, lat, lng) {
    return String(template)
      .replace('{s}', 'a')
      .replace('{z}', String(z))
      .replace('{x}', String(tileX(lng, z)))
      .replace('{y}', String(tileY(lat, z)));
  }

  /** Clave de la zona (celda) donde cae un punto. */
  const ordersMapZoneKey = (lat, lng) =>
    `${MAP_IMAGE_ZONE_ZOOM}/${tileX(lng, MAP_IMAGE_ZONE_ZOOM)}/${tileY(lat, MAP_IMAGE_ZONE_ZOOM)}`;

  /**
   * Centro del mapa SIN reventar.
   *
   * Leaflet lanza «Set map center and zoom first» si se le pide el centro antes de
   * fijar la vista, y eso pasa justo mientras se monta la capa base. Sin centro no
   * hay zona que comprobar: se devuelve null y el techo se queda en el seguro.
   */
  function ordersMapCenterOf(map) {
    try {
      const centro = map?.getCenter?.();
      if (Number.isFinite(Number(centro?.lat)) && Number.isFinite(Number(centro?.lng))) return centro;
    } catch {
      /* el mapa todavía no tiene vista */
    }
    return null;
  }

  /** Techo de imagen real ya comprobado en otras visitas (celda -> nivel). */
  function ordersMapNativeStore() {
    try {
      const crudo = JSON.parse(localStorage.getItem(MAP_NATIVE_STORE_KEY) ?? 'null');
      return crudo && typeof crudo === 'object' ? crudo : {};
    } catch {
      return {};
    }
  }

  function ordersMapNativeRemember(clave, zoom) {
    try {
      const store = ordersMapNativeStore();
      store[clave] = { z: zoom, at: new Date().toISOString() };
      const recortado = Object.entries(store).slice(-MAP_NATIVE_STORE_MAX);
      localStorage.setItem(MAP_NATIVE_STORE_KEY, JSON.stringify(Object.fromEntries(recortado)));
    } catch {
      /* sin almacén se comprueba otra vez y ya está */
    }
  }

  function ordersMapNativeSaved(clave) {
    const guardado = ordersMapNativeStore()[clave];
    if (!guardado || !Number.isFinite(Number(guardado.z))) return null;
    const edad = Date.now() - Date.parse(guardado.at ?? 0);
    if (!Number.isFinite(edad) || edad > MAP_NATIVE_TTL_MS) return null;
    return Number(guardado.z);
  }

  /**
   * Hasta qué nivel el mapa tiene IMAGEN REAL en la zona que se está mirando.
   *
   * Nunca devuelve más de lo comprobado: sin dato, el techo seguro (18, que tiene
   * imagen en todo el país). Con dato, lo que se midió en esa celda.
   */
  function ordersMapNativeZoom(punto = null) {
    const config = ordersMapBaseConfig();
    if (!config.probe) return config.maxNativeZoom;
    const centro = punto ?? ordersMapCenterOf(state.ordersMap.map);
    if (!centro || !Number.isFinite(Number(centro.lat)) || !Number.isFinite(Number(centro.lng))) {
      return state.ordersMap.nativeZoom ?? MAP_NATIVE_DEFAULT_ZOOM;
    }
    const clave = ordersMapZoneKey(centro.lat, centro.lng);
    const guardado = ordersMapNativeSaved(clave);
    if (guardado !== null) return Math.min(guardado, MAP_NATIVE_MAX_ZOOM);
    // La zona que se está mirando ya se comprobó en esta sesión.
    if (state.ordersMap.nativeZoom !== null && state.ordersMap.zone === clave) return state.ordersMap.nativeZoom;
    /*
     * Zona NUEVA sin comprobar: se usa el techo seguro (18, que tiene imagen real en
     * todo el país) hasta que responda la comprobación. Al revés —heredar el 19 de la
     * zona anterior— el mapa pediría tiles del 19 en un sitio que no los tiene y se
     * vería el mosaico gris un instante. Primero imagen real; el 19, si toca.
     */
    return MAP_NATIVE_DEFAULT_ZOOM;
  }

  /**
   * COMPROBAR EL TECHO DE LA ZONA: se pide UN tile del nivel 19 del centro que se
   * está mirando y se mira si es foto o el relleno de "aquí no hay imagen".
   *
   * Una vez por zona (y por mes, que la imagen cambia con los años). Si la foto
   * existe, el techo sube a 19 y el mapa se repinta con esa capa; si no, se queda
   * en 18 y el aviso lo dirá al acercarse. Nunca se sube el techo por optimismo.
   */
  async function probeOrdersMapNative() {
    const config = ordersMapBaseConfig();
    const map = state.ordersMap.map;
    if (!config.probe || !map || state.tab !== 'mapa') return null;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
    const centro = ordersMapCenterOf(map);
    if (!centro) return null;
    const clave = ordersMapZoneKey(centro.lat, centro.lng);
    if (state.ordersMap.probing === clave) return null; // ya hay una comprobación en vuelo
    const guardado = ordersMapNativeSaved(clave);
    if (guardado !== null) return guardado;
    state.ordersMap.probing = clave;
    try {
      const res = await fetch(tileUrlFor(config.url, MAP_NATIVE_MAX_ZOOM, centro.lat, centro.lng));
      if (!res?.ok) return null;
      const cuerpo =
        typeof res.arrayBuffer === 'function' ? await res.arrayBuffer() : await res.blob?.();
      const bytes = Number(cuerpo?.byteLength ?? cuerpo?.size ?? 0);
      // El relleno de "sin imagen" pesa 2,5 KB y es SIEMPRE el mismo archivo; una
      // foto real, como poco 5,4 KB. Por debajo del umbral, ese nivel no existe.
      const nivel = bytes >= MAP_MIN_REAL_TILE_BYTES ? MAP_NATIVE_MAX_ZOOM : MAP_NATIVE_DEFAULT_ZOOM;
      ordersMapNativeRemember(clave, nivel);
      if (state.tab !== 'mapa' || !state.ordersMap.map) return nivel;
      const aplicado = Number(state.ordersMap.baseLayer?.options?.maxNativeZoom ?? 0);
      state.ordersMap.nativeZoom = nivel;
      state.ordersMap.zone = clave;
      // Si el techo de ESTA zona no es el que está puesto (sube o baja), se repinta
      // la capa de imagen: así se aprovecha el 19 donde lo hay y se deja de pedir
      // donde no (que es lo que sacaba el mosaico gris).
      if (nivel !== aplicado) {
        addOrdersMapBase(state.ordersMap.map);
      }
      updateOrdersMapZoomHint();
      return nivel;
    } catch {
      // Sin red no se decide nada: el techo seguro se queda como está.
      return null;
    } finally {
      if (state.ordersMap.probing === clave) state.ordersMap.probing = null;
    }
  }

  /** Comprobar como mucho una vez por zona, y solo cuando el mapa está quieto. */
  function maybeProbeOrdersMapNative() {
    const config = ordersMapBaseConfig();
    if (!config.probe) return;
    const map = state.ordersMap.map;
    if (!map) return;
    const centro = ordersMapCenterOf(map);
    if (!centro) return;
    /*
     * Lo primero: que la capa esté al techo que toca AHORA. Si se acaba de entrar
     * en una zona sin comprobar, baja al techo seguro (18) mientras se comprueba; si
     * no, el mapa pediría tiles del 19 en un sitio que no los tiene y se vería el
     * mosaico gris un instante.
     */
    syncOrdersMapNativeCeiling();
    const clave = ordersMapZoneKey(centro.lat, centro.lng);
    if (ordersMapNativeSaved(clave) !== null) return;
    if (state.ordersMap.probing === clave) return;
    if (state.ordersMap.probeTimer) clearTimeout(state.ordersMap.probeTimer);
    // Un respiro muy corto: si el operador está moviendo el mapa, no se comprueba
    // cada paso, pero la respuesta llega antes de que se note el techo conservador.
    state.ordersMap.probeTimer = setTimeout(() => {
      state.ordersMap.probeTimer = null;
      probeOrdersMapNative().catch(() => {});
    }, 250);
  }

  /**
   * Poner la capa de imagen en el techo que toca AHORA MISMO.
   *
   * Se llama al mover el mapa: si la zona es nueva, baja al techo seguro mientras
   * responde la comprobación (nunca se piden niveles a ciegas).
   */
  function syncOrdersMapNativeCeiling() {
    const config = ordersMapBaseConfig();
    const map = state.ordersMap.map;
    const capa = state.ordersMap.baseLayer;
    if (!config.probe || !map || !capa) return;
    const aplicado = Number(capa.options?.maxNativeZoom ?? 0);
    const toca = ordersMapNativeZoom(ordersMapCenterOf(map));
    if (toca !== aplicado) addOrdersMapBase(map);
  }

  /**
   * Pinta la capa base elegida (y sus etiquetas) sobre el mapa.
   *
   * No se recrea el mapa: se quita la capa de imagen y se pone la nueva, así los
   * marcadores, la medición y la entrega en vivo siguen donde estaban.
   */
  function addOrdersMapBase(map) {
    if (!map || !window.L) return;
    state.ordersMap.base = ordersMapBaseKey();
    const config = ordersMapBaseConfig();
    /* El techo no es una constante: es lo que se ha comprobado en ESTA zona. */
    const nativo = config.probe ? ordersMapNativeZoom(ordersMapCenterOf(map)) : config.maxNativeZoom;
    state.ordersMap.nativeZoom = config.probe ? nativo : null;
    state.ordersMap.baseLayer?.remove();
    state.ordersMap.labelLayer?.remove();
    state.ordersMap.labelLayer = null;
    state.ordersMap.labelReady = false;
    const capa = window.L.tileLayer(config.url, {
      ...MAP_TILE_TUNING,
      maxNativeZoom: nativo,
      maxZoom: config.maxZoom,
      attribution: config.attribution,
    });
    /*
     * Por debajo van los marcadores: la foto es el fondo, nunca tapa un pin.
     */
    capa.setZIndex?.(1);
    watchOrdersMapTiles(capa, `${config.label} no disponible`);
    capa.addTo(map);
    state.ordersMap.baseLayer = capa;
    if (config.labels && state.ordersMap.layers.labels) {
      const etiquetas = window.L.tileLayer(MAP_LABEL_LAYER.url, {
        ...MAP_TILE_TUNING,
        maxNativeZoom: MAP_LABEL_LAYER.maxNativeZoom,
        maxZoom: MAP_LABEL_LAYER.maxZoom,
        attribution: MAP_LABEL_LAYER.attribution,
        pane: 'overlayPane',
      });
      etiquetas.setZIndex?.(4);
      watchOrdersMapTiles(etiquetas, '');
      etiquetas.addTo(map);
      state.ordersMap.labelLayer = etiquetas;
      state.ordersMap.labelReady = true;
    }
    map.attributionControl?.setPrefix?.('');
    updateOrdersMapZoomHint();
    return capa;
  }

  /**
   * Un solo sitio para los avisos de los tiles: cargando, cargó, falló.
   *
   * `avisoFallo` vacío significa «no molestes con el fallo de esta capa» (las
   * etiquetas pueden faltar sin que el mapa deje de servir).
   */
  function watchOrdersMapTiles(layer, avisoFallo) {
    layer.on('loading', () => {
      state.deliveryMap.tileLoading += 1;
      setDeliveryMapNotice('Cargando el mapa…');
      startDeliveryTileSlowTimer();
    });
    layer.on('load', () => {
      state.deliveryMap.tileLoading = Math.max(0, state.deliveryMap.tileLoading - 1);
      stopDeliveryTileSlowTimer();
      // Se limpia el aviso de carga y `refreshOrdersMapNotice()` decide: si hay una
      // medición o un aviso de ampliación, se siguen viendo ellos.
      if (!state.deliveryMap.tileError) setDeliveryMapNotice('');
    });
    layer.on('tileerror', () => {
      state.deliveryMap.tileError = true;
      stopDeliveryTileSlowTimer();
      if (avisoFallo) setDeliveryMapNotice(avisoFallo);
    });
  }

  /**
   * «Ampliado»: cuando se pasa del zoom con imagen propia se dice, porque a partir
   * de ahí la foto se estira y se ve más grande pero NO más nítida. Prometer
   * detalle que no existe es justo lo que no se hace en este panel.
   */
  function updateOrdersMapZoomHint() {
    const map = state.ordersMap.map;
    const config = ordersMapBaseConfig();
    const anterior = state.ordersMap.zoomHint;
    if (!map || !config) return;
    const zoom = map.getZoom();
    // El techo es el de ESTA zona (medido), no una constante: donde no hay z19
    // real nunca se dice que lo hay, y donde sí, no se avisa de ampliación.
    const nativo = config.probe ? ordersMapNativeZoom(ordersMapCenterOf(map)) : config.maxNativeZoom;
    state.ordersMap.zoomHint =
      zoom > nativo
        ? `${config.label}: ampliado (aquí la imagen real llega al nivel ${nativo}; más cerca no gana detalle)`
        : '';
    if (state.ordersMap.zoomHint !== anterior) refreshOrdersMapNotice();
    const estado = $('#mapa-estado');
    if (estado) estado.textContent = ordersMapStatusText();
  }

  /** Cambiar de capa base: se recuerda y el mapa la pinta al momento. */
  function setOrdersMapBase(key) {
    if (!MAP_BASE_LAYERS[key] || key === state.ordersMap.base) return;
    state.ordersMap.base = key;
    try {
      localStorage.setItem(MAPS_BASE_KEY, key);
    } catch {
      /* la elección es una comodidad: sin almacén se queda en memoria */
    }
    state.deliveryMap.tileError = false;
    state.deliveryMap.tileLoading = 0;
    setDeliveryMapNotice('');
    addOrdersMapBase(state.ordersMap.map ?? ensureOrdersMap());
    renderOrdersMap();
    maybeProbeOrdersMapNative();
    toast(
      key === 'satelite'
        ? 'Satélite: foto real del terreno. Se comprueba sola hasta qué nivel hay imagen de verdad en cada zona'
        : 'Mapa de calles: más ligero para cuando la señal es mala',
    );
  }

  /** Encender y apagar las calles y los nombres sobre la foto. */
  function toggleOrdersMapLabels(force = null) {
    const activo = force === null ? !state.ordersMap.layers.labels : force;
    state.ordersMap.layers.labels = activo;
    try {
      localStorage.setItem(MAPS_LABELS_KEY, activo ? '1' : '0');
    } catch {
      /* se queda en memoria */
    }
    const map = state.ordersMap.map;
    if (!map || !window.L) return;
    if (activo && !state.ordersMap.labelLayer && ordersMapBaseConfig().labels) {
      const etiquetas = window.L.tileLayer(MAP_LABEL_LAYER.url, {
        ...MAP_TILE_TUNING,
        maxNativeZoom: MAP_LABEL_LAYER.maxNativeZoom,
        maxZoom: MAP_LABEL_LAYER.maxZoom,
        attribution: MAP_LABEL_LAYER.attribution,
      });
      etiquetas.setZIndex?.(4);
      watchOrdersMapTiles(etiquetas, '');
      etiquetas.addTo(map);
      state.ordersMap.labelLayer = etiquetas;
      return;
    }
    if (!activo && state.ordersMap.labelLayer) {
      state.ordersMap.labelLayer.remove();
      state.ordersMap.labelLayer = null;
    }
  }

  function resetOrdersMap() {
    for (const marker of state.ordersMap.markers.values()) marker.remove();
    state.ordersMap.measureLine?.remove();
    state.ordersMap.measureLine = null;
    state.ordersMap.measurePoints = [];
    for (const marker of state.ordersMap.measureMarkers ?? []) marker.remove();
    state.ordersMap.measureMarkers = [];
    for (const marker of [state.deliveryMap.customerMarker, state.deliveryMap.deliveryMarker]) marker?.remove();
    state.deliveryMap.customerMarker = null;
    state.deliveryMap.deliveryMarker = null;
    state.deliveryMap.routeLine?.remove();
    state.deliveryMap.routeLine = null;
    state.deliveryMap.sessionId = null;
    state.deliveryMap.destinationKey = null;
    state.deliveryMap.fitDone = false;
    if (state.ordersMap.map) {
      try {
        state.ordersMap.map.remove();
      } catch {
        /* ya estaba fuera del DOM */
      }
    }
    state.ordersMap.map = null;
    state.ordersMap.markers = new Map();
    state.ordersMap.refMarker = null;
    state.focusMarker = null;
    state.ordersMap.focusMarker = null;
    state.ordersMap.fitted = false;
    // Las capas de imagen se van con el mapa: aquí solo se olvidan las referencias.
    state.ordersMap.baseLayer = null;
    state.ordersMap.labelLayer = null;
    state.ordersMap.labelReady = false;
    state.ordersMap.zoomHint = '';
    // La comprobación de la zona es del mapa que se está desmontando.
    state.ordersMap.nativeZoom = null;
    state.ordersMap.zone = null;
    state.ordersMap.probing = null;
    if (state.ordersMap.probeTimer) clearTimeout(state.ordersMap.probeTimer);
    state.ordersMap.probeTimer = null;
    state.deliveryMap.tileLoading = 0;
    state.deliveryMap.tileError = false;
  }

  function addOrdersMapRefMarker() {
    const map = state.ordersMap.map;
    const coords = mapLatLng(state.ordersMap.refPoint);
    if (!map || !coords || !window.L) return;
    state.ordersMap.refMarker?.remove();
    state.ordersMap.refMarker = window.L
      .marker(coords, { icon: mapMarkerIcon('me') })
      .addTo(map)
      .bindPopup('Tu ubicación (punto de referencia)');
  }

  /** Pinta los marcadores SIN recrear el mapa (así no parpadea al refrescar). */
  function syncOrdersMapMarkers() {
    const visibles = ordersMapVisiblePoints();
    const map = state.ordersMap.map ?? ensureOrdersMap();
    if (!map || !window.L) return;
    const vivos = new Set();
    for (const point of visibles) {
      vivos.add(point.key);
      const existente = state.ordersMap.markers.get(point.key);
      const html = ordersMapPopup(point);
      if (existente) {
        existente.setLatLng([point.latitude, point.longitude]);
        existente.setPopupContent(html);
        continue;
      }
      const marker = window.L
        .marker([point.latitude, point.longitude], {
          icon: mapMarkerIcon(point.kind),
          title: point.title,
        })
        .addTo(map)
        .bindPopup(html);
      state.ordersMap.markers.set(point.key, marker);
    }
    for (const [key, marker] of [...state.ordersMap.markers]) {
      if (vivos.has(key)) continue;
      marker.remove();
      state.ordersMap.markers.delete(key);
    }
    if (!state.ordersMap.fitted && visibles.length) {
      fitOrdersMap();
      state.ordersMap.fitted = true;
    }
  }

  /** «Ver todo»: encuadra TODOS los puntos visibles de una vez. */
  function fitOrdersMap() {
    const map = state.ordersMap.map;
    const puntos = ordersMapVisiblePoints().map((point) => [point.latitude, point.longitude]);
    if (state.ordersMap.refPoint) {
      const mios = mapLatLng(state.ordersMap.refPoint);
      if (mios) puntos.push(mios);
    }
    if (!map || !window.L || !puntos.length) return;
    if (puntos.length === 1) map.setView(puntos[0], 15);
    else map.fitBounds(window.L.latLngBounds(puntos).pad(0.18), { padding: [30, 30], maxZoom: 16 });
  }

  /** Un toque en el mapa: en modo «medir» cada toque es un punto de la medición. */
  function ordersMapMapClick(latlng) {
    if (!state.ordersMap.measuring || !latlng || !window.L) return;
    const punto = { latitude: latlng.lat, longitude: latlng.lng };
    state.ordersMap.measurePoints.push(punto);
    if (state.ordersMap.measurePoints.length > 2) {
      state.ordersMap.measurePoints = state.ordersMap.measurePoints.slice(-2);
      for (const marker of state.ordersMap.measureMarkers ?? []) marker.remove();
      state.ordersMap.measureMarkers = [];
      state.ordersMap.measureLine?.remove();
      state.ordersMap.measureLine = null;
    }
    const map = state.ordersMap.map;
    state.ordersMap.measureMarkers = state.ordersMap.measureMarkers ?? [];
    state.ordersMap.measureMarkers.push(
      window.L.circleMarker([punto.latitude, punto.longitude], {
        radius: 7,
        color: '#0b6b4f',
        weight: 3,
        fillColor: '#ffffff',
        fillOpacity: 1,
      }).addTo(map),
    );
    const [uno, dos] = state.ordersMap.measurePoints;
    if (uno && dos) {
      state.ordersMap.measureLine?.remove();
      state.ordersMap.measureLine = window.L
        .polyline(
          [
            [uno.latitude, uno.longitude],
            [dos.latitude, dos.longitude],
          ],
          { color: '#0b6b4f', weight: 3, dashArray: '6 8' },
        )
        .addTo(map);
      const metros = metersBetween(uno, dos);
      /*
       * El resultado se guarda en el estado (no solo se pinta): así la carga de
       * teselas no lo borra y sigue a la vista mientras se mira el mapa.
       */
      state.ordersMap.measureText = `Distancia ${fmtDistance(metros)} en línea recta · unos ${fmtEta(
        metros,
      )} a ${MAP_AVG_SPEED_KMH} km/h`;
      refreshOrdersMapNotice();
      return;
    }
    state.ordersMap.measureText = 'Toca el segundo punto en el mapa.';
    refreshOrdersMapNotice();
  }

  /**
   * «MEDIR DESDE AQUÍ»: mete las coordenadas de un punto YA conocido en la
   * medición.
   *
   * Es el gesto que de verdad se usa («¿a cuánto está este cliente?»): tocar el
   * pin para medir NO siempre cuenta como toque del mapa (Leaflet no deja pasar el
   * clic del marcador), así que el punto trae su propia acción, en el globo y en su
   * ficha.
   */
  function ordersMapMeasureTo(point) {
    const coords = mapLatLng(point);
    if (!coords) {
      toast('Ese punto no trae coordenadas');
      return;
    }
    if (!state.ordersMap.measuring) ordersMapToggleMeasure(true);
    ordersMapMapClick({ lat: coords[0], lng: coords[1] });
  }

  function ordersMapToggleMeasure(force = null) {
    const box = $('#orders-map');
    if (!box) return;
    const activo = force === null ? !state.ordersMap.measuring : force;
    state.ordersMap.measuring = activo;
    state.ordersMap.measurePoints = [];
    state.ordersMap.measureText = '';
    state.ordersMap.measureLine?.remove();
    state.ordersMap.measureLine = null;
    for (const marker of state.ordersMap.measureMarkers ?? []) marker.remove();
    state.ordersMap.measureMarkers = [];
    // El botón flotante se queda marcado mientras se está midiendo.
    $('#mapa-acciones')?.setAttribute('aria-pressed', String(activo));
    box.classList.toggle('map-view--measuring', activo);
    state.ordersMap.measureText = activo ? 'Toca dos puntos para medir la distancia (línea recta).' : '';
    refreshOrdersMapNotice();
    // Al salir de medir, el aviso vuelve a lo que tocaba (por ejemplo, si el zoom
    // está en modo ampliado, se recuerda).
    if (!activo) {
      const estado = $('#mapa-estado');
      if (estado) estado.textContent = ordersMapStatusText();
    }
  }

  /** «Mi ubicación»: punto de referencia del GPS, solo al pulsar el botón. */
  async function ordersMapUseMyLocation(button) {
    await working(button, 'Buscando…', async () => {
      const found = await getBrowserLocation();
      if (!found.ok) {
        toast(found.message);
        return;
      }
      closeSheet();
      state.ordersMap.refPoint = found.location;
      addOrdersMapRefMarker();
      renderOrdersMap();
      toast('Punto de referencia fijado: las distancias salen de aquí');
    });
  }

  /**
   * LO QUE SE PUEDE HACER CON UN PEDIDO, EN LA LISTA DEL MAPA.
   *
   * Es la misma lista de acciones que tenía la vista de Delivery (asignar,
   * iniciar, entregado, contactar), que ahora vive dentro del mapa: una sola
   * pantalla para mirar dónde está todo y para mover la entrega.
   */
  function mapOrderActionsHtml(point) {
    const item = point.item;
    const order = point.order ?? {};
    const session = point.session;
    const operational = point.operational ?? 'PENDIENTE';
    /*
     * QUIÉN ES «EL REPARTIDOR» AQUÍ: un agente (o repartidor) que NO gestiona el
     * reparto. El pedido se le pasa a un agente y ese agente lo entrega; el que
     * asigna (ADMIN, `delivery.tracking.manage_all`) no reparte, organiza.
     */
    const esRepartidor =
      ['AGENT', 'DELIVERY'].includes(String(currentUser()?.role ?? '').toUpperCase()) &&
      !hasPermission('delivery.tracking.manage_all');
    const assignedUserId = order.delivery?.delivery_user_id ?? '';
    const assignedName = order.delivery?.delivery_user_name_snapshot ?? null;
    const assignedToMe = Boolean(assignedUserId) && assignedUserId === currentUser()?.id;
    const canAssign = (state.deliveryUsers ?? []).length > 0;
    const hasDestination = Boolean(deliveryLatLng(order.delivery?.location));
    const canStart = operational === 'PENDIENTE' && hasDestination && (esRepartidor ? assignedToMe : true);
    const chat = point.conversationId
      ? `<button class="btn btn--ghost btn--sm" data-map-chat="${escapeHtml(point.conversationId)}" type="button">Chat</button>`
      : '';
    const centro = `<button class="btn btn--ghost btn--sm" data-map-center="${escapeHtml(point.key)}" type="button">Centrar</button>`;
    if (operational === 'EN_CAMINO' && session) {
      return `${chat}<button class="btn btn--ghost btn--sm" data-delivery-focus="${escapeHtml(session.id)}" type="button">Ver en vivo</button>${
        esRepartidor && assignedToMe
          ? `<button class="btn btn--primary btn--sm" data-delivery-complete="${escapeHtml(session.id)}" type="button">Entregado</button>`
          : ''
      }`;
    }
    if (esRepartidor && assignedToMe) {
      const contactar = !hasDestination && point.conversationId
        ? `<button class="btn btn--whatsapp btn--sm" data-delivery-contact="${escapeHtml(point.conversationId)}" data-delivery-ask="location" type="button">Solicitar ubicación</button>`
        : point.conversationId
          ? `<button class="btn btn--whatsapp btn--sm" data-delivery-contact="${escapeHtml(point.conversationId)}" type="button">Contactar</button>`
          : '';
      return `${contactar}<button class="btn btn--primary btn--sm" data-delivery-start="${escapeHtml(item.id)}" type="button" ${
        canStart ? '' : 'disabled'
      }>Iniciar entrega</button>`;
    }
    if (esRepartidor) return `${chat}<button class="btn btn--ghost btn--sm" type="button" disabled>No asignado</button>`;
    if (canAssign && operational === 'PENDIENTE' && !session) {
      return `${chat}<span class="delivery-assign"><select class="field__select" data-delivery-assign="${escapeHtml(
        item.id,
      )}" aria-label="Asignar a un agente">
        <option value="">${assignedName ? 'Cambiar de agente' : 'Asignar a un agente'}</option>
        ${(state.deliveryUsers ?? [])
          .map(
            (user) =>
              `<option value="${escapeHtml(user.id)}" ${user.id === assignedUserId ? 'selected' : ''}>${escapeHtml(
                user.display_name ?? user.username ?? 'Delivery',
              )}</option>`,
          )
          .join('')}
      </select></span>`;
    }
    return `${chat}${centro}`;
  }

  /** La lista de puntos (con su distancia si hay punto de referencia). */
  function ordersMapListHtml() {
    const puntos = ordersMapVisiblePoints();
    if (!puntos.length) {
      return `<p class="view__hint">${
        state.ordersMap.loading
          ? 'Buscando ubicaciones…'
          : state.ordersMap.filter === 'envivo'
            ? 'Ninguna entrega en curso ahora mismo.'
            : 'Todavía no hay puntos guardados. Cuando un cliente mande su ubicación por WhatsApp aparecerá aquí sola.'
      }</p>`;
    }
    const conDistancia = puntos
      .map((point) => ({ point, meters: ordersMapDistance(point) }))
      .sort((a, b) =>
        a.meters === null || b.meters === null
          ? String(b.point.at ?? '').localeCompare(String(a.point.at ?? ''))
          : a.meters - b.meters,
      );
    return conDistancia
      .map(({ point, meters }) => {
        const esPedido = point.kind === 'order';
        const vivo = esPedido && Boolean(point.session);
        const gps = vivo ? deliveryGpsLabel(point.session) : '';
        return `<article class="map-item ${esPedido ? 'map-item--order' : ''}${vivo ? ' map-item--live' : ''}">
          <button class="map-item__main" data-map-open="${escapeHtml(point.key)}" type="button">
            <strong>${escapeHtml(point.title)}</strong>
            <small>${escapeHtml(point.detail || point.address || 'Ubicación')}</small>
            <small class="map-item__meta">${
              esPedido
                ? `<span class="tag delivery-status delivery-status--${escapeHtml(
                    (point.operational ?? 'PENDIENTE').toLowerCase(),
                  )}">${escapeHtml(operationalStatusLabel(point.operational ?? 'PENDIENTE'))}</span>`
                : 'Ubicación del cliente'
            } · ${escapeHtml(mapWhen(point.at))}${meters !== null ? ` · <b>${escapeHtml(fmtDistance(meters))}</b>` : ''}</small>
            ${gps ? `<small class="map-item__gps">${escapeHtml(gps)}</small>` : ''}
          </button>
          <div class="map-item__actions">${esPedido ? mapOrderActionsHtml(point) : `${point.conversationId ? `<button class="btn btn--ghost btn--sm" data-map-chat="${escapeHtml(point.conversationId)}" type="button">Chat</button>` : ''}<button class="btn btn--ghost btn--sm" data-map-center="${escapeHtml(point.key)}" type="button">Centrar</button>`}</div>
        </article>`;
      })
      .join('');
  }

  /** Estado del mapa: cuántos puntos, entregas en vivo y cuándo se miró. */
  function ordersMapStatusText() {
    const puntos = ordersMapVisiblePoints();
    const pedidos = puntos.filter((point) => point.kind === 'order').length;
    const ubicaciones = puntos.length - pedidos;
    const activas = (state.deliveryTracking ?? []).filter((row) => row.status === 'ACTIVE').length;
    const base = ordersMapBaseConfig();
    const partes = [
      `${pedidos} pedido${pedidos === 1 ? '' : 's'}`,
      `${ubicaciones} ubicaci${ubicaciones === 1 ? 'ón' : 'ones'}`,
    ];
    if (activas) partes.push(`${activas} entrega${activas === 1 ? '' : 's'} en vivo`);
    if (state.ordersMap.refPoint) partes.push('distancias desde tu punto');
    /*
     * Con qué se está mirando el terreno y hasta qué nivel hay FOTO REAL aquí: el
     * operador ve de un vistazo si puede acercarse más o si ya está ampliando.
     */
    if (base) {
      const nativo = base.probe ? ordersMapNativeZoom(ordersMapCenterOf(state.ordersMap.map)) : base.maxNativeZoom;
      partes.push(base.probe ? `${base.label.toLowerCase()} (imagen z${nativo})` : base.label.toLowerCase());
    }
    if (state.ordersMap.zoomHint) partes.push('ampliado');
    if (state.ordersMap.loading) partes.push('actualizando…');
    else if (state.ordersMap.error) partes.push('sin conexión: se ve lo último guardado');
    else if (state.ordersMap.updatedAt) partes.push(`visto ${fmtWhen(state.ordersMap.updatedAt)}`);
    return partes.join(' · ');
  }

  /** Pantalla «Mapa y entregas»: filtros, mapa, entrega en vivo y lista. */
  function renderOrdersMap() {
    const box = $('#orders-map');
    if (!box) return;
    $$('[data-map-filter]').forEach((chip) =>
      chip.setAttribute('aria-pressed', String(chip.dataset.mapFilter === state.ordersMap.filter)),
    );
    const estado = $('#mapa-estado');
    if (estado) estado.textContent = ordersMapStatusText();
    const lista = $('#mapa-lista');
    if (lista) lista.innerHTML = ordersMapListHtml();
    renderMapLive();
    syncOrdersMapMarkers();
  }

  /**
   * Trae los puntos guardados y (si se pide) los datos del negocio.
   *
   * `full` se usa al ENTRAR en la pantalla —un pedido nuevo de la web tiene que
   * salir—; el refresco automático solo mira ubicaciones, que es lo que cambia
   * solo cuando un cliente comparte su punto.
   */
  async function refreshOrdersMap({ full = false, silent = false } = {}) {
    if (!silent) {
      state.ordersMap.loading = true;
      renderOrdersMap();
    }
    try {
      if (full) await load({ keepTab: true });
      const data = await api('/api/admin/locations?limit=500');
      state.ordersMap.locations = data.locations ?? [];
      state.ordersMap.error = false;
      state.ordersMap.updatedAt = new Date().toISOString();
      cacheMapLocations(state.ordersMap.locations);
      state.ordersMap.fitted = state.ordersMap.fitted && state.ordersMap.markers.size > 0;
    } catch (error) {
      if (error.message === 'unauthorized') return;
      state.ordersMap.error = true;
    } finally {
      state.ordersMap.loading = false;
      renderOrdersMap();
    }
  }

  /** Sondeo de la pantalla: una ubicación que acaba de llegar sale sola. */
  function startOrdersMapPoll() {
    if (state.ordersMap.pollTimer) return;
    state.ordersMap.pollTimer = setInterval(() => {
      if (state.tab !== 'mapa') return;
      if (document.visibilityState !== 'visible') return;
      if (state.ordersMap.loading) return;
      refreshOrdersMap({ silent: true }).catch(() => {});
    }, MAPS_POLL_MS);
  }

  function stopOrdersMapPoll() {
    if (state.ordersMap.pollTimer) clearInterval(state.ordersMap.pollTimer);
    state.ordersMap.pollTimer = null;
  }

  /** Un punto de la lista abre SU mapa (la pantalla única) centrado en él. */
  function openOrdersMapPoint(key) {
    const point = ordersMapPoints().find((entry) => entry.key === key);
    if (!point) return;
    openMapScreen({
      location: point.location ?? {
        latitude: point.latitude,
        longitude: point.longitude,
        address: point.address,
        source: point.kind === 'order' ? 'order_delivery' : undefined,
        customer_id: point.customerId ?? null,
      },
      title: point.kind === 'order' ? `Pedido ${point.title}` : `Ubicación de ${point.title}`,
      conversationId: point.conversationId ?? '',
    });
  }

  /** Centra el mapa en un punto sin abrir nada (para no perder el contexto). */
  function centerOrdersMapPoint(key) {
    const point = ordersMapPoints().find((entry) => entry.key === key);
    const map = state.ordersMap.map ?? ensureOrdersMap();
    if (!point || !map) return;
    map.setView([point.latitude, point.longitude], Math.max(map.getZoom(), 15), { animate: true });
    state.ordersMap.markers.get(key)?.openPopup();
  }

  /** Bloque de ubicaciones del cliente para su ficha (§13). */
  function customerLocationsHtml(locations) {
    if (!locations?.length) {
      return `<p class="view__hint">Todavía no ha compartido ninguna ubicación.</p>`;
    }
    const [latest, ...rest] = locations;
    const row = (location) => `
      <div class="loc-row">
        <span class="loc-row__body">
          <strong>${escapeHtml(locationTitle(location))}</strong>
          <small>${escapeHtml(locationContext(location).who)}${
            location.age_label ? ` · ${escapeHtml(location.age_label)}` : ''
          }</small>
        </span>
        ${
          location.map_url
            ? `<a class="loc__link" href="${escapeHtml(location.map_url)}" target="_blank" rel="noopener noreferrer">Ver mapa</a>`
            : ''
        }
      </div>`;
    return `${row(latest)}${
      rest.length
        ? `<details class="loc-history"><summary>Ver historial (${rest.length})</summary>${rest.map(row).join('')}</details>`
        : ''
    }`;
  }

  async function shareReceiptPdf({ url, receipt }) {
    const title = `Factura ${receipt.order_number}`;
    if (navigator.canShare && window.File) {
      try {
        const response = await fetch(url, { credentials: 'same-origin' });
        if (response.ok) {
          const blob = await response.blob();
          const file = new File([blob], `${receipt.order_number}-factura.pdf`, { type: 'application/pdf' });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ title, files: [file] });
            return;
          }
        }
      } catch {
        /* Si no puede compartir archivo, se intenta compartir el enlace. */
      }
    }
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch {
        /* el usuario canceló o el navegador no pudo compartir */
      }
    }
    window.open(url, '_blank', 'noopener');
  }

  async function openOrderEditor(orderId) {
    try {
      const data = await api(`/api/admin/orders/${encodeURIComponent(orderId)}`);
      openOrderForm({
        customerId: data.item?.customer_id,
        conversationId: data.item?.conversation_id ?? '',
        orderId,
        order: data.order,
      });
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudo abrir el pedido');
    }
  }

  /** Factura de compra dentro del CRM + documento para abrir o compartir. */
  async function openReceipt(orderId) {
    try {
      const data = await api(`/api/admin/orders/${encodeURIComponent(orderId)}`);
      const receipt = data.receipt;
      const order = data.order ?? {};
      const integrity = data.integrity ?? {};
      const timeline = data.timeline ?? [];
      const operational = integrity.operationalStatus ?? getOrderOperationalStatus(order);
      const lines = (receipt.items ?? [])
        .map(
          (line) => `<div class="receipt-line">
            <span>${escapeHtml(line.label)}</span>
            <span class="receipt-line__qty">×${escapeHtml(line.quantity)}</span>
            <span class="receipt-line__amount">${money(line.subtotal, receipt.currency)}</span>
          </div>`,
        )
        .join('');
      openSheet(
        `Factura · ${receipt.order_number}`,
        `
        <div class="receipt" aria-label="Comprobante de compra">
          <p class="receipt__brand">${escapeHtml(receipt.business)}</p>
          <p class="receipt__doc">${escapeHtml(receipt.document)}</p>
          <dl class="facts">
            <div class="fact"><dt>Pedido</dt><dd>${escapeHtml(receipt.order_number)}</dd></div>
            <div class="fact"><dt>Fecha</dt><dd>${escapeHtml(fmtWhen(receipt.date))}</dd></div>
            ${receipt.customer_name ? `<div class="fact"><dt>Cliente</dt><dd>${escapeHtml(receipt.customer_name)}</dd></div>` : ''}
            ${receipt.phone_masked ? `<div class="fact"><dt>Teléfono</dt><dd>${escapeHtml(receipt.phone_masked)}</dd></div>` : ''}
            ${
              receipt.payment_method_label
                ? `<div class="fact"><dt>Método de pago</dt><dd>${escapeHtml(receipt.payment_method_label)}</dd></div>`
                : ''
            }
            <div class="fact"><dt>Estado</dt><dd>${escapeHtml(receipt.status_label)}</dd></div>
            <div class="fact"><dt>Origen</dt><dd>${escapeHtml(sourceLabel(order.source))}</dd></div>
            <div class="fact"><dt>Atribución</dt><dd>${escapeHtml(sourceOriginLabel(order.source_origin, order))}</dd></div>
            ${receipt.cancelled_at ? `<div class="fact"><dt>Cancelada</dt><dd>${escapeHtml(fmtWhen(receipt.cancelled_at))}</dd></div>` : ''}
            ${receipt.cancel_reason ? `<div class="fact"><dt>Motivo</dt><dd>${escapeHtml(receipt.cancel_reason)}</dd></div>` : ''}
          </dl>
          ${
            timeline.length
              ? `<div class="order-timeline" aria-label="Timeline del pedido">
                  ${timeline
                    .map(
                      (row) => `<div class="order-timeline__item">
                        <strong>${escapeHtml(row.label ?? 'Movimiento')}</strong>
                        <small>${escapeHtml(fmtWhen(row.at))}${row.by ? ` · ${escapeHtml(row.by)}` : ''}</small>
                        ${row.reason ? `<span>Motivo: ${escapeHtml(row.reason)}</span>` : ''}
                      </div>`,
                    )
                    .join('')}
                </div>`
              : ''
          }
          <div class="receipt__lines">${lines}</div>
          <div class="receipt__totals">
            <div><span>Productos</span><strong>${money(receipt.subtotal, receipt.currency)}</strong></div>
            ${receipt.discount ? `<div><span>Descuento</span><strong>−${money(receipt.discount, receipt.currency)}</strong></div>` : ''}
            ${
              receipt.delivery_fee
                ? `<div><span>Delivery</span><strong>${money(receipt.delivery_fee, receipt.currency)}</strong></div>`
                : ''
            }
            ${
              receipt.shipping
                ? `<div><span>Envío</span><strong>${money(receipt.shipping, receipt.currency)}</strong></div>`
                : ''
            }
            <div class="receipt__grand"><span>TOTAL</span><span>${money(receipt.total, receipt.currency)}</span></div>
          </div>
          ${
            receipt.has_location
              ? `<div class="loc-row">
                   <span class="loc-row__body"><strong>📍 Ubicación de entrega registrada</strong>
                   <small>${escapeHtml(receipt.location_label ?? 'Ubicación compartida')}</small></span>
                   ${
                     mapLatLng(receipt.location ?? {})
                       ? `<button class="btn btn--ghost btn--sm" data-open-map="${mapLocationAttr(receipt.location)}" data-map-title="Ubicación del pedido ${escapeHtml(
                           receipt.order_number,
                         )}" type="button">Ver en el mapa</button>`
                       : ''
                   }
                 </div>`
              : ''
          }
          <p class="view__hint">${escapeHtml(receipt.thanks)}</p>
          <p class="view__hint">${escapeHtml(receipt.note)}</p>
        </div>
        <div class="receipt-pdf-card" aria-label="Factura lista para compartir">
          <span class="receipt-pdf-card__icon" aria-hidden="true">${ICONS.doc}</span>
          <span class="receipt-pdf-card__body">
            <strong>Factura lista para compartir</strong>
            <small>Factura ${escapeHtml(receipt.order_number)} · ${money(receipt.total, receipt.currency)}</small>
          </span>
        </div>
        ${sheetFabHtml(`data-receipt-actions="${escapeHtml(orderId)}"`)}
        `,
      );
      // El menú de la factura necesita sus datos: se guardan con la hoja abierta.
      state.receiptContext = { orderId, order, receipt, item: data.item ?? null };
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudo abrir el comprobante');
    }
  }

  /**
   * PASAR UN PEDIDO A UN DELIVERY.
   *
   * Estaba SOLO en el mapa (una lista desplegable dentro de la fila del punto) y
   * desde el pedido no había forma de encontrarlo: se creaba un pedido y no se
   * sabía cómo pasarlo al reparto. Ahora es una acción del propio pedido, dentro
   * de su botón flotante de acciones. El servidor solo lo permite a quien puede
   * gestionar el reparto (`delivery.tracking.manage_all`): si no, la lista de
   * repartidores llega vacía.
   */
  async function openDeliveryAssignSheet({ orderId, order = null }) {
    const item = state.items.find((candidate) => candidate.id === orderId) ?? null;
    const actual = order ?? (item ? itemOrder(item) : {}) ?? {};
    const entrega = actual?.delivery ?? {};
    const asignadoId = entrega.delivery_user_id ?? '';
    const asignadoNombre = entrega.delivery_user_name_snapshot ?? null;
    const repartidores = (state.deliveryUsers ?? []).filter((user) => user.active !== false);
    const fila = (user) =>
      `<button class="menu-item" data-order-delivery-user="${escapeHtml(user.id)}" data-order-id="${escapeHtml(
        orderId,
      )}" type="button">
        <span class="menu-item__icon" aria-hidden="true">${user.id === asignadoId ? ICONS.checkCircle : ICONS.send}</span>
        <span><strong>${escapeHtml(user.display_name ?? user.username ?? 'Delivery')}</strong><small>${
          user.id === asignadoId ? 'lo lleva ahora' : escapeHtml(roleLabel(user.role))
        }</small></span>
      </button>`;
    openSheet(
      'Pasar a un delivery',
      `
      ${
        asignadoNombre
          ? `<p class="view__hint">Ahora lo lleva <strong>${escapeHtml(asignadoNombre)}</strong>. Al elegir otro, el pedido cambia de agente (queda auditado).</p>`
          : '<p class="view__hint">Elige el <strong>agente</strong> que va a hacer la entrega: es quien lo lleva, marca la entrega y comparte su ubicación mientras reparte.</p>'
      }
      <div class="menu-list">
        ${
          repartidores.length
            ? repartidores.map(fila).join('')
            : `<p class="rule rule--warn">No hay agentes activos. Se crean en «Usuarios» (menú lateral) y vuelven a aparecer aquí.</p>`
        }
      </div>
      <button class="btn btn--ghost btn--block" data-close-sheet type="button">Cerrar</button>
      `,
      { variant: 'menu' },
    );
  }

  /** Asigna el pedido a un repartidor (el MISMO endpoint que usa el mapa). */
  async function assignOrderToDelivery(orderId, deliveryUserId, button) {
    if (!orderId || !deliveryUserId) return;
    await working(button, 'Asignando…', async () => {
      try {
        await api(`/api/admin/orders/${encodeURIComponent(orderId)}/delivery/assign`, {
          method: 'POST',
          body: JSON.stringify({ deliveryUserId }),
        });
        toast('Pedido pasado a delivery');
        closeSheet();
        await load({ keepTab: true });
        if (state.openId === orderId) renderSheet();
      } catch (error) {
        if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo asignar el delivery');
      }
    });
  }

  /**
   * BOTÓN FLOTANTE DE ACCIONES DE UNA HOJA.
   *
   * La ficha del pedido (y su factura) tenían una columna de botones que las
   * llenaba de ruido: Ver cliente, Ver factura, Pasar a un delivery, Llamar,
   * Escribir por WhatsApp, Modificar, Cancelar… Ahora TODO eso vive dentro de un
   * botón flotante: lo que se lee es la ficha, y las acciones están a un toque,
   * siempre en el mismo sitio.
   */
  const sheetFabHtml = (attrs = '') =>
    `<button class="sheet-fab" data-sheet-actions ${attrs} type="button" aria-label="Acciones">${ICONS.spark}</button>`;

  /**
   * Menú de acciones (dentro del botón flotante).
   *
   * `data` son atributos `data-*` que ya sabe atender el panel (la misma acción
   * de siempre, ahora dentro del menú) y `href` para lo que de verdad es un
   * enlace, como llamar por teléfono.
   */
  function openSheetActionMenu({ title = 'Acciones', nota = '', acciones = [] } = {}) {
    const fila = (accion) => {
      const cuerpo = `<span class="menu-item__icon" aria-hidden="true">${accion.icon ?? ''}</span>
        <span><strong>${escapeHtml(accion.label)}</strong>${
          accion.note ? `<small>${escapeHtml(accion.note)}</small>` : ''
        }</span>`;
      // Lo que NO se puede hacer se enseña apagado y con el motivo: nada desaparece sin decir por qué.
      if (accion.disabled) {
        return `<button class="menu-item menu-item--off" type="button" disabled>${cuerpo}</button>`;
      }
      if (accion.href) return `<a class="menu-item" href="${escapeHtml(accion.href)}">${cuerpo}</a>`;
      const attrs = Object.entries(accion.data ?? {})
        .map(([clave, valor]) => `${clave}="${escapeHtml(String(valor))}"`)
        .join(' ');
      return `<button class="menu-item" type="button" ${attrs}>${cuerpo}</button>`;
    };
    openSheet(
      title,
      `${nota ? `<p class="view__hint">${escapeHtml(nota)}</p>` : ''}<div class="menu-list">${acciones
        .map(fila)
        .join('')}</div>`,
      { variant: 'menu' },
    );
  }

  /** Las acciones del pedido, todas dentro de su botón flotante. */
  function openOrderActionsMenu(itemId) {
    const item = state.items.find((candidate) => candidate.id === itemId) ?? null;
    if (!item) return;
    const phone = digits(item.phone);
    const esPedido = item.type === 'order_intent';
    const clienteId = customerIdForItem(item);
    const conversacionId = conversationForCustomer(clienteId)?.id ?? item.conversation_id ?? '';
    const estado = orderOperational(item);
    /*
     * Con el pedido YA ENTREGADO es cuando toca el seguimiento: se dice arriba, para
     * que las dos acciones de abajo (seguimiento y mensaje) no se pasen por alto.
     */
    const nota =
      esPedido && estado === 'ENTREGADO'
        ? 'Pedido entregado: buen momento para el seguimiento. Programa una tarea para el equipo o un mensaje al cliente.'
        : '';
    // El seguimiento y el mensaje programado se ligan al pedido desde el que se crean.
    const enganche = { 'data-conversation': conversacionId, 'data-order-id': item.id };
    /*
     * Sin cliente (pedidos de la web que llegaron sin teléfono, o pruebas) no hay a quién
     * programarle nada: en vez de esconder las dos acciones, se enseña el motivo. Un menú
     * al que le faltan opciones sin explicación parece un menú roto.
     */
    const sinCliente = esPedido && !clienteId
      ? item.phone
        ? 'Falta vincular al cliente de este pedido'
        : 'Este pedido no trae teléfono ni cliente: no hay a quién avisar'
      : '';
    openSheetActionMenu({
      title: item.order_number ?? item.name ?? 'Acciones',
      nota,
      acciones: [
        { icon: ICONS.chevron, label: 'Volver a la ficha', data: { 'data-open': item.id } },
        esPedido
          ? {
              icon: ICONS.doc,
              label: 'Ver factura',
              note: 'Comprobante con detalle y total',
              data: { 'data-receipt': item.id },
            }
          : null,
        esPedido && hasPermission('delivery.tracking.manage_all')
          ? {
              icon: ICONS.send,
              label: 'Pasar a un delivery',
              note: 'Elige el agente que lo lleva',
              data: { 'data-order-delivery': item.id },
            }
          : null,
        clienteId
          ? { icon: ICONS.person, label: 'Ver cliente', note: 'Su ficha completa', data: { 'data-customer': clienteId } }
          : null,
        { icon: ICONS.chat, label: 'Escribir por WhatsApp', note: 'Plantilla o mensaje libre', data: { 'data-item-wa': item.id } },
        clienteId
          ? {
              icon: ICONS.clock,
              label: 'Programar seguimiento',
              note: 'Una tarea para el equipo: hablar con este cliente',
              data: { 'data-followup-new': clienteId, ...enganche },
            }
          : sinCliente
            ? { icon: ICONS.clock, label: 'Programar seguimiento', note: sinCliente, disabled: true }
            : null,
        clienteId
          ? {
              icon: ICONS.send,
              label: 'Programar mensaje al cliente',
              note: 'Lo envía el sistema el día y la hora que elijas',
              data: { 'data-scheduled-new': clienteId, ...enganche },
            }
          : sinCliente
            ? { icon: ICONS.send, label: 'Programar mensaje al cliente', note: sinCliente, disabled: true }
            : null,
        phone ? { icon: ICONS.phone, label: 'Llamar', note: item.phone, href: `tel:${phone}` } : null,
      ].filter(Boolean),
    });
  }

  /** Escribir por WhatsApp: elegir la plantilla, ver el mensaje final y enviarlo. */
  function openItemWhatsAppSheet(itemId) {
    const item = state.items.find((candidate) => candidate.id === itemId) ?? null;
    if (!item) return;
    const mensajes = state.messages ?? [];
    openSheet(
      `Escribir a ${item.name ?? 'el cliente'}`,
      `<label class="field">
        <span class="field__label">Mensaje</span>
        <select class="field__select" id="wa-item-template">
          ${mensajes
            .map((message) => `<option value="${escapeHtml(message.id)}">${escapeHtml(message.name)}</option>`)
            .join('')}
        </select>
      </label>
      <p class="view__hint" id="wa-item-preview"></p>
      <button class="btn btn--whatsapp btn--block" id="wa-item-send" type="button">Escribir por WhatsApp</button>`,
    );
    const pintar = () => {
      const message = mensajes.find((entry) => entry.id === $('#wa-item-template')?.value);
      const preview = $('#wa-item-preview');
      if (preview) preview.textContent = message ? fillTemplate(message.body, item) : '';
    };
    $('#wa-item-template')?.addEventListener('change', pintar);
    pintar();
    $('#wa-item-send')?.addEventListener('click', () => {
      const message = mensajes.find((entry) => entry.id === $('#wa-item-template')?.value);
      openWhatsApp(item, message?.body ?? 'Hola {nombre}, te escribo de {negocio}.');
    });
  }

  /** Las acciones de la factura, también dentro de su botón flotante. */
  function openReceiptActionsMenu(ctx) {
    const { orderId, order = {}, receipt = {}, item = null } = ctx ?? {};
    if (!orderId) return;
    const operational = getOrderOperationalStatus(order);
    const abierto = receipt.status !== 'entregado' && receipt.status !== 'cancelado';
    openSheetActionMenu({
      title: receipt.order_number ? `Factura · ${receipt.order_number}` : 'Factura',
      acciones: [
        { icon: ICONS.doc, label: 'Ver factura', note: 'Documento para imprimir', data: { 'data-receipt-open': orderId } },
        {
          icon: ICONS.send,
          label: 'Compartir factura',
          note: 'PDF por WhatsApp o donde quieras',
          data: { 'data-receipt-share': orderId },
        },
        hasPermission('delivery.tracking.manage_all') && abierto
          ? { icon: ICONS.send, label: 'Pasar a un delivery', data: { 'data-order-delivery': orderId } }
          : null,
        item?.customer_id ? { icon: ICONS.person, label: 'Ver cliente', data: { 'data-customer': item.customer_id } } : null,
        { icon: ICONS.note, label: 'Modificar pedido', data: { 'data-order-edit': orderId } },
        isAdmin()
          ? {
              icon: ICONS.check,
              label: 'Cambiar estado',
              note: operationalStatusLabel(operational),
              data: { 'data-order-status-change': orderId, 'data-order-status-current': operational },
            }
          : null,
        isAdmin() && receipt.status !== 'cancelado'
          ? { icon: ICONS.close, label: 'Cancelar venta', data: { 'data-sale-cancel': orderId } }
          : null,
      ].filter(Boolean),
    });
  }

  async function openOrderStatusSheet(orderId, context = {}) {
    const order = context.order ?? {};
    const current = context.integrity?.operationalStatus ?? getOrderOperationalStatus(order);
    openSheet(
      `Cambiar estado · ${escapeHtml(order.order_number ?? orderId)}`,
      `
      <dl class="facts">
        <div class="fact"><dt>Estado actual</dt><dd>${escapeHtml(operationalStatusLabel(current))}</dd></div>
        <div class="fact"><dt>Pedido</dt><dd>${escapeHtml(order.order_number ?? orderId)}</dd></div>
      </dl>
      <label class="field">
        <span class="field__label">Cambiar a</span>
        <select class="field__select" id="manual-order-status">${manualOrderStatusOptions(current)}</select>
      </label>
      <label class="field">
        <span class="field__label">Motivo obligatorio</span>
        <textarea class="field__area" id="manual-order-reason" placeholder="Ej.: Cliente confirmó por llamada, error de captura, entrega verificada…"></textarea>
      </label>
      <p class="rule" id="manual-order-impact">El cambio quedará auditado con tu usuario.</p>
      <button class="btn btn--primary btn--block" id="manual-order-confirm" type="button">Confirmar cambio</button>
      `,
    );
    const updateImpact = () => {
      const target = $('#manual-order-status')?.value ?? current;
      const text =
        target === 'ENTREGADO'
          ? 'Confirmar cerrará tracking activo, actualizará inventario, postventa y Meta Purchase una sola vez.'
          : target === 'CANCELADO'
            ? 'Confirmar cerrará cualquier tracking activo y el pedido no contará como venta entregada.'
            : target === 'EN_CAMINO'
              ? 'Solo se permite si ya existe una entrega activa con tracking. No se inventará tracking.'
              : 'Solo se permite si no existe tracking activo. No revierte ventas entregadas.';
      const box = $('#manual-order-impact');
      if (box) box.textContent = text;
    };
    $('#manual-order-status')?.addEventListener('change', updateImpact);
    updateImpact();
    $('#manual-order-confirm')?.addEventListener('click', async (event) => {
      const target = $('#manual-order-status')?.value ?? '';
      const reason = $('#manual-order-reason')?.value.trim() ?? '';
      if (reason.length < 6 || /^[\W_]+$/u.test(reason) || /^(ok|okay|bien|listo|na|n\/a)$/i.test(reason)) {
        toast('Escribe un motivo claro');
        return;
      }
      if (['ENTREGADO', 'CANCELADO'].includes(target)) {
        const label = operationalStatusLabel(target);
        const ok = window.confirm(`¿Confirmas marcar este pedido como ${label}? Este cambio quedará auditado.`);
        if (!ok) return;
      }
      await working(event.currentTarget, 'Cambiando…', async () => {
        try {
          await api(`/api/admin/orders/${encodeURIComponent(orderId)}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status: target, reason, expectedStatus: current }),
          });
          toast('Estado actualizado');
          await load({ keepTab: true });
          await openReceipt(orderId);
        } catch (error) {
          if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo cambiar el estado');
        }
      });
    });
  }

  async function openCancelSale(orderId) {
    try {
      const data = await api(`/api/admin/orders/${encodeURIComponent(orderId)}`);
      const order = data.order ?? {};
      const receipt = data.receipt ?? {};
      const lines = (order.items ?? receipt.items ?? [])
        .map((line) => `${line.variantName ?? line.label ?? 'Producto'} ×${line.quantity ?? 1}`)
        .join(', ');
      openSheet(
        `Cancelar venta · ${receipt.order_number ?? order.order_number ?? orderId}`,
        `
        <p class="rule rule--warn">Esta acción cancelará la venta y devolverá los productos al inventario.</p>
        <dl class="facts">
          <div class="fact"><dt>Cliente</dt><dd>${escapeHtml(receipt.customer_name ?? data.customer?.name ?? '—')}</dd></div>
          <div class="fact"><dt>Productos</dt><dd>${escapeHtml(lines || '—')}</dd></div>
          <div class="fact"><dt>Total</dt><dd>${money(receipt.total ?? order.total ?? 0, receipt.currency ?? order.currency)}</dd></div>
          <div class="fact"><dt>Pago</dt><dd>${escapeHtml(receipt.payment_method_label ?? paymentMethodLabel(order.payment_method))}</dd></div>
          <div class="fact"><dt>Fecha</dt><dd>${escapeHtml(fmtWhen(receipt.date ?? order.created_at))}</dd></div>
        </dl>
        <label class="field">
          <span class="field__label">Motivo obligatorio</span>
          <textarea class="field__area" id="sale-cancel-reason" placeholder="Ej.: Cliente anuló el pedido, error de registro…"></textarea>
        </label>
        <button class="btn btn--danger btn--block" id="sale-cancel-confirm" type="button">Cancelar venta y devolver inventario</button>
        `,
      );
      $('#sale-cancel-confirm')?.addEventListener('click', async (event) => {
        const reason = $('#sale-cancel-reason')?.value.trim();
        if (!reason) {
          toast('Escribe el motivo de cancelación');
          return;
        }
        await working(event.currentTarget, 'Cancelando…', async () => {
          try {
            await api(`/api/admin/orders/${encodeURIComponent(orderId)}/cancel`, {
              method: 'POST',
              body: JSON.stringify({ reason }),
            });
            toast('Venta cancelada e inventario restaurado');
            await load({ keepTab: true });
            await openReceipt(orderId);
          } catch (error) {
            if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo cancelar la venta');
          }
        });
      });
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudo abrir la venta');
    }
  }

  /** Base del panel (para construir enlaces absolutos del comprobante). */
  const app2Base = () => `${window.location.origin}`;

  /**
   * Programar un MENSAJE (no es un seguimiento: aquí el sistema intenta enviar).
   * Fuera de la ventana de 24 h solo se puede programar una plantilla aprobada.
   */
  function openScheduledForm({ customerId, conversationId = '', orderId = '' } = {}) {
    const customer = customerById(customerId) ?? (state.wa.chat?.customer?.id === customerId ? state.wa.chat.customer : null);
    if (!customer) return;
    const approved = (state.templates ?? []).filter(waTemplateApproved);
    const dentroDeVentana = state.wa.chat?.customer?.id === customerId ? state.wa.chat?.canSendFreeText !== false : null;
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    openSheet(
      `Programar mensaje · ${customerName(customer)}`,
      `
      <p class="view__hint">
        El sistema lo intentará enviar a esa hora. Si al llegar el momento ya no se puede (ventana de 24 h,
        «no contactar»), <strong>no se fuerza</strong>: queda bloqueado y te avisa.
      </p>
      <label class="field">
        <span class="field__label">Fecha</span>
        <input class="field__input" id="sch-date" type="date" value="${todayISO()}" />
      </label>
      <label class="field">
        <span class="field__label">Hora</span>
        <input class="field__input" id="sch-time" type="time" value="${time}" />
      </label>
      <div class="item__actions" style="margin-top:0">
        <button class="chip" data-sch-quick="60" type="button">En 1 hora</button>
        <button class="chip" data-sch-quick="1440" type="button">Mañana</button>
        <button class="chip" data-sch-quick="10080" type="button">En 7 días</button>
      </div>
      <label class="field">
        <span class="field__label">Mensaje</span>
        <textarea class="field__area" id="sch-text" placeholder="Hola, ¿te ayudo con tu pedido?"></textarea>
      </label>
      ${
        approved.length
          ? `<label class="field">
               <span class="field__label">O usar una plantilla aprobada</span>
               <select class="field__select" id="sch-template">
                 <option value="">— texto de arriba —</option>
                 ${approved.map((template) => `<option value="${escapeHtml(template.name)}">${escapeHtml(waTemplateLabel(template))}</option>`).join('')}
               </select>
             </label>`
          : `<p class="view__hint">No hay plantillas aprobadas en Meta: fuera de la ventana de 24 h el mensaje quedará bloqueado.</p>`
      }
      ${
        dentroDeVentana === false
          ? '<p class="rule rule--warn">La ventana de 24 h ya terminó: programa una plantilla aprobada.</p>'
          : ''
      }
      <button class="btn btn--primary btn--block" id="sch-save" type="button">Programar mensaje</button>
      `,
    );

    $$('[data-sch-quick]').forEach((chip) =>
      chip.addEventListener('click', () => {
        const when = new Date(Date.now() + Number(chip.dataset.schQuick) * 60000);
        $('#sch-date').value = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(
          when.getDate(),
        ).padStart(2, '0')}`;
        $('#sch-time').value = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
      }),
    );

    $('#sch-save').addEventListener('click', async (event) => {
      const date = $('#sch-date').value;
      const time = $('#sch-time').value || '09:00';
      const template = $('#sch-template')?.value || '';
      const body = $('#sch-text').value.trim();
      if (!date) {
        toast('Elige la fecha');
        return;
      }
      if (!template && !body) {
        toast('Escribe el mensaje');
        return;
      }
      await working(event.currentTarget, 'Programando…', async () => {
        try {
          await api('/api/admin/scheduled', {
            method: 'POST',
            body: JSON.stringify({
              customerId: customer.id,
              conversationId: conversationId || undefined,
              orderId: orderId || undefined,
              // La hora local del teléfono → instante exacto (sin desfases).
              scheduledAt: new Date(`${date}T${time}:00`).toISOString(),
              type: template ? 'template' : 'text',
              template: template || undefined,
              text: body || undefined,
            }),
          });
          toast('Mensaje programado');
          await load({ keepTab: true });
          closeSheet();
        } catch (error) {
          if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo programar');
        }
      });
    });
  }

  async function scheduledAction(id, action, payload = {}) {
    try {
      await api(`/api/admin/scheduled/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ action, ...payload }),
      });
      toast(action === 'cancel' ? 'Mensaje cancelado' : 'Mensaje reprogramado');
      await load({ keepTab: true });
      if (state.customerId) await openCustomer(state.customerId);
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudo actualizar el mensaje');
    }
  }

  /** Interruptores del plan de postventa (Ajustes). */
  async function toggleFollowupDay(key, enabled) {
    const current = { ...(state.settings?.followup ?? {}) };
    current[key] = enabled;
    try {
      const result = await api('/api/admin/settings/followup', {
        method: 'POST',
        body: JSON.stringify({ enabled: current }),
      });
      state.settings = { ...(state.settings ?? {}), followup: result.followup.enabled };
      toast(enabled ? 'Día activado' : 'Día desactivado');
      renderAjustes();
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudo guardar el ajuste');
    }
  }

  /** Métricas del período elegido (Hoy / 7 días / 30 días). */
  async function loadMetrics(period) {
    state.metricsPeriod = period;
    try {
      state.metrics = (await api(`/api/admin/metrics?period=${encodeURIComponent(period)}`)).metrics;
    } catch (error) {
      if (error.message !== 'unauthorized') state.metrics = null;
    }
    renderAjustes();
  }

  async function assignCurrentConversation(action, userId = null, conversationId = state.wa.selectedId) {
    if (!conversationId) return;
    const path =
      action === 'take'
        ? `/api/admin/conversations/${encodeURIComponent(conversationId)}/take`
        : action === 'release'
          ? `/api/admin/conversations/${encodeURIComponent(conversationId)}/release`
          : `/api/admin/conversations/${encodeURIComponent(conversationId)}/assign`;
    try {
      await api(path, {
        method: 'POST',
        body: JSON.stringify(userId ? { userId } : {}),
      });
      await refreshWhatsapp();
      if (state.wa.selectedId === conversationId) await loadWaThread(conversationId, { force: true });
      toast(action === 'take' ? 'Conversación tomada' : action === 'release' ? 'Conversación liberada' : 'Conversación reasignada');
      closeSheet();
    } catch (error) {
      if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo cambiar la asignación');
    }
  }

  async function loadInventory() {
    state.inventoryLoading = true;
    try {
      const data = await api('/api/admin/inventory');
      state.inventory = data;
      state.catalog = data.presentations ?? state.catalog;
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudo cargar inventario');
    } finally {
      state.inventoryLoading = false;
    }
    renderProductos();
  }

  async function loadSalesReport(period = state.salesReportPeriod) {
    state.salesReportPeriod = period;
    state.salesReportLoading = true;
    try {
      const data = await api(`/api/admin/reports/sales?period=${encodeURIComponent(period)}`);
      state.salesReport = data.report ?? null;
    } catch (error) {
      if (error.message !== 'unauthorized') toast('No se pudo cargar el reporte');
    } finally {
      state.salesReportLoading = false;
    }
    renderReportes();
  }

  async function submitInventoryForm(form) {
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      let path = '/api/admin/inventory/restock';
      if (form.id === 'inventory-cost') path = '/api/admin/inventory/cost';
      if (form.id === 'inventory-adjust') path = '/api/admin/inventory/adjust';
      if (form.id === 'inventory-count') path = '/api/admin/inventory/count';
      const data = await api(path, { method: 'POST', body: JSON.stringify(body) });
      state.inventory = data.inventory ?? state.inventory;
      toast(form.id === 'inventory-cost' ? 'Costo actualizado' : 'Inventario actualizado');
      await loadInventory();
      state.salesReport = null;
    } catch (error) {
      if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo guardar inventario');
    }
  }


  // ------------------------------------------------------------------ PWA

  function updateBadge() {
    const pendientes = (state.stats?.hoy ?? 0) + (state.stats?.nuevos ?? 0);
    const badge = $('#badge-hoy');
    badge.hidden = pendientes === 0;
    badge.textContent = pendientes;
    // WhatsApp: mensajes sin leer + conversaciones que necesitan una persona.
    const whatsappPendiente = (state.hoy?.sinResponder ?? 0) + (state.hoy?.humanoRequerido ?? 0);
    const waBadge = $('#badge-whatsapp');
    waBadge.hidden = whatsappPendiente === 0;
    waBadge.textContent = whatsappPendiente;
    if (navigator.setAppBadge) navigator.setAppBadge(pendientes + whatsappPendiente).catch(() => {});
  }
  function renderOutboxBanner() {
    const count = readOutbox().length;
    const banner = $('#outbox-banner');
    banner.hidden = count === 0;
    banner.textContent = count
      ? `${count} cambio(s) pendientes de enviar. Se enviarán solos cuando vuelva la conexión.`
      : '';
  }

  function setConnection(online) {
    state.online = online;
    const pill = $('#state-pill');
    pill.hidden = false;
    /*
     * Indicador de PRESENCIA: un punto con un halo lento. Dice "sistema
     * conectado", no es un botón (no hace nada al tocarlo) y no finge nada: si
     * el navegador dice que no hay red, cambia de color y de texto.
     */
    pill.dataset.online = online ? 'true' : 'false';
    pill.innerHTML =
      '<span class="presence__dot" aria-hidden="true"></span>' +
      `<span class="presence__label">${online ? 'En línea' : 'Sin conexión'}</span>`;
    pill.setAttribute('aria-label', online ? 'Sistema en línea' : 'Sin conexión');
    $('#offline-banner').hidden = online;
    renderMobileHeader();
    if (online) flushOutbox();
  }

  let installEvent = null;

  function pushPermissionLabel() {
    if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) return 'No disponible';
    if (Notification.permission === 'granted') return 'Activadas';
    if (Notification.permission === 'denied') return 'Bloqueadas por navegador';
    return 'Desactivadas';
  }

  function urlBase64ToUint8Array(value) {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
  }

  function samePushKey(current, expected) {
    if (!current) return true;
    const left = new Uint8Array(current);
    if (left.length !== expected.length) return false;
    return left.every((value, index) => value === expected[index]);
  }

  async function refreshPushStatus() {
    const data = await api('/api/admin/push-status');
    state.push = data.push ?? state.push;
    saveSnapshot();
    return state.push;
  }

  async function syncCrmPushSubscription(options = {}) {
    const requestPermission = options.requestPermission !== false;
    if (!state.push?.publicKey) {
      if (!options.quiet) toast('Push no está configurado en el servidor');
      return false;
    }
    if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
      if (!options.quiet) toast('Este navegador no soporta notificaciones push');
      return false;
    }
    let permission = Notification.permission;
    if (permission !== 'granted') {
      if (!requestPermission) return false;
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      if (!options.quiet) toast(permission === 'denied' ? 'Notificaciones bloqueadas por navegador' : 'No se activaron las notificaciones');
      renderMapLive();
      return false;
    }
    /*
     * Con tope de tiempo: si el service worker no llega a activarse, esto se
     * quedaba esperando PARA SIEMPRE y el botón parecía no hacer nada.
     */
    const registration = await withTimeout(navigator.serviceWorker.ready, 8000);
    if (!registration) {
      if (!options.quiet) toast('El panel no terminó de instalarse en este teléfono: cierra y vuelve a abrirlo');
      return false;
    }
    const applicationServerKey = urlBase64ToUint8Array(state.push.publicKey);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription?.options?.applicationServerKey && !samePushKey(subscription.options.applicationServerKey, applicationServerKey)) {
      await subscription.unsubscribe().catch(() => {});
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }
    await api('/api/admin/push-subscriptions', {
      method: 'POST',
      body: JSON.stringify(subscription),
    });
    state.push = { ...state.push, subscribed: true, activeSubscriptions: Math.max(1, Number(state.push?.activeSubscriptions ?? 0)) };
    state.wa.notify = true;
    localStorage.setItem(WA_NOTIFY_KEY, '1');
    if (!options.quiet) toast('Notificaciones activadas');
    renderMapLive();
    return true;
  }

  async function enableCrmPush() {
    const enabled = await syncCrmPushSubscription({ requestPermission: true });
    if (enabled) await refreshPushStatus().catch(() => null);
    // El resultado se queda escrito en la hoja: pulsar no puede quedarse sin respuesta.
    state.pushResult = enabled
      ? { servidor: 'Teléfono registrado', local: 'listo para recibir avisos', at: new Date().toISOString() }
      : { servidor: 'Este teléfono no quedó registrado', local: pushPermissionLabel().toLowerCase(), at: new Date().toISOString() };
    return enabled;
  }

  function autoSyncCrmPush() {
    if (!state.push?.publicKey || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    syncCrmPushSubscription({ requestPermission: false, quiet: true })
      .then((enabled) => {
        if (enabled) refreshPushStatus().catch(() => null);
      })
      .catch(() => {});
  }

  /** Promesa con tope de tiempo: si el panel no termina de instalarse, se DICE. */
  const withTimeout = (promise, ms) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

  /**
   * Aviso LOCAL en este dispositivo (sin servidor ni push).
   *
   * Sirve para separar dos fallos que se ven igual desde fuera: «el servidor no
   * mandó nada» y «el teléfono no está mostrando los avisos del CRM».
   */
  async function showLocalPushTest() {
    try {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
      const registration = await withTimeout(navigator.serviceWorker.ready, 8000);
      if (!registration?.showNotification) return false;
      await registration.showNotification('Prueba en este teléfono', {
        body: 'Si ves este aviso, este teléfono muestra los avisos del CRM.',
        tag: 'phyto-push-test-local',
        icon: '/admin/icon-192.png',
        badge: '/admin/icon-192.png',
        data: { deepLink: '/admin/?v=hoy' },
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * PRUEBA de notificaciones, de verdad y con resultado a la vista.
   *
   *   1. deja ESTE teléfono registrado (si no hay registro, no hay a dónde
   *      mandar el aviso) y pide al servidor la prueba real por push;
   *   2. muestra además un aviso LOCAL, para saber si el que falla es el envío
   *      o el teléfono;
   *   3. deja el resultado escrito en la hoja (antes, si el botón estaba
   *      deshabilitado o el service worker no arrancaba, no pasaba NADA).
   */
  async function testCrmPush() {
    const registrado = await syncCrmPushSubscription({ requestPermission: true, quiet: true });
    let servidor = 'El servidor no pudo enviar la prueba';
    try {
      const data = await api('/api/admin/push-subscriptions/test', { method: 'POST', body: '{}' });
      state.push = data.status ?? state.push;
      const push = data.push ?? {};
      if (push.notConfigured > 0) servidor = 'El servidor no tiene llaves push: no salió nada';
      else if (push.sent > 0) servidor = `Enviado desde el servidor a ${push.sent} teléfono${push.sent === 1 ? '' : 's'}`;
      else if (push.expired > 0) servidor = 'El teléfono registrado ya no acepta avisos: pulsa Activar';
      else if (push.failed > 0) servidor = 'El servicio de push rechazó el envío';
      else servidor = data.message ?? 'El servidor no tiene un teléfono registrado';
    } catch (error) {
      servidor = error.body?.message ?? 'El servidor no pudo enviar la prueba';
    }
    const local = registrado ? await showLocalPushTest() : false;
    state.pushResult = {
      servidor,
      local: local
        ? 'aviso mostrado aquí'
        : registrado
          ? 'este teléfono no mostró el aviso'
          : 'este teléfono no quedó registrado',
      at: new Date().toISOString(),
    };
    toast(`${servidor} · ${state.pushResult.local}`);
    // La prueba ya está creada en el CRM: se refresca para que aparezca aquí mismo.
    await load({ keepTab: true }).catch(() => {});
    openNotificationsSheet();
    return state.pushResult;
  }

  function initPwa() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' }).catch(() => {});
    }

    window.addEventListener('online', () => setConnection(true));
    window.addEventListener('offline', () => setConnection(false));
    setConnection(navigator.onLine);

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      installEvent = event;
      $('#install-card').hidden = false;
      $('#install').hidden = false; // el navegador puede instalarla por nosotros
    });

    $('#install').addEventListener('click', async () => {
      if (!installEvent) return;
      installEvent.prompt();
      const choice = await installEvent.userChoice.catch(() => null);
      if (choice?.outcome === 'accepted') {
        $('#install-card').hidden = true;
        toast('Instalada: búscala en tu pantalla de inicio');
      }
      installEvent = null;
    });

    // Instalada (o en iPhone, que no avisa): solo las instrucciones manuales.
    if (window.matchMedia('(display-mode: standalone)').matches) $('#install-card').hidden = true;
    else $('#install').hidden = !installEvent;
  }

  // ------------------------------------------------------------------- menú
  /*
   * El menú lateral guarda lo secundario (pedidos, seguimientos, plantillas y
   * ajustes) para que abajo solo queden los tres destinos de trabajo. Se cierra
   * tocando fuera, con la ✕ o con Escape, y devuelve el foco a quien lo abrió.
   */
  let drawerFocusBack = null;

  function openDrawer() {
    const drawer = $('#drawer');
    const scrim = $('#scrim');
    if (!drawer || !scrim) return;
    drawerFocusBack = document.activeElement;
    drawer.hidden = false;
    scrim.hidden = false;
    requestAnimationFrame(() => {
      drawer.classList.add('drawer--open');
      scrim.classList.add('scrim--open');
    });
    $('#menu')?.setAttribute('aria-expanded', 'true');
    state.drawer = true;
    drawer.querySelector('button')?.focus();
  }

  function closeDrawer() {
    const drawer = $('#drawer');
    const scrim = $('#scrim');
    if (!drawer || !scrim || drawer.hidden) return;
    drawer.classList.remove('drawer--open');
    scrim.classList.remove('scrim--open');
    $('#menu')?.setAttribute('aria-expanded', 'false');
    state.drawer = false;
    setTimeout(() => {
      if (!state.drawer) {
        drawer.hidden = true;
        scrim.hidden = true;
      }
    }, 200);
    if (drawerFocusBack instanceof HTMLElement) drawerFocusBack.focus();
    drawerFocusBack = null;
  }

  // ------------------------------------------------------------------- tabs

  /** Los tres destinos de trabajo + lo que vive en el menú lateral. */
  const VIEWS = ['hoy', 'whatsapp', 'clientes', 'mapa', 'perfil-cliente', 'pedidos', 'productos', 'reportes', 'seguimientos', 'mensajes', 'ajustes', 'usuarios', 'perfil'];
  const VIEW_SUBTITLE = {
    hoy: 'CRM',
    whatsapp: 'WhatsApp',
    clientes: 'Clientes',
    mapa: 'Mapa y entregas',
    'perfil-cliente': 'Perfil del cliente',
    pedidos: 'Pedidos',
    productos: 'Inventario',
    reportes: 'Reportes',
    seguimientos: 'Seguimientos',
    mensajes: 'Plantillas',
    ajustes: 'Ajustes',
    usuarios: 'Usuarios',
    perfil: 'Mi perfil',
  };

  function setTab(tab, options = {}) {
    if ((tab === 'usuarios' && !isAdmin()) || (tab === 'ajustes' && !hasPermission('settings.manage')) || (tab === 'reportes' && !hasPermission('reports.profit.view'))) {
      tab = 'hoy';
    }
    if (tab !== 'whatsapp') {
      state.wa.searchOpen = false;
      delete document.body.dataset.waView;
    }
    if (tab !== 'clientes') state.clientSearchOpen = false;
    // Fuera del mapa no se sigue nada: ni GPS en vivo ni sondeos ni el mapa vivo.
    if (tab !== 'mapa') {
      stopOrdersMapPoll();
      stopDeliveryEvents();
      resetOrdersMap();
      delete document.body.dataset.mapPanel;
      state.ordersMap.panelOpen = false;
    }
    state.tab = tab;
    localStorage.setItem(TAB_KEY, tab);
    if (state.drawer) closeDrawer();
    // El ancho de la bandeja de WhatsApp depende de la pestaña activa (CSS).
    document.body.dataset.tab = tab;
    $$('[data-tab]').forEach((button) => button.setAttribute('aria-current', String(button.dataset.tab === tab)));
    VIEWS.forEach((name) => {
      const view = $(`#view-${name}`);
      if (view) view.hidden = name !== tab;
    });
    const sub = $('#topbar-sub');
    if (sub) sub.textContent = VIEW_SUBTITLE[tab] ?? 'CRM';
    renderMobileHeader();
    if (!options.silent) {
      window.scrollTo({ top: 0 });
      // Al entrar en WhatsApp se refresca una vez; el sondeo sigue después.
      if (tab === 'whatsapp') refreshWhatsapp().catch(() => {});
      if (tab === 'delivery') {
        refreshDeliveryTracking().catch(() => {});
        startDeliveryEvents();
      }
      if (tab === 'productos') loadInventory().catch(() => {});
      if (tab === 'reportes' && hasPermission('reports.profit.view')) loadSalesReport(state.salesReportPeriod).catch(() => {});
      if (tab === 'usuarios') loadUsers().catch(() => {});
      // El perfil se relee del servidor: el nombre pudo cambiar en otro sitio.
      if (tab === 'perfil') refreshProfile().catch(() => {});
      // Al entrar en Ajustes se refresca lo que cambia con el uso: los números y
      // la traza. Así el negocio ve el efecto de lo que acaba de hacer.
      if (tab === 'ajustes') {
        loadMetrics(state.metricsPeriod).catch(() => {});
        state.auditEntries = null;
        state.auditLoading = true;
        loadAuditEntries();
      }
    }
    /*
     * MAPA Y ENTREGAS: se carga SIEMPRE al entrar, también con enlace directo
     * (`?v=mapa`, que entra sin refrescar nada más). Primero se pinta AL INSTANTE
     * lo último visto (guardado en el teléfono) y detrás piden los datos de
     * verdad: con mala señal se ve algo útil desde el primer segundo, y con buena
     * señal se corrige solo. El sondeo y el GPS en vivo siguen mientras la
     * pantalla esté abierta.
     */
    if (tab === 'mapa') {
      if (!state.ordersMap.locations?.length) state.ordersMap.locations = mapCachedLocations();
      state.ordersMap.fitted = false;
      renderOrdersMap();
      refreshOrdersMap({ full: !options.silent }).catch(() => {});
      startOrdersMapPoll();
      refreshDeliveryTracking().catch(() => {});
      startDeliveryEvents();
    }
  }

  // ---------------------------------------------------------------- eventos

  /*
   * Los manejadores se enganchan una sola vez. Si `boot` llegara a ejecutarse
   * dos veces (por ejemplo, un `DOMContentLoaded` repetido), engancharlos de
   * nuevo haría que un toque contara doble (enviar dos mensajes, abrir y cerrar
   * una hoja a la vez), así que se marcan como ya montados.
   */
  let eventosMontados = false;

  function initEvents() {
    if (eventosMontados) return;
    eventosMontados = true;

    $('#login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const username = $('#login-username')?.value.trim() ?? '';
      const password = $('#login-password')?.value ?? '';
      const token = $('#login-token')?.value.trim() ?? '';
      if (!token && (!username || !password)) return;
      try {
        const payload = token ? { token } : { username, password };
        const result = await api('/api/admin/login', { method: 'POST', body: JSON.stringify(payload) });
        state.auth = { user: result.user ?? null, legacy: Boolean(token) };
        if ($('#login-token')) $('#login-token').value = '';
        if ($('#login-password')) $('#login-password').value = '';
        showApp();
        await load();
      } catch (error) {
        $('#login-error').hidden = false;
        $('#login-error').textContent = loginErrorMessage(error);
      }
    });

    document.addEventListener('submit', (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (['inventory-restock', 'inventory-cost', 'inventory-adjust', 'inventory-count'].includes(form.id)) {
        event.preventDefault();
        submitInventoryForm(form);
      }
      if (form.id === 'user-create') {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        working(form.querySelector('button[type="submit"]'), 'Creando…', async () => {
          await api('/api/admin/users', { method: 'POST', body: JSON.stringify(data) });
          form.reset();
          await loadUsers();
          toast('Usuario creado');
        }).catch((error) => {
          if (error.message !== 'unauthorized') toast(error.body?.error === 'weak_password' ? `La contraseña debe tener mínimo ${minPass()} caracteres` : error.body?.message ?? 'No se pudo crear');
        });
      }
    });

    $$('[data-tab]').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab)));

    $('#search').addEventListener('input', (event) => {
      state.q = event.target.value.trim();
      renderClientes();
    });

    $('#chips').innerHTML = [
      ['todos', 'Todos'],
      ['clientes', 'Clientes'],
      ['interesados', 'Interesados'],
      ['prospectos', 'Prospectos'],
      ['seguimiento', 'Seguimiento'],
    ]
      .map(
        ([value, text]) =>
          `<button class="chip" data-filter="${value}" aria-pressed="${value === state.filter}" type="button">${text}</button>`,
      )
      .join('');

    $('#chips').addEventListener('click', (event) => {
      const chip = event.target.closest('[data-filter]');
      if (!chip) return;
      state.filter = chip.dataset.filter;
      $$('[data-filter]').forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)),
      );
      renderClientes();
    });

    $('#stats').addEventListener('click', (event) => {
      const card = event.target.closest('[data-goto]');
      if (card) {
        setTab(card.dataset.goto);
        return;
      }
      // Compatibilidad: las tarjetas antiguas filtraban la lista de clientes.
      const legacy = event.target.closest('[data-stat]');
      if (!legacy) return;
      state.filter = legacy.dataset.stat === 'atrasados' ? 'hoy' : legacy.dataset.stat;
      $$('[data-filter]').forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)),
      );
      setTab('clientes');
      renderClientes();
    });

    /*
     * Pulsación larga = seleccionar (el gesto de WhatsApp). Se cancela en cuanto
     * el dedo o el ratón se mueven, para no secuestrar el desplazamiento de la
     * lista, y el clic que viene después de la pulsación no vuelve a quitar la
     * fila (para eso está `waPressFired`).
     */
    let waPressTimer = null;
    let waPressFrom = null;
    let waPressFired = false;
    const waPressCancel = () => {
      if (waPressTimer) clearTimeout(waPressTimer);
      waPressTimer = null;
      waPressFrom = null;
    };
    document.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest?.('[data-conv-more]') || event.target.closest?.('.conv__more')) return;
      if (event.target.closest?.('[data-customer]')) return;
      const row = event.target.closest?.('[data-conv]');
      if (!row || state.wa.selected.size) return;
      waPressFired = false;
      waPressFrom = { x: event.clientX, y: event.clientY, id: row.dataset.conv };
      if (waPressTimer) clearTimeout(waPressTimer);
      waPressTimer = setTimeout(() => {
        waPressTimer = null;
        const conversationId = waPressFrom?.id;
        if (!conversationId) return;
        waPressFired = true;
        if (!state.wa.selected.has(conversationId)) state.wa.selected.add(conversationId);
        renderWaList();
      }, 420);
    });
    document.addEventListener('pointermove', (event) => {
      if (!waPressFrom) return;
      if (Math.abs(event.clientX - waPressFrom.x) > 12 || Math.abs(event.clientY - waPressFrom.y) > 12) waPressCancel();
    });
    document.addEventListener('pointerup', waPressCancel);
    document.addEventListener('pointercancel', waPressCancel);
    document.addEventListener('scroll', waPressCancel, true);

    document.addEventListener('click', (event) => {
      /*
       * El orden importa: los botones viven DENTRO de tarjetas que también son
       * táctiles. Si se comprobara `data-chat` primero, pulsar "Registrar compra"
       * abriría el chat en vez de la compra.
       */
      if (event.target.closest('#wa-sync-templates')) {
        syncWaTemplates(event.target.closest('#wa-sync-templates'));
        return;
      }
      /*
       * MAPA DE PEDIDOS: filtros, herramientas y puntos. Va PRIMERO porque estos
       * botones viven dentro de tarjetas y de ventanas del mapa, que también son
       * táctiles; si se comprobara otra cosa antes, el toque haría lo de detrás.
       */
      const mapFilter = event.target.closest('[data-map-filter]');
      if (mapFilter) {
        state.ordersMap.filter = mapFilter.dataset.mapFilter || 'todo';
        state.ordersMap.fitted = false;
        renderOrdersMap();
        return;
      }
      const mapOpen = event.target.closest('[data-map-open]');
      if (mapOpen) {
        openOrdersMapPoint(mapOpen.dataset.mapOpen);
        return;
      }
      const mapCenter = event.target.closest('[data-map-center]');
      if (mapCenter) {
        centerOrdersMapPoint(mapCenter.dataset.mapCenter);
        return;
      }
      const mapChat = event.target.closest('[data-map-chat]');
      if (mapChat) {
        closeSheet();
        openChat(mapChat.dataset.mapChat);
        return;
      }
      // Cualquier ubicación guardada en un atributo abre el mapa centrado en ella.
      const anyMap = event.target.closest('[data-open-map]');
      if (anyMap) {
        openMapScreen({
          location: mapLocationFromAttr(anyMap.dataset.openMap),
          title: anyMap.dataset.mapTitle || 'Ubicación',
          conversationId: anyMap.dataset.mapConversation || '',
        });
        return;
      }
      /*
       * ACCIONES DEL MAPA (botón flotante, panel y capas). El mapa es una sola
       * pantalla: sus herramientas viven en el botón flotante, no en una barra.
       */
      if (event.target.closest('#mapa-acciones')) {
        openMapActions();
        return;
      }
      if (event.target.closest('#mapa-panel-handle') || event.target.closest('#mapa-scrim')) {
        toggleMapPanel(false);
        return;
      }
      const mapAction = event.target.closest('[data-map-action]');
      if (mapAction) {
        const accion = mapAction.dataset.mapAction;
        if (accion === 'lista') {
          closeSheet();
          toggleMapPanel();
          return;
        }
        if (accion === 'medir') {
          closeSheet();
          ordersMapToggleMeasure();
          return;
        }
        if (accion === 'aqui') {
          ordersMapUseMyLocation(mapAction);
          return;
        }
        if (accion === 'ajustar') {
          closeSheet();
          fitOrdersMap();
          return;
        }
        if (accion === 'seguir') {
          closeSheet();
          state.deliveryMap.autoFollow = true;
          state.deliveryActiveSessionId =
            (state.deliveryTracking ?? []).find((row) => row.status === 'ACTIVE')?.id ?? state.deliveryActiveSessionId;
          state.ordersMap.fitted = false;
          renderOrdersMap();
          fitDeliveryBounds();
          return;
        }
        if (accion === 'actualizar') {
          closeSheet();
          refreshOrdersMap({ full: true }).catch(() => {});
          refreshDeliveryTracking({ rebuild: true }).catch(() => {});
          return;
        }
        return;
      }
      const measurePoint = event.target.closest('[data-map-measure-point]');
      if (measurePoint) {
        const punto = ordersMapVisiblePoints().find((row) => row.key === measurePoint.dataset.mapMeasurePoint) ?? null;
        if (punto) ordersMapMeasureTo(punto);
        return;
      }
      const mapBase = event.target.closest('[data-map-base]');
      if (mapBase) {
        setOrdersMapBase(mapBase.dataset.mapBase);
        openMapActions(); // la hoja se repinta con la capa elegida marcada
        return;
      }
      const mapLayer = event.target.closest('[data-map-layer]');
      if (mapLayer) {
        const nombre = mapLayer.dataset.mapLayer;
        if (nombre === 'labels') {
          // Las calles y los nombres van ENCIMA de la foto: se encienden y apagan.
          toggleOrdersMapLabels();
          openMapActions();
          return;
        }
        if (nombre in state.ordersMap.layers) state.ordersMap.layers[nombre] = !state.ordersMap.layers[nombre];
        state.ordersMap.fitted = false;
        renderOrdersMap();
        openMapActions(); // la hoja se repinta con el estado nuevo de las capas
        return;
      }
      if (event.target.closest('#mapa-actualizar')) {
        refreshOrdersMap({ full: true }).catch(() => {});
        refreshDeliveryTracking({ rebuild: true }).catch(() => {});
        return;
      }
      const purchase = event.target.closest('[data-purchase]');
      if (purchase) {
        openPurchaseForm(purchase.dataset.purchase || null);
        return;
      }
      const stageChange = event.target.closest('[data-customer-stage]');
      if (stageChange) {
        changeCustomerStage(stageChange.dataset.customerStage, stageChange.dataset.stage);
        return;
      }
      const tagManage = event.target.closest('[data-customer-tags]');
      if (tagManage) {
        openCustomerTags(tagManage.dataset.customerTags);
        return;
      }
      const stageMenu = event.target.closest('[data-customer-stage-menu]');
      if (stageMenu) {
        openCustomerStageMenu(stageMenu.dataset.customerStageMenu);
        return;
      }
      if (event.target.closest('[data-new-conversation]')) {
        closeSheet();
        setTab('whatsapp');
        openNewConversationSheet();
        return;
      }
      const tabGo = event.target.closest('[data-tab]');
      if (tabGo && tabGo.closest('#sheet')) {
        closeSheet();
        setTab(tabGo.dataset.tab);
        return;
      }
      /*
       * Ubicación en el hilo: «⋯» abre sus acciones (ver mapa, usar para un pedido,
       * compartir). Se busca el mensaje en el hilo ya cargado: la ubicación viaja
       * con el mensaje, así que no hace falta pedirla otra vez.
       */
      const locMenu = event.target.closest('[data-loc-menu]');
      if (locMenu) {
        const id = locMenu.dataset.locMenu;
        const messages = state.wa.chat?.messages ?? [];
        const found = messages.find((row) => row.location?.id === id)?.location ?? null;
        if (found) openLocationActions({ location: found, conversationId: state.wa.selectedId });
        return;
      }
      // --- acciones comerciales (S4/S5): pedido, comprobante, programar ---
      if (event.target.closest('#wa-actions')) {
        const button = event.target.closest('#wa-actions');
        openChatActions(button.dataset.customer, button.dataset.conversation);
        return;
      }
      const dashboardTab = event.target.closest('[data-dashboard-tab]');
      if (dashboardTab) {
        setTab(dashboardTab.dataset.dashboardTab);
        return;
      }
      if (event.target.closest('[data-dashboard-profile]')) {
        setTab('perfil');
        return;
      }
      if (event.target.closest('[data-dashboard-notifications]')) {
        openNotificationsSheet();
        return;
      }
      if (event.target.closest('[data-push-enable]')) {
        enableCrmPush()
          .then(() => openNotificationsSheet())
          .catch((error) => toast(error.body?.message ?? 'No se pudieron activar las notificaciones'));
        return;
      }
      if (event.target.closest('[data-push-test]')) {
        testCrmPush().catch((error) => toast(error.body?.message ?? 'No se pudo probar las notificaciones'));
        return;
      }
      const noticeDismiss = event.target.closest('[data-notice-dismiss]');
      if (noticeDismiss) {
        dismissNotice(noticeDismiss.dataset.noticeDismiss);
        return;
      }
      const notificationOpen = event.target.closest('[data-notification-open]');
      if (notificationOpen) {
        openNotificationTarget(notificationOpen.dataset.notificationOpen, notificationOpen.dataset.notificationEntity).catch(() =>
          toast('No se pudo abrir la notificación'),
        );
        return;
      }
      const deliveryContact = event.target.closest('[data-delivery-contact]');
      if (deliveryContact) {
        // «Solicitar ubicación» deja además el aviso listo para enviar.
        const opciones =
          deliveryContact.dataset.deliveryAsk === 'location' ? { openTemplate: LOCATION_TEMPLATE } : {};
        openChat(deliveryContact.dataset.deliveryContact, opciones).catch(() => toast('No se pudo abrir el chat'));
        return;
      }
      const deliveryCenter = event.target.closest('[data-delivery-center]');
      if (deliveryCenter) {
        if (deliveryCenter.dataset.deliveryCenter === 'both') fitDeliveryBounds();
        else centerDelivery(deliveryCenter.dataset.deliveryCenter);
        return;
      }
      if (event.target.closest('[data-delivery-push]')) {
        enableCrmPush().catch(() => toast('No se pudieron activar las notificaciones'));
        return;
      }
      const deliveryStart = event.target.closest('[data-delivery-start]');
      if (deliveryStart) {
        startDelivery(deliveryStart.dataset.deliveryStart).catch((error) => {
          if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo iniciar entrega');
        });
        return;
      }
      const deliveryFocus = event.target.closest('[data-delivery-focus]');
      if (deliveryFocus) {
        state.deliveryActiveSessionId = deliveryFocus.dataset.deliveryFocus;
        state.ordersMap.fitted = false;
        state.deliveryMap.autoFollow = true;
        renderOrdersMap();
        fitDeliveryBounds();
        return;
      }
      const deliveryStop = event.target.closest('[data-delivery-stop]');
      if (deliveryStop) {
        stopDelivery(deliveryStop.dataset.deliveryStop, false).catch((error) => {
          if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo detener');
        });
        return;
      }
      const deliveryComplete = event.target.closest('[data-delivery-complete]');
      if (deliveryComplete) {
        stopDelivery(deliveryComplete.dataset.deliveryComplete, true).catch((error) => {
          if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo completar');
        });
        return;
      }
      if (event.target.closest('[data-delivery-refresh]')) {
        load({ keepTab: true }).catch(() => {});
        return;
      }
      if (event.target.closest('[data-open-drawer]')) {
        openDrawer();
        return;
      }
      if (event.target.closest('[data-simple-back]')) {
        if (state.tab === 'perfil-cliente' || state.tab === 'mapa') {
          setTab(state.previousTab && state.previousTab !== state.tab ? state.previousTab : 'hoy');
        } else {
          setTab('hoy');
        }
        return;
      }
      if (event.target.closest('#profile-actions')) {
        openProfileActions();
        return;
      }
      const profilePhoto = event.target.closest('[data-profile-photo]');
      if (profilePhoto) {
        openImageViewer(profilePhoto.dataset.profilePhoto, 'Foto del cliente');
        return;
      }
      const convAssign = event.target.closest('[data-conv-assign]');
      if (convAssign) {
        openAssignSheet(convAssign.dataset.convAssign || state.wa.selectedId);
        return;
      }
      const convAssignMe = event.target.closest('[data-conv-assign-me]');
      if (convAssignMe) {
        assignCurrentConversation('take', null, convAssignMe.dataset.convAssignMe || state.wa.selectedId);
        return;
      }
      const convAssignUser = event.target.closest('[data-conv-assign-user]');
      if (convAssignUser) {
        assignCurrentConversation(
          'assign',
          convAssignUser.dataset.convAssignUser,
          convAssignUser.dataset.conversation || state.wa.selectedId,
        );
        return;
      }
      const convTake = event.target.closest('[data-conv-take]');
      if (convTake) {
        assignCurrentConversation('take', null, convTake.dataset.convTake || state.wa.selectedId);
        return;
      }
      const convRelease = event.target.closest('[data-conv-release]');
      if (convRelease) {
        assignCurrentConversation('release', null, convRelease.dataset.convRelease || state.wa.selectedId);
        return;
      }
      const convReassign = event.target.closest('[data-conv-reassign]');
      if (convReassign) {
        // Reasignar es la MISMA hoja de asignación: se elige persona, sin adivinar.
        openAssignSheet(convReassign.dataset.convReassign || state.wa.selectedId);
        return;
      }
      const orderNew = event.target.closest('[data-order-new]');
      if (orderNew) {
        openOrderForm({
          customerId: orderNew.dataset.orderNew,
          conversationId: orderNew.dataset.conversation ?? '',
        });
        return;
      }
      const profileOrder = event.target.closest('[data-profile-order]');
      if (profileOrder) {
        state.customerProfileOrderId = profileOrder.dataset.profileOrder || null;
        renderCustomerProfile();
        return;
      }
      const orderFilter = event.target.closest('[data-order-filter]');
      if (orderFilter) {
        state.pedidosFilter = orderFilter.dataset.orderFilter;
        renderPedidos();
        return;
      }
      const attachLoc = event.target.closest('[data-order-attach-loc]');
      if (attachLoc) {
        attachLocationToOrder(attachLoc.dataset.orderAttachLoc, attachLoc.dataset.attachLocation, attachLoc);
        return;
      }
      const sheetActions = event.target.closest('[data-sheet-actions]');
      if (sheetActions) {
        // El botón flotante sabe de qué es la hoja abierta: el ítem o la factura.
        if (sheetActions.dataset.item) openOrderActionsMenu(sheetActions.dataset.item);
        else if (sheetActions.dataset.receiptActions) openReceiptActionsMenu(state.receiptContext);
        return;
      }
      const itemWa = event.target.closest('[data-item-wa]');
      if (itemWa) {
        openItemWhatsAppSheet(itemWa.dataset.itemWa);
        return;
      }
      const receiptOpen = event.target.closest('[data-receipt-open]');
      if (receiptOpen) {
        window.open(
          `${app2Base()}/api/admin/orders/${encodeURIComponent(receiptOpen.dataset.receiptOpen)}/receipt`,
          '_blank',
          'noopener',
        );
        return;
      }
      const receiptShare = event.target.closest('[data-receipt-share]');
      if (receiptShare) {
        const receipt = state.receiptContext?.receipt ?? null;
        if (receipt) {
          shareReceiptPdf({
            url: `${app2Base()}/api/admin/orders/${encodeURIComponent(receiptShare.dataset.receiptShare)}/factura`,
            receipt,
          });
        }
        return;
      }
      const orderDelivery = event.target.closest('[data-order-delivery]');
      if (orderDelivery) {
        const id = orderDelivery.dataset.orderDelivery;
        const item = state.items.find((candidate) => candidate.id === id) ?? null;
        openDeliveryAssignSheet({ orderId: id, order: item ? itemOrder(item) : null });
        return;
      }
      const orderDeliveryUser = event.target.closest('[data-order-delivery-user]');
      if (orderDeliveryUser) {
        assignOrderToDelivery(
          orderDeliveryUser.dataset.orderId,
          orderDeliveryUser.dataset.orderDeliveryUser,
          orderDeliveryUser,
        );
        return;
      }
      const orderEdit = event.target.closest('[data-order-edit]');
      if (orderEdit) {
        openOrderEditor(orderEdit.dataset.orderEdit);
        return;
      }
      const orderOpen = event.target.closest('[data-order-open]');
      if (orderOpen) {
        openReceipt(orderOpen.dataset.orderOpen);
        return;
      }
      const receipt = event.target.closest('[data-receipt]');
      if (receipt) {
        openReceipt(receipt.dataset.receipt);
        return;
      }
      const orderStatusChange = event.target.closest('[data-order-status-change]');
      if (orderStatusChange) {
        openOrderStatusSheet(orderStatusChange.dataset.orderStatusChange, {
          order: state.receiptContext?.order ?? {},
          integrity: { operationalStatus: orderStatusChange.dataset.orderStatusCurrent },
        });
        return;
      }
      const saleCancel = event.target.closest('[data-sale-cancel]');
      if (saleCancel) {
        openCancelSale(saleCancel.dataset.saleCancel);
        return;
      }
      const scheduledNew = event.target.closest('[data-scheduled-new]');
      if (scheduledNew) {
        openScheduledForm({
          customerId: scheduledNew.dataset.scheduledNew,
          conversationId: scheduledNew.dataset.conversation ?? '',
          orderId: scheduledNew.dataset.orderId ?? '',
        });
        return;
      }
      const scheduledCancel = event.target.closest('[data-scheduled-cancel]');
      if (scheduledCancel) {
        scheduledAction(scheduledCancel.dataset.scheduledCancel, 'cancel', { reason: 'cancelado en el panel' });
        return;
      }
      const metricsChip = event.target.closest('[data-metrics]');
      if (metricsChip) {
        loadMetrics(metricsChip.dataset.metrics);
        return;
      }
      const reportChip = event.target.closest('[data-report-period]');
      if (reportChip) {
        loadSalesReport(reportChip.dataset.reportPeriod);
        return;
      }
      const review = event.target.closest('[data-review]');
      if (review) {
        reconcileMedia(review.dataset.reviewId, review.dataset.review);
        return;
      }
      const role = event.target.closest('[data-user-role]');
      if (role) {
        updateUser(role.dataset.userRole, { role: role.dataset.role });
        return;
      }
      const active = event.target.closest('[data-user-active]');
      if (active) {
        updateUser(active.dataset.userActive, { active: active.dataset.active === 'true' });
        return;
      }
      const password = event.target.closest('[data-user-password]');
      if (password) {
        const usuario = (state.users ?? []).find((row) => row.id === password.dataset.userPassword);
        openUserPasswordSheet(
          password.dataset.userPassword,
          usuario?.display_name ?? usuario?.username ?? 'Usuario',
        );
        return;
      }
      // El ojo de cualquier campo de contraseña: solo cambia el `type` del campo de al lado.
      const passEye = event.target.closest('[data-pass-eye]');
      if (passEye) {
        const input = passEye.closest('.pass')?.querySelector('input');
        if (!input) return;
        const ver = input.type === 'password';
        input.type = ver ? 'text' : 'password';
        passEye.setAttribute('aria-pressed', String(ver));
        passEye.setAttribute('aria-label', ver ? 'Ocultar la contraseña' : 'Ver la contraseña');
        passEye.innerHTML = ver ? ICONS.eyeOff : ICONS.eye;
        input.focus();
        return;
      }
      // ---------------------------------------------- multimedia (S3)
      const viewImage = event.target.closest('[data-media-view]');
      if (viewImage) {
        openViewer(viewImage.dataset.mediaView);
        return;
      }
      if (event.target.closest('#media-viewer') || event.target.closest('#media-viewer-close')) {
        closeViewer();
        return;
      }
      const playAudio = event.target.closest('[data-audio-play]');
      if (playAudio) {
        toggleAudio(playAudio.dataset.audioPlay, playAudio.dataset.audioSrc);
        return;
      }
      const retry = event.target.closest('[data-media-retry]');
      if (retry) {
        retryMedia(retry.dataset.mediaRetry);
        return;
      }
      if (event.target.closest('#wa-attach')) {
        openAttachSheet(state.wa.selectedId);
        return;
      }
      if (event.target.closest('#wa-mic')) {
        openRecorder(state.wa.selectedId);
        return;
      }
      // Enviar una plantilla desde el chat: el botón del compositor y la entrada
      // del menú ⋯ hacen lo mismo (elegir plantilla y rellenar sus huecos).
      if (event.target.closest('#wa-template-open') || event.target.closest('[data-wa-template]')) {
        openWaTemplateSheet();
        return;
      }
      if (event.target.closest('[data-wa-ask-location]')) {
        askForLocation();
        return;
      }
      if (event.target.closest('[data-wa-confirm-order]')) {
        // Confirmación del pedido: los datos (número, total, pago) van puestos
        // solos, así el cliente solo tiene que decir «sí» o corregir algo.
        openWaTemplateSheet({ templateName: ORDER_CONFIRM_TEMPLATE });
        return;
      }
      // --------------------------------------------- respuestas rápidas
      if (event.target.closest('[data-quick-replies]')) {
        openQuickReplies();
        return;
      }
      if (event.target.closest('[data-qr-new]')) {
        openQuickReplyForm(null);
        return;
      }
      const qrPick = event.target.closest('[data-qr-insert]');
      if (qrPick) {
        insertQuickReply(qrPick.dataset.qrInsert);
        return;
      }
      const qrMore = event.target.closest('[data-qr-menu]');
      if (qrMore) {
        qrMenuId = qrMenuId === qrMore.dataset.qrMenu ? null : qrMore.dataset.qrMenu;
        renderQuickReplies();
        return;
      }
      const qrEdit = event.target.closest('[data-qr-edit]');
      if (qrEdit) {
        openQuickReplyForm(qrEdit.dataset.qrEdit);
        return;
      }
      const qrDel = event.target.closest('[data-qr-del]');
      if (qrDel) {
        quickReplyDelete(qrDel.dataset.qrDel);
        return;
      }
      if (event.target.closest('[data-qr-back]')) {
        openQuickReplies();
        return;
      }
      const customer = event.target.closest('[data-customer]');
      if (customer) {
        openCustomer(customer.dataset.customer);
        return;
      }
      if (event.target.closest('[data-customer-back]')) {
        setTab(state.previousTab && state.previousTab !== 'perfil-cliente' ? state.previousTab : 'whatsapp');
        return;
      }
      const newFollowup = event.target.closest('[data-followup-new]');
      if (newFollowup) {
        openFollowupForm({
          customerId: newFollowup.dataset.followupNew,
          conversationId: newFollowup.dataset.conversation ?? '',
          orderId: newFollowup.dataset.orderId ?? '',
        });
        return;
      }
      const done = event.target.closest('[data-followup-done]');
      if (done) {
        followupAction(done.dataset.followupDone, 'complete');
        return;
      }
      const postpone = event.target.closest('[data-followup-postpone]');
      if (postpone) {
        followupAction(postpone.dataset.followupPostpone, 'postpone', { days: 3 });
        return;
      }
      const cancel = event.target.closest('[data-followup-cancel]');
      if (cancel) {
        followupAction(cancel.dataset.followupCancel, 'cancel', { reason: 'cancelado en el panel' });
        return;
      }
      const pause = event.target.closest('[data-pause]');
      if (pause) {
        customerAction(pause.dataset.pause, 'pause');
        return;
      }
      const resume = event.target.closest('[data-resume]');
      if (resume) {
        customerAction(resume.dataset.resume, 'resume');
        return;
      }
      const optin = event.target.closest('[data-optin]');
      if (optin) {
        customerAction(optin.dataset.optin, 'optin');
        return;
      }
      const optout = event.target.closest('[data-optout]');
      if (optout) {
        const id = optout.dataset.optout;
        // Dos toques: dejar de escribirle a alguien para siempre no puede ser
        // un roce con el dedo.
        if (pendingOptOut !== id) {
          pendingOptOut = id;
          optout.textContent = '¿Seguro? Toca otra vez';
          toast('Si tocas otra vez, este cliente no recibirá más mensajes');
          return;
        }
        pendingOptOut = null;
        customerAction(id, 'optout');
        return;
      }
      const chat = event.target.closest('[data-chat]');
      if (chat) {
        openChat(chat.dataset.chat, { followupId: chat.dataset.followup ?? null });
        return;
      }
      const convMore = event.target.closest('[data-conv-more]');
      if (convMore) {
        openConvMenu(convMore.dataset.convMore);
        return;
      }
      const convAct = event.target.closest('[data-conv-act]');
      if (convAct) {
        runConvAction(convAct.dataset.convAct, convAct.dataset.convId);
        return;
      }
      if (event.target.closest('[data-wa-sel-clear]')) {
        state.wa.selected.clear();
        renderWaList();
        return;
      }
      const selAll = event.target.closest('[data-wa-sel-all]');
      if (selAll) {
        const visibles = waVisibleConversations().map((row) => row.id);
        const todas = visibles.length > 0 && visibles.every((id) => state.wa.selected.has(id));
        state.wa.selected.clear();
        if (!todas) visibles.forEach((id) => state.wa.selected.add(id));
        renderWaList();
        return;
      }
      const bulk = event.target.closest('[data-wa-bulk]');
      if (bulk) {
        runWaBulk(bulk.dataset.waBulk);
        return;
      }
      const conv = event.target.closest('[data-conv]');
      if (conv) {
        // Con una selección abierta, tocar una fila selecciona o quita (el gesto
        // de WhatsApp): para abrirla se cancela antes con la ✕.
        if (waPressFired) {
          waPressFired = false;
          return;
        }
        if (state.wa.selected.size) {
          toggleWaSelect(conv.dataset.conv);
          return;
        }
        selectConversation(conv.dataset.conv);
        return;
      }
      // Reintentos de la bandeja: un fallo del API se ve y se puede volver a probar.
      if (event.target.closest('#wa-retry')) {
        state.wa.listError = false;
        renderWaList();
        load({ keepTab: true })
          .then(() => refreshWhatsapp())
          .catch(() => {});
        return;
      }
      if (event.target.closest('#wa-retry-thread')) {
        if (state.wa.selectedId) loadWaThread(state.wa.selectedId, { force: true });
        return;
      }
      if (event.target.closest('[data-client-search-open]')) {
        state.clientSearchOpen = true;
        renderMobileHeader();
        requestAnimationFrame(() => $('#client-appbar-search')?.focus());
        return;
      }
      if (event.target.closest('[data-client-search-close]')) {
        state.clientSearchOpen = false;
        if (state.q) {
          state.q = '';
          const search = $('#search');
          if (search) search.value = '';
          renderClientes();
        }
        renderMobileHeader();
        return;
      }
      if (event.target.closest('[data-client-search-clear]')) {
        state.clientSearchOpen = false;
        state.q = '';
        const search = $('#search');
        if (search) search.value = '';
        renderClientes();
        renderMobileHeader();
        return;
      }
      if (event.target.closest('[data-client-actions-open]')) {
        openClientsActions();
        return;
      }
      if (event.target.closest('[data-wa-search-open]')) {
        state.wa.searchOpen = true;
        renderMobileHeader();
        requestAnimationFrame(() => $('#wa-appbar-search')?.focus());
        return;
      }
      if (event.target.closest('[data-wa-search-close]')) {
        state.wa.searchOpen = false;
        if (state.wa.q) {
          state.wa.q = '';
          const search = $('#wa-search');
          if (search) search.value = '';
          refreshWhatsapp().catch(() => renderWaList());
        }
        renderMobileHeader();
        return;
      }
      if (event.target.closest('[data-wa-search-clear]')) {
        state.wa.searchOpen = false;
        state.wa.q = '';
        const search = $('#wa-search');
        if (search) search.value = '';
        refreshWhatsapp().catch(() => renderWaList());
        renderMobileHeader();
        return;
      }
      if (event.target.closest('[data-wa-date-open]')) {
        openWaDateMenu();
        return;
      }
      if (event.target.closest('#wa-date-menu')) {
        openWaDateMenu();
        return;
      }
      const waDate = event.target.closest('[data-wa-date]');
      if (waDate) {
        closeSheet();
        setWaDateFilter(waDate.dataset.waDate);
        return;
      }
      const waDateDay = event.target.closest('[data-wa-date-day]');
      if (waDateDay) {
        closeSheet();
        setWaDateFilter('custom', { from: waDateDay.dataset.waDateDay, to: waDateDay.dataset.waDateDay });
        return;
      }
      if (event.target.closest('[data-wa-date-custom]')) {
        openWaCustomDateSheet();
        return;
      }
      const wa = event.target.closest('[data-wa]');
      if (wa) {
        const item = state.items.find((candidate) => candidate.id === wa.dataset.wa);
        if (item) {
          const message = state.messages[0];
          openWhatsApp(item, message?.body ?? 'Hola {nombre}, te escribo de {negocio}.');
        }
        return;
      }
      const open = event.target.closest('[data-open]');
      if (open) {
        state.openId = open.dataset.open;
        renderSheet();
        return;
      }
      const del = event.target.closest('[data-del-message]');
      if (del) {
        const id = del.dataset.delMessage;
        // Dos toques: borrar una plantilla al primer roce sería un error caro.
        if (pendingDelete !== id) {
          pendingDelete = id;
          renderMensajes();
          toast('Toca otra vez para borrar');
          return;
        }
        pendingDelete = null;
        api(`/api/admin/messages/${encodeURIComponent(id)}`, { method: 'DELETE' })
          .then((body) => {
            state.messages = body.messages;
            renderMensajes();
            toast('Plantilla borrada');
          })
          .catch(() => toast('No se pudo borrar'));
        return;
      }
      const edit = event.target.closest('[data-edit-message]');
      if (edit) {
        openMessageForm(state.messages.find((message) => message.id === edit.dataset.editMessage));
        return;
      }
      if (event.target.closest('[data-close-sheet]')) {
        closeSheet();
      }
    });

    $('#nueva-plantilla').addEventListener('click', () => openMessageForm(null));
    $('#clientes-acciones').addEventListener('click', () => openClientsActions());
    $('#compra-nueva-ped').addEventListener('click', () => openPurchaseForm(null));

    // Interruptores del plan de postventa (Ajustes): cada día se activa o apaga.
    document.addEventListener('change', (event) => {
      const toggle = event.target.closest('[data-plan-toggle]');
      if (toggle) toggleFollowupDay(toggle.dataset.planToggle, toggle.checked);
      const deliveryAssign = event.target.closest('[data-delivery-assign]');
      if (deliveryAssign && deliveryAssign.value) {
        api(`/api/admin/orders/${encodeURIComponent(deliveryAssign.dataset.deliveryAssign)}/delivery/assign`, {
          method: 'POST',
          body: JSON.stringify({ deliveryUserId: deliveryAssign.value }),
        })
          .then(() => load({ keepTab: true }))
          .then(() => toast('Delivery asignado'))
          .catch((error) => {
            if (error.message !== 'unauthorized') toast(error.body?.message ?? 'No se pudo asignar delivery');
          });
      }
    });

    // Buscar dentro de un audio (el deslizador manda en la reproducción).
    document.addEventListener('input', (event) => {
      const seek = event.target.closest('[data-audio-seek]');
      if (seek) seekAudio(seek.dataset.audioSeek, Number(seek.value));
    });

    // ------------------------------------------------------- menú lateral
    $('#menu').addEventListener('click', () => (state.drawer ? closeDrawer() : openDrawer()));
    $('#drawer-close').addEventListener('click', () => closeDrawer());
    $('#scrim').addEventListener('click', () => closeDrawer());
    $('#drawer').addEventListener('click', (event) => {
      // Elegir una opción del menú navega y lo cierra.
      if (event.target.closest('[data-tab]')) closeDrawer();
    });
    $('#logout-drawer').addEventListener('click', () => $('#logout').click());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!$('#media-viewer')?.hidden) {
          closeViewer();
          return;
        }
        if (state.drawer) {
          closeDrawer();
          return;
        }
        if (!$('#sheet')?.hidden) closeSheet();
      }
    });

    // -------------------------------------------------- bandeja de WhatsApp
    /*
     * La bandeja no tiene botón de recargar: se refresca sola (sondeo de 8 s) y
     * al entrar en la pestaña. Buscar y filtrar sí son acciones de la persona.
     */
    $('#wa-search').addEventListener('input', (event) => {
      state.wa.q = event.target.value.trim();
      refreshWhatsapp().catch(() => renderWaList());
    });
    document.addEventListener('input', (event) => {
      const appSearch = event.target.closest('#wa-appbar-search');
      if (appSearch) {
        state.wa.q = appSearch.value.trim();
        const search = $('#wa-search');
        if (search && search.value !== state.wa.q) search.value = state.wa.q;
        refreshWhatsapp().catch(() => renderWaList());
        return;
      }
      const clientSearch = event.target.closest('#client-appbar-search');
      if (clientSearch) {
        state.q = clientSearch.value.trim();
        const search = $('#search');
        if (search && search.value !== state.q) search.value = state.q;
        renderClientes();
      }
    });
    $('#wa-filters').addEventListener('click', (event) => {
      if (event.target.closest('#wa-notify')) {
        enableCrmPush()
          .then((enabled) => {
          state.wa.notify = enabled === true;
          localStorage.setItem(WA_NOTIFY_KEY, state.wa.notify ? '1' : '0');
          renderWhatsapp();
          })
          .catch(() => toast('No se pudieron activar las notificaciones'));
        return;
      }
      if (event.target.closest('#wa-sound')) {
        state.wa.sound = !state.wa.sound;
        localStorage.setItem(WA_SOUND_KEY, state.wa.sound ? '1' : '0');
        renderWhatsapp();
        if (state.wa.sound) playNewMessageSound();
        return;
      }
      const chip = event.target.closest('[data-wa-filter]');
      if (!chip) return;
      state.wa.filter = chip.dataset.waFilter;
      state.wa.selected.clear();
      $$('[data-wa-filter]').forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.waFilter === state.wa.filter)),
      );
      refreshWhatsapp().catch(() => renderWaList());
    });
    $('#wa-new-chat').addEventListener('click', () => openNewConversationSheet());
    // En el móvil, ← vuelve a la lista de conversaciones.
    $('#wa-back').addEventListener('click', () => setWaView('list'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') waPollTick();
    });

    $('#logout').addEventListener('click', async () => {
      stopDeliveryWatch();
      stopDeliveryEvents();
      await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' });
      showLogin('Sesión cerrada.');
    });
  }

  /** Formulario de plantilla (alta o edición) dentro de la hoja inferior. */
  function openMessageForm(message) {
    state.openId = null;
    $('#sheet-title').textContent = message ? 'Editar plantilla' : 'Nueva plantilla';
    $('#sheet-body').innerHTML = `
      <label class="field">
        <span class="field__label">Nombre</span>
        <input class="field__input" id="msg-name" value="${escapeHtml(message?.name ?? '')}" placeholder="Recordatorio de entrega" />
      </label>
      <label class="field">
        <span class="field__label">Texto del mensaje</span>
        <textarea class="field__area" id="msg-body" placeholder="Hola {nombre}, …">${escapeHtml(message?.body ?? '')}</textarea>
      </label>
      <p class="view__hint">Variables: {nombre} · {frasco} · {cantidad} · {total} · {negocio}</p>
      <button class="btn btn--primary btn--block" id="msg-save" type="button">Guardar plantilla</button>
    `;
    $('#sheet').hidden = false;
    $('#msg-save').addEventListener('click', async () => {
      const name = $('#msg-name').value.trim();
      const body = $('#msg-body').value.trim();
      if (!name || !body) {
        toast('Hacen falta nombre y texto');
        return;
      }
      try {
        const result = await api('/api/admin/messages', {
          method: 'POST',
          body: JSON.stringify({ id: message?.id, name, body, position: message?.position ?? 99 }),
        });
        state.messages = result.messages;
        renderMensajes();
        $('#sheet').hidden = true;
        toast('Plantilla guardada');
      } catch {
        toast('No se pudo guardar');
      }
    });
  }

  // --------------------------------------------------------------- arranque

  async function boot() {
    initEvents();
    paintIcons();
    initPwa();

    // Un único temporizador para la bandeja de WhatsApp (8 s, solo cuando toca).
    setInterval(waPollTick, 8000);

    // Atajos del icono instalado (manifest → shortcuts): /admin/?v=clientes
    const query = new URLSearchParams(location.search);
    const wanted = query.get('v');
    if (VIEWS.includes(wanted)) state.tab = wanted;

    /*
     * Sin conexión NO se puede comprobar la sesión, pero el panel ya estuvo
     * abierto antes en este teléfono: se muestra con la última copia en vez de
     * pedir la clave a alguien que está en la calle sin datos.
     */
    const cached = readSnapshot();
    if (!navigator.onLine && cached) {
      showApp();
      await load({ keepTab: true });
      await applyDeepLink(query);
      toast('Sin conexión: datos guardados en el teléfono');
      return;
    }

    /*
     * Enlace con la clave dentro (`/panel?token=…`, el de antes; nginx lo
     * redirige a `/admin/?token=…`): se entra solo y se quita la clave de la
     * barra de direcciones, para que no quede a la vista ni en el historial.
     */
    const linkToken = query.get('token');
    if (linkToken) {
      try {
        await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: linkToken }) });
        history.replaceState(null, '', `${location.pathname}${wanted ? `?v=${wanted}` : ''}`);
        showApp();
        await load();
        await applyDeepLink(query);
        return;
      } catch {
        /* Clave caducada o CRM apagado: se cae al acceso normal, que explica el motivo. */
      }
    }

    if (await checkSession()) {
      showApp();
      await load();
      await applyDeepLink(query);
    } else if (cached) {
      // El servidor no contesta (o la sesión caducó): si hay copia, se enseña.
      showApp();
      await load({ keepTab: true });
      await applyDeepLink(query);
    } else {
      showLogin();
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
