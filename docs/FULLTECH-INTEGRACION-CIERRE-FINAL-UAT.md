# FULLTECH — Cierre de integración y UAT final

Rama: `integracion/smart-commerce-delivery` · Worktree: `C:\Users\pc\DEV\UAT\PHYTOEMAGRY-candidato`
Tip: `9b144ec` (base `main 5c72826` + 9 commits de reparto y custodia). **Sin merge, sin push, sin despliegue.**

---

## A. Resumen ejecutivo

Se consolidó en un único candidato aislado: tienda Fulltech, Smart Commerce, CRM, Delivery, custodia y Supervisor IA.

**Terminado en esta pasada**: panel administrativo de custodia y rendiciones conectado al backend real; servicio de conciliación compartido con detección de incidencias (solo lectura); integración segura del Supervisor con el ciclo logístico (cierre de entregas terminadas); APK UAT recompilado con hash; suite enfocada de 284 pruebas en verde; UAT HTTP ampliado a 36 comprobaciones.

**No terminado**: reparación contable automática (deliberadamente inexistente), UAT visual en emulador (no había dispositivo conectado), y la clasificación de los 96 fallos históricos solo avanzó en dos familias.

---

## B. Arquitectura

```
Cliente ──► Store (public/store) ──► /api/store/commerce/*  ┐
                                    /api/store/account/*    ├─► Smart Commerce (reservas, cuotas, proveedores)
                                                            │
Panel CRM ─► /api/admin/*  ──► crm-server.mjs ──► pedidos (items) ──► delivery-lifecycle (estado logístico)
                │                    │                                  │
                │                    ├─► delivery-cash (libro append-only) ──► delivery-reconciliation (solo lectura)
                │                    └─► delivery-supervisor (calendario T+5/T+20/T+30)
                └─► custody.html ◄── /api/admin/delivery-cash[/movements|/incidents]

APK Delivery ─► /api/courier/* (token cv1, epoch, permisos por cuenta)
```

Conceptos **separados** (no un campo único): estado logístico (`delivery.lifecycle`), etapa de supervisión (calendario), comunicación (outbox), incidencia (`delivery.issues`) y cobro/custodia (libro + declarado).

---

## C. Funcionalidades

| Módulo | Implementado | Integrado | Probado | Pendiente | Bloqueante |
|---|---|---|---|---|---|
| Store (catálogo, carrito, ofertas, SEO) | Sí | Sí | Sí | — | No |
| Smart Commerce (GPS, precios, cuotas, reservas) | Sí | Sí | Sí | — | No |
| Proveedores y sucursales | Sí | Sí | Sí | — | No |
| Retiro con código de un uso | Sí | Sí | Sí | — | No |
| CRM pedidos y permisos | Sí | Sí | Sí | — | No |
| Delivery backend (auth, ciclo, código, cobro) | Sí | Sí | Sí | — | No |
| Custodia y rendiciones (API) | Sí | Sí | Sí | — | No |
| **Panel de custodia (UI)** | **Sí** | **Sí** | API + unitarias | UAT visual en navegador | No |
| Conciliación e incidencias | Sí (solo lectura) | Sí | Sí | Reparación contable (otro flujo) | No |
| Supervisor IA | Sí | **Sí (capa de cierre)** | Sí (135) | Mapeo de etapa por estado logístico | No |
| APK Android | Sí | Sí | Pruebas Flutter | UAT en dispositivo | No |

---

## D. Cambios (esta pasada)

| Commit | Contenido |
|---|---|
| `c05de9d` | Supervisor: DELIVERED/CANCELLED/REJECTED/EXPIRED cierran la supervisión; `lifecycle` expuesto. 15 pruebas nuevas. `scripts/audit-custodia.mjs` inicial. |
| `9b144ec` | `server/delivery-reconciliation.mjs` (reglas compartidas), endpoints `delivery-cash/movements` y `delivery-cash/incidents`, `public/admin/custody.html` + `custody.js`, enlace desde la vista Delivery, auditoría reescrita sobre el servicio, UAT +6 comprobaciones, 11 pruebas nuevas. |

---

## E. Pruebas (resultados de esta ejecución)

| Comando | Resultado |
|---|---|
| `npx vitest run <24 archivos enfocados>` | **284/284** |
| `node scripts/uat-integracion-delivery.mjs` | **36 OK · 0 fallos** |
| `node scripts/audit-custodia.mjs` | **sin discrepancias** |
| `node scripts/check-store-postgres-uat.mjs` (cluster efímero propio) | **todas PASS** |
| `npx vitest run` (suite general) | **96 fallidos · 2325 pasados · 3 omitidos (2424)** |
| `flutter analyze` / `flutter test` (Delivery) | limpio / 78/78 |

---

## F. Finanzas

- Cargos y rendiciones en **centavos enteros**; el libro es **append-only** y nadie lo edita desde el panel.
- La custodia se alimenta del **efectivo declarado** (`cash_declared_cents`), nunca del saldo del pedido.
- Rendición parcial/total probada; sobre-rendición **rechazada** por el servidor; saldo final 0.
- Auditoría: 2 pedidos entregados con efectivo, 2 cargos, **diferencia 0**, sin incidencias.
- Duplicados: reintento con la misma clave y **doble pulsación simultánea** → una sola entrega y un solo cargo.
- **Efectivo declarado ≠ verificado**: no existe flujo de verificación y el panel lo dice explícitamente.

---

## G. Supervisor

- Calendario **T+5 / T+20 / T+30** intacto (120 pruebas).
- Nuevo: `lifecycleSupervisionOf()` cierra la supervisión en DELIVERED/CANCELLED/REJECTED/EXPIRED → **no se recuerda iniciar una entrega ya entregada**. `REASSIGNED` no cierra (sigue vivo con otro responsable).
- El estado logístico se expone en el resultado, **no reinterpreta** la etapa.
- Deduplicación: clave única por evento/outbox (ya existente, verificado por pruebas de reinicio y concurrencia).
- Transporte: en UAT nunca se envía WhatsApp real.

---

## H. Android

- APK: `C:\Users\pc\DEV\PROYECTOS\INTERNO\FULLTECH-DELIVERY\build\app\outputs\flutter-apk\app-debug.apk`
- Tamaño: 170,01 MB · Fecha: 2026-10-24 10:43 · Commit: `48d0366`
- SHA-256: `797C878E8AA147057C61AF51AD7D0F49E1F34EA5075B41FDEE5144165A8EBFDC`
- Configuración: `DELIVERY_ENV=uat`, `DELIVERY_DEMO_DATA=false`, `DELIVERY_API_BASE_URL=http://10.0.2.2:4477` (**solo emulador**; para teléfono físico hace falta una URL UAT accesible).
- **Sin emulador conectado en esta sesión: no se realizó UAT visual.**

---

## I. Regresiones

Línea base hoy: 96 fallidos / 2246 pasados (2346). Candidato: **96 / 2325** (2424) → mismos fallos, +79 pruebas nuevas en verde, **ningún archivo nuevo** en la lista de fallos.

Clasificación verificada:

- **F — pruebas desactualizadas**: `wa-assignment-ux`, `quick-replies` (fallan también en aislamiento). `index.html` ya no contiene `wa-actions`, `wa-fab-row`, `wa__chat-menu` ni `data-quick`: el panel se rediseñó y las aserciones describen el DOM antiguo. **No se tocaron** (habría que decidir cuál es el contrato correcto).
- **E/F — UAT de panel con jsdom**: familia `panel-*-uat` (timeouts y `hidden` sobre nodos inexistentes).
- **G — intermitentes**: `offline-24h`, `notifications-user-persistence`, `delivery-assignment-notifications` bajo carga de suite.
- **A/C/D**: ninguno detectado en tienda, Smart Commerce, custodia ni delivery.

---

## J. Riesgos residuales

| Riesgo | Severidad | Estado |
|---|---|---|
| Supervisor sigue usando etapa-calendario, no estado logístico | Media | Mitigado (cierre por estado + `lifecycle` expuesto); decisión pendiente |
| Sin reparación contable automática | Baja (por diseño) | Requiere flujo autorizado aparte |
| UAT visual del panel y del APK | Media | Pendiente de navegador/emulador |
| 96 fallos históricos | Media | Ninguno en las rutas nuevas; 2 familias diagnosticadas |
| APK apunta a `10.0.2.2` | Media | Solo emulador; documentado |

---

## K. Producción (checklist, sin ejecutar)

1. Merge autorizado de `integracion/smart-commerce-delivery` → `release/google-oauth-20261023`.
2. Variables: `PHYTO_DELIVERY_PROOF_TTL_MINUTES`, `PHYTO_DELIVERY_OFFER_TTL_MINUTES`, proveedor de WhatsApp, `PHYTO_CRM_DATABASE_URL`.
3. Feature flags: `smartCommerce.enabled` (hoy `false` en el host UAT), plantillas de aviso.
4. Migraciones: solo colecciones declarativas nuevas; compatibles con datos históricos (los pedidos viejos no tienen `lifecycle`).
5. Monitoreo: incidencias de conciliación, outbox `pending`/`failed`, escalaciones del Supervisor.
6. **Rollback**: `git revert` de los commits de integración o retorno a `a93a635`; el libro financiero no se toca (append-only).
7. APK: recompilar contra la URL real del backend antes de publicar.

---

## L. Veredicto

| Módulo | Veredicto |
|---|---|
| Store / Smart Commerce | **GO técnico e integración** |
| CRM + permisos | **GO** |
| Delivery backend | **GO** |
| Custodia (API + panel) | **GO técnico**; falta UAT visual |
| Conciliación | **GO** (solo lectura, sin reparación automática) |
| Supervisor IA | **GO condicionado** (capa de cierre; mapeo de etapa pendiente de decisión) |
| APK Android | **GO condicionado** (sin UAT en dispositivo) |

**Integral: GO condicionado para revisión humana.** No hay GO de publicación: faltan UAT visual, decisión sobre el Supervisor y autorización de merge.
