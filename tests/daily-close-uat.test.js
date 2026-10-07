// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const html = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const css = readFileSync(new URL('../public/admin/admin.css', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

describe('cierre diario del delivery', () => {
  it('tiene pantalla propia con cierre automático y cálculo de liquidación', () => {
    expect(html).toContain('data-tab="cierre"');
    expect(html).toContain('data-daily-close-access');
    expect(html).not.toContain('data-tab="cierre" type="button" data-permission="reports.profit.view"');
    expect(html).toContain('id="view-cierre"');
    expect(app).toContain('function dailyCloseModel');
    expect(app).toContain('function businessClockMinutes');
    expect(app).toContain('const canUseDailyClose');
    expect(app).toContain("'AGENT', 'DELIVERY'");
    expect(app).toContain('18 * 60');
    expect(app).toContain('21 * 60');
    expect(app).toContain('a las 9:00 p.m. queda automático');
    expect(app).toContain('deliveryCommissionForLine');
    expect(app).toContain('capsules === 5 ? 150 : capsules === 10 ? 200 : capsules === 60 ? 200 : capsules > 10 ? 250');
    expect(app).toContain('cashHeldByDelivery');
    expect(app).toContain("String(order.delivery?.delivery_user_id ?? '') === String(user?.id ?? '')");
    expect(app).toContain('settlementLabel');
    expect(app).toContain('Efectivo en mano');
    expect(app).toContain('Delivery cobrado');
    expect(app).toContain('Total que se gana');
    expect(app).toContain('No delivery');
    expect(app).toContain('Hacer cierre ahora');
    expect(app).toContain('Todavía es temprano: el cierre manual se habilita desde las 6:00 p.m.');
    expect(app).toContain('function deliveryEarningsForUser');
    expect(app).toContain('profileDeliveryEarningsHtml');
    expect(app).toContain('Ganancia acumulada por entregas');
    expect(css).toContain('.daily-close__grid');
    expect(css).toContain('.daily-close__block--green');
    expect(css).toContain('.profile-earnings');
  });
});
