// @vitest-environment node
/**
 * UAT DE LA PIEL DEL PANEL — app shell, WhatsApp, compositor y acciones.
 *
 * Este archivo NO comprueba negocio: comprueba que la pantalla que se sirve de
 * verdad (la que ve el vendedor) cumple el rediseño, porque son justo las cosas
 * que se rompen solas al tocar CSS: un appbar que vuelve, un botón gigante que
 * reaparece bajo el compositor, un texto de ayuda permanente, una burbuja dentro
 * de otra burbuja…
 *
 * Mide sobre los tres archivos que se publican (`index.html`, `admin.css`,
 * `app.js`). Lo que se ve en pantalla se midió aparte, en un navegador de verdad,
 * a 360x800, 390x844, 412x915, 1280x900 y 1440x900.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const adminDir = path.join(process.cwd(), 'public', 'admin');
/** Los archivos se leen con los finales de línea normalizados: así las reglas de
 * estilo se pueden comprobar como bloques, no a golpe de `toContain` suelto. */
const read = (name) => readFileSync(path.join(adminDir, name), 'utf8').replaceAll('\r\n', '\n');
const html = read('index.html');
const app = read('app.js');
const css = read('admin.css');

/** El trozo de HTML de la vista de WhatsApp (donde no debe quedar ruido). */
const waHtml = html.slice(html.indexOf('id="view-whatsapp"'), html.indexOf('<!-- CLIENTES -->'));

describe('app shell: barra ligera, menú y estado flotantes', () => {
  it('el menú flota y se convierte en ✕ (sin quedar pegado a una barra)', () => {
    expect(html).toContain('class="float-btn float-btn--menu"');
    expect(html).toContain('aria-controls="drawer"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('class="burger"');
    expect(css).toContain('.float-btn {');
    expect(css).toContain('position: fixed');
    // La animación del icono depende del estado real del menú, no de una clase.
    expect(css).toContain(".float-btn[aria-expanded='true'] .burger span:first-child");
    expect(app).toContain("$('#menu')?.setAttribute('aria-expanded', 'true')");
  });

  it('el estado del sistema es un indicador con pulso, no un botón', () => {
    expect(html).toContain('id="state-pill"');
    expect(html).toContain('role="status"');
    expect(app).toContain('presence__dot');
    expect(app).toContain("'En línea'");
    expect(app).toContain("pill.dataset.online = online ? 'true' : 'false'");
    expect(css).toContain('.presence__dot');
    expect(css).toContain('@keyframes presence-breathe');
    // Se respeta a quien pide menos movimiento.
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('ya no hay botón de recargar ni nombre de vista repetido en Hoy', () => {
    expect(html).not.toContain('id="refresh"');
    expect(app).not.toContain("$('#refresh')");
    // En Hoy el encabezado dice «Phytoemagry / CRM», nada de «Hoy» otra vez.
    expect(app).toContain("hoy: 'CRM'");
  });

  it('la barra inferior es sobria: tres destinos y sin círculo elevado', () => {
    expect(css).toContain('grid-template-columns: repeat(3, 1fr)');
    expect(css).toContain('.tab--center[aria-current=\'true\'] .tab__icon');
    // El globo de WhatsApp ya no es el protagonista de la barra.
    expect(css).toMatch(/\.tab--center \.tab__icon \{[^}]*margin-top: 0/);
  });

  it('Delivery aparece en el drawer móvil sin duplicar Hoy, WhatsApp y Clientes', () => {
    expect(html).toContain('<button class="drawer__item" data-tab="delivery" type="button">');
    expect(html.indexOf('<p class="drawer__group">Gestión</p>')).toBeLessThan(
      html.indexOf('<p class="drawer__group drawer__group--primary">Operación</p>'),
    );
    expect(css).toMatch(/@media \(max-width: 979px\) \{[\s\S]*?\.drawer__group--primary,\n\s+\.drawer__nav--primary \{\n\s+display: grid;/);
    expect(css).toContain(".drawer__nav--primary .drawer__item:not([data-tab='delivery'])");
    expect(css).toMatch(/\.drawer__nav--primary \.drawer__item:not\(\[data-tab='delivery'\]\) \{\n\s+display: none;/);
    expect(css).toMatch(/\.drawer \{[\s\S]*?display: flex;\n\s+flex-direction: column;/);
    expect(css).toMatch(/\.drawer__foot \{[\s\S]*?margin-top: auto;/);
  });

  it('los iconos son UN sistema (SVG), no emojis mezclados', () => {
    expect(app).toContain('const ICONS = {');
    expect(app).toContain('function paintIcons');
    expect(app).toContain('paintIcons();');
    for (const emoji of ['☀', '💬', '👥', '📦', '🔔', '📝', '⚙', '☰', '⟳', '🎤', '➤']) {
      expect(html).not.toContain(emoji);
    }
  });
});

describe('WhatsApp: la conversación es la pantalla', () => {
  it('no hay appbar general ni aviso de «conectado» con el número del negocio', () => {
    expect(css).toContain("body[data-tab='whatsapp'] .topbar");
    expect(css).toMatch(/body\[data-tab='whatsapp'\] \.topbar \{\n\s+display: none/);
    // El estado de WhatsApp solo se anuncia cuando HAY algo que hacer.
    expect(app).not.toContain('WhatsApp conectado');
    expect(app).toContain("$('#wa-status').innerHTML = wa.configured");
  });

  it('la vista de WhatsApp no lleva relleno: el hilo va a sangre', () => {
    expect(css).toMatch(/body\[data-tab='whatsapp'\] \.content \{\n\s+padding: 0/);
    // Y el hilo se queda con todo el alto que sobra.
    expect(css).toMatch(/\.thread \{[\s\S]*?flex: 1;/);
    expect(css).toContain('.thread--wa {');
  });

  it('la identidad del cliente está arriba y ocupa poco', () => {
    expect(waHtml).toContain('class="wa__chat-head"');
    expect(waHtml).toContain('id="wa-chat-name"');
    expect(waHtml).toContain('id="wa-chat-meta"');
    expect(app).toContain("$('#wa-chat-name').textContent");
    expect(app).toContain("$('#wa-chat-meta').textContent");
    // Cabecera compacta (una franja de ~50 px, no un header de 80).
    expect(css).toMatch(/\.wa__chat-head \{[\s\S]*?padding: calc\(7px \+ env\(safe-area-inset-top, 0px\)\) 46px 7px 60px;/);
  });

  it('atrás solo aparece donde hace falta (en escritorio sobra)', () => {
    expect(waHtml).toContain('id="wa-back"');
    expect(css).toMatch(/@media \(min-width: 980px\) \{[\s\S]*?\.wa__back \{\n\s+display: none;/);
    // En una conversación abierta, el menú flotante deja sitio al ←.
    expect(css).toContain("body[data-wa-view='chat'] .float-btn--menu");
    expect(app).toContain('document.body.dataset.waView = view');
  });

  it('el icono del menú solo vive en la principal; en el resto, volver', () => {
    // El menú lateral se abre desde el círculo grande de la cabecera de Hoy…
    expect(app).toContain('data-open-drawer');
    // …y en cualquier otra página el botón flotante del menú DESAPARECE: allí lo
    // que hay es un volver, en el mismo sitio y sin superponerse (eran dos
    // círculos a 14 px y 16 px, uno encima del otro).
    expect(css).toMatch(/body:not\(\[data-tab='hoy'\]\) \.float-btn--menu \{\n\s+display: none;/);
    expect(app).toContain('data-simple-back');
    // Una conversación abierta es la pantalla entera y ya lleva su ←: la barra
    // general (con OTRO volver) se retira para no duplicar el control.
    expect(css).toMatch(/body\[data-wa-view='chat'\] \.mobile-header \{\n\s+display: none;/);
    // El volver es un control de dedo (44 px, no 38) y redondo.
    expect(css).toMatch(/\.simple-head__back \{[\s\S]*?width: 44px;\n\s+height: 44px;/);
    expect(css).toMatch(/\.simple-head__back \{[\s\S]*?border-radius: 50%/);
    // Alineado con el borde del contenido (los 14 px de `.content`) y sin barra dura.
    expect(css).toMatch(/\.simple-head \{[\s\S]*?padding: calc\(5px \+ env\(safe-area-inset-top, 0px\)\) 14px 5px;/);
    expect(css).toMatch(/\.simple-head \{[\s\S]*?border-bottom: 1px solid rgba\(11, 107, 79, 0\.07\)/);
    // Volver lleva al inicio, que es donde está el menú.
    expect(app).toContain("setTab('hoy')");
  });

  it('la lista son filas limpias, sin tarjeta por conversación', () => {
    expect(css).toMatch(/\.conv \{[\s\S]*?border-bottom: 1px solid var\(--border-soft\)/);
    expect(css).toMatch(/\.conv \{[\s\S]*?border-radius: 0/);
    // La fila ya no repite el teléfono: el nombre, el último mensaje y la hora.
    expect(app).not.toContain('conv__phone');
  });
});

describe('mensajes: un mensaje, un componente visual', () => {
  it('el archivo ES la burbuja (nada de tarjeta dentro de tarjeta)', () => {
    expect(app).toContain('soloArchivo');
    expect(app).toContain("'bubble--media'");
    expect(css).toMatch(/\.bubble--media \{[\s\S]*?background: transparent/);
  });

  it('el audio es UN componente: play, onda y duración', () => {
    expect(app).toContain('class="audio"');
    expect(app).toContain('audio__play');
    expect(app).toContain('audio__seek');
    expect(app).toContain('audio__times');
    // La duración que ya conocemos no se enseña como «--:--».
    expect(app).toContain('fmtSeconds(media.durationMs / 1000)');
    // La onda avanza con una variable CSS (sin repintar el hilo entero).
    expect(app).toContain("--audio-progress");
    expect(css).toContain('.audio__seek::-webkit-slider-runnable-track');
  });

  it('la imagen funciona como componente, con pie de foto solo si existe', () => {
    expect(app).toContain('media-thumb');
    expect(app).toContain('media-caption');
    expect(css).toMatch(/\.media-thumb img \{[\s\S]*?border-radius: 14px/);
  });

  it('el hilo se abre por lo último (también cuando llegan las imágenes)', () => {
    expect(app).toContain('const irAlFinal');
    expect(app).toContain("addEventListener('load', irAlFinal, { once: true })");
    // Y no depende de `requestAnimationFrame` para funcionar en cualquier entorno.
    expect(app).toContain("if (typeof requestAnimationFrame === 'function')");
  });

  it('las fechas son una etiqueta discreta, no una tarjeta', () => {
    expect(css).toMatch(/\.day-sep \{[\s\S]*?border: 0;/);
  });
});

describe('compositor y acciones del cliente', () => {
  it('el compositor es una sola pieza integrada', () => {
    expect(app).toContain('class="composer-bar"');
    expect(app).toContain('id="wa-attach"');
    expect(app).toContain('id="wa-text"');
    expect(app).toContain('class="composer-end"');
    expect(app).toContain('id="wa-mic"');
    expect(app).toContain('id="wa-send"');
    expect(css).toMatch(/\.composer-bar \{[\s\S]*?grid-template-columns: auto 1fr auto;/);
    // Micro y envío comparten casilla: cambiar de uno a otro no mueve el layout.
    expect(css).toMatch(/\.composer-end \.composer-btn \{\n\s+grid-area: 1 \/ 1;/);
  });

  it('no queda texto de ayuda permanente debajo del campo (en el móvil)', () => {
    expect(css).toMatch(/\.composer-rule \{\n\s+display: none;/);
    expect(css).toMatch(/@media \(min-width: 980px\) \{\n\s+\.composer-rule \{\n\s+display: block;/);
    expect(app).not.toContain('Enter envía · Shift+Enter hace un salto de línea');
  });

  it('la ventana de 24 h solo se avisa cuando de verdad está cerrada', () => {
    expect(app).toContain('La ventana de atención de 24 horas terminó');
    expect(app).toContain('if (!canSendFreeText) {');
  });

  it('las acciones del chat son un botón flotante inferior, sin tarjeta grande', () => {
    expect(waHtml).not.toContain('id="compra-nueva-wa"');
    expect(app).not.toContain('compra-nueva-wa');
    expect(waHtml).toContain('class="wa__fab-row"');
    expect(waHtml).toContain('class="wa-fab"');
    expect(waHtml).not.toContain('class="wa__chat-menu"');
    expect(waHtml).toContain('id="wa-actions"');
    expect(css).toMatch(/\.thread \{[\s\S]*?padding: 12px 12px 56px;/);
    expect(css).toMatch(/\.wa__fab-row \{\n\s+position: relative;\n\s+height: 0;/);
  });

  it('el menú de acciones lleva las cuatro acciones, con cliente ya elegido', () => {
    const menu = app.slice(app.indexOf('function openChatActions'), app.indexOf('function openChatActions') + 5200);
    for (const accion of ['Crear pedido', 'Programar seguimiento', 'Programar mensaje', 'Ver cliente']) {
      expect(menu).toContain(accion);
    }
    // Cada acción viaja con el cliente y la conversación de los que viene.
    expect(menu).toContain('data-order-new="${escapeHtml(customer.id)}"');
    expect(menu).toContain('data-conversation="${escapeHtml(');
    // Sin párrafos explicativos: solo la que envía sola avisa de que envía sola.
    expect(menu).not.toContain('Acciones de venta con este cliente');
    expect(menu).toContain('Lo envía el sistema');
  });

  it('los menús son popover en escritorio y hoja en el móvil', () => {
    expect(app).toContain("{ variant = '' } = {}");
    expect(css).toContain(".sheet[data-variant='menu'] .sheet__panel");
    expect(css).toContain('@media (min-width: 720px)');
  });

  it('crear pedido desde el chat no vuelve a pedir nombre ni teléfono', () => {
    expect(app).toContain('`Pedido para ${customerName(customer)}`');
    // Los campos de teléfono/nombre solo existen cuando NO hay cliente.
    const form = app.slice(app.indexOf('function openOrderForm'), app.indexOf('function openOrderForm') + 1800);
    expect(form).toContain('id="order-phone"');
    expect(form).toMatch(/customer\s*\?\s*''/);
    expect(app).not.toContain('Cliente precargado de la conversación');
  });
});
