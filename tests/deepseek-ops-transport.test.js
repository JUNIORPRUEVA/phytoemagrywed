// @vitest-environment node
/**
 * ETAPA E — TRANSPORTE REAL CON EL PROVEEDOR (sin clave real).
 *
 * El planificador de agentes no habla HTTP: pide a `proofreading.plan`, que es
 * el código que YA está en producción para las correcciones. Esta suite
 * comprueba **nuestro lado del cable** contra un endpoint simulado:
 *
 *   - la URL fija, el modelo, `thinking` desactivado, temperatura 0, JSON,
 *     `max_tokens` y las cabeceras;
 *   - que la clave se guarda CIFRADA y se descifra solo al enviar;
 *   - que el consumo se reserva y se **devuelve** si la respuesta no sirve;
 *   - que un plazo agotado, un corte de red, un HTTP 500, un truncamiento o un
 *     JSON inválido terminan en `null` (y el agente sigue con su pauta).
 *
 * Lo que NO prueba esto: qué contesta DeepSeek de verdad. Eso exige una clave
 * real y está en la UAT (`docs/OPS-CENTER-ETAPA-E.md`).
 */
import { describe, expect, it } from 'vitest';

import { createProofreadingService, DEEPSEEK_MODEL } from '../server/proofreading.mjs';

/** Ajustes en memoria con la MISMA forma que usa el servicio real. */
function settingsDouble() {
  const map = new Map();
  return {
    map,
    async read(id) {
      return map.has(id) ? { id, value: map.get(id) } : null;
    },
    async write(id, value) {
      map.set(id, value);
    },
  };
}

const API_KEY = 'sk-prueba-0123456789abcdef';

function okPayload(content) {
  return {
    model: DEEPSEEK_MODEL,
    choices: [{ finish_reason: 'stop', message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
    usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 },
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function serviceWith(fetchImpl, overrides = {}) {
  const settings = settingsDouble();
  const service = createProofreadingService({
    settings,
    secret: 'token-de-prueba',
    fetchImpl,
    clock: () => new Date('2026-10-22T12:00:00.000Z'),
    ...overrides,
  });
  return { service, settings };
}

describe('transporte con el proveedor', () => {
  it('envía exactamente lo que la política permite y devuelve el JSON con su consumo', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(okPayload({ action: 'message', body: 'Voy con el ticket, aviso en un rato.' }));
    };
    const { service, settings } = serviceWith(fetchImpl);
    await service.save({ apiKey: API_KEY, enabled: true, dailyLimit: 10 });

    const result = await service.plan({
      system: 'Eres un asistente interno.',
      user: '{"mensajes":[]}',
      maxTokens: 300,
      actorId: 'ops-agent:delivery_supervisor',
    });

    expect(result).toBeTruthy();
    expect(result.json).toEqual({ action: 'message', body: 'Voy con el ticket, aviso en un rato.' });
    expect(result.model).toBe(DEEPSEEK_MODEL);
    expect(result.usage).toEqual({ prompt: 900, completion: 40, total: 940 });
    expect(result.ms).toBeGreaterThanOrEqual(0);

    /* Una sola llamada, a la URL fija, con la clave descifrada en la cabecera. */
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions');
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${API_KEY}`);

    const body = JSON.parse(calls[0].init.body);
    expect(body.model).toBe(DEEPSEEK_MODEL);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBe(300);
    expect(body.messages.map((row) => row.role)).toEqual(['system', 'user']);

    /* La clave NO se guarda en claro. */
    const stored = settings.map.get('proofreading_deepseek');
    expect(JSON.stringify(stored)).not.toContain(API_KEY);
    expect(stored.credential.data).toBeTruthy();

    /* El consumo diario se apunta. */
    expect(settings.map.get('proofreading_usage').calls).toBe(1);
  });

  it('cada intento válido gasta cuota y el tope diario corta en seco', async () => {
    let calls = 0;
    const { service } = serviceWith(async () => {
      calls += 1;
      return jsonResponse(okPayload({ action: 'wait', minutes: 30 }));
    });
    await service.save({ apiKey: API_KEY, enabled: true, dailyLimit: 2 });

    expect(await service.plan({ system: 's', user: 'u', actorId: 'a' })).toBeTruthy();
    expect(await service.plan({ system: 's', user: 'u', actorId: 'a' })).toBeTruthy();
    /* Tercer intento: sin cuota, no se llama al proveedor. */
    expect(await service.plan({ system: 's', user: 'u', actorId: 'a' })).toBeNull();
    expect(calls).toBe(2);
  });

  it('un fallo del proveedor no gasta cuota', async () => {
    const { service, settings } = serviceWith(async () => jsonResponse({ error: 'boom' }, 500));
    await service.save({ apiKey: API_KEY, enabled: true, dailyLimit: 5 });
    expect(await service.plan({ system: 's', user: 'u', actorId: 'a' })).toBeNull();
    expect(settings.map.get('proofreading_usage').calls).toBe(0);
  });

  it('un truncamiento, un JSON roto o un 404 terminan en null', async () => {
    const truncated = serviceWith(async () =>
      jsonResponse({ choices: [{ finish_reason: 'length', message: { content: '{"action":"mess' } }], usage: {} }),
    );
    await truncated.service.save({ apiKey: API_KEY, enabled: true, dailyLimit: 5 });
    expect(await truncated.service.plan({ system: 's', user: 'u', actorId: 'a' })).toBeNull();

    const broken = serviceWith(async () => jsonResponse(okPayload('esto no es json')));
    await broken.service.save({ apiKey: API_KEY, enabled: true, dailyLimit: 5 });
    expect(await broken.service.plan({ system: 's', user: 'u', actorId: 'a' })).toBeNull();

    const missing = serviceWith(async () => jsonResponse({ error: 'not found' }, 404));
    await missing.service.save({ apiKey: API_KEY, enabled: true, dailyLimit: 5 });
    expect(await missing.service.plan({ system: 's', user: 'u', actorId: 'a' })).toBeNull();
  });

  it('un proveedor que no contesta dentro del plazo no cuelga el agente', async () => {
    const slow = serviceWith(
      () => new Promise((resolve) => setTimeout(() => resolve(jsonResponse(okPayload({ action: 'wait' }))), 400)),
      { providerTimeoutMs: 40 },
    );
    await slow.service.save({ apiKey: API_KEY, enabled: true, dailyLimit: 5 });
    const started = Date.now();
    const result = await slow.service.plan({ system: 's', user: 'u', actorId: 'a' });
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    /* El intento que no sirvió no se cobra. */
    expect(slow.settings.map.get('proofreading_usage').calls).toBe(0);
  });

  it('sin clave o con el apoyo apagado, no hay ninguna llamada', async () => {
    let calls = 0;
    const { service } = serviceWith(async () => {
      calls += 1;
      return jsonResponse(okPayload({ action: 'wait' }));
    });
    /* Sin guardar clave: */
    expect(await service.plan({ system: 's', user: 'u', actorId: 'a' })).toBeNull();
    /* Con clave pero apagado: */
    await service.save({ apiKey: API_KEY, enabled: false });
    expect(await service.plan({ system: 's', user: 'u', actorId: 'a' })).toBeNull();
    expect(calls).toBe(0);
  });

  it('rechaza prompts vacíos o desmesurados antes de gastar una llamada', async () => {
    let calls = 0;
    const { service } = serviceWith(async () => {
      calls += 1;
      return jsonResponse(okPayload({ action: 'wait' }));
    });
    await service.save({ apiKey: API_KEY, enabled: true, dailyLimit: 5 });
    expect(await service.plan({ system: '', user: 'u' })).toBeNull();
    expect(await service.plan({ system: 's', user: '' })).toBeNull();
    expect(await service.plan({ system: 's', user: 'x'.repeat(13000) })).toBeNull();
    expect(calls).toBe(0);
  });
});
