# Centro IA — oficina de agentes, registro compartido y colaboración

Fecha: 2026-10-21 · Ámbito: **local y UAT aislada** · **sin commit, sin push, sin despliegue**.
Continúa las etapas A–E del Centro de Operaciones (`docs/OPS-CENTER-ETAPA-A…E.md`).

Objetivo de esta etapa: que todo lo de IA viva en **un solo sitio** (Centro IA), que cada agente
tenga **su oficina**, que las herramientas se administren **en un registro compartido** con
autorización individual, que los agentes puedan **pedirse ayuda sin escalar permisos** y que el
**Supervisor IA Delivery** se administre desde el centro sin perder nada de lo que ya hacía.

---

## 0. Resumen para decidir

| Pregunta | Respuesta |
|---|---|
| ¿Hay una sola entrada para todo lo de IA? | **Sí** — «Centro IA» (entrada única en el menú). Dentro: Agentes · Tickets · Supervisor IA. |
| ¿La pantalla de entrada es el equipo y no una bandeja abierta? | **Sí** — lista de agentes con estado, trabajo pendiente y sin leer. |
| ¿Cada agente tiene su oficina? | **Sí** — `/api/admin/ops/agents/:key/office` con tickets, trabajo en curso, actividad, herramientas y ayuda. |
| ¿La conversación es la misma? | **Sí** — se reutiliza el chat del Centro de Operaciones; no hay un segundo motor. |
| ¿El Supervisor IA sigue funcionando y se administra desde el centro? | **Sí** — la pantalla es la misma (`supervisor.js`), cambió la puerta de entrada. Se añadió enlace del pedido al ticket. |
| ¿Todos ven las herramientas y solo se ejecutan las autorizadas? | **Sí** — catálogo público; lista blanca por agente; el motor revalida en cada invocación. |
| ¿Pueden colaborar sin escalar permisos? | **Sí** — delegación en el MISMO ticket, con su propia lista de herramientas y reglas anti-bucle. |
| ¿Se ha roto algo? | **No** — **203/203** pruebas de la familia (14 archivos) en verde. |
| ¿Se ha tocado producción? | **No.** Ni producción, ni datos reales, ni WhatsApp. |

**Veredicto: GO de la etapa** (código + UAT aislada) · **NO-GO de despliegue** hasta que el negocio
pruebe el tono de los mensajes y autorice publicar.

---

## 1. Auditoría de arquitectura y navegación (Fase 0)

Lo que YA existía y **se reutilizó sin reescribir**:

| Pieza | Dónde | Uso en esta etapa |
|---|---|---|
| Tickets internos + hilo | `server/ops/tickets.mjs`, `messages.mjs` | Sin cambios de contrato. La oficina solo los lee. |
| Registro de agentes | `ops_agents`, `agents.mjs` (`saveAgent`, `listAgents`) | Se le añaden responsabilidades y «acepta ayuda». |
| Catálogo de herramientas | `server/ops/tools.mjs` | Se enriquece (alcance, riesgo, plazo, idempotencia, auditoría) y se añade `agent.request_help`. |
| Ejecución durable | `ops_agent_runs` + lease + `opsAgentTick` | Igual. La colaboración crea runs del mismo tipo. |
| Aprobaciones humanas | `ops_agent_approvals` + `decideApproval` | Igual. `ticket.close` sigue exigiendo una persona. |
| Supervisor determinista | `delivery-supervisor.mjs` + `supervisor.js` + sus rutas | Intacto: solo cambió la entrada del menú. |
| Chat del centro | `public/admin/ops.js` (lista + conversación) | Es el chat que se abre desde la oficina. No hay copia. |
| Navegación | `app.js` (`VIEWS`, `setTab`, `fulltech:tab`) | Se añadió un canal `fulltech:navigate` para que un módulo pida una pestaña. |

Lo que **NO** se tocó:

- El chat del cliente (WhatsApp) y su motor de envío.
- Los pedidos, la facturación, el inventario y el cierre.
- Las reglas deterministas del supervisor de reparto.

**Estado de Git al empezar:** había trabajo ajeno sin commitear (`pos.js`, `store.js`, `pos.css`,
`app.js`, `index.html`, `sw.js`, un test de POS y unos iconos nuevos). Se ha **convivido** con él:
no se revirtió nada y los cambios de esta etapa van en archivos y zonas distintas.

---

## 2. Estructura nueva del Centro IA (Fases 1 y 2)

### Pantallas

```
Centro IA  (data-tab="ops")
├── Agentes          ← ENTRADA. El equipo, no una bandeja.
│   └── Oficina de un agente
│         ├── Asignados      (tickets + trabajo en curso)
│         ├── Actividad      (pasos reales de sus ejecuciones)
│         ├── Herramientas   (las que TIENE, con riesgo y plazo)
│         └── Ayuda          (colaboraciones pedidas y recibidas)
├── Tickets          ← la bandeja de siempre (lista + conversación)
└── Supervisor IA    ← la pantalla de siempre (no se duplica)
```

- **Móvil:** una columna. Centro IA → oficina → conversación, con botón de volver que regresa a la
  oficina de la que se vino.
- **Escritorio (≥900 px):** la oficina usa dos columnas (ficha del agente a la izquierda, trabajo a
  la derecha); la bandeja mantiene su doble panel de siempre.

### Datos (nada inventado)

`GET /api/admin/ops/centro` (requiere `tickets.read`) devuelve el equipo con:

- `state` derivado de los runs: `working` · `waiting_human` · `waiting` · `idle` · `paused`.
- `assigned` = tickets abiertos asignados; `pending` = runs vivos; `unread` = mensajes humanos
  posteriores al último `seq` que el agente procesó (**no** la bandeja de una persona).
- `planner` (`llm` o `deterministic`) para no fingir IA donde no la hay.

`GET /api/admin/ops/agents/:key/office` añade: herramientas resueltas del catálogo, trabajo en
curso con su error si lo hubo, actividad (pasos), colaboraciones y **avisos comprobables**
(desactivado, ejecuciones fallidas, reintentos, planificador determinista, ayuda sin responder).

Si la clave no existe → **404**: la pantalla nunca se inventa un agente.

---

## 3. Migración del Supervisor IA Delivery (Fase 3)

- **Qué se movió:** la *puerta de entrada*. El botón «Supervisor IA» ya no está en el desplegable
  «Entregas»; se entra desde **Centro IA → Supervisor IA**.
- **Qué NO se movió (a propósito):** la pantalla (`#view-supervisor`), su módulo (`supervisor.js`)
  y todas sus acciones (ejecutar ahora, vista previa, resumen diario, reglas, posponer, incluir en
  seguimiento). **Hay una sola interfaz de administración del supervisor.**
- **Paridad comprobada en UAT de navegador:** desde el centro se abre `#view-supervisor` y la
  pantalla queda visible; en el menú ya **no** hay una segunda entrada.
- **Enlace contextual nuevo:** cada fila del supervisor tiene un botón **«Centro IA»** que abre el
  ticket de ESE pedido (`fulltech:navigate {tab:'ops', orderId}`). Si el pedido no tiene ticket, se
  dice; no se inventa uno. También vale como enlace directo: `/admin/?v=ops&order=<idPedido>`.
- **El módulo de reparto conserva** su gestión normal: mapa, mis entregas, asignaciones, avisos.

---

## 4. Registro compartido y autorización (Fase 4)

Un solo catálogo (`server/ops/tools.mjs`, 16 entradas). **Ver una herramienta no es poder
ejecutarla.**

Cada herramienta declara:

| Campo | Para qué |
|---|---|
| `name` | identificador único (`ticket.post_message`, `agent.request_help`…) |
| `description` | qué hace, en lenguaje del negocio |
| `schema` / `inputs` / `outputs` | entradas validadas y claves de salida |
| `permission` | permiso del AGENTE (`tickets.reply`, `orders.read`…) |
| `approverPermission` | permiso de LA PERSONA en las de `high_impact` |
| `scope` | `ticket` · `order` · `agent` |
| `risk` | `low` · `medium` · `high` |
| `timeoutMs` | plazo propio (el motor aplica además el global de 20 s) |
| `idempotent` | si repetirla no duplica el efecto |
| `audit` | `call` (traza de herramientas) o `action` (además, auditoría del CRM) |
| `enabled` / `requiresApproval` | si se puede asignar y si exige aprobación humana |

Reglas que siguen intactas:

- Los **permisos se derivan** de las herramientas; no se aceptan del navegador.
- `order.change_total`, `order.cancel`, `order.refund`, `customer.update_sensitive`: **desactivadas**.
- `db.query_raw`, `server.exec`, `whatsapp.send_external`: **prohibidas** (no existen).
- `ticket.close`: `high_impact`, la ejecuta **una persona** con `tickets.close`.
- El motor revalida herramienta + permiso **en cada invocación** (`tool_not_allowed`,
  `agent_permission_denied`).

---

## 5. Contrato de colaboración entre agentes (Fase 6)

**Qué es:** el agente A pide a B que mire **el mismo ticket**. No se abre otro ticket, no se copia
la conversación del cliente y **no se transfieren permisos**: B trabaja con su lista blanca y sus
permisos, y deja su respuesta en el hilo compartido. A sigue después.

**Herramienta:** `agent.request_help` (`write`, `scope: agent`, riesgo medio, permiso
`tickets.update`) con `{ agentKey, question }`.

**Reglas (todas en el servidor):**

| Regla | Código de error |
|---|---|
| Nada de pedirse ayuda a uno mismo | `delegation_self` |
| El destinatario tiene que existir | `delegation_target_missing` |
| Tiene que estar activo | `delegation_target_disabled` |
| Tiene que trabajar en ese tipo de ticket | `delegation_type_denied` |
| Puede negarse a colaborar (`config.collaboration=false`) | `delegation_target_opt_out` |
| Sin bucles: la cadena viaja con el run | `delegation_loop` |
| Profundidad máxima 2 (A→B→C; C no delega) | `delegation_depth_exceeded` |
| Tope de 4 peticiones por ticket | `delegation_limit` |
| Repetir la misma petición devuelve la viva | `duplicate: true` |

**Qué deja escrito:** fila en `ops_agent_delegations` (persistente), mensaje en el hilo
(«Le pido ayuda a …»), evento del ticket, línea de auditoría (`agent_delegation_requested` /
`completed` / `failed`) y participante nuevo (`agent:<clave>`) para que el receptor pueda escribir.

**Estados:** `pending` → `accepted` → `completed` (o `rejected` / `failed` / `cancelled`).

**Cómo decide el agente pedir ayuda:** por la pauta determinista cuando el ticket está **escalado o
es urgente** y hay un compañero válido (una sola vez por ejecución: si el servidor la rechaza, no se
reintenta en bucle), o por el modelo (`action: "collaborate"`), que **solo puede elegir entre los
compañeros que el servidor puso en la lista** (`invalid_collaborator` si se los inventa).

**Lo que NO hace:** conversaciones autónomas entre agentes, peticiones a agentes de otro tipo de
ticket, ni compartir datos del cliente (el hilo interno no los tiene).

---

## 6. Perfiles de responsabilidad (Fase 5)

Cada agente guarda hasta **6 responsabilidades** (texto para las personas: «Vigilar entregas sin
confirmar», «Pedir acuse al repartidor»…). Se editan en el registro de agentes del panel y se ven en
su oficina. **No son lógica**: lo que un agente puede hacer sale siempre de sus herramientas.

El perfil del Supervisor de reparto (ejemplo real usado en la UAT): leer tickets y estado del
pedido, escribir seguimiento, pedir acuse, cerrar su trabajo, pedir ayuda. **Nunca** cerrar el
ticket, tocar importes ni afirmar una entrega que no consta.

---

## 7. Orquestación persistente (Fase 7)

Lo que ya había y se ha vuelto a comprobar con esta etapa:

- Un evento de ticket solo **marca** trabajo; la ejecución la hace el planificador con *lease* en
  base de datos (sobrevive a reinicios).
- Los pasos y las llamadas a herramientas son **idempotentes** (`step_key`, `idempotency_key`).
- La colaboración crea un run del receptor con su **cadena** en el `state` (anti-bucle).
- Tras reiniciar el servidor, la UAT comprobó que **el ticket, el trabajo pendiente y las
  delegaciones siguen igual**.
- Una decisión humana (aprobación) **no la pisa** un reintento posterior.

**Límite conocido (sin cambios):** el `seq` de mensajes y el *lease* asumen **un solo proceso**.
Con varias réplicas habría que mover la secuencia a la base. Hoy se despliega con 1 réplica.

---

## 8. Seguridad (Fase 8) — hallazgos

| # | Comprobación | Resultado |
|---|---|---|
| S1 | Un agente no puede darse una herramienta desactivada | **Bloqueado** (`tool_disabled`, `tool_forbidden`) |
| S2 | Un agente no puede tener permisos fuera de la lista blanca | **Bloqueado** (`agent_permission_denied`) |
| S3 | Un agente no puede ejecutar lo que no tiene, aunque lo pida el modelo | **Bloqueado** en ejecución (`tool_not_allowed`) |
| S4 | Delegar no transfiere permisos | **Sí**: el receptor usa su propia ficha; sus permisos en la prueba son `tickets.read/reply/update` |
| S5 | No se puede delegar a sí mismo, a un desactivado, ni a otro tipo de ticket | **Bloqueado** (4 códigos distintos) |
| S6 | Bucles y cadenas infinitas | **Bloqueado** (cadena + profundidad + tope por ticket) |
| S7 | El hilo del cliente y WhatsApp | **Intactos**: la UAT acabó con **0 mensajes** enviados |
| S8 | Operaciones de alto impacto | **Siguen desactivadas**; `ticket.close` sigue necesitando a una persona |
| S9 | ¿La oficina expone datos de clientes? | **No**: solo tickets, estados y contadores internos |
| S10 | Lectura del equipo por roles sin administración | **Sí** (por diseño): `tickets.read` ve el equipo; administrar exige `admin.full` |

---

## 9. Diseño visual (Fase 9)

- Cabecera propia compacta (marca IA, navegación segmentada, aprobaciones/administración como
  iconos), tipografía del panel y acento azul FULLTECH.
- **Un solo título por pantalla**: en móvil manda la cabecera del panel; la marca del módulo entra
  desde 640 px.
- Avatares discretos con iniciales y **punto de estado**; cifras con `tabular-nums`.
- Directorio como **lista de equipo** (no tarjetas promocionales); oficina como espacio de trabajo,
  con dos columnas en escritorio.
- Claro y oscuro con las variables del centro (`--ops-*`); sin desbordamiento horizontal en
  ninguno de los cuatro casos medidos.

Capturas (en `docs/capturas/`):

| Archivo | Qué enseña |
|---|---|
| `centro-ia-equipo-movil-claro.png` | entrada del centro (equipo) en móvil |
| `centro-ia-equipo-movil-oscuro.png` | lo mismo en oscuro |
| `centro-ia-oficina-movil-claro.png` | oficina del agente en móvil |
| `centro-ia-herramientas-movil-claro.png` | herramientas autorizadas con su riesgo |
| `centro-ia-colaboracion-movil-claro.png` | colaboración pedida y recibida |
| `centro-ia-ticket-movil-claro.png` | la conversación (misma del centro) |
| `centro-ia-supervisor-movil-claro.png` | Supervisor IA abierto desde el centro |
| `centro-ia-equipo-escritorio-claro.png` | equipo en escritorio |
| `centro-ia-oficina-escritorio-claro.png` | oficina a dos columnas |
| `centro-ia-oficina-escritorio-oscuro.png` | oficina en oscuro |

---

## 10. UAT (Fase 10)

### Automatizada (Vitest)

| Archivo | Qué cubre |
|---|---|
| `tests/ops-centro-ia.test.js` (18) | registro de herramientas, directorio, oficina, colaboración (permisos, bucles, topes, duplicados) |
| `tests/panel-centro-ia-uat.test.js` (8) | panel real en jsdom: entrada = equipo, oficina, chat compartido, vuelta, bandeja, supervisor |
| `tests/panel-ops-uat / -fase-c / -fase-d` (21) | regresión del chat y la administración del centro |
| `ops-agents`, `ops-llm`, `ops-tickets`, `ops-notifications` (69) | motor, modelo, tickets y avisos |
| `deepseek-ops-transport`, `deepseek-proofreading`, `supervisor-deepseek`, `delivery-supervisor`, `delivery-supervisor-routes` (87) | proveedor y supervisor intactos |

**Total ejecutado: 203/203 en 14 archivos** (`--no-file-parallelism`).

### Navegador real (`.tmp/uat-centro-ia.mjs`, Chromium)

Datos ficticios: 2 agentes, 1 pedido/ticket urgente y una colaboración real ejecutada por el motor.
Todas las comprobaciones en verde:

```
OK  el menú tiene UNA entrada «Centro IA»
OK  el equipo muestra los 2 agentes registrados (2)
OK  aparecen por su nombre, sin nada escrito a mano
OK  el directorio no desborda en móvil
OK  la oficina abre el agente correcto
OK  la oficina lista el ticket asignado
OK  la oficina enseña la herramienta de colaboración
OK  no se enseñan herramientas desactivadas
OK  el motor creó 1 delegación(es) reales
OK  la sección de colaboración pinta datos reales
OK  el chat abre el ticket correcto (cabecera)
OK  el hilo trae la conversación real del ticket
OK  la conversación no desborda en móvil
OK  el botón de volver regresa a la oficina del agente
OK  la bandeja completa sigue disponible desde el centro
OK  desde la bandeja se vuelve al equipo
OK  el Supervisor IA se abre desde el Centro IA
OK  no queda una segunda entrada del supervisor en el menú
OK  la oficina no desborda en escritorio
OK  en escritorio la oficina usa dos columnas
OK  tras reiniciar, el trabajo del agente sigue igual
OK  el ticket asignado sobrevive al reinicio
OK  las delegaciones persisten con su estado
OK  cero mensajes de WhatsApp
OK  sin errores de consola (0)
```

Los dos errores 401 de consola de la primera pasada eran de `/api/admin/session` **antes de entrar**
(sesión anónima): no son un fallo de la pantalla y se filtran a propósito.

### Fallos previos detectados (NO son de esta etapa)

`tests/panel-shell-uat.test.js` tiene 2 rojos que **ya venían**: espera `class="wa-fab"` en la vista de
WhatsApp y «Crear pedido» dentro de `openChatActions`. Comprobado contra `HEAD`: `wa-fab` **no existe
en ese archivo** (`git show HEAD:public/admin/index.html`), y el diff de `app.js` de esta etapa son
18 líneas en otro punto del archivo.

---

## 11. Archivos

**Nuevos**

- `server/ops/collaboration.mjs` — delegaciones entre agentes (reglas, persistencia, cierre).
- `server/ops/centro.mjs` — lecturas del equipo y de la oficina (estados derivados y avisos).
- `tests/ops-centro-ia.test.js`, `tests/panel-centro-ia-uat.test.js`.
- `.tmp/uat-centro-ia.mjs` (UAT de navegador, no versionada) y las capturas del §9.

**Modificados**

- `server/ops/tools.mjs` — metadatos completos + `agent.request_help` + `timeoutOf`/`toolSpec`.
- `server/ops/agents.mjs` — responsabilidades, `collaboration`, runs de colaboración, rama de ayuda,
  plazos por herramienta, cierre de delegaciones.
- `server/ops/llm.mjs` — acción `collaborate` con la lista de compañeros como dato.
- `server/ops/routes.mjs` — `/centro`, `/agents/:key/office`, `/delegations`.
- `server/collections.mjs` — colección `ops_agent_delegations`.
- `server/audit.mjs`, `server/realtime.mjs` — acciones y evento de colaboración.
- `public/admin/ops.js` — pantallas del centro, oficina, navegación y enlaces directos.
- `public/admin/ops.css` — piel del Centro IA (claro y oscuro).
- `public/admin/supervisor.js` — botón «Centro IA» por pedido.
- `public/admin/app.js` — etiqueta «Centro IA», canal `fulltech:navigate`.
- `public/admin/index.html` — versión de `ops.*`, fuera la entrada duplicada del supervisor.
- `public/admin/sw.js` — `crm-v231-centro-ia-oficina-20261021`.
- `tests/panel-ops-uat.test.js`, `-fase-c`, `-fase-d` — abren la sección de tickets del centro.
- `docs/DECISIONES.md` §51.

---

## 12. Riesgos que quedan

| # | Riesgo | Estado |
|---|---|---|
| C1 | Un proceso único para `seq` y *lease* | Sin cambios; documentado. No abrir varias réplicas sin mover la secuencia. |
| C2 | Las responsabilidades son texto libre | No ejecutan nada; sirven para que las personas sepan qué esperar. |
| C3 | El planificador determinista pide ayuda «cuando el ticket ya se escaló» | Regla acotada a una vez por ejecución; se afina con uso real. |
| C4 | Un agente podría pedir ayuda muchas veces en tickets distintos | El tope es **por ticket** (4). Si molesta, bajar `MAX_DELEGATIONS_PER_TICKET`. |
| C5 | El aviso «Planificador determinista» puede parecer un error | Es honesto a propósito: mientras no haya modelo conectado, se dice. |
| C6 | La oficina lee tickets con `limit: 400` | Suficiente para el volumen actual (decenas); si crece, paginar. |

---

## 13. GO / NO-GO

**GO de la etapa:**

- ✅ Un Centro IA con el equipo como entrada, oficina por agente y la conversación de siempre.
- ✅ Registro compartido con metadatos completos y autorización por agente.
- ✅ Colaboración entre agentes con reglas duras, persistencia y auditoría.
- ✅ Supervisor IA Delivery administrado solo desde el centro, sin duplicar pantalla.
- ✅ 203 pruebas en verde + UAT de navegador con 25 comprobaciones y 10 capturas.
- ✅ Cero WhatsApp, cero datos reales, cero cambios en producción.

**NO-GO de despliegue** (lo que falta para publicar):

- ❌ Validar el tono y la utilidad de los mensajes con el negocio.
- ❌ Decidir si se activa un modelo en producción (hoy el agente de la UAT es determinista).
- ❌ Revisar el riesgo C1 antes de pasar a más de una réplica.
