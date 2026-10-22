/**
 * PRUEBA DE LA INTELIGENCIA COMERCIAL DEL CENTRO IA (sin red).
 *
 * Cubre las tres piezas nuevas:
 *  1. Herramientas de LECTURA acotadas y autorizadas por recurso.
 *  2. Bucle de consulta del modelo (`askWithTools`): pide datos, se le
 *     contestan y solo entonces responde.
 *  3. Contabilidad de consumo y presupuesto diario del proveedor.
 */
import { describe, expect, it } from 'vitest';
import { createProofreadingService } from '../server/proofreading.mjs';
import { createReadTools } from '../server/ops/read-tools.mjs';

/* ------------------------------------------------------------------ apoyo */

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

async function servicio({ fetchImpl, clock = () => new Date('2026-10-22T15:00:00Z') } = {}) {
  const settings = ajustes();
  const svc = createProofreadingService({ settings, secret: 'secreto-de-prueba', fetchImpl, clock });
  await svc.save({ enabled: true, apiKey: 'clave-de-prueba-1234567890' });
  return { svc, settings };
}

const ahora = Date.parse('2026-10-22T15:00:00Z');
const haceDias = (dias) => new Date(ahora - dias * 86400000).toISOString();

/** Contexto mínimo con las conversaciones y pedidos que leen las herramientas. */
function contexto({ conversations = [], orders = [], catalogo = [] } = {}) {
  return {
    clock: () => new Date(ahora),
    customers: {
      async listConversations() {
        return conversations;
      },
    },
    store: {
      listAdmin() {
        return orders;
      },
    },
    inventory: {
      async catalog() {
        return { presentations: catalogo, stock: 42 };
      },
    },
  };
}

const conversacion = (extra = {}) => ({
  customer_id: 'cus_1',
  customer: { name: 'Ana Pérez' },
  customer_stage: 'cliente',
  tags: ['recompra'],
  has_purchase: true,
  last_purchase_at: haceDias(40),
  active_order: null,
  awaiting_reply: true,
  last_inbound_at: haceDias(3),
  last_message: { body: '¿Tienen la de 60 cápsulas?', at: haceDias(3), direction: 'inbound' },
  assigned_user_id: 'usr_1',
  ...extra,
});

const pedido = ({ id, cliente = 'cus_1', estado = 'entregado', dias = 40, total = 60, items = [] } = {}) => ({
  id,
  type: 'order_intent',
  customer_id: cliente,
  received_at: haceDias(dias),
  order_json: {
    order_number: id,
    customer_id: cliente,
    status: estado,
    total,
    delivered_at: estado === 'entregado' ? haceDias(dias) : null,
    items,
  },
});

const puedeTodo = () => true;

/* ------------------------------------------------------- 1. herramientas */

describe('herramientas de lectura del Agente de Seguimiento', () => {
  it('busca clientes y devuelve solo lo necesario, con la marca de no contactar', async () => {
    const ctx = contexto({
      conversations: [
        conversacion(),
        conversacion({ customer_id: 'cus_2', customer: { name: 'Ana María Ruiz', do_not_contact: true } }),
        conversacion({ customer_id: 'cus_3', customer: { name: 'Luis' } }),
      ],
    });
    const tools = createReadTools({ ctx, can: puedeTodo, actor: { id: 'usr_1', actor_type: 'USER' } });
    const salida = await tools.run('clientes_buscar', { q: 'ana' });
    expect(salida.ok).toBe(true);
    expect(salida.datos).toHaveLength(2);
    expect(salida.datos[1].noContactar).toBe(true);
    expect(salida.datos[0].diasDesdeUltimaCompra).toBe(40);
  });

  it('sin permiso de ver todo, solo encuentra sus conversaciones', async () => {
    const ctx = contexto({
      conversations: [
        conversacion(),
        conversacion({ customer_id: 'cus_9', customer: { name: 'Ana Top' }, assigned_user_id: 'usr_9' }),
      ],
    });
    const tools = createReadTools({
      ctx,
      can: (permiso) => permiso !== 'chats.force_reassign',
      actor: { id: 'usr_1', actor_type: 'USER' },
    });
    const salida = await tools.run('clientes_buscar', { q: 'ana' });
    expect(salida.datos.map((row) => row.customerId)).toEqual(['cus_1']);

    const ficha = await tools.run('cliente_ficha', { cliente: 'cus_9' });
    expect(ficha.ok).toBe(false);
    expect(ficha.error).toBe('no_autorizado');
  });

  it('la ficha resume compras entregadas y el último mensaje', async () => {
    const ctx = contexto({
      conversations: [conversacion()],
      orders: [
        pedido({ id: 'P-1', dias: 40, total: 60, items: [{ quantity: 2, variantName: '60 cápsulas' }] }),
        pedido({ id: 'P-2', dias: 5, estado: 'nuevo', total: 30 }),
      ],
    });
    const tools = createReadTools({ ctx, can: puedeTodo, actor: { id: 'usr_1', actor_type: 'USER' } });
    const salida = await tools.run('cliente_ficha', { cliente: 'Ana Pérez' });
    expect(salida.ok).toBe(true);
    expect(salida.datos.compras.pedidos).toBe(1);
    expect(salida.datos.compras.total).toBe(60);
    expect(salida.datos.compras.diasDesdeUltima).toBe(40);
    expect(salida.datos.compras.productos[0]).toEqual({ nombre: '60 cápsulas', veces: 1 });
    expect(salida.datos.ultimoMensaje.sinResponder).toBe(true);
  });

  it('un nombre ambiguo devuelve opciones en vez de adivinar', async () => {
    const ctx = contexto({
      conversations: [
        conversacion({ customer_id: 'cus_1', customer: { name: 'Ana Pérez' } }),
        conversacion({ customer_id: 'cus_2', customer: { name: 'Ana Pérez' } }),
      ],
    });
    const tools = createReadTools({ ctx, can: puedeTodo, actor: { id: 'usr_1', actor_type: 'USER' } });
    const salida = await tools.run('cliente_ficha', { cliente: 'ana pérez' });
    expect(salida.ok).toBe(false);
    expect(salida.error).toBe('ambiguo');
    expect(salida.opciones).toHaveLength(2);
  });

  it('conversaciones sin responder y catálogo respetan los topes', async () => {
    const ctx = contexto({
      conversations: [
        conversacion({ customer_id: 'a' }),
        conversacion({ customer_id: 'b', last_inbound_at: haceDias(1) }),
      ],
      catalogo: [
        { id: 'p1', name: '60 cápsulas', capsule_quantity: 60, sale_price_cents: 3500 },
        { id: 'p2', name: '120 cápsulas', capsule_quantity: 120, sale_price_cents: 6000 },
      ],
    });
    const tools = createReadTools({ ctx, can: puedeTodo, actor: { id: 'usr_1', actor_type: 'USER' } });
    const sinResponder = await tools.run('conversaciones_sin_responder', { horas: 24, limite: 1 });
    expect(sinResponder.datos).toHaveLength(1);
    /* `total` cuenta todo lo que coincide; `datos` es la página pedida. */
    expect(sinResponder.total).toBe(2);

    const catalogo = await tools.run('catalogo_precios', { q: '120' });
    expect(catalogo.datos).toEqual([{ nombre: '120 cápsulas', capsulas: 120, precio: 60, disponible: true }]);

    /* El límite que pide el modelo nunca supera el máximo de la herramienta. */
    const abusivo = await tools.run('catalogo_precios', { limite: 999 });
    expect(abusivo.datos.length).toBeLessThanOrEqual(12);
  });

  it('una herramienta inexistente se rechaza sin ejecutar nada', async () => {
    const tools = createReadTools({ ctx: contexto(), can: puedeTodo, actor: { id: 'usr_1', actor_type: 'USER' } });
    expect(tools.nombres).toEqual([
      'clientes_buscar',
      'cliente_ficha',
      'compras_recompra',
      'pedidos_pendientes',
      'conversaciones_sin_responder',
      'catalogo_precios',
    ]);
    const salida = await tools.run('sql_libre', { query: 'DELETE FROM phytoemagry_orders' });
    expect(salida).toEqual({ ok: false, error: 'herramienta_no_autorizada', nota: 'Esa consulta no está registrada.' });
  });
});

/* ------------------------------------------------- 2. bucle con el modelo */

const conLlamada = (nombre, argumentos, id = 'call_1') => ({
  ok: true,
  json: async () => ({
    model: 'deepseek-flash',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name: nombre, arguments: JSON.stringify(argumentos) } }],
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  }),
});

const respuestaTexto = (texto) => ({
  ok: true,
  json: async () => ({
    model: 'deepseek-flash',
    choices: [{ finish_reason: 'stop', message: { content: texto } }],
    usage: { prompt_tokens: 150, completion_tokens: 60, total_tokens: 210 },
  }),
});

describe('consulta del modelo con herramientas', () => {
  it('pide una consulta, la recibe y después responde', async () => {
    const cuerpos = [];
    const respuestas = [conLlamada('clientes_buscar', { q: 'ana' }), respuestaTexto('Ana compró hace 40 días.')];
    const { svc } = await servicio({
      fetchImpl: async (_url, options) => {
        cuerpos.push(JSON.parse(options.body));
        return respuestas.shift();
      },
    });
    const usadas = [];
    const salida = await svc.askWithTools({
      system: 'eres el agente de seguimiento',
      user: '{"pregunta":"¿puedo ofrecerle recompra a Ana?"}',
      tools: [{ type: 'function', function: { name: 'clientes_buscar', parameters: { type: 'object' } } }],
      runTool: async (nombre, args) => {
        usadas.push([nombre, args]);
        return { ok: true, datos: [{ nombre: 'Ana Pérez', diasDesdeUltimaCompra: 40 }] };
      },
      actorId: 'ops-agent:followup_agent:usr_1',
      agent: 'followup_agent',
    });

    expect(salida.ok).toBe(true);
    expect(salida.text).toBe('Ana compró hace 40 días.');
    expect(salida.rounds).toBe(2);
    expect(salida.toolsUsed).toEqual([{ name: 'clientes_buscar', ok: true, error: null }]);
    expect(salida.usage).toEqual({ prompt: 250, completion: 80, total: 330 });
    expect(usadas).toEqual([['clientes_buscar', { q: 'ana' }]]);

    /* El modelo recibe el catálogo de herramientas y el resultado acotado. */
    expect(cuerpos[0].tools).toHaveLength(1);
    expect(cuerpos[0].tool_choice).toBe('auto');
    expect(cuerpos[1].messages.some((row) => row.role === 'tool')).toBe(true);
  });

  it('un historial de conversación se manda recortado, sin crecer sin control', async () => {
    let cuerpo = null;
    const { svc } = await servicio({
      fetchImpl: async (_url, options) => {
        cuerpo = JSON.parse(options.body);
        return respuestaTexto('ok');
      },
    });
    await svc.askWithTools({
      system: 's',
      user: 'u',
      history: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'agent' : 'user', text: `turno ${i}` })),
      tools: [],
      runTool: async () => ({ ok: false }),
    });
    const turnos = cuerpo.messages.filter((row) => row.role !== 'system');
    expect(turnos).toHaveLength(7); /* 6 de historial + la pregunta */
    expect(turnos.at(-1).content).toBe('u');
  });

  it('respeta el máximo de vueltas cuando el modelo solo pide datos', async () => {
    let llamadas = 0;
    const { svc } = await servicio({
      fetchImpl: async () => {
        llamadas += 1;
        return conLlamada('clientes_buscar', { q: 'ana' }, `call_${llamadas}`);
      },
    });
    const salida = await svc.askWithTools({
      system: 's',
      user: 'u',
      tools: [{ type: 'function', function: { name: 'clientes_buscar' } }],
      runTool: async () => ({ ok: true, datos: [] }),
      maxRounds: 2,
    });
    expect(llamadas).toBe(2);
    expect(salida.ok).toBe(false);
    expect(salida.reason).toBe('sin_respuesta');
  });

  it('sin clave configurada no consulta ni gasta', async () => {
    const settings = ajustes();
    const svc = createProofreadingService({
      settings,
      secret: 'x',
      fetchImpl: async () => {
        throw new Error('no debería llamarse');
      },
    });
    const salida = await svc.askWithTools({ system: 's', user: 'u', runTool: async () => ({ ok: true }) });
    expect(salida).toEqual({ ok: false, reason: 'sin_configurar' });
  });
});

/* --------------------------------------- 3. consumo y presupuesto del día */

describe('consumo y presupuesto del proveedor', () => {
  it('acumula llamadas, tokens y coste estimado por agente', async () => {
    const { svc } = await servicio({ fetchImpl: async () => respuestaTexto('hola') });
    await svc.save({
      enabled: true,
      apiKey: 'clave-de-prueba-1234567890',
      priceInputPerM: 0.5,
      priceOutputPerM: 1.5,
      dailyBudgetUsd: 5,
    });

    await svc.answer({ system: 's', user: 'u', actorId: 'ops-agent:followup_agent:usr_1', agent: 'followup_agent' });
    const uso = await svc.opsUsage();
    expect(uso.calls).toBe(1);
    expect(uso.tokens).toEqual({ prompt: 150, completion: 60, total: 210 });
    /* 150/1e6 * 0.5 + 60/1e6 * 1.5 = 0.000165 */
    expect(uso.estimatedCostUsd).toBeCloseTo(0.000165, 6);
    expect(uso.remainingUsd).toBeCloseTo(4.999835, 6);
    expect(uso.byAgent.followup_agent).toMatchObject({ calls: 1, total: 210 });
    /* El aviso de que es una estimación viaja siempre con el dato. */
    expect(uso.note).toContain('No es la factura');
  });

  it('sin tarifas configuradas no inventa dinero', async () => {
    const { svc } = await servicio({ fetchImpl: async () => respuestaTexto('hola') });
    await svc.answer({ system: 's', user: 'u' });
    const uso = await svc.opsUsage();
    expect(uso.calls).toBe(1);
    expect(uso.estimatedCostUsd).toBe(0);
    expect(uso.budgetUsd).toBeNull();
    expect(uso.prices).toEqual({ inputPerM: null, outputPerM: null });
    expect(uso.note).toContain('No es la factura');
  });

  it('con el presupuesto agotado no se llama al proveedor y se dice el motivo', async () => {
    let llamadas = 0;
    const { svc } = await servicio({
      fetchImpl: async () => {
        llamadas += 1;
        return respuestaTexto('hola');
      },
    });
    await svc.save({
      enabled: true,
      apiKey: 'clave-de-prueba-1234567890',
      priceInputPerM: 1,
      priceOutputPerM: 1,
      dailyBudgetUsd: 0.00005,
    });
    const primera = await svc.askWithTools({ system: 's', user: 'u', runTool: async () => ({ ok: true }) });
    expect(primera.ok).toBe(true);
    expect(llamadas).toBe(1);

    const segunda = await svc.askWithTools({ system: 's', user: 'u', runTool: async () => ({ ok: true }) });
    expect(segunda).toEqual({ ok: false, reason: 'presupuesto' });
    expect(llamadas).toBe(1);
    const texto = await svc.answer({ system: 's', user: 'u' });
    expect(texto).toEqual({ ok: false, reason: 'presupuesto' });
  });

  it('el tope diario de llamadas sigue mandando aunque haya presupuesto', async () => {
    const { svc } = await servicio({ fetchImpl: async () => respuestaTexto('hola') });
    await svc.save({ enabled: true, apiKey: 'clave-de-prueba-1234567890', dailyLimit: 1, dailyBudgetUsd: 50 });
    expect((await svc.answer({ system: 's', user: 'u' })).ok).toBe(true);
    expect(await svc.answer({ system: 's', user: 'u' })).toEqual({ ok: false, reason: 'limite' });
  });
});
