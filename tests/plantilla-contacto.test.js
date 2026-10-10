// @vitest-environment node
/**
 * CHAT DIRECTO — plantilla principal de contacto personalizado.
 *
 * Lo que se protege aquí:
 *   - dentro de la ventana de 24 h se escribe TEXTO LIBRE (no se obliga a plantilla);
 *   - fuera de la ventana, WhatsApp solo admite una plantilla APROBADA de verdad;
 *   - la plantilla es sencilla: nombre real + mensaje del agente, nada más
 *     (sin saludo por hora, sin «solicitud», sin teléfonos dentro del texto);
 *   - el servidor VUELVE A COMPROBAR conversación → cliente → destinatario justo
 *     antes de enviar: nunca se cruzan datos entre clientes;
 *   - enviar un mensaje NO toca pedidos, ubicaciones ni delivery.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'clave-chat-directo-123';
const APP_SECRET = 'app-secreto-chat-directo';
const PHONE = '18095558888';
const NOMBRE = 'Juan Pérez';

/** El cuerpo que TIENE que estar registrado en Meta, palabra por palabra. */
const CUERPO =
  'Hola {{1}}, te escribimos de Phytoemagry.\n\n{{2}}\n\nSi necesitas alguna información adicional, estamos disponibles para ayudarte.';

let tmpDir;
let app;
let cookie = '';
let conversationId = '';
let customerId = '';

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN123',
  businessAccountId: 'WABA1',
  sent: [],
  failWith: null,
  /** Plantillas que «están en Meta». Vacío = Meta no conoce ninguna todavía. */
  metaTemplates: [],
  async sendText(to, body, options) {
    if (mockWhatsApp.failWith) return { ok: false, status: 400, error: mockWhatsApp.failWith };
    mockWhatsApp.sent.push({ to, body, options, type: 'text' });
    return { ok: true, status: 200, messageId: `wamid.TXT${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    if (mockWhatsApp.failWith) return { ok: false, status: 400, error: mockWhatsApp.failWith };
    mockWhatsApp.sent.push({ to, template, type: 'template' });
    return { ok: true, status: 200, messageId: `wamid.TPL${mockWhatsApp.sent.length}` };
  },
  async listTemplates() {
    // Meta todavía no conoce esta plantilla: no puede aparecer aprobada.
    return { ok: true, templates: mockWhatsApp.metaTemplates };
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

async function waitFor(check, timeout = 4000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timeout: el servidor no terminó el trabajo');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Mensaje entrante como el que manda Meta (el nombre real lo pone el perfil). */
async function inbound(id, body, from = PHONE, name = NOMBRE) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name }, wa_id: from }],
              messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  return fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
}

/** Deja la conversación fuera de la ventana de 24 h. */
async function cerrarVentana() {
  await app.collections.update('conversations', conversationId, {
    last_inbound_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
  });
}
async function abrirVentana() {
  await app.collections.update('conversations', conversationId, { last_inbound_at: new Date().toISOString() });
}

async function aprobarContacto() {
  const response = await call('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({ name: 'phyto_contacto_personalizado_v1', status: 'APPROVED' }),
  });
  expect(response.status).toBe(200);
  return (await json(response)).template;
}

const enviar = (payload) =>
  call(`/api/admin/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify(payload) });

const listaPlantillas = async () => json(await call('/api/admin/wa-templates'));

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-chat-directo-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsappPhoneNumber: '+18095550000',
    whatsapp: mockWhatsApp,
    schedulerEnabled: false,
  });
  const login = await call('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  await inbound('wamid.CHAT1', 'Hola, quiero información');
  const conversation = await waitFor(async () => {
    const data = await json(await call('/api/admin/conversations'));
    return data.conversations.find((row) => row.customer?.phone_e164 === `+${PHONE}`) ?? null;
  });
  conversationId = conversation.id;
  customerId = conversation.customer_id;
  // Las plantillas existen (las siembra el CRM) antes de aprobar nada.
  await listaPlantillas();
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('la plantilla principal del chat directo', () => {
  it('está declarada con DOS variables y el cuerpo exacto de Meta', async () => {
    const data = await listaPlantillas();
    const plantilla = data.templates.find((row) => row.name === 'phyto_contacto_personalizado_v1');
    expect(plantilla).toBeTruthy();
    expect(plantilla.friendly_name).toBe('Contacto personalizado');
    expect(plantilla.category).toBe('MARKETING');
    expect(plantilla.language).toBe('es');
    expect(plantilla.body).toBe(CUERPO);
    expect(plantilla.variables).toEqual(['customer_name', 'mensaje']);
    expect((plantilla.body.match(/\{\{\d+\}\}/g) ?? []).length).toBe(2);
  });

  it('es SENCILLA: sin saludo por hora, sin «solicitud» y sin teléfonos', async () => {
    const data = await listaPlantillas();
    const plantilla = data.templates.find((row) => row.name === 'phyto_contacto_personalizado_v1');
    expect(plantilla.body).not.toMatch(/Buenos|Buenas/);
    expect(plantilla.body).not.toMatch(/solicitud/i);
    expect(plantilla.variables).not.toContain('saludo');
  });

  it('NO nace aprobada, y sincronizar con Meta no la aprueba', async () => {
    const antes = (await listaPlantillas()).templates.find((row) => row.name === 'phyto_contacto_personalizado_v1');
    expect(antes.status).toBe('pending_approval');
    expect(antes.sendable).toBe(false);

    await call('/api/admin/wa-templates/sync', { method: 'POST', body: '{}' });
    const despues = (await listaPlantillas()).templates.find((row) => row.name === 'phyto_contacto_personalizado_v1');
    expect(despues.status).toBe('pending_approval');
    expect(despues.sendable).toBe(false);
  });

  it('sin aprobar no se puede enviar: lo dice y no sale nada', async () => {
    await cerrarVentana();
    mockWhatsApp.sent.length = 0;
    const response = await enviar({
      template: 'phyto_contacto_personalizado_v1',
      templateValues: { 1: NOMBRE, 2: 'Hola' },
    });
    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.error).toBe('template_not_approved');
    expect(body.message).toMatch(/no está aprobada en Meta/i);
    expect(mockWhatsApp.sent).toHaveLength(0);
  });
});

describe('la regla de las 24 horas', () => {
  it('DENTRO de la ventana se escribe texto libre', async () => {
    await abrirVentana();
    mockWhatsApp.sent.length = 0;
    const response = await enviar({ body: 'Claro, te cuento: una cápsula al día.', conversationId });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.message.type).toBe('text');
    expect(mockWhatsApp.sent.at(-1)).toMatchObject({
      to: `+${PHONE}`,
      type: 'text',
      body: 'Claro, te cuento: una cápsula al día.',
    });
  });

  it('FUERA de la ventana el texto libre NO sale (no se evade la regla)', async () => {
    await cerrarVentana();
    mockWhatsApp.sent.length = 0;
    const response = await enviar({ body: '¿Sigues por ahí?', conversationId });
    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.error).toBe('outside_window');
    // Y el aviso manda a la salida legal: la plantilla aprobada.
    expect(body.message).toMatch(/plantilla/i);
    expect(mockWhatsApp.sent).toHaveLength(0);
  });

  it('FUERA de la ventana SÍ sale con la plantilla aprobada', async () => {
    await aprobarContacto();
    mockWhatsApp.sent.length = 0;
    const response = await enviar({
      template: 'phyto_contacto_personalizado_v1',
      templateValues: { 2: 'Te escribimos por tu pedido.' },
    });
    expect(response.status).toBe(200);
    expect(mockWhatsApp.sent.at(-1).type).toBe('template');
  });
});

describe('los huecos de la plantilla', () => {
  it('el nombre sale AUTOMÁTICO del cliente de esta conversación', async () => {
    await abrirVentana();
    mockWhatsApp.sent.length = 0;
    const response = await enviar({
      template: 'phyto_contacto_personalizado_v1',
      templateValues: { 2: 'Un mensaje cualquiera.' },
    });
    expect(response.status).toBe(200);
    expect(mockWhatsApp.sent.at(-1).template.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: NOMBRE },
          { type: 'text', text: 'Un mensaje cualquiera.' },
        ],
      },
    ]);
  });

  it('el mensaje del agente se envía EXACTO y el texto final es el previsto', async () => {
    const mio = 'Queremos confirmar si todavía deseas recibir tu pedido mañana.';
    const response = await enviar({ template: 'phyto_contacto_personalizado_v1', templateValues: { 2: mio } });
    expect(response.status).toBe(200);
    const body = await json(response);
    // Letra a letra: el nombre en su sitio, el mensaje del agente dentro y los
    // saltos de línea del texto fijo INTACTOS.
    const esperado = CUERPO.replace('{{1}}', 'Juan Pérez').replace('{{2}}', mio);
    expect(body.message.body).toBe(esperado);
    expect(body.message.body.split('\n\n')).toHaveLength(3);
  });

  it('el agente puede CORREGIR el nombre: lo escrito manda', async () => {
    const response = await enviar({
      template: 'phyto_contacto_personalizado_v1',
      templateValues: { 1: 'Juanpi', 2: 'Hola' },
    });
    expect(response.status).toBe(200);
    expect(mockWhatsApp.sent.at(-1).template.components[0].parameters[0].text).toBe('Juanpi');
  });

  it('al cliente NUNCA le viaja su propio teléfono dentro del texto', async () => {
    mockWhatsApp.sent.length = 0;
    const response = await enviar({ template: 'phyto_contacto_personalizado_v1', templateValues: { 2: '¿Seguimos?' } });
    const body = await json(response);
    expect(response.status).toBe(200);
    expect(body.message.body).not.toMatch(/809|1809|\+18095558888/);
    // El número se usa para ENVIAR, no para escribirlo.
    expect(mockWhatsApp.sent.at(-1).to).toBe(`+${PHONE}`);
  });

  it('aplana los saltos de línea que Meta no admite DENTRO de una variable', async () => {
    const response = await enviar({
      template: 'phyto_contacto_personalizado_v1',
      templateValues: { 2: 'Primera línea\n\nSegunda   línea' },
    });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(mockWhatsApp.sent.at(-1).template.components[0].parameters[1].text).toBe('Primera línea Segunda línea');
    // Los saltos del texto FIJO (los que puso el negocio en Meta) siguen ahí.
    expect(body.message.body.split('\n\n')).toHaveLength(3);
  });

  it('sin el mensaje del agente se dice qué falta en vez de mandar algo vacío', async () => {
    mockWhatsApp.sent.length = 0;
    const response = await enviar({ template: 'phyto_contacto_personalizado_v1' });
    expect(response.status).toBe(422);
    const body = await json(response);
    expect(body.error).toBe('missing_template_data');
    expect(body.missing).toContain('mensaje');
    expect(mockWhatsApp.sent).toHaveLength(0);
  });
});

describe('el servidor revalida antes de enviar', () => {
  it('si el panel afirma OTRA conversación, se corta y no sale nada', async () => {
    mockWhatsApp.sent.length = 0;
    const response = await enviar({ body: 'Hola', conversationId: 'conv_de_otro_cliente' });
    expect(response.status).toBe(409);
    expect((await json(response)).error).toBe('conversation_mismatch');
    expect(mockWhatsApp.sent).toHaveLength(0);
  });

  it('el destinatario es SIEMPRE el cliente de la conversación de la URL', async () => {
    mockWhatsApp.sent.length = 0;
    // El cuerpo intenta colar otro destinatario: se ignora por completo.
    const response = await enviar({ body: 'Hola', conversationId, to: '18090000000', phone: '18090000000' });
    expect(response.status).toBe(200);
    expect(mockWhatsApp.sent.at(-1).to).toBe(`+${PHONE}`);
  });

  it('una conversación que no existe no envía nada', async () => {
    mockWhatsApp.sent.length = 0;
    const response = await call('/api/admin/conversations/conv_inventada/messages', {
      method: 'POST',
      body: JSON.stringify({ body: 'Hola' }),
    });
    expect(response.status).toBe(404);
    expect(mockWhatsApp.sent).toHaveLength(0);
  });

  it('quien pidió no recibir mensajes no recibe la plantilla', async () => {
    await call(`/api/admin/customers/${customerId}/opt-out`, { method: 'POST', body: '{}' });
    mockWhatsApp.sent.length = 0;
    const response = await enviar({ template: 'phyto_contacto_personalizado_v1', templateValues: { 2: 'Hola' } });
    expect(response.status).toBe(409);
    expect((await json(response)).error).toBe('do_not_contact');
    expect(mockWhatsApp.sent).toHaveLength(0);
    await call(`/api/admin/customers/${customerId}/opt-in`, { method: 'POST', body: '{}' });
  });
});

describe('enviar un mensaje no toca nada más', () => {
  it('no crea pedidos, ni ubicaciones, ni sesiones de delivery', async () => {
    const antes = await json(await call('/api/admin/data'));
    const contar = (data) => ({
      pedidos: (data.items ?? []).filter((item) => item.type === 'order_intent').length,
      ubicaciones: (data.locations ?? []).length,
      deliveries: (data.deliveryTracking ?? []).length,
    });
    const antesContado = contar(antes);

    await enviar({ template: 'phyto_contacto_personalizado_v1', templateValues: { 2: 'Solo un mensaje.' } });

    const despues = await json(await call('/api/admin/data'));
    expect(contar(despues)).toEqual(antesContado);
  });
});

/*
 * LA PLANTILLA DE LAS CAMPAÑAS (la que dice que escribe Fulltech).
 *
 * El negocio pidió que las campañas salgan con ESTA presentación y no con la
 * genérica. El texto fijo de una plantilla lo aprueba Meta, así que vive como
 * plantilla propia: aquí se sujeta el texto exacto y que, con el aviso de la
 * mudanza, el mensaje final sea PALABRA POR PALABRA el que pidió el negocio.
 */
const CUERPO_FULLTECH =
  'Hola {{1}}, te escribimos de Fulltech, distribuidor de Phytoemagry en Higüey.\n\n{{2}}\n\nCualquier duda, respóndenos por aquí y te ayudamos.';
const AVISO_MUDANZA =
  'Nos mudamos temporalmente a La Otra Banda y ahora trabajamos de forma virtual, con almacen en Higuey. Tenemos delivery de 8 a. m. a 9 p. m. Para pedidos o consultas, escribenos por aqui. Entrega rapida.';

describe('la plantilla de las campañas (aviso de Fulltech)', () => {
  it('está en el catálogo con DOS variables y su texto fijo exacto', async () => {
    const data = await listaPlantillas();
    const plantilla = data.templates.find((row) => row.name === 'phyto_aviso_fulltech_v1');
    expect(plantilla).toBeTruthy();
    expect(plantilla.friendly_name).toBe('Aviso de Fulltech (campañas)');
    expect(plantilla.category).toBe('MARKETING');
    expect(plantilla.language).toBe('es');
    expect(plantilla.body).toBe(CUERPO_FULLTECH);
    // El hueco LIBRE es el segundo: por ahí va el mensaje que escribe el agente.
    expect(plantilla.variables).toEqual(['customer_name', 'mensaje']);
  });

  it('con el aviso de la mudanza, el mensaje final es EXACTAMENTE el que pidió el negocio', () => {
    // Igual que lo monta el panel: texto fijo de delante + mensaje + texto fijo de detrás.
    const [antes, despues] = CUERPO_FULLTECH.split('{{2}}');
    const final = `${antes.replace('{{1}}', '{{nombre}}')}${AVISO_MUDANZA}${despues}`.trim();
    expect(final).toBe(
      'Hola {{nombre}}, te escribimos de Fulltech, distribuidor de Phytoemagry en Higüey.\n\n' +
        'Nos mudamos temporalmente a La Otra Banda y ahora trabajamos de forma virtual, con almacen en Higuey. ' +
        'Tenemos delivery de 8 a. m. a 9 p. m. Para pedidos o consultas, escribenos por aqui. Entrega rapida.\n\n' +
        'Cualquier duda, respóndenos por aquí y te ayudamos.',
    );
  });

  it('NO nace aprobada: hasta que Meta no la apruebe no se puede usar en una campaña', async () => {
    const plantilla = (await listaPlantillas()).templates.find((row) => row.name === 'phyto_aviso_fulltech_v1');
    expect(plantilla.status).toBe('pending_approval');
    expect(plantilla.sendable).toBe(false);
  });

  it('al sincronizar con Meta conserva la ficha del CRM (nombre amable y variables)', async () => {
    /*
     * Meta manda en el texto y el estado; el CRM manda en QUÉ HUECO ES EL LIBRE.
     * Sin esto, una plantilla recién creada en Meta llega sin variables y el panel
     * no sabría por dónde va el mensaje (ni ofrecería la campaña con ella).
     */
    mockWhatsApp.metaTemplates = [
      {
        name: 'phyto_aviso_fulltech_v1',
        id: '900000000000001',
        language: 'es',
        category: 'MARKETING',
        status: 'PENDING',
        components: [{ type: 'BODY', text: CUERPO_FULLTECH }],
      },
    ];
    try {
      const sync = await json(await call('/api/admin/wa-templates/sync', { method: 'POST', body: '{}' }));
      expect(sync.ok).toBe(true);
      const plantilla = (await listaPlantillas()).templates.find((row) => row.name === 'phyto_aviso_fulltech_v1');
      expect(plantilla.meta_template_id).toBe('900000000000001');
      expect(plantilla.friendly_name).toBe('Aviso de Fulltech (campañas)');
      expect(plantilla.variables).toEqual(['customer_name', 'mensaje']);
      expect(plantilla.body).toBe(CUERPO_FULLTECH);
      // Sigue SIN aprobar: la aprobación la decide Meta, no la sincronización.
      // (Meta la reporta como «PENDING»; el CRM la enseña como pendiente.)
      expect(plantilla.sendable).toBe(false);
      expect(String(plantilla.status).toUpperCase()).not.toBe('APPROVED');
    } finally {
      mockWhatsApp.metaTemplates = [];
    }
  });
});
