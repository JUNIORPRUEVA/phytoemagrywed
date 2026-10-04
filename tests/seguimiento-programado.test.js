// @vitest-environment node
/**
 * MENSAJES PROGRAMADOS — seguimiento de compra / de interés.
 *
 * Lo que se protege aquí:
 *   - la PROPUESTA la decide el servidor según lo que sabe DE VERDAD del cliente
 *     (compró o no, cuántos frascos), y NO se inventa nada que no sepa;
 *   - nunca se menciona el «grupo» si el CRM no sabe que el cliente está en él;
 *   - no se programa con una plantilla que Meta no ha aprobado;
 *   - el contenido se CONGELA al programar: al llegar la hora se envía exactamente
 *     eso, aunque el cliente o su pedido hayan cambiado después;
 *   - nunca se cruzan datos entre clientes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';
import {
  INTEREST_FOLLOWUP_TEMPLATE,
  MANY_BOTTLES,
  PURCHASE_FOLLOWUP_TEMPLATE,
  SUGGESTED_TEXT,
  bottlesOfOrder,
  suggestScheduledMessage,
} from '../server/message-suggestions.mjs';

const TOKEN = 'clave-programados-123';

let tmpDir;
let app;
let cookie = '';
/** Clientes de prueba: nombres, teléfonos y conversaciones. */
const gente = {};

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN123',
  businessAccountId: 'WABA1',
  sent: [],
  failWith: null,
  async sendText(to, body) {
    if (mockWhatsApp.failWith) return { ok: false, status: 400, error: mockWhatsApp.failWith };
    mockWhatsApp.sent.push({ to, body, type: 'text' });
    return { ok: true, status: 200, messageId: `wamid.TXT${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    if (mockWhatsApp.failWith) return { ok: false, status: 400, error: mockWhatsApp.failWith };
    mockWhatsApp.sent.push({ to, template, type: 'template' });
    return { ok: true, status: 200, messageId: `wamid.TPL${mockWhatsApp.sent.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

const call = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
  });
const json = async (response) => JSON.parse(await response.text());

const soon = (ms = 900) => new Date(Date.now() + ms).toISOString();

async function nuevoCliente(slot, phone, name) {
  const response = await call('/api/admin/conversations/start', {
    method: 'POST',
    body: JSON.stringify({ phone, name, body: '' }),
  });
  const body = await json(response);
  gente[slot] = { phone, name, customerId: body.customer.id, conversationId: body.conversation.id };
  return gente[slot];
}

async function compra(customerId, quantity, status = 'entregado') {
  const response = await call('/api/admin/purchases', {
    method: 'POST',
    body: JSON.stringify({ customerId, variantId: 'capsules_10', quantity, paymentMethod: 'CASH', status }),
  });
  const body = await json(response);
  if (response.status !== 201) throw new Error(`no se pudo crear la compra: ${JSON.stringify(body)}`);
  return body;
}

/** Aprueba una plantilla como lo hace el negocio tras aprobarla en Meta. */
async function aprobar(name) {
  const response = await call('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({ name, status: 'APPROVED' }),
  });
  expect(response.status).toBe(200);
}

const sugerir = async (customerId) =>
  json(await call(`/api/admin/scheduled/suggestion?customerId=${encodeURIComponent(customerId)}`));

/** Un mensaje programado que ya toca: se adelanta su hora y se pasa el scheduler. */
async function adelantar(scheduledId) {
  await app.collections.update('scheduled_messages', scheduledId, {
    scheduled_at: new Date(Date.now() - 60_000).toISOString(),
  });
  await app.scheduler.tick();
  return app.collections.get('scheduled_messages', scheduledId);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-programados-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    whatsappPhoneNumber: '+18095550000',
    whatsapp: mockWhatsApp,
    schedulerEnabled: false,
  });
  const login = await call('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  // Los clientes: uno de volumen, uno de un frasco y uno que nunca compró.
  await nuevoCliente('volumen', '18095551001', 'Ana Volumen');
  await nuevoCliente('uno', '18095551002', 'Luis Uno');
  await nuevoCliente('interesado', '18095551003', 'María Interesada');
  await nuevoCliente('abierto', '18095551004', 'Pedro Abierto');

  await compra(gente.volumen.customerId, MANY_BOTTLES + 2); // 8 frascos
  await compra(gente.uno.customerId, 3); // 3 frascos
  await compra(gente.abierto.customerId, 4, 'nuevo'); // pedido SIN entregar

  // Las plantillas tienen que existir antes de aprobarlas (las siembra el CRM).
  await call('/api/admin/wa-templates');
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('la propuesta del servidor', () => {
  it('cliente con compra entregada → seguimiento de compra', async () => {
    const { suggestion, templates } = await sugerir(gente.volumen.customerId);
    expect(suggestion.type).toBe('compra');
    expect(suggestion.templateName).toBe(PURCHASE_FOLLOWUP_TEMPLATE);
    expect(suggestion.hasPurchase).toBe(true);
    expect(templates.purchase.name).toBe(PURCHASE_FOLLOWUP_TEMPLATE);
  });

  it('8 frascos (6 o más) → mensaje de cliente de volumen', async () => {
    const { suggestion } = await sugerir(gente.volumen.customerId);
    expect(suggestion.bottles).toMatchObject({ known: true, units: MANY_BOTTLES + 2 });
    expect(suggestion.manyBottles).toBe(true);
    expect(suggestion.message).toBe(SUGGESTED_TEXT.purchaseMany);
  });

  it('3 frascos (menos de 6) → mensaje general de compra', async () => {
    const { suggestion } = await sugerir(gente.uno.customerId);
    expect(suggestion.manyBottles).toBe(false);
    expect(suggestion.message).toBe(SUGGESTED_TEXT.purchaseFew);
  });

  it('EXACTAMENTE 6 frascos cuenta como 6 o más (frontera)', async () => {
    await nuevoCliente('frontera', '18095551005', 'Frontera Exacta');
    await compra(gente.frontera.customerId, MANY_BOTTLES);
    const { suggestion } = await sugerir(gente.frontera.customerId);
    expect(suggestion.bottles.units).toBe(MANY_BOTTLES);
    expect(suggestion.manyBottles).toBe(true);
    expect(suggestion.message).toBe(SUGGESTED_TEXT.purchaseMany);
  });

  it('cliente sin compra → seguimiento de interés', async () => {
    const { suggestion } = await sugerir(gente.interesado.customerId);
    expect(suggestion.type).toBe('interes');
    expect(suggestion.templateName).toBe(INTEREST_FOLLOWUP_TEMPLATE);
    expect(suggestion.hasPurchase).toBe(false);
    expect(suggestion.message).toBe(SUGGESTED_TEXT.interestGeneral);
  });

  it('un pedido SIN entregar no es una compra', async () => {
    const { suggestion } = await sugerir(gente.abierto.customerId);
    expect(suggestion.hasPurchase).toBe(false);
    expect(suggestion.type).toBe('interes');
  });

  it('NUNCA se menciona el «grupo»: el CRM no sabe quién está en él', async () => {
    for (const slot of ['volumen', 'uno', 'interesado', 'abierto']) {
      const { suggestion } = await sugerir(gente[slot].customerId);
      expect(suggestion.groupMember).toBe(false);
      expect(suggestion.message).not.toMatch(/grupo/i);
    }
  });

  it('si no se pueden saber los frascos, se usa el mensaje general y se dice qué falta', () => {
    // Pedido antiguo reconstruido: sin `units` y sin líneas.
    const sinDatos = { type: 'order_intent', status: 'entregado', id: 'x', quantity: null, order_json: '{}' };
    expect(bottlesOfOrder(sinDatos)).toMatchObject({ known: false, units: null });
    const resultado = suggestScheduledMessage({ customer: { name: 'Ana' }, orders: [sinDatos] });
    expect(resultado.message).toBe(SUGGESTED_TEXT.purchaseFew);
    expect(resultado.manyBottles).toBe(false);
    expect(resultado.notes.join(' ')).toMatch(/cuántos frascos/i);
  });

  it('si el dato SÍ existe, no se avisa de nada', async () => {
    const { suggestion } = await sugerir(gente.volumen.customerId);
    expect(suggestion.notes).toEqual([]);
  });

  it('el caso del grupo existe pero NO se activa sin un dato real', () => {
    const sinDato = suggestScheduledMessage({ customer: { name: 'Ana' }, orders: [] });
    expect(sinDato.message).toBe(SUGGESTED_TEXT.interestGeneral);
    const conDato = suggestScheduledMessage({ customer: { name: 'Ana' }, orders: [], groupMember: true });
    expect(conDato.message).toBe(SUGGESTED_TEXT.interestGroup);
    expect(conDato.groupMember).toBe(true);
  });
});

describe('programar un mensaje', () => {
  it('con la plantilla todavía SIN aprobar no se programa (y se dice por qué)', async () => {
    mockWhatsApp.sent.length = 0;
    const response = await call('/api/admin/scheduled', {
      method: 'POST',
      body: JSON.stringify({
        customerId: gente.volumen.customerId,
        conversationId: gente.volumen.conversationId,
        scheduledAt: soon(),
        type: 'template',
        template: PURCHASE_FOLLOWUP_TEMPLATE,
        templateValues: { 2: SUGGESTED_TEXT.purchaseMany },
      }),
    });
    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.error).toBe('template_not_approved');
    expect(body.message).toMatch(/no está aprobada en Meta/i);
    const lista = await json(await call('/api/admin/scheduled'));
    expect(lista.scheduled.filter((row) => row.customer_id === gente.volumen.customerId)).toHaveLength(0);
  });

  it('la conversación de OTRO cliente se rechaza: no se cruzan datos', async () => {
    await aprobar(PURCHASE_FOLLOWUP_TEMPLATE);
    const response = await call('/api/admin/scheduled', {
      method: 'POST',
      body: JSON.stringify({
        customerId: gente.volumen.customerId,
        conversationId: gente.interesado.conversationId,
        scheduledAt: soon(),
        type: 'template',
        template: PURCHASE_FOLLOWUP_TEMPLATE,
        templateValues: { 2: 'Hola' },
      }),
    });
    expect(response.status).toBe(409);
    expect((await json(response)).error).toBe('conversation_mismatch');
  });

  it('un cliente que no existe o una fecha inválida se rechazan', async () => {
    const sinCliente = await call('/api/admin/scheduled', {
      method: 'POST',
      body: JSON.stringify({ customerId: 'cus_inventado', scheduledAt: soon(), text: 'Hola' }),
    });
    expect(sinCliente.status).toBe(422);
    const sinFecha = await call('/api/admin/scheduled', {
      method: 'POST',
      body: JSON.stringify({ customerId: gente.volumen.customerId, scheduledAt: 'mañana', text: 'Hola' }),
    });
    expect(sinFecha.status).toBe(422);
    expect((await json(sinFecha)).error).toBe('invalid_date');
  });

  it('con la plantilla aprobada se programa y el contenido queda CONGELADO', async () => {
    const { suggestion } = await sugerir(gente.volumen.customerId);
    const response = await call('/api/admin/scheduled', {
      method: 'POST',
      body: JSON.stringify({
        customerId: gente.volumen.customerId,
        conversationId: gente.volumen.conversationId,
        scheduledAt: soon(60_000),
        type: 'template',
        template: PURCHASE_FOLLOWUP_TEMPLATE,
        templateValues: { 2: suggestion.message },
      }),
    });
    expect(response.status).toBe(201);
    const row = (await json(response)).message;
    gente.volumen.scheduledId = row.id;
    expect(row.status).toBe('SCHEDULED');
    // Todo lo que hay que guardar, guardado.
    expect(row.customer_id).toBe(gente.volumen.customerId);
    expect(row.conversation_id).toBe(gente.volumen.conversationId);
    expect(row.template).toBe(PURCHASE_FOLLOWUP_TEMPLATE);
    expect(row.template_language).toBe('es');
    expect(row.time_zone).toBeTruthy();
    expect(row.scheduled_at).toBeTruthy();
    expect(row.template_components[0].parameters.map((p) => p.text)).toEqual(['Ana Volumen', suggestion.message]);
    expect(row.template_body).toContain('Ana Volumen');
    expect(row.template_body).toContain(suggestion.message);
  });

  it('el agente puede EDITAR el mensaje sugerido y se guarda el suyo', async () => {
    const mio = 'Te escribo para saber si quieres repetir.';
    const response = await call('/api/admin/scheduled', {
      method: 'POST',
      body: JSON.stringify({
        customerId: gente.uno.customerId,
        conversationId: gente.uno.conversationId,
        scheduledAt: soon(60_000),
        type: 'template',
        template: PURCHASE_FOLLOWUP_TEMPLATE,
        templateValues: { 2: mio },
      }),
    });
    expect(response.status).toBe(201);
    const row = (await json(response)).message;
    gente.uno.scheduledId = row.id;
    expect(row.template_body).toContain(mio);
    expect(row.template_body).not.toContain(SUGGESTED_TEXT.purchaseFew);
  });
});

describe('al llegar la hora', () => {
  it('se envía EXACTAMENTE lo aprobado, al cliente correcto', async () => {
    mockWhatsApp.sent.length = 0;
    const row = await adelantar(gente.volumen.scheduledId);
    expect(row.status).toBe('SENT');
    expect(mockWhatsApp.sent).toHaveLength(1);
    const enviado = mockWhatsApp.sent[0];
    expect(enviado.to).toBe(`+${gente.volumen.phone}`);
    expect(enviado.type).toBe('template');
    expect(enviado.template.name).toBe(PURCHASE_FOLLOWUP_TEMPLATE);
    expect(enviado.template.language).toBe('es');
    expect(enviado.template.components[0].parameters.map((p) => p.text)).toEqual([
      'Ana Volumen',
      SUGGESTED_TEXT.purchaseMany,
    ]);
    expect(row.wa_message_id).toBeTruthy();
    expect(row.message_id).toBeTruthy();
  });

  it('NO se regenera: si el cliente o el pedido cambian, el mensaje NO cambia', async () => {
    // El agente edita el nombre del cliente después de programar.
    await call(`/api/admin/customers/${gente.uno.customerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Luis Ya Cambiado' }),
    });
    mockWhatsApp.sent.length = 0;
    const row = await adelantar(gente.uno.scheduledId);
    expect(row.status).toBe('SENT');
    // Sigue saliendo el nombre que había cuando se programó y el mensaje escrito.
    expect(mockWhatsApp.sent[0].template.components[0].parameters.map((p) => p.text)).toEqual([
      'Luis Uno',
      'Te escribo para saber si quieres repetir.',
    ]);
    expect(row.template_body).toContain('Luis Uno');
  });

  it('una fecha FUTURA no se envía antes de tiempo', async () => {
    mockWhatsApp.sent.length = 0;
    await call('/api/admin/scheduled', {
      method: 'POST',
      body: JSON.stringify({
        customerId: gente.interesado.customerId,
        conversationId: gente.interesado.conversationId,
        scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
        type: 'template',
        template: PURCHASE_FOLLOWUP_TEMPLATE,
        templateValues: { 2: 'Más adelante' },
      }),
    });
    const resultado = await app.scheduler.tick();
    expect(resultado.sent).toBe(0);
    expect(mockWhatsApp.sent).toHaveLength(0);
  });

  it('si Meta retira la plantilla entre programar y enviar, NO se fuerza: queda sin enviar', async () => {
    // Se programa con la plantilla aprobada...
    const creado = await json(
      await call('/api/admin/scheduled', {
        method: 'POST',
        body: JSON.stringify({
          customerId: gente.interesado.customerId,
          conversationId: gente.interesado.conversationId,
          scheduledAt: soon(60_000),
          type: 'template',
          template: PURCHASE_FOLLOWUP_TEMPLATE,
          templateValues: { 2: 'Puede que no salga' },
        }),
      }),
    );
    // ...y Meta la retira antes de la hora.
    await call('/api/admin/wa-templates', {
      method: 'POST',
      body: JSON.stringify({ name: PURCHASE_FOLLOWUP_TEMPLATE, status: 'PENDING' }),
    });
    mockWhatsApp.sent.length = 0;
    const row = await adelantar(creado.message.id);
    expect(row.status).toBe('BLOCKED');
    expect(row.blocked_reason).toBe('TEMPLATE_NOT_APPROVED');
    expect(row.blocked_message).toMatch(/no está aprobada/i);
    expect(mockWhatsApp.sent).toHaveLength(0);
    // Y el contenido congelado sigue ahí, para poder ver qué se iba a enviar.
    expect(row.template_body).toContain('Puede que no salga');
    await aprobar(PURCHASE_FOLLOWUP_TEMPLATE);
  });

  it('un error de Meta deja el mensaje FALLIDO con su motivo', async () => {
    mockWhatsApp.failWith = { code: 131026, message: 'Message undeliverable' };
    const creado = await json(
      await call('/api/admin/scheduled', {
        method: 'POST',
        body: JSON.stringify({
          customerId: gente.interesado.customerId,
          conversationId: gente.interesado.conversationId,
          scheduledAt: soon(60_000),
          type: 'template',
          template: PURCHASE_FOLLOWUP_TEMPLATE,
          templateValues: { 2: 'Va a fallar' },
        }),
      }),
    );
    const row = await adelantar(creado.message.id);
    mockWhatsApp.failWith = null;
    expect(row.status).toBe('FAILED');
    expect(row.error_code).toBe(131026);
    expect(row.error_message).toMatch(/undeliverable/i);
    // Queda como mensaje fallido en el hilo, con su motivo: se puede auditar.
    const thread = await json(await call(`/api/admin/conversations/${gente.interesado.conversationId}/messages`));
    expect(thread.messages.some((message) => message.status === 'failed')).toBe(true);
  });

  it('un mensaje CANCELADO no sale', async () => {
    const creado = await json(
      await call('/api/admin/scheduled', {
        method: 'POST',
        body: JSON.stringify({
          customerId: gente.interesado.customerId,
          conversationId: gente.interesado.conversationId,
          scheduledAt: soon(60_000),
          type: 'template',
          template: PURCHASE_FOLLOWUP_TEMPLATE,
          templateValues: { 2: 'Este se cancela' },
        }),
      }),
    );
    const cancelado = await call(`/api/admin/scheduled/${creado.message.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'cancel', reason: 'el cliente ya escribió' }),
    });
    expect((await json(cancelado)).message.status).toBe('CANCELLED');
    mockWhatsApp.sent.length = 0;
    await adelantar(creado.message.id);
    expect(mockWhatsApp.sent).toHaveLength(0);
  });
});
