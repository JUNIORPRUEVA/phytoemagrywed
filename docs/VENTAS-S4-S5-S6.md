# CRM como centro de ventas — auditoría y arquitectura (S4 / S5 / S6)

> Estado: **en local, sin desplegar**. No se toca Meta, no se envían mensajes reales,
> no se crean pedidos reales. Este documento es la auditoría del modelo actual y el
> plan de las tres fases nuevas.

Flujo objetivo del negocio:

```
LEAD WHATSAPP → CLIENTE → CONVERSACIÓN → SEGUIMIENTO → PEDIDO → PAGO/ESTADO
→ COMPROBANTE → ENTREGA → SEGUIMIENTO POSTVENTA → RECOMPRA
```

---

## 1. Auditoría del modelo actual (lo que ya existe)

| Concepto | Dónde vive | Estado real |
| --- | --- | --- |
| Cliente | `phytoemagry_customers` (telefono E.164 único) | ✅ existe; **no tiene estado comercial** |
| Conversación | `phytoemagry_conversations` (1 por cliente) | ✅ existe |
| Mensajes WhatsApp | `phytoemagry_wa_messages` | ✅ entrantes + salientes (solo **texto** y plantilla) |
| Pedido / compra | `phytoemagry_items` (`type=order_intent`) | ✅ pero **una sola línea** (variant + cantidad), sin `conversation_id` |
| Estados del pedido | `nuevo, contactado, interesado, confirmado, entregado, perdido` | ⚠️ mezclan contacto y venta |
| Seguimiento | `phytoemagry_followups` (día 1/3/7/14/21/30) | ✅ creado al ENTREGAR, idempotente (`fu:<pedido>:<día>`) |
| Plan de seguimiento | `PHYTO_FOLLOWUP_PLAN` (variable de entorno) | ⚠️ **no configurable desde Ajustes** |
| Plantillas Meta | `phytoemagry_wa_templates` | ✅ con estado real (`approved` manda) |
| Catálogo de precios | `src/config/product.config.js` | ✅ única fuente (el panel lo pide a `/api/admin/data`) |
| Comprobante / ticket | — | ❌ no existe |
| Mensaje programado | — | ❌ no existe (nada persistente que sobreviva a un reinicio) |
| Auditoría comercial | — | ❌ no existe |
| Métricas | `customers.metrics()` | parcial: clientes, conversaciones, ventas; sin períodos |
| Multimedia (S3) | — | ❌ el servidor no descarga ni envía media |

### Hallazgos que condicionan el diseño

1. **El pedido es de una sola línea.** `purchaseRow()` fuerza un `variantId`. Para el
   pedido desde la conversación hace falta multi-ítem, descuento y datos de entrega.
   Se añade `order_json` (el detalle) **sin tocar** las columnas actuales: la primera
   línea sigue en `variant_id/quantity/unit_price/total`, así el CSV, las estadísticas
   y los tests de Meta (una venta = `entregado`) siguen funcionando igual.
2. **Los estados mezclan dos ejes.** `interesado/contactado` son de conversación;
   `confirmado/entregado/perdido` son de pedido. No se inventan estados nuevos
   redundantes: se añade **estado comercial del cliente** (derivado) y se mantiene
   el estado del pedido, ampliando solo los que faltan de verdad
   (`borrador`, `en_preparacion`, `enviado`) sin duplicar los equivalentes.
3. **Nada de programación persistente.** El plan de seguimiento sí es persistente,
   pero no hay una **cola de mensajes programados**. Se añade `scheduled_messages`
   con `idempotency_key` ÚNICO: un reinicio no puede enviar dos veces.
4. **El seguimiento nunca envía.** Se mantiene: el motor crea **tareas**; los mensajes
   programados son otra cosa, explícita y separada (sección E del encargo).

---

## 2. Arquitectura

### 2.1 Fuente única del catálogo

`src/lib/catalog.js` deriva el catálogo de `src/config/product.config.js` (una sola
fuente de precios) y calcula totales. Lo usan el servidor (`server/orders.mjs`) y el
panel (`/api/admin/catalog`). **Ninguna pantalla repite un precio.**

### 2.2 Pedido (S4)

- `server/orders.mjs`: construye la fila del pedido, el número legible
  (`PE-XXXXXX`, estable a partir del id) y el **comprobante** (datos + HTML imprimible).
- Pedido desde la conversación: `POST /api/admin/orders` con `customerId`,
  `conversationId`, `items[]`, `discount`, `notes`, `delivery`, `status`.
- El comprobante NO se llama «factura»: es **«Comprobante de compra»**
  (no hay integración fiscal). Teléfono **enmascarado**. Sin afirmaciones médicas.
- Dos vistas: la del CRM (en el panel) y una **HTML imprimible/descargable**
  (`/api/admin/orders/:id/receipt`), ligera, sin PDF pesado. En móvil, botón
  para **enviar la factura por WhatsApp desde el CRM** (API oficial) y «Abrir PDF».
  *(Cambio posterior: el botón usaba la Web Share API —el menú del sistema— y ya no:
  ver `docs/WHATSAPP_INTEGRATION.md`, «Enviar la factura de un pedido».)*

### 2.3 Seguimiento y programación (S5)

- Seguimiento manual con `conversation_id` y `order_id` opcionales.
- Plan de seguimiento **configurable desde Ajustes** (colección `settings`).
- Cola persistente `scheduled_messages`:

```
SCHEDULED → PROCESSING → SENT → DELIVERED → READ
                    ↘ FAILED
                    ↘ BLOCKED  (ventana 24 h / opt-out / plantilla no aprobada)
                    ↘ CANCELLED
```

- Scheduler (`server/scheduler.mjs`): consulta trabajo persistido pendiente, reclama,
  comprueba reglas y envía. Idempotencia por `idempotency_key` y por transición de
  estado. Al arrancar, una fila `PROCESSING` huérfana vuelve a `SCHEDULED`
  (recuperación tras caída) pero **la clave única impide el doble envío**.
- Si al llegar la hora el mensaje ya no se puede enviar legalmente: **no se fuerza**.
  Queda `BLOCKED` y se crea una tarea/alerta para el operador.

### 2.4 Espacio de trabajo de ventas (S6)

- Ficha 360 del cliente: resumen (estado comercial, última interacción, próximo
  seguimiento, pedidos, total comprado), WhatsApp, pedidos, seguimientos, programados.
- **HOY** como centro operativo con acciones directas (responder, abrir cliente,
  completar, reprogramar, ver pedido). Sin gráficas decorativas.
- Métricas con períodos Hoy / 7 días / 30 días. Sin atribución inventada: si la UTM
  existe, se conserva y se relaciona después.
- Auditoría (`audit`): pedido creado/modificado/cancelado, estado cambiado,
  seguimiento creado/completado, mensaje programado/enviado/fallido.
- Notificaciones = insignia + HOY (sin spam).

### 2.5 Fuera de alcance (S, explícito)

Nada de IA: sin borradores generados, sin clasificación por IA, sin decisiones
autónomas. Solo puntos de extensión (documentados en `WHATSAPP_INTEGRATION.md`).

---

## 3. Plan por fases

| Fase | Entrega | Tests clave |
| --- | --- | --- |
| **S4** | catálogo único, pedido multi-ítem desde el chat, comprobante, acciones del chat | pedido desde conversación, precio del catálogo, cantidad/total, comprobante, pedido↔cliente, pedido↔conversación, legacy intacto |
| **S5** | seguimiento manual vinculado, plan configurable, cola persistente, scheduler, idempotencia | followups automáticos idempotentes, manual, completar, reprogramar, persiste reinicio, no doble envío, ventana 24 h, plantilla fuera de ventana, opt-out, cancelación |
| **S6** | cliente 360, HOY operativo, métricas por período, auditoría, notificaciones | historial cliente, métricas sin doble conteo, estado comercial derivado |

## 4. GO / NO-GO

Se entrega candidato local con tests en verde, UAT en navegador y capturas.
**NO-GO a producción** hasta decisión explícita del negocio (S3 multimedia y
registro del número en Cloud API siguen pendientes por parte de Meta).

---

## 5. Estado de implementación (local, sin desplegar)

| Fase | Estado | Dónde |
| --- | --- | --- |
| **S4** Sales Core | ✅ hecho | `src/lib/catalog.js`, `server/orders.mjs`, `POST/GET/PATCH /api/admin/orders`, `/receipt`, acciones del chat y comprobante en el panel |
| **S5** Follow-up Engine | ✅ hecho | `server/settings.mjs` (plan por Ajustes), `server/scheduler.mjs` (cola persistente + scheduler), `POST /api/admin/scheduled`, `followups` con `conversation_id`/`order_id` |
| **S6** Sales Workspace | ✅ hecho | `server/audit.mjs`, ficha 360 con estado comercial y programados, HOY operativo, `metrics?period=`, Ajustes con plan + métricas + auditoría |

### Verificación

- **Tests nuevos (59)**, todos en verde:
  - `tests/sales-core.test.js` (15) — catálogo, pedido desde la conversación,
    comprobante, pedido modificado, pedido↔cliente↔conversación, legacy intacto.
  - `tests/followup-engine.test.js` (14) — plan configurable, tareas idempotentes
    (marcar entregado dos veces no duplica), seguimiento manual ligado al chat,
    mensaje programado que **sobrevive a un reinicio**, sin doble envío, ventana de
    24 h, plantilla aprobada, opt-out, cancelación, fallo con motivo, recuperación
    de un trabajo interrumpido.
  - `tests/sales-workspace.test.js` (8) — estado comercial derivado y manual, ficha
    360, métricas por período sin doble conteo, auditoría.
  - `tests/panel-sales-uat.test.js` (7) — **UAT con el panel real** en un DOM contra
    un CRM real: entrar, HOY, menú de acciones del chat, crear pedido con el precio
    del catálogo, comprobante, programar mensaje, comprobante imprimible, apagar un
    día del plan desde Ajustes, métricas y auditoría.
- **Capturas** en `docs/capturas/ventas/` (Chrome headless, 390×844 y 1280×900):
  acceso, HOY, conversación, pedidos, Ajustes.
- Suite completa: 27 archivos, 456 pasan / 2 saltados. Las 5 pruebas que fallan son
  del trabajo de **multimedia (S3)** que está en curso en paralelo
  (`tests/media-routes.test.js`), no de estas fases.

