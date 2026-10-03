// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8');

describe('delivery tracking frontend UAT guards', () => {
  it('carga mapa real Leaflet con tiles de OpenStreetMap y atribución', () => {
    expect(html).toContain('/admin/vendor/leaflet/leaflet.css');
    expect(html).toContain('/admin/vendor/leaflet/leaflet.js');
    expect(html).not.toContain('unpkg.com/leaflet');
    expect(app).toContain('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(app).toContain('OpenStreetMap contributors');
  });

  it('pide GPS inicial antes de crear tracking para evitar sesiones zombie', () => {
    const startDelivery = app.indexOf('async function startDelivery(orderId)');
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

  it('usa UN solo mapa de Leaflet para la pantalla unificada', () => {
    // Una sola llamada a window.L.map en todo el panel: si aparece otra, es que
    // alguien volvió a crear un mapa aparte (lo que había antes con Delivery).
    expect(app.match(/window\.L\.map\(/g)).toHaveLength(1);
    expect(app).toContain('if (state.ordersMap.map && state.ordersMap.map.getContainer?.() === el) return state.ordersMap.map;');
    expect(app).toContain('function ensureDeliveryMap() {\r\n    return ensureOrdersMap();');
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
    // En RD la imagen propia llega al nivel 18 (19 en Santo Domingo/Bávaro) y a
    // partir de ahí se AMPLÍA avisando, sin fingir detalle que no existe.
    expect(app).toContain('maxNativeZoom: 18');
    expect(app).toContain('maxZoom: 20');
    expect(app).toMatch(/ampliado \(la imagen de esta zona llega al nivel/);
    // Los nombres y las calles van encima de la foto, y se pueden apagar.
    expect(app).toContain('World_Transportation');
    expect(app).toContain('function toggleOrdersMapLabels');
    expect(app).toContain('data-map-base="${clave}"');
    expect(app).toContain("const MAPS_BASE_KEY = 'pe_orders_map_base'");
    // Y el mapa dibujado de siempre sigue disponible (pesa mucho menos).
    expect(app).toContain('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(app).toContain('&copy; OpenStreetMap contributors');
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
