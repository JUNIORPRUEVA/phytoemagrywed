# Centro de Operaciones IA — Etapa C (avisos, acuses y seguimiento del trabajo)

> **Estado:** ETAPA C COMPLETADA · **sin commit, sin push, sin deploy, sin tocar producción.**
> Base: `OPS-CENTER-ETAPA-A.md` (arquitectura) y `OPS-CENTER-ETAPA-B.md` (bandeja + conversación).
> Fecha: 2026-10-21 · UAT con **usuarios, pedidos y tickets ficticios** (`@uat.local` / `@phyto.local` de prueba).

---

## 1. Auditoría previa (qué había y qué se reutilizó)

| Pieza existente | Estado | Decisión en la Etapa C |
|---|---|---|
| `user_notifications` (+ `idempotency_key` única) | En producción | **Se reutiliza tal cual** para todos los avisos del ticket |
| `push_jobs` / `push_subscriptions` | En producción (Web Push real) | **Se reutiliza**: cada aviso intenta el push y guarda su estado real |
| `notification_deletions` | En producción | Sin cambios (borrar un aviso no lo resucita) |
| SSE `/api/admin/events` con audiencia | En producción | Se amplía la lista cerrada con `message.*` y `task.*` |
| `audit.mjs` (acciones cerradas) | En producción | +4 acciones de tarea y participantes |
| `scheduler.mjs` | En producción | Se le añade **una pasada** (`opsDeadlineTick`): plazos sin navegador |
| Rutas de notificaciones del panel (`GET/DELETE .../notifications`, `.../read`) | En producción | Sin cambios: el centro solo marca leídas las suyas |
| Conversaciones de WhatsApp del cliente | En producción | **No se tocan** (ni tablas, ni rutas, ni pantallas) |

**Duplicaciones evitadas:** no se creó un segundo sistema de avisos, ni una segunda cola, ni un
segundo bus de eventos, ni una campana paralela. El centro usa las mismas piezas que ya mueven
los pedidos y el WhatsApp entrante.

**Proceso único (supuesto explícito):** el CRM corre **una** instancia Node (nginx y Node en el
mismo contenedor, 1 réplica en Swarm). Por eso la secuencia de mensajes usa un cerrojo **en
memoria** por ticket. Si algún día hubiera varias réplicas, hay que cambiarlo por
`SELECT … FOR UPDATE SKIP LOCKED` (documentado en el código y en §9). Con una instancia, dos
peticiones simultáneas **no pueden** repetir número (probado con 6 envíos a la vez).

---

## 2. Funcionalidad implementada

### 2.1 Avisos internos (7 tipos, todos persistentes)

| Suceso | Tipo | Destinatarios | Se repite si se reintenta |
|---|---|---|---|
| Ticket asignado | `OPS_TICKET_ASSIGNED` | el asignado | no (`ticket + persona + versión`) |
| Mensaje nuevo | `OPS_TICKET_MESSAGE` | participantes menos el autor | no (`mensaje + persona`) |
| Mención `@nombre` | `OPS_TICKET_MENTION` | solo el mencionado | no (ídem) |
| Acuse exigido | `OPS_TICKET_ACK_REQUIRED` | asignado / participantes | no |
| Plazo vencido | `OPS_TICKET_DUE` | participantes | no (`ticket + plazo + persona`) |
| Escalado / ayuda | `OPS_TICKET_ESCALATED` | participantes + administración | no |
| Cambio de estado / cierre | `OPS_TICKET_STATUS` | resto de participantes | no (`ticket + estado + updated_at`) |

- **Persistencia antes del envío:** primero la fila en `user_notifications`, después el push.
  Si el push falla, el aviso sigue y su estado real queda en `push_jobs`.
- **Deep link** accionable: `/admin/?v=ops&ticket=<id>` y el centro abre ESE ticket al entrar.
- **Sin datos de más:** número, asunto y un recorte del texto. Nunca teléfonos ni direcciones.
- **Leer el ticket apaga la campana:** al marcar leído se ponen en `read` los avisos de ese
  ticket para esa persona (con `read_at`).
- **Plazos sin navegador:** `opsDeadlineTick` corre en el scheduler; una vez por plazo.

### 2.2 Seis estados separados (no se confunden nunca)

| Estado | Dónde se guarda | Quién y cuándo |
|---|---|---|
| Mensaje creado | `ops_ticket_messages` (con `seq`) | autor + hora |
| Aviso enviado | `user_notifications` (con `idempotency_key`) | destinatario + tipo |
| Aviso entregado al dispositivo | `push_jobs.status` (`sent`/`failed`/`expired`) | por suscripción |
| Mensaje leído | `ops_ticket_participants.last_read_seq` + `unread_count` | por persona |
| Tarea acusada | `ops_tickets.task.acknowledged_at/_by` | quien acusa |
| Tarea completada | `ops_tickets.task.completed_at/_by` | quien completa |
| Ticket resuelto | `ops_tickets.status='resolved'` + `resolved_at/_by` | quien cierra |

Leer **no** acusa, acusar **no** completa y completar **no** cierra. Cada paso se comprueba en
las pruebas y se ve en la ficha.

### 2.3 Seguimiento del trabajo (7 acciones auditables)

`acknowledge` · `start` · `progress` · `issue` · `help` · `complete` · `escalate`.
Cada una escribe: una fila en `ops_ticket_events` (línea de tiempo con autor y hora), una entrada
en la auditoría (`ticket_task_updated` / `ticket_task_completed` / `ticket_escalated`), el estado
en el ticket y un evento SSE con nombre canónico.

### 2.4 Ficha del ticket y participantes

- Identificador, tipo, estado, prioridad, **responsable**, **agentes IA autorizados** (vacío:
  ninguno conectado todavía), pedido vinculado (número, estado y cliente solo con `clients.read`),
  alta (quién y cuándo), plazo y seguimiento.
- Bloque **Trabajo** con acuse, inicio, último avance, incidencias, ayuda, completado y escalado.
- **Participantes** con su estado real por persona: `sin leer N · leyó #N · acusó #N · avisado #N`.
- **Actividad** (últimos 12 hechos).
- Alta y baja de participantes **validada en servidor**: no se puede quitar al responsable
  (`409 assignee_locked`) ni dejar el ticket sin nadie (`409 last_participant`); un rol sin
  `tickets.participants.manage` recibe `403`.

### 2.5 Contrato de eventos para agentes futuros (sin activar ninguno)

Lista cerrada en `server/realtime.mjs`, todos con `audience: 'ticket'` (solo participantes):

```
ticket.created · ticket.assigned · ticket.status_changed · ticket.escalated · ticket.resolved
message.created · message.read
task.acknowledged · task.completed
```

El evento **no lleva el cuerpo del mensaje**: lleva `ticketId`, `seq`, autor y un recorte. Un
agente futuro se suscribe a lo que su permiso permita sin acoplarse a ningún modelo de IA.

### 2.6 Interfaz (sobre la base de la Etapa B, sin rediseñarla)

- **Contador numérico** por fila (no un punto) y **total** en el distintivo del menú.
- **Barra de trabajo** sobre el compositor: chips del estado de la tarea + botón «Trabajo» con las
  7 acciones (filtradas por permiso).
- **Mención**: botón `@` con la lista de participantes; inserta `@Nombre` y el servidor la detecta
  (sin acentos ni mayúsculas).
- **Botón `ⓘ`** en la cabecera: abre la ficha (panel lateral en escritorio, hoja en móvil).
- **Paginación**: «Ver mensajes anteriores» (mantiene la posición de lectura).
- Claro/oscuro y móvil/escritorio completos; sin desplazamiento horizontal.

---

## 3. Archivos modificados y nuevos

**Nuevos**

```
server/ops/notify.mjs              avisos (7 tipos), destinatarios, pasada de plazos
tests/ops-notifications.test.js    14 pruebas backend de la Etapa C
tests/panel-ops-fase-c.test.js     7 pruebas de panel de la Etapa C
docs/capturas/ops-ficha-*.png      4 capturas nuevas (móvil/escritorio × claro/oscuro)
docs/capturas/ops-trabajo-*.png    2 capturas nuevas (menú de trabajo)
docs/OPS-CENTER-ETAPA-C.md         este informe
```

**Modificados**

| Archivo | Cambio |
|---|---|
| `server/ops/tickets.mjs` | `taskOf`, `requires_ack`, estado de tarea, `OPS_TASK_ACTIONS`, `taskAction`, `removeParticipant`, `participantDirectory`, paginación en `readTicket`, avisos en creación/asignación/estado/cierre |
| `server/ops/messages.mjs` | contador de no leídos por participante, detección de menciones, avisos por mensaje, `message.created`/`message.read`, acuse delegado en la acción de tarea |
| `server/ops/routes.mjs` | `POST /tickets/:id/task`, `DELETE /tickets/:id/participants/:userId`, `GET /ops/users`, paginación `?before=` |
| `server/scheduler.mjs` | `opsDeadlineTick` en la pasada (con su try/catch) |
| `server/crm-server.mjs` | `notifyOpsUser` (aviso + push), inyección en las rutas y en el scheduler, `notifyUser` expuesto |
| `server/realtime.mjs` | tipos `message.*` y `task.*`, `ticket.status_changed`, `ticket.escalated` |
| `server/audit.mjs` | `ticket_task_updated`, `ticket_task_completed`, `ticket_escalated`, `ticket_participant_removed` |
| `public/admin/ops.js` | ficha, acciones de tarea, menciones, contadores, paginación, deep link `?ticket=` |
| `public/admin/ops.css` | estilos de la Etapa C (+ corrección del estado vacío de la cabecera) |
| `public/admin/index.html` | `ops.js?v=ops-2`, `ops.css?v=ops-2` |
| `public/admin/sw.js` | `VERSION` → `crm-v226-centro-operaciones-c-20261021` |

**No se tocó:** chat de WhatsApp del cliente, pedidos, conversaciones, facturación ni los
cambios de la otra línea de trabajo (galería/tienda/IA de respuesta).

---

## 4. Pruebas de backend (CRM real, SQLite temporal)

`tests/ops-notifications.test.js` — **14/14 verde**

1. La asignación avisa **una vez** al asignado y no se repite al reasignar al mismo.
2. Un mensaje avisa a los demás participantes y **nunca al autor**.
3. `@carlos mendez` (sin tilde, en minúsculas) genera aviso de **mención**.
4. El doble envío del mismo mensaje no duplica **ni mensaje ni aviso**.
5. Leer marca los avisos como `read` con `read_at` y pone el contador a 0.
6. La pasada de plazos avisa **una vez por plazo**; la segunda pasada no avisa.
7. Leer → acusar → completar → resolver: **cuatro estados distintos** y persistentes.
8. Iniciar/avance/problema quedan en la línea de tiempo **con autor** e `issueCount`.
9. Escalar deja `waiting/human`, sube prioridad, avisa a administración y guarda el motivo.
10. Un ticket ajeno no se puede tocar **ni por la ruta de tarea** (403).
11. Participantes: 403 sin permiso, alta correcta, `assignee_locked`, baja de observador.
12. El directorio del equipo exige permiso y **no expone hashes**.
13. El hilo se pagina hacia atrás (`limit` + `before` + `hasMore`).
14. Avisos, acuse y estado **sobreviven al reinicio** del backend.

`tests/ops-tickets.test.js` (Etapa B) — **13/13 verde** (sin regresiones).

## 5. Pruebas de frontend (panel real en jsdom + CRM real)

`tests/panel-ops-fase-c.test.js` — **7/7 verde**

1. La fila muestra **cuántos** sin leer (`2`) y el menú lleva el total.
2. Al abrir el ticket el contador vuelve a **0** (en pantalla y en el servidor).
3. La ficha muestra asunto, estado, responsable, participantes y actividad.
4. «Registrar avance» pide detalle y **queda guardado** (`lastProgressByName` + evento `progress`).
5. «Acusar recibo» se registra y **no cierra** ni completa el ticket.
6. El administrador añade un participante y **el servidor lo guarda** (y se ve por su nombre).
7. El estado de trabajo (acuse hecho) persiste y `requiresAck` sigue marcado.

`tests/panel-ops-uat.test.js` (Etapa B) — **6/6 verde** (sin regresiones).

**Barrido de regresión** (8 archivos): `ops-tickets`, `ops-notifications`, `panel-ops-uat`,
`panel-ops-fase-c`, `realtime`, `sw-privacy` **en verde**; `panel-shell-uat` (2) y
`panel-whatsapp` (1) siguen con los **fallos preexistentes** documentados desde la Etapa B
(`wa-fab`, `openChatActions` y la lista de `setInterval`, que ya tiene 9 en `HEAD`).

---

## 6. UAT en navegador real (Chromium) y capturas

`390×844` y `1440×900`, claro y oscuro, con 3 tickets y 3 usuarios ficticios.

| Medida | Móvil | Escritorio |
|---|---|---|
| Desbordamiento horizontal | ninguna | ninguna |
| Ficha · ancho | hoja completa | **430 px**, dentro de la ventana |
| Ficha · alto | 876 px con scroll interno | 876 px con scroll interno |
| Ficha · filas de datos | 16 | 16 |
| Ficha · participantes | 2 | 2 |
| Ficha · actividad | 2 hechos | 2 hechos |
| Compositor visible | sí | sí |
| Errores de consola / 401 tras entrar | **0** | **0** |

Capturas (`docs/capturas/`, 18 archivos, ~2,3 MB):

| Archivo | Qué demuestra |
|---|---|
| `ops-menu-{movil,escritorio}-claro.png` | «Centro IA» en el menú |
| `ops-lista-{movil,escritorio}-{claro,oscuro}.png` | Bandeja con **contador numérico** y chips de estado/trabajo |
| `ops-chat-{movil,escritorio}-{claro,oscuro}.png` | Hilo con ambos lados, acuse y línea de tiempo |
| `ops-ficha-{movil,escritorio}-{claro,oscuro}.png` | **Ficha**: estado, trabajo, participantes con «leyó/acusó/avisado» y actividad |
| `ops-trabajo-{movil,escritorio}-claro.png` | Menú de las 7 acciones de trabajo |
| `ops-nuevo-{movil,escritorio}-claro.png` | Alta con buscador de pedidos |

---

## 7. Verificación de avisos y acuses (evidencia concreta)

- En la ficha real de la UAT, el participante muestra **`lease #3 · acusó #3 · avisado #2`**: son
  tres marcadores distintos sacados de la base, no del navegador.
- En las pruebas, `user_notifications` del asignado contiene **exactamente una** fila por suceso,
  con `entity_type='ticket'`, `entity_id` del ticket y `deep_link` con su id.
- El autor de un mensaje **no** tiene fila de aviso de su propio mensaje (comprobado por conteo).
- Tras leer, **todas** las filas de ese ticket para esa persona están en `read` con `read_at`.
- `push_jobs` guarda el resultado real (`sent`/`failed`/`expired`/`not_configured`); en UAT no hay
  claves VAPID, así que el estado honesto es `not_configured` y **no se envía nada real**.

---

## 8. Hallazgos de seguridad y concurrencia

1. **Cerrojo de secuencia en memoria** (por ticket): 6 envíos simultáneos → `1..6` sin repetir.
   Supuesto de **una instancia** documentado; con réplicas, `FOR UPDATE SKIP LOCKED`.
2. **Contador de no leídos en servidor**: se incrementa dentro del cerrojo y se recalcula al leer
   (0 si se leyó todo; si no, se cuentan los que quedan). Sobrevive al reinicio.
3. **Idempotencia en dos capas**: `client_key` del mensaje (no duplica mensaje) y
   `idempotency_key` del aviso (no duplica campana/push).
4. **Aviso ≠ permiso**: los destinatarios salen de participantes + (para escalar) administración;
   nunca «todo el equipo». El evento SSE se filtra por audiencia `ticket`.
5. **Proyección por permisos**: el nombre del cliente solo viaja con `clients.read`; el teléfono y
   la dirección **no existen** en el ticket.
6. **Participantes**: 403 sin `tickets.participants.manage`; no se quita al responsable; no se deja
   el ticket sin nadie; el directorio no devuelve hashes ni secretos.
7. **Estado de tarea separado del ticket**: un repartidor puede completar su trabajo
   (`tickets.ack`) pero **no** cerrar el ticket (`tickets.close`).
8. **Escalar exige ser participante** o tener `tickets.read_all`, y sube prioridad y estado.

**Fallo real encontrado y corregido durante la etapa:** las menciones comparaban el `id` de la
**fila de participación** (`opart_…`) con el del usuario; nunca coincidía y no llegaba ningún aviso
de mención. Ahora se usa `participant_id`.

**Segundo fallo corregido:** el tema oscuro de las capturas se revertía porque el panel guarda la
preferencia en `<html data-tema>` y pinta `<html data-theme>`; el UAT tocaba solo la segunda. Se
corrigió el guion (no el producto) y se volvió a medir: todas las capturas oscuras son oscuras.

---

## 9. Riesgos restantes

| Riesgo | Nivel | Nota |
|---|---|---|
| Una sola instancia (cerrojo en memoria) | Medio | Correcto hoy (1 réplica). Documentado; migrar a `SKIP LOCKED` si se escala |
| Sin centro de notificaciones propio en la UI | Bajo | El aviso vive en `user_notifications` y el panel ya tiene su campana; el centro muestra contadores |
| «Entregado» solo verificable en push | Bajo | Se muestra `push_jobs.status`; sin claves VAPID el estado es `not_configured` (honesto) |
| La ficha lista hasta 80 hechos de actividad | Bajo | Suficiente; paginar si se pide historial largo |
| `opsDeadlineTick` recorre hasta 400 tickets | Bajo | Índice por `created_at`; optimizar con índice por `due_at` cuando crezca |
| WhatsApp a empleados | — | **No implementado** (fuera del alcance de la etapa, por indicación) |
| Aviso de estado en cada cambio puede ser ruidoso | Bajo | Se excluye al autor; si molesta, agrupar por ventana en la Etapa D |

---

## 10. GO / NO-GO para la Etapa D

**GO.** Se cumplen los criterios de aceptación: los avisos son fiables y persistentes, la lectura
se distingue del acuse y de la completación, el historial queda completo y la interfaz está lista
(móvil/escritorio, claro/oscuro, sin desbordes, 0 errores de consola).

**Condiciones para arrancar la Etapa D** (agentes):

1. Aprobar por escrito la **lista de herramientas** por agente y sus `scopes` de datos.
2. Aprobar la **política de aprobación humana** para acciones de alto impacto.
3. Aceptar el contrato de eventos de §2.5 como interfaz estable (cambiarlo después obliga a
   versionar `REALTIME_VERSION`).
4. Mantener la regla de que **el agente no recibe `ctx.db`**: solo herramientas y proyecciones.

**Sigue sin publicarse nada:** ni commit, ni push, ni deploy. Producción intacta.
