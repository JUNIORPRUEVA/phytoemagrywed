# FULLTECH header logo refinement — GO for local UAT

Only the existing header logo was refined. It now renders at 144 × 32.28 CSS px (previously 170.66 × 39.98px). AppBar remains 45px tall, with the same padding and 40px navigation controls. object-fit: contain and an explicit aspect ratio prevent stretching. The drawer artwork is unchanged.

Transparent assets were derived deterministically from the approved compact master, using connected background masking and white-matte removal. Solid emblem/lettering pixels are preserved; background openings are transparent and soft reflections retain partial alpha. No image generation, redesigned lettering, recoloring, added shadows or new background. The original high-resolution PNG and previous masters remain untouched. Original/archive SHA-256 both equal 7a03445532e0660cba37b5b088ac52143e5f2b79da023e177fd63ba691240fd2.

Source: assets/branding/fulltech-store-compact-master.png. Transparent master: assets/branding/fulltech-store-header-transparent-master.png. Generator: scripts/build-store-logo-transparent.mjs. Metadata: assets/branding/fulltech-store-header-transparent.json.

| Runtime asset (public/store/assets/branding/) | Pixels | Bytes |
|---|---:|---:|
| fulltech-store-header-transparent-144.png | 144 × 32 | 12389 |
| fulltech-store-header-transparent-144.webp | 144 × 32 | 9836 |
| fulltech-store-header-transparent-288.png | 288 × 65 | 39601 |
| fulltech-store-header-transparent-288.webp | 288 × 65 | 28182 |
| fulltech-store-header-transparent-432.png | 432 × 97 | 79435 |
| fulltech-store-header-transparent-432.webp | 432 × 97 | 52894 |

## Validation

Real Chromium against http://127.0.0.1:8897/store/ with isolated local UAT API, at 360/390/430/1440px in both light and dark system themes: 8/8 passed. Mobile DPR 3, desktop DPR 2. Exact horizontal centering; no overflow, clipping or overlap; menu and cart positions identical to baseline; open/close menu and cart navigation passed. Badge count 3 validated using isolated browser storage; no catalog or order writes. No JavaScript errors. Existing dark-mode header remains pale, as designed by the existing theme; no theme colors were modified. Transparency additionally inspected on a dark #111b2a backing.

Both PNG and lossless WebP have transparent corners, transparent background pixels and partial-alpha reflection pixels. PNG fallback, delayed-image layout stability and offline cached logo reload passed. Service-worker version/CSS URL updated only to invalidate the old header asset; offline test explicitly registers the existing worker. 3× WebP is 52.9 KB, versus 70.0 KB previously. One measured local load was 5.6ms; this is not an internet performance benchmark.

No production changes, deployment, commit or push. Existing unrelated Git changes preserved, including server/store-catalog.mjs. Catalog, products, prices, checkout, PWA icons and navigation logic untouched. git diff --check passed.

## Evidence

[Header comparison: light before/after, dark before/after](capturas/fulltech-logo-refinement/comparison-390.png) · [Alpha on dark](capturas/fulltech-logo-refinement/alpha-dark.png) · [Badge](capturas/fulltech-logo-refinement/badge-360.png) · [Validation](capturas/fulltech-logo-refinement/validation.json) · [Fallback/offline/delayed load](capturas/fulltech-logo-refinement/extra-checks.json)

| Theme | Width | Before | After |
|---|---:|---|---|
| light | 360px | [Before](capturas/fulltech-logo-refinement/before-light-360.png) | [After](capturas/fulltech-logo-refinement/after-light-360.png) |
| light | 390px | [Before](capturas/fulltech-logo-refinement/before-light-390.png) | [After](capturas/fulltech-logo-refinement/after-light-390.png) |
| light | 430px | [Before](capturas/fulltech-logo-refinement/before-light-430.png) | [After](capturas/fulltech-logo-refinement/after-light-430.png) |
| light | 1440px | [Before](capturas/fulltech-logo-refinement/before-light-1440.png) | [After](capturas/fulltech-logo-refinement/after-light-1440.png) |
| dark | 360px | [Before](capturas/fulltech-logo-refinement/before-dark-360.png) | [After](capturas/fulltech-logo-refinement/after-dark-360.png) |
| dark | 390px | [Before](capturas/fulltech-logo-refinement/before-dark-390.png) | [After](capturas/fulltech-logo-refinement/after-dark-390.png) |
| dark | 430px | [Before](capturas/fulltech-logo-refinement/before-dark-430.png) | [After](capturas/fulltech-logo-refinement/after-dark-430.png) |
| dark | 1440px | [Before](capturas/fulltech-logo-refinement/before-dark-1440.png) | [After](capturas/fulltech-logo-refinement/after-dark-1440.png) |
