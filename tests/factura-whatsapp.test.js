// @vitest-environment node
/**
 * ENVIAR LA FACTURA POR WHATSAPP (documento nativo, sin salir del CRM).
 *
 * Lo que se protege aquí:
 *   - el PDF sale como DOCUMENTO NATIVO de WhatsApp con su nombre de archivo,
 *     no como enlace ni abriendo WhatsApp Web / la app / el menú del sistema;
 *   - a quién se le envía lo decide el SERVIDOR mirando el PEDIDO: ni el cliente,
 *     ni la conversación, ni el destinatario salen nunca de lo que manda el panel;
 *   - dentro de la ventana de 24 h: texto corto + documento;
 *   - fuera de la ventana: SOLO la plantilla aprobada con cabecera de documento, y
 *     si no está aprobada se dice claro y no se envía nada (nunca se finge);
 *   - doble clic o reintento no duplican nada;
 *   - el documento queda en el hilo como evidencia.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'clave-factura-123';
const APP_SECRET = 'app-secreto-factura';

const PHONES = { ana: '18095552001', luis: '18095552002' };
const NOMBRES = { [PHONES.ana]: 'Ana Factura', [PHONES.luis]: 'Luis Ajeno' };

let tmpDir;
let app;
let cookie = '';
const ids = {};

/** R2 de mentira: guarda en memoria, sin red y sin credenciales. */
const storage = {
  enabled: true,
  provider: 's3',
  bucket: 'uat-facturas',
  objects: new Map(),
  async put(key, buffer) {
    storage.objects.set(key, Buffer.from(buffer));
    return { ok: true, objectKey: key, size: buffer.length };
  },
  async get(key) {
    const found = storage.objects.get(key);
    return found ? { ok: true, buffer: found } : { ok: false, error: 'not_found' };
  },
};

/** Graph de mentira: anota TODO lo que se intenta enviar. */
const graph = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-FACTURA',
  businessAccountId: 'WABA1',
  sent: [],
  documents: [],
  uploads: [],
  templateList: [],
  failSend: null,
  failUpload: null,
  /*
   * Los `wamid` de WhatsApp son ÚNICOS en todo el mundo. El contador NO se
   * reinicia al limpiar las listas: repetir un `wamid` haría que el índice único
   * de mensajes rechazara el registro (y el hilo se quedaría sin evidencia).
   */
  secuencia: 0,
  async sendText(to, body) {
    graph.secuencia += 1;
    graph.sent.push({ kind: 'text', to, body });
    return { ok: true, status: 200, messageId: `wamid.TXT${graph.secuencia}` };
  },
  async sendTemplate(to, template) {
    graph.secuencia += 1;
    graph.sent.push({ kind: 'template', to, template });
    return { ok: true, status: 200, messageId: `wamid.TPL${graph.secuencia}` };
  },
  async uploadMedia(input) {
    if (graph.failUpload) return { ok: false, status: 400, error: graph.failUpload };
    graph.uploads.push({ mimeType: input.mimeType, filename: input.filename, bytes: input.buffer.length });
    return { ok: true, status: 200, mediaId: `mid_${graph.uploads.length}` };
  },
  /*
   * El cliente de ARCHIVOS (`whatsapp-media.mjs`) devuelve `waMessageId`
   * (así lo lee el pipeline y así lo devuelve el cliente real); el cliente de
   * texto/plantillas devuelve `messageId`. Se respeta cada forma.
   */
  async sendDocument(to, input) {
    if (graph.failSend) return { ok: false, status: 400, error: graph.failSend };
    graph.secuencia += 1;
    graph.documents.push({ to, ...input });
    return { ok: true, status: 200, waMessageId: `wamid.DOC${graph.secuencia}` };
  },
  async sendImage() {
    return { ok: true, status: 200, waMessageId: 'wamid.IMG1' };
  },
  async sendAudio() {
    return { ok: true, status: 200, waMessageId: 'wamid.AUD1' };
  },
  async listTemplates() {
    return { ok: true, status: 200, templates: graph.templateList };
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

async function inbound(id, phone, body) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: NOMBRES[phone] }, wa_id: phone }],
              messages: [{ from: phone, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  await fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
    },
    body: raw,
  });
}

/** Deja la conversación fuera de la ventana de 24 h. */
const cerrarVentana = (conversationId) =>
  app.collections.update('conversations', conversationId, {
    last_inbound_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
  });

async function crearPedido(slot, { quantity = 2, status = 'nuevo' } = {}) {
  const response = await call('/api/admin/orders', {
    method: 'POST',
    body: JSON.stringify({
      customerId: ids[`${slot}Customer`],
      conversationId: ids[slot],
      items: [{ variantId: 'capsules_10', quantity, unitPrice: 2500 }],
      paymentMethod: 'CASH',
      status,
    }),
  });
  const body = await json(response);
  if (response.status !== 201) throw new Error(`no se pudo crear el pedido: ${JSON.stringify(body)}`);
  return body;
}

const enviarFactura = (orderId, extra = {}) =>
  call(`/api/admin/orders/${encodeURIComponent(orderId)}/invoice-whatsapp`, {
    method: 'POST',
    body: JSON.stringify(extra),
  });

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-factura-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsappPhoneNumber: '+18095550000',
    whatsapp: graph,
    whatsappMedia: graph,
    storage,
    schedulerEnabled: false,
  });
  const login = await call('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  await inbound('wamid.FACT-1', PHONES.ana, 'Hola, quiero mi factura');
  await inbound('wamid.FACT-2', PHONES.luis, 'Hola');

  const data = await json(await call('/api/admin/conversations'));
  for (const conversation of data.conversations ?? []) {
    const phone = String(conversation.customer?.phone_e164 ?? '').replace(/\D/g, '');
    const slot = Object.entries(PHONES).find(([, value]) => value === phone)?.[0];
    if (slot) {
      ids[slot] = conversation.id;
      ids[`${slot}Customer`] = conversation.customer_id;
    }
  }
  if (!ids.ana || !ids.luis) throw new Error('no se pudieron mapear las conversaciones');

  // Las plantillas existen (las siembra el CRM al consultarlas).
  await call('/api/admin/wa-templates');

  ids.pedidoAna = (await crearPedido('ana')).item.id;
  ids.pedidoLuis = (await crearPedido('luis')).item.id;
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('la plantilla vive en el CRM sin fingir aprobación', () => {
  it('nace pendiente, no enviable y con cabecera de documento declarada', async () => {
    const data = await json(await call('/api/admin/wa-templates'));
    const plantilla = data.templates.find((row) => row.name === 'phyto_envio_factura_v1');
    expect(plantilla).toBeTruthy();
    expect(plantilla.category).toBe('UTILITY');
    expect(plantilla.language).toBe('es');
    expect(plantilla.body).toBe('Hola {{1}}, te compartimos la factura correspondiente a tu pedido {{2}}.');
    expect(plantilla.variables).toEqual(['customer_name', 'order_number']);
    expect(plantilla.header).toMatchObject({ format: 'DOCUMENT' });
    expect(plantilla.status).toBe('pending_approval');
    expect(plantilla.sendable).toBe(false);
    expect(plantilla.meta_template_id).toBeNull();
  });
});

describe('la factura en PDF', () => {
  it('es la MISMA que sirve el CRM: misma factura, sin duplicar documentos', async () => {
    const response = await call(`/api/admin/orders/${ids.pedidoAna}/factura`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    const pdf = Buffer.from(await response.arrayBuffer());
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(500);
  });

  it('representa el pedido ACTUAL (se genera bajo demanda, nunca se queda vieja)', async () => {
    const antes = await json(await call(`/api/admin/orders/${ids.pedidoAna}`));
    const totalAntes = antes.receipt.total;
    // Se le añade un frasco al pedido y la factura cambia con él.
    await call(`/api/admin/orders/${ids.pedidoAna}`, {
      method: 'PATCH',
      body: JSON.stringify({ items: [{ variantId: 'capsules_10', quantity: 3, unitPrice: 2500 }] }),
    });
    const despues = await json(await call(`/api/admin/orders/${ids.pedidoAna}`));
    expect(despues.receipt.total).not.toBe(antes.receipt.total);
    expect(despues.receipt.total).toBeGreaterThan(totalAntes);
    // Se deja como estaba para el resto de la suite.
    await call(`/api/admin/orders/${ids.pedidoAna}`, {
      method: 'PATCH',
      body: JSON.stringify({ items: [{ variantId: 'capsules_10', quantity: 2, unitPrice: 2500 }] }),
    });
  });
});

describe('enviar la factura dentro de la ventana de 24 h', () => {
  it('manda un texto corto y DESPUÉS el PDF como documento nativo', async () => {
    graph.sent.length = 0;
    graph.documents.length = 0;
    graph.uploads.length = 0;
    const response = await enviarFactura(ids.pedidoAna, { idempotencyKey: 'inv:uan:' + Date.now() });
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.ok).toBe(true);
    expect(body.outsideWindow).toBe(false);

    // 1) El texto, con el nombre real.
    expect(graph.sent).toHaveLength(1);
    expect(graph.sent[0]).toMatchObject({ kind: 'text', to: `+${PHONES.ana}` });
    expect(graph.sent[0].body).toBe('Hola Ana Factura, te compartimos la factura de tu pedido.');

    // 2) El PDF, como DOCUMENTO nativo (no un enlace).
    expect(graph.documents).toHaveLength(1);
    expect(graph.documents[0].to).toBe(`+${PHONES.ana}`);
    expect(graph.documents[0].mediaId).toBeTruthy();
    expect(graph.documents[0].filename).toBe(`Factura-${body.order_number}.pdf`);
    // Se subió a Meta como PDF de verdad.
    expect(graph.uploads[0]).toMatchObject({ mimeType: 'application/pdf' });
    expect(graph.uploads[0].bytes).toBeGreaterThan(500);
  });

  it('el archivo se guarda (R2) y el documento queda EN EL HILO como evidencia', async () => {
    const thread = await json(await call(`/api/admin/conversations/${ids.ana}/messages`));
    const documento = thread.messages.find((message) => message.type === 'document');
    expect(documento).toBeTruthy();
    expect(documento.direction).toBe('outbound');
    expect(documento.body).toBe(`Factura-PE-${ids.pedidoAna.slice(-6).toUpperCase()}.pdf`);
    expect(documento.wa_message_id).toBeTruthy();
    // Con su archivo: el hilo puede abrirlo (y se guardó en el almacén).
    expect(documento.media?.id).toBeTruthy();
    expect(storage.objects.size).toBeGreaterThan(0);
    // Y con el pedido relacionado en sus metadatos.
    expect(documento.provider?.order_id).toBe(ids.pedidoAna);
    expect(documento.provider?.invoice_filename).toBe(documento.body);
  });

  it('el PDF guardado es el mismo documento (no un archivo vacío ni otra cosa)', async () => {
    const thread = await json(await call(`/api/admin/conversations/${ids.ana}/messages`));
    const documento = thread.messages.find((message) => message.type === 'document');
    const respuesta = await call(`/api/admin/media/${documento.media.id}`);
    expect(respuesta.status).toBe(200);
    const pdf = Buffer.from(await respuesta.arrayBuffer());
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('NO abre WhatsApp Web, ni la app, ni el menú del sistema: no devuelve ningún enlace', async () => {
    const response = await enviarFactura(ids.pedidoAna, { idempotencyKey: 'inv:sin-enlace:' + Date.now() });
    const texto = await response.text();
    expect(texto).not.toMatch(/wa\.me|whatsapp\.com|api\.whatsapp/i);
    expect(texto).not.toMatch(/https?:\/\//);
  });
});

describe('doble clic y reintentos', () => {
  it('dos peticiones con la MISMA clave envían una sola factura', async () => {
    graph.sent.length = 0;
    graph.documents.length = 0;
    const clave = 'inv:doble:' + Date.now();
    const primera = await enviarFactura(ids.pedidoAna, { idempotencyKey: clave });
    const segunda = await enviarFactura(ids.pedidoAna, { idempotencyKey: clave });
    expect(primera.status).toBe(201);
    expect(segunda.status).toBe(200);
    expect((await json(segunda)).duplicate).toBe(true);
    // Una sola vez, de verdad.
    expect(graph.sent).toHaveLength(1);
    expect(graph.documents).toHaveLength(1);
  });

  it('doble clic SIMULTÁNEO (sin esperar la respuesta) tampoco duplica', async () => {
    graph.sent.length = 0;
    graph.documents.length = 0;
    const clave = 'inv:carrera:' + Date.now();
    const [a, b] = await Promise.all([
      enviarFactura(ids.pedidoAna, { idempotencyKey: clave }),
      enviarFactura(ids.pedidoAna, { idempotencyKey: clave }),
    ]);
    expect([200, 201]).toContain(a.status);
    expect([200, 201]).toContain(b.status);
    expect(graph.documents).toHaveLength(1);
  });
});

describe('seguridad: a quién se le envía lo decide el servidor', () => {
  it('la factura va SIEMPRE al cliente del pedido, aunque el panel diga otra cosa', async () => {
    graph.sent.length = 0;
    graph.documents.length = 0;
    const antesEnLaConversacionDeAna = (
      await json(await call(`/api/admin/conversations/${ids.ana}/messages`))
    ).messages.filter((message) => message.type === 'document').length;
    // Se intenta colar otro cliente, otra conversación y otro destinatario.
    const response = await enviarFactura(ids.pedidoLuis, {
      idempotencyKey: 'inv:cruce:' + Date.now(),
      customerId: ids.anaCustomer,
      conversationId: ids.ana,
      to: `+${PHONES.ana}`,
      phone: PHONES.ana,
    });
    expect(response.status).toBe(201);
    // El pedido es de Luis: sale para Luis y por SU conversación.
    expect(graph.documents[0].to).toBe(`+${PHONES.luis}`);
    expect(graph.sent[0].body).toBe('Hola Luis Ajeno, te compartimos la factura de tu pedido.');
    // Y en la conversación de Ana NO se añadió ninguna factura.
    const despuesEnLaConversacionDeAna = (
      await json(await call(`/api/admin/conversations/${ids.ana}/messages`))
    ).messages.filter((message) => message.type === 'document').length;
    expect(despuesEnLaConversacionDeAna).toBe(antesEnLaConversacionDeAna);
  });

  it('un pedido SIN cliente no envía nada', async () => {
    // Un pedido puede quedarse sin cliente válido (cliente borrado o dato
    // corrupto). Se apunta a un cliente que no existe: el servidor no adivina.
    const suelto = await crearPedido('ana');
    // OJO: `store.update` usa claves camelCase (`customerId`), no columnas.
    await app.store.update(suelto.item.id, { customerId: 'cus_que_no_existe' });
    graph.documents.length = 0;
    const response = await enviarFactura(suelto.item.id);
    expect(response.status).toBe(409);
    expect((await json(response)).error).toBe('order_without_customer');
    expect(graph.documents).toHaveLength(0);
  });

  it('si la conversación del pedido es de OTRO cliente, no se usa (se busca la suya)', async () => {
    // Se le cuelga al pedido de Luis la conversación de Ana (dato corrupto).
    await app.store.update(ids.pedidoLuis, { conversationId: ids.ana });
    graph.sent.length = 0;
    graph.documents.length = 0;
    const response = await enviarFactura(ids.pedidoLuis, { idempotencyKey: 'inv:corrupto:' + Date.now() });
    expect(response.status).toBe(201);
    expect(graph.documents[0].to).toBe(`+${PHONES.luis}`);
    // Y quedó registrado en el hilo de LUIS, no en el de Ana.
    const hiloLuis = await json(await call(`/api/admin/conversations/${ids.luis}/messages`));
    expect(hiloLuis.messages.some((message) => message.type === 'document')).toBe(true);
    await app.store.update(ids.pedidoLuis, { conversationId: ids.luis });
  });

  it('un pedido que no existe no envía nada', async () => {
    graph.documents.length = 0;
    const response = await enviarFactura('pedido_inventado');
    expect(response.status).toBe(404);
    expect(graph.documents).toHaveLength(0);
  });

  it('a quien pidió no recibir mensajes no se le manda la factura', async () => {
    await call(`/api/admin/customers/${ids.anaCustomer}/opt-out`, { method: 'POST', body: '{}' });
    graph.documents.length = 0;
    const response = await enviarFactura(ids.pedidoAna);
    expect(response.status).toBe(409);
    expect((await json(response)).error).toBe('do_not_contact');
    expect(graph.documents).toHaveLength(0);
    await call(`/api/admin/customers/${ids.anaCustomer}/opt-in`, { method: 'POST', body: '{}' });
  });
});

describe('fuera de la ventana de 24 h', () => {
  it('sin la plantilla aprobada: NO se envía nada y se explica qué falta', async () => {
    await cerrarVentana(ids.ana);
    graph.sent.length = 0;
    graph.documents.length = 0;
    const response = await enviarFactura(ids.pedidoAna);
    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.error).toBe('template_not_approved');
    expect(body.outsideWindow).toBe(true);
    expect(body.message).toMatch(/ventana de 24 h/i);
    expect(body.message).toMatch(/no está aprobada en Meta/i);
    expect(body.message).toMatch(/phyto_envio_factura_v1/);
    // Ni texto libre ni documento suelto: Meta no lo permite y no se intenta.
    expect(graph.sent).toHaveLength(0);
    expect(graph.documents).toHaveLength(0);
  });

  it('con una plantilla aprobada SIN cabecera de documento tampoco (no se adivina)', async () => {
    /*
     * En Meta está aprobada pero SIN cabecera. El CRM refleja lo que dice Meta al
     * sincronizar y entonces se niega a usarla para transportar el PDF: darla por
     * buena sería el error 132012 de WhatsApp.
     */
    graph.templateList = [
      {
        id: 'tpl-factura-uat',
        name: 'phyto_envio_factura_v1',
        language: 'es',
        category: 'UTILITY',
        status: 'APPROVED',
        components: [{ type: 'BODY', text: 'Hola {{1}}, te compartimos la factura correspondiente a tu pedido {{2}}.' }],
      },
    ];
    const sincronizado = await call('/api/admin/wa-templates/sync', { method: 'POST', body: '{}' });
    expect(sincronizado.status).toBe(200);
    const sincronizada = (await json(await call('/api/admin/wa-templates'))).templates.find(
      (row) => row.name === 'phyto_envio_factura_v1',
    );
    expect(sincronizada.sendable).toBe(true);
    expect(sincronizada.header).toBeNull();

    graph.documents.length = 0;
    const response = await enviarFactura(ids.pedidoAna);
    expect(response.status).toBe(409);
    expect((await json(response)).error).toBe('template_without_document_header');
    expect(graph.documents).toHaveLength(0);
  });

  it('aprobada CON cabecera de documento: el PDF viaja en la cabecera de la plantilla', async () => {
    await call('/api/admin/wa-templates', {
      method: 'POST',
      body: JSON.stringify({
        name: 'phyto_envio_factura_v1',
        status: 'APPROVED',
        header: { format: 'DOCUMENT' },
      }),
    });
    graph.sent.length = 0;
    graph.uploads.length = 0;
    const response = await enviarFactura(ids.pedidoAna, { idempotencyKey: 'inv:fuera:' + Date.now() });
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.outsideWindow).toBe(true);
    expect(body.template).toBe('phyto_envio_factura_v1');

    // El PDF SÍ se subió a Meta…
    expect(graph.uploads).toHaveLength(1);
    expect(graph.uploads[0].mimeType).toBe('application/pdf');
    // …y viaja como cabecera de la plantilla, con su nombre de archivo.
    expect(graph.sent).toHaveLength(1);
    const template = graph.sent[0].template;
    expect(template.name).toBe('phyto_envio_factura_v1');
    expect(template.components[0]).toEqual({
      type: 'header',
      parameters: [
        { type: 'document', document: { id: 'mid_1', filename: `Factura-${body.order_number}.pdf` } },
      ],
    });
    // Y el cuerpo, con el nombre y el número de pedido.
    expect(template.components[1]).toEqual({
      type: 'body',
      parameters: [
        { type: 'text', text: 'Ana Factura' },
        { type: 'text', text: body.order_number },
      ],
    });
    // Nada de texto libre fuera de la ventana.
    expect(graph.sent.filter((row) => row.kind === 'text')).toHaveLength(0);
    await app.collections.update('conversations', ids.ana, { last_inbound_at: new Date().toISOString() });
  });
});

describe('cuando Meta rechaza', () => {
  it('dice qué pasó en palabras, lo deja registrado y NO duplica al reintentar', async () => {
    graph.failSend = { code: 131053, message: 'Media upload error' };
    const clave = 'inv:fallo:' + Date.now();
    graph.sent.length = 0;
    graph.documents.length = 0;
    const response = await enviarFactura(ids.pedidoAna, { idempotencyKey: clave });
    expect([422, 502]).toContain(response.status);
    const body = await json(response);
    expect(body.message).toMatch(/No se pudo enviar la factura/i);
    expect(body.message).not.toMatch(/131053|Media upload error/);

    // El texto salió (una vez) y el documento NO.
    expect(graph.sent).toHaveLength(1);
    expect(graph.documents).toHaveLength(0);

    // Al reintentar, el texto NO se repite: solo se intenta el documento.
    graph.failSend = null;
    const reintento = await enviarFactura(ids.pedidoAna, { idempotencyKey: clave });
    expect(reintento.status).toBe(201);
    expect(graph.sent).toHaveLength(1);
    expect(graph.documents).toHaveLength(1);
  }, 20000);
});

describe('no se toca nada más', () => {
  it('enviar la factura no cambia el pedido, ni delivery, ni ubicaciones, ni programados', async () => {
    const antes = await json(await call('/api/admin/data'));
    const contar = (data) => ({
      pedidos: (data.items ?? []).filter((item) => item.type === 'order_intent').length,
      estados: (data.items ?? []).filter((item) => item.type === 'order_intent').map((item) => item.status).join(','),
      deliveries: (data.deliveryTracking ?? []).length,
      ubicaciones: (data.locations ?? []).length,
      programados: (data.scheduled?.upcoming ?? []).length,
    });
    const antesContado = contar(antes);

    const response = await enviarFactura(ids.pedidoAna, { idempotencyKey: 'inv:no-toca:' + Date.now() });
    expect(response.status).toBe(201);

    const despues = await json(await call('/api/admin/data'));
    expect(contar(despues)).toEqual(antesContado);
  });
});
