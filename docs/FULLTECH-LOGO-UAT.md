# FULLTECH STORE approved logo — local UAT

GO for local UAT. No deployment, push or commit performed.

## Scope and audit

Replaced the header's placeholder F and HTML wordmark and the drawer's matching placeholder. The header remains 45px high (40px inner row). Its compact image is 170.66 × 39.98 CSS pixels, centered at every tested width. The full horizontal artwork is used in the drawer; the compact composition is retained in the header at all breakpoints because vertical space remains 40px even on desktop. Both use original image pixels, without recreated lettering, recoloring, new effects or changed element proportions. The compact variant scales the emblem and lettering independently and proportionally, as authorized.

Existing assets audited and left unchanged: assets/branding/fulltech-logo-source.png, public/assets/img/fulltech-logo.png, public/admin/fulltech-logo*.png, public/store/icon.svg, icon-192.png, icon-512.png and manifest.webmanifest. No catalog, cart, checkout, price, order or admin implementation changes. Existing unrelated Git changes preserved.

## Assets

Original download remains untouched: C:/Users/pc/Downloads/Logotipo 3D FULLTECH STORE.png. Byte-identical archive: assets/branding/fulltech-store-approved-original.png (1,172,421 bytes). SHA-256: 7a03445532e0660cba37b5b088ac52143e5f2b79da023e177fd63ba691240fd2.

Lossless cropped masters: assets/branding/fulltech-store-horizontal-master.png (1604 × 562) and fulltech-store-compact-master.png (2394 × 562). Full crop: x=28, y=232, width=1604, height=562. Compact crops and deterministic regeneration are documented in scripts/build-store-logo.mjs. Source reflections and shadows retained. No image generation used.

Optimized runtime assets are under public/store/assets/branding/. All WebP outputs use lossless encoding after Lanczos proportional resampling; PNG provides fallback.

| Asset filename | Dimensions | Bytes |
|---|---:|---:|
| fulltech-store-horizontal-240.png | 240 × 84 | 30,657 |
| fulltech-store-horizontal-240.webp | 240 × 84 | 19,786 |
| fulltech-store-horizontal-480.png | 480 × 168 | 106,950 |
| fulltech-store-horizontal-480.webp | 480 × 168 | 63,880 |
| fulltech-store-horizontal-720.png | 720 × 252 | 228,190 |
| fulltech-store-horizontal-720.webp | 720 × 252 | 130,480 |
| fulltech-store-compact-192.png | 192 × 45 | 19,092 |
| fulltech-store-compact-192.webp | 192 × 45 | 11,402 |
| fulltech-store-compact-384.png | 384 × 90 | 64,811 |
| fulltech-store-compact-384.webp | 384 × 90 | 34,966 |
| fulltech-store-compact-576.png | 576 × 135 | 137,306 |
| fulltech-store-compact-576.webp | 576 × 135 | 69,994 |

## Validation

Real storefront HTML/CSS/JavaScript served at http://127.0.0.1:8897/store/ using a local static server and GET-only API proxy to isolated UAT on port 8896. No production access. UAT uses data/uat/phyto-uat.sqlite with external messaging mocked and scheduler disabled.

Chromium 1248 installation tested at 360, 390, 430, 768 and 1440px, height 900px; mobile DPR 3, tablet/desktop DPR 2. All five pass: logo loaded, horizontal centering error below 0.1px, 45px header, no horizontal overflow, no navigation overlap, menu open/close and cart navigation operational, no JavaScript errors. Visual inspection confirms complete artwork and readable text.

PNG fallback passed at DPR 1. Delaying the logo download leaves the header bounding box exactly unchanged. Whole-page CLS includes existing asynchronous catalog loading (0–0.046); no claim of zero page-wide CLS is made. Offline cached logo reload passed after explicitly registering the existing service worker in the test browser (store.js does not currently register it). The service-worker cache version and CSS URL were bumped and logo assets precached; no PWA icons or manifest changed.

Existing tests: npx vitest run tests/store-phase1.test.js — 12/12 passed. git diff --check — passed. Browser measurements: [before](capturas/fulltech-logo/before-metrics.json), [after](capturas/fulltech-logo/after-metrics.json), [additional checks](capturas/fulltech-logo/extra-checks.json). Local browser harnesses are retained in data/uat/fulltech-logo-browser.mjs and fulltech-logo-extra.mjs; local read-only static proxy: data/uat/fulltech-logo-server.mjs.

## Screenshots

| Width | Before | After |
|---|---|---|
| 360px | [Before](capturas/fulltech-logo/before-360.png) | [After](capturas/fulltech-logo/after-360.png) |
| 390px | [Before](capturas/fulltech-logo/before-390.png) | [After](capturas/fulltech-logo/after-390.png) |
| 430px | [Before](capturas/fulltech-logo/before-430.png) | [After](capturas/fulltech-logo/after-430.png) |
| 768px | [Before](capturas/fulltech-logo/before-768.png) | [After](capturas/fulltech-logo/after-768.png) |
| 1440px | [Before](capturas/fulltech-logo/before-1440.png) | [After](capturas/fulltech-logo/after-1440.png) |

[All header sizes](capturas/fulltech-logo/header-comparison.png) · [Full artwork in drawer](capturas/fulltech-logo/after-drawer-390.png) · [PNG fallback](capturas/fulltech-logo/after-png-360.png)

GO: local UAT acceptance. Production rollout remains outside this task.
