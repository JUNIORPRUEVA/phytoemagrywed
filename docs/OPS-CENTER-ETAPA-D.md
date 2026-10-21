# Centro de Operaciones — ETAPA D (marco universal de agentes)

Fecha: 2026-10-22 · Ámbito: UAT aislada (`dataFile` temporal, WhatsApp simulado) · Sin producción, sin
despliegue, sin push.

Este documento cierra la Etapa D: **marco universal para que varios agentes de IA trabajen en las
conversaciones internas** de forma durable, con herramientas acotadas y **aprobación humana** para lo
irreversible.

La base contractual está en `docs/OPS-CENTER-ETAPA-D-CONTRATO.md` (aprobada antes de escribir código).
Aquí se documenta **lo implementado, lo probado y lo que queda cerrado**.

> **Manual de uso para el equipo**: `docs/PANEL.md` → «Centro de operaciones (tickets internos)».
> **Resumen de las reglas**: `docs/DECISIONES.md` §50.

---

## 1. Arquitectura de agentes

Cuatro piezas, cada una con una responsabilidad y sin dependencias circulares:

```
ticket (evento)  ──►  publishTicketEvent ──► ctx.opsAgents.onTicketEvent
                                                    │
                                                    ▼
                                        ensureRunForEvent  (marca trabajo)
                                                    │
   scheduler (cada vuelta) ──► opsAgentTick ──► claimRun (lease en BD)
                                                    │
                                            planStep (determinista)
                                                    │
                                    invokeTool (validar → ejecutar → registrar)
                                                    │
                              ┌─────────────────────┴──────────────────────┐
                              ▼                                            ▼
                    efecto permitido                            requestApproval
                    (read/write)                                run = waiting_human
                                                                        │
                                                        decideApproval (persona)
                                                                        │
                                                            ejecuta UNA vez
```

| Pieza | Archivo | Qué hace y qué NO hace |
|---|---|---|
| Catálogo de herramientas | `server/ops/tools.mjs` | Describe y **valida**. No ejecuta nada. |
| Motor de agentes | `server/ops/agents.mjs` | Registro, runs, pasos, aprobaciones, tick. |
| Rutas | `server/ops/routes.mjs` | Expone registro, asignación y decisión de aprobaciones. |
| Panel | `public/admin/ops.js` | Pinta agente y aprobación; decide una persona. |

**Decisión clave:** el agente **nunca recibe `ctx.db`**. Solo puede llamar a las herramientas de su
lista, y esas herramientas son funciones explícitas de `agents.mjs` que a su vez usan los módulos de
tickets/mensajes ya probados en B y C. No hay «ejecutar esto que te mando».

**Separación de identidades:** el agente es un actor `AGENT` con id `agent:<key>`. No es un usuario del
CRM, no puede iniciar sesión y no aparece en `users`. Sus mensajes llevan `author_type: 'agent'`; los de
una persona, `'user'`.

### Planificador

`planStep({ ticket, run, agent, now })` es **determinista y sin red**. Devuelve una de cuatro decisiones:

| Decisión | Cuándo |
|---|---|
| `{type:'tool', tool, args}` | Hay trabajo concreto (contexto, estado del pedido, saludo, respuesta, acuse, escalado). |
| `{type:'approval', tool, args, justification}` | El paso es `high_impact` (hoy, `ticket.close`). |
| `{type:'wait', minutes}` | No hay nada que hacer; se despierta con el próximo evento o plazo. |
| `{type:'fail', error}` | Situación irrecuperable. |

Es el **único punto** que habría que sustituir para conectar un modelo de lenguaje: recibe
`{ticket, run, agent}` y devuelve una de esas cuatro formas. El resto del sistema (permisos,
aprobaciones, idempotencia, recuperación) no cambia. **No se ha conectado ningún proveedor externo.**

Dos reglas que se aplican **antes** de proponer un paso:

- **Solo se planifica lo que el agente tiene.** Cada decisión de herramienta comprueba la lista del
  agente (`has('ticket.post_message')`, etc.). Sin eso, un agente de solo lectura haría que el plan
  pidiera un mensaje, la ejecución lo rechazara y el run se quedara reintentando cinco veces.
- **El estado del pedido vinculado se consulta una vez**, antes de saludar, con `order.get_status`
  (solo lectura). Si el pedido no existe o el agente no tiene el permiso, se anota el error y el plan
  continúa sin el dato: una lectura opcional no puede matar el trabajo.

---

## 2. Contrato de eventos (estable, v1)

Los eventos de ticket ya existían desde B/C. La Etapa D añade **tres**, en la lista cerrada
`REALTIME_TYPES` de `server/realtime.mjs`:

| Evento | `requires` | Audiencia | Cuándo se emite |
|---|---|---|---|
| `agent.execution.started` | `tickets.read` | `ticket` | Antes de ejecutar el paso (con `decision.type`). |
| `agent.execution.completed` | `tickets.read` | `ticket` | El run quedó en `waiting_event`/`waiting_human`/`succeeded`. |
| `agent.execution.failed` | `tickets.read` | `ticket` | El run quedó en `failed` (con el error). |

Reglas que no cambian:

- El bus es **aditivo**: nada de lo que ya escuchaba el panel se ha tocado.
- Un evento **no ejecuta** trabajo de agente; solo marca el run como «para ahora». La ejecución ocurre
  en el scheduler, nunca en la petición HTTP del navegador.
- La publicación de un evento **no puede tumbar** la operación que sí se guardó (todo en `try/catch`).

Nuevas acciones de auditoría (`server/audit.mjs`, lista cerrada `AUDIT_ACTIONS`):
`agent_created`, `agent_updated`, `agent_approval_requested`, `agent_approval_decided`,
`agent_approval_executed`, `agent_approval_failed`, `ticket_agent_assigned`.

---

## 3. Registro de herramientas y matriz de permisos

### 3.1 Catálogo cerrado

| Herramienta | Efecto | Permiso del AGENTE | Permiso del APROBADOR | Estado |
|---|---|---|---|---|
| `ticket.get_context` | read | `tickets.read` | — | Activa |
| `order.get_status` | read | `orders.read` | — | Activa |
| `ticket.post_message` | write | `tickets.reply` | — | Activa |
| `ticket.request_ack` | write | `tickets.reply` | — | Activa |
| `ticket.set_follow_up` | write | `tickets.update` | — | Activa |
| `ticket.escalate` | write | `tickets.reply` | — | Activa |
| `ticket.complete_work` | write | `tickets.update` | — | Activa |
| **`ticket.close`** | **high_impact** | — (prohibido al agente) | **`tickets.close`** | Activa **con aprobación** |
| `order.change_total` | high_impact | — | `orders.update_operational` | **Desactivada** |
| `order.cancel` | high_impact | — | `orders.update_operational` | **Desactivada** |
| `order.refund` | high_impact | — | `orders.update_operational` | **Desactivada** |
| `customer.update_sensitive` | high_impact | — | `clients.update` | **Desactivada** |
| `db.query_raw` | **forbidden** | — | — | No existe |
| `server.exec` | **forbidden** | — | — | No existe |
| `whatsapp.send_external` | **forbidden** | — | — | No existe |

`enabled: false` significa «registrada pero no asignable»: el alta de un agente que la pida devuelve
`422 tool_disabled`. Las `forbidden` devuelven `422 tool_forbidden`. Las escritas de más (importes,
cancelaciones, devoluciones, datos sensibles, consultas crudas, comandos, WhatsApp al cliente) están
**explícitamente fuera** y así queda en el código, no solo en un documento.

### 3.2 Permisos del agente: lista blanca derivada

`AGENT_PERMISSIONS = ['tickets.read', 'tickets.read_all', 'tickets.reply', 'tickets.ack',
'tickets.update', 'orders.read']`.

Los permisos **no se aceptan del formulario**: se **derivan** de las herramientas asignadas. Si el
resultado contiene algo fuera de esa lista, el alta falla con `422 agent_permission_denied`. Un agente
no puede tener `tickets.close`, `orders.update_operational` ni `admin.full`, ni pidiéndolo.

### 3.3 Validación de argumentos

`validateArgs` comprueba, **antes de ejecutar**, el esquema de cada herramienta (tipo, obligatoriedad,
longitud máxima). Los argumentos desconocidos **se descartan**: nunca llegan a la ejecución. Una
validación fallida queda registrada como `ops_tool_calls.status = 'error'`.

---

## 4. Política de aprobación humana

| Regla | Implementación |
|---|---|
| Qué la necesita | Solo herramientas con `requiresApproval` (hoy `ticket.close`). |
| Quién puede decidir | Quien tenga `required_permission` (hoy `tickets.close`). Sin él: `403`. |
| Qué se aprueba | **Los parámetros exactos** que se muestran en la tarjeta (`params`). No hay «aprobar en general». |
| Cuánto dura | 24 h (`APPROVAL_TTL_MS`). Al vencer: `expired` y no se puede aprobar (`409`). |
| Cuántas veces se ejecuta | **Una.** Aprobar ejecuta y deja la aprobación en `consumed`; reintentar devuelve `409`. |
| Quién ejecuta | La **persona que aprobó**: la herramienta se invoca con su identidad y su `can`. |
| Rechazar | No ejecuta nada, deja `decision_note` y el ticket sigue abierto. |
| Rastro | Evento en el hilo (`approval_requested` / `approval_rejected` / `approval_executed` / `approval_failed`) + auditoría + `ops_tool_calls`. |
| Aviso | Notificación `OPS_TICKET_APPROVAL` a administración (campana + push si está configurado). |

**Garantía estructural:** el planificador solo puede producir la decisión `approval`, nunca una llamada
directa a `ticket.close`. Y `executeTool('ticket.close')` devuelve `approval_required` si no recibe
`approvalId`. Dos cerrojos independientes.

---

## 5. Marco implementado (archivos)

### Administración en el panel (cierre de R4, R5 y R7)

Tres cosas que en la primera entrega solo existían por API o con un diálogo del sistema:

| Qué | Dónde | Cómo funciona |
|---|---|---|
| **Bandeja de aprobaciones** | barra del centro → «Aprobaciones» (con contador) | `GET /ops/approvals?status=pending`; una tarjeta por petición **con el número y título del ticket** encima, y los botones Aprobar/Rechazar. El contador solo se cuenta a quien tiene `tickets.close`. |
| **Registro de agentes** | barra del centro → «Agentes IA» | Lista de agentes (clave, versión, nº de herramientas, ejecuciones en curso) y formulario de alta/edición con **las herramientas del catálogo real** y su efecto («solo lee», «escribe en el ticket», «necesita aprobación»). La clave no se puede cambiar al editar. |
| **Motivo del rechazo** | hoja propia | Sustituye a `window.prompt`: se puede estilar, no queda pegado al teclado en móvil y el texto se guarda en `decision_note` + histórico. |

Detalles que no son cosméticos:

- El formulario de alta **nace vacío** (`data-editing=""`, campos en blanco): heredar el último agente habría
  editado el existente sin querer. Hay una prueba que lo fija.
- Los permisos **siguen derivándose en el servidor**: el panel no manda permisos, manda herramientas.
- Desde la bandeja se puede saltar al ticket (`data-ops-open`), y la hoja se cierra sola.
- Decidir desde la bandeja recarga **solo** lo que corresponde: la bandeja, la ficha si estaba abierta y el
  hilo únicamente si la aprobación era de ese ticket.

### Nuevos
| Archivo | Contenido |
|---|---|
| `server/ops/tools.mjs` | Catálogo cerrado, lista blanca de permisos, `validateArgs`, `toolCatalog`, `assignableTools`. |
| `server/ops/agents.mjs` | Registro (`listAgents`, `agentByKey`, `saveAgent`), runs (`ensureRunForEvent`, `onTicketEvent`, `recoverStaleRuns`, `opsAgentTick`, `runsForTicket`), planificador (`planStep`), aprobaciones (`decideApproval`, `listApprovals`), asignación (`assignAgentToTicket`). |
| `docs/OPS-CENTER-ETAPA-D-CONTRATO.md` | Contrato de seguridad previo a la implementación. |
| `docs/OPS-CENTER-ETAPA-D.md` | Este informe. |
| `tests/ops-agents.test.js` | 16 pruebas de backend. |
| `tests/panel-ops-fase-d.test.js` | 5 pruebas de panel (jsdom). |

### Modificados (cambios mínimos y aditivos)
| Archivo | Cambio |
|---|---|
| `server/collections.mjs` | 5 colecciones: `ops_agents`, `ops_agent_runs`, `ops_agent_steps`, `ops_tool_calls`, `ops_agent_approvals`. |
| `server/ops/messages.mjs` | `postMessage` acepta `authorType`, `kind`, `meta`. Un mensaje de agente **no** da por atendida una espera humana. |
| `server/ops/tickets.mjs` | `addParticipant(participantType)`, `publishTicketEvent` despierta agentes, proyección con `assignedAgentName`/`type`, permisos `manageAgents`/`approve`. |
| `server/ops/notify.mjs` | Tipo `OPS_TICKET_APPROVAL` + `notifyApprovalRequested`. |
| `server/ops/routes.mjs` | `GET/POST/PATCH /ops/agents`, `POST /ops/tickets/:id/agent`, `GET /ops/tickets/:id/runs`, `GET /ops/approvals`, `POST /ops/approvals/:id/approve\|reject`; la ficha devuelve `approvals` y `runs`. |
| `server/scheduler.mjs` | `opsAgentTick` dentro de `runTick`, con su propio `try/catch`. |
| `server/crm-server.mjs` | Import del motor, `opsAgentTick` en el scheduler, gancho `ctx.opsAgents.onTicketEvent`, `findOrder` inyectado a las herramientas. |
| `server/realtime.mjs` · `server/audit.mjs` | 3 tipos SSE y 7 acciones de auditoría (listas cerradas ampliadas). |
| `public/admin/ops.js` | Burbuja de agente con chip «IA», tarjeta de aprobación con parámetros y botones, bloque «Agentes» en la ficha, asignación de agente. |
| `public/admin/ops.css` | Bloque Etapa D (chip, avatar, burbuja, tarjeta) + ajuste de cabecera en móvil. |
| `public/admin/index.html` · `public/admin/sw.js` | `ops.js?v=ops-3`, `ops.css?v=ops-3`, `crm-v227-centro-operaciones-d-20261022`. |

### Rutas nuevas

| Método | Ruta | Permiso | Efecto |
|---|---|---|---|
| `GET` | `/api/admin/ops/agents` | `admin.full` | Agentes + catálogo de herramientas. |
| `POST`/`PATCH` | `/api/admin/ops/agents` | `admin.full` | Alta/edición (valida herramientas y deriva permisos). |
| `POST` | `/api/admin/ops/tickets/:id/agent` | `tickets.update` | Asigna agente, lo añade como participante y crea su run. |
| `GET` | `/api/admin/ops/tickets/:id/runs` | `tickets.read` | Diagnóstico de ejecuciones. |
| `GET` | `/api/admin/ops/approvals?status=&ticket=` | `tickets.read` | Bandeja de aprobaciones (con `ticketNumber`/`ticketTitle`). |
| `POST` | `/api/admin/ops/approvals/:id/approve` | `tickets.close` | Decide y **ejecuta una vez**. |
| `GET` | `/api/admin/ops/inbox` | `tickets.read` | Bandeja de tickets + `pendingApprovals` (solo se cuenta a quien puede decidir). |
| `POST` | `/api/admin/ops/approvals/:id/reject` | `tickets.close` | Rechaza sin ejecutar. |

---

## 6. Persistencia y recuperación (evidencia)

| Garantía | Mecanismo | Prueba |
|---|---|---|
| El run sobrevive a un reinicio | Todo el estado está en `ops_agent_runs.state` (JSON) en BD | `el estado del run sobrevive a reiniciar el backend` (cierra y levanta el servidor con el mismo fichero: mismo `id`, mismo `step`, sigue en el paso 2) |
| Un run a medias no se pierde | `lease_owner` + `lease_until` (60 s) | `un run con el lease caducado vuelve a la cola con un intento más` (`running` → `pending`, `attempt` 1 → 2) |
| No hay dos ejecuciones a la vez | `claimRun` reescribe y **relee** el lease; si otro lo tomó, lo suelta | Cubierto por el diseño de `claimRun`; el proceso es único (1 réplica) |
| No se repite un efecto | `ops_tool_calls.idempotency_key` único (`tool:<run>:<step>:<name>` y `tool:approval:<id>`) | `repetir el mismo evento no duplica el mensaje del agente` |
| Un paso lento no cuelga la vuelta | `withTimeout` 20 s por herramienta | Implementado en `invokeTool` |
| Un fallo no bloquea el sistema | `MAX_ATTEMPTS = 5` con espera exponencial (2, 4, 8, 16, 30 min) | `last_error` + `attempt` en la ficha |
| Las aprobaciones caducan solas | `recoverStaleRuns` marca `expired` | `una aprobación caducada ya no se puede aprobar` |
| El panel no bloquea nada | El trabajo lo hace el scheduler, no la petición del navegador | Los runs avanzan con el panel cerrado |

Límites de ejecución aplicados: 1 paso por run y vuelta · máx. 5 runs por vuelta · 60 s de lease ·
20 s por herramienta · 5 intentos · máx. 6 mensajes por run.

---

## 7. Pruebas automatizadas

`npx vitest run tests/ops-*.test.js tests/panel-ops-*.test.js --no-file-parallelism`

| Archivo | Pruebas | Qué cubre |
|---|---|---|
| `tests/ops-tickets.test.js` | 13 | Etapa B (sin cambios). |
| `tests/ops-notifications.test.js` | 14 | Etapa C (sin cambios). |
| **`tests/ops-agents.test.js`** | **22** | Registro, ejecución, reanudación, idempotencia, aprobación, permisos, recuperación, bandeja de aprobaciones y estado del pedido vinculado. |
| `tests/panel-ops-uat.test.js` | 6 | Panel B (sin cambios). |
| `tests/panel-ops-fase-c.test.js` | 7 | Panel C (sin cambios). |
| **`tests/panel-ops-fase-d.test.js`** | **8** | Burbuja de agente, tarjeta, aprobar, ficha, rastro, bandeja de aprobaciones, alta de agentes y motivo del rechazo. |
| **Total** | **70/70** | |

Casos concretos de la Etapa D que merecen mención:

1. **Registro** — rechaza herramienta prohibida (`db.query_raw`, `server.exec`), desactivada
   (`order.refund`) e inexistente; un `AGENT` no puede dar de alta agentes (`403`).
2. **Permisos derivados** — el agente creado tiene `tickets.read/reply/update` y **no** `tickets.close`.
3. **Ejecución** — 1 paso por vuelta (`get_context` → saludo → `waiting_event`), con `author_type:
   'agent'` y participante de tipo `agent`.
4. **Reanudación** — una respuesta humana despierta el run y el agente contesta.
5. **Idempotencia** — forzar otra vuelta con el mismo estado no duplica el mensaje; todas las llamadas
   tienen `idempotency_key`.
6. **Aprobación** — el cierre **no** ocurre sin aprobación; el run queda `waiting_human`; un `DELIVERY`
   recibe `403`; administración aprueba y el ticket pasa a `resolved`; aprobar dos veces devuelve `409`
   y hay **una** fila de `ticket.close` en `ops_tool_calls`.
7. **Rechazo** — no cierra, guarda `decision_note`, deja evento `approval_rejected`.
8. **Agente desactivado** — el run pasa a `failed` con `agent_unavailable` (no ejecuta nada).
9. **Recuperación** — lease caducado → `pending` con `attempt+1`; aprobación vencida → `409
   approval_expired`; reinicio del backend → el run continúa desde el paso donde estaba.
10. **Bandeja de aprobaciones** — cada petición trae `ticketNumber` y `ticketTitle`; el contador de la
    bandeja solo suma a quien puede decidir (un `DELIVERY` ve `0`); decidir desde la bandeja resuelve el
    ticket y la petición desaparece de las pendientes.
11. **Alta de agentes desde el panel** — el formulario nace vacío, manda herramientas (no permisos) y el
    servidor deriva `tickets.read`/`tickets.reply` sin `tickets.close`.
12. **Rechazo con motivo** — la hoja del panel guarda `decision_note`; la prueba **rompe `window.prompt`**
    a propósito, así que volver al diálogo del sistema hace fallar la suite.
13. **Estado del pedido vinculado** — el agente consulta `order.get_status` una sola vez antes de saludar
    y lo dice en el mensaje; si el pedido no se puede leer, el run sigue sin bucle; y si alguien quita el
    permiso `orders.read` tocando la base, el motor **sigue negándose** (`agent_permission_denied`
    registrado en `ops_tool_calls`).

---

## 8. UAT real (navegador, E2E)

Script: `.tmp/uat-ops-agentes.mjs` (no versionado, igual que el de C) — **Chromium real** contra el CRM
real, con un agente ficticio `asistente_reparto` dado de alta por API.

Recorrido: entrada por el formulario de login → menú real → «Centro IA» → ticket → hilo con el agente →
tarjeta de aprobación → **clic real en «Aprobar y ejecutar»** → estado final.

Resultado medido (móvil 390×844 y escritorio 1440×900, claro y oscuro):

| Comprobación | Móvil | Escritorio |
|---|---|---|
| Desbordamiento horizontal | No | No |
| Mensajes del agente pintados | 3 | 3 |
| Chip «IA» visible | Sí | Sí |
| Tarjeta de aprobación | 1 (315 px, dentro de pantalla) | 1 (460 px, dentro de pantalla) |
| Parámetros visibles en la tarjeta | 1 | 1 |
| Botón «Aprobar y ejecutar» | Sí | Sí |
| Tras aprobar: estado `consumed` | Sí | Sí |
| Tras aprobar: el botón desaparece | Sí | Sí |
| Ficha: fila del agente + selector | Sí / Sí | Sí / Sí |
| Errores de consola | 0 | 0 |

Recorrido de administración (segunda pasada del mismo script): barra del centro → «Aprobaciones» (con
badge «1») → «Agentes IA». Medido en los dos tamaños:

| Comprobación | Móvil | Escritorio |
|---|---|---|
| Desbordamiento horizontal (bandeja y registro) | No | No |
| Tarjetas en la bandeja | 1 | 1 |
| La bandeja dice el nº de ticket | Sí | Sí |
| Botón de aprobar en la bandeja | Sí | Sí |
| Agentes listados / herramientas del catálogo | 1 / 8 | 1 / 8 |
| Formulario de alta dentro de pantalla | Sí | Sí |
| Errores de consola | 0 | 0 |

Hallazgo real encontrado **en esta UAT** y corregido: en móvil el chip «IA · Asistente de reparto» de la
cabecera desbordaba los 56 px y se metía debajo de los iconos (ⓘ ⋯). Ahora en ≤640 px ese chip no se
pinta: el nombre completo sigue en el hilo y en la ficha.

Segundo hallazgo, en el paso de administración: el icono de la cabecera de las hojas nuevas (escudo del
registro, robot de agentes) se pintaba **a tamaño completo** porque el `<svg>` no tenía medida y ocupaba
todo el ancho, empujando el título. Ahora está acotado a 15 px (medido en la UAT: `headerIconWidth: 15`).
Ese mismo paso confirmó que el formulario de «Nuevo agente» llega con los campos vacíos (lo que se ve
en la captura son los *placeholders*, no valores heredados).

Segundo ajuste de UX: el mensaje que pide la aprobación volcaba el JSON de parámetros
(`{"resolution":"…"}`) y lo repetía junto a la tarjeta. Ahora el mensaje es una frase legible y los
parámetros se leen **solo** en la tarjeta.

---

## 9. Capturas (conversaciones con agente)

`docs/capturas/` — 12 imágenes de la Etapa D (8 del flujo del agente + 4 de la administración):

| Archivo | Qué muestra |
|---|---|
| `ops-agente-chat-movil-claro.png` | Hilo con mensajes del agente y tarjeta de aprobación (móvil, claro). |
| `ops-agente-chat-movil-oscuro.png` | Igual en oscuro. |
| `ops-agente-ficha-movil-claro.png` | Ficha con el bloque «Agentes». |
| `ops-agente-aprobado-movil-claro.png` | Tarjeta ya ejecutada (sin botones). |
| `ops-agente-chat-escritorio-claro.png` | Hilo completo en escritorio. |
| `ops-agente-chat-escritorio-oscuro.png` | Igual en oscuro. |
| `ops-agente-ficha-escritorio-claro.png` | Ficha: agente asignado, estado del run, selector. |
| `ops-agente-aprobado-escritorio-claro.png` | Resultado tras aprobar. |
| `ops-agente-bandeja-movil-claro.png` / `ops-agente-bandeja-escritorio-claro.png` | Bandeja de aprobaciones con el ticket al que pertenece cada petición. |
| `ops-agente-registro-movil-claro.png` / `ops-agente-registro-escritorio-claro.png` | Registro de agentes y formulario de alta con el catálogo real de herramientas. |

---

## 10. Seguridad y concurrencia — hallazgos

**Lo que quedó demostrado:**

1. **El agente no puede cerrar un ticket.** Ni pidiéndolo al planificador (solo produce decisiones
   `approval`), ni llamando a la herramienta sin `approvalId` (`approval_required`), ni teniendo la
   herramienta en su lista con permiso `null`.
2. **Los permisos no se pueden inventar.** Se derivan de las herramientas y se validan contra la lista
   blanca. Probado: `customer.update_sensitive` (desactivada) se rechaza con `422`.
3. **Aprobar ejecuta con la identidad del humano.** `invokeTool(..., approveCan)` sustituye el `can` del
   agente por el del aprobador; `resolveTicket` revalida `tickets.close` y la participación.
4. **Aprobación de un solo uso.** `consumed` + `idempotency_key = tool:approval:<id>` impiden la doble
   ejecución aunque se pulse dos veces o se reintente la red.
5. **Aprobación caducada** = `409`. No hay ventana infinita.
6. **Sin WhatsApp, sin datos de cliente en las herramientas.** `order.get_status` devuelve **solo**
   `{orderId, number, status}`: ni importes, ni teléfono, ni dirección.
7. **Auditoría completa:** alta/cambio de agente, asignación, petición, decisión, ejecución y fallo.

**Riesgos de concurrencia identificados (y su estado):**

| Riesgo | Estado |
|---|---|
| Dos vueltas del scheduler ejecutando el mismo run | `claimRun` con lease + relectura. Proceso único (1 réplica) → sin carreras reales hoy. |
| Dos aprobaciones simultáneas de la misma solicitud | El primer `update` a `approved/consumed` gana; la segunda lectura ve `consumed` → `409`. |
| Evento duplicado de ticket (reintento de red) | `ensureRunForEvent` reutiliza el run activo; el paso tiene `step_key` único. |
| Mensaje duplicado del agente | `client_key` determinista (`agent:<run>:<paso>`) + `client_key` único en BD. |
| Escalado a varias réplicas | **No soportado todavía**: el reparto de `seq` de mensajes y el lease asumen un solo proceso. Documentado como riesgo R3. |

---

## 11. Riesgos y pendientes

| # | Riesgo / pendiente | Impacto | Mitigación actual |
|---|---|---|---|
| R1 | El planificador es determinista, no un modelo real | El agente no «entiende» lenguaje libre | El punto de enchufe está aislado (`planStep`); el resto del marco ya es definitivo |
| R2 | `ticket.close` es la única herramienta `high_impact` activa | Poca superficie probada en producción | Las demás están declaradas y desactivadas: activarlas exige decisión explícita |
| R3 | Varias réplicas romperían el lease y el `seq` | Riesgo futuro de infraestructura | Documentado; hoy hay 1 réplica. Si se escala, el cambio es local a `claimRun` y `withTicketLock` |
| R4 | ~~No hay interfaz para editar un agente~~ **RESUELTO**: alta y edición desde el panel | — | Registro con validación del servidor |
| R5 | ~~La bandeja de aprobaciones no tiene pantalla~~ **RESUELTO**: barra del centro con contador | — | Se decide desde el hilo o desde la bandeja |
| R6 | Los agentes no aparecen en `/ops/users` | No se pueden añadir como participantes a mano | Se añaden al asignarlos (participante tipo `agent`) |
| R7 | ~~`window.prompt` para el motivo del rechazo~~ **RESUELTO**: hoja del panel | — | Probado rompiendo `window.prompt` en la suite |
| R8 | Un agente puede escribir hasta 6 mensajes por run | Ruido si el plan se equivoca | Límite duro `MAX_MESSAGES_PER_RUN` |

Nada de esto requiere tocar producción: son mejoras sobre lo ya entregado. R4, R5 y R7 quedan cerrados;
los que siguen abiertos (R1, R2, R3, R6, R8) son decisiones de producto o de infraestructura, no deudas
de esta etapa.

---

## 12. GO / NO-GO

**GO** para el marco de agentes de la Etapa D, con este alcance:

- ✅ Registro de agentes con catálogo cerrado y permisos derivados.
- ✅ Ejecución durable (persistente, idempotente, con lease y recuperación tras caída).
- ✅ Aprobación humana obligatoria para lo irreversible, de un solo uso y con caducidad.
- ✅ Contrato de eventos estable y auditado.
- ✅ Panel que distingue agente de persona y permite decidir sin salir del hilo.
- ✅ Bandeja de aprobaciones y registro de agentes en el propio panel (sin tocar la API a mano).
- ✅ 70 pruebas automáticas en verde y UAT real en Chromium sin errores.

**NO-GO todavía** para:

- ❌ Activar `order.change_total`, `order.cancel`, `order.refund`, `customer.update_sensitive`
  (requieren autorización expresa y su propio circuito de pruebas).
- ❌ Conectar un proveedor de IA externo (no se ha hecho: el planificador es local y determinista).
- ❌ Cualquier herramienta que toque al cliente (`whatsapp.send_external`): sigue sin existir.
- ❌ Desplegar a producción: **no se ha desplegado, ni hecho commit, ni push**.

Siguiente paso natural (cuando se pida): sustituir `planStep` por un planificador con modelo real,
manteniendo intactos el catálogo, las aprobaciones y la recuperación ya probados.
