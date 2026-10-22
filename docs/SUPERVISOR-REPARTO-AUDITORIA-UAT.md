# Supervisor IA de Reparto — auditoría integral y UAT

**Fecha:** 2026-10-22 · **Alcance:** auditoría de código + correcciones + UAT aislada con el
servidor real.
**No se ha tocado producción, no se ha desplegado, no se ha hecho push y no se ha enviado
un solo WhatsApp real.**
Todo lo que se afirma aquí está respaldado por código citado o por una prueba ejecutada; lo
que no se pudo probar se dice como tal.

---

## 1. Arquitectura real

Hay **dos motores** y un puente entre ellos. No son lo mismo y conviene no confundirlos:

```
pedido asignado
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│ MOTOR DETERMINISTA  server/delivery-supervisor.mjs           │
│ (sin modelo, sin decisiones creativas)                       │
│  supervisionEligibility → ¿entra en supervisión?             │
│  supervisionOf         → etapa + minutos + teléfono           │
│  supervisorTick        → recordatorio / escalado / posposición│
│  handleSupervisorReply → respuestas del repartidor por WhatsApp│
└─────────────────────────────────────────────────────────────┘
      │ scheduler cada 30 s (server/scheduler.mjs)
      ▼
┌─────────────────────────────────────────────────────────────┐
│ PUENTE  server/ops/delivery-tickets.mjs                      │
│  abre el ticket interno del pedido en riesgo y asigna el      │
│  agente `delivery_supervisor`; al cerrarse la entrega, marca  │
│  la TAREA como terminada (el ticket NO se cierra solo).       │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│ MOTOR DE AGENTES  server/ops/agents.mjs                       │
│  runs durables con lease, planificador DETERMINISTA (planStep)│
│  herramientas del catálogo cerrado (server/ops/tools.mjs)     │
│  aprobaciones humanas para lo irreversible                    │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
   Chat:  `/api/admin/ops/agents/delivery_supervisor/ask`  (Centro IA, con modelo)
          `/api/admin/delivery-supervisor/ask`             (pantalla clásica, determinista)
```

**Punto clave de la auditoría:** el scheduler sabía ejecutar tres ticks del Centro IA
(`opsDeadlineTick`, `opsDeliveryTicketTick`, `opsAgentTick`) y `crm-server.mjs` **no se los
pasaba**. Consecuencia real: los pedidos en riesgo nunca abrían su ticket, ningún agente daba
un paso y los plazos de los tickets no se revisaban jamás. Solo funcionaba el motor
determinista (recordatorios y escalados por WhatsApp/campana). **Corregido** (ver §14).

---

## 2. Herramientas disponibles (catálogo real)

| Herramienta | Efecto | Permiso | Qué hace |
|---|---|---|---|
| `ticket.get_context` | read | `tickets.read` | Ticket + participantes + últimos mensajes |
| `order.get_status` | read | `orders.read` | Estado operativo del pedido |
| **`delivery.get_status`** | read | `orders.read` | **Nueva:** etapa de la entrega, minutos, acuse, entrega reportada y si el repartidor tiene teléfono |
| `ticket.post_message` | write | `tickets.reply` | Mensaje interno en el hilo |
| `ticket.request_ack` | write | `tickets.reply` | Pide acuse de la tarea |
| `ticket.set_follow_up` | write | `tickets.update` | Programa la siguiente vuelta |
| `ticket.escalate` | write | `tickets.reply` | Escala el ticket a una persona |
| `ticket.complete_work` | write | `tickets.update` | Termina el TRABAJO (no cierra el ticket) |
| `agent.request_help` | write | `tickets.update` | Pide ayuda a otro agente sobre el mismo ticket |
| `ticket.close` | high_impact | `tickets.close` de **la persona** que aprueba | Único cierre, y solo con aprobación |

Prohibidas a propósito (documentadas para que no se asignen nunca): `db.query_raw`,
`server.exec`, `whatsapp.send_external`, `order.refund`, `customer.update_sensitive`.

El Supervisor **no** recibe permisos de finanzas, precios, reembolsos ni base de datos: los
permisos se derivan de las herramientas y están en lista blanca (`AGENT_PERMISSIONS`).

Desde esta auditoría las herramientas por defecto del Supervisor son las 8 de arriba
(`order.get_status`, `delivery.get_status`, `ticket.escalate` y `ticket.complete_work` estaban
registradas pero **no asignadas**, así que el agente no podía consultar la entrega ni escalar).

---

## 3. Matriz de funcionalidades del ciclo de entrega

| # | Etapa | Servicio / función | Evidencia | Estado |
|---|---|---|---|---|
| 1 | Creación del pedido | `crm-server.createOrder` → `POST /api/admin/orders` | prueba + código | IMPLEMENTADO Y VALIDADO |
| 2 | Asignación a repartidor | `assignDeliveryToOrder` / `/orders/:id/delivery/assign` | prueba | IMPLEMENTADO Y VALIDADO |
| 3 | Identificación del repartidor | usuario DELIVERY (`delivery_user_id`) o contacto externo (`delivery.external.phone_e164`) | `responsibleOf` | IMPLEMENTADO Y VALIDADO |
| 4 | Teléfono del repartidor | `crm_users.personal_phone` / `fleet_phone`; externo en `delivery_contacts` | §5 | PARCIAL → **corregido** (validación) |
| 5 | Ticket de supervisión | `opsDeliveryTicketTick` → `openDeliveryTicketsFromSupervision` | prueba E1 | **AUSENTE en la práctica** → **corregido** (no estaba cableado) |
| 6 | Notificación de la asignación | `createDeliveryAssignmentNotification` (campana + push) | prueba | IMPLEMENTADO Y VALIDADO (no hay WhatsApp en el acto; el primer aviso es el recordatorio) |
| 7 | Solicitud de acuse | `ticket.request_ack` + recordatorio con la siguiente acción | prueba F3 | IMPLEMENTADO Y VALIDADO |
| 8 | Confirmación del repartidor | `handleSupervisorReply` intención `ack` → `acknowledged_at` | prueba F3 | IMPLEMENTADO Y VALIDADO |
| 9 | Preparación del pedido | pickups (`order_pickups`) → etapa `pickup_pending` | `pendingPickupsByOrder` | IMPLEMENTADO SIN PRUEBA SUFICIENTE (fuera del alcance de esta tanda) |
| 10 | Inicio del recorrido | intención `start` → `delivery_status = IN_TRANSIT` | prueba existente | IMPLEMENTADO Y VALIDADO |
| 11 | Estado «En camino» | transición oficial `EN_CAMINO` (exige tracking activo) | `transitionOrderStatus` | IMPLEMENTADO Y VALIDADO (lo mueve una persona; el supervisor solo avisa) |
| 12 | Llegada al destino | intención `arriving` | prueba existente | IMPLEMENTADO Y VALIDADO |
| 13 | Entrega al cliente | — | — | AUSENTE como paso propio (no hay firma/evidencia del cliente; ver riesgos) |
| 14 | Confirmación de entrega | «Entregado» → `awaiting_confirmation` → «CONFIRMAR» → `completeDelivery` | prueba F1/F3 | IMPLEMENTADO Y VALIDADO |
| 15 | Cierre del pedido | `markOrderDelivered` + `ensureInventoryForSale` (si no hay stock, falla y lo dice) | prueba F1 | IMPLEMENTADO Y VALIDADO |
| 16 | Cierre del trabajo del supervisor | `closeDeliveredTickets` (tarea terminada, ticket abierto) | prueba F1 | **AUSENTE** → **corregido** |
| 17 | Notificaciones finales | recibo al cliente (`sendDeliveryReceiptToCustomer`), campanas | código | IMPLEMENTADO SIN PRUEBA SUFICIENTE en esta tanda |
| 18 | Historial y auditoría | `delivery_supervision_events`, `audit.record` (`delivery.supervisor_*`, `order.status_changed`) | pruebas | IMPLEMENTADO Y VALIDADO |

---

## 4. Flujo de acuse (Fase 3): qué distingue el sistema

| Concepto | Dónde vive | Comprobado |
|---|---|---|
| Mensaje preparado | `sendReminder` antes de enviar | código |
| Mensaje autorizado | plantilla aprobada (`phyto_supervisor_recordatorio_v1`) | diagnóstico + pruebas |
| Mensaje enviado | evento `reminder` con `data.whatsapp: 'sent'` + `message_id` | **prueba F3** |
| Mensaje entregado / leído | `wa_messages.status` del mensaje (webhook de estados) | NO ligado al evento de supervisión (ver riesgos) |
| Acuse confirmado | `delivery.supervisor.acknowledged_at` + evento `ack` con autor «Repartidor …» | **prueba F3** |

Regla dura verificada: **un envío no vale como acuse**. La prueba comprueba que tras el
recordatorio el pedido **no** tiene `acknowledged_at`, y que solo se rellena cuando el
repartidor escribe desde su teléfono.

Ambigüedad: con dos pedidos abiertos el supervisor **no adivina**, pide el número de pedido
(prueba existente `delivery-supervisor.test.js > con dos pedidos abiertos NO adivina`).
La IA (`interpret`) solo PROPONE intención y nunca registra una confirmación con confianza
baja (dos pruebas existentes).

---

## 5. Teléfono del repartidor (Fase 2) — hallazgos y corrección

**Cómo funciona:** repartidor interno → `crm_users.personal_phone` y, si falta, `fleet_phone`
(se usan en ese orden). Repartidor externo → `phone_e164` guardado en el pedido desde
`delivery_contacts`. Se normalizan con `toE164` (una sola regla para todo el sistema).

**Defectos verificados y corregidos:**

1. **Se guardaba cualquier cosa.** `createUser`/`updateUser` usaban `short(valor, 40)`: «abc»,
   «el de la flota» o «123» se aceptaban tal cual. Al enviar, `normalizePhone` acepta 8–15
   dígitos, así que un número incompleto podía convertirse en un destino equivocado.
   → `validateUserPhone()` (backend): normaliza a E.164, exige **≥ 11 dígitos** y, si empieza
   por 1, exactamente 11; devuelve `422 invalid_phone` con el motivo. Un valor vacío sigue
   siendo válido («no guardado») y **nunca se sobrescribe solo**.
2. **El supervisor no detectaba la falta de número por entrega.** `supervisionOf` no sabía si
   el responsable tenía teléfono; el recordatorio quedaba `skipped` (o solo en la campana) y
   **no se escalaba**. Ahora el estado devuelve `hasPhone`/`missingPhone` (con `null` = «no se
   sabe», para no afirmar nada sin comprobarlo) y la pasada escala a administración **una vez
   por etapa** con el motivo exacto `courier_without_phone`, dejando el evento escrito.
3. **El panel no lo decía.** La fila del supervisor muestra ahora el chip **«Sin teléfono»** y,
   cuando el repartidor ya reportó la entrega, **«Reportada, falta confirmar»**.

El flujo para arreglarlo **reutiliza el CRM**: Usuarios → repartidor → teléfono personal o de
flota (solo administración). No se inventa ningún número, no se busca fuera del sistema y no
hay escritura automática: la persona lo confirma.

---

## 6. Temporizadores y escalamiento (Fase 4)

Valores **reales** (por defecto en código, configurables en la pantalla):

| Ajuste | Valor real | Nota |
|---|---|---|
| Primer recordatorio | **10 min** | El encargo citaba ~5 min como referencia: NO es lo configurado |
| Repetición | **30 min** | coincide con la referencia del flujo comercial |
| Intentos | **3** | después se escala |
| «Atrasada» | **90 min** | solo cambia la gravedad visual |
| Escalar a administración | **120 min** | exige ≥1 aviso previo |
| Horario de contacto | **08:00–20:00** (America/Santo_Domingo) | fuera de horario se aplaza, no se pierde |
| Volumen por pasada | 8 recordatorios / 10 escalados | un arranque no dispara cientos |
| Posposición máxima | 7 días · 3 veces | con fecha y motivo |

Garantías comprobadas por pruebas existentes que siguen en verde: reserva atómica del aviso
(dos pasadas no duplican), reinicio del servidor sin repetir, reasignación (se avisa al nuevo
y se deja de escribir al anterior), posposición vencida avisada una sola vez, conciliación
diaria una vez al día.

---

## 7. Estados reales (Fase 5)

- **Pedido** (`order.status`): `nuevo` → `confirmado` → `enviado` → `entregado` · `cancelado` ·
  `perdido`. La transición a `enviado` exige **tracking activo**; a `entregado`, stock
  suficiente (`ensureInventoryForSale`); una venta entregada no vuelve atrás sin reversión.
- **Entrega** (`delivery.delivery_status`): `PENDING_CONTACT`, `READY_FOR_DELIVERY`,
  `IN_TRANSIT`, `DELIVERED`, `CANCELLED`, `ISSUE_REPORTED`.
- **Repartidor externo** (`delivery.external.status`): `assigned`, `sent`, `failed`,
  `in_progress`, `awaiting_confirmation`, `delivered`, `issue`.
- **Etapas de supervisión** (`SUPERVISOR_STAGES`): `closed`, `no_responsible`, `not_confirmed`,
  `send_failed`, `pending_start`, `pending_pickup`, `in_transit`, `awaiting_confirmation`,
  `issue`, `postponed`.

**Defecto verificado y corregido:** un pedido **cancelado** podía marcarse como **entregado**
(si la cancelación y la confirmación del repartidor se cruzaban, la transición lo aceptaba en
silencio). Ahora `transitionOrderStatus` devuelve `409 order_cancelled` y el flujo de WhatsApp
responde que no hay pedido abierto. Prueba F5.

---

## 8. Conversación con el Supervisor (Fase 6)

Antes, el chat del Centro IA solo recibía hechos de «oficina» (tickets, actividad): no sabía
nada de entregas. Ahora recibe un bloque `reparto` con: resumen (abiertas, sin arrancar, en
camino, incidencias, atrasadas, sin confirmar, pospuestas, confirmadas 24 h, **sin teléfono**),
reglas de aviso, **última pasada real** del backend, hasta 12 entregas con etapa / siguiente
acción / minutos / repartidor / acuse / última respuesta / si tiene teléfono, lista de
repartidores sin número, incidencias, actividad reciente, bloqueos y aprobaciones pendientes.

Preguntas comprobadas en UAT (servidor real):
- «¿Qué entregas tienes y a quién no le puedes escribir?» → nombra el pedido y avisa de la
  falta de teléfono (prueba F2).
- «¿Qué entregas tengo abiertas y quién las lleva?» (pantalla clásica) → nombra el pedido, el
  repartidor y «SIN teléfono» (prueba F6).

El prompt prohíbe expresamente afirmar que una entrega está terminada si solo está reportada o
pendiente de confirmar, inventar teléfonos y decir que «ya escribió» sin evidencia. Sin
proveedor, el resumen determinista dice lo mismo con los mismos hechos.

---

## 9. Incidencias (Fase 7)

| # | Caso | Comportamiento real | Prueba |
|---|---|---|---|
| 1 | Repartidor sin teléfono | detectado por entrega, escalado `courier_without_phone`, aviso interno, nada enviado | **F2 (nueva)** |
| 2 | Teléfono inválido | 422 al guardar; no se escribe a un número basura | **F4 (nueva)** |
| 3 | Repartidor no responde | recordatorios 10/30 min, tope 3 y escalado | `supervisor-autonomia` |
| 4 | Rechaza la entrega | incidencia + escalado | `delivery-supervisor` |
| 5 | Informa retraso | posposición con fecha y confirmación | `delivery-supervisor` |
| 6 | Dirección incompleta | `EN_CAMINO` exige destino (`missing_destination`) | `delivery-supervisor-validation` |
| 7-8 | Cliente no responde / no está | incidencia reportada por el repartidor → administración | `delivery-supervisor` |
| 9 | Pedido cancelado | no se supervisa; no se puede entregar | **F5 (nueva)** |
| 10 | Repartidor reasignado | se avisa al nuevo; el anterior ya no puede confirmar | `supervisor-autonomia` |
| 11 | Entrega fallida | estado `failed` → etapa `send_failed` → escalado | `delivery-supervisor` |
| 12 | Entrega reportada sin confirmación | queda `awaiting_confirmation`, no cierra | **F3 (nueva)** |
| 13 | Dos pedidos al mismo repartidor | pide el número, no adivina | `delivery-supervisor` |
| 14 | Dos repartidores confirmando | solo el asignado encuentra el pedido abierto | `supervisor-autonomia` |
| 15 | Error de WhatsApp | `failed`/`pending` con motivo real y escalado | `delivery-supervisor` |
| 16 | Proveedor IA caído | la pauta determinista sigue; el chat responde con registros | `ops-agent-ia` |
| 17 | Reinicio a mitad | el aviso ya enviado no se repite (clave de idempotencia) | `supervisor-autonomia` |
| 18 | Webhook duplicado | una sola respuesta/evento | `supervisor-autonomia` |

---

## 10. Permisos (Fase 8)

| Acción | Permiso exigido | Sin permiso |
|---|---|---|
| Ver la pantalla del supervisor, diagnóstico, vista previa, ejecutar la pasada, ajustes | `delivery.tracking.manage_all` | 403 |
| Preguntar al Supervisor en el Centro IA | `tickets.read` | 403 |
| Preguntar al Agente de Seguimiento | `followups.read` | 403 |
| Ver el consumo del modelo | `admin.full` | 403 |
| Cerrar un ticket | `tickets.close` **de la persona** que aprueba | el agente no puede |

El agente actúa con SUS permisos (derivados de sus herramientas); al ejecutar una aprobación
se usan los de **la persona** que aprobó, nunca los del agente.

---

## 11. Auditoría

Se escribe siempre, en tres sitios distintos y con clave de idempotencia:
- `delivery_supervision_events`: `reminder`, `escalation`, `escalation_whatsapp`, `ack`,
  `started`, `pickup_reported`, `arriving`, `delivered_reported`, `delivered_confirmed`,
  `issue`, `postponed`, `postpone_due`, `unclear`, `help_requested`, `daily`.
- `audit`: `delivery.supervisor_reminder_sent|failed`, `delivery.supervisor_escalated`,
  `delivery.supervisor_escalation_sent|failed|unavailable`, `ops.agent_asked`,
  `order.status_changed`, `delivery.assigned|reassigned|unassigned`.
- `ops_agent_steps` / `ops_tool_calls`: cada paso del agente y cada herramienta ejecutada.

Minimización: al administrador que recibe el escalado solo le llegan número de pedido, quién
lo lleva y un enlace; nunca el teléfono ni la dirección del cliente.

---

## 12. Pruebas ejecutadas

**Nuevas (esta auditoría):** `tests/supervisor-reparto-integral-uat.test.js` — **10 pruebas**,
servidor real, WhatsApp simulado que solo apunta:

| Escenario | Qué demuestra |
|---|---|
| F2 sin teléfono | escalado `courier_without_phone` una sola vez, 0 mensajes, fila con `phone_missing` |
| F2 chat Centro IA | responde con el pedido real y pide el número |
| F2 chat clásico | responde con pedido, repartidor y «SIN teléfono» |
| F4 validación | 422 con basura/corto/incompleto, 200 con válido y guardado como `+1809…` |
| F4 con número | la entrega deja de estar bloqueada y el aviso sale al número correcto |
| F3 acuse | enviado ≠ acuse; el acuse lo firma el repartidor |
| F1 escenario A completo | ticket abierto solo → agente consulta la entrega → saludo con el dato real → «Entregado» + «CONFIRMAR» → pedido entregado → **tarea del supervisor terminada y ticket abierto** |
| F5 cancelado | 409 `order_cancelled` en el panel y bloqueo en WhatsApp |

**Regresión (verde):** `delivery-supervisor` (45), `supervisor-autonomia` (17),
`delivery-supervisor-routes` (9), `delivery-supervisor-validation`, `delivery-courier` (25),
`delivery-tracking`, `delivery-assignment-notifications`, `auth-users-assignment`,
`delivery-frontend-uat`, `ops-agents`, `ops-tickets`, `ops-centro-ia`, `panel-ops-fase-c/d`,
`panel-centro-ia-uat`, `ops-read-tools`, `ops-agent-ia`, `deepseek-proofreading`.

**Fallos PREEXISTENTES (comprobados con A/B: mismo resultado sin mis cambios):**
`tests/ops-agents.test.js` → «una respuesta humana reanuda el run» (1);
`tests/ops-notifications.test.js` (8); `tests/panel-pedido-confirmar-uat.test.js` (2).
No se han tocado para «ponerlos verdes».

**Limitación declarada:** no se ejecutó una pasada visual en Chromium ni en dispositivos
físicos en esta tanda (la política del repositorio pide no abrir navegadores salvo petición y
el cambio visual es un chip en una fila existente). La comprobación de UI se hizo con jsdom
(`delivery-frontend-uat`, `panel-ops-*`, `panel-centro-ia-uat`). Para hacerla a mano:
`npm run uat` → `http://127.0.0.1:8790/admin/?v=supervisor`.

---

## 13. Evidencias de ejecución

```
tests/supervisor-reparto-integral-uat.test.js  (10 tests)  OK
tests/delivery-supervisor.test.js              (45 tests)  OK
tests/supervisor-autonomia.test.js             (17 tests)  OK
tests/delivery-supervisor-routes.test.js        (9 tests)  OK
tests/delivery-courier.test.js                 (25 tests)  OK
tests/panel-ops-fase-c.test.js                  (7 tests)  OK
tests/delivery-frontend-uat.test.js                        OK
```

Traza real de la UAT (servidor real, WhatsApp simulado):

```
[crm] supervisor de delivery · awaiting_confirmation · pedido 5c1edc75…
[crm] supervisor de delivery · delivered · pedido 5c1edc75…
[crm] venta entregada 5c1edc75…: 6 tarea(s) de seguimiento
[crm] supervisor de delivery · ack · pedido 60d85eb0…
```

---

## 14. Defectos corregidos

| # | Defecto | Gravedad | Corrección |
|---|---|---|---|
| D1 | Los ticks `opsDeadlineTick`, `opsDeliveryTicketTick` y `opsAgentTick` **no estaban cableados**: nunca se abría el ticket de un reparto en riesgo ni avanzaba ningún agente | **Crítica** | `crm-server.mjs` los pasa al scheduler con un puente `opsBridge` (mismos permisos que las rutas) |
| D2 | El supervisor no detectaba «repartidor sin teléfono» por entrega y no lo escalaba | **Alta** | `courierPhonesByUser` + `hasPhone/missingPhone` en `supervisionOf` + escalado `courier_without_phone` |
| D3 | El teléfono del repartidor se guardaba sin validar (texto libre) | **Alta** | `validateUserPhone` en backend + `422 invalid_phone` con motivo |
| D4 | El chat del supervisor no conocía las entregas (solo tickets) | **Alta** | bloque `reparto` en `agentFacts` + prompt con reglas + resumen determinista |
| D5 | `order.get_status`, `ticket.escalate` y `ticket.complete_work` no estaban asignados; no existía lectura de entrega | Media | herramienta nueva `delivery.get_status` + defaults del agente |
| D6 | Un pedido cancelado podía marcarse entregado | **Alta** | `409 order_cancelled` en `transitionOrderStatus` |
| D7 | El ticket del reparto quedaba abierto para siempre al cerrarse la entrega | Media | `closeDeliveredTickets` (termina la tarea, no cierra el ticket) |
| D8 | La pantalla no distinguía «sin teléfono» ni «reportada, falta confirmar» | Baja | dos chips en `supervisor.js` |

---

## 15. Riesgos pendientes

1. **Entrega sin evidencia del cliente.** El cierre se apoya en la palabra del repartidor
   («Entregado» + «CONFIRMAR»). No hay firma, foto ni código del cliente. Para el negocio puede
   ser suficiente; para una disputa, no. *Recomendación:* foto o PIN opcional al confirmar.
2. **`entregado`/`leído` del mensaje no se refleja en el evento del supervisor.** El dato existe
   en `wa_messages`, pero el evento guarda solo `sent`/`failed`. *Recomendación:* enlazar el
   `message_id` con el estado cuando llegue el webhook.
3. **Activación con fecha.** Un pedido asignado **antes** de `activatedAt` no se supervisa (va a
   «Revisión»). Es intencional, pero se puede malinterpretar como «no funciona».
4. **Tope de lectura de 5000 pedidos** en la pasada: por encima, el supervisor lo informa
   (`capped`) pero los que queden fuera no se supervisan.
5. **La pasada completa recorre todos los pedidos cada 30 s.** Con miles de pedidos habrá que
   indexar por estado/asignación.
6. **Sin dispositivo físico** no se ha probado el panel del supervisor en pantalla real.
7. **Trabajo de otros en el árbol**: hay archivos modificados por otras sesiones
   (`server/customers.mjs`, `public/admin/app.js`, `pos.js`…). No se han tocado.

---

## 16. Estado de Git

- Rama `main`, **sin commit, sin push y sin despliegue**.
- Archivos de esta auditoría:
  - `server/crm-server.mjs` (cableado de ticks, puente, guardia de cancelado, mensajes de error de teléfono)
  - `server/delivery-supervisor.mjs` (teléfono por entrega, escalado por falta de número, diagnóstico con entregas, chat)
  - `server/ops/delivery-tickets.mjs` (cierre del trabajo del supervisor)
  - `server/ops/agents.mjs` (herramienta `delivery.get_status`, plan y cierre)
  - `server/ops/tools.mjs` (catálogo)
  - `server/ops/centro.mjs` (herramientas por defecto del agente)
  - `server/ops/ask.mjs` (hechos de reparto en el chat)
  - `server/users.mjs` (validación del teléfono)
  - `public/admin/supervisor.js` (chips «Sin teléfono» y «Reportada, falta confirmar»)
  - `public/admin/index.html`, `public/admin/sw.js` (versiones: `supervisor.js?v=7`, `crm-v265-…`)
  - `tests/supervisor-reparto-integral-uat.test.js` (nuevo)
  - `docs/SUPERVISOR-REPARTO-AUDITORIA-UAT.md` (este informe)

---

## 17. Veredicto

**GO para operar el Supervisor de Reparto**, con estas condiciones:

- El motor determinista está completo para *detectar, avisar, recordar y escalar*, y ahora
  además **abre el ticket interno**, **avisa cuando falta el teléfono** y **termina su trabajo**
  cuando la entrega se cierra.
- El repartidor puede confirmar por WhatsApp en dos pasos, y ninguna entrega se cierra sin esa
  confirmación o sin que una persona la cierre en el panel.
- El chat responde con datos reales de las entregas, no con suposiciones.

**NO-GO** para:

- Dar por buena una entrega **sin evidencia del cliente** en un negocio con disputas.
- Activar recordatorios masivos sin revisar la **vista previa** (`/delivery-supervisor/preview`).
- Dejar sin teléfono a los repartidores: el sistema lo detecta y escala, pero no puede arreglarlo
  por sí solo.

**Pendiente antes de publicar** (no bloquea la auditoría): un repaso visual en Chromium y, si el
negocio lo quiere, la foto/PIN de entrega.
