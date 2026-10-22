# FULLTECH supplied icons and cart actions — UAT

**GO for local UAT.** Preview: http://127.0.0.1:8898/store/

The three pasted missions were identical. All sixteen supplied PNGs were inspected and already contained alpha transparency. The original download files were left untouched, and byte-identical originals plus SHA-256 provenance are archived in assets/branding/store-icons-original/. Optimized 96×96 PNGs preserve the exact shapes, crop empty margins, and add consistent transparent inset. No AI generation or redrawing. Total optimized assets: 28449 bytes.

## Integration

The visible silhouettes come directly from the uploaded PNGs through CSS alpha masks. currentColor provides the existing blue active, muted inactive and white button colors without duplicating bitmap variants. Existing generated icons.js was not edited; a small adapter uses the supplied assets for matching functions and retains Material icons for unsupported meanings (security, package, support, etc.). The supplied up arrow is optimized and available but not forced into an unrelated control.

| Supplied asset | Runtime PNG | Bytes | Placement |
|---|---|---:|---|
| pagina-de-inicio.png | home.png | 2583 | Inicio navigation |
| categoria.png | categories.png | 1425 | Categorías navigation and category fallback |
| filtrar (1).png | filter.png | 606 | Catalog filter toolbar |
| flecha-izquierda.png | back.png | 775 | Back buttons; rotated for forward links |
| compartir.png | share.png | 2464 | Product share |
| el-tiempo-de-entrega.png | truck.png | 3817 | Delivery benefit |
| carro.png | cart.png | 2040 | Header, bottom navigation, add actions |
| whatsapp (3).png | whatsapp.png | 3504 | About contact action |
| usuario.png | account.png | 2764 | Mi cuenta navigation |
| abajo.png | down.png | 1246 | Reduce quantity |
| arriba.png | up.png | 1216 | Available; no matching current standalone control |
| mas (1).png | plus.png | 570 | Increase quantity |
| cruz-quitar-signo.png | close.png | 927 | Drawer close |
| menu (2).png | menu.png | 666 | Header menu |
| eliminar (2).png | delete.png | 1638 | Remove cart item |
| lupa.png | search.png | 2208 | Search input and entry |

Runtime directory: public/store/assets/icons/custom/. Generator: scripts/build-store-custom-icons.mjs. Full source manifest: assets/branding/store-icons-original/manifest.json. All assets were suitable; no supplied icon required replacement.

## Cart and action behavior

Header cart stays visible, preserves immediate count updates and gains a blue active surface when count > 0. A single 380ms scale pulse runs on count changes. No idle loop and no attention animation on initial page load. Card/catalog/detail add buttons use the supplied cart, a minimum 44px action target, hover/press feedback and 1.2 seconds of Agregado feedback. Repeated taps reset the feedback timer correctly and restore the original icon/label; icon markup is no longer lost after confirmation. A polite live status announces success. prefers-reduced-motion removes the pulse and press/transition motion while retaining the success message.

Header height remains 45px. Logo, navigation destinations, stock eligibility, catalog, prices and checkout behavior are retained. Quantity icons have explicit dark ink on their existing white button surfaces, including dark mode. No animation libraries.

## Verification

Real Chromium against loopback UAT; widths 360, 390, 430 and 1440px at DPR 2, light and dark: **8/8 interaction cases passed**.

- Correct supplied home/category/cart/account icons; actual PNG mask URLs verified.
- Menu open/close and all bottom navigation destinations.
- Multiple products and rapid repeated adds; immediate badge counts 1/3/4.
- Header and bottom cart navigation, quantity adjustment, product-detail add and share icon.
- Finite animation iteration count = 1; pulse disabled with reduced motion.
- Original icon restored after feedback; button width/height stable.
- No horizontal overflow or browser-console/JavaScript errors in the tested flows.
- Separate action-performance check: 0 layout-shift score and 0 observed long tasks >50ms during add/restore. This is a local lab observation, not a production benchmark.
- Offline shell and all sixteen PNGs passed after explicitly registering the existing service worker; v34 precaches the new module/CSS/assets.
- Syntax checks and git diff --check passed.

Initial transfer across these views was 510.8–528.7 KiB before and 513.8–524.7 KiB after. Lazy-image selection varies with viewport; no material transfer increase was observed.

## Files

- public/store/custom-icons.js — supplied-asset adapter and fallback.
- public/store/custom-icons.css — PNG masks, action states, accessibility/reduced motion.
- public/store/store.js — icon import, matching action markup, feedback and cart visual state; pre-existing changes preserved.
- public/store/index.html — stylesheet/live status, close icon and script version 28.
- public/store/sw.js — cache v34 and assets.
- public/store/assets/icons/custom/*.png — 16 optimized assets.
- assets/branding/store-icons-original/ — source archive and manifest.
- scripts/build-store-custom-icons.mjs and scripts/check-store-icons-browser.mjs — reproducible generation/browser checks. Browser runner accepts PLAYWRIGHT_MODULE and CHROMIUM_PATH for an existing installation.
- docs/FULLTECH-ICONS-UAT.md and docs/capturas/store-icons/ — evidence.

## Screenshots

| Theme / width | Before | After | Added state | Cart |
|---|---|---|---|---|
| light / 360px | [Before](capturas/store-icons/before-light-360.png) | [After](capturas/store-icons/after-light-360.png) | [Added](capturas/store-icons/added-light-360.png) | [Cart](capturas/store-icons/cart-light-360.png) |
| light / 390px | [Before](capturas/store-icons/before-light-390.png) | [After](capturas/store-icons/after-light-390.png) | [Added](capturas/store-icons/added-light-390.png) | [Cart](capturas/store-icons/cart-light-390.png) |
| light / 430px | [Before](capturas/store-icons/before-light-430.png) | [After](capturas/store-icons/after-light-430.png) | [Added](capturas/store-icons/added-light-430.png) | [Cart](capturas/store-icons/cart-light-430.png) |
| light / 1440px | [Before](capturas/store-icons/before-light-1440.png) | [After](capturas/store-icons/after-light-1440.png) | [Added](capturas/store-icons/added-light-1440.png) | [Cart](capturas/store-icons/cart-light-1440.png) |
| dark / 360px | [Before](capturas/store-icons/before-dark-360.png) | [After](capturas/store-icons/after-dark-360.png) | [Added](capturas/store-icons/added-dark-360.png) | [Cart](capturas/store-icons/cart-dark-360.png) |
| dark / 390px | [Before](capturas/store-icons/before-dark-390.png) | [After](capturas/store-icons/after-dark-390.png) | [Added](capturas/store-icons/added-dark-390.png) | [Cart](capturas/store-icons/cart-dark-390.png) |
| dark / 430px | [Before](capturas/store-icons/before-dark-430.png) | [After](capturas/store-icons/after-dark-430.png) | [Added](capturas/store-icons/added-dark-430.png) | [Cart](capturas/store-icons/cart-dark-430.png) |
| dark / 1440px | [Before](capturas/store-icons/before-dark-1440.png) | [After](capturas/store-icons/after-dark-1440.png) | [Added](capturas/store-icons/added-dark-1440.png) | [Cart](capturas/store-icons/cart-dark-1440.png) |

[Source contact sheet](capturas/store-icons/source-contact.png) · [Interaction results](capturas/store-icons/interaction-tests.json) · [Action performance](capturas/store-icons/action-performance.json) · [Offline test](capturas/store-icons/offline.json)

No production changes, commit, push or deployment. No backend changes or new orders/payments. Approved logo and unrelated work preserved. No functional blockers observed in local UAT.
