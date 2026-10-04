// @vitest-environment node
/**
 * EL PDF VIAJA COMO DOCUMENTO NATIVO DE WHATSAPP (no como enlace).
 *
 * Estas pruebas miran el CUERPO EXACTO que sale hacia la Graph API: es la única
 * forma de demostrar que la factura se envía como `type: document` con su
 * `media_id` y su `filename`, y que la subida manda `application/pdf`. Sin esto,
 * un mock amable podría esconder un envío que en realidad no es un documento.
 */
import { describe, expect, it } from 'vitest';

import { createWhatsAppMedia } from '../server/whatsapp-media.mjs';

/** Captura la petición y responde como Meta (200 + `messages[0].id`). */
function espia(respuesta = {}) {
  const llamadas = [];
  const fetchImpl = async (url, options = {}) => {
    llamadas.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      async json() {
        return respuesta;
      },
    };
  };
  return { llamadas, fetchImpl };
}

const cliente = (fetchImpl) =>
  createWhatsAppMedia({
    accessToken: 'token-de-prueba',
    phoneNumberId: 'PN-123',
    graphVersion: 'v21.0',
    fetchImpl,
  });

describe('sendDocument: documento nativo con media_id y nombre de archivo', () => {
  it('manda `type: document` con el `id` de Meta y el nombre del PDF', async () => {
    const { llamadas, fetchImpl } = espia({ messages: [{ id: 'wamid.DOC-1' }] });
    const resultado = await cliente(fetchImpl).sendDocument('18095551234', {
      mediaId: 'mid_1',
      filename: 'Factura-PE-00125.pdf',
    });

    expect(resultado.ok).toBe(true);
    expect(resultado.waMessageId).toBe('wamid.DOC-1');
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].url).toBe('https://graph.facebook.com/v21.0/PN-123/messages');
    expect(JSON.parse(llamadas[0].options.body)).toEqual({
      messaging_product: 'whatsapp',
      to: '18095551234',
      type: 'document',
      document: { id: 'mid_1', filename: 'Factura-PE-00125.pdf' },
    });
  });

  it('el nombre del archivo NO se pierde aunque sea muy largo (Meta corta a 240)', async () => {
    const { llamadas, fetchImpl } = espia({ messages: [{ id: 'wamid.DOC-2' }] });
    const largo = `${'F'.repeat(300)}.pdf`;
    await cliente(fetchImpl).sendDocument('18095551234', { mediaId: 'mid_2', filename: largo });
    const cuerpo = JSON.parse(llamadas[0].options.body);
    expect(cuerpo.document.filename).toHaveLength(240);
    expect(cuerpo.document.filename.startsWith('FFF')).toBe(true);
  });

  it('sin `media_id` no se inventa nada: Meta devuelve error y se dice', async () => {
    const llamadas = [];
    const fetchImpl = async (url, options = {}) => {
      llamadas.push({ url, options });
      return {
        ok: false,
        status: 400,
        headers: new Headers({ 'content-type': 'application/json' }),
        async json() {
          return { error: { code: 131_047, message: '(#131047) Re-engagement message' } };
        },
      };
    };
    const resultado = await cliente(fetchImpl).sendDocument('18095551234', { mediaId: null });
    expect(resultado.ok).toBe(false);
    expect(resultado.error.code).toBe(131_047);
    expect(llamadas).toHaveLength(1);
  });
});

describe('uploadMedia: el PDF sale como application/pdf', () => {
  it('sube el archivo con su tipo y su nombre, y devuelve el `media_id`', async () => {
    const { llamadas, fetchImpl } = espia({ id: 'mid_pdf_1' });
    const pdf = Buffer.from('%PDF-1.7 contenido de prueba');
    const resultado = await cliente(fetchImpl).uploadMedia({
      buffer: pdf,
      mimeType: 'application/pdf',
      filename: 'Factura-PE-00125.pdf',
    });

    expect(resultado.ok).toBe(true);
    expect(resultado.mediaId).toBe('mid_pdf_1');
    expect(llamadas[0].url).toBe('https://graph.facebook.com/v21.0/PN-123/media');
    const cuerpo = llamadas[0].options.body.toString('latin1');
    expect(cuerpo).toContain('name="messaging_product"');
    expect(cuerpo).toContain('whatsapp');
    expect(cuerpo).toContain('name="type"');
    expect(cuerpo).toContain('application/pdf');
    expect(cuerpo).toContain('name="file"; filename="Factura-PE-00125.pdf"');
    expect(cuerpo).toContain('Content-Type: application/pdf');
    // El PDF viaja ENTERO (la parte binaria no se recorta ni se convierte).
    expect(llamadas[0].options.body.includes(pdf)).toBe(true);
  });
});
