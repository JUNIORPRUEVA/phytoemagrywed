// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/admin/admin.css', import.meta.url), 'utf8');

describe('Hoy notification UX', () => {
  it('no muestra problemas de WhatsApp como bloque fijo en la lista de Hoy', () => {
    const renderHoy = app.slice(app.indexOf('function renderHoy'), app.indexOf('function renderWhatsapp'));
    expect(renderHoy).not.toContain('WhatsApp los rechazó');
    expect(renderHoy).not.toContain('Mensajes programados con problemas');
    expect(renderHoy).not.toContain('scheduledProblemCard');
  });

  it('mueve problemas al icono de notificaciones y permite descartarlos', () => {
    expect(app).toContain("const NOTICE_DISMISSED_KEY = 'pe_notice_dismissed'");
    expect(app).toContain('function localNoticeRows');
    expect(app).toContain('const unreadNotifications = unreadNotificationCount();');
    expect(app).toContain('data-notice-dismiss');
    expect(app).toContain('Entendido');
    expect(app).toContain('function dismissNotice');
  });

  it('el appbar de Hoy no muestra el indicador de conexión como tercer icono', () => {
    const header = app.slice(app.indexOf('function renderMobileHeader'), app.indexOf("if (state.tab === 'whatsapp')"));
    expect(header).toContain('data-dashboard-profile');
    expect(header).toContain('data-dashboard-notifications');
    expect(header).not.toContain('dashboard-head__net');
  });

  it('la campana de Hoy abre una hoja modal visible por encima del appbar', () => {
    const handler = app.slice(app.indexOf("event.target.closest('[data-dashboard-notifications]')"), app.indexOf("const noticeDismiss"));
    expect(handler).toContain('openNotificationsSheet();');
    expect(css).toMatch(/\.sheet\s*\{[^}]*z-index:\s*900;/s);
  });

  it('al abrir una notificación del servidor desaparece de la bandeja', () => {
    expect(app).toContain('async function dismissOpenedNotification(notificationId)');
    expect(app).toContain("state.notifications = (state.notifications ?? []).filter((row) => row.id !== notificationId);");
    // Abrir un aviso lo BORRA (y se apunta), no solo lo marca como leído: si no,
    // volvía a salir en el siguiente refresco.
    expect(app).toContain('marcarNotificacionBorrada(notificationId);');
    expect(app).toContain('await flushNotificacionesBorradas()');
    const openTarget = app.slice(app.indexOf('async function openNotificationTarget'), app.indexOf('function stopDeliveryWatch'));
    expect(openTarget).toContain('await dismissOpenedNotification(notificationId);');
    expect(openTarget).not.toContain('/read`, { method: \'POST\'');
  });

  it('lo borrado no vuelve: se recuerda el id y se reintenta el borrado en el servidor', () => {
    expect(app).toContain("const NOTIF_DELETED_KEY = 'pe_notif_borradas'");
    expect(app).toContain('function notificacionesVisibles(rows = state.notifications ?? [])');
    expect(app).toContain('async function flushNotificacionesBorradas()');
    expect(app).toContain('function borrarNotificacion(notificationId)');
    // La lista de la hoja y el contador de la campana usan la MISMA fuente.
    // (Con `\r?\n`: el archivo puede estar con fin de línea de Windows.)
    expect(app).toMatch(/const unreadNotificationCount = \(\) =>\r?\n\s+notificacionesVisibles\(/);
    expect(app).toContain('data-notification-delete');
    // Y la cola de borrados no se vacía a ciegas: se reintenta hasta que el
    // servidor confirma (si no, el aviso quedaba vivo allí­ y volví­a en otro
    // teléfono —o con los datos del navegador limpios—).
    const borrarTodas = app.slice(app.indexOf('async function deleteAllNotifications'), app.indexOf('/** Borra UNA notificación'));
    expect(borrarTodas).toContain('await flushNotificacionesBorradas()');
    expect(borrarTodas).not.toContain('guardarNotifListas(NOTIF_PENDING_KEY, [])');
    /*
     * El servidor también recuerda el borrado (tabla `notification_deletions`):
     * por aviso Y por suceso, para que una recreación del mismo suceso no lo
     * resucite, y filtrando en la propia lista.
     */
    const server = readFileSync(new URL('../server/crm-server.mjs', import.meta.url), 'utf8');
    expect(server).toContain("action: 'notifications.deleted_all'");
    expect(server).toContain('async function rememberNotificationDeletion');
    expect(server).toContain('async function deletableNotifications');
    expect(server).toContain('borradoParaSuDestinatario');
    expect(server).toContain("ctx.db.insert('notification_deletions'");
    const colecciones = readFileSync(new URL('../server/collections.mjs', import.meta.url), 'utf8');
    expect(colecciones).toContain('notification_deletions');
  });

  it('un aviso descartado no reaparece aunque cambie la cuenta o el estado', () => {
    // La clave es ESTABLE y el valor descartado va aparte: antes la clave llevaba
    // el número (`wa-failed:2`) y al llegar el tercer fallo volvía a salir.
    expect(app).toContain("const key = 'wa-failed';");
    expect(app).not.toContain('wa-failed:${failedCount}');
    expect(app).toContain('const key = `scheduled-problem:${row.id}`;');
    expect(app).not.toContain('scheduled-problem:${row.id}:${row.status}');
    expect(app).toContain('function noticeDismissed(descartados, key, valor)');
    expect(app).toContain('if (typeof valor === \'number\' && typeof guardado === \'number\') return valor <= guardado;');
  });

  it('los iconos del appbar de Hoy quedan clicables por encima de capas decorativas', () => {
    expect(css).toMatch(/\.dashboard-head::after\s*\{[^}]*pointer-events:\s*none;/s);
    expect(css).toMatch(/body\[data-tab='hoy'\]\s+\.mobile-header\s*\{[^}]*z-index:\s*0;[^}]*pointer-events:\s*none;/s);
    expect(css).toMatch(/body\[data-tab='hoy'\]\s+\.dashboard-head\s*\{[^}]*pointer-events:\s*none;/s);
    expect(css).toMatch(/body\[data-tab='hoy'\]\s+\.dashboard-head__menu\s*\{[^}]*pointer-events:\s*auto;/s);
    expect(css).toMatch(/body\[data-tab='hoy'\]\s+\.dashboard-head__actions\s*\{[^}]*z-index:\s*5;/s);
    expect(css).toMatch(/body\[data-tab='hoy'\]\s+\.dashboard-head__quick\s*\{[^}]*pointer-events:\s*auto;/s);
  });
});
