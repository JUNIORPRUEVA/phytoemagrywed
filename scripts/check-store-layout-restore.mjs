import { chromium } from 'file:///C:/Users/pc/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = new URL('../docs/capturas/store-restored/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Users/pc/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe', headless: true });
try {
  for (const width of [360, 390, 430, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 850 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:8898/store/', { waitUntil: 'networkidle' });
    await page.locator('.ft-hero').waitFor();
    if (await page.locator('.cart-shortcut').isVisible()) throw Error(`Empty cart visible at ${width}`);
    const state = await page.evaluate(() => {
      const bounds = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; };
      return { header: bounds('.ft-header'), logo: bounds('.ft-wordmark'), search: bounds('.ft-search--entry'), hero: bounds('.ft-hero'), cart: bounds('.cart-shortcut'), nav: bounds('.ft-nav'), viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, marketplaceStylesheet: !!document.querySelector('link[href*="marketplace.css"]'), searchInsideHeader: !!document.querySelector('.ft-header .ft-search') };
    });
    await page.screenshot({ path: fileURLToPath(new URL(`home-${width}.png`, output)), fullPage: false });
    if (state.marketplaceStylesheet || state.searchInsideHeader || state.documentWidth > width || state.header.height > 55) throw Error(`Layout failed at ${width}: ${JSON.stringify(state)}`);
    if (width <= 430 && (state.hero.x > 8 || state.nav.width !== width || Math.abs(state.logo.x + state.logo.width / 2 - width / 2) > 1)) throw Error(`Mobile layout failed at ${width}: ${JSON.stringify(state)}`);
    await page.locator('#menu-button').click();
    if (await page.locator('#drawer').getAttribute('aria-hidden') !== 'false') throw Error(`Menu failed at ${width}`);
    await page.locator('#close-drawer').click();
    await page.waitForTimeout(350);
    await page.locator('.ft-nav__item[data-route="catalog"]').click();
    await page.locator('.product-card').first().waitFor();
    if (await page.locator('#store-search').count() !== 1) throw Error(`Catalog search failed at ${width}`);
    await page.locator('[data-add-cart]').first().click();
    await page.locator('.cart-shortcut').waitFor({ state: 'visible' });
    const floating = await page.locator('.cart-shortcut').boundingBox();
    if (width <= 430 && floating.y + floating.height > state.nav.y - 16) throw Error(`Floating cart overlaps navigation at ${width}`);
    if (width === 390) await page.screenshot({ path: fileURLToPath(new URL('catalog-390.png', output)), fullPage: false });
    await page.locator('.cart-shortcut').click();
    await page.waitForURL('**/#/cart');
    await page.locator('[data-cart-remove]').first().click();
    await page.locator('.cart-shortcut').waitFor({ state: 'hidden' });
    await page.reload({ waitUntil: 'networkidle' });
    if (await page.locator('.cart-shortcut').isVisible()) throw Error(`Empty cart visible after reload at ${width}`);
    console.log(JSON.stringify({ width, header: state.header, nav: state.nav, floating, emptyAddRemoveReload: 'ok' }));
    await context.close();
  }
} finally { await browser.close(); }
