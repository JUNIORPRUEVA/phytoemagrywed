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

  it('los iconos del appbar de Hoy quedan clicables por encima de capas decorativas', () => {
    expect(css).toMatch(/\.dashboard-head::after\s*\{[^}]*pointer-events:\s*none;/s);
    expect(css).toMatch(/body\[data-tab='hoy'\]\s+\.mobile-header\s*\{[^}]*z-index:\s*0;[^}]*pointer-events:\s*none;/s);
    expect(css).toMatch(/body\[data-tab='hoy'\]\s+\.dashboard-head\s*\{[^}]*pointer-events:\s*none;/s);
    expect(css).toMatch(/body\[data-tab='hoy'\]\s+\.dashboard-head__menu\s*\{[^}]*pointer-events:\s*auto;/s);
    expect(css).toMatch(/body\[data-tab='hoy'\]\s+\.dashboard-head__actions\s*\{[^}]*z-index:\s*5;/s);
    expect(css).toMatch(/body\[data-tab='hoy'\]\s+\.dashboard-head__quick\s*\{[^}]*pointer-events:\s*auto;/s);
  });
});
