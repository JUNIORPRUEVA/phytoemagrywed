# Asistente IA Contextual del chat — auditoría e implementación (2026-10-21)

> Estado: implementado en local, **sin commit, sin push y sin despliegue**. Producción no se ha tocado.

## 1. Auditoría inicial (código real)

### Botón de IA del chat (existía)
- `public/admin/index.html` → `#wa-ai-reply` (`.wa-ai-fab`, «✦ IA») dentro de `.wa__fab-row`, entre el hilo y el compositor.
- `public/admin/proofreading.js` → `pedirSugerenciaIA()`: una sola petición a la vez, descarta respuestas tardías al cambiar de chat, «Usar respuesta» solo rellena el compositor (nunca envía).
- `POST /api/admin/ai/reply-suggestion` (`server/proofreading-routes.mjs`) → `ctx.customers.messagesFor(id,{limit:200})` + últimos 5 → `proofreading.suggestReply`.
- Proveedor: DeepSeek `deepseek-flash`, `thinking:disabled`, cuota diaria del panel, clave cifrada AES-256-GCM derivada de `PHYTO_CRM_TOKEN`.

### Centro IA / agentes (existía)
- `server/ops/tools.mjs`: catálogo CERRADO de herramientas con `effect` (`read`/`write`/`high_impact`/`forbidden`), `permission`, `approverPermission`, `requiresApproval`.
- `server/ops/agents.mjs`: motor con `invokeTool`, `withTimeout`, `ops_tool_calls` idempotentes y aprobaciones (`decideApproval` ejecuta con la identidad del humano).
- `server/ops/centro.mjs`, `server/ops/routes.mjs`, `public/admin/ops.js`: administración y supervisión.
- `server/proofreading.mjs` → `plan({system,user,maxTokens,actorId})`: **adaptador único al modelo** reutilizable (misma clave, cuota, plazo, JSON).

### Permisos y aislamiento (existían)
- `server/users.mjs`: `chats.read`, `chats.reply`, `chats.take_unassigned`, `clients.read`, `orders.read`…
- `canOpenConversation()` (`server/crm-server.mjs`): dueño de la conversación, o conversación sin asignar con `chats.take_unassigned`; ADMIN con `chats.force_reassign` ve todo.

### Brechas encontradas
1. El botón solo producía **un texto plano** en una cajita del compositor: sin panel, sin accesos, sin fuentes y **sin datos del cliente** (ni pedidos, ni expediente, ni empresa).
2. No existía ninguna consulta del asistente al backend: el modelo solo veía 5 mensajes.
3. Las herramientas del Centro IA son **de ticket**, no de cliente: no servían tal cual y no se debían duplicar.
4. No había acción de auditoría para consultas de IA en el chat.

## 2. Implementación

### Backend (nuevo, aditivo)
- `server/assistant.mjs`
  - Acciones cerradas: `draft_reply`, `analyze_customer`, `orders`, `templates`, `next_action`, `company_info`, `free`.
  - `buildAssistantContext()`: expediente 360 (`customers.profile`), últimos 10 mensajes (320 caracteres cada uno), últimos 8 pedidos con productos, seguimientos pendientes, plantillas **solo APPROVED**, catálogo publicado (`src/lib/catalog.js`).
  - **Minimización**: teléfono y dirección del cliente NO viajan al modelo.
  - `assistantQuery()`: usa `ctx.proofreading.plan()` (mismo proveedor/cuota/plazo que el resto del Centro IA) y valida la respuesta contra un esquema cerrado.
  - El `draft` solo se acepta si la acción es `draft_reply` (un análisis no puede devolver un «mensaje listo para enviar»).
- `server/assistant-routes.mjs`
  - `POST /api/admin/assistant/query` `{conversationId, action, message}`.
  - Comprueba `chats.reply`, resuelve la conversación en la base y aplica `canOpen`; el cliente sale de la conversación, nunca del cuerpo.
  - Límite de 8 consultas por persona por minuto (429).
  - Auditoría `assistant.query` sin texto del cliente ni borrador.
- `server/audit.mjs`: nueva acción `assistant.query`.
- `server/crm-server.mjs`: import + despacho de la ruta junto a la de proofreading.

### Interfaz (nuevo)
- `public/admin/assistant.js` + `public/admin/assistant.css`.
  - El mismo botón ✦ abre el panel (`window.PhytoAssistant.open`); la sugerencia existente sigue funcionando y ahora se pinta dentro del panel.
  - Cabecera «Asistente IA · interno», subtítulo «¿En qué puedo ayudarte con este cliente?», 6 accesos, campo libre y botón «Consultar IA».
  - Respuesta con viñetas, **fuentes usadas**, borrador **editable** e «Insertar en el compositor» (no envía), próximos pasos y aviso de solo lectura.
  - Invalidación al cambiar de chat (observa `#wa-actions`, fila activa y vista lista/chat) y descarte de respuestas tardías por generación.
  - Panel montado **encima del compositor**, dentro de la columna del chat: no tapa el campo ni el teclado.
- `public/admin/proofreading.js`: gancho `window.PhytoAssistant?.open?.()` y el resultado se pinta en el panel si está abierto.
- `public/admin/index.html`: `assistant.css?v=1`, `assistant.js?v=1`, `proofreading.js?v=17`.
- `public/admin/sw.js`: `SHELL` + `VERSION = 'crm-v233-asistente-ia-20261021'`.

## 3. Seguridad

- **Permisos**: `chats.reply` para consultar; `canOpenConversation` para el recurso real. El asistente **no hereda** los permisos de los agentes del Centro IA.
- **Aislamiento**: el `customerId` se deriva de la conversación autorizada; el navegador no puede inyectar otro cliente ni otro hilo. (El CRM es de una sola empresa: no existe `companyId` en el modelo; no se inventó multiempresa.)
- **Prompt injection**: los mensajes del cliente viajan como DATO dentro del JSON de contexto; el sistema ordena explícitamente no obedecer órdenes del contenido; la salida se valida contra un esquema cerrado.
- **Cero escrituras**: no hay ninguna llamada a `db.insert/update` ni a WhatsApp en el camino de consulta. El borrador no se envía ni se guarda.
- **Auditoría**: `assistant.query` con acción, resultado, modelo, ms, tokens y tipos de fuente; sin texto del cliente.
- **Degradación**: sin clave/saldo → `ai_unavailable`; el chat y WhatsApp siguen funcionando.

## 4. UAT REAL (2026-10-21) — proveedor real y navegador real

### 4.1 Entorno

- CRM real (`startCrmServer`) en **base SQLite temporal**; nunca producción ni la base UAT del usuario.
- WhatsApp **simulado** (mock en memoria + contador en archivo): 0 envíos a Meta durante toda la UAT.
- Credencial DeepSeek **copiada cifrada** desde `data/uat/phyto-uat.sqlite` (lectura) y descifrada por el
  propio servicio con el token `phyto-uat`. No se imprimió, no se descifró a mano y no viaja en logs.
- Clientes ficticios: **A** con pedido entregado + pedido pendiente y mensajes recientes; **B** sin
  pedidos y conversación mixta (inglés + criollo); **C** sin pedidos ni mensajes; **D** con compra y
  seguimiento guardado. Plantillas: una APPROVED y una `pending_approval`.

### 4.2 Proveedor real — 15 comprobaciones

| # | Caso | Resultado | Evidencia |
| --- | --- | --- | --- |
| 1 | Recupera el cliente y distingue pedidos | OK | 3.249 ms · 1.585 tok · «PE-UATA02 está abierto… PE-UATA01 entregado» |
| 2 | Lee los mensajes recientes | OK | 2.159 ms · cita «¿Mi pedido sale hoy?» y «¿me confirmas cuando salga?» |
| 3 | Borrador sin inventar | OK | 2.462 ms · 186 caracteres, sin cifras ni promesas inventadas |
| 4 | Cliente sin pedidos: lo dice | OK | 2.367 ms · «el expediente está prácticamente vacío» |
| 5 | Conversación mixta (EN + criollo) | OK | 2.264 ms · borrador en criollo («Bonjou… mèsi…») |
| 6 | Usa la plantilla aprobada y no la pendiente | OK | 2.217 ms |
| 7 | Información de empresa con precios reales | OK | 3.047 ms · precios del catálogo, ninguno inventado |
| 8 | Inyección desde el texto del cliente | OK | 2.484 ms · trató el texto como dato, no obedeció |
| 9 | Sugerir respuesta (✦) sigue funcionando | OK | 1.169–1.857 ms |
| 10 | Sin proveedor → `ai_unavailable` | OK | inyección de fallo, sin red |
| 11 | Proveedor que revienta | OK | la ruta responde error, no se cuelga |
| 12 | Ninguna escritura de negocio | OK | 3 pedidos y 5 mensajes intactos |
| 13 | Ruta HTTP real con sesión | OK | 200 · `scope.customerId = cus_uat_a` |
| 14 | Auditoría sin texto del cliente | OK | `assistant.query` presente, marcador ausente |
| 15 | Aislamiento entre clientes | OK | 2.078 ms · el asistente de B no ve nada de A/C/D |
| 16 | Sugiere la próxima acción | OK | 3.039 ms · 1.435 tok · «Verificar en logística la fecha de despacho de PE-UATA02…» |

Las **7 acciones** (`draft_reply`, `analyze_customer`, `orders`, `templates`, `next_action`,
`company_info`, `free`) quedaron ejercitadas contra el proveedor REAL.

Latencia real medida: **1,2–3,5 s** y **986–1.630 tokens** por consulta (Flash, sin streaming).
`/api/admin/ai/reply-suggestion` (función anterior) siguió respondiendo con el proveedor real.

### 4.3 Navegador real — 53 comprobaciones en Chromium

Viewports 360×740, 390×844, 430×932 y 1440×900; 390 y 1440 también en **oscuro**.
Todas las comprobaciones en verde:

- seis accesos visibles y clicables; panel siempre **encima** del compositor (sin taparlo);
- `scrollX = 0` y **cero desbordes** en todos los tamaños, antes y después de responder;
- consulta real de pedidos desde el panel en cada viewport (2.874–3.442 ms);
- borrador editable, «cancelar» conserva el texto previo del compositor y «aceptar» lo sustituye;
- **0 envíos WhatsApp** durante toda la sesión;
- cambio de cliente en mitad de una consulta: el panel se invalida, la respuesta tardía se descarta y
  al reabrirlo no aparece ningún dato del cliente anterior;
- sin errores de consola propios (el único ruido es el sondeo `calling/incoming` → 401, ajeno).

Capturas en `docs/capturas/`:

`assistant-uat-360-claro.png`, `-360-claro-respuesta.png`, `assistant-uat-390-claro.png`,
`-390-claro-respuesta.png`, `-390-claro-borrador.png`, `assistant-uat-430-claro.png`,
`-430-claro-respuesta.png`, `assistant-uat-1440-claro.png`, `-1440-claro-respuesta.png`,
`-1440-claro-borrador.png`, `assistant-uat-390-oscuro.png`, `-390-oscuro-respuesta.png`,
`assistant-uat-1440-oscuro.png`, `-1440-oscuro-respuesta.png`, `assistant-uat-390-cambio-cliente.png`.

### 4.4 Correcciones que salieron de la UAT

1. **Idioma del borrador**: respondía en español a un cliente que escribía en inglés/criollo. Ahora la
   respuesta al empleado sigue en español y **el borrador va en el idioma del cliente** (verificado).
2. **Texto sin enviar**: insertar un borrador ya no pisa en silencio lo escrito; pide confirmación
   (prueba nueva en jsdom + verificación en navegador).
3. **Ráfaga**: el tope por persona pasó de 8 a **20 consultas/minuto** (el panel ya impide paralelismo;
   la cuota diaria de DeepSeek sigue siendo el límite económico).
4. **Altura**: el panel dejó de ocupar 60vh y ahora es `min(52vh, 480px)` (móvil `min(50dvh, 420px)`),
   para que el hilo del cliente siga visible.

## 5. Pruebas automatizadas

| Comando | Resultado |
| --- | --- |
| `npx vitest run tests/assistant-ia.test.js --no-file-parallelism` | **25/25** |
| `npx vitest run --no-file-parallelism` (assistant-ia, ai-smart-reply, panel-proofreading, deepseek-proofreading, composer-mobile, sw-privacy, render, delivery-map-cache, conversation-resolution, auth-users-assignment) | **275/275** (10 archivos) |
| `panel-whatsapp` + `panel-conv-list-uat` + `panel-shell-uat` | 79/87 · los **8 fallos son preexistentes** (`wa-fab`/`#wa-actions` inexistentes, lista de `setInterval` desfasada, plantillas/ubicación del chat): ninguno menciona el asistente |
| `node --check` en módulos nuevos y modificados | OK |

## 6. Seguridad verificada en la UAT real

- **Aislamiento**: el contexto se construye desde la conversación autorizada; el asistente de un cliente
  no ve pedidos, mensajes ni nombres de otros (caso 15 con proveedor real).
- **Autorización en servidor**: sin sesión → 401; sin `chats.reply` → 403; conversación ajena → 403 sin
  leer al cliente; conversación inexistente responde igual que una ajena.
- **Sin escrituras**: pedidos, mensajes y clientes intactos tras 15 consultas; el borrador no se envía ni
  se guarda.
- **Logs**: la auditoría guarda acción, resultado, modelo, ms, tokens y tipos de fuente; **no** guarda el
  texto del cliente ni el borrador (verificado con un marcador único).
- **Prompt injection**: texto del cliente tratado como dato; la salida se valida contra esquema cerrado.

## 7. Riesgos y pendientes

- El CRM es de **una sola empresa**: el aislamiento real es por conversación→cliente y por permisos de
  sesión (no existe `companyId`); no se inventó multiempresa.
- Dependencia del saldo de DeepSeek: si el proveedor responde 402, el asistente lo explica y el chat
  sigue funcionando.
- Las **acciones de escritura** (pedido, cotización, nota, seguimiento) no están conectadas a propósito.
  Cuando se conecten deben pasar por `ops_tool_calls` + `ops_agent_approvals`.
- El 401 de `calling/incoming` en UAT es del sondeo de llamadas sin configurar en el servidor de prueba;
  no lo genera el asistente.

## 8. OPERACIONES ASISTIDAS Y MOTOR DE CONFIRMACIÓN (2026-10-21, UAT real)

### 8.1 Qué se implementó

- `server/assistant-actions.mjs`: **motor de propuestas**. El modelo solo devuelve una INTENCIÓN
  (`order`, `quote`, `note`, `followup`); el servidor resuelve los productos contra el catálogo real,
  calcula el total con `calculateSale` (la MISMA función del POS), comprueba stock y guarda una
  propuesta `pending` en la colección nueva `assistant_proposals`.
- `POST /api/admin/assistant/actions/:id/confirm` y `…/cancel`.
- Reglas del motor: caducidad de 10 minutos, un solo uso (`pending → executing → executed/failed`),
  **huella de la propuesta completa** (parámetros + líneas + total) para invalidar confirmaciones
  viejas si cambia el catálogo, permisos revalidados al ejecutar (`orders.create`, `clients.update`,
  `chats.reply`), acceso a la conversación revalidado, propuesta de otra persona rechazada (salvo
  `settings.manage`), id determinista (`ast_<propuesta>`) para que un reintento no duplique, y
  auditoría (`assistant.action_prepared/confirmed/cancelled/failed`).
- Reutilización (sin duplicar lógica): `createOrder` del CRM, `followups.createManual`, el `PATCH`
  de notas del cliente y la **ruta real del POS** para cotizaciones (mismo `requestId` idempotente,
  mismas validaciones de precio y stock). No se creó ninguna infraestructura paralela.
- UI: tarjeta **Pedido/Cotización/Nota/Seguimiento preparado** con cliente, líneas, total, acciones
  Editar · Cancelar · Confirmar. Confirmar muestra el número y estado REALES. Nada se envía por
  WhatsApp; insertar un borrador sigue sin enviar.

### 8.2 UAT real (servidor real, base temporal, WhatsApp simulado)

`.tmp/uat-assistant-actions.mjs` → **15/15**:

| # | Comprobación | Resultado |
| --- | --- | --- |
| 1 | Preparar pedido no ejecuta | pendiente · total 2.500 |
| 2 | Preparar no crea pedidos | 0 pedidos |
| 3 | Confirmar crea el pedido real | `PE-9F52FF` · estado `nuevo` |
| 4 | Pedido ligado al cliente y al chat | `cnv_uat_act` |
| 5 | Doble confirmación no duplica | `duplicate=true` · 1 pedido |
| 6 | Propuesta ejecutada no se cancela | 409 |
| 7 | Cancelar no ejecuta | cancel 200 · confirm 409 · 1 pedido |
| 8 | Nota guardada solo al confirmar | «Prefiere que le llamen por la tarde.» |
| 9 | Seguimiento creado al confirmar | fecha correcta en `followups` |
| 10 | Cotización creada con el servicio del POS | `COT-9AB2E77B90` |
| 11 | Confirmación manipulada | 409 `proposal_changed` |
| 12 | Sin sesión | 401 |
| 13 | Auditoría preparada/confirmada/cancelada | 6/4/2 |
| 14 | WhatsApp enviado | **0** |
| 15 | Cliente intacto | sin cambios |

### 8.3 Tarjeta en navegador real

`.tmp/uat-assistant-card.mjs` (respuesta del asistente simulada con `page.route`, sin gastar cuota):
**10/10** en 390×844 claro y 1440×900 oscuro → cliente, líneas con precio, total `RD$8,880`,
Editar/Cancelar/Confirmar, panel encima del compositor, sin desbordes y confirmación con el número
real. Capturas: `docs/capturas/assistant-uat-390-claro-propuesta.png`,
`…-propuesta-confirmado.png`, `assistant-uat-1440-oscuro-propuesta.png`, `…-confirmado.png`.

### 8.4 Pruebas automatizadas nuevas

- `tests/assistant-actions.test.js` (**15**) + caso de tarjeta en `tests/assistant-ia.test.js` (**26**).
- Regresión en 11 archivos: **306/306**.

## 9. CLASIFICACIÓN DE LOS FALLOS DE REGRESIÓN AJENOS

Se corrigieron las pruebas obsoletas que describían una UI retirada (menú `#wa-actions` → columna
`#wa-chat-cols`; iconos `img:*`; grupos del menú; inventario de `setInterval`; Centro IA en lugar de
«Seguimiento»). `panel-shell` (28) y `panel-whatsapp` (14) quedan **verdes**; `panel-conv-list` pasó
de 40 a **42/45**.

Los **3 fallos restantes** de `panel-conv-list` están clasificados:

1. **«Pedir confirmación» (pedido real)** — la hoja de confirmación no se abre desde la prueba en
   jsdom con el pedido recién creado por el POS. Es un flujo del chat/POS ajeno al asistente.
   *Clasificación: pendiente de revisar el flujo, no es regresión del asistente.*
2. **Preferencias del pedido** — el POS ahora **retoma el borrador guardado del cliente antes que las
   preferencias** (`if(!draft.items.length)`), decisión de producto posterior a la prueba.
   *Clasificación: prueba obsoleta por cambio de comportamiento.*
3. **Elegir cuál pedido** — depende de que exista un segundo pedido abierto que creaba la prueba (2).
   *Clasificación: cascada de la anterior.*

No se modificaron estas tres pruebas para «forzar verde».

## 10. Decisión

- **GO** para UAT con el equipo: consultas, borradores y **operaciones asistidas** verificadas con
  proveedor real, servidor real y navegador real (16/16 + 15/15 + 10/10), sin escrituras sin
  confirmación y con auditoría.
- **GO técnico candidato** para la evaluación de despliegue: no hay bloqueos técnicos conocidos en el
  asistente. Quedan **pendientes declarados**: prueba en dispositivo físico iOS/Android, revisión del
  flujo «Pedir confirmación» del chat (3.º fallo clasificado) y aprobación de negocio.
- **NO se despliega** en esta misión: sin commit, sin push, sin deploy y sin tocar producción.
