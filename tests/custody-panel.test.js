// @vitest-environment node
/**
 * PANEL DE CUSTODIA — contrato de la pantalla compacta.
 *
 * No es una prueba de estilos: comprueba que la pantalla sigue teniendo lo que
 * hace falta para operar (métricas, columnas, filtros, detalle y rendición) y
 * que no reintroduce la cabecera gigante ni los controles duplicados.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ADMIN = path.join(process.cwd(), 'public', 'admin');
const html = readFileSync(path.join(ADMIN, 'custody.html'), 'utf8');
const js = readFileSync(path.join(ADMIN, 'custody.js'), 'utf8');

describe('métricas', () => {
  it('muestra los cinco indicadores operativos', () => {
    for (const label of ['Bajo custodia', 'Pendiente de rendir', 'Rendido', 'Con saldo', 'Incidencias']) {
      expect(js).toContain(label);
    }
  });

  it('no usa una cabecera gigante', () => {
    expect(html).not.toMatch(/height:\s*(1[5-9]\d|2\d\d)px/);
    expect(html).toContain('.bar h1{font-size:16px');
  });
});

describe('tabla', () => {
  for (const column of ['Repartidor', 'Pedidos', 'Efectivo', 'Pendiente', 'Estado']) {
    it(`tiene la columna ${column}`, () => {
      expect(html).toContain(`<th`);
      expect(html).toMatch(new RegExp(`>\\s*${column}\\s*<`));
    });
  }

  it('los importes se alinean a la derecha en una clase numérica', () => {
    expect(html).toContain('td.num{text-align:right');
  });

  it('tiene búsqueda y filtro en una sola barra', () => {
    expect(html).toContain('id="search"');
    expect(html).toContain('id="filter"');
    expect(html.match(/id="search"/g)).toHaveLength(1);
  });
});

describe('detalle y rendición', () => {
  it('abre un panel lateral con movimientos', () => {
    expect(html).toContain('id="drawer"');
    expect(js).toContain('d-movements');
  });

  it('la rendición muestra saldo antes y después', () => {
    expect(js).toContain('Saldo pendiente:');
    expect(js).toContain('Nuevo saldo:');
  });

  it('no permite montos inválidos ni duplica el envío', () => {
    expect(js).toContain('\\d{1,9}');
    expect(js).toContain('button.disabled = true');
  });

  it('sigue usando el endpoint existente de rendiciones', () => {
    expect(js).toContain('/api/admin/delivery-cash/remittance');
    expect(js).not.toContain('/api/admin/delivery-cash/charge');
  });
});

describe('aspecto del panel', () => {
  it('usa el mismo tema que el CRM: variables y modo oscuro', () => {
    // La página es independiente, así que tiene que leer la preferencia guardada.
    expect(html).toContain("localStorage.getItem(KEY)");
    expect(html).toContain("pe_tema");
    expect(html).toContain(":root[data-theme='dark']");
    // Ningún color de fondo blanco fijo en las piezas grandes.
    expect(html).not.toMatch(/\.card\{[^}]*background:#fff/);
    expect(html).not.toMatch(/\.wrap\{[^}]*background:#fff/);
    expect(html).not.toMatch(/#drawer \.sheet\{[^}]*background:#fff/);
  });

  it('el volver es el icono redondo del panel', () => {
    expect(html).toMatch(/\.bar a\.back\{[^}]*border-radius:50%/s);
    expect(html).not.toMatch(/<a class="back"[^>]*>\s*Volver/);
  });
});

describe('datos reales', () => {
  it('no inventa saldos: los lee del backend', () => {
    expect(js).toContain('/api/admin/delivery-cash');
    expect(js).toContain('/api/admin/delivery-cash/movements');
    expect(js).toContain('/api/admin/delivery-cash/incidents');
    expect(js).not.toMatch(/const\s+couriers\s*=\s*\[\s*\{/);
  });

  it('el efectivo declarado no se presenta como verificado', () => {
    expect(js).toContain('no se presenta como verificado');
  });
});
