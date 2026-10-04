// @vitest-environment node
/**
 * PLANTILLA PRINCIPAL REUTILIZABLE («Contacto personalizado»).
 *
 * Lo que se protege aquí:
 *   - el SALUDO se calcula con la hora LOCAL DEL NEGOCIO y sale concordado
 *     («Buenos días» / «Buenas tardes» / «Buenas noches»), nunca «Buenos tardes»;
 *   - la plantilla NO nace aprobada: hasta que Meta la apruebe no se envía;
 *   - el texto fijo no se toca: lo único variable son sus variables;
 *   - al cliente NO le viaja su propio número de teléfono dentro del texto;
 *   - el servidor VUELVE A COMPROBAR la conversación justo antes de enviar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { greetingForNow, startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'clave-plantilla-123';
const APP_SECRET = 'app-secreto-plantilla';
const PHONE = '18095558888';
const TZ = 'America/Santo_Domingo';

/** El cuerpo que TIENE que estar registrado en Meta, palabra por palabra. */
const CUERPO =
  '{{1}}, {{2}}.\n\nTe escribimos de Phytoemagry en relación con tu solicitud.\n\n{{3}}\n\nSi necesitas alguna información adicional, estamos disponibles para ayudarte.';

let tmpDir;
let app;
let cookie = '';
let conversationId = '';

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN123',
  businessAccountId: 'WABA1',
  read: [],
  sent: [],
  failWith: null,
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
    // Meta no conoce (todavía) la plantilla nueva: no puede aparecer aprobada.
    return { ok: true, templates: [] };
  },
  async markAsRead(messageId) {
    mockWhatsApp.read.push(messageId);
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
async function inbound(id, body, from = PHONE, name = 'Juan Pérez') {
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

/** Aprueba la plantilla como lo haría el negocio tras aprobarla en Meta. */
async function approveContactTemplate() {
  const response = await call('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({ name: 'phyto_contacto_personalizado_v1', status: 'APPROVED' }),
  });
  expect(response.status).toBe(200);
  return (await json(response)).template;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-tpl-contacto-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsappPhoneNumber: '+18095550000',
    whatsapp: mockWhatsApp,
  });
  const login = await call('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  await inbound('wamid.TPLC1', 'Hola, quiero información');
  const conversation = await waitFor(async () => {
    const data = await json(await call('/api/admin/conversations'));
    return data.conversations.find((row) => row.customer?.phone_e164 === `+${PHONE}`) ?? null;
  });
  conversationId = conversation.id;
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('el saludo sale de la hora local del negocio', () => {
  // Santo Domingo no cambia de hora (UTC-4 todo el año), así que cada instante
  // UTC tiene una hora local fija y la prueba es determinista.
  const enSantoDomingo = (utc) => greetingForNow(new Date(utc), TZ);

  it('dice «Buenos días» de 05:00 a 11:59', () => {
    expect(enSantoDomingo('2026-01-15T09:00:00Z')).toBe('Buenos días'); // 05:00
    expect(enSantoDomingo('2026-01-15T12:00:00Z')).toBe('Buenos días'); // 08:00
    expect(enSantoDomingo('2026-01-15T15:59:00Z')).toBe('Buenos días'); // 11:59
  });

  it('dice «Buenas tardes» de 12:00 a 18:59', () => {
    expect(enSantoDomingo('2026-01-15T16:00:00Z')).toBe('Buenas tardes'); // 12:00
    expect(enSantoDomingo('2026-01-15T22:59:00Z')).toBe('Buenas tardes'); // 18:59
  });

  it('dice «Buenas noches» de 19:00 a 04:59', () => {
    expect(enSantoDomingo('2026-01-15T23:00:00Z')).toBe('Buenas noches'); // 19:00
    expect(enSantoDomingo('2026-01-16T03:59:00Z')).toBe('Buenas noches'); // 23:59
    expect(enSantoDomingo('2026-01-15T08:59:00Z')).toBe('Buenas noches'); // 04:59
    expect(enSantoDomingo('2026-01-15T04:30:00Z')).toBe('Buenas noches'); // 00:30
  });

  it('la frase va completa y concordada: nunca «Buenos tardes» ni «Buenas días»', () => {
    // Se recorre el día entero, hora a hora, en la zona del negocio.
    for (let hora = 0; hora < 24; hora += 1) {
      const utc = new Date(Date.UTC(2026, 0, 15, hora + 4, 0, 0)); // hora local = `hora`
      const saludo = greetingForNow(utc, TZ);
      expect(['Buenos días', 'Buenas tardes', 'Buenas noches']).toContain(saludo);
      expect(saludo).not.toMatch(/Buenos tardes|Buenas días|Buenos noches|Buenas mañana/);
    }
  });

  it('usa la zona que se le pasa, no la del equipo', () => {
    // El mismo instante: en Tokio ya es de mañana, en Santo Domingo es de noche.
    const instante = new Date('2026-01-15T23:30:00Z');
    expect(greetingForNow(instante, 'Asia/Tokyo')).toBe('Buenos días');
    expect(greetingForNow(instante, TZ)).toBe('Buenas noches');
  });

  it('el servidor lo manda al panel para que el hueco venga puesto', async () => {
    const data = await json(await call('/api/admin/wa-templates'));
    const esperado = greetingForNow(new Date(), TZ);
    // Puede cruzar una franja entre las dos lecturas; se admite solo ese caso.
    expect(data.greeting).toBe(esperado);
  });
});

describe('la plantilla principal reutilizable', () => {
  it('está declarada con sus TRES variables y el cuerpo exacto', async () => {
    const data = await json(await call('/api/admin/wa-templates'));
    const plantilla = data.templates.find((row) => row.name === 'phyto_contacto_personalizado_v1');
    expect(plantilla).toBeTruthy();
    expect(plantilla.friendly_name).toBe('Contacto personalizado');
    expect(plantilla.language).toBe('es');
    expect(plantilla.category).toBe('MARKETING');
    expect(plantilla.body).toBe(CUERPO);
    expect(plantilla.variables).toEqual(['saludo', 'customer_name', 'mensaje']);
    // Tres marcadores en el cuerpo = tres parámetros, ni uno más.
    expect((plantilla.body.match(/\{\{\d+\}\}/g) ?? []).length).toBe(3);
  });

  it('NO nace aprobada: sin aprobarla en Meta no se puede enviar', async () => {
    const data = await json(await call('/api/admin/wa-templates'));
    const plantilla = data.templates.find((row) => row.name === 'phyto_contacto_personalizado_v1');
    expect(plantilla.status).toBe('pending_approval');
    expect(plantilla.sendable).toBe(false);
    expect(plantilla.meta_template_id).toBeNull();

    mockWhatsApp.sent.length = 0;
    const blocked = await call(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ template: 'phyto_contacto_personalizado_v1', templateValues: { 1: 'Buenas tardes', 2: 'Juan', 3: 'Hola' } }),
    });
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error).toBe('template_not_approved');
    expect(mockWhatsApp.sent).toHaveLength(0);
  });

  it('sincronizar con Meta no la aprueba por su cuenta', async () => {
    await call('/api/admin/wa-templates/sync', { method: 'POST', body: '{}' });
    const data = await json(await call('/api/admin/wa-templates'));
    const plantilla = data.templates.find((row) => row.name === 'phyto_contacto_personalizado_v1');
    expect(plantilla.status).toBe('pending_approval');
    expect(plantilla.sendable).toBe(false);
  });

  it('ya aprobada, rellena saludo + nombre real + lo que escribe el agente', async () => {
    await approveContactTemplate();
    const antes = json(await call('/api/admin/wa-templates'));
    const saludo = (await antes).greeting;

    mockWhatsApp.sent.length = 0;
    const response = await call(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        template: 'phyto_contacto_personalizado_v1',
        conversationId,
        templateValues: { 3: 'Queremos confirmar si todavía deseas recibir tu pedido mañana.' },
      }),
    });
    expect(response.status).toBe(200);
    const data = await json(response);
    expect(mockWhatsApp.sent.at(-1).template.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: saludo },
          { type: 'text', text: 'Juan Pérez' },
          { type: 'text', text: 'Queremos confirmar si todavía deseas recibir tu pedido mañana.' },
        ],
      },
    ]);
    /*
     * EL TEXTO FINAL, LETRA A LETRA: el saludo delante del nombre, el mensaje del
     * agente en su sitio y los saltos de línea del texto fijo INTACTOS.
     */
    expect(data.message.body).toBe(CUERPO.replace('{{1}}', saludo).replace('{{2}}', 'Juan Pérez').replace('{{3}}', 'Queremos confirmar si todavía deseas recibir tu pedido mañana.'));
  });

  it('el agente puede corregir el saludo y el nombre (lo escrito manda)', async () => {
    const response = await call(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        template: 'phyto_contacto_personalizado_v1',
        templateValues: { 1: 'Buenos días', 2: 'Juan', 3: 'Te escribimos por tu pedido.' },
      }),
    });
    expect(response.status).toBe(200);
    const data = await json(response);
    expect(mockWhatsApp.sent.at(-1).template.components[0].parameters.map((row) => row.text)).toEqual([
      'Buenos días',
      'Juan',
      'Te escribimos por tu pedido.',
    ]);
    expect(data.message.body).toBe(
      'Buenos días, Juan.\n\nTe escribimos de Phytoemagry en relación con tu solicitud.\n\nTe escribimos por tu pedido.\n\nSi necesitas alguna información adicional, estamos disponibles para ayudarte.',
    );
  });

  it('nunca le viaja al cliente su propio número de teléfono dentro del texto', async () => {
    mockWhatsApp.sent.length = 0;
    const response = await call(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ template: 'phyto_contacto_personalizado_v1', templateValues: { 3: '¿Seguimos con tu pedido?' } }),
    });
    expect(response.status).toBe(200);
    const data = await json(response);
    expect(data.message.body).not.toMatch(/809|1809|\+18095558888/);
    expect(data.message.body).not.toContain(mockWhatsApp.sent.at(-1).to.replace('+', ''));
    // El destinatario es el correcto: el número se usa para ENVIAR, no para
    // escribirlo dentro del mensaje.
    expect(mockWhatsApp.sent.at(-1).to).toBe(`+${PHONE}`);
  });

  it('aplana los saltos de línea que Meta no admite DENTRO de una variable', async () => {
    const response = await call(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        template: 'phyto_contacto_personalizado_v1',
        templateValues: { 3: 'Primera línea\n\nSegunda   línea' },
      }),
    });
    expect(response.status).toBe(200);
    const data = await json(response);
    expect(mockWhatsApp.sent.at(-1).template.components[0].parameters[2].text).toBe('Primera línea Segunda línea');
    // Pero los saltos del texto FIJO (los que puso el negocio en Meta) siguen ahí.
    expect(data.message.body.split('\n\n')).toHaveLength(4);
  });

  it('si falta el hueco libre, se dice qué falta en vez de mandar algo vacío', async () => {
    mockWhatsApp.sent.length = 0;
    const response = await call(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ template: 'phyto_contacto_personalizado_v1' }),
    });
    expect(response.status).toBe(422);
    const data = await json(response);
    expect(data.error).toBe('missing_template_data');
    expect(data.missing).toContain('mensaje');
    expect(mockWhatsApp.sent).toHaveLength(0);
  });
});

describe('el servidor revalida la conversación antes de enviar', () => {
  it('si el panel afirma otra conversación, se corta y no sale nada', async () => {
    mockWhatsApp.sent.length = 0;
    const response = await call(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Hola', conversationId: 'conv_de_otro_cliente' }),
    });
    expect(response.status).toBe(409);
    const data = await json(response);
    expect(data.error).toBe('conversation_mismatch');
    expect(mockWhatsApp.sent).toHaveLength(0);
  });

  it('con la conversación correcta, se envía', async () => {
    mockWhatsApp.sent.length = 0;
    const response = await call(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Hola, te escribo por aquí.', conversationId }),
    });
    expect(response.status).toBe(200);
    expect(mockWhatsApp.sent).toHaveLength(1);
  });

  it('quien pidió no recibir mensajes no recibe la plantilla', async () => {
    const customer = (await json(await call('/api/admin/conversations'))).conversations.find(
      (row) => row.customer?.phone_e164 === `+${PHONE}`,
    );
    await app.collections.update('customers', customer.customer_id, { do_not_contact: true });
    mockWhatsApp.sent.length = 0;
    const response = await call(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ template: 'phyto_contacto_personalizado_v1', templateValues: { 3: 'Hola' } }),
    });
    expect(response.status).toBe(409);
    expect((await json(response)).error).toBe('do_not_contact');
    expect(mockWhatsApp.sent).toHaveLength(0);
    await app.collections.update('customers', customer.customer_id, { do_not_contact: false });
  });
});
