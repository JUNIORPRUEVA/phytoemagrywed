// @vitest-environment node
/**
 * SEPARACIÓN CRM ↔ FULLTECH DELIVERY (interfaz).
 *
 * El CRM administra; la app ejecuta. Lo que se vigila aquí es que la interfaz
 * del CRM no ofrezca la operación del repartidor ni permita crear ese rol:
 *  - «Mis entregas» ya no está en el menú;
 *  - la ruta antigua responde con un aviso, no con la consola de entregas;
 *  - el selector de roles ya no ofrece Repartidor;
 *  - la custodia sigue teniendo puerta de entrada.
 *
 * Es una prueba de contrato de interfaz (texto del marcado y del módulo), no
 * de estilos: no se ejecuta navegador.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ADMIN = path.join(process.cwd(), 'public', 'admin');
const read = (file) => readFileSync(path.join(ADMIN, file), 'utf8');

describe('menú del CRM', () => {
  const html = read('index.html');

  it('ya no ofrece «Mis entregas»', () => {
    expect(html).not.toContain('Mis entregas');
    expect(html).not.toContain('data-tab="delivery"');
  });

  it('conserva la administración logística (mapa y supervisión)', () => {
    expect(html).toContain('data-tab="mapa"');
    expect(html).toContain('id="view-supervisor"');
  });

  it('la custodia tiene su propia puerta de entrada', () => {
    expect(html).toContain('/admin/custody.html');
  });

  it('la vista antigua sigue existiendo para no dejar una ruta rota', () => {
    expect(html).toContain('id="view-delivery"');
  });
});

describe('pantalla operativa retirada', () => {
  const app = read('app.js');

  it('la ruta antigua responde con un aviso, no con la consola de entregas', () => {
    expect(app).toContain('Mis entregas se trasladó a la app');
    expect(app).toContain('FULLTECH DELIVERY');
  });

  it('el aviso remite a la custodia y al mapa, no a una entrega', () => {
    const block = app.slice(app.indexOf('function renderDelivery()'), app.indexOf('function renderDeliveryLegacyUnused()'));
    expect(block).toContain('/admin/custody.html');
    expect(block).toContain('#mapa');
  });
});

describe('selector de roles', () => {
  const app = read('app.js');
  const selector = app.slice(app.indexOf('<select class="field__select" name="role">'), app.indexOf('name="password"'));

  it('ya no ofrece el rol Repartidor', () => {
    expect(selector).not.toContain('value="DELIVERY"');
    expect(selector).not.toContain('solo entregas');
  });

  it('mantiene los roles administrativos y operativos', () => {
    expect(selector).toContain('value="AGENT"');
    expect(selector).toContain('value="OPERADOR"');
    expect(selector).toContain('value="ADMIN"');
  });
});
