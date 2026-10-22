# Centro IA · Agente de Seguimiento (consolidación de seguimientos y mensajes programados)

**Fecha:** 2026-10-21 · **Alcance:** UAT aislada. **No se ha desplegado nada, ni se ha hecho push,
ni se ha eliminado ni migrado ningún dato.**

La petición era dejar de tener dos pantallas sueltas («Seguimientos» y «Mensajes programados») y
tener **un agente que se ocupe de ese trabajo**, sin un sistema paralelo y sin que la IA pueda enviar
nada por su cuenta. Lo que sigue explica qué se hizo, qué se reutilizó y qué se comprobó.

---

## 1. Auditoría previa: qué había

| Pieza | Dónde vivía | Qué hacía |
| --- | --- | --- |
| Motor de seguimientos | `server/followups.mjs` | Estados `pending/completed/cancelled/skipped`, vencidos/hoy/próximos, completar, omitir, cancelar, posponer, reprogramar, crear a mano, próximo por cliente. Zona `America/Santo_Domingo`. |
| Programador de mensajes | `server/scheduler.mjs` | Cola persistente `scheduled_messages` (`SCHEDULED → PROCESSING → SENT/DELIVERED/READ`, más `FAILED/CANCELLED/BLOCKED`), reintentos, `tick()` propio en el servidor. **Revalida al enviar**: ventana de 24 h, plantilla aprobada, opt-out y conversación; si algo no cuadra, **bloquea**, no fuerza. |
| Rutas | `server/crm-server.mjs` | `POST /api/admin/followups`, `PATCH /api/admin/followups/:id` (`complete/skip/cancel/postpone/reschedule`), `GET/POST /api/admin/scheduled`, `PATCH /api/admin/scheduled/:id` (`cancel/reschedule/edit`). |
| Pantallas | `#view-seguimientos`, `#view-mensajes` | Listas, filtros, búsqueda, creación manual, ficha del cliente. |
| Permisos | `followups.read/create/update/delete` | ADMIN `*`; cancelar/omitir exige `followups.delete`. Quien ve un cliente se decide por conversación (`chats.force_reassign` ⇒ todos). |
| Menú | Grupo «Seguimiento» del cajón | Dos entradas: Seguimientos y Mensajes programados. |

Conclusión de la auditoría: **el trabajo pesado ya existía y funcionaba**. Lo que faltaba era una
puerta única, criterio comercial y una capa de propuestas con aprobación.

## 2. Qué se reutilizó (nada se duplicó)

- **Los mismos motores**: `ctx.followups` y `ctx.scheduler`. El agente los llama; no hay una segunda
  cola ni un segundo estado de seguimientos.
- **Las mismas rutas** para lo que hace una persona desde la lista (completar, posponer, cancelar,
  reprogramar). El panel llama a `PATCH /api/admin/followups/:id` y `PATCH /api/admin/scheduled/:id`.
- **El mismo registro de herramientas** del Centro IA (`server/ops/tools.mjs`) y el mismo motor de
  agentes, aprobaciones y auditoría (`server/ops/agents.mjs`, tabla `ops_agent_approvals`).
- **El mismo chat** del Centro IA para conversar (no hay un chat nuevo).
- **La misma pantalla completa** para quien quiera la vista clásica: «Pantalla completa» navega a
  `#view-seguimientos` / `#view-mensajes` con `fulltech:navigate`.

## 3. El agente

**Agente de Seguimiento** — «Asistente inteligente encargado de organizar seguimientos comerciales,
preparar comunicaciones programadas y ayudar al equipo a mantener una atención oportuna a los
clientes». Clave técnica `followup_agent`, marcado con `config.workMode = 'followups'`. **Su alta la
hace una persona** (botón «Dar de alta» en el Centro IA, permiso `admin.full`); no se crea solo.

Herramientas (9 nuevas, 25 en total en el catálogo):

| Herramienta | Efecto | Permiso del agente | Aprueba quien tenga |
| --- | --- | --- | --- |
| `followup.list` | lectura | `followups.read` | — |
| `schedule.list` | lectura | `messages.read` | — |
| `followup.create` | **solo propuesta** | `followups.propose` | `followups.create` |
| `followup.reschedule` | **solo propuesta** | `followups.propose` | `followups.update` |
| `followup.complete` | **solo propuesta** | `followups.propose` | `followups.update` |
| `followup.cancel` | **solo propuesta** | `followups.propose` | `followups.delete` |
| `schedule.create` | **solo propuesta** | `messages.propose` | `followups.create` |
| `schedule.reschedule` | **solo propuesta** | `messages.propose` | `followups.update` |
| `schedule.cancel` | **solo propuesta** | `messages.propose` | `followups.delete` |

Las siete de escritura llevan `approvalOnly: true`: el motor **rechaza** ejecutarlas si no vienen de
una aprobación (`approval_required`). El agente no puede «decidir» por su cuenta ni aunque el modelo
lo intente.

## 4. Las cuatro secciones del agente

1. **Conversar** — se pregunta en lenguaje normal. La respuesta es texto + **propuestas validadas**.
   El panel dice cuántas propuestas se enviaron a aprobación y cuántas se descartaron (con el motivo).
   Si no hay proveedor de IA, se dice; las listas y la cola siguen funcionando.
2. **Seguimientos** — vencidos / hoy / próximos con cliente, motivo y fecha; botones «Completar»,
   «+1 día» y «Cancelar» (este último solo con `followups.delete`). Son las rutas de siempre.
3. **Programados** — **cola de envío** (`Programado`, `Enviando`, `Falló`, `Bloqueado`) con
   «+1 hora» y «Cancelar», y aparte el **historial reciente** (`Enviado`, `Entregado`, `Leído`,
   `Cancelado`). Se ve de un vistazo qué está pendiente y qué ya salió.
4. **Aprobaciones** — propuestas **Pendientes** con «Aprobar» / «Rechazar», y **actividad reciente**
   (ejecutada, rechazada, quién y cuándo). Aprobar ejecuta de verdad, con los permisos de la persona.

## 5. Datos: nada se ha perdido

- No se ha borrado ni migrado ninguna tabla, fila ni índice. `followups` y `scheduled_messages`
  siguen igual; el agente **lee** esos datos (con el mismo filtro de visibilidad por conversación).
- Los seguimientos y mensajes que ya existían aparecen en el agente y siguen apareciendo en las
  pantallas clásicas.
- Las programaciones pendientes siguen en su cola y se envían con el programador de siempre.

## 6. Estado de una programación (para no confundir tres cosas)

| Concepto | Dónde se ve | Qué significa |
| --- | --- | --- |
| **Recomendación** | Conversar / Aprobaciones (Pendiente) | El agente propone. **No existe** todavía ningún seguimiento ni mensaje. |
| **Programación aprobada** | Programados → cola, chip «Programado» | Existe la fila en `scheduled_messages`, con el **texto exacto aprobado**. Nada se ha enviado. |
| **Mensaje enviado** | Programados → historial, chip «Enviado/Entregado/Leído» | El programador lo envió y WhatsApp respondió. |

El texto que se envía es **el que se aprobó**: al aprobar se congela en la fila de la cola (no se
vuelve a generar). Si al enviar ya no se cumple una regla (ventana de 24 h, plantilla, opt-out,
conversación), la fila pasa a **Bloqueado** con su motivo: no se fuerza el envío.

## 7. Permisos y aprobaciones

- Ver el agente y sus listas: `followups.read`. Conversar: `followups.read`.
- Proponer: el agente usa `followups.propose` / `messages.propose`; **aprobar** exige el permiso de
  la acción concreta (`followups.create/update/delete`). Un OPERADOR puede proponer y aprobar lo que
  su rol permite, pero **no** puede cancelar.
- Un cliente que no lleva el usuario no aparece ni se puede proponer (`not_your_customer`).
- Las propuestas caducan a los **30 minutos** (`proposal_expired`) y una propuesta ya decidida no se
  puede volver a ejecutar (`proposal_consumed`).
- Todo se audita: propuesta, decisión, quién y resultado.

## 8. Lo que NO depende de la IA ni del panel

- El **programador** corre en el servidor: envía lo aprobado aunque el navegador esté cerrado y
  aunque el proveedor de IA esté caído (comprobado en la UAT: chat 503 `llm_unavailable` y el
  mensaje aprobado se envió igual).
- Un seguimiento aprobado es una tarea normal del motor de seguimientos: vive sin el agente.
- El agente **no** interviene en el envío: no hay ningún paso que espere al modelo.

## 9. Archivos

**Nuevos**
- `server/ops/work.mjs` — cerebro del agente: alcance, foto del trabajo, validación, propuestas,
  decisión y ejecución, prompt.
- `tests/ops-seguimiento-agente.test.js` — 12 pruebas de propuesta/aprobación/ejecución.
- `tests/panel-seguimiento-agente-uat.test.js` — 9 pruebas de panel (jsdom) del agente.

**Modificados**
- `server/ops/tools.mjs` — 9 herramientas nuevas, permisos y `approvalOnly` en el catálogo.
- `server/ops/agents.mjs` — guarda `approval_required` en `executeTool`; guarda `workMode`.
- `server/ops/centro.mjs` — `work` en la oficina del agente, contadores y `workAgent` en el directorio.
- `server/ops/routes.mjs` — `GET /api/admin/ops/work`, `POST /work/chat`, `POST /work/agent`,
  `POST /work/propose`, `POST /work/proposals/:id/approve|reject`.
- `server/crm-server.mjs` — inyecta el proveedor de IA en las rutas del Centro IA.
- `public/admin/ops.js` — oficina de trabajo con las cuatro secciones, acciones y refresco por
  pestaña; aviso de alta del agente en el directorio.
- `public/admin/ops.css` — estilos del chat del agente, botones pequeños y aviso de alta.
- `public/admin/index.html` — el grupo «Seguimiento» del cajón queda vacío (con nota); las vistas,
  rutas y enlaces antiguos se conservan.
- `tests/panel-outreach-uat.test.js`, `tests/panel-recordar-uat.test.js` — navegan a esas pantallas
  por la navegación interna (el menú ya no las tiene).
- `tests/ops-centro-ia.test.js` — el catálogo admite los alcances `followup` y `message`.

## 10. Pruebas ejecutadas

| Bloque | Resultado |
| --- | --- |
| `tests/ops-seguimiento-agente.test.js` | 12/12 |
| `tests/panel-seguimiento-agente-uat.test.js` | 9/9 |
| `tests/ops-centro-ia.test.js` | 18/18 |
| `tests/panel-centro-ia-uat.test.js` | 8/8 |
| `tests/followup-engine.test.js`, `tests/seguimiento-programado.test.js` | OK |
| `tests/panel-outreach-uat.test.js` | 10/10 |
| `tests/panel-recordar-uat.test.js` | 1 fallo **preexistente** (valor inválido en `pe_prefs`) |

Lo que demuestran, en corto: una propuesta **no crea nada**; al aprobarla se crea el seguimiento real
o la fila de la cola con el texto exacto; aprobar dos veces no duplica; rechazar no ejecuta nada; un
operador recibe 403 al aprobar una cancelación y administración la ejecuta; fuera de la ventana de
24 h se responde `outside_window` y no se programa; una propuesta caducada no se aprueba; el chat sin
proveedor devuelve 503 y **el mensaje aprobado se envía igual** con `scheduler.tick()`.

**Regresión amplia** (48 archivos de panel/agentes/supervisor: 675 pruebas): 617 pasan y 58 fallan.
Los 58 fallos **ya existen en el commit anterior** (`HEAD~1`), comprobado ejecutando las mismas
pruebas en un árbol limpio de ese commit: `panel-blindaje` (2), `panel-hoy` (2), `panel-perfil` (1),
`panel-programados` (9), `panel-recordar` (1), `panel-conv-list` (5), `panel-location` (7),
`panel-media` (1), `panel-mensajes` (1), `panel-offline` (2), `panel-pedido-confirmar` (2),
`panel-sales` (5), `panel-shell` (2). Ninguno tiene que ver con este cambio.

> **Actualización (auditoría final, §14.4):** la medición definitiva se hizo por archivo contra
> `HEAD~1` y con el conteo confirmado. El reparto final es el de esa tabla; la única diferencia real
> es `panel-sales-uat`, cuyos rojos extra vienen de los cambios de otros escritores incluidos en el
> mismo commit (revertidos en un worktree → vuelve a 6). Ver §14.4.

## 11. Riesgos y límites conocidos

1. **El programador y el servidor son un solo proceso**: la cola se procesa en `tick()`. Si el
   servidor está caído, nada se envía hasta que vuelva (con reintentos). No se ha cambiado.
2. **`approvalOnly` es una defensa de motor, no de interfaz**: si alguien con permiso llama a la ruta
   de aprobación, ejecuta. Es lo esperado (esa persona es la aprobación), y queda auditado.
3. **La ventana de 24 h manda**: si la conversación se enfría, el mensaje aprobado se bloquea con
   motivo. Es la regla de WhatsApp, no una decisión del agente.
4. **El chat necesita proveedor**: sin clave de IA el agente no conversa (503). Las listas, la cola y
   el programador siguen funcionando.
5. **Dos escritores en el repositorio**: durante el trabajo, un proceso externo ha ido confirmando
   cambios en `main` (commit `4fdad86`, también en `origin/main`). Este trabajo **no ha hecho commit,
   push ni despliegue**.

## 12. Estado Git

- Rama `main`, HEAD `4fdad86` («impotante»), también en `origin/main`.
- Sin commit, sin push y sin despliegue por mi parte.
- Cambios locales pendientes: `tests/panel-outreach-uat.test.js`, `tests/panel-recordar-uat.test.js`
  (adaptación a que el menú ya no tiene esas dos entradas).

## 13. Veredicto

**GO en UAT aislada.** La consolidación funciona, conserva los datos y las programaciones, no crea un
sistema paralelo y ninguna escritura ocurre sin aprobación humana.

**NO-GO de despliegue** hasta que el negocio valide el tono de los mensajes propuestos y se decida
quién aprueba en producción. Y antes de publicar hay que resolver los fallos de panel preexistentes
(listados arriba), que no son de este cambio pero están en el mismo árbol.

---

# 14. Auditoría final de integración (2026-10-21)

Revisión de integridad, autorización, regresiones y UAT en navegador real. **Sin commit, sin push,
sin despliegue y sin tocar producción.**

## 14.1 Estado de Git verificado

| Dato | Valor |
| --- | --- |
| Rama | `main` |
| HEAD | `4fdad86` («impotante», Junior Lopez, 2026-10-21 20:21 −04:00) |
| `origin/main` | `4fdad86` (el commit ya está publicado por otra persona/automatización) |
| Árbol de trabajo | **sucio**: cambios míos + cambios en curso de otros escritores |
| Otros worktrees | `%TEMP%\release-store-notify` en `release/store-notify` (`ef14852`), limpio, sin tocar |

`4fdad86` es un commit **ómnibus**: 105 archivos que mezclan esta entrega con trabajo ajeno
(asistente IA contextual, POS premium, tienda, capturas). Incluye lo mío: `server/ops/work.mjs`,
`server/ops/{centro,collaboration}.mjs`, `tools/agents/routes`, `public/admin/{ops.js,ops.css,index.html}`,
`tests/{ops-seguimiento-agente,panel-seguimiento-agente-uat,ops-centro-ia,panel-centro-ia-uat}.test.js`
y las capturas `centro-ia-*`. Verificado leyendo el propio commit (`git show HEAD:<archivo>`), no el
árbol de trabajo.

**Cambios sin confirmar (míos, de esta auditoría):**

| Archivo | Qué |
| --- | --- |
| `server/ops/work.mjs` | cerrojo de una sola ejecución por propuesta (`proposal_busy`) |
| `public/admin/offline.js` | las rutas del agente no se encolan; su 503 se muestra tal cual |
| `public/admin/index.html` | `offline.js?v=33` |
| `tests/ops-seguimiento-agente.test.js` | +3 pruebas (carrera, parámetros sellados, ventana al enviar) |
| `tests/offline-24h.test.js`, `tests/panel-outreach-uat.test.js`, `tests/panel-recordar-uat.test.js` | navegación a las pantallas retiradas del menú |
| `docs/DECISIONES.md`, `docs/CENTRO-IA-SEGUIMIENTO.md` | decisión §52 e informe |
| `docs/capturas/audit-seguimiento-*.png` | 5 capturas de la UAT real |

**Cambios sin confirmar de otros escritores** (no los he tocado): `public/admin/{app.js,admin.css,
assistant.js,assistant.css,pos.js,pos.css,store.js,store.css,sw.js}`, `server/{assistant,proofreading}.mjs`,
`scripts/optimize-ui-icons.py`, `tests/{assistant-ia,deepseek-proofreading,pos-panel,store-panel,
panel-conv-list-uat}.test.js` y sus capturas. Estaban limpios al empezar la auditoría y han cambiado
mientras se ejecutaba: el árbol está en obras.

## 14.2 Integración funcional (navegador real, Chromium)

Script: `.tmp/audit-uat-seguimiento.mjs` · **58/58 comprobaciones OK** en 4 pasadas
(escritorio 1440×900 y móvil 390×844, claro y oscuro), con un WhatsApp simulado que **solo apunta**
lo que se enviaría.

- El cajón del menú abre, tiene **Centro IA** y **no** tiene «Seguimientos» ni «Mensajes programados».
- `#view-seguimientos` y `#view-mensajes` siguen existiendo y abren con `?v=seguimientos` y
  `?v=mensajes` (enlaces antiguos).
- La oficina del agente muestra las cuatro secciones: `chat, followups, scheduled, approvals`.
- Seguimiento real visible; cola con el texto aprobado y chip **Programado**; aprobar desde el
  navegador crea el seguimiento (1→2→3→4→5, una por pasada).
- **Cero desbordamiento horizontal** (`documentElement.scrollWidth − innerWidth = 0`) en las cuatro
  combinaciones. En 390 px la barra de pestañas se desplaza en horizontal (`overflow-x:auto`): las
  cuatro son alcanzables, no se sale de la página.
- **Cero errores de consola** (se filtran el 401 de sesión previo al acceso y los 4xx/5xx que la
  propia prueba provoca).
- Con el modelo apagado, el chat dice «El modelo no respondió. Las listas y las programaciones siguen
  funcionando.» y **no inventa**.
- **Estado de carga comprobado** con la red del chat retrasada 900 ms: mientras el agente «piensa»,
  el botón se deshabilita y dice «Pensando…» (y la caja de texto también se bloquea); al terminar
  vuelve a «Preguntar» habilitado.
- Con el navegador cerrado, `scheduler.tick()` envía el mensaje aprobado (estado `SENT`) y **solo**
  ese: 1 envío simulado en toda la UAT.

Capturas: `docs/capturas/audit-seguimiento-{escritorio,movil}-{light,dark}.png` y
`audit-seguimiento-movil-oscuro-aprobaciones.png`.

## 14.3 Seguridad (con prueba, no por lectura)

| Garantía | Cómo se comprobó | Resultado |
| --- | --- | --- |
| Una propuesta no ejecuta antes de aprobar | cola y seguimientos antes/después de proponer | sin cambios |
| Se ejecuta **lo propuesto**, no lo que mande el cliente | aprobar con `params:{text:'OTRO TEXTO'}` en el cuerpo → la fila guarda el texto aprobado | OK |
| Aprobar dos veces no duplica | secuencial → `proposal_consumed`; 5 aprobaciones HTTP simultáneas → 1 ejecución; dos llamadas solapadas → `proposal_busy` | OK |
| Rechazada no ejecuta | rechazar y contar seguimientos | 0 creados |
| Caducada no ejecuta | `expires_at` al pasado → `proposal_expired` | OK |
| Sin permiso no se aprueba | operador aprueba `followup.cancel` → 403; admin → ejecuta | OK |
| Ventana de 24 h | sin ventana → `outside_window`; ventana cerrada **después** de aprobar → la fila queda `BLOCKED` y **no sale nada** | OK |
| El programador no salta el contrato | el texto enviado es el congelado al aprobar; revalida al enviar y bloquea | OK |

**Hallazgo corregido (defecto real de integración):** la capa offline del panel
(`public/admin/offline.js`) envolvía **cualquier** POST con `x-fulltech-operation` y convertía un
**503 legítimo del servidor** en `409 offline_operation_uncertain` («necesita revisión»), dejando
además la operación en `processing`. En un navegador real eso significaba que el chat **nunca**
recibía `llm_unavailable`: mostraba «Esta acción requiere conexión con el servicio» aunque hubiera
red. Arreglado en dos pasos: (1) las rutas `/ops/work/...` van a la lista de escrituras protegidas
(no se encolan: conversar es una pregunta y aprobar es una decisión que no se puede repetir a
ciegas); (2) si el servidor contesta 5xx con JSON en esas rutas, se devuelve su respuesta tal cual.
Verificado: el navegador recibe `503` y el panel muestra el motivo real.

**Riesgo declarado (no reproducido en este entorno):** el cerrojo de aprobaciones es **del proceso**
(`Set` en memoria). El servidor es un único proceso por diseño, así que es correcto; si algún día se
ejecuta en varios procesos o contra PostgreSQL en diferido, hará falta un *compare-and-set* en la
base (hoy `db.update` es leer-y-escribir).

## 14.4 Clasificación de la regresión (medida, no supuesta)

Familia ejecutada: 51 archivos `ops-*`, `panel-*`, `supervisor-*`, `llm-*`, `deepseek-*`, `offline-*`,
`assistant-*`, `seguimiento-*`, `followup-*`. Se comparó contra un **worktree limpio de `HEAD~1`**
(antes de esta entrega) ejecutando los mismos archivos.

| Archivo | Ahora | `HEAD~1` | Clasificación |
| --- | --- | --- | --- |
| `panel-sales-uat` | 17 | 6 | **+11 ajenos** (verificado: revirtiendo en el worktree los archivos de los otros escritores incluidos en `4fdad86` vuelve a **6**) |
| `panel-programados-uat` | 10 | 10 | preexistente |
| `panel-location-uat` | 7 | 7 | preexistente |
| `panel-conv-list-uat` | 3 | 5 | preexistente (inestable) |
| `panel-blindaje-uat` | 2 | 2 | preexistente |
| `panel-hoy-uat` | 2 | 2 | preexistente |
| `panel-offline-uat` | 2 | 2 | preexistente |
| `panel-pedido-confirmar-uat` | 2 | 2 | preexistente |
| `offline-24h` | 2 | 2 | preexistente (mismo error: `pe_crm_snapshot.auth` nulo) |
| `panel-media-uat` | 1 | 1 | preexistente |
| `panel-mensajes-uat` | 1 | 1 | preexistente |
| `panel-perfil-uat` | 1 | 1 | preexistente |
| `panel-recordar-uat` | 1 | 1 | preexistente |

**Supuestos de prueba obsoletos por esta entrega (corregidos, no «maquillados»):** tres archivos
navegaban pulsando `[data-tab="seguimientos"]` / `[data-tab="mensajes"]`, entradas que ya no existen.
`panel-outreach-uat` y `panel-recordar-uat` ahora usan `fulltech:navigate` (el mismo camino de los
enlaces antiguos) y se les añadió una comprobación **positiva** de que el grupo «Seguimiento» ya no
está en el menú. `offline-24h` usa el mismo fallback en su recorrido de pantallas: vuelve a fallar
exactamente donde fallaba antes (línea `pe_crm_snapshot`), no antes.

**Comportamiento realmente roto (ajeno, en zona crítica):** `panel-sales-uat` sigue 6 rojos desde
antes de esta entrega y la mitad son de verdad: `#wa-actions` **ya no existe en el marcado** —
desapareció en `84c649f` («sin botón flotante de acciones») y `app.js` aún lo referencia; el POS ya
no tiene `[data-pos-discount="total"]` (rediseño de POS, `premium-*`). Comprobado también en
navegador real: `#wa-actions: false`, `[data-pos-discount]: false`, sin errores de JS. No es de este
trabajo y no lo he tocado: lo tiene que resolver su autor.

## 14.5 Veredicto de la auditoría

**GO técnico del Agente de Seguimiento** en UAT aislada: integración verificada, seguridad con
prueba, cero regresiones propias, UAT real en 4 combinaciones.

**NO-GO de producción**, por causas ajenas a esta entrega:

1. El árbol de trabajo tiene trabajo ajeno a medias (POS, asistente, tienda, `sw.js`) y `HEAD` ya
   está en `origin/main` mezclado en un commit ómnibus.
2. `panel-sales-uat`: 17 rojos, 11 de ellos introducidos por esos cambios ajenos en zona de
   facturación/POS; y `#wa-actions` desaparecido del marcado.
3. Fallos preexistentes en `panel-programados`, `panel-location`, `panel-blindaje`, `panel-hoy`,
   `panel-offline`, `panel-pedido-confirmar`, `panel-perfil`, `panel-mensajes`, `panel-media`,
   `panel-recordar` y `offline-24h`.

Antes de publicar: congelar el árbol, que cada autor cierre sus rojos, volver a ejecutar esta misma
tabla y repetir la UAT de navegador. El Agente de Seguimiento, por su parte, está listo.

---

# 15. La pantalla de agentes: dos listones (2026-10-21)

Lo que se pidió: **una sola pantalla con los dos agentes en listones, uno debajo del otro**, y al
pulsar uno, su oficina con todo lo suyo.

## 15.1 Qué se cambió

| Antes | Ahora |
| --- | --- |
| Cabecera «Agentes \| Tickets \| **Supervisor IA**»: el supervisor salía dos veces (acceso suelto + su fila). | Cabecera «Agentes \| Tickets». El supervisor solo existe como **fila**; su pantalla única se abre desde su propia oficina («Pantalla del supervisor»). |
| Las tarjetas vivían en una columna de 780 px, con medio panel vacío al lado. | `.centro-team` a todo el ancho del lienzo (1180 px), una fila por agente, apiladas. |
| Si un agente no estaba dado de alta, **desaparecía** (podías ver un solo listón sin saber por qué). | La lista muestra **siempre** los dos: el que falta aparece como «Sin dar de alta», con su botón **Dar de alta** en la propia fila. |

El alta sigue siendo explícita (nada se registra solo): el servidor manda la definición por defecto
del agente conocido (`knownAgents` en `GET /api/admin/ops/centro`) y el botón la envía a
`POST /api/admin/ops/agents` (solo administración).

## 15.2 Por qué no se «veía» el arreglo anterior

El panel es una PWA: el service worker sirve **el `index.html` de su caché**. En el arreglo anterior
solo se subió la versión de los recursos (`ops.js?v=ops-7` → `ops-8`) dentro del HTML, pero **no** la
`VERSION` del service worker: la app seguía sirviendo el HTML cacheado con `ops-7`, así que no había
nada nuevo que pintar y tampoco aparecía la barra «Actualizar» (el `sw.js` era idéntico byte a byte).

Ahora `sw.js` es `crm-v255-centro-ia-listones-20261021`, lo que hace que el navegador instale un
service worker nuevo, refresque el armazón y ofrezca «Actualizar». Comprobado con un perfil real:
el SW queda al mando y su caché `crm-v255-…` guarda `index.html` con `ops.js?v=ops-8` y
`ops.css?v=ops-8` (y los dos archivos versionados).

Para verlo en un aparato que ya tenía la app abierta: abrir el panel y pulsar **Actualizar** en la
barra que aparece; si no sale, **Ajustes → Buscar actualización** (o recargar con Ctrl+F5).

## 15.3 Comprobado en navegador real

- Con **un solo** agente dado de alta, la pantalla muestra **dos listones** (el segundo, «Sin dar de
  alta», con su botón). Tras pulsarlo quedan dos agentes reales y el pendiente desaparece.
- Los dos listones abren su oficina y se vuelve a la lista con «← Agentes».
- Escritorio 1440×900 y móvil 390×844, claro y oscuro: apilados, a todo el ancho, sin desbordamiento.
- Suites: `panel-centro-ia-uat` (8), `panel-seguimiento-agente-uat` (9), `ops-centro-ia` (18) y
  `ops-seguimiento-agente` (15) en verde.

Capturas: `docs/capturas/equipo-agentes-{escritorio,movil}-{light,dark}.png`,
`equipo-agentes-dos-listones-antes.png` (uno de alta y el otro pendiente),
`equipo-agentes-dos-listones.png` (los dos dados de alta),
`equipo-agentes-oficina-supervisor.png` y `equipo-agentes-supervisor-pantalla.png`.

---

# 16. Los iconos del menú no se veían (2026-10-21)

## 16.1 La causa

El marcado declara los iconos del menú de dos formas:

```html
<span class="drawer__icon" data-icon="img:sun"></span>      <!-- la imagen configurada -->
<span class="drawer__icon" data-icon="gear"></span>         <!-- un trazo vectorial -->
```

`paintIcons()` (en `app.js`) solo miraba el mapa de **vectoriales** (`ICONS`), así que las claves
`img:sun`, `img:orders`, `img:cart`… no existían y el hueco se quedaba **vacío**. No había ningún
error de red que lo delatara (el PNG ni se pedía): por eso «no cargan y no se ve por qué».

## 16.2 El arreglo

`paintIcons()` ahora atiende las dos familias:

- `img:nombre` → `<img class="app-icon" src="/admin/assets/icons/ui/nombre.png">` (el estilo
  `.drawer__icon .app-icon` ya existía con 20×20).
- cualquier otra clave → el trazo vectorial de `ICONS`.

Si un PNG faltara, se anota en el hueco (`data-icon-missing`) y la fila no se rompe. Y como los 18
iconos de `assets/icons/ui/*.png` ya están en la lista `SHELL` del service worker, **se ven también
sin conexión**: comprobado bloqueando las peticiones de `/assets/icons/ui/**` y recargando, los
iconos siguen saliendo de la caché.

## 16.3 Para verlo en un aparato que ya tenía la app

El `app.js` cambió, así que se publicó con URL nueva (`app.js?v=premium-35`) y se subió la versión
del service worker a `crm-v256-iconos-menu-20261021`. En el panel: abrir y pulsar **Actualizar** en
la barra; si no aparece, **Ajustes → Buscar actualización** (o Ctrl+F5 en escritorio).

Capturas: `docs/capturas/menu-iconos-escritorio.png`, `menu-iconos-movil-oscuro.png` y
`menu-iconos-sin-red.png` (con las peticiones de los PNG bloqueadas).

## 16.4 El botón del menú en móvil (mismo día)

La cabecera móvil (`.dashboard-head__menu`, la de la pantalla HOY) llevaba **solo** las tres barras
CSS, pero la regla `.dashboard-head__menu:not([aria-expanded='true']) .burger { display: none }`
las ocultaba esperando la imagen del menú… que no estaba. Resultado: un **cuadro vacío** en la
esquina. Ahora ese botón lleva también `menu.png` (22×22), igual que el botón flotante: cerrado se
ve el icono, y al abrir vuelven las barras (aspa). Comprobado en navegador: escritorio 54×54 con
imagen 22×22, móvil 42×42 con imagen 22×22, y el cajón con sus 26 entradas y **ningún** hueco vacío.
El botón del menú de WhatsApp (`.wa__menu`) se queda con sus barras: si se le añade la imagen
saldrían los dos iconos a la vez.

Capturas: `docs/capturas/menu-boton-escritorio.png`, `menu-boton-movil.png` y `menu-cajon-movil.png`.

---

# 17. Facturación: la X flotante de cerrar (2026-10-22)

En la pantalla de Facturación había **dos** botones con forma de X y no eran lo mismo:

| Botón | Dónde | Qué hacía | Qué se hizo |
| --- | --- | --- | --- |
| `.pos-swipe-close` («Cerrar facturación») | Flotante, fijo arriba a la derecha (`position:fixed`), justo encima del nombre del ticket | Salía de Facturación y volvía a la pestaña anterior | **Eliminado** (lo pidió el negocio: para salir está el «←» del appbar) |
| `[data-pos-remove-client]` («Quitar cliente») | En la fila del cliente | Quita el cliente de la venta, **no** cierra la pantalla | Se quedó como estaba (mi primer cambio lo movió sin que se hubiera pedido y se revirtió) |

El botón flotante vivía en `app.js`, en la cabecera móvil de `state.tab === 'catalogo'`, con
`position:fixed; top:66px; right:12px`: por eso parecía «flotar sobre el nombre del ticket».

Comprobado en navegador real: ya no existe `.pos-swipe-close` ni `[data-billing-close]`; el chip del
ticket sigue mostrando el nombre del cliente; el «←» del appbar sigue sacando de Facturación
(`hoy → catalogo → hoy`); y «Quitar cliente» sigue en su sitio. Pruebas: `pos-panel` y `store-panel`
**50/50**, y `panel-centro-ia-uat` en verde (58/58 en el lote).

Publicado con `app.js?v=premium-37` y service worker `crm-v259-facturacion-sin-x-20261022`.
Captura: `docs/capturas/facturacion-sin-x-flotante.png`.
