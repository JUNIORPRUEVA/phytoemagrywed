# Centro IA — rediseño y agentes que rinden cuentas (2026-10-22)

**Alcance:** auditoría + rediseño de interfaz + capa conversacional de lectura + oportunidades comerciales.
**Producción:** no tocada · **Sin commit, sin push, sin despliegue** · UAT aislada en `data/uat/`.

---

## 1. Auditoría: lo que ya había (y se ha reutilizado)

| Pieza | Dónde está | Estado encontrado |
| --- | --- | --- |
| Centro de operaciones (3 pantallas: equipo → oficina → tickets) | `public/admin/ops.js` (~3.100 líneas), `#view-ops` | Funcionaba; cabecera con 4 tarjetas de estadísticas + fila de iconos |
| Directorio de agentes | `directoryHtml()` + `server/ops/centro.mjs` (`KNOWN_AGENTS`, `centroDirectory`) | Listones apilados; estado real derivado de los *runs* |
| Oficina de un agente | `agentOffice()` (`centro.mjs`) + `officeHtml()` | Tarjeta grande que repetía nombre, rol, responsabilidades y estadísticas |
| Tickets y mensajes internos | `server/ops/tickets.mjs`, `messages.mjs`, `collaboration.mjs` | Completo (acuses, tareas, delegaciones, aprobaciones) |
| Motor de agentes | `server/ops/agents.mjs` (planificador determinista del supervisor) | Completo: saluda, pide acuse, responde, pide cierre, escala, pide ayuda, espera |
| Agente de Seguimiento | `server/ops/work.mjs` (7 acciones, 9 herramientas, propuestas) | Completo y **solo por aprobación humana** |
| Aprobaciones | `ops_agent_approvals` + `decideWorkProposal` (con bloqueo anti-duplicado) | Completo |
| Seguimientos y mensajes programados | `ctx.followups`, `ctx.scheduler` | Completos; el programador envía sin depender del navegador |
| Permisos | `tickets.read`, `tickets.close`, `followups.*`, `admin.full` | Comprobados en el backend |
| Proveedor de IA en las rutas de ops | `handleOpsRoute({..., llm})` | **No se inyecta** → la conversación no tenía modelo: `/work/chat` devolvía **503** |

**Hallazgo principal:** la arquitectura está completa y es sólida; lo que faltaba era (a) la capa que permite **preguntarle a un agente por su trabajo con datos reales**, (b) las **oportunidades comerciales** con evidencia, y (c) una interfaz acorde.

## 2. Cambios visuales

- Cabecera: **«Centro IA»** con subtítulo «Tu equipo de asistentes inteligentes».
- **Eliminadas** las cuatro tarjetas (agentes activos / trabajando / pendientes / sin leer) y la **fila de iconos** del encabezado. Los datos siguen existiendo (`/ops/centro` los devuelve) y las funciones se reubicaron:
  - Aprobaciones y administración de agentes → **«Actividad y tickets»** (donde ya estaban).
  - Atajo discreto de aprobaciones en el listado, **solo si hay pendientes**.
- Navegación: **Agentes | Actividad y tickets** (sin menús redundantes; el enlace «Todos los tickets» del listado se quitó porque repetía la pestaña).
- Listado: filas compactas (87 px de alto a 390 px) con avatar, nombre, función, estado real y un indicador de actividad; sin estadísticas grandes.
- Detalle: **cabecera de dos líneas en móvil** (volver, avatar, nombre, especialidad, estado y la acción propia), **sin** la tarjeta grande ni el botón «Pantalla completa» (duplicaba navegación; las vistas siguen existiendo para enlaces antiguos).
- Conversación: ocupa el resto de la pantalla; el **compositor queda abajo dentro del flujo** (`position: static`, columna flex, `100dvh` con `env(safe-area-inset-bottom)`), el hilo hace su propio scroll y **no se tapa ningún mensaje**.
- Las respuestas se pintan con **formato seguro**: se escapa todo y solo se reconocen párrafos y listas `·`/`-`; nunca se inyecta HTML del modelo.

## 3. Agentes mejorados

### 3.1 Ambos agentes admiten preguntas (nuevo)

`POST /api/admin/ops/agents/:key/ask` → `server/ops/ask.mjs`

- Construye **hechos verificables** con los registros existentes: tickets asignados, ejecuciones pendientes (estado, paso, próximo intento, último error), últimos 12 pasos de actividad con su ticket, delegaciones, avisos y contadores.
- El Agente de Seguimiento añade seguimientos, cola de programados, propuestas y oportunidades.
- **Distingue** tarea pedida / planificada / en ejecución / terminada / fallida / propuesta pendiente / aprobada.
- Si no hay registros, lo dice («Todavía no tengo pasos registrados»). Si no hay modelo, contesta con el **resumen determinista** de esos mismos hechos (`source: 'registros'`) — ver §6.
- El **Supervisor de reparto conserva su pauta determinista**: esto solo LEE, no cambia tiempos, acuses ni escalamientos.

### 3.2 El Agente de Seguimiento rinde cuentas y ve oportunidades

- `/work/chat` ya no devuelve 503 sin modelo: responde con sus registros (sin proponer nada).
- Nuevo bloque **«Oportunidades reales»** en su pestaña *Seguimientos* (`GET /api/admin/ops/work/commercial`).

## 4. Oportunidades comerciales (Fase 5–7)

`server/ops/commercial.mjs` — **solo lectura, acotada y con evidencia**:

| Bloque | Cómo se calcula (datos reales) | Límite |
| --- | --- | --- |
| **Recompra** | Compró antes (`has_purchase`), **sin pedido abierto** y **≥ 21 días** desde la última compra. Se muestra «Compró hace N días» | 8 filas |
| **Recuperación** | Conversaciones `awaiting_reply` (el último mensaje lo escribió el cliente); pedidos `nuevo`/`confirmado` con ≥ 2 días; seguimientos vencidos | 8 filas cada uno |
| **Fidelización** | Clientes con ≥ 2 pedidos **entregados**, ordenados por pedidos e importe | 8 filas |
| **Excluidos** | `do_not_contact` o baja de WhatsApp: **nunca** se proponen, solo se cuentan | — |

- No afirma que un cliente «consumió» nada ni que «necesita» reposición: solo fechas, pedidos y estados.
- No atribuye ventas a seguimientos (el sistema no lo puede verificar) y el prompt lo prohíbe explícitamente.
- Se le pasa al modelo **el resumen ya calculado** (nunca la base): como mucho 5.000 pedidos y 8 filas por bloque.
- **Limitación declarada:** las cotizaciones del POS no se cuentan (viven en el documento del ticket, no ligadas al cliente en este resumen). El propio resumen lo dice.

## 5. Permisos y aprobaciones

- `/ask` y `/work/commercial` exigen sesión + `tickets.read` / `followups.read`; sin sesión → **401** (probado).
- La visibilidad comercial usa la **misma regla** que la pantalla de seguimientos (`chats.force_reassign` → todo; si no, solo las conversaciones asignadas).
- Ninguna propuesta se ejecuta sin aprobación: se mantiene `ops_agent_approvals` con su bloqueo anti-duplicado (una sola ejecución aunque lleguen varias aprobaciones).
- **No hay envío automático de WhatsApp**: lo que sale lo envía el programador de mensajes ya aprobados; en UAT es MOCK (`data/uat/envios.log`). Comprobado: 0 envíos tras toda la UAT.

## 6. Estado real de la IA (importante)

**Actualizado 2026-10-22 (ver `docs/CENTRO-IA-MODELO.md`):** el proveedor ya está conectado a las
rutas del Centro IA. `handleOpsRoute` recibe `llm` (`plan`, JSON) y `ai` (`answer`, texto libre), los
dos del MISMO servicio del corrector (misma clave, plazo, tope por minuto y límite diario).

- Las respuestas llegan con `source: 'modelo'`, modelo y milisegundos; si el proveedor cae, con
  `source: 'registros'` y el motivo (`sin_configurar`, `limite`, `plazo`…) — nunca simulando razonamiento.
- Cada consulta queda auditada como `ops.agent_asked` con tokens y tiempo.

Lo que sigue es el estado **antes** de esa integración, conservado como historial.

## 7. Archivos

| Archivo | Qué |
| --- | --- |
| `server/ops/ask.mjs` | **Nuevo**: hechos + respuesta de cada agente (con o sin modelo) |
| `server/ops/commercial.mjs` | **Nuevo**: oportunidades acotadas con evidencia |
| `server/ops/routes.mjs` | Rutas `/ask` y `/work/commercial`; `/work/chat` responde sin modelo; oportunidades en el prompt |
| `server/ops/work.mjs` | Prompt con especialidad comercial y reglas (sin causalidad, sin promesas de salud, respetar consentimiento) |
| `public/admin/ops.js` | Cabecera «Centro IA», sin tarjetas ni iconos, navegación nueva, detalle compacto, conversación con compositor, sugerencias, preguntas al agente, bloque de oportunidades |
| `public/admin/ops.css` | Cabecera compacta, columna de conversación, compositor, sugerencias (claro y oscuro) |
| `public/admin/index.html` | `ops.css`/`ops.js` → `v=ops-10` |
| `public/admin/sw.js` | `VERSION = 'crm-v262-centro-ia-premium-20261022'` |
| `tests/panel-centro-ia-uat.test.js` | Adaptado al diseño nuevo + prueba de «pregúntale y contesta con sus registros» |

## 8. Pruebas

- `panel-centro-ia-uat` → **9/9** (incluye: abre en la conversación, cabecera compacta, sin tarjeta vieja, preguntas de un clic y respuesta con sus registros, sin envíos).
- Lote relacionado (`pos-panel`, `store-panel`, `historial de cierres`) → **71/71**.
- **Navegador real (Chromium, UAT aislada)** → **22/22**: cabecera y navegación, sin estadísticas ni iconos, filas compactas, cabecera de dos líneas, compositor `static` y visible, hilo con 6 mensajes sin solape, 360/390/430 px y escritorio, claro y oscuro, **0 px de desborde**, consola limpia.
- Pruebas de API: `/ask` 200 con hechos reales para los dos agentes, **401 sin sesión**, `/work/commercial` 200 con 7 conversaciones sin responder, 1 cliente frecuente y 1 excluido.
- `offline-24h` mantiene **2 fallos previos** (verificados sobre `HEAD` sin estos cambios; ajenos).

Capturas en `docs/capturas/`: `centro-ia-lista-390.png`, `centro-ia-conversacion-supervisor-390.png`,
`centro-ia-conversacion-larga-390.png`, `centro-ia-agente-seguimiento-390.png`,
`centro-ia-oportunidades-390.png`, `centro-ia-conversacion-390-oscuro.png`,
`centro-ia-detalle-360.png`, `centro-ia-detalle-430.png`,
`centro-ia-lista-escritorio.png`, `centro-ia-conversacion-escritorio.png`.

> Nota de honestidad: **todo se probó en Chromium**. No se han hecho pruebas en iPhone/Safari ni Android real.

## 9. Rendimiento

- El listado ya no pinta 4 tarjetas de estadísticas y la oficina no calcula totales por repintado.
- Las oportunidades se piden **aparte** (`/work/commercial`): la oficina abre igual aunque ese resumen tarde o falle; si falla, el bloque simplemente no aparece (no se inventan cifras).
- El compositor **no se bloquea** mientras se espera: solo el botón Enviar, para no duplicar la llamada; el campo sigue editable.
- Las respuestas se acotan en el servidor (mensaje 800 caracteres, hechos de 12 pasos y 8 filas por bloque) para no disparar tokens.
- Nada de esto toca el arranque del CRM ni la bandeja.

## 10. Riesgos que quedan

1. **No hay modelo conectado** a las rutas de ops (§6): las respuestas son resúmenes de registros. Conectarlo es un cambio pequeño y aislado, pendiente de autorización.
2. **Cotizaciones del POS** no entran en oportunidades (limitación declarada en la propia respuesta).
3. La oficina del agente se sirve con `tickets.read` y **no filtra por participación** (comportamiento previo al cambio, no ampliado aquí). Endurecerlo requiere exponer los participantes en `agentOffice`.
4. Tope de **5.000 registros** en `store.listAdmin` (patrón de todo el servidor); el resumen comercial lo marca con `revisado.truncado`.
5. La altura de la conversación usa `100dvh`: correcta en navegadores actuales; en alguno antiguo puede quedar un borde.

## 11. Estado Git

Sin cambios de otros módulos. Modificados: `server/ops/{routes,work}.mjs`, `public/admin/{ops.js,ops.css,index.html,sw.js}`, `tests/panel-centro-ia-uat.test.js`. Nuevos: `server/ops/{ask,commercial}.mjs`, este informe y 10 capturas. **Nada commiteado ni desplegado.**

## 12. GO / NO-GO

- **GO** para revisar y publicar esta entrega: el Centro IA se ve y se comporta como un equipo, cada agente tiene su conversación, responde con datos reales y sigue sin poder ejecutar nada sin aprobación.
- **Modelo conectado** (2026-10-22): ver `docs/CENTRO-IA-MODELO.md` para el detalle de la integración,
  el consumo medido y las limitaciones. Las respuestas ya las redacta `deepseek-flash` sobre los hechos
  autorizados, con respaldo a registros cuando el proveedor no responde.
