// @vitest-environment node
/**
 * META — API de conversiones (CAPI): lo que se manda META y lo que NO.
 *
 * Lo que se prueba aquí no es "que compile", es lo que puede costar dinero o
 * privacidad:
 *  - el token NUNCA puede aparecer en un log, un error ni un payload;
 *  - `test_event_code` solo en UAT (jamás en producción);
 *  - el teléfono dominicano se normaliza ANTES de hashear (si no, Meta no
 *    reconoce al cliente y la conversión se pierde);
 *  - `fbc`/`fbp` viajan SIN hashear (Meta los quiere tal cual);
 *  - si Meta falla, la función devuelve un error y NO lanza.
 */
import { describe, expect, it } from 'vitest';

import { buildFbcValue } from '../src/lib/attribution.js';
import {
  buildFbc,
  buildUserData,
  createMetaCapi,
  hashPhone,
  normalizePhone,
  normalizeText,
  resolveFbc,
  resolveFbp,
  sanitizeError,
  sanitizeResponse,
  sha256,
} from '../server/meta-capi.mjs';

const TOKEN = 'EAAtoken-secreto-de-prueba-1234567890abcdef';

/** fetch falso que apunta lo que se envió y responde como Meta. */
function fakeFetch(answer = { body: { events_received: 1, fbtrace_id: 'AbC123' }, status: 200 }) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => JSON.stringify(answer.body),
    };
  };
  return { impl, calls };
}

describe('meta-capi · normalización del teléfono (República Dominicana)', () => {
  it('todas las formas de escribir el mismo número dan el mismo resultado', () => {
    const expected = '18091234567';
    for (const raw of [
      '8091234567',
      '809 123 4567',
      '(809) 123-4567',
      '+18091234567',
      '+1 809 123 4567',
      '18091234567',
      '0018091234567',
      ' 809-123-4567 ',
      'whatsapp: 8091234567',
    ]) {
      expect(normalizePhone(raw), raw).toBe(expected);
    }
    // 829 y 849 también son República Dominicana.
    expect(normalizePhone('8291234567')).toBe('18291234567');
    expect(normalizePhone('849-123-4567')).toBe('18491234567');
  });

  it('lo que no identifica a nadie devuelve null (mejor nada que basura)', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('sin numero')).toBeNull();
    expect(normalizePhone('1234567890123456789')).toBeNull();
  });

  it('el teléfono se hashea DESPUÉS de normalizar (si no, Meta no lo reconoce)', () => {
    const a = hashPhone('(809) 123-4567');
    const b = hashPhone('+18091234567');
    expect(a).toBe(b);
    expect(a).toBe(sha256('18091234567'));
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('el texto se normaliza en minúsculas y sin espacios de más', () => {
    expect(normalizeText('  Juan   Pérez ')).toBe('juan pérez');
    expect(normalizeText('')).toBeNull();
  });
});

describe('meta-capi · fbc y fbp', () => {
  it('_fbc se construye desde el fbclid con el formato oficial de Meta', () => {
    expect(buildFbc('IwAR123', 1700000000000)).toBe('fb.1.1700000000000.IwAR123');
    expect(buildFbc('')).toBeNull();
  });

  it('la misma fórmula en el navegador y en el servidor (no pueden separarse)', () => {
    // `attribution.js` no puede importar el módulo del servidor (node:crypto):
    // si alguien cambia una de las dos, este test cae.
    expect(buildFbcValue('IwAR123', 1700000000000)).toBe(buildFbc('IwAR123', 1700000000000));
  });

  it('si Meta ya puso la cookie _fbc, manda la cookie', () => {
    expect(resolveFbc({ fbc: 'fb.1.1700000000000.CookieReal', fbclid: 'otro' })).toBe('fb.1.1700000000000.CookieReal');
    expect(resolveFbc({ fbc: 'basura', fbclid: 'IwAR9' }, )).toMatch(/^fb\.1\.\d+\.IwAR9$/);
  });

  it('_fbp solo se acepta con el formato correcto', () => {
    expect(resolveFbp('fb.1.1700000000000.123456789')).toBe('fb.1.1700000000000.123456789');
    expect(resolveFbp('loquesea')).toBeNull();
    expect(resolveFbp(null)).toBeNull();
  });

  it('fbc y fbp viajan SIN hashear; el teléfono y el external_id SÍ se hashean', () => {
    const userData = buildUserData({
      payload: {
        attribution: { fbclid: 'IwAR777', fbc: null, fbp: 'fb.1.1700000000000.999' },
        meta: { events: {} },
      },
      phone: '8091234567',
      name: 'Ana',
      externalId: 'sesion-abc',
      ip: '190.80.1.2',
      userAgent: 'Mozilla/5.0 (prueba)',
    });

    expect(userData.fbc).toMatch(/^fb\.1\.\d+\.IwAR777$/);
    expect(userData.fbp).toBe('fb.1.1700000000000.999');
    expect(userData.client_ip_address).toBe('190.80.1.2');
    expect(userData.client_user_agent).toContain('Mozilla');
    expect(userData.ph).toEqual([sha256('18091234567')]);
    expect(userData.fn).toEqual([sha256('ana')]);
    expect(userData.external_id).toEqual([sha256('sesion-abc')]);
    // Nada hasheado por error:
    expect(JSON.stringify(userData)).not.toContain('18091234567');
  });
});

describe('meta-capi · envío', () => {
  it('manda el Payload con event_id, action_source y el token en el cuerpo (no en la URL)', async () => {
    const { impl, calls } = fakeFetch();
    const capi = createMetaCapi({ pixelId: '1234567890', accessToken: TOKEN, fetchImpl: impl });

    const result = await capi.send({
      eventName: 'Lead',
      eventId: 'lead_abc',
      eventSourceUrl: 'https://phytoemagryrd.lat/#frascos',
      userData: { fbc: 'fb.1.1.x' },
      customData: { currency: 'DOP' },
    });

    expect(result.ok).toBe(true);
    expect(result.response.eventsReceived).toBe(1);
    expect(result.response.fbtraceId).toBe('AbC123');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/1234567890/events');
    expect(calls[0].url).not.toContain(TOKEN);
    const event = calls[0].body.data[0];
    expect(event).toMatchObject({
      event_name: 'Lead',
      event_id: 'lead_abc',
      action_source: 'website',
      event_source_url: 'https://phytoemagryrd.lat/#frascos',
    });
    expect(event.event_time).toBeGreaterThan(1_700_000_000);
    expect(calls[0].body.access_token).toBe(TOKEN);
  });

  it('la venta usa el total REAL del pedido y la moneda del negocio', async () => {
    const { impl, calls } = fakeFetch();
    const capi = createMetaCapi({ pixelId: '1', accessToken: TOKEN, fetchImpl: impl });

    await capi.sendPurchase({
      eventId: 'purchase_pedido-1',
      orderId: 'pedido-1',
      value: 5000,
      currency: 'DOP',
      contentIds: ['capsules_20'],
      contents: [{ id: 'capsules_20', quantity: 1, item_price: 5000 }],
      userData: {},
    });

    const event = calls[0].body.data[0];
    expect(event.event_name).toBe('Purchase');
    expect(event.event_id).toBe('purchase_pedido-1');
    expect(event.custom_data).toMatchObject({ currency: 'DOP', value: 5000, order_id: 'pedido-1', content_type: 'product' });
    expect(event.custom_data.content_ids).toEqual(['capsules_20']);
  });

  it('sin credenciales queda desactivada y no llama a Meta', async () => {
    const { impl, calls } = fakeFetch();
    const capi = createMetaCapi({ pixelId: '', accessToken: '', fetchImpl: impl });
    expect(capi.enabled).toBe(false);
    await expect(capi.sendPurchase({ eventId: 'purchase_1', value: 100 })).resolves.toMatchObject({
      ok: false,
      skipped: true,
    });
    expect(calls).toHaveLength(0);
  });

  it('una versión de Graph vacía usa la de por defecto (URL válida)', async () => {
    // El CRM pasa la variable de entorno tal cual: vacía llegaba como '' y la URL
    // quedaba con doble barra (`graph.facebook.com//<pixel>/events`).
    const empty = fakeFetch();
    const capi = createMetaCapi({ pixelId: '1', accessToken: TOKEN, graphVersion: '', fetchImpl: empty.impl });
    expect(capi.graphVersion).toBe('v21.0');
    await capi.sendPurchase({ eventId: 'purchase_v', value: 1 });
    expect(empty.calls[0].url).toBe('https://graph.facebook.com/v21.0/1/events');

    const custom = fakeFetch();
    const otra = createMetaCapi({ pixelId: '1', accessToken: TOKEN, graphVersion: 'v23.0', fetchImpl: custom.impl });
    await otra.sendPurchase({ eventId: 'purchase_w', value: 1 });
    expect(custom.calls[0].url).toBe('https://graph.facebook.com/v23.0/1/events');
  });

  it('un fallo de Meta devuelve error saneado y NO lanza (el CRM no se puede caer)', async () => {
    const { impl } = fakeFetch({ status: 400, body: { error: { code: 190, type: 'OAuthException', message: `token ${TOKEN} inválido` } } });
    const capi = createMetaCapi({ pixelId: '1', accessToken: TOKEN, fetchImpl: impl });

    const result = await capi.sendPurchase({ eventId: 'purchase_x', value: 100, currency: 'DOP' });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error.code).toBe(190);
    expect(result.error.message).not.toContain(TOKEN);
    expect(result.error.message).toContain('[oculto]');
  });

  it('una excepción de red tampoco lanza', async () => {
    const capi = createMetaCapi({
      pixelId: '1',
      accessToken: TOKEN,
      fetchImpl: async () => {
        throw new Error(`conexión rechazada hacia graph.facebook.com/${TOKEN}`);
      },
    });
    const result = await capi.sendPurchase({ eventId: 'purchase_y', value: 1 });
    expect(result.ok).toBe(false);
    expect(result.error.message).not.toContain(TOKEN);
  });
});

describe('meta-capi · test_event_code', () => {
  it('en UAT se incluye; en producción se IGNORA aunque la variable esté puesta', async () => {
    const uat = fakeFetch();
    const uatCapi = createMetaCapi({
      pixelId: '1',
      accessToken: TOKEN,
      testEventCode: 'TEST12345',
      appEnv: 'uat',
      fetchImpl: uat.impl,
      log: () => {},
    });
    expect(uatCapi.hasTestEventCode).toBe(true);
    await uatCapi.sendPurchase({ eventId: 'purchase_1', value: 100 });
    expect(uat.calls[0].body.test_event_code).toBe('TEST12345');

    const prod = fakeFetch();
    const prodCapi = createMetaCapi({
      pixelId: '1',
      accessToken: TOKEN,
      testEventCode: 'TEST12345',
      appEnv: 'production',
      fetchImpl: prod.impl,
      log: () => {},
    });
    expect(prodCapi.hasTestEventCode).toBe(false);
    await prodCapi.sendPurchase({ eventId: 'purchase_2', value: 100 });
    expect(prod.calls[0].body.test_event_code).toBeUndefined();
  });

  it('sin variable no hay test_event_code (evento normal)', async () => {
    const { impl, calls } = fakeFetch();
    const capi = createMetaCapi({ pixelId: '1', accessToken: TOKEN, appEnv: 'production', fetchImpl: impl, log: () => {} });
    await capi.sendPurchase({ eventId: 'purchase_3', value: 10 });
    expect(calls[0].body.test_event_code).toBeUndefined();
  });

  it('un código con formato inesperado se ignora (nunca un evento de prueba accidental)', async () => {
    const { impl, calls } = fakeFetch();
    const capi = createMetaCapi({
      pixelId: '1',
      accessToken: TOKEN,
      testEventCode: 'no-es-un-codigo',
      appEnv: 'uat',
      fetchImpl: impl,
      log: () => {},
    });
    await capi.sendPurchase({ eventId: 'purchase_4', value: 10 });
    expect(calls[0].body.test_event_code).toBeUndefined();
  });
});

describe('meta-capi · saneado de textos', () => {
  it('los errores ocultan el token aunque venga dentro de la URL', () => {
    const clean = sanitizeError(
      { message: `GET https://graph.facebook.com/v21.0/1/events?access_token=${TOKEN} falló`, status: 400, code: 100 },
      TOKEN,
    );
    expect(clean.message).not.toContain(TOKEN);
    expect(clean.message).toContain('[oculto]');
    expect(clean.status).toBe(400);
    expect(clean.code).toBe(100);
  });

  it('la respuesta de Meta se reduce a lo útil', () => {
    expect(
      sanitizeResponse({ events_received: 2, fbtrace_id: 'XyZ', messages: [{ code: 100, message: 'aviso' }] }, TOKEN),
    ).toEqual({ eventsReceived: 2, messages: [{ code: 100, message: 'aviso' }], fbtraceId: 'XyZ' });
    expect(sanitizeResponse(null)).toBeNull();
  });
});
