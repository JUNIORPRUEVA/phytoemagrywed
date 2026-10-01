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
    expect(app).toContain('state.deliveryMap.deliveryMarker.setLatLng(currentLatLng)');
  });

  it('crea una sola instancia de mapa y reutiliza marcadores de cliente/delivery', () => {
    expect(app).toContain('if (state.deliveryMap.map && state.deliveryMap.map.getContainer?.() === el) return state.deliveryMap.map;');
    expect(app).toContain('state.deliveryMap.customerMarker = window.L.marker');
    expect(app).toContain('state.deliveryMap.deliveryMarker = window.L.marker');
    expect(app).toContain('state.deliveryMap.deliveryMarker.setLatLng(currentLatLng)');
    expect(app).toContain('state.deliveryMap.routeLine.setLatLngs(points)');
  });

  it('tiene controles flotantes, bottom sheet, fit bounds y auto-follow', () => {
    expect(app).toContain('delivery-map-appbar');
    expect(app).toContain('delivery-map-tools');
    expect(app).toContain('delivery-bottom-sheet');
    expect(app).toContain('delivery-map-cta');
    expect(app).toContain('function fitDeliveryBounds');
    expect(app).toContain('function centerDelivery');
    expect(app).toContain("map.on('dragstart zoomstart'");
    expect(app).toContain('state.deliveryMap.autoFollow = false');
    expect(app).toContain('map.panTo(currentLatLng');
  });

  it('separa fallo de tiles del tracking realtime', () => {
    expect(app).toContain("tiles.on('tileerror'");
    expect(app).toContain('Mapa base no disponible');
    expect(app).toContain('Mapa base lento. El GPS sigue activo.');
    expect(app).toContain('DELIVERY_TILE_SLOW_MS = 4500');
    expect(app).toContain('state.deliveryMap.deliveryMarker.setLatLng(currentLatLng)');
  });

  it('restaura la última vista del mapa sin guardar datos sensibles', () => {
    expect(app).toContain("const DELIVERY_MAP_VIEW_KEY = 'pe_delivery_map_view'");
    expect(app).toContain('function deliveryMapLastView');
    expect(app).toContain('function saveDeliveryMapLastView');
    expect(app).toContain("map.on('moveend zoomend', saveDeliveryMapLastView)");
    expect(app).toContain('localStorage.setItem(');
    expect(app).toContain('center: [Number(center.lat.toFixed(6)), Number(center.lng.toFixed(6))]');
    expect(app).toContain('if (lastView) map.setView(lastView.center, lastView.zoom, { animate: false })');
  });

  it('mantiene prefetch automático de OSM desactivado por política del proveedor', () => {
    expect(app).toContain('const DELIVERY_TILE_PREFETCH_ENABLED = false');
    expect(app).toContain('function maybePrefetchDeliveryTiles');
    expect(app).toContain('OSM public tiles allow normal browser/service-worker caching, not automatic area prefetch.');
    expect(app).toContain("maybePrefetchDeliveryTiles('destination-available')");
    expect(app).toContain("maybePrefetchDeliveryTiles('delivery-position-available')");
  });
});
