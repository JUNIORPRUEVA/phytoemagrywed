// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/admin/admin.css', import.meta.url), 'utf8');

describe('mobile navigation and floating actions', () => {
  it('el botón volver del mapa usa el handler común de regreso', () => {
    expect(html).toContain('class="map-appbar"');
    expect(html).toContain('data-simple-back type="button" aria-label="Volver"');
    expect(app).not.toContain('data-tab="hoy" type="button" aria-label="Volver"');
  });

  it('la pantalla del mapa tiene su botón flotante de acciones en móvil', () => {
    // El mapa ocupa la pantalla y TODO se hace desde un botón flotante: la lista,
    // medir distancias, mi ubicación, encuadrar, seguir la entrega y las capas.
    expect(html).toContain('class="map-fab"');
    expect(html).toContain('id="mapa-acciones"');
    expect(css).toContain('.map-fab');
    expect(app).toMatch(/\$\{fila\(\s*'medir',/);
    expect(app).toContain("fila('aqui',");
    expect(app).toContain("capa('live',");
    // Y la lista se abre y se cierra como panel, no navegando a otra pantalla.
    expect(css).toContain("body[data-map-panel='open'] .map-panel {");
    expect(app).toContain('function toggleMapPanel');
  });

  it('la pantalla del mapa ocupa el teléfono entero, sin scroll de página', () => {
    const plano = css.replaceAll('\r\n', '\n');
    // Alto = ventana menos la barra de abajo (y sus márgenes seguros).
    expect(plano).toMatch(/\.map-stage \{[\s\S]*?height: calc\(100dvh - var\(--pe-tabbar/);
    // Fuera la cabecera del móvil y el hueco que se reserva para la barra fija:
    // con 20px de sobra la pantalla se podía desplazar y el mapa se movía solo.
    expect(plano).toMatch(/body\[data-tab='mapa'\] \.mobile-header \{\n\s+display: none;/);
    expect(plano).toMatch(/body\[data-tab='mapa'\] \.app \{\n\s+padding-bottom: 0;/);
    // Los controles de Leaflet se apartan: no pueden quedar bajo la barra flotante.
    expect(plano).toMatch(/\.map-view--full \.leaflet-top\.leaflet-left \{\n\s+top: 72px;/);
    expect(plano).toMatch(/\.map-view--full \.leaflet-bottom\.leaflet-right \{\n\s+top: 72px;\n\s+bottom: auto;/);
  });

  it('al salir de WhatsApp se limpia data-wa-view para que Hoy muestre su drawer', () => {
    expect(app).toContain("if (tab !== 'whatsapp') {");
    expect(app).toContain('delete document.body.dataset.waView');
    expect(app).toContain('data-open-drawer');
  });

  it('Clientes conserva su botón flotante de acciones en móvil', () => {
    expect(html).toContain('class="client-fab"');
    expect(html).toContain('id="clientes-acciones"');
    expect(css).toContain('.client-fab');
    expect(css).not.toContain("body[data-tab='clientes'] .client-fab {\n    display: none;");
  });
});
