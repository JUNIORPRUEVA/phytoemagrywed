/**
 * PRUEBA DE LA RESPUESTA CON MODELO (sin red): `answer()` del mismo servicio
 * de IA que usa el corrector. Verifica los cuatro desenlaces que importan:
 * éxito, proveedor caído, plazo agotado y tope de gasto — y que un intento
 * fallido NO consuma cuota.
 */
import { describe, expect, it } from 'vitest';
import { createProofreadingService } from '../server/proofreading.mjs';

/** Ajustes en memoria (misma forma que la tabla de settings). */
function ajustes(initial = {}) {
  const datos = new Map(Object.entries(initial));
  return {
    datos,
    async read(key) {
      return datos.has(key) ? { value: datos.get(key) } : null;
    },
    async write(key, value) {
      datos.set(key, value);
    },
  };
}

/** Servicio con la clave ya guardada (cifrada por el propio servicio). */
async function servicio({ fetchImpl, clock = () => new Date(0) } = {}) {
  const settings = ajustes();
  const svc = createProofreadingService({ settings, secret: 'secreto-de-prueba', fetchImpl, clock });
  await svc.save({ enabled: true, apiKey: 'clave-de-prueba-1234567890' });
  return { svc, settings };
}

const respuestaOk = (texto) => ({
  ok: true,
  json: async () => ({
    model: 'deepseek-flash',
    choices: [{ finish_reason: 'stop', message: { content: texto } }],
    usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
  }),
});

describe('respuesta con modelo del Centro IA', () => {
  it('devuelve el texto, el modelo y los tokens cuando el proveedor contesta', async () => {
    let cuerpo = null;
    const { svc } = await servicio({
      fetchImpl: async (_url, options) => {
        cuerpo = JSON.parse(options.body);
        return respuestaOk('Tienes 3 seguimientos vencidos.');
      },
    });
    const salida = await svc.answer({ system: 'eres un agente', user: '{"pregunta":"¿qué hay?"}', actorId: 'usr_1' });
    expect(salida.ok).toBe(true);
    expect(salida.text).toBe('Tienes 3 seguimientos vencidos.');
    expect(salida.model).toBe('deepseek-flash');
    expect(salida.usage).toEqual({ prompt: 120, completion: 40, total: 160 });
    /* El tope de tokens se aplica SIEMPRE, aunque pidan más. */
    expect(cuerpo.max_tokens).toBeLessThanOrEqual(900);
    expect(cuerpo.messages).toHaveLength(2);
    /* Sin `response_format`: es texto libre, no JSON. */
    expect(cuerpo.response_format).toBeUndefined();
  });

  it('sin clave guardada no llama al proveedor y lo dice', async () => {
    const settings = ajustes();
    const svc = createProofreadingService({
      settings,
      secret: 'x',
      fetchImpl: async () => {
        throw new Error('no debería llamarse');
      },
    });
    const salida = await svc.answer({ system: 'a', user: 'b' });
    expect(salida).toEqual({ ok: false, reason: 'sin_configurar' });
  });

  it('si el proveedor rechaza, devuelve el motivo y NO cobra la consulta', async () => {
    const { svc } = await servicio({
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    });
    const salida = await svc.answer({ system: 'a', user: 'b' });
    expect(salida).toEqual({ ok: false, reason: 'provider_auth' });
    const estado = await svc.status();
    expect(estado.usedToday).toBe(0);
  });

  it('si se agota el plazo, devuelve `plazo` y NO cobra la consulta', async () => {
    const { svc } = await servicio({
      /* Nunca contesta: solo el plazo puede cerrar la espera. */
      fetchImpl: () => new Promise(() => {}),
    });
    const salida = await svc.answer({ system: 'a', user: 'b', timeoutMs: 30 });
    expect(salida).toEqual({ ok: false, reason: 'plazo' });
    expect((await svc.status()).usedToday).toBe(0);
  });

  it('respuesta vacía o truncada = sin respuesta útil (y sin cobro)', async () => {
    const cortada = {
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'length', message: { content: 'a medias' } }] }),
    };
    const { svc } = await servicio({ fetchImpl: async () => cortada });
    const salida = await svc.answer({ system: 'a', user: 'b' });
    expect(salida).toEqual({ ok: false, reason: 'truncado' });
    expect((await svc.status()).usedToday).toBe(0);
  });

  it('el tope diario corta la consulta antes de llamar al proveedor', async () => {
    let llamadas = 0;
    const settings = ajustes();
    const svc = createProofreadingService({
      settings,
      secret: 'x',
      fetchImpl: async () => {
        llamadas += 1;
        return respuestaOk('ok');
      },
    });
    await svc.save({ enabled: true, apiKey: 'clave-de-prueba-1234567890', dailyLimit: 1 });
    const primera = await svc.answer({ system: 'a', user: 'b' });
    expect(primera.ok).toBe(true);
    const segunda = await svc.answer({ system: 'a', user: 'b' });
    expect(segunda).toEqual({ ok: false, reason: 'limite' });
    expect(llamadas).toBe(1);
  });

  it('no acepta contextos gigantes (última barrera de gasto)', async () => {
    const { svc } = await servicio({
      fetchImpl: async () => {
        throw new Error('no debería llamarse');
      },
    });
    const salida = await svc.answer({ system: 'a', user: 'x'.repeat(15000) });
    expect(salida).toEqual({ ok: false, reason: 'contexto_demasiado_grande' });
  });
});
