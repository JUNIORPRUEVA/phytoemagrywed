import { chromium } from 'file:///C:/Users/pc/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const out = new URL('../docs/capturas/store-discovery/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Users/pc/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe', headless: true });
try {
  for (const width of [360, 390, 430, 768, 1280]) {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 850 }, colorScheme, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto('http://127.0.0.1:8898/store/', { waitUntil: 'networkidle' });
      await page.locator('.ft-discovery').waitFor();
      await page.locator('#signup-prompt').waitFor({ state: 'visible' });
      const refinements = await page.evaluate(() => {
        const search = document.querySelector('.ft-home-search .ft-search').getBoundingClientRect();
        const tile = document.querySelector('.ft-search-tile').getBoundingClientRect();
        return { searchHeight: search.height, rightIcon: tile.right === search.right - 1,
          logoWidth: document.querySelector('.ft-wordmark').getBoundingClientRect().width,
          summaries: [...document.querySelectorAll('.ft-card__summary')].every(n => Array.from(n.textContent).length <= 85),
          categories: document.querySelectorAll('.ft-card__category').length };
      });
      if (refinements.searchHeight !== 40 || !refinements.rightIcon || refinements.logoWidth !== 132 || !refinements.summaries || !refinements.categories) throw Error(JSON.stringify(refinements));
      const latest = await page.evaluate(() => {
        const images = [...document.querySelectorAll('.ft-hero__duo img')].map(n => n.getBoundingClientRect());
        const prompt = document.querySelector('#signup-prompt').getBoundingClientRect();
        const nav = document.querySelector('.ft-nav').getBoundingClientRect();
        return { imageGap: images[1].top - images[0].bottom, diagonal: images[0].right > images[1].right,
          promptGap: nav.top - prompt.bottom, searchAsset: getComputedStyle(document.querySelector('.ft-search-tile .ft-custom-icon')).getPropertyValue('--icon-url'),
          requestAsset: getComputedStyle(document.querySelector('.ft-nav__item[data-route="request"] .ft-custom-icon')).getPropertyValue('--icon-url') };
      });
      if (latest.imageGap < 10 || !latest.diagonal || latest.promptGap < 0 || !latest.searchAsset.includes('search-large.png') || !latest.requestAsset.includes('find-for-you.png')) throw Error(JSON.stringify(latest));
      const metrics = await page.evaluate(() => {
        const rect = document.querySelector('.ft-discovery').getBoundingClientRect();
        const button = document.querySelector('.ft-card [data-add-cart]').getBoundingClientRect();
        return { x: rect.x, width: rect.width, viewport: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
          background: getComputedStyle(document.body).backgroundColor, button: { width: button.width, height: button.height },
          images: [...document.querySelectorAll('.ft-hero__duo img')].every(i => i.complete && i.naturalWidth > 0) };
      });
      if (metrics.overflow || metrics.background !== 'rgb(247, 248, 250)' || !metrics.images || metrics.button.width !== 44) throw Error(JSON.stringify(metrics));
      if (width < 760 && (metrics.x !== 0 || metrics.width !== width)) throw Error('Unexpected lateral margin');
      if (await page.locator('.cart-shortcut').isVisible()) throw Error('Empty cart visible');
      await page.screenshot({ path: fileURLToPath(new URL(`home-${width}-${colorScheme}.png`, out)) });
      await page.evaluate(() => scrollTo(0, 650));
      await page.waitForTimeout(150);
      const sticky = await page.evaluate(() => ({ y: document.querySelector('.ft-home-search').getBoundingClientRect().y,
        headerBottom: document.querySelector('.ft-header').getBoundingClientRect().bottom,
        cardBottom: document.querySelector('.ft-discovery').getBoundingClientRect().bottom }));
      if (sticky.y !== 0 || sticky.headerBottom > 0 || sticky.cardBottom > 0) throw Error(`Sticky failed: ${JSON.stringify(sticky)}`);
      await page.screenshot({ path: fileURLToPath(new URL(`scroll-${width}-${colorScheme}.png`, out)) });
      await page.locator('.ft-card [data-add-cart]').first().click();
      await page.locator('.cart-shortcut').waitFor({ state: 'visible' });
      await page.locator('.cart-shortcut').click();
      await page.locator('[data-cart-remove]').first().click();
      await page.locator('.cart-shortcut').waitFor({ state: 'hidden' });
      if (errors.length) throw Error(errors.join('\n'));
      console.log(JSON.stringify({ width, colorScheme, ...metrics, sticky, cart: 'add/remove OK' }));
      await context.close();
    }
  }
  const signedContext = await browser.newContext({ viewport: { width: 390, height: 850 } });
  const signedPage = await signedContext.newPage();
  await signedPage.route('**/api/store/account/me', route => route.fulfill({ json: { account: { id: 'uat-signed-view', name: 'Cliente UAT' } } }));
  await signedPage.goto('http://127.0.0.1:8898/store/', { waitUntil: 'networkidle' });
  if (await signedPage.locator('#signup-prompt').isVisible()) throw Error('Signup prompt shown to signed-in customer');
  await signedContext.close();
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 850 } });
  const guestPage = await guestContext.newPage();
  await guestPage.goto('http://127.0.0.1:8898/store/', { waitUntil: 'networkidle' });
  await guestPage.locator('.ft-profile').click();
  await guestPage.waitForURL('**/#/account');
  await guestPage.locator('#signup-prompt').waitFor({ state: 'hidden' });
  await guestPage.locator('.ft-nav__item[data-route="request"]').click();
  await guestPage.waitForURL('**/#/request');
  await guestPage.locator('.ft-nav__item[data-route="request"][aria-current="page"]').waitFor();
  await guestContext.close();
  console.log('Signed-in prompt suppression, guest profile and request navigation: OK');
} finally { await browser.close(); }
