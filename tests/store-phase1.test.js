import { describe, expect, it } from 'vitest';
import { effectiveAvailability, publicWarranty } from '../server/store-catalog.mjs';

describe('disponibilidad comercial de la tienda', () => {
  it('un producto disponible con existencias se puede comprar', () => {
    expect(effectiveAvailability({ kind: 'product', store_availability: 'AVAILABLE_NOW', track_stock: true, quantity: 5 })).toBe('AVAILABLE_NOW');
  });

  it('cero existencias bloquea la compra aunque esté marcado como disponible', () => {
    expect(effectiveAvailability({ kind: 'product', store_availability: 'AVAILABLE_NOW', track_stock: true, quantity: 0 })).toBe('UNAVAILABLE');
  });

  it('sin dato fiable de existencias no se vende directo', () => {
    expect(effectiveAvailability({ kind: 'product', store_availability: 'AVAILABLE_NOW', track_stock: true, quantity: null })).toBe('ON_REQUEST');
  });

  it('bajo pedido se mantiene bajo pedido', () => {
    expect(effectiveAvailability({ kind: 'product', store_availability: 'ON_REQUEST', track_stock: false })).toBe('ON_REQUEST');
  });

  it('sin control de existencias se puede vender si está disponible', () => {
    expect(effectiveAvailability({ kind: 'product', store_availability: 'AVAILABLE_NOW', track_stock: false })).toBe('AVAILABLE_NOW');
  });

  it('un servicio no se vende en la tienda', () => {
    expect(effectiveAvailability({ kind: 'service', store_availability: 'AVAILABLE_NOW' })).toBe('UNAVAILABLE');
  });

  it('un producto archivado/inexistente queda no disponible', () => {
    expect(effectiveAvailability(null)).toBe('UNAVAILABLE');
  });
});

describe('garantía pública', () => {
  it('arma la etiqueta con los meses', () => {
    const warranty = publicWarranty({ warranty_available: true, warranty_months: 6, warranty_provider: 'FULLTECH' });
    expect(warranty.label).toBe('Garantía de 6 meses');
    expect(warranty.months).toBe(6);
    expect(warranty.available).toBe(true);
  });

  it('un mes usa singular', () => {
    expect(publicWarranty({ warranty_available: true, warranty_months: 1 }).label).toBe('Garantía de 1 mes');
  });

  it('sin meses pero del fabricante lo dice', () => {
    expect(publicWarranty({ warranty_available: true, warranty_months: 0, warranty_provider: 'manufacturer' }).label).toBe('Garantía del fabricante');
  });

  it('sin garantía comercial usa el texto acordado', () => {
    expect(publicWarranty({ warranty_available: false }).label).toBe('Sin garantía comercial adicional');
  });

  it('nunca expone las notas internas', () => {
    const warranty = publicWarranty({
      warranty_available: true,
      warranty_months: 3,
      warranty_public_notes: 'Conserva la factura.',
      warranty_private_notes: 'NO PUBLICAR: costo de reposición interno',
      warranty_conditions: 'Cubre defectos de fábrica.',
    });
    const serialized = JSON.stringify(warranty);
    expect(serialized).not.toContain('NO PUBLICAR');
    expect(serialized).not.toContain('costo de reposición');
    expect(warranty.notes).toBe('Conserva la factura.');
  });
});
