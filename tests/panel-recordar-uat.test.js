// @vitest-environment node
/**
 * UAT DEL PANEL — LO QUE EL USUARIO ELIGE SE QUEDA ELEGIDO.
 *
 * Panel REAL (`public/admin/index.html` + `app.js`) contra un CRM de verdad, y
 * «abrir la app otra vez» = un navegador NUEVO con el mismo almacén guardado (y
 * también con el almacén vacío, que es el caso del icono instalado y del otro
 * teléfono). Se comprueban las tres quejas del negocio:
 *
 *   1. los FILTROS (bandeja, pedidos, seguimientos, clientes) y la PESTAÑA se
 *      quedan puestos al volver a entrar;
 *   2. los PERMISOS se piden UNA vez: lo concedido no se vuelve a pedir y «Ahora
 *      no» se respeta;
 *   3. lo que se BORRA de la campana no vuelve — ni en otro dispositivo, ni si el
 *      mismo suceso se procesa otra vez (el borrado se recuerda en el servidor,
 *      no solo en el teléfono);
 *   4. la lista de chats: un ARCHIVADO que escribe vuelve a la lista principal y
 *      de primero, y el BUSCADOR busca en todas (encuentra una archivada aunque
 *      el filtro puesto no la muestre).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

/*
 * La llave pública de push se pone ANTES de cargar el servidor: es lo que hace
 * que el panel ofrezca «Activar notificaciones». Se quita enseguida del entorno
 * para no dejarlo cambiado a los demás archivos de la batería (el servidor ya
 * leyó la suya al cargarse).
 */
process.env.PHYTO_WEB_PUSH_PUBLIC_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const { startCrmServer } = await import('../server/crm-server.mjs');
delete process.env.PHYTO_WEB_PUSH_PUBLIC_KEY;

const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const html = readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');
const appJs = readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8');

const ADMIN = { username: 'ana', password: 'UatLocal-123' };
/** El panel exige clave configurada en el servidor para poder entrar. */
const TOKEN = 'uat-recordar-123';
const APP_SECRET = 'uat-recordar-secret';
const PHONE = '18095557999';

/** WhatsApp de mentira: la bandeja se llena con webhooks firmados de verdad. */
const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT-RECORDAR',
  sent: [],
  async sendText() {
    return { ok: true, status: 200, messageId: `wamid.REC${mockWhatsApp.sent.push('texto')}` };
  },
  async sendTemplate() {
    return { ok: true, status: 200, messageId: `wamid.RECT${mockWhatsApp.sent.push('plantilla')}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

let tmpDir;
let app;
let adminUserId = '';
let montarPanel;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) {
      const detalle = typeof label === 'function' ? await label() : label;
      throw new Error(`timeout esperando: ${detalle}`);
    }
    await sleep(25);
  }
}

/**
 * Abre el panel como lo abriría una persona: un navegador nuevo, con lo que
 * hubiera guardado en el teléfono (`storage`) y entrando con su usuario.
 */
async function abrirPanel({ storage = {}, conCuenta = true } = {}) {
  const dom = new JSDOM(html, { url: `${app.url}/admin/`, runScripts: 'outside-only' });
  const win = dom.window;
  for (const [clave, valor] of Object.entries(storage)) {
    win.localStorage.setItem(clave, typeof valor === 'string' ? valor : JSON.stringify(valor));
  }
  let cookie = '';
  const peticiones = [];
  const t0 = Date.now();
  win.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, `${app.url}/admin/`).toString();
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    peticiones.push(`${init.method ?? 'GET'} ${url.replace(app.url, '')} → ${response.status} (+${Date.now() - t0}ms)`);
    return response;
  };
  win.scrollTo = () => {};
  win.confirm = () => true;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  /*
   * Un navegador con notificaciones: sin esto, el panel dice «no soportado» y el
   * aviso de permisos no llega a existir.
   */
  win.Notification = { permission: 'default', requestPermission: async () => 'default' };
  win.eval(`${appJs}\n//# sourceURL=app.js`);
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  await waitFor(() => !win.document.querySelector('#login').hidden || !win.document.querySelector('#app').hidden, 'la pantalla de acceso');

  if (conCuenta) {
    win.document.querySelector('#login-username').value = ADMIN.username;
    win.document.querySelector('#login-password').value = ADMIN.password;
    win.document.querySelector('#login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => !win.document.querySelector('#app').hidden, 'el panel abierto');
  }
  await waitFor(() => win.document.querySelector('#stats')?.textContent?.includes('Sin responder'), 'las tarjetas de HOY');

  const doc = win.document;
  return {
    dom,
    win,
    doc,
    $: (selector) => doc.querySelector(selector),
    $$: (selector) => [...doc.querySelectorAll(selector)],
    click: (target) => {
      const selector = typeof target === 'string' ? target : null;
      const element = selector ? doc.querySelector(selector) : target;
      /* Seguimientos y Mensajes ya no están en el menú (viven en el Centro IA):
         se abren por la navegación interna, igual que los enlaces antiguos. */
      const tab = selector?.match(/\[data-tab="([a-z-]+)"\]$/)?.[1] ?? null;
      if (!element && tab && ['seguimientos', 'mensajes'].includes(tab)) {
        win.dispatchEvent(new win.CustomEvent('fulltech:navigate', { detail: { tab } }));
        return doc.querySelector(`#view-${tab}`);
      }
      if (!element) throw new Error(`no existe el elemento para pulsar: ${target}`);
      element.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      return element;
    },
    guardado: (clave) => win.localStorage.getItem(clave),
    objeto: (clave) => JSON.parse(win.localStorage.getItem(clave) ?? 'null'),
    peticiones,
    t0,
    cerrar: () => win.close(),
  };
}

/** Un mensaje entrante de verdad (webhook firmado): crea cliente y conversación. */
async function inboundWhatsapp(id, body) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: 'Cliente Prueba' }, wa_id: PHONE }],
              messages: [{ from: PHONE, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  await fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
  await sleep(250);
}

/** Pide al CRM con una sesión de administración (para mirar la API de frente). */
let cookieApi = '';
async function apiAdmin(query) {
  if (!cookieApi) {
    const login = await fetch(`${app.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ADMIN),
    });
    cookieApi = login.headers.get('set-cookie').split(';')[0];
  }
  const response = await fetch(`${app.url}/api/admin/conversations?${query}`, { headers: { cookie: cookieApi } });
  return response.json();
}

const ABIERTO = (panel) => panel.$('#app') && !panel.$('#app').hidden;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-recordar-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    bootstrapAdminUser: ADMIN.username,
    bootstrapAdminPassword: ADMIN.password,
    metaAppSecret: APP_SECRET,
    whatsapp: mockWhatsApp,
    quiet: true,
    schedulerEnabled: false,
  });
  adminUserId = (await app.collections.findBy('crm_users', 'username', ADMIN.username))?.id ?? '';
  expect(adminUserId).toBeTruthy();
  montarPanel = abrirPanel;
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('los filtros y la pestaña se quedan puestos', () => {
  let prefs = null;

  it('el usuario pone sus filtros y la app los apunta', async () => {
    const panel = await abrirPanel();
    expect(ABIERTO(panel)).toBe(true);

    // Bandeja: Archivados (el caso que contó el negocio: al volver, se perdía).
    panel.click('.tab[data-tab="whatsapp"]');
    panel.click('#wa-filters [data-wa-filter="archivados"]');
    // Pedidos: pendientes.
    panel.click('.tab[data-tab="pedidos"]');
    panel.click('#pedidos-filtros [data-order-filter="pendiente"]');
    // Clientes: interesados.
    panel.click('.tab[data-tab="clientes"]');
    panel.click('#chips [data-filter="interesados"]');
    // Seguimientos: vencidos.
    panel.click('.drawer__item[data-tab="seguimientos"]');
    panel.click('#seguimientos-filtros [data-followup-filter="vencidos"]');
    // Y se queda mirando la bandeja: esa es la pestaña que debe recuperar.
    panel.click('.tab[data-tab="whatsapp"]');

    prefs = panel.objeto('pe_prefs');
    expect(prefs).toMatchObject({
      tab: 'whatsapp',
      waFilter: 'archivados',
      pedidosFilter: 'pendiente',
      followupsFilter: 'vencidos',
      clientFilter: 'interesados',
    });
    // Lo que se ESCRIBE en un buscador no se guarda: un texto viejo esconde datos.
    expect(prefs.waQ).toBeUndefined();
    expect(prefs.pedidosSearch).toBeUndefined();
    panel.cerrar();
  });

  it('al volver a abrir la app sigue puesto (pestaña, chips y título)', async () => {
    const panel = await abrirPanel({ storage: { pe_prefs: prefs } });

    // Abre donde estaba, no en HOY.
    expect(panel.doc.body.dataset.tab).toBe('whatsapp');
    expect(panel.$('#view-whatsapp').hidden).toBe(false);
    expect(panel.$('#view-hoy').hidden).toBe(true);
    // El filtro está puesto (y se ve: el título dice cuál).
    expect(panel.$('#wa-filters [data-wa-filter="archivados"]').getAttribute('aria-pressed')).toBe('true');
    expect(panel.$('#mobile-header').textContent).toContain('WhatsApp · Archivados');

    panel.click('.tab[data-tab="pedidos"]');
    expect(panel.$('#pedidos-filtros [data-order-filter="pendiente"]').getAttribute('aria-pressed')).toBe('true');
    expect(panel.$('#pedidos-estado-chip').textContent).toBe('Estado · Pendientes');

    panel.click('.tab[data-tab="clientes"]');
    expect(panel.$('#chips [data-filter="interesados"]').getAttribute('aria-pressed')).toBe('true');
    expect(panel.$('#mobile-header').textContent).toContain('Personas · Interesados');

    panel.click('.drawer__item[data-tab="seguimientos"]');
    expect(panel.$('#seguimientos-filtros [data-followup-filter="vencidos"]').getAttribute('aria-pressed')).toBe('true');
    panel.cerrar();
  });

  it('quitar el filtro también se recuerda (no se queda pegado para siempre)', async () => {
    const panel = await abrirPanel({ storage: { pe_prefs: prefs } });
    panel.click('.tab[data-tab="whatsapp"]');
    panel.click('#wa-filters [data-wa-filter="todos"]');
    const quitado = panel.objeto('pe_prefs');
    expect(quitado.waFilter).toBe('todos');
    panel.cerrar();

    const otra = await abrirPanel({ storage: { pe_prefs: quitado } });
    expect(otra.$('#wa-filters [data-wa-filter="todos"]').getAttribute('aria-pressed')).toBe('true');
    expect(otra.$('#mobile-header').textContent).not.toContain('WhatsApp · ');
    otra.cerrar();
  });

  it('un valor inválido guardado en el teléfono no rompe la lista', async () => {
    const panel = await abrirPanel({ storage: { pe_prefs: { tab: 'inventado', waFilter: 'lo-que-sea', pedidosFilter: 42 } } });
    expect(panel.doc.body.dataset.tab).toBe('hoy');
    expect(panel.$('#wa-filters [data-wa-filter="todos"]').getAttribute('aria-pressed')).toBe('true');
    expect(panel.$('#pedidos-estado-chip').textContent).toBe('Estado · Todo');
    panel.cerrar();
  });
});

describe('los permisos se piden una vez', () => {
  it('el aviso sale la primera vez', async () => {
    const panel = await abrirPanel();
    const aviso = panel.$('#permission-banner');
    expect(aviso.hidden).toBe(false);
    expect(aviso.textContent).toContain('Activar notificaciones');
    // Y se apunta que ya se ofreció (para no repetirlo en cada visita).
    expect(panel.objeto('pe_permisos').notifications.ofertado).toBeTruthy();
    panel.cerrar();
  });

  it('no vuelve a salir en la siguiente visita', async () => {
    const primera = await abrirPanel();
    const memoria = primera.objeto('pe_permisos');
    primera.cerrar();

    const segunda = await abrirPanel({ storage: { pe_permisos: memoria } });
    expect(segunda.$('#permission-banner').hidden).toBe(true);
    expect(segunda.$('#permission-banner').textContent).not.toContain('Activar notificaciones');
    segunda.cerrar();
  });

  it('«Ahora no» se respeta: ni en la visita siguiente ni tres visitas después', async () => {
    const primera = await abrirPanel();
    primera.click('[data-permission-dismiss="notifications"]');
    expect(primera.$('#permission-banner').hidden).toBe(true);
    const memoria = primera.objeto('pe_permisos');
    expect(memoria.notifications.descartado).toBeTruthy();
    primera.cerrar();

    let storage = { pe_permisos: memoria };
    for (let vuelta = 0; vuelta < 3; vuelta += 1) {
      const visita = await abrirPanel({ storage });
      expect(visita.$('#permission-banner').hidden).toBe(true);
      storage = { pe_permisos: visita.objeto('pe_permisos') };
      visita.cerrar();
    }
  });

  it('lo ya dicho no se repite, y si el estado cambia se cuenta una vez más', async () => {
    // Ya se le ofreció con ESTE estado (`bloqueado`: este navegador no puede
    // concederlo). No se le vuelve a decir.
    const repetido = await abrirPanel({
      storage: { pe_permisos: { notifications: { ofertado: '2026-01-01T00:00:00.000Z', estado: 'bloqueado' } } },
    });
    expect(repetido.$('#permission-banner').hidden).toBe(true);
    repetido.cerrar();

    // El estado CAMBIÓ (antes se podía pedir, ahora está bloqueado): se cuenta
    // una única vez más, y queda apuntado con el estado nuevo.
    const cambio = await abrirPanel({
      storage: { pe_permisos: { notifications: { ofertado: '2026-01-01T00:00:00.000Z', estado: 'prompt' } } },
    });
    expect(cambio.$('#permission-banner').textContent).toContain('Activar notificaciones');
    const memoria = cambio.objeto('pe_permisos');
    expect(memoria.notifications.estado).not.toBe('prompt');
    cambio.cerrar();

    const siguiente = await abrirPanel({ storage: { pe_permisos: memoria } });
    expect(siguiente.$('#permission-banner').hidden).toBe(true);
    siguiente.cerrar();
  });

  it('el GPS se ofrece a quien entrega, no a cualquiera que mire HOY', async () => {
    // Administración en HOY: nada de pedir ubicación.
    const admin = await abrirPanel();
    expect(admin.$('#permission-banner').textContent).not.toContain('Permitir ubicación');
    admin.cerrar();

    // En la pantalla de entregas sí (es donde se puede iniciar una entrega).
    const entregas = await abrirPanel();
    Object.defineProperty(entregas.win.navigator, 'geolocation', { value: { getCurrentPosition() {} }, configurable: true });
    entregas.click('.drawer__item[data-tab="delivery"]');
    await waitFor(() => entregas.$('#permission-banner').textContent.includes('Permitir ubicación'), 'el aviso de ubicación');
    const memoria = entregas.objeto('pe_permisos');
    expect(memoria.geolocation.ofertado).toBeTruthy();
    entregas.cerrar();

    // Y en la siguiente visita tampoco insiste.
    const otra = await abrirPanel({ storage: { pe_permisos: memoria } });
    Object.defineProperty(otra.win.navigator, 'geolocation', { value: { getCurrentPosition() {} }, configurable: true });
    otra.click('.drawer__item[data-tab="delivery"]');
    expect(otra.$('#permission-banner').textContent).not.toContain('Permitir ubicación');
    otra.cerrar();
  });
});

describe('lo que se borra de la campana no vuelve', () => {
  const crearAvisos = async (avisos) => {
    for (const [id, clave] of avisos) {
      await app.collections.insert('user_notifications', {
        id,
        recipient_user_id: adminUserId,
        type: 'WHATSAPP_MESSAGE_RECEIVED',
        title: `Nuevo mensaje · Cliente ${id}`,
        body: 'Hola, quiero información',
        entity_type: 'conversation',
        entity_id: 'conv-1',
        deep_link: '/admin/?v=whatsapp',
        data: null,
        status: 'unread',
        read_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        idempotency_key: clave,
      });
    }
  };
  const filasServidor = async () => app.collections.list('user_notifications');
  const enServidor = async () => (await filasServidor()).length;
  const idsEnServidor = async () => (await filasServidor()).map((row) => `${row.id}(${row.idempotency_key})`);
  /** El borrado hay que ESPERARLO: `enServidor` es asincrono. */
  const quedanEnServidor = async (cuantas) => (await enServidor()) === cuantas;
  const campana = (panel) => panel.$('.dashboard-head__badge')?.textContent ?? '';

  it('borrar un aviso lo quita del servidor, no solo de este teléfono', async () => {
    await crearAvisos([
      ['not_uat_a', 'uat-evento:a'],
      ['not_uat_b', 'uat-evento:b'],
    ]);
    const panel = await abrirPanel();
    expect(campana(panel)).toBe('2');

    panel.click('[data-dashboard-notifications]');
    const borrar = panel.$$('#sheet-body [data-notification-delete]');
    expect(borrar.length).toBe(2);
    const clicEn = Date.now() - panel.t0;
    // Se borra SIEMPRE la misma (por su id): el test siguiente vuelve a crear ESE
    // mismo suceso con otro id, y así no depende del orden de la lista.
    panel.click('#sheet-body [data-notification-delete="not_uat_a"]');
    await waitFor(() => campana(panel) === '1', 'la campana con un aviso menos');
    await waitFor(
      () => quedanEnServidor(1),
      async () => `el borrado en el servidor (clic en +${clicEn}ms · quedan: ${(await idsEnServidor()).join(', ')} · ${panel.peticiones.slice(-3).join(' | ')})`,
    );

    /*
     * EL CASO DE LA QUEJA: abrir la app en OTRO navegador (icono instalado, otro
     * móvil, o con los datos del sitio limpios). El almacén del teléfono no
     * lleva nada: lo que evita que vuelva es que el servidor ya no lo tiene.
     */
    const otro = await abrirPanel();
    expect(campana(otro)).toBe('1');
    otro.cerrar();
    panel.cerrar();
  });

  it('ni aunque el mismo suceso se procese otra vez (otra fila, otro id)', async () => {
    // El mismo suceso que el aviso borrado, con un id nuevo.
    await crearAvisos([['not_uat_c', 'uat-evento:a']]);
    expect(await enServidor()).toBe(2);
    const panel = await abrirPanel();
    // Sigue viéndose UNO: el suceso borrado no resucita.
    expect(campana(panel)).toBe('1');
    panel.cerrar();
  });

  it('«Eliminar todas» deja la campana limpia también en un dispositivo nuevo', async () => {
    const panel = await abrirPanel();
    expect(campana(panel)).not.toBe('');
    panel.click('[data-dashboard-notifications]');
    panel.click('[data-notifications-delete-all]');
    await waitFor(() => campana(panel) === '', 'la campana sin número');
    await waitFor(() => quedanEnServidor(0), async () => `la lista del servidor vacía (quedan: ${(await idsEnServidor()).join(', ')})`);

    const nuevo = await abrirPanel();
    expect(campana(nuevo)).toBe('');
    nuevo.click('[data-dashboard-notifications]');
    expect(nuevo.$('#sheet-body').textContent).toContain('No hay notificaciones');
    nuevo.cerrar();
    panel.cerrar();
  });
});

describe('una lista vacía por filtro recordado no es un callejón sin salida', () => {
  it('dice qué filtro está puesto y ofrece «Ver todas» en un toque', async () => {
    await inboundWhatsapp('wamid.RECORDAR.1', 'Hola, quiero información');

    // Como si el usuario hubiera dejado la bandeja en «Archivados»: la
    // conversación existe, pero el filtro la esconde y por eso la lista sale vacía.
    const panel = await abrirPanel({ storage: { pe_prefs: { tab: 'whatsapp', waFilter: 'archivados' } } });
    expect(panel.doc.body.dataset.tab).toBe('whatsapp');
    await waitFor(() => panel.$('#wa-conversations').textContent.includes('No hay conversaciones archivadas'), 'el aviso de lista vacía');
    expect(panel.$('#mobile-header').textContent).toContain('WhatsApp · Archivados');

    panel.click('[data-wa-filter-clear]');
    await waitFor(() => panel.$$('#wa-conversations [data-conv]').length === 1, 'la conversación a la vista');
    expect(panel.$('#mobile-header').textContent).not.toContain('Archivados');
    expect(panel.objeto('pe_prefs').waFilter).toBe('todos');
    panel.cerrar();
  });
});

describe('la lista de chats: archivados que escriben y buscador general', () => {
  /** Abre la bandeja con el filtro de «Todos» y devuelve la primera fila. */
  async function bandeja() {
    const panel = await abrirPanel({ storage: { pe_prefs: { tab: 'whatsapp', waFilter: 'todos' } } });
    await waitFor(() => panel.$$('#wa-conversations [data-conv]').length >= 1, 'una conversación en la bandeja');
    return panel;
  }

  /** Archiva esa conversación desde el menú «⋯» de su fila. */
  async function archivar(panel, id) {
    panel.click(`[data-conv-more="${id}"]`);
    panel.click('#sheet-body [data-conv-act="archive"]');
    await waitFor(() => !panel.$(`[data-conv="${id}"]`), 'la conversación archivada fuera de la lista');
  }

  it('un archivado que escribe vuelve a la lista principal, y de primero', async () => {
    await inboundWhatsapp('wamid.RECORDAR.ARCH1', 'Hola, quiero información');
    const panel = await bandeja();
    const id = panel.$$('#wa-conversations [data-conv]')[0].dataset.conv;

    await archivar(panel, id);
    // Archivada de verdad: sigue existiendo, pero en su lista.
    expect(panel.$(`[data-conv="${id}"]`)).toBeNull();

    /*
     * LA CLIENTA ESCRIBE. Tiene que volver a la pantalla principal y ARRIBA del
     * todo: es lo que hace que un chat archivado no se pierda cuando el cliente
     * responde (antes se quedaba archivado y parecía que nadie había escrito).
     */
    await inboundWhatsapp('wamid.RECORDAR.ARCH2', 'Volví por aquí, ¿me ayudan?');
    panel.win.dispatchEvent(new panel.win.Event('focus'));
    await waitFor(() => panel.$(`[data-conv="${id}"]`), 'la conversación de vuelta en la lista principal');

    const filas = panel.$$('#wa-conversations [data-conv]');
    expect(filas[0].dataset.conv).toBe(id);
    // Y ya no está archivada: no se dice «Archivado» ni hay que desarchivarla.
    expect(filas[0].textContent).not.toContain('Archivado');
    // El contador de sin leer la marca como nueva (acaba de escribir).
    expect(filas[0].querySelector('.conv__unread')).not.toBeNull();
    panel.cerrar();
  });

  it('el buscador busca en TODAS: encuentra una archivada aunque el filtro no la muestre', async () => {
    await inboundWhatsapp('wamid.RECORDAR.BUS1', 'Hola, soy Yahaira');
    const panel = await bandeja();
    const id = panel.$$('#wa-conversations [data-conv]')[0].dataset.conv;
    const nombre = panel.$(`[data-conv="${id}"] .conv__name`).textContent.trim();
    expect(nombre.length).toBeGreaterThan(2);

    await archivar(panel, id);
    // Un filtro que NO la incluye (y que además deja la lista sin ella): da igual,
    // buscar tiene que traerla.
    panel.click('#wa-filters [data-wa-filter="no-leidos"]');
    await waitFor(() => panel.$(`[data-conv="${id}"]`) === null, 'la archivada fuera con ese filtro');

    const buscar = (texto) => {
      const input = panel.$('#wa-search');
      input.value = texto;
      input.dispatchEvent(new panel.win.Event('input', { bubbles: true }));
    };
    buscar(nombre.slice(0, Math.min(6, nombre.length)));
    await waitFor(() => panel.$(`[data-conv="${id}"]`), 'la archivada encontrada por el buscador');
    // La fila avisa de que está archivada: se entiende por qué aparece.
    expect(panel.$(`[data-conv="${id}"]`).textContent).toContain('Archivado');

    /*
     * Y si no coincide nadie, el vacío habla de la BÚSQUEDA (no del filtro) y deja
     * quitarla de un toque: «no hay conversaciones con este filtro» delante de un
     * nombre escrito hace pensar que ese chat no existe.
     */
    buscar('zzzz-no-existe');
    await waitFor(() => panel.$('#wa-conversations').textContent.includes('Nadie coincide con'), 'el aviso de búsqueda sin resultados');
    panel.click('#wa-conversations [data-wa-search-clear]');
    await waitFor(() => panel.$('#wa-search').value === '', 'el buscador vacío');

    // Al quitar el texto, manda otra vez el filtro que estaba puesto: buscar no
    // cambia lo que el usuario había elegido.
    await waitFor(() => panel.$(`[data-conv="${id}"]`) === null, 'vuelve a mandar el filtro');
    expect(panel.$('#wa-filters [data-wa-filter="no-leidos"]').getAttribute('aria-pressed')).toBe('true');
    panel.cerrar();
  });

  it('el CRM tampoco esconde las archivadas cuando se busca (misma regla)', async () => {
    const todas = await apiAdmin('filter=archivados');
    const archivada = todas.conversations[0];
    expect(archivada).toBeTruthy();
    const trozo = String(archivada.customer?.name ?? '').slice(0, 5);

    // Con un filtro que no la incluye, sin buscar… no sale.
    const sinBuscar = await apiAdmin('filter=no-leidos');
    expect(sinBuscar.conversations.some((row) => row.id === archivada.id)).toBe(false);
    // …y buscando, sí (aunque el filtro siga en la URL).
    const buscando = await apiAdmin(`filter=no-leidos&q=${encodeURIComponent(trozo)}`);
    expect(buscando.conversations.some((row) => row.id === archivada.id)).toBe(true);
  });
});
