# Etapa D — Contrato de seguridad y herramientas (APROBADO COMO BASE)

> Este documento se cierra **antes** de implementar ejecución de agentes. Lo que está aquí es
> lo único que el framework permite; cualquier capacidad nueva exige cambiar este archivo y la
> tabla `OPS_TOOLS` a la vez.
> Fecha: 2026-10-21 · Sin producción, sin despliegue, sin push.

---

## 1. Principios no negociables

1. **El ticket es la fuente de verdad.** Todo lo que hace un agente queda en el hilo o en la
   línea de tiempo del ticket, aunque falle el proveedor de IA o se reinicie el servidor.
2. **El agente no tiene base de datos.** Solo herramientas registradas, con esquema y permiso.
3. **El contenido es DATO, no instrucción.** Ni mensajes ni adjuntos se convierten en llamadas.
4. **Lo irreversible exige una persona.** Ninguna herramienta `high_impact` se ejecuta sin una
   aprobación explícita, ligada a parámetros exactos.
5. **Todo es idempotente y auditable.** Cada paso, herramienta y aprobación tiene clave única y
   queda registrado con quién y cuándo.
6. **Sin infraestructura nueva.** Persistencia en las colecciones del CRM; trabajo diferido en el
   scheduler que ya existe; eventos en el bus SSE que ya existe.
7. **Una instancia.** El CRM corre un solo proceso Node; la ejecución usa *lease* en base de datos
   (no memoria) para que un reinicio no pierda ni duplique trabajo.

---

## 2. Contrato de eventos (v1)

Lista cerrada en `server/realtime.mjs`. Todos con `audience: 'ticket'` (solo participantes) y
`requires: 'tickets.read'`. El payload **nunca** lleva cuerpos completos ni datos personales.

| Evento | Cuándo | Datos (resumen) |
|---|---|---|
| `ticket.created` | ticket nuevo | `ticketId`, `type`, `priority`, `requires_ack` |
| `ticket.assigned` | cambia el responsable | `assigned_user_id` |
| `ticket.updated` | cambios de estado/plazo/participantes | `status`, `priority` |
| `ticket.escalated` | escalado o ayuda | `action` |
| `ticket.resolved` | cierre | `status` |
| `message.created` | mensaje interno | `seq`, `message_id`, `author_type`, `mentioned` |
| `message.read` | alguien marca leído | `seq`, `user_id` |
| `task.acknowledged` | acuse de tarea | `task.acknowledged_at` |
| `task.completed` | trabajo completado | `task.completed_at` |
| `agent.execution.started` | arranca un paso de ejecución | `agent_key`, `run_id`, `step` |
| `agent.execution.completed` | termina bien | `agent_key`, `run_id`, `status` |
| `agent.execution.failed` | termina mal | `agent_key`, `run_id`, `error` |

**Versión:** `REALTIME_VERSION = 1`. Cambiar la forma de un payload obliga a subirla.
**Deduplicación:** todo efecto se comprueba por clave (`ops_agent_steps.step_key`,
`ops_tool_calls.idempotency_key`, `ops_agent_approvals.idempotency_key`).
**Replay:** el bus repite eventos al reconectar (`?since=`); el consumidor **no** ejecuta por
recibir un evento, solo marca trabajo pendiente (`next_run_at = now`). Repetir un evento no
repite una acción porque las acciones tienen su propia clave. Los efectos irreversibles solo
ocurren al consumir una aprobación, y su ejecución también es idempotente (`approval:<id>`).

---

## 3. Catálogo de herramientas (`OPS_TOOLS`)

| Herramienta | Efecto | Permiso exigido | Aprobación | Estado |
|---|---|---|---|---|
| `ticket.get_context` | read | `tickets.read` | no | **activa** |
| `order.get_status` | read | `orders.read` | no | **activa** |
| `ticket.post_message` | write | `tickets.reply` | no | **activa** |
| `ticket.request_ack` | write | `tickets.reply` | no | **activa** |
| `ticket.set_follow_up` | write | `tickets.update` | no | **activa** |
| `ticket.escalate` | write | `tickets.reply` | no | **activa** |
| `ticket.complete_work` | write | `tickets.update` | no | **activa** |
| `ticket.close` | high_impact | `tickets.close` | **sí** | activa con aprobación |
| `order.change_total` | high_impact | — | sí | **desactivada** |
| `order.cancel` | high_impact | — | sí | **desactivada** |
| `order.refund` | high_impact | — | sí | **desactivada** |
| `customer.update_sensitive` | high_impact | — | sí | **desactivada** |
| `db.query_raw` | prohibida | — | — | **desactivada** |
| `server.exec` | prohibida | — | — | **desactivada** |
| `whatsapp.send_external` | prohibida | — | — | **desactivada** |

Una herramienta `desactivada` **no se puede asignar** a un agente: el registro la rechaza
(`tool_disabled`). Las prohibidas están solo para dejar escrito que no existen como capacidad.

## 4. Matriz de permisos por agente

Un agente **no** es un rol del CRM. Tiene su propia lista blanca:

```
tickets.read · tickets.read_all · tickets.reply · tickets.ack · tickets.update · orders.read
```

- El registro valida que **todos** los permisos de sus herramientas estén en esa lista
  (`agent_permission_denied` si no).
- `tickets.close` **solo** se ejerce a través de la herramienta con aprobación; el agente no
  puede cerrar un ticket por su cuenta.
- Sin `orders.read`, `order.get_status` devuelve `403` al agente aunque la herramienta esté
  asignada (doble comprobación en ejecución).

## 5. Política de aprobación humana

Se crea una aprobación cuando el plan pide una herramienta `high_impact`.

Registra obligatoriamente: `agent_key`, `ticket_id`, `run_id`, `tool`, `params` (exactos),
`justification`, `required_permission`, `status`, `requested_at`, `expires_at` (24 h),
`decided_by_user_id`, `decided_at`, `decision_note`, `executed_at`, `execution_result`.

Reglas:

1. **Nada se ejecuta antes de aprobar.** El run queda `waiting_human`.
2. **La aprobación vale solo para esos parámetros.** Se guarda un `params_hash`; si el agente
   propone otra cosa, es otra solicitud.
3. **Una sola ejecución.** `idempotency_key = approval:<id>`; aprobar dos veces no repite.
4. **Caduca** a las 24 h (`expired`) y no se puede aprobar después.
5. **Solo ADMIN** (permiso `tickets.approve`) decide. Quien la pide no la aprueba.
6. **Rechazo** → el run se reanuda sabiendo que fue rechazada; el plan escala o termina.
7. Todo queda en la auditoría (`agent_approval_requested`, `agent_approval_decided`,
   `agent_approval_executed`).

## 6. Límites de ejecución

- Un **paso por vuelta** del scheduler (no bucles largos dentro de una petición).
- *Lease* de 60 s; un lease vencido vuelve a `pending` (máx. 5 intentos → `failed`).
- Plazo por paso: 20 s (`withTimeout`); al vencer → `failed` con error estructurado.
- `next_run_at` para reanudar: un evento relevante lo adelanta a «ahora».
- Máximo de mensajes por run: 6 (evita que un agente inunde el hilo).
- Errores: `{ code, message, retryable }`; los no reintentables no se repiten.

## 7. Lo que queda explícitamente FUERA de esta etapa

- Proveedor LLM conectado a producción: se deja la interfaz, **no se activa** ningún modelo
  externo (el planificador es determinista).
- WhatsApp a empleados/clientes desde un agente.
- Cualquier operación financiera, de cancelación, reembolso o borrado.
- Acceso del agente a conversaciones de clientes.

Cambiar cualquiera de estos puntos exige autorización explícita del negocio y una revisión de
este contrato.
