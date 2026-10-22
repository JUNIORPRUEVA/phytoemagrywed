# FULLTECH discovery and About — local UAT report

**GO for local UAT.** Preview: http://127.0.0.1:8898/store/ · About: http://127.0.0.1:8898/store/#/nosotros

## 1. Existing storefront audit

The workspace already contained substantial uncommitted homepage, offers, search and About implementation, as well as unrelated CRM changes. This task retained and completed that work. Baseline screenshots were captured before edits against the existing running local storefront. The existing approved transparent logo, 45px AppBar, blue/white hero, two-column mobile grids, cart/checkout and bottom navigation were retained. No CRM administration UI files were edited.

The authoritative model remains fulltech_catalog_v1 (SKU, quantity, version, JSON product document), fulltech_store_publication_v1 (publication, featured flag, editorial order), fulltech_categories_v1 and fulltech_product_images_v1. Inventory and pricing are owned by the existing catalog; public records are explicitly projected. Offers already support compare_at_cents, validated against price_cents, with discounts calculated server-side. No sales-ranking source was reliable enough to label seeded products bestsellers. Existing indexed search and pagination were reused.

Audit gaps corrected: unstable publication timestamps used as launch dates; seed backdating; weak seed-environment detection; internal notes included in public search tokens; search query lost on return; loaded catalog pages and scroll lost on return; stale request races; fractional peso display rounded away; mixed image ratios stretching card media; low-contrast dark-mode section text.

## 2. Homepage hierarchy

Existing hero → verified checkout benefits → dynamic category strip → featured products → configured offers → verified recent publications → discover more → small About entry and footer. Currently 21 distinct product cards, not the whole 54-item catalog. Sections have no duplicate product IDs across them. Existing header logo remains centered, including desktop beside the Nosotros link.

## 3. UAT seed

There were already 50 numbered demonstration products. One additional accessory was added using the same model, bringing the deterministic seed to **51** records, SKU UAT-001 through UAT-051. All have internal DEMO UAT descriptions. The isolated storefront has 54 published products including pre-existing UAT/project records. The numbered seed spans seven existing business categories; existing Phytoemagry records bring the visible category count to eight.

14 configured test discounts; 6 stock-controlled zero-stock cases; prices RD$420–RD$28500. Original in-repository vector test illustrations are rasterized to WebP in four aspect ratios; no competitor images. Demo brands/specifications are fictitious.

The seed now requires loopback, port 8790–8799, SQLite, the local UAT file, and an explicit UAT identity flag. That flag is enabled only by the UAT launcher and only when the actual file resolves to data/uat/phyto-uat.sqlite. The server is bound to 127.0.0.1; external WhatsApp is mocked, CAPI/push are disabled and the scheduler is off. No production database or real payments are used. Re-running the seed created 0 records; dry-run exits without writes. No existing real prices were changed.

## 4. Category images and carousel

/api/store/home and /api/store/categories compute names/counts from published catalog records and use representative product imagery. Touch scrolling, momentum, hidden scrollbars, compact cards, lazy loading and direct category URLs are retained. Category selection survives product/back navigation.

| Category | Published products |
|---|---:|
| Accesorios | 9 |
| Cámaras | 8 |
| Tecnología | 8 |
| Hogar | 7 |
| Seguridad | 7 |
| Electricidad | 6 |
| Redes y conectividad | 6 |
| Phytoemagry | 2 |

## 5. Merchandising integrity

Featured uses the existing administrative flag/order. Offers require configured compareAtPrice > price; percentage calculation is authoritative on the server, and product detail now shows the same offer pricing as cards. Public projection includes publishedAt. New fulltech_store_first_publication_v1 records the first publication prospectively and preserves it through merchandising edits. Historical timestamps are **not inferred**; old records without a verified first-publication time do not enter Novedades. Recent arrivals require a verified time in the last 30 days, excluding future dates. The newly seeded accessory supplies one legitimate recent item.

There is no fabricated bestseller/rating/review section. Destacados is the neutral merchandising area; its screenshot is the requested popularity-area alternative.

## 6. Discovery and state

Backend indexed search covers product/public names, SKU, category, brand and public descriptions. Internal description tokens were removed in the versioned v2 search index; existing data is reindexed without deleting the previous index. Name/keyword/SKU/category searches, relevance/newest/ascending/descending sorts and offers/featured filters work against the full catalog. Search text is stored in the route. Loaded page count and scroll are restored on back (browser test: 4948px → 4948px). Request sequence guards discard stale catalog responses. Pagination tested through 24, 48 and all 54 items without duplicates. Empty results/category and image-failure states work. Cart storage is not touched by searching/filtering.

## 7. About page

Original Nosotros content covers introduction, company, product areas, values, real request/delivery/pickup services, conditional warranty, contact and product/contact actions. Entry points: homepage, mobile drawer and desktop information navigation; bottom navigation unchanged. Existing catalog photography is reused with fixed dimensions and lazy loading. No invented offices, staff, history, awards or testimonials.

Sources: docs/FULLTECH-PLANTILLA-DOCUMENTOS.md and docs/IMPORTACION-FULLPOS.md for company identity; docs/DECISIONES.md and docs/PENDIENTE.md for WhatsApp; existing checkout and warranty projection for policies. The reference [Mantika About page](https://distribuyemantika.com/sobre-nosotros) was inspected for organization (introduction, services, variety, contact); no text, imagery or literal layout was copied. Its location section was not carried over because no verified FULLTECH location was needed.

## 8. Video decision

No approved video asset was found. No video/player dependency or fake media was added. If supplied later, use a compact poster and user-initiated player after the About entry, with captions and preload=none; no autoplay.

## 9. Files changed or completed

- public/store/store.js — existing homepage/About completion; state, requests, precision and detail offers.
- public/store/storefront.css — existing discovery styling; fixed media slots, desktop logo centering, About photo and scoped dark contrast.
- public/store/index.html — stylesheet/script cache URLs; existing Nosotros navigation retained.
- public/store/sw.js — v33 cache, matching stylesheet and store.js?v=27 shell. No PWA icon changes.
- server/store-catalog.mjs — durable first publication and public-only search index.
- server/store-public-routes.mjs — bounded sections, publishedAt projection/recent filtering and offers parameter compatibility.
- server/crm-server.mjs — explicit isolated UAT identity, no admin UI change.
- scripts/uat-env.mjs — passes UAT identity configuration.
- scripts/seed-store-uat.mjs — stronger guards, 51st fixture, no fabricated dates, safe dry-run.
- scripts/serve-store-discovery-uat.mjs — loopback static/proxy server, rejects non-UAT backend.
- scripts/check-store-discovery-browser.mjs — reproducible responsive screenshot/metrics runner; uses externally installed Playwright, no package dependency changes.
- tests/store-public-api.test.js — publication/privacy/discount/section integrity regression test.
- docs/FULLTECH-DISCOVERY-UAT.md and docs/capturas/store-discovery/ — evidence.

Earlier logo assets and unrelated changes remain preserved.

## 10. Performance

Fresh Chromium contexts; local loopback API, no network throttling, DPR 1, five viewport sizes in light/dark. These are lab observations, not production Web Vitals or proof of an internet speed improvement. Initial metrics are recorded before the final screenshots scroll to load below-fold images.

| Metric | Before | After |
|---|---:|---:|
| Median observed LCP | 156ms | 156ms |
| Maximum observed CLS | 0.065 | 0.051 |
| Median initial resource transfer | 364.9 KiB | 460.6 KiB |
| Rendered homepage product cards | 8 | 21 |

Transfer increases with the category/discovery content; loading remains local-lab fast and below-fold images are lazy. No new runtime dependencies. Fixed square media removes intrinsic-image layout changes. CLS is low but not universally zero because existing asynchronous page rendering remains.

## 11. Tests

- Vitest: tests/store-public-api.test.js, tests/store-catalog.test.js, tests/store-accounts.test.js — **33 passed, 1 existing skipped**.
- Five viewport sizes: 360×800, 390×844, 430×932, 768×1024, 1440×900; light and dark. No horizontal overflow, broken loaded images or uncaught browser exceptions in all ten cases.
- Separate browser console check: zero errors across home/search/offers/About/cart.
- Mixed-ratio images: first six mobile card media all 188×188px.
- Ascending/descending price and exact SKU tests passed.
- Delayed response race and history/scroll tests passed.
- Syntax checks and git diff --check passed.

Shopping-flow checks:
- category touch-scroll and exact selected filter.
- keyword search + detail + back retains query.
- pagination 48 unique + back restores loaded pages.
- final page includes all products without duplicates.
- empty category.
- out-of-stock cannot add.
- cart add + quantity + authoritative total.
- checkout authentication guard retains cart.
- isolated authenticated checkout creates pending test order, no payment.
- authoritative offer calculations.
- about -> products.
- missing-image network failure fallback.

Checkout used a fictitious example.test customer and an explicitly marked test order in the isolated database, pending confirmation. No actual payment, fulfillment or real customer order. Image-failure testing intercepts requests only in the browser; the existing rule requiring images before publication remains intact.

## 12. Screenshots

Full-page screenshots were scrolled to load lazy images before capture. Fixed bottom navigation appears at its viewport position in full-page captures. Categories, featured products, offers and the neutral popularity alternative are visible in the full homepage screenshots.

| Theme / viewport | Before home | After home | Search | Category | Offers | About |
|---|---|---|---|---|---|---|
| light / 360 | [Before](capturas/store-discovery/before-light-360-home.png) | [Home](capturas/store-discovery/after-light-360-home.png) | [Search](capturas/store-discovery/after-light-360-search.png) | [Category](capturas/store-discovery/after-light-360-category.png) | [Offers](capturas/store-discovery/after-light-360-offers.png) | [About](capturas/store-discovery/after-light-360-about.png) |
| light / 390 | [Before](capturas/store-discovery/before-light-390-home.png) | [Home](capturas/store-discovery/after-light-390-home.png) | [Search](capturas/store-discovery/after-light-390-search.png) | [Category](capturas/store-discovery/after-light-390-category.png) | [Offers](capturas/store-discovery/after-light-390-offers.png) | [About](capturas/store-discovery/after-light-390-about.png) |
| light / 430 | [Before](capturas/store-discovery/before-light-430-home.png) | [Home](capturas/store-discovery/after-light-430-home.png) | [Search](capturas/store-discovery/after-light-430-search.png) | [Category](capturas/store-discovery/after-light-430-category.png) | [Offers](capturas/store-discovery/after-light-430-offers.png) | [About](capturas/store-discovery/after-light-430-about.png) |
| light / 768 | [Before](capturas/store-discovery/before-light-768-home.png) | [Home](capturas/store-discovery/after-light-768-home.png) | [Search](capturas/store-discovery/after-light-768-search.png) | [Category](capturas/store-discovery/after-light-768-category.png) | [Offers](capturas/store-discovery/after-light-768-offers.png) | [About](capturas/store-discovery/after-light-768-about.png) |
| light / 1440 | [Before](capturas/store-discovery/before-light-1440-home.png) | [Home](capturas/store-discovery/after-light-1440-home.png) | [Search](capturas/store-discovery/after-light-1440-search.png) | [Category](capturas/store-discovery/after-light-1440-category.png) | [Offers](capturas/store-discovery/after-light-1440-offers.png) | [About](capturas/store-discovery/after-light-1440-about.png) |
| dark / 360 | [Before](capturas/store-discovery/before-dark-360-home.png) | [Home](capturas/store-discovery/after-dark-360-home.png) | [Search](capturas/store-discovery/after-dark-360-search.png) | [Category](capturas/store-discovery/after-dark-360-category.png) | [Offers](capturas/store-discovery/after-dark-360-offers.png) | [About](capturas/store-discovery/after-dark-360-about.png) |
| dark / 390 | [Before](capturas/store-discovery/before-dark-390-home.png) | [Home](capturas/store-discovery/after-dark-390-home.png) | [Search](capturas/store-discovery/after-dark-390-search.png) | [Category](capturas/store-discovery/after-dark-390-category.png) | [Offers](capturas/store-discovery/after-dark-390-offers.png) | [About](capturas/store-discovery/after-dark-390-about.png) |
| dark / 430 | [Before](capturas/store-discovery/before-dark-430-home.png) | [Home](capturas/store-discovery/after-dark-430-home.png) | [Search](capturas/store-discovery/after-dark-430-search.png) | [Category](capturas/store-discovery/after-dark-430-category.png) | [Offers](capturas/store-discovery/after-dark-430-offers.png) | [About](capturas/store-discovery/after-dark-430-about.png) |
| dark / 768 | [Before](capturas/store-discovery/before-dark-768-home.png) | [Home](capturas/store-discovery/after-dark-768-home.png) | [Search](capturas/store-discovery/after-dark-768-search.png) | [Category](capturas/store-discovery/after-dark-768-category.png) | [Offers](capturas/store-discovery/after-dark-768-offers.png) | [About](capturas/store-discovery/after-dark-768-about.png) |
| dark / 1440 | [Before](capturas/store-discovery/before-dark-1440-home.png) | [Home](capturas/store-discovery/after-dark-1440-home.png) | [Search](capturas/store-discovery/after-dark-1440-search.png) | [Category](capturas/store-discovery/after-dark-1440-category.png) | [Offers](capturas/store-discovery/after-dark-1440-offers.png) | [About](capturas/store-discovery/after-dark-1440-about.png) |

[Safe checkout](capturas/store-discovery/checkout-safe-390.png) · [Image fallback](capturas/store-discovery/missing-image-390.png) · [Shopping-flow evidence](capturas/store-discovery/shopping-flow.json) · [Before metrics](capturas/store-discovery/before-metrics.json) · [After metrics](capturas/store-discovery/after-metrics.json) · [State tests](capturas/store-discovery/state-checks.json) · [Seed summary](capturas/store-discovery/seed-summary.json)

## 13. Limits and remaining decisions

Demo illustrations/specifications/prices are for UAT only; they are not production merchandising. No reliable popularity data or approved video exists, so those claims/media are omitted. Historical first-publication dates remain unknown rather than invented. The existing skipped catalog test remains skipped. Production performance requires a separately authorized deployment/staging measurement. No functional blocker was observed in the tested local flows.

## 14. Decision and reproduction

**GO — isolated local UAT.** No commit, push or deployment. Production untouched.

Start the backend with node --experimental-sqlite scripts/uat-env.mjs --port=8798 --sin-scheduler; seed with node scripts/seed-store-uat.mjs --port=8798; serve with node scripts/serve-store-discovery-uat.mjs. Browser runner: node scripts/check-store-discovery-browser.mjs after, setting PLAYWRIGHT_MODULE (installed module URL) and CHROMIUM_PATH if needed. It writes screenshots under docs/capturas/store-discovery/. Additional flow/state harnesses are retained locally under data/uat/store-discovery-*.mjs.
