// @vitest-environment node
/**
 * FACTURAS DE PROVEEDOR.
 *
 * Lo que se comprueba:
 *   · el tipo de archivo se decide por los BYTES (PDF, JPG, PNG), no por lo que
 *     diga el navegador,
 *   · un archivo gigante o de otro tipo se rechaza con su propio código,
 *   · la factura siempre queda ligada a un pedido y a una tienda,
 *   · una factura puede cubrir varias recogidas del mismo pedido y tienda.
 */
import { describe, expect, it } from 'vitest';
import { INVOICE_MAX_BYTES, detectInvoiceFile, normalizeSupplierInvoice } from '../server/suppliers.mjs';

const pdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.7\nfactura de prueba\n%%EOF').toString('base64')}`;
const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')}`;
const jpg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64')}`;

describe('el archivo se reconoce por su contenido', () => {
  it('acepta PDF, JPG y PNG', () => {
    expect(detectInvoiceFile({ base64: pdf })).toMatchObject({ mime: 'application/pdf', ext: 'pdf' });
    expect(detectInvoiceFile({ base64: png })).toMatchObject({ mime: 'image/png', ext: 'png' });
    expect(detectInvoiceFile({ base64: jpg })).toMatchObject({ mime: 'image/jpeg', ext: 'jpg' });
  });

  it('un tipo que no es factura se rechaza aunque diga que es imagen', () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]).toString('base64');
    expect(() => detectInvoiceFile({ base64: zip })).toThrowError(/PDF, JPG o PNG/);
  });

  it('un archivo vacío o ilegible no pasa', () => {
    expect(() => detectInvoiceFile({ base64: '' })).toThrowError(/elegirlo|vacío/i);
    expect(() => detectInvoiceFile({ base64: '***' })).toThrowError(/elegirlo/i);
  });

  it('más de 4 MB se rechaza antes de guardar', () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(INVOICE_MAX_BYTES + 10)]).toString('base64');
    expect(() => detectInvoiceFile({ base64: big })).toThrowError(/4 MB/);
  });
});

describe('la factura se liga a pedido y tienda', () => {
  it('guarda número, total y varias recogidas', () => {
    const invoice = normalizeSupplierInvoice({
      order_id: 'order_1',
      supplier_id: 'sup_a',
      invoice_number: 'A-123',
      total_cents: 240000,
      pickup_ids: ['pickup:order_1:sup_a', 'pickup:order_1:sup_a'],
      base64: pdf,
    });
    expect(invoice.order_id).toBe('order_1');
    expect(invoice.supplier_id).toBe('sup_a');
    expect(invoice.invoice_number).toBe('A-123');
    expect(invoice.total_cents).toBe(240000);
    expect(invoice.pickup_ids).toEqual(['pickup:order_1:sup_a']);
    expect(invoice.file.mime).toBe('application/pdf');
  });

  it('sin pedido o sin tienda no se guarda', () => {
    expect(() => normalizeSupplierInvoice({ supplier_id: 'sup_a', base64: pdf })).toThrowError(/pedido/i);
    expect(() => normalizeSupplierInvoice({ order_id: 'order_1', base64: pdf })).toThrowError(/tienda/i);
  });

  it('un total negativo no es un total', () => {
    expect(() =>
      normalizeSupplierInvoice({ order_id: 'o', supplier_id: 's', total_cents: -1, base64: pdf }),
    ).toThrowError(/total/i);
  });
});
