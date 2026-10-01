// @vitest-environment node
/**
 * EL PANEL TIENE QUE LLAMAR A LO QUE SE CONSTRUYÓ.
 *
 * Este archivo existe por un fallo real de la fase anterior: el píxel estaba
 * configurado pero nadie llamaba a su adaptador, así que "todo funcionaba" y no
 * se medía nada. Aquí se comprueba, sobre el archivo que se sirve de verdad, que
 * el panel usa los endpoints nuevos y que no hay ningún envío automático.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const adminDir = path.join(process.cwd(), 'public', 'admin');
const html = readFileSync(path.join(adminDir, 'index.html'), 'utf8');
const app = readFileSync(path.join(adminDir, 'app.js'), 'utf8');
const css = readFileSync(path.join(adminDir, 'admin.css'), 'utf8');

describe('el panel tiene las secciones nuevas', () => {
  it('existe la pestaña de WhatsApp y su bandeja', () => {
    expect(html).toContain('data-tab="whatsapp"');
    expect(html).toContain('id="view-whatsapp"');
    expect(html).toContain('id="badge-whatsapp"');
    // Bandeja real: lista a la izquierda, conversación a la derecha.
    expect(html).toContain('id="wa-conversations"');
    expect(html).toContain('id="wa-chat-pane"');
    expect(html).toContain('id="wa-search"');
    expect(html).toContain('id="wa-filters"');
    expect(html).toContain('id="wa-back"');
    // El estado de WhatsApp también se explica en Ajustes.
    expect(html).toContain('id="wa-config"');
    // La vista vieja de lista plana ya no existe.
    expect(html).not.toContain('id="list-whatsapp"');
  });

  it('la bandeja cubre búsqueda, filtros, dos columnas y escritorio/móvil', () => {
    for (const filter of ['Todos', 'Nuevos', 'Pendientes', 'Clientes', 'Seguimiento', 'Archivados']) expect(app).toContain(`'${filter}'`);
    expect(app).toContain('Activar notificaciones');
    expect(app).toContain('data-wa-bulk');
    expect(css).toContain('.conv--active');
    expect(css).toContain('.conv--pending');
    expect(css).toContain('.wa-bulk');
    expect(css).toContain("body[data-tab='whatsapp']");
    expect(css).toContain(".wa[data-view='chat'] .wa__list");
  });

  it('distingue “no hay conversaciones” de “falló el API”', () => {
    expect(app).toContain('No pudimos cargar las conversaciones.');
    expect(app).toContain('Aún no hay conversaciones. Cuando un cliente escriba por WhatsApp, aparecerá aquí.');
    expect(app).toContain('Reintentar');
  });

  it('las cinco vistas se muestran y se ocultan de verdad', () => {
    for (const name of ['hoy', 'whatsapp', 'clientes', 'mensajes', 'ajustes']) {
      expect(app).toContain(`'${name}'`);
      expect(html).toContain(`id="view-${name}"`);
    }
    expect(app).toContain("$$('[data-tab]')");
  });

  it('la barra de pestañas tiene TRES destinos y WhatsApp en el centro', () => {
    expect(css).toContain('repeat(3, 1fr)');
    expect(html).toContain('class="tab tab--center" data-tab="whatsapp"');
    // Lo secundario vive en el menú lateral, no en la barra de abajo.
    expect(html).toContain('id="drawer"');
    expect(html).toContain('data-tab="pedidos"');
    expect(html).toContain('data-tab="seguimientos"');
    expect(html).not.toContain('class="tab" data-tab="mensajes"');
  });

  it('el menú lateral está y se cierra de tres formas', () => {
    expect(html).toContain('aria-controls="drawer"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('id="drawer-close"');
    expect(app).toContain('function openDrawer');
    expect(app).toContain('function closeDrawer');
    expect(app).toContain("event.key === 'Escape'");
    expect(app).toContain("$('#scrim').addEventListener('click'");
  });
});

describe('el panel llama a los endpoints del CRM', () => {
  it('clientes, compras y seguimiento', () => {
    expect(app).toContain('/api/admin/customers/');
    // Los pedidos se crean por el endpoint de pedidos (el antiguo `/purchases`
    // sigue existiendo en el servidor por compatibilidad, pero el panel usa uno solo).
    expect(app).toContain('/api/admin/orders');
    expect(app).toContain('/api/admin/followups');
    expect(app).toContain('/api/admin/wa-templates');
    // Y la cola de mensajes programados del centro de ventas.
    expect(app).toContain('/api/admin/scheduled');
  });

  it('conversaciones y envío manual', () => {
    expect(app).toContain('/api/admin/conversations/');
    // El envío sale de un botón con una persona delante.
    expect(app).toContain("id=\"wa-send\"");
    expect(app).toContain("id=\"wa-send-template\"");
    expect(app).toContain('Nada se envía solo.');
    // Enter envía; Shift+Enter hace salto de línea (nunca automático).
    expect(app).toContain("event.key === 'Enter' && !event.shiftKey");
  });

  it('la conversación tiene cara de aplicación de mensajería', () => {
    // Avatar con iniciales, icono según el contenido y separadores de día.
    expect(app).toContain('const waInitials');
    expect(app).toContain('WA_KIND_ICON');
    expect(app).toContain('const waDayLabel');
    expect(app).toContain("return 'Hoy'");
    expect(app).toContain("return 'Ayer'");
    expect(app).toContain('bubble--grouped');
    // Compositor: adjuntar · campo · micrófono/Enviar.
    expect(app).toContain('composer-bar');
    expect(app).toContain("id=\"wa-attach\"");
    expect(app).toContain("id=\"wa-mic\"");
    // Fondo botánico propio (CSS, sin assets ajenos).
    expect(css).toContain('.chat-bg');
    expect(html).toContain('chat-bg');
  });

  it('las acciones del día (hecho, posponer, cancelar, no contactar)', () => {
    for (const attribute of ['data-followup-done', 'data-followup-postpone', 'data-followup-cancel', 'data-optout', 'data-pause']) {
      expect(app).toContain(attribute);
    }
  });

  it('el hilo distingue CLIENTE, NEGOCIO y AUTOMATIZACIÓN', () => {
    // Quién escribe se ve por el LADO y el color (izquierda/derecha), no por una
    // etiqueta repetida en cada mensaje: eso era ruido. Lo que SÍ se etiqueta es
    // lo automático, porque ahí hay algo que el negocio tiene que saber.
    expect(app).toContain("bubble--${inbound ? 'in' : 'out'}");
    expect(app).toContain('Automatización');
    expect(app).toContain('bubble--auto');
  });
});

describe('nada se envía solo', () => {
  it('los temporizadores de refresco/estado no envían mensajes solos', () => {
    // El sondeo de la bandeja (8 s) mantiene la pantalla al día; el contador de
    // la nota de voz (200 ms) SOLO pinta el tiempo y corta al llegar al tope —
    // nunca envía: el envío lo pulsa siempre una persona. Delivery también usa
    // polling de lectura si SSE no está disponible. El resto son `setTimeout`.
    const intervals = (app.match(/setInterval\([^)]*\)/g) ?? []).sort();
    expect(intervals).toEqual(['setInterval(deliveryPollTick, 8000)', 'setInterval(tick, 200)', 'setInterval(waPollTick, 8000)']);
    const from = app.indexOf('function waPollTick');
    const tick = app.slice(from, from + 900);
    expect(tick).not.toContain('POST');
    expect(tick).not.toContain('/messages');
    expect(app).toMatch(/waPollTick/);
    const deliveryFrom = app.indexOf('function deliveryPollTick');
    const deliveryTick = app.slice(deliveryFrom, deliveryFrom + 500);
    expect(deliveryTick).toContain("state.tab !== 'delivery'");
    expect(deliveryTick).toContain("document.visibilityState !== 'visible'");
    expect(deliveryTick).toContain('refreshDeliveryTracking');
    expect(deliveryTick).not.toContain('POST');
    expect(deliveryTick).not.toContain('/messages');
    expect(app).not.toMatch(/autoSend|sendAutomatically|scheduleSend/i);

    // El reloj de la grabación solo escribe el tiempo en pantalla.
    const desde = app.indexOf('const tick = () => {');
    const reloj = app.slice(desde, desde + 500);
    expect(reloj).toContain('rec-time');
    expect(reloj).not.toMatch(/fetch|uploadMediaFile|sendAudio|sendImage|POST/);
  });

  it('el sondeo no corre fuera de la pestaña ni en segundo plano', () => {
    const from = app.indexOf('function waPollTick');
    const tick = app.slice(from, from + 900);
    expect(tick).toContain("state.tab !== 'whatsapp'");
    expect(tick).toContain("document.visibilityState !== 'visible'");
  });

  it('el seguimiento se presenta como una tarea, no como un envío', () => {
    expect(app).toContain('Es una TAREA para una persona: el sistema no envía nada solo.');
  });
});
