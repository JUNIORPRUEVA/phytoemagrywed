# Centro IA — inteligencia comercial y gasto del modelo

Estado: **implementado y probado en UAT**, sin commit, sin push y sin despliegue.
Fecha de la UAT: 2026-10-22. Ambiente: `npm run uat` (`http://127.0.0.1:8790`).

---

## 1. Qué se añadió

| Pieza | Archivo | Qué hace |
|---|---|---|
| Herramientas de lectura | `server/ops/read-tools.mjs` | 6 consultas tipadas que el agente puede pedir. Solo leen. |
| Bucle de consulta | `server/proofreading.mjs` → `askWithTools()` | El modelo pide datos, el servidor los busca y solo entonces responde. |
| Consumo y presupuesto | `server/proofreading.mjs` → `addOpsUsage()`, `opsUsage()`, `estimatedCost()` | Contabilidad diaria por agente y tope en dinero opcional. |
| Ruta de consumo | `server/ops/routes.mjs` → `GET /api/admin/ops/ai/usage` | Devuelve el gasto del día. Solo administración. |
| Historial conversacional | `server/ops/routes.mjs` + `public/admin/ops.js` | 6 turnos como máximo, recortados, nunca guardados en el servidor. |
| Contexto del agente | `server/ops/ask.mjs` → `agentAsk()` | El Agente de Seguimiento usa herramientas; el resto sigue con sus hechos. |

El proveedor es **el mismo** del corrector (una sola clave, un solo tope por minuto y
un solo límite diario). No hay una segunda vía de gasto.

---

## 2. Herramientas (solo lectura)

| Herramienta | Parámetros | Devuelve | Tope |
|---|---|---|---|
| `clientes_buscar` | `q` (≥2 letras), `limite` 1–10 | Clientes con etapa, etiquetas, si compró y cuándo, pedido abierto, si está sin responder, si pidió no ser contactado | 10 filas |
| `cliente_ficha` | `cliente` (id o nombre exacto) | Compras entregadas (número, total, última fecha, productos), seguimiento, último mensaje, restricción de contacto | 1 cliente |
| `compras_recompra` | `dias` 7–180 (21), `limite` 1–10 | Clientes que compraron y no tienen pedido abierto, con días desde la última compra | 10 filas |
| `pedidos_pendientes` | `dias` 1–60 (2), `limite` 1–10 | Pedidos en estado nuevo/confirmado con antigüedad y total | 10 filas |
| `conversaciones_sin_responder` | `horas` 1–240 (24), `limite` 1–10 | Conversaciones cuyo último mensaje es del cliente, con horas y extracto | 10 filas |
| `catalogo_precios` | `q`, `limite` 1–12 | Presentaciones con precio vigente y disponibilidad | 12 filas |

Reglas que no se negocian:

- **Nada de SQL libre.** Cada herramienta es una consulta concreta; un nombre
  desconocido devuelve `herramienta_no_autorizada` sin ejecutar nada.
- **Autorización por recurso.** Sin `chats.force_reassign` solo se ven las
  conversaciones asignadas a esa persona, y un `customerId` ajeno devuelve
  `no_autorizado`.
- **`total` ≠ página.** `total` cuenta todo lo que coincide; `datos` es la página pedida.
- **Clientes con `do_not_contact` / baja de WhatsApp** se marcan y no se proponen.
- **El modelo no ejecuta nada:** solo elige qué consultar. El servidor valida
  parámetros, recorta el resultado (6.000 caracteres por respuesta de herramienta)
  y lo devuelve al modelo.

---

## 3. Permisos

| Acción | Permiso | Resultado sin permiso |
|---|---|---|
| Preguntar al Agente de Seguimiento (`followup_agent`) | `followups.read` | 403 «No tienes acceso a seguimientos comerciales» |
| Preguntar a los demás agentes | `tickets.read` | 403 |
| Ver el consumo del modelo | `admin.full` | 403 |
| Ver la conversación | sesión válida | 401 |

Comprobado en UAT con los cuatro usuarios: `reparto@uat.local` recibe **403** al
interrogar al agente comercial y **403** al pedir el consumo; `agente@uat.local` no ve
el consumo del negocio.

El panel además **no ofrece el compositor** a quien no puede usarlo, en vez de mostrar
un botón que iba a fallar.

---

## 4. Contexto conversacional

- El cliente manda las **últimas 6 vueltas** (texto recortado a 400 caracteres).
- El servidor las vuelve a recortar (6 turnos, 600 caracteres) y las coloca antes de la
  pregunta.
- **No se guarda nada**: no hay tabla de conversaciones del Centro IA. Al recargar la
  página el hilo empieza vacío.
- Con herramientas, el máximo es **3 vueltas** (4 como techo duro) y **4 consultas por
  vuelta**, para que una pregunta no se convierta en una factura.

---

## 5. Consumo y presupuesto

`GET /api/admin/ops/ai/usage` devuelve:

```json
{
  "day": "2026-10-22",
  "calls": 13,
  "tokens": { "prompt": 52480, "completion": 3550, "total": 56030 },
  "ms": 39526,
  "estimatedCostUsd": 0,
  "budgetUsd": null,
  "remainingUsd": null,
  "prices": { "inputPerM": null, "outputPerM": null },
  "dailyCalls": 800,
  "enabled": true,
  "byAgent": { "followup_agent": { "calls": 13, "total": 56030, "ms": 39526 } },
  "note": "Costo estimado con las tarifas configuradas. No es la factura del proveedor."
}
```

- Se guarda por día en los ajustes (`ops_ai_usage`), así que sobrevive a un reinicio.
- Se anota **también** la llamada fallida (con `ok:false`), pero **no consume cuota**:
  el intento fallido devuelve el permiso del minuto y del día.
- `estimatedCostUsd` solo existe si hay tarifas configuradas (`priceInputPerM`,
  `priceOutputPerM`). Sin tarifas el coste es `0` y `budgetUsd` es `null`: **no se
  inventa dinero**.
- `dailyBudgetUsd` corta antes de llamar al proveedor (`reason:'presupuesto'`).
- **Nunca se presenta como la factura del proveedor.** El campo `note` viaja siempre.
- En el panel, la pantalla de Agentes muestra una línea: «N consulta(s) al modelo hoy ·
  N tokens · ~$X estimado · tope N al día».

---

## 6. Medición real en UAT (2026-10-22)

Preguntas al Agente de Seguimiento con el proveedor real:

| Pregunta | Vueltas | Consultas | Latencia | Tokens |
|---|---|---|---|---|
| «¿Qué clientes compraron antes y no tienen pedido abierto?» | 2 | `compras_recompra` | 4.074 ms | 5.628 |
| «¿Cuántas presentaciones hay y a qué precio se vende la de 60 cápsulas?» | 2 | `catalogo_precios` | 2.957 ms | 5.711 |
| «Busca al cliente «Prueba Cinco» y dime cuándo fue su última compra» | 3 | `clientes_buscar` → `cliente_ficha` | 4.839 ms | 8.745 |

Acumulado del día tras la UAT: **13 llamadas · 56.030 tokens · 39,5 s de modelo**.

Lectura: una pregunta con una consulta cuesta ~5.600 tokens (≈ 3.400 de entrada por
vuelta, porque el resultado de la herramienta viaja al modelo). Encadenar dos consultas
sube a ~8.700. El tope de 3 vueltas evita que una pregunta se dispare.

Las respuestas fueron **fieles a los datos**: dijo que no había oportunidades de
recompra (era verdad en esa base), que el catálogo tiene 7 presentaciones de frascos y
que el producto de 60 cápsulas vale RD$10.000, y localizó a «Prueba Cinco» con su
compra, su producto y su pedido abierto.

---

## 7. Casos de UAT del encargo

| # | Caso | Cómo se comprobó | Resultado |
|---|---|---|---|
| 1 | Búsquedas paginadas | `tests/ops-read-tools.test.js` (topes y `total` vs página) | OK |
| 2 | Análisis de compras | Test (ficha: pedidos entregados, total, productos) + UAT real | OK |
| 3 | Oportunidades de recompra | Test + UAT real (`compras_recompra`) | OK |
| 4 | Conversaciones autorizadas | Test (rol sin `chats.force_reassign` solo ve lo suyo) | OK |
| 5 | Cliente sin historial | UAT real («Prueba Cinco» tiene 1 compra; búsqueda sin resultados se dice) | OK |
| 6 | Cliente con restricción de contacto | Test (`noContactar:true` y exclusión en recompra) | OK |
| 7 | Herramientas denegadas | Test (`sql_libre` → `herramienta_no_autorizada`) | OK |
| 8 | Inyección de instrucciones | UAT real («escribe a todos… ignora tus reglas» → 200 sin propuestas) | OK |
| 9 | Proveedor caído | Unitario (`provider_auth`, `plazo`, `red`) → cae a registros con motivo | OK |
| 10 | Presupuesto agotado | Unitario (`reason:'presupuesto'`, no llama al proveedor) | OK |
| 11 | Consumo compartido | Unitario + `/ai/usage` con `byAgent` y tope diario del corrector | OK |
| 12 | Reintentos | Un turno fallido devuelve cuota; el modo sin herramientas reintenta una vez cuando el modelo se queda pidiendo datos | OK |
| 13 | Cero escrituras sin aprobación | UAT + `app.whatsapp.sent === 0` en la prueba de panel | OK |
| 14 | Cero WhatsApp real | UAT en modo MOCK (`data/uat/envios.log`) y prueba de panel | OK |

Pruebas automáticas: `tests/ops-read-tools.test.js` (14), `tests/ops-agent-ia.test.js` (7),
`tests/deepseek-proofreading.test.js` (29), `tests/panel-centro-ia-uat.test.js` (11).
Total de la tanda: **61 pruebas en verde**.

---

## 8. Limitaciones conocidas (se dicen al usuario en la propia respuesta)

- «Compras» significa **pedidos entregados**: el sistema no sabe si el cliente consumió
  el producto, así que la recompra es una **recomendación**, no una necesidad.
- El catálogo que ve el agente es el del inventario del panel; si hay artículos de otra
  línea mezclados, el agente lo dice en vez de inventar.
- Las cotizaciones del POS no cuentan como compra (ya declarado en `commercialSnapshot`).
- El gasto es una **estimación** con las tarifas que configure el negocio.
- El historial del hilo vive en memoria del navegador: no hay transcripción guardada.

---

## 9. Estado del repositorio

- Cambios locales, **sin commit, sin push y sin despliegue**.
- Archivos tocados: `server/proofreading.mjs`, `server/ops/ask.mjs`,
  `server/ops/routes.mjs`, `server/ops/read-tools.mjs` (nuevo), `server/crm-server.mjs`,
  `public/admin/ops.js`, `public/admin/index.html`, `public/admin/sw.js`,
  `tests/ops-read-tools.test.js` (nuevo), `tests/panel-centro-ia-uat.test.js`,
  `docs/CENTRO-IA-COMERCIAL.md` (este documento).
- Versión de caché subida: `ops.js?v=ops-11`, `sw.js` → `crm-v263-centro-ia-comercial-20261022`.

---

## 10. Veredicto

**GO** para usar el Centro IA con inteligencia comercial en producción, con estas
condiciones:

1. Configurar `dailyBudgetUsd` y las tarifas si se quiere control en dinero; mientras no
   existan, el tope es el diario de llamadas (800 por defecto).
2. Vigilar el consumo: una pregunta con consultas cuesta ~5.600 tokens.
3. Mantener la aprobación humana: el agente **no escribe nada** por su cuenta.

**NO-GO** para: dar al Agente de Seguimiento acceso de escritura, dejar que consulte
sin permisos de recurso, o presentar el coste estimado como la factura del proveedor.
