// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/admin/admin.css', import.meta.url), 'utf8');

describe('mobile navigation and floating actions', () => {
  it('el botón volver del mapa usa el handler común de regreso', () => {
    expect(app).toContain('class="delivery-map-appbar"');
    expect(app).toContain('data-simple-back type="button" aria-label="Volver"');
    expect(app).not.toContain('data-tab="hoy" type="button" aria-label="Volver"');
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
