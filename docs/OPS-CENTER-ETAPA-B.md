# Centro de Operaciones IA — Etapa B (bandeja + conversación de tickets)

> **Estado:** ETAPA B COMPLETADA · **sin commit, sin push, sin deploy, sin tocar producción.**
> Base de diseño: `docs/OPS-CENTER-ETAPA-A.md` (aprobada).
> Fecha: 2026-10-21 · Datos usados en UAT: **ficticios** (`@uat.local`, «Cliente UAT»).

---

## 1. Resultado en una frase

Ya existe un **espacio de trabajo interno real**: tickets que se guardan en la base,
conversaciones con identidad, hora, leído/acuse separados, búsqueda, filtros, alta manual
o desde un pedido, y una pantalla propia (móvil y escritorio, claro y oscuro) que **no
comparte ni una línea con el chat de WhatsApp del cliente**.

Lo que **no** hay todavía (por diseño de la etapa): agentes ejecutándose, aprobaciones
humanas, notificaciones push propias del ticket ni mensajería por WhatsApp a empleados.
El modelo de datos ya los contempla.

---

## 2. Requisitos de la etapa → dónde se cumple

| # | Requisito | Estado | Dónde |
|---|---|---|---|
| 1 | Preservar los 29 cambios ajenos y el CRM actual | ✅ | No se tocó ninguno; `git status` lo confirma (§10) |
| 2 | No modificar el chat de WhatsApp del cliente | ✅ | Colecciones, rutas y pantalla separadas; `app.js` solo suma 4 líneas |
| 3 | Arquitectura aditiva `ops_*` | ✅ | 4 colecciones nuevas, prefijo físico `phytoemagry_ops_*` |
| 4 | Tickets y conversaciones persistentes con autorización real en el servidor | ✅ | `server/ops/*.mjs`, §4 y §5 |
| 5 | Bandeja + chat premium, móvil primero, identidad propia | ✅ | `public/admin/ops.{js,css}`, §6 |
| 6 | Alta manual y desde un pedido, con antiduplicado fiable | ✅ | `POST /api/admin/ops/tickets` + `active_key` |
| 7 | Mensajes con autor, hora, no leídos e historial | ✅ | `ops_ticket_messages` + participantes |
| 8 | Modelo preparado para agentes, sin ejecutarlos | ✅ | `author_type` (`user/agent/system/tool`), estados `waiting_on`, `ops_ticket_events` |
| 9 | Reutilizar SSE, scheduler, permisos, notificaciones y auditoría | ✅ | SSE (`ticket.*`), auditoría (7 acciones), permisos por rol; scheduler y notificaciones **no se usan aún** (no hay trabajo diferido en B) |
| 10 | Validación en servidor, control de acceso, idempotencia, persistencia | ✅ | §4, §5 |
| 11 | Los tickets sobreviven a recarga y reinicio | ✅ | Prueba con reinicio real del backend (§7) |
| 12 | Móvil y escritorio, claro y oscuro | ✅ | 12 capturas y medidas reales (§7) |
| 13 | UAT en navegador real con tickets y usuarios ficticios | ✅ | Chromium, 390×844 y 1440×900, §7 |

---

## 3. Archivos

**Nuevos**

```
server/ops/tickets.mjs      dominio: tipos, estados, dedupe, numeración, proyección por permisos
server/ops/messages.mjs     hilo: secuencia por ticket, idempotencia, lectura y acuse
server/ops/routes.mjs       rutas /api/admin/ops/* con `can(...)`
public/admin/ops.js         pantalla (módulo ESM, escucha fulltech:tab)
public/admin/ops.css        piel propia, todo bajo body[data-tab='ops'] y prefijo .ops-
tests/ops-tickets.test.js   13 pruebas contra el CRM real
tests/panel-ops-uat.test.js 6 pruebas del panel real (jsdom) con la navegación de verdad
docs/capturas/ops-*.png     12 capturas de evidencia
docs/OPS-CENTER-ETAPA-B.md  este informe
```

**Modificados (mínimos y justificados)**

| Archivo | Cambio |
|---|---|
| `server/collections.mjs` | +4 colecciones `ops_*` (solo aditivo) |
| `server/users.mjs` | permisos `tickets.*` en AGENT, DELIVERY y OPERADOR (ADMIN ya tiene `*`) |
| `server/audit.mjs` | +7 acciones cerradas `ticket_*` |
| `server/realtime.mjs` | +5 tipos `ticket.*` y audiencia `ticket` (solo participantes) |
| `server/crm-server.mjs` | import + **una** delegación a `handleOpsRoute` con `findOrder`/`listOrders` inyectados |
| `public/admin/index.html` | hoja `ops.css`, vista `#view-ops`, script `ops.js` y entrada «Centro IA» en el menú |
| `public/admin/app.js` | 4 líneas: `VIEWS`, subtítulo, y `ops` en las dos listas del rol DELIVERY |
| `public/admin/sw.js` | `ops.js`/`ops.css` al shell y `VERSION` → `crm-v225-centro-operaciones-20261021` |

---

## 4. Modelo de datos (lo que hay de verdad en la base)

```js
ops_tickets:            number(único) type entity_type entity_id status waiting_on priority
                        assigned_user_id assigned_agent_id parent_ticket_id due_at follow_up_at
                        last_message_at active_key(único) created_at
ops_ticket_messages:    ticket_id seq_key author_type author_id kind client_key(único) created_at
ops_ticket_participants: ticket_id participant_type participant_id role last_read_seq last_ack_seq created_at
ops_ticket_events:      ticket_id kind actor_id created_at idempotency_key(único)
```

Detalles que importan:

- **`active_key` único y liberable**: se rellena solo si se puede afirmar *qué flujo* es.
  Con pedido → `delivery:order:<id>:delivery`. Sin pedido, con `idempotencyKey` del
  formulario → `idem:<clave>`. Sin ninguna de las dos cosas → `NULL` (dos incidencias
  manuales con el mismo título son DOS trabajos, no un duplicado). Al cerrar se pone a
  `NULL` y el pedido puede tener otro ticket más adelante; el histórico no se borra.
- **`seq` + `seq_key`**: secuencia por ticket asignada dentro de un cerrojo en memoria y
  guardada con ceros delante para que ordenar por la columna indexada (texto) coincida con
  ordenar por número. Sin eso, «10» saldría antes que «9».
- **Estados separados**: `last_read_seq` (leído) y `last_ack_seq` (acuse) son columnas
  distintas. Ninguna de las dos cierra nada.
- **Proyección por permisos**: el nombre del cliente solo viaja con `clients.read`. El
  teléfono y la dirección **nunca** forman parte del ticket.

---

## 5. API y autorización

Todas las rutas viven bajo `/api/admin/` (sesión + CSRF ya existentes) y exigen
`tickets.read` como puerta de entrada.

| Método | Ruta | Permiso extra | Qué hace |
|---|---|---|---|
| GET | `/api/admin/ops/inbox?filter=&q=&type=` | — | Lista recortada por participación (o `read_all`) |
| GET | `/api/admin/ops/summary` | — | Contadores (abiertos, sin leer, en espera, urgentes, míos) |
| GET | `/api/admin/ops/orders?q=` | `orders.read` | Buscador de pedidos para vincular (sin datos sensibles) |
| GET | `/api/admin/ops/orders/:id/ticket` | — | El ticket activo de ese pedido, si existe |
| POST | `/api/admin/ops/tickets` | `tickets.create` | Alta (manual o con `entityType/entityId`) |
| GET | `/api/admin/ops/tickets/:id` | participante o `read_all` | Ticket + mensajes + eventos + participantes + permisos |
| PATCH | `/api/admin/ops/tickets/:id` | `tickets.update` | Estado (abierto/en curso/en espera), prioridad, plazos, asignación |
| POST | `/api/admin/ops/tickets/:id/messages` | `tickets.reply` | Mensaje (idempotente por `clientKey`) |
| POST | `/api/admin/ops/tickets/:id/read` | participante | Cursor de lectura |
| POST | `/api/admin/ops/tickets/:id/ack` | `tickets.ack` | Acuse explícito (hecho en la línea de tiempo) |
| POST | `/api/admin/ops/tickets/:id/resolve` | `tickets.close` | Cierra (o cancela con `cancelled:true`) y libera el flujo |
| POST | `/api/admin/ops/tickets/:id/participants` | `tickets.participants.manage` | Añade persona al hilo |

**Permisos añadidos**

- AGENT / OPERADOR: leer todo, crear, responder, acusar, actualizar, cerrar, gestionar participantes.
- DELIVERY: `tickets.read`, `tickets.reply`, `tickets.ack` → **solo sus tickets** (no tiene
  `read_all` y no puede cerrar).
- ADMIN: `*` (como siempre).

**Prueba de aislamiento real** (`tests/ops-tickets.test.js`): un repartidor recibe **403** al
abrir un ticket ajeno, no lo ve en su bandeja y no puede escribir en él; sí trabaja en el
que tiene asignado.

**Tiempo real**: se publican `ticket.created/updated/message/assigned/resolved` con
`audience: 'ticket'`; el filtro del bus solo se los entrega a los participantes (o a quien
puede verlos todos). El evento no lleva el texto del mensaje.

**Auditoría**: `ticket_created`, `ticket_message_sent`, `ticket_acknowledged`,
`ticket_status_changed`, `ticket_assigned`, `ticket_resolved`, `ticket_participant_added`.

---

## 6. Interfaz

- Entrada **«Centro IA»** en el menú lateral, con contador de no leídos
  (`data-drawer-badge="ops"`), en una sección «Operación» propia para que también se
  alcance en móvil (la sección «Principal» está oculta en móvil).
- **Bandeja**: buscador, 7 filtros en una sola fila desplazable, filas de **91 px** con
  icono por tipo, número, título, estado, prioridad, responsable y vista previa; punto azul
  de no leído.
- **Conversación**: cabecera de **56 px** (móvil) / **58 px** (escritorio) con número, chip
  de estado, título a una línea y menú `⋯`; burbujas propias (azul) y ajenas (blancas) con
  nombre y hora; separador de día; la línea de tiempo (apertura, acuses, cambios de estado)
  se pinta como hechos sueltos; botón **«Acusar recibo»** solo cuando hay algo sin acusar;
  compositor con `Enter` para enviar y `Shift+Enter` para salto.
- **Alta**: hoja con tipo, prioridad, asunto, detalle y **buscador de pedidos** (por número
  o cliente) que vincula el ticket al pedido real.
- **Resolver**: hoja con nota opcional; avisa de que cerrar libera el flujo.
- **Móvil primero**: una columna (lista ↔ conversación) con `100dvh`; en la conversación
  se retira la cabecera general para no duplicar el ←.
- **Escritorio**: dos columnas (372 px + resto), tarjetas redondeadas.
- **Oscuro**: bloque propio con ancla completa (`:root[data-theme='dark'] body[data-tab='ops']`).
- Sin temporizadores: los avisos llegan por SSE y al volver a la pestaña se refresca una vez.

---

## 7. Pruebas

### 7.1 Automatizadas (CRM real, SQLite temporal)

`tests/ops-tickets.test.js` — **13/13 verde**

1. Alta manual: número `TK-XXXXXX`, creador participante `owner`.
2. Rechaza tipo inválido (422 `invalid_type`) y asunto corto (422 `invalid_title`).
3. Ticket de pedido: `entityId` real, resumen copiado del pedido; segundo intento **409
   `duplicate_ticket` con el mismo id**; pedido inexistente → 404 `order_not_found`.
4. Mensaje: `seq=1`, autor real, ticket pasa a `in_progress`, vista previa actualizada.
5. **Idempotencia**: el mismo `clientKey` devuelve `duplicate:true` y **una** sola fila.
6. **Concurrencia**: 6 envíos simultáneos → secuencias `1..6` sin huecos ni repetidos.
7. Mensaje vacío → 422; escribir en ticket cerrado → 409 `ticket_closed`.
8. Dos tickets manuales con el mismo título son dos tickets.
9. El mismo formulario dos veces (mismo `idempotencyKey`) devuelve el MISMO ticket.
10. Leer no acusa (`ackPending` pasa a true), acusar no cierra, y el acuse queda en eventos.
11. Aislamiento del repartidor (403 / no aparece / no escribe).
12. El repartidor sí responde en su ticket y **no** puede cerrarlo (403).
13. Cerrar libera el flujo (segundo ticket del mismo pedido) y conserva el histórico.
14. **Reinicio del backend** (`app.close()` + arranque nuevo): el ticket y su mensaje siguen.

`tests/panel-ops-uat.test.js` — **6/6 verde** (panel real en jsdom + CRM real)

1. «Centro IA» existe en el menú y la vista abre vacía de verdad (sin filas inventadas).
2. Se crea un ticket desde el formulario y **está en el servidor** con su prioridad.
3. Se abre el hilo, se escribe y el mensaje sale como propio con el nombre real; está en la base.
4. «Acusar recibo» deja el hecho y **no** cierra el ticket.
5. Filtros y búsqueda recortan con datos reales.
6. Al salir y volver a la pestaña, los tickets y el hilo siguen ahí.

### 7.2 Regresión de lo tocado

`ops-tickets`, `panel-ops-uat`, `realtime`, `sw-privacy`, `collections-legacy-collision`,
`auth-users-assignment`, `crm-server` → **7 archivos, 90 pass / 2 skip**.

Fallos **preexistentes** (comprobados contra `HEAD`, no son de esta etapa):

- `panel-shell-uat` (2): esperan `class="wa-fab"` y el texto «Crear pedido» dentro de
  `openChatActions` — código que ya no existe en `HEAD`.
- `panel-whatsapp` (1): la lista de `setInterval` del test espera 8 y **`HEAD` ya tiene 9**
  (verificado extrayendo el archivo de `HEAD`).

### 7.3 UAT en navegador real (Chromium)

`390×844` y `1440×900`, claro y oscuro, con 3 tickets y 3 usuarios ficticios.

| Medida | Móvil | Escritorio |
|---|---|---|
| Desbordamiento horizontal | ninguno (390 = 390) | ninguno (1440 = 1440) |
| Alto de fila | 91 px | 91 px |
| Cabecera del ticket | 56 px | 58 px |
| Compositor visible | sí (95 px con acuse) | sí (101 px) |
| Mensajes en el hilo | 3 (2 propios + 1 ajeno) | 3 |
| Hilo desplazado al final | sí (scrollTop = scrollHeight − clientHeight) | sí |
| Errores de consola / 401 después de entrar | **0** | **0** |

Capturas (`docs/capturas/`):

- `ops-menu-movil-claro.png`, `ops-menu-escritorio-claro.png` — la entrada «Centro IA» en el menú.
- `ops-lista-{movil,escritorio}-{claro,oscuro}.png` — bandeja en los cuatro casos.
- `ops-chat-{movil,escritorio}-{claro,oscuro}.png` — conversación con ambos lados y acuse.
- `ops-nuevo-{movil,escritorio}-claro.png` — alta con buscador de pedidos.

---

## 8. Fallos reales encontrados y corregidos durante la etapa

Quedan documentados porque son los que volverían a aparecer:

1. **Deduplicación demasiado agresiva.** La primera versión calculaba la clave de flujo
   también sin pedido (`admin:admin`), así que **dos incidencias manuales distintas se
   fusionaban en una**. Lo cazó la prueba de concurrencia (7 mensajes donde había 6 envíos:
   el segundo ticket había devuelto 409 con el primero). Ahora la clave exige pedido o
   `idempotencyKey`; si no, no hay deduplicación.
2. **`form.title` no es el campo «Asunto».** Es la propiedad `title` del `<form>` (cadena
   vacía) y tiene prioridad sobre el acceso por nombre: el formulario decía siempre
   «escribe un asunto». Se leen los campos con `form.querySelector('[name=…]')`.
3. **El comodín `*` de ADMIN no se interpretaba en el cliente**, así que el administrador
   veía «Sin acceso» en su propio módulo. Ahora `can()` trata `*` como todos los permisos.
4. **En escritorio el compositor quedaba fuera de pantalla** cuando el panel mostraba una
   franja encima (permiso de notificaciones): `.content` con `height:100%` no descuenta esa
   franja. Se pasó a columna flex con `flex:1 / min-height:0`.
5. **El ticket de tipo «entrega» exigía pedido.** Una incidencia de reparto puede no tener
   pedido todavía: ahora el vínculo es opcional y solo se valida si se indica.
6. **Trabajo asíncrono tocando el DOM tras cerrar la página** (rechazo no controlado en
   pruebas y en una pestaña descargada). Guardas `domAlive()` en las funciones de pintado.
7. **El botón «Acusar recibo» no aparecía nunca** en un hilo propio: la proyección que
   devuelve el envío trae `myReadSeq` antiguo. Tras enviar se marca leído en el servidor.
8. **Doble borde en el buscador de pedidos** de la hoja de alta (heredaba el estilo de los
   campos del formulario). El estilo de campo ahora se aplica solo a hijos directos.

---

## 9. Riesgos restantes

| Riesgo | Nivel | Nota / siguiente paso |
|---|---|---|
| Sin notificaciones propias del ticket (push/in-app) | Medio | Previsto en la Etapa C; hoy el aviso es el contador y el SSE en vivo |
| La bandeja lee hasta 250 tickets y filtra en memoria | Bajo | Suficiente para el volumen actual (decenas); paginar cuando pase de ~1.000 |
| `findOrder`/buscador recorren los pedidos (`listAdmin` 5.000) | Bajo | Solo en alta/vínculo; optimizar con índice cuando crezca |
| Secuencia con cerrojo en memoria | Bajo | Correcto con 1 proceso (el CRM actual); con réplicas → `FOR UPDATE` |
| La franja de permisos del panel puede tapar el compositor | Mitigado | La altura ya es flexible; comprobado con la franja visible |
| Escritor concurrente en `app.js` | Medio | Mis cambios son 4 líneas; cualquier conflicto se resuelve a mano |
| `docs/capturas/` crece | Bajo | 12 PNG de ~200 KB; borrables sin afectar al código |
| No hay «ficha/participantes» en la UI | Bajo | La ruta existe y está probada; la pantalla llega en la Etapa C |

---

## 10. Trabajo ajeno preservado

`git status` mantiene los cambios de la otra línea de trabajo (galería de productos, tienda
pública, IA de respuesta) **intactos**: `public/admin/{offline.js,proofreading.js,store.css,store.js,product-editor.css}`,
`public/store/*`, `server/{proofreading,store-*}.mjs`, `package*.json` y sus pruebas.
Además aparecieron **dos archivos de prueba modificados por ese mismo escritor durante esta
sesión** (`tests/auth-users-assignment.test.js`, `tests/conversation-resolution.test.js`) y
un cambio en `openChatActions` (`chats.take_unassigned`) dentro de `app.js`: **no son míos y
no se han tocado**.

---

## 11. GO / NO-GO

**GO para la Etapa C** (participantes en pantalla, notificaciones internas + push, completa
de tarea, contadores por persona). Lo entregado es una base sólida y probada:

- persistencia real verificada, incluso tras reiniciar el backend;
- permisos comprobados en el servidor, con prueba explícita de acceso denegado;
- idempotencia y concurrencia probadas con envíos simultáneos;
- UI medida en cuatro combinaciones (móvil/escritorio × claro/oscuro) sin desbordes ni
  errores de consola.

**NO-GO** para la Etapa D (agentes) hasta que se aprueben, por escrito: la lista de
herramientas por agente, la política de aprobación humana para acciones de alto impacto y el
mapa de identidad WhatsApp ↔ empleado (`crm_users` sigue sin teléfono).

**Nada de esto se ha publicado.** Sin commit, sin push, sin deploy y sin tocar producción.
