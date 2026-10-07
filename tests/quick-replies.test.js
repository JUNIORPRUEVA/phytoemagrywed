// @vitest-environment node
/**
 * RESPUESTAS RÁPIDAS DEL CRM.
 *
 * Lo que se fija aquí es el comportamiento que el negocio pidió, y sobre todo la
 * regla que NO se puede romper:
 *
 *   ELEGIR UNA RESPUESTA RÁPIDA NO ENVÍA NADA.
 *
 * Se levanta el servidor de verdad (SQLite temporal, sin tocar producción) con un
 * cliente de WhatsApp FALSO que cuenta llamadas: así "no se llamó a Meta" es un
 * número comprobable y no una opinión.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'clave-respuestas-rapidas';
const APP_SECRET = 'app-secreto-respuestas';
const WABA = 'WABA-QR';
const PHONE = '18095557777';

let tmpDir;
let app;
let cookie = '';
let conversation = null;

/** Cliente de WhatsApp falso: cuenta TODO lo que saldría hacia Meta. */
const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-QR',
  businessAccountId: WABA,
  sent: [],
  read: [],
  async sendText(to, body, options) {
    mockWhatsApp.sent.push({ to, body, options });
    return { ok: true, status: 200, messageId: `wamid.QR${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    mockWhatsApp.sent.push({ to, template });
    return { ok: true, status: 200, messageId: `wamid.QT${mockWhatsApp.sent.length}` };
  },
  async sendInteractive() {
    return { ok: false, skipped: true };
  },
  async markAsRead(messageId) {
    mockWhatsApp.read.push(messageId);
    return { ok: true };
  },
};

/** Llamadas reales a Meta/Graph desde que arrancó el servidor. */
const graphCalls = () => mockWhatsApp.sent.length + mockWhatsApp.read.length;

const call = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers ?? {}) },
  });

const json = async (response) => JSON.parse(await response.text());

const qr = {
  list: async () => json(await call('/api/admin/messages')),
  create: async (payload) => call('/api/admin/messages', { method: 'POST', body: JSON.stringify(payload) }),
  remove: async (id) => call(`/api/admin/messages/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  audit: async () => json(await call('/api/admin/audit')),
  data: async () => json(await call('/api/admin/data')),
};

async function waitFor(check, timeout = 4000) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      /* todavía no está */
    }
    if (Date.now() - start > timeout) throw new Error('timeout: el CRM no terminó el trabajo');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Mensaje entrante firmado como los que manda Meta (crea cliente y conversación). */
async function inbound(waId, from, body, name = 'Cliente') {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name }, wa_id: from }],
              messages: [{ from, id: waId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  return fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
    },
    body: raw,
  });
}

const threadOf = async (id) => json(await call(`/api/admin/conversations/${id}/messages`));

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-qr-'));
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
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('las respuestas rápidas se guardan de verdad', () => {
  it('trae respuestas base de precios, grupos y cuentas listas para usar', async () => {
    const listado = await qr.list();
    const byId = new Map(listado.messages.map((row) => [row.id, row]));

    expect(byId.get('msg-precios-phyto')?.body).toContain('5 cápsulas: RD$1,250');
    expect(byId.get('msg-precios-phyto')?.body).toContain('60 cápsulas: RD$10,000');
    expect(byId.get('msg-grupos-phyto')?.body).toContain('chat.whatsapp.com/Da9M4Zml4p3Kxc3lME8JqC');
    expect(byId.get('msg-bienvenida-phyto')?.body).toContain('1 cápsula al día después del desayuno');
    expect(byId.get('msg-cuentas-banco')?.body).toContain('Popular: 0841088008 - FULLTECH SRL');
    expect(byId.get('msg-cuentas-banco')?.body).toContain('BHD: 28726660019 - Yunior Lopez de la Rosa');
    expect(byId.get('msg-cuentas-banco')?.body).toContain('Banreservas: 9600921403 - Yunior Lopez de la Rosa');
    expect(byId.get('msg-cuentas-banco')?.body).not.toMatch(/C[eé]dula|40238377333/i);
  });

  it('se crean, se listan y sobreviven a volver a entrar', async () => {
    const creada = await qr.create({ name: 'Modo de uso', body: 'Tomar 1 cápsula al día después del desayuno.' });
    expect(creada.status).toBe(200);
    const cuerpo = await json(creada);
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.messages.some((row) => row.name === 'Modo de uso')).toBe(true);

    // Persistencia real: no vive en el navegador, vive en el almacén del CRM.
    const listado = await qr.list();
    const guardada = listado.messages.find((row) => row.name === 'Modo de uso');
    expect(guardada).toMatchObject({ name: 'Modo de uso', body: 'Tomar 1 cápsula al día después del desayuno.' });
    expect(guardada.id).toBeTruthy();
    // Y el panel la recibe en su carga normal, sin pedir nada extra.
    const datos = await qr.data();
    expect(datos.messages.some((row) => row.id === guardada.id)).toBe(true);
  });

  it('el nombre y el texto se validan en el SERVIDOR (no solo en la pantalla)', async () => {
    expect((await qr.create({ body: 'Sin nombre' })).status).toBe(422);
    expect((await qr.create({ name: 'Sin texto' })).status).toBe(422);
    expect((await qr.create({ name: '   ', body: '   ' })).status).toBe(422);
    expect((await qr.create({})).status).toBe(422);
  });

  it('se editan sin crear una segunda respuesta', async () => {
    const creada = await json(await qr.create({ name: 'Precio', body: 'Tenemos presentaciones desde RD$1,250.' }));
    const id = creada.message.id;
    const antes = (await qr.list()).messages.length;

    const editada = await qr.create({ id, name: 'Precio y presentación', body: 'Tenemos presentaciones desde RD$1,250.' });
    expect(editada.status).toBe(200);
    const despues = await qr.list();

    expect(despues.messages).toHaveLength(antes);
    expect(despues.messages.filter((row) => row.id === id)).toHaveLength(1);
    expect(despues.messages.find((row) => row.id === id).name).toBe('Precio y presentación');
  });

  it('se borran y desaparecen de la lista', async () => {
    const creada = await json(await qr.create({ name: 'Temporal', body: 'Esta se borra.' }));
    expect((await qr.remove(creada.message.id)).status).toBe(200);
    const listado = await qr.list();
    expect(listado.messages.some((row) => row.id === creada.message.id)).toBe(false);
    // Borrar algo que ya no está no rompe nada.
    expect((await qr.remove('no-existe')).status).toBe(200);
  });

  it('las nuevas van AL FINAL: el orden es estable y predecible', async () => {
    const listado = await qr.list();
    const posiciones = listado.messages.map((row) => Number(row.position) || 0);
    expect(posiciones).toEqual([...posiciones].sort((a, b) => a - b));
    // Y ninguna se repite: nada de órdenes que bailan solos.
    expect(new Set(posiciones).size).toBe(posiciones.length);
  });

  it('el texto largo se guarda entero, y una respuesta enorme se corta en vez de romper', async () => {
    const largo = 'x'.repeat(5000);
    const creada = await json(await qr.create({ name: 'Larga', body: largo }));
    expect(creada.message.body.length).toBeLessThan(largo.length);
    expect(creada.message.body.length).toBeGreaterThan(1000);
  });
});

describe('una respuesta rápida NO es una plantilla de Meta', () => {
  it('crear, editar y borrar respuestas NO llama a Meta ni una vez', async () => {
    const antes = graphCalls();
    const creada = await json(await qr.create({ name: 'Sin Meta', body: 'Esto no sale del CRM.' }));
    await qr.create({ id: creada.message.id, name: 'Sin Meta 2', body: 'Esto tampoco.' });
    await qr.remove(creada.message.id);
    // EL TEST CRÍTICO: preparar texto es una operación LOCAL.
    expect(graphCalls()).toBe(antes);
  });

  it('insertar una respuesta en el compositor tampoco llama a nada (ni a Graph ni al API)', async () => {
    // La inserción no tiene endpoint: es el navegador escribiendo en el campo. Se
    // comprueba sobre el fuente que insertar NO envía ni pide nada.
    const app = readFileSync(path.join(process.cwd(), 'public', 'admin', 'app.js'), 'utf8');
    const desde = app.indexOf('function insertQuickReply');
    expect(desde).toBeGreaterThan(0);
    const cuerpo = app.slice(desde, app.indexOf('\n  /**', desde + 10));
    expect(cuerpo).toContain('area.value');
    expect(cuerpo).not.toContain('api(');
    expect(cuerpo).not.toContain('fetch(');
    expect(cuerpo).not.toContain('sendWaMessage');
    expect(cuerpo).not.toContain("method: 'POST'");
    // Y el texto entra en el compositor, con el cursor puesto, sin enviar.
    expect(cuerpo).toContain('focus()');
    expect(cuerpo).toContain('setSelectionRange');
  });

  it('las plantillas de Meta y las respuestas rápidas viven separadas', async () => {
    const app = readFileSync(path.join(process.cwd(), 'public', 'admin', 'app.js'), 'utf8');
    // Las plantillas aprobadas se leen de `/wa-templates`; las respuestas rápidas
    // se guardan en `/messages`. Nunca se mezclan.
    expect(app).toContain('/api/admin/wa-templates');
    expect(app).toContain("api('/api/admin/messages'");
    const desde = app.indexOf('function insertQuickReply');
    const cuerpo = app.slice(desde, app.indexOf('\n  /**', desde + 10));
    expect(cuerpo).not.toContain('template');
  });
});

describe('seguridad y reglas que siguen vigentes', () => {
  it('sin sesión no se lee ni se escribe ninguna respuesta', async () => {
    const sinSesion = (route, options = {}) =>
      fetch(`${app.url}${route}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
    expect((await sinSesion('/api/admin/messages')).status).toBe(401);
    expect((await sinSesion('/api/admin/messages', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await sinSesion('/api/admin/messages/lo-que-sea', { method: 'DELETE' })).status).toBe(401);
  });

  it('lo que se guarda es TEXTO: ni se ejecuta ni se interpreta HTML', async () => {
    const ataque = '<img src=x onerror=alert(1)>';
    const creada = await json(await qr.create({ name: ataque, body: `<script>alert('x')</script> Hola {nombre}` }));
    // El servidor guarda el texto tal cual (es texto del operador) y lo devuelve
    // como JSON: no genera HTML ni lo evalúa.
    expect(creada.message.name).toBe(ataque);
    expect(creada.message.body).toContain('<script>');
    // Quien lo pinta en pantalla es el panel, y ahí sí se escapa.
    const app = readFileSync(path.join(process.cwd(), 'public', 'admin', 'app.js'), 'utf8');
    const fila = app.slice(app.indexOf('function qrRowHtml'), app.indexOf('function renderQuickReplies'));
    expect(fila).toContain('escapeHtml(row.name');
    expect(fila).toContain('escapeHtml(qrPreview(row.body))');
    await qr.remove(creada.message.id);

    // El formulario también escapa lo que ya había guardado.
    const formulario = app.slice(app.indexOf('function openQuickReplyForm'), app.indexOf('function quickReplyDelete'));
    expect(formulario).toContain('escapeHtml(');
  });

  it('editar y borrar respuestas NO toca los mensajes ya enviados ni la conversación', async () => {
    expect((await inbound('wamid.QR-IN-1', PHONE, 'Hola, ¿cuánto cuesta?', 'Cliente QR')).status).toBe(200);
    conversation = await waitFor(async () => {
      const listado = json(await call('/api/admin/conversations'));
      return (await listado).conversations.find((row) => row.customer?.phone_e164 === `+${PHONE}`);
    });
    const antes = await threadOf(conversation.id);
    expect(antes.messages).toHaveLength(1);
    const graphAntes = graphCalls();

    // Se usa una respuesta para preparar el texto y se borra después: el mensaje
    // que ya salió no puede cambiar ni desaparecer.
    const creada = await json(await qr.create({ name: 'Respuesta usada', body: 'Hola {nombre}, ya te digo el precio.' }));
    await qr.create({ id: creada.message.id, name: 'Respuesta usada (editada)', body: 'Otro texto.' });
    await qr.remove(creada.message.id);

    const despues = await threadOf(conversation.id);
    expect(despues.messages.map((row) => row.body)).toEqual(['Hola, ¿cuánto cuesta?']);
    expect(despues.messages[0].id).toBe(antes.messages[0].id);
    // Nada de esto ha enviado ni ha leído nada en Meta.
    expect(graphCalls()).toBe(graphAntes);
  });

  it('la respuesta rápida no se salta la ventana de 24 h ni el opt-out', async () => {
    const app = readFileSync(path.join(process.cwd(), 'public', 'admin', 'app.js'), 'utf8');
    // Fuera de la ventana SÍ hay dónde escribir, pero enviar no manda texto libre:
    // lo escrito viaja al hueco libre de una plantilla aprobada y se revisa antes.
    expect(app).toContain('function waClosedComposerHtml');
    expect(app).toContain('openWaTemplateSheet();');
    expect(app).toContain('No se puede escribir en esta conversación');
    expect(app).toContain('La ventana de atención de 24 horas terminó.');
    expect(app).toContain('Este cliente pidió no recibir mensajes.');
    // Y el envío sigue saliendo del mismo sitio de siempre.
    expect(app).toContain("api(`/api/admin/conversations/${encodeURIComponent(conversationId)}/messages`");
  });

  it('el filtro busca en el nombre y en el texto', async () => {
    const app = readFileSync(path.join(process.cwd(), 'public', 'admin', 'app.js'), 'utf8');
    const desde = app.indexOf('function qrFiltered');
    const cuerpo = app.slice(desde, app.indexOf('function qrRowHtml'));
    expect(cuerpo).toContain("row.name ?? ''");
    expect(cuerpo).toContain("row.body ?? ''");
    expect(cuerpo).toContain('toLowerCase()');
  });
});

describe('la pantalla, tal como se sirve', () => {
  const app = readFileSync(path.join(process.cwd(), 'public', 'admin', 'app.js'), 'utf8');
  const css = readFileSync(path.join(process.cwd(), 'public', 'admin', 'admin.css'), 'utf8');

  it('se llega desde las acciones del chat, sin botón nuevo ni pantalla aparte', () => {
    expect(app).toContain('data-quick-replies="1"');
    expect(app).toContain('data-qr-new');
    expect(app).toContain('function openQuickReplies');
    // Es el MISMO contenedor de hoja que usa el resto del panel: no hay pantalla
    // nueva ni navegación fuera de la conversación.
    expect(app).toContain("'Respuestas rápidas'");
    expect(app).toContain('function insertQuickReply');
  });

  it('la lista es compacta y con el «+» pequeño en el encabezado', () => {
    // El «+» es un icono con etiqueta accesible, no un botón enorme de texto.
    expect(app).toContain('aria-label="Crear respuesta rápida"');
    expect(app).not.toContain('CREAR NUEVA RESPUESTA RÁPIDA');
    // Fila: título + una o dos líneas de vista previa.
    expect(css).toContain('.qr__name');
    expect(css).toContain('-webkit-line-clamp: 2');
    expect(css).toContain('.qr__more');
  });

  it('el vacío se explica y ofrece crearla', () => {
    expect(app).toContain('Aún no tienes respuestas rápidas.');
    expect(app).toContain('+ Crear la primera');
    // Y se distingue de "la búsqueda no encontró nada".
    expect(app).toContain('Ninguna respuesta coincide con la búsqueda.');
  });

  it('se ve bien en móvil y en escritorio (hoja abajo / panel compacto)', () => {
    // La misma hoja que el resto del panel: abajo en móvil y popover en escritorio.
    expect(app).toContain("{ variant: 'menu' }");
    expect(css).toContain('.qr__list');
    expect(css).toContain('.qr__form-actions');
    // Las filas no son tarjetas: son líneas separadas por un borde.
    const bloque = css.slice(css.indexOf('.qr__row {'), css.indexOf('.qr__pick {'));
    expect(bloque).toContain('border-bottom: 1px solid');
    expect(bloque).not.toContain('box-shadow');
  });

  it('accesibilidad mínima: etiquetas, estado del menú y ESC', () => {
    expect(app).toContain('aria-expanded=');
    expect(app).toContain('aria-label="Buscar respuestas"');
    expect(app).toContain('aria-label="Opciones de ');
    // El ESC que cierra la hoja ya existía en el panel y se sigue usando.
    expect(app).toContain("event.key === 'Escape'");
  });
});

describe('la lista del panel lateral y el chat usan los MISMOS datos', () => {
  it('guardar desde el chat refresca la pantalla de plantillas', () => {
    const app = readFileSync(path.join(process.cwd(), 'public', 'admin', 'app.js'), 'utf8');
    const form = app.slice(app.indexOf('function openQuickReplyForm'), app.indexOf('function quickReplyDelete'));
    // Una sola lista y un solo endpoint: lo que se crea en el chat aparece arriba.
    expect(form).toContain('state.messages = result.messages');
    expect(form).toContain('renderMensajes()');
  });

  it('el rastro administrativo queda registrado, sin guardar el texto de la respuesta', async () => {
    const creada = await json(await qr.create({ name: 'Con traza', body: 'Texto que NO debe salir en la traza.' }));
    await qr.create({ id: creada.message.id, name: 'Con traza (editada)', body: 'Tampoco.' });
    await qr.remove(creada.message.id);

    const auditoria = await qr.audit();
    const acciones = auditoria.entries.map((entry) => entry.action);
    expect(acciones).toContain('quick_reply_created');
    expect(acciones).toContain('quick_reply_updated');
    expect(acciones).toContain('quick_reply_deleted');

    const serializado = JSON.stringify(auditoria.entries);
    expect(serializado).toContain('Con traza');
    // El cuerpo del texto no se guarda en la traza.
    expect(serializado).not.toContain('NO debe salir en la traza');
  });
});
