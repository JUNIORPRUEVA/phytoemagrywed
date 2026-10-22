# FULLTECH checkout and CRM integrity — local UAT

**GO for continued local UAT of the supported pending-order flow. NO-GO for full production acceptance of the requested priced-shipping/payment checkout.** Preview: http://127.0.0.1:8898/store/

## 1. Shopping-flow audit

Read FULLTECH-ICONS-UAT.md and inspected the storefront, account routes, public catalog, shared order creation, inventory validation and storage adapters. Existing discovery already has indexed search, bounded pagination, optimized images, authoritative offer prices and out-of-stock eligibility. Approved logo, icons and cart motion were retained. No speculative homepage redesign.

Backend contract: authenticated customer account with saved phone; delivery or pickup; pending unpaid order in the existing CRM. Guest order creation is not supported. There is no storefront shipping-rate API or payment-method selection contract. Admin payment methods are not an authorization to expose online payment processing. No guest bypass or fabricated charge/fee was added.

## 2. Confirmed defects

- Checkout generated a new retry key on every render; refresh after an uncertain response could create another order.
- Address/notes disappeared on refresh.
- Shared order creation could update an already-saved order on retry; browser-provided IDs were not customer-scoped.
- Summary showed only article count/total, with no itemized review or explicit subtotal versus final delivered cost.
- Failed product fetch could show a zero/incomplete checkout subtotal.
- Dark-theme fulfillment cards had light text over white backgrounds.
- Public order validation silently truncated carts above 30 lines and accepted repeated product IDs.

## 3. Implemented improvements

Account-scoped sessionStorage draft retains delivery choice, address and notes within the tab. The first submitted payload is frozen until an uncertain response is resolved. Refresh offers “Comprobar pedido enviado” using the same payload/key. Validation errors permit corrections; ambiguous failures retain the original attempt. An explicit submitting guard complements the disabled submit button. Changed carts are not blindly cleared after a pending attempt succeeds.

Server keys are hashed with the authenticated customer ID. Existing orders are returned before rechecking mutable catalog data, without changing their status/customer/details. Ownership-checked legacy keys remain recoverable. Creation uses the existing order lock and a duplicate-insert guard to avoid overwriting another worker's persisted winner. No parallel order/customer/inventory database.

Checkout shows customer name/phone, item quantities/prices, product subtotal, delivery-cost uncertainty and the actual deferred-payment process. Address has street-address autocomplete, required/minimum-length validation for delivery only. Existing pickup option is retained. A compact summary and theme-aware fulfillment surfaces correct contrast. Missing/unavailable product data blocks a misleading new checkout. Duplicate/oversized cart lines now receive an explicit 422.

## 4. Files changed in this mission

- public/store/store.js: checkout draft, recovery, itemized review and guards; preserved previous icon changes.
- public/store/store.css: scoped checkout summary/choice styling.
- public/store/index.html and public/store/sw.js: store.js v29, store.css v6, shell cache v35; preserved previous icon precache work.
- server/crm-server.mjs: store-only retry/ownership/duplicate handling. Other concurrent CRM edits preserved.
- server/store-catalog.mjs: reject oversized/duplicate order lines.
- tests/store-checkout-uat.test.js: isolated backend integration coverage.
- scripts/check-store-checkout-visual.mjs and scripts/check-store-checkout-flow.mjs: Chromium evidence runners.
- docs/FULLTECH-CHECKOUT-UAT.md and docs/capturas/store-checkout/: report and evidence.

Unrelated admin, delivery, operations and existing test changes remain in the working tree. No commit, push, deployment, production database access, real WhatsApp or payment transaction. Local tests created fictitious accounts/pending orders only. Approved image assets were not edited.

## 5. Checkout before / after

Before: sign in → delivery/pickup + blank address/notes → generic total → Realizar pedido; refresh lost data and retry identity.

After: same supported account gate → reused customer details + itemized subtotal → saved delivery/pickup/address/notes → explicit request for confirmation → stable order receipt. An uncertain response leads to checking the same order, including after refresh. No extra account/profile fields were added. Shipping/payment remain explicitly pending coordination, rather than appearing as free/paid.

## 6. Measured performance

Eight fresh Chromium contexts at DPR 2, loopback, service workers blocked, identical viewport/theme pairs. Initial storefront DOMContentLoaded median: **50.6 ms before / 46.4 ms after**. These tiny local samples do not establish a production speed improvement. Initial transfer increased **3,420 bytes** per corresponding view, from 526,223–537,385 to 529,643–540,805 bytes. No new library or image payload.

Slow recovery tested at 400 ms simulated latency, 100 KB/s download and 50 KB/s upload. The original request remained idempotent. Search-to-add worked in all eight recovery journeys. No new search latency or production Core Web Vitals claim is made; prior discovery measurements remain in FULLTECH-DISCOVERY-UAT.md.

## 7. CRM / inventory results

The new integration test verifies concurrent same-key requests return one order ID; another customer using that key gets a different order. Customer/price/payment-status values supplied by the browser cannot override session ownership or authoritative pricing. Two units at RD$1,250.50 produce RD$2,501. Excess stock quantity fails. Guest POST fails. Duplicate product lines and >30 lines fail explicitly.

Order is present in the correct CRM customer profile and account order list; the other customer's order is excluded. CRM order endpoint returns the same record before/after retry, even with altered payload and unpublished product. Pending orders leave inventory unchanged, as designed. Existing inventory regression tests cover delivered-sale deduction, cancellation restoration and concurrent last-unit protection.

The existing pending → confirmation → delivery/lifecycle workflow was retained. A new end-to-end delivery assignment/completion or lifecycle transition was not performed in this mission; it is not claimed as newly validated. Pending submissions do not mark customers as having completed a purchase.

## 8. Automated and browser evidence

Four Vitest files: **34 passed, 1 existing skipped** (store-checkout-uat, store-public-api, store-catalog, store-accounts). The checkout test was rerun after final server guards and passed. Syntax and git diff --check passed.

Chromium **8/8**: 360/390/430/1440px × light/dark. Search USB → add → quantity 2 → refresh cart → fictitious registration → delivery data → refresh retains input → server accepts but response is deliberately aborted → refresh → same-order retry → one receipt → account history → empty cart. All passed with no pageerror exceptions and no horizontal overflow. The intentionally aborted request produces an expected network failure; it is not presented as a zero-network-error run. No real payment or delivery selected/executed.

Evidence: [recovery results](capturas/store-checkout/recovery-results.json), [before metrics](capturas/store-checkout/before-metrics.json), [after metrics](capturas/store-checkout/after-metrics.json).

Runners require an installed Playwright module/Chromium; optional PLAYWRIGHT_MODULE and CHROMIUM_PATH select existing installations. Both enforce localhost UAT health and block external browser requests. Visual runner accepts before/after; don't overwrite the saved before evidence during ordinary reruns.

## 9. Screenshots

| Theme / width | Before | After | Lost response | Recovered order |
|---|---|---|---|---|
| light / 360 | [Before](capturas/store-checkout/before-light-360.png) | [After](capturas/store-checkout/after-light-360.png) | [Recovery](capturas/store-checkout/recovery-light-360.png) | [Success](capturas/store-checkout/success-light-360.png) |
| light / 390 | [Before](capturas/store-checkout/before-light-390.png) | [After](capturas/store-checkout/after-light-390.png) | [Recovery](capturas/store-checkout/recovery-light-390.png) | [Success](capturas/store-checkout/success-light-390.png) |
| light / 430 | [Before](capturas/store-checkout/before-light-430.png) | [After](capturas/store-checkout/after-light-430.png) | [Recovery](capturas/store-checkout/recovery-light-430.png) | [Success](capturas/store-checkout/success-light-430.png) |
| light / 1440 | [Before](capturas/store-checkout/before-light-1440.png) | [After](capturas/store-checkout/after-light-1440.png) | [Recovery](capturas/store-checkout/recovery-light-1440.png) | [Success](capturas/store-checkout/success-light-1440.png) |
| dark / 360 | [Before](capturas/store-checkout/before-dark-360.png) | [After](capturas/store-checkout/after-dark-360.png) | [Recovery](capturas/store-checkout/recovery-dark-360.png) | [Success](capturas/store-checkout/success-dark-360.png) |
| dark / 390 | [Before](capturas/store-checkout/before-dark-390.png) | [After](capturas/store-checkout/after-dark-390.png) | [Recovery](capturas/store-checkout/recovery-dark-390.png) | [Success](capturas/store-checkout/success-dark-390.png) |
| dark / 430 | [Before](capturas/store-checkout/before-dark-430.png) | [After](capturas/store-checkout/after-dark-430.png) | [Recovery](capturas/store-checkout/recovery-dark-430.png) | [Success](capturas/store-checkout/success-dark-430.png) |
| dark / 1440 | [Before](capturas/store-checkout/before-dark-1440.png) | [After](capturas/store-checkout/after-dark-1440.png) | [Recovery](capturas/store-checkout/recovery-dark-1440.png) | [Success](capturas/store-checkout/success-dark-1440.png) |

## 10. Remaining risks / acceptance limits

- Exact delivery pricing and a supported customer payment-selection contract do not exist. They require backend/business integration before a fully priced checkout can be accepted.
- Guest checkout is unsupported; account ownership checks remain mandatory.
- Draft recovery persists within the browser tab/session. Separate new checkouts in independent tabs/devices can generate separate order keys; cross-device purchase deduplication is not claimed.
- PostgreSQL multi-worker behavior, deployment/cache migration and the complete delivery/lifecycle workflow need dedicated release validation. Local SQLite tests are not a production certification.
- Drafts contain delivery details in sessionStorage; they are scoped to the account and removed on success. Closing the tab ends this recovery mechanism.

## 11. Decision

GO for local review of the improved supported pending-order journey. NO-GO for claiming the full mission's production acceptance: shipping quotation/payment selection and release-environment workflow validation remain unresolved. No deployment was requested or performed.
