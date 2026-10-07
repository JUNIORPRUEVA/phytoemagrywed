// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/*
 * El texto se normaliza a LF antes de comparar: el repositorio guarda LF
 * (`.gitattributes`, `* text=auto eol=lf`) y el contenedor recibe LF, pero una
 * copia editada en Windows puede tener CRLF. Sin esto, una comparación podía
 * pasar en Windows y tumbar el build en el servidor (`npm run verify`).
 */
const app = readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const html = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const css = readFileSync(new URL('../public/admin/admin.css', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

describe('delivery tracking frontend UAT guards', () => {
  it('Mis entregas abre el chat correcto con mensaje listo sin cambiar estado', () => {
    expect(app).toContain('function deliveryMessage(order)');
    expect(app).toContain('data-delivery-contact="${escapeHtml(order.id)}"');
    expect(app).toContain('await openChat(order.conversation_id, { draft: deliveryMessage(order), deliveryOrderId: order.id });');
    expect(app).toContain("state.wa.draft = options.draft ?? ''");
    expect(app).toContain('state.wa.deliveryOrderId = options.deliveryOrderId ?? null');
    expect(app).toContain('state.wa.deliveryStartReadyOrderId = null');

    const contactBlock = app.slice(app.indexOf('async function contactDeliveryCustomer'), app.indexOf('async function applyDeepLink'));
    expect(contactBlock).toContain('openChat(order.conversation_id');
    expect(contactBlock).not.toContain('/delivery/start');
    expect(contactBlock).not.toContain('/delivery-tracking/');
  });

  it('el detalle de entrega obliga contacto primero y muestra mapa cacheable compacto', () => {
    expect(app).toContain('function updateDeliveryDetailMap');
    expect(app).toContain('if (Array.isArray(point) && point.length >= 2)');
    expect(app).toContain('if (meters === null || meters === undefined || meters === \'\') return \'\';');
    expect(app).toContain('const measuredDistance = current && destination ? metersBetween(current, destination) : null;');
    expect(app).toContain('class="delivery-detail-map" id="delivery-detail-map"');
    expect(app).toContain('class="delivery-map-mode" data-delivery-map-mode');
    expect(app).toContain("return MAP_BASE_LAYERS[state.deliveryDetailMap?.base] ? state.deliveryDetailMap.base : 'satelite';");
    expect(app).toContain('function toggleDeliveryDetailMapBase');
    expect(app).toContain(".bindTooltip('Cliente'");
    expect(app).toContain(".bindTooltip('Tu ubicación'");
    expect(app).toContain('if (activeOrder && session.order_id === activeOrder.id) updateDeliveryDetailMap(activeOrder);');
    expect(app).toContain('class="icon-btn delivery-detail-back"');
    expect(app).toContain('function deliveryDetailPanelHtml');
    expect(app).toContain("document.body.dataset.deliveryDetail = 'true'");
    expect(app).toContain('function openDeliveryOrderDetail');
    expect(app).toContain("touchZoom: 'center'");
    expect(app).toContain('scrollWheelZoom: true');
    expect(app).toContain('maxZoom: 22');
    expect(app).toContain('Delivery cobrado');
    expect(app).toContain('Primero contacta al cliente');
    expect(app).toContain('Luego podrás iniciar la entrega.');
    expect(app).toContain('Aceptar y contactar');
    expect(app).toContain('data-delivery-order-detail');
    expect(app).toContain('Ver pedido');
    expect(app).toContain('Voy saliendo para allá. Por favor mantente pendiente para coordinar la entrega.');
    expect(app).toContain("const DELIVERY_ASSIGNMENT_CUSTOMER_NOTICE = 'Ya pasé la orden al mensajero. Él te contactará para la entrega.';");
    expect(app).toContain('function sendDeliveryAssignmentCustomerNotice');
    expect(app).toContain('deliveryAssignmentNotice: true');
    expect(app).toContain("uploadKey(`delivery-notice-${orderId}`)");
    expect(app.match(/data-delivery-contact=/g)).toHaveLength(1);
    const renderBlock = app.slice(app.indexOf('function renderDelivery'), app.indexOf('function openDeliveryOrder'));
    expect(renderBlock).not.toContain('<div><h1>Entrega</h1>');
    expect(css).toContain("body[data-delivery-detail='true'] .mobile-header");
    expect(css).toContain("body[data-delivery-detail='true'] {");
    expect(css).toContain("body[data-delivery-detail='true'] .app");
    expect(css).toContain('display: none');
    expect(css).toContain('height: calc(100dvh - var(--pe-tabbar)');
    expect(css).toContain('overflow: hidden');
    expect(css).toContain('animation: delivery-action-breathe');
    expect(css).toContain('@keyframes delivery-action-sheen');
    expect(css).toContain('.delivery-map-label--customer');
    expect(css).toContain('.delivery-map-label--driver');
  });

  it('al asignar delivery permite comentario interno visible en la orden', () => {
    expect(app).toContain('id="delivery-assign-note"');
    expect(app).toContain('Comentario para el delivery');
    expect(app).toContain('body: JSON.stringify({ deliveryUserId, deliveryNote })');
    expect(app).toContain('function deliveryAssignmentNoteHtml');
    expect(app).toContain('Comentario para esta entrega');
    expect(app).toContain('No se envía al cliente.');
  });

  it('al entrar al detalle calcula distancia con GPS sin iniciar tracking ni cambiar estado', () => {
    expect(app).toContain('function getDeliveryPreviewPosition');
    expect(app).toContain('maximumAge: 30000');
    expect(app).toContain('state.deliveryPreviewPoint = { orderId, loading: true');
    expect(app).toContain('refreshDeliveryPreviewPosition(orderId).catch(() => {});');
    expect(app).toContain('Activa ubicación para calcular distancia');
    const previewBlock = app.slice(app.indexOf('async function refreshDeliveryPreviewPosition'), app.indexOf('async function rollbackDeliveryStart'));
    expect(previewBlock).not.toContain('/delivery/start');
    expect(previewBlock).not.toContain('sendDeliveryPoint');
  });

  it('en chat abierto desde delivery oculta acciones comerciales flotantes', () => {
    expect(app).toContain('const deliveryChatMode = Boolean(data.deliveryContext?.asDelivery || state.wa.deliveryOrderId);');
    expect(app).toContain('actions.hidden = deliveryChatMode');
    expect(app).toContain('button.hidden || state.wa.chat?.deliveryContext?.asDelivery || state.wa.deliveryOrderId');
    expect(html).toContain('id="wa-delivery-cta"');
    expect(app).toContain('state.wa.deliveryStartReadyOrderId = resultado.deliveryOrder.id ?? state.wa.deliveryOrderId');
    expect(app).toContain('data-delivery-start="${escapeHtml(deliveryOrderId)}"');
    expect(app).toContain('Volver a entrega');
    expect(app).toContain('Iniciar entrega');
    expect(css).toContain('.wa__delivery-cta');
    expect(css).toContain('@keyframes delivery-chat-cta-in');
  });

  it('la app instalada no permite zoom de página por pellizco ni doble toque', () => {
    expect(html).toContain('maximum-scale=1, user-scalable=no');
    expect(app).toContain('function lockAppZoom()');
    expect(app).toContain("'touchmove'");
    expect(app).toContain("document.addEventListener('gesturestart'");
    expect(app).toContain('lockAppZoom();');
    expect(app).toContain('function isMapGestureTarget');
    expect(app).toContain("'#orders-map, #delivery-detail-map'");
  });

  it('carga mapa real Leaflet con tiles de OpenStreetMap y atribución', () => {
    expect(html).toContain('/admin/vendor/leaflet/leaflet.css');
    expect(html).toContain('/admin/vendor/leaflet/leaflet.js');
    expect(html).toContain('/admin/app.js?v=order-qty-polish-57');
    expect(html).toContain('/admin/admin.css?v=order-qty-polish-57');
    expect(html).not.toContain('unpkg.com/leaflet');
    expect(app).toContain('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(app).toContain('OpenStreetMap contributors');
  });

  it('pide GPS inicial antes de crear tracking para evitar sesiones zombie', () => {
    const startDelivery = app.indexOf('async function startDelivery(orderId, button = null)');
    const getInitial = app.indexOf('await getInitialDeliveryPosition()', startDelivery);
    const startApi = app.indexOf('/delivery/start', startDelivery);
    expect(startDelivery).toBeGreaterThan(-1);
    expect(getInitial).toBeGreaterThan(startDelivery);
    expect(startApi).toBeGreaterThan(getInitial);
    expect(app).toContain('Necesitas permitir acceso a tu ubicación para iniciar la entrega.');
  });

  it('muestra solo estados operativos simples en el panel de delivery', () => {
    expect(app).toContain('function getOrderOperationalStatus');
    expect(app).toContain("return 'PENDIENTE'");
    expect(app).toContain("return 'EN_CAMINO'");
    expect(app).toContain("return 'ENTREGADO'");
    expect(app).toContain("return 'CANCELADO'");
    /*
     * La lista de entregas es ahora la lista del mapa: cuando no hay nada que
     * enseñar lo dice claro, y una entrega en curso sin punto de entrega pide la
     * ubicación (antes eso era un texto aparte en la pantalla de Delivery).
     */
    expect(app).toContain('Todavía no hay puntos guardados');
    expect(app).toContain('Ninguna entrega en curso ahora mismo.');
    expect(app).toContain('Solicitar ubicación');
    expect(app).not.toContain('No hay pedidos abiertos con ubicación de entrega.');
  });

  it('tiene rollback operativo si watchPosition falla al arrancar', () => {
    expect(app).toContain('async function rollbackDeliveryStart');
    expect(app).toContain('/delivery-tracking/${encodeURIComponent(sessionId)}/stop');
    expect(app).toContain('/api/admin/items/${encodeURIComponent(orderId)}');
    expect(app).toContain('Date.now() - state.deliveryWatchStartedAt <= 5000');
  });

  it('muestra precisión GPS buena, moderada y baja sin bloquear tracking', () => {
    expect(app).toContain('Buena precisión');
    expect(app).toContain('Precisión moderada');
    expect(app).toContain('Baja precisión GPS');
    expect(app).toContain('meters <= 20');
    expect(app).toContain('meters <= 50');
  });

  it('actualiza marcador existente sin render completo en location_updated', () => {
    const eventStart = app.indexOf("source.addEventListener('delivery.location_updated'");
    const eventEnd = app.indexOf("source.addEventListener('delivery.tracking_stopped'", eventStart);
    const eventBlock = app.slice(eventStart, eventEnd);
    expect(eventBlock).toContain('updateDeliveryMap');
    expect(eventBlock).not.toContain('renderDelivery()');
    // Ni el repintado de la pantalla entera del mapa: el GPS llega cada pocos
    // segundos y rehacer la lista en cada punto la haría parpadear.
    expect(eventBlock).not.toContain('renderOrdersMap()');
    expect(app).toContain('state.deliveryMap.deliveryMarker.setLatLng(currentLatLng)');
  });

  it('usa el mapa principal y un mapa real de fondo en el detalle de entrega', () => {
    // Hay dos instancias controladas: el mapa operativo grande y el fondo real
    // del detalle de entrega. Ambas se limpian explícitamente.
    expect(app.match(/window\.L\.map\(/g)).toHaveLength(3);
    expect(app).toContain('if (state.ordersMap.map && state.ordersMap.map.getContainer?.() === el) return state.ordersMap.map;');
    expect(app).toContain('function ensureDeliveryMap() {\n    return ensureOrdersMap();');
    expect(app).toContain('function resetDeliveryDetailMap');
    expect(app).toContain('function ensureDeliveryDetailMap');
    expect(app).toContain('state.deliveryMap.customerMarker = window.L.marker');
    expect(app).toContain('state.deliveryMap.deliveryMarker = window.L.marker');
    expect(app).toContain('state.deliveryMap.deliveryMarker.setLatLng(currentLatLng)');
    expect(app).toContain('state.deliveryMap.routeLine.setLatLngs(points)');
  });

  it('tiene controles flotantes, lista plegable, fit bounds y auto-follow', () => {
    // Los botones del mapa flotan sobre él (antes eran una barra y unos pies de
    // página propios de la pantalla de Delivery).
    expect(html).toContain('class="map-appbar"');
    expect(html).toContain('class="map-fab"');
    expect(html).toContain('class="map-live"');
    expect(html).toContain('class="map-panel"');
    expect(html).toContain('class="map-scrim"');
    expect(app).toContain('function openMapActions');
    expect(app).toContain('function toggleMapPanel');
    expect(app).toContain('function fitDeliveryBounds');
    expect(app).toContain('function centerDelivery');
    expect(app).toContain("map.on('dragstart zoomstart'");
    expect(app).toContain('state.deliveryMap.autoFollow = false');
    expect(app).toContain('map.panTo(currentLatLng');
  });

  it('separa fallo de tiles del tracking realtime', () => {
    expect(app).toContain("layer.on('tileerror'");
    expect(app).toContain('no disponible');
    expect(app).toContain('Mapa base lento. El GPS sigue activo.');
    expect(app).toContain('DELIVERY_TILE_SLOW_MS = 4500');
    expect(app).toContain('state.deliveryMap.deliveryMarker.setLatLng(currentLatLng)');
  });

  it('enseña el TERRENO con imagen real (satélite) y deja elegir la capa', () => {
    // Foto aérea de verdad (Esri/Maxar): es lo que pidió el negocio para ver las
    // casas, los patios y los caminos.
    expect(app).toContain("'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'");
    expect(app).toContain("const MAP_DEFAULT_BASE = 'satelite'");
    expect(app).toContain('Imágenes &copy; Esri');
    // Los nombres y las calles van encima de la foto, y se pueden apagar.
    expect(app).toContain('World_Transportation');
    expect(app).toContain('function toggleOrdersMapLabels');
    expect(app).toContain('data-map-base="${clave}"');
    expect(app).toContain("const MAPS_BASE_KEY = 'pe_orders_map_base'");
    // Y el mapa dibujado de siempre sigue disponible (pesa mucho menos).
    expect(app).toContain('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(app).toContain('&copy; OpenStreetMap contributors');
  });

  it('usa el MÁXIMO nivel de imagen REAL de cada zona, sin inventar detalle', () => {
    // El techo por defecto es el 18 (medido: hay imagen propia en las 20 zonas de
    // RD comprobadas) y solo sube a 19 si se COMPRUEBA que ese nivel trae foto.
    expect(app).toContain('const MAP_NATIVE_DEFAULT_ZOOM = 18');
    expect(app).toContain('const MAP_NATIVE_MAX_ZOOM = 19');
    expect(app).toContain('function probeOrdersMapNative');
    expect(app).toContain('function ordersMapNativeZoom');
    // El relleno de "sin imagen" de Esri pesa 2.521 B (el mismo en todo el país) y
    // la foto real más pequeña medida en RD, 5.462 B: el umbral va en medio.
    expect(app).toContain('const MAP_MIN_REAL_TILE_BYTES = 4000');
    // La comprobación se recuerda por zona (celda) y caduca: la imagen cambia.
    expect(app).toContain("const MAP_NATIVE_STORE_KEY = 'pe_map_native_zoom'");
    expect(app).toContain('const MAP_NATIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000');
    // Nunca se pide el nivel 20: no existe en RD (sería mosaico gris).
    expect(app).toContain('tileUrlFor(config.url, MAP_NATIVE_MAX_ZOOM, centro.lat, centro.lng)');
    // Y al pasar del techo real se avisa: es ampliación, no más detalle.
    expect(app).toMatch(/ampliado \(aquí la imagen real llega al nivel/);
    expect(app).toContain('más cerca no gana detalle');
  });

  it('restaura la última vista del mapa sin guardar datos sensibles', () => {
    expect(app).toContain("const MAPS_VIEW_KEY = 'pe_orders_map_view'");
    expect(app).toContain('function ordersMapSavedView');
    expect(app).toContain('function saveOrdersMapView');
    expect(app).toContain("map.on('moveend zoomend', saveOrdersMapView)");
    expect(app).toContain('localStorage.setItem(');
    expect(app).toContain('center: [Number(center.lat.toFixed(6)), Number(center.lng.toFixed(6))]');
    expect(app).toContain('map.setView(vista?.center ?? [18.6157, -68.7071], vista?.zoom ?? 12)');
    // Solo centro y zoom: ni direcciones ni teléfonos del cliente en el almacén.
    const saveStart = app.indexOf('function saveOrdersMapView');
    const saveBlock = app.slice(saveStart, saveStart + 900);
    expect(saveBlock).toContain('zoom })');
    expect(saveBlock).not.toMatch(/address|phone|nombre|name:/);
  });

  it('mantiene prefetch automático de tiles desactivado por política del proveedor', () => {
    expect(app).toContain('const DELIVERY_TILE_PREFETCH_ENABLED = false');
    expect(app).toContain('function maybePrefetchDeliveryTiles');
    expect(app).toContain('allows automatic area prefetch');
    expect(app).toContain("maybePrefetchDeliveryTiles('destination-available')");
    expect(app).toContain("maybePrefetchDeliveryTiles('delivery-position-available')");
  });
});
