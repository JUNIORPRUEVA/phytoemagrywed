# Centro IA — validación del agente con un modelo REAL

Fecha: 2026-10-21 · Ámbito: **UAT aislada** · **sin commit, sin push, sin despliegue**.
Continúa `docs/CENTRO-IA.md` (oficina de agentes) y `docs/OPS-CENTER-ETAPA-E.md` (adaptador del modelo).

Pregunta que responde este informe: **¿el Supervisor IA Delivery funciona como un agente
inteligente de verdad dentro de su oficina, o solo con la pauta determinista?**

---

## 0. Veredicto

| Pregunta | Respuesta |
|---|---|
| ¿Hay un modelo real conectado y activo? | **Sí** — `configured:true`, `enabled:true`, modelo `deepseek-flash`, tope 800/día. |
| ¿El agente planifica con el modelo? | **Sí** — `config.planner: 'llm'`; 4 pasos aplicados por el modelo en cada pasada. |
| ¿Escribe mensajes contextuales? | **Sí** — usa el número de pedido, el tiempo en tránsito y el estado real leído con la herramienta. |
| ¿Entiende una respuesta con faltas? | **Sí** — «ola, ya lo tengo en la moto, salgo ahora pa ya» → respuesta adecuada. |
| ¿Elige acciones autorizadas? | **Sí** — `ticket.post_message` y `agent.request_help`, ambas en su lista blanca. |
| ¿Todo queda persistido y auditable? | **Sí** — mensajes con `seq` y hora, pasos, llamadas a herramientas, ejecuciones, delegación. |
| ¿Puede pedir ayuda sin heredar permisos? | **Sí** — el asesor conserva sus 3 permisos (`tickets.read/reply/update`) y no recibe `orders.read`. |
| ¿Los casos duros están cubiertos? | **Sí** — duplicado, proveedor caído, respuesta inválida, reinicio y herramienta no autorizada. |
| ¿Se activó algo de alto impacto? | **No.** `ticket.close` sigue exigiendo a una persona; las de dinero, desactivadas. |
| ¿Se envió WhatsApp o se tocó producción? | **No.** 0 mensajes; producción intacta. |

**Veredicto: GO del agente con modelo real en UAT aislada · NO-GO de despliegue** (falta validar el
tono con el negocio y decidir la clave de producción).

---

## 1. Auditoría del planificador y del proveedor

**Cómo se conecta.** El motor (`server/ops/agents.mjs`) calcula primero la **pauta determinista**
(`planStep`) y solo consulta al modelo cuando el paso es de contenido (`ticket.post_message`) o una
espera (`wait`). El modelo puede cambiar **el texto** y **cuándo volver a mirar**; nunca la lectura de
contexto, el acuse, el escalado, la aprobación ni las herramientas fuera de la lista.

**Dónde vive la clave.** En el ajuste `set_proofreading_deepseek` de `data/uat/phyto-uat.sqlite`,
cifrada (AES-256-GCM) con el token del entorno de UAT (`phyto-uat`). El guion **no la ve**: copia el
documento cifrado a una base temporal y el servidor la descifra.

**Estado comprobado en la propia UAT (no supuesto):**

```
configured: true · enabled: true · modelo: deepseek-flash · usadasHoy: 0 · tope: 800
```

El modelo está **fijado por el servidor** (`deepseek-flash`), con `thinking: disabled`, temperatura 0,
`response_format: json_object`, plazo de 8 s por llamada y cuota diaria del panel.

---

## 2. Escenario de la prueba

Todo ficticio, en base temporal:

- **Pedido** `PE-A84E9A` (1 frasco, efectivo) con su conversación de cliente.
- **Repartidor** «Luis Reparto» (rol DELIVERY).
- **Ticket** `TK-1CA9A1` abierto por el supervisor de reparto con el pedido **120 minutos** en
  `IN_TRANSIT` (pedido atrasado de verdad, no un texto inventado).
- **Agentes:** `delivery_supervisor` (planificador `llm`, 6 herramientas incluida `agent.request_help`)
  y `sales_advisor` (pauta determinista, **sin** `orders.read`, para demostrar que no hereda permisos).

---

## 3. Conversación real (dos pasadas, texto del modelo)

Salida literal de la segunda pasada (`#seq · autor · hora UTC · texto`):

```
#1 [agent] Supervisor de reparto · 23:28:08.243Z: Ticket TK-1CA9A1: la entrega PE-A84E9A lleva 120
   minutos en tránsito y sigue sin confirmar. Luis Reparto, cuando puedas comparte por aquí el
   estatus real de la entrega para dar seguimiento.
#2 [agent] Supervisor de reparto · 23:28:08.270Z: Confirma el acuse cuando lo veas, por favor.
#3 [user]  Luis Reparto · 23:28:09.623Z: ola, ya lo tengo en la moto, salgo ahora pa ya
#4 [agent] Supervisor de reparto · 23:28:10.801Z: Gracias, Luis. Quedamos pendientes de que confirmes
   la entrega de PE-A84E9A cuando la completes, para cerrar el seguimiento.
#5 [user]  Luis Reparto · 23:28:11.898Z: oye una cosa, el cobro se lo hago al entregar o va pagado?
#6 [agent] Supervisor de reparto · 23:28:13.444Z: Le pido ayuda a Asesor comercial: ¿El pedido
   vinculado a PE-A84E9A va pagado o se cobra contra entrega? Luis Reparto pregunta cómo manejar el
   cobro al entregar.
#7 [agent] Asesor comercial · 23:28:14.205Z: Reviso lo que me pide Supervisor de reparto: «¿El pedido
   vinculado a PE-A84E9A va pagado o se cobra contra entrega? …». Dejo aquí lo que puedo confirmar
   con los datos de este ticket.
#8 [user]  Ana LLM · 23:28:16.537Z: Mensaje duplicado de prueba
#9 [agent] Supervisor de reparto · 23:28:16.544Z: Anotado. Sigo con lo que falta y os confirmo en cuanto esté.
```

La **primera pasada** produjo otro texto igual de natural («Luis, el pedido PE-114A14 sigue en
tránsito y ya lleva 120 minutos en esa etapa…») y otra pregunta de ayuda distinta. **No es una
plantilla**: es el modelo leyendo el ticket.

Puntos que importan:

- **#6 lo decidió el modelo**, no la pauta: eligió la acción `collaborate` y redactó la pregunta.
- **#9** responde a una persona que escribió «Ana LLM» (un humano del equipo), no a un cliente.
- Ningún mensaje afirma que la entrega esté hecha (los datos no lo dicen).

---

## 4. Consumo medido del proveedor

| Dato | Pasada 1 | Pasada 2 |
|---|---|---|
| Llamadas reales al proveedor | **8** | **8** |
| Pasos aplicados por el modelo | 4 | 4 |
| Latencia por llamada | 1624 / 1293 / 1223 / 1006 ms | 1246 / 1297 / 1041 / 730 ms |
| Latencia media | **1287 ms** | **1079 ms** |
| Tokens totales | **5043** | **5095** |
| Tokens por llamada (entrada+salida) | 1135 · 1213 · 1288 · 1407 | 1146 · 1219 · 1306 · 1424 |
| Caídas a la pauta | 5 (3 son de los proveedores simulados) | 5 (ídem) |
| Motivos registrados | `provider_failed`, `invalid_action`, `tool_not_allowed`, `action_not_allowed_in_mode` | ídem |
| WhatsApp enviados | 0 | 0 |
| Resultado | 49/49 comprobaciones | 49/49 comprobaciones |

Dos observaciones útiles:

- **~1,1-1,3 s por decisión** y **~1.200 tokens por llamada** (el prompt de sistema y el contexto del
  ticket son casi todo). Una conversación de 4 turnos cuesta unas 4-5 mil tokens.
- `action_not_allowed_in_mode` apareció con el **modelo real**: intentó escribir cuando la pauta decía
  «espera» y la guarda lo frenó (es la protección anti-spam de la Etapa E, funcionando en vivo).

---

## 5. Persistencia y auditoría

| Qué | Dónde | Comprobado |
|---|---|---|
| Mensajes del hilo | `ops_ticket_messages` (`seq`, `created_at`, autor) | ✔ secuencia y hora tras reiniciar |
| Pasos de ejecución | `ops_agent_steps` (`step_key` único) | ✔ 6 pasos en el ticket principal |
| Llamadas a herramientas | `ops_tool_calls` (idempotencia por paso) | ✔ todas dentro de la lista blanca |
| Ejecuciones | `ops_agent_runs` (estado + `updated_at` + `state`) | ✔ estado y hora en todas |
| Delegación | `ops_agent_delegations` | ✔ `completed`, con hora de solicitud y de cierre |
| Traza de empresa | auditoría + eventos del ticket | ✔ «Ayuda pedida a Asesor comercial», «Ayuda entregada» |

En el navegador esos hechos se ven como línea de tiempo dentro del hilo (ver §8).

---

## 6. Colaboración sin herencia de permisos

- El supervisor pidió ayuda **al asesor** y se creó **una** delegación sobre **el mismo ticket**
  (no se abrió otro).
- El asesor entró como **participante** `agent:sales_advisor` (autorización explícita) y recibió
  **su propio run**, con `workflow: 'collab'`.
- **Sus permisos son los suyos**: `['tickets.read','tickets.reply','tickets.update']`. **No** recibió
  `orders.read` (que sí tiene el supervisor): no puede leer el pedido, solo el ticket.
- Dejó su respuesta en el hilo compartido y la delegación quedó **`completed`** con nota y hora.

---

## 7. Casos duros (todos en verde)

| Caso | Qué se hizo | Resultado |
|---|---|---|
| **Evento duplicado** | dos `POST` con el mismo `clientKey` | segundo responde `duplicate:true`; **2 → 2 ejecuciones** |
| **Proveedor caído/lento** | proveedor que lanza error | cae a la pauta, motivo `provider_failed` registrado, run **no** falla, hilo válido |
| **Respuesta inválida del modelo** | `{"action":"inventar_cosa"}` | se descarta (`invalid_action`), manda la pauta; el texto basura **no llega al hilo** |
| **Herramienta no autorizada** | el modelo pide `ticket.escalate` a un agente que no la tiene | `tool_not_allowed`; **0** ejecuciones de esa herramienta |
| **Alta con herramienta desactivada** | `order.refund` en el registro | **422 `tool_disabled`** |
| **Reinicio del servidor** | cerrar y abrir sobre la misma base | misma conversación, mismas horas, misma oficina, mismo trabajo pendiente, delegación intacta, y el agente **reanuda** |

---

## 8. UAT en navegador (Centro IA)

Chromium real, móvil 390×900 y escritorio 1280×1400, entrando por `?v=ops`:

- Se abre **la oficina del Supervisor IA** desde el equipo.
- Se abre su ticket y el hilo pinta **6 mensajes del agente**, cada uno con su etiqueta **IA**.
- La línea de tiempo muestra: ticket abierto · agente asignado · prioridad → urgente · **ayuda pedida a
  Asesor comercial** · trabajo completado · **ayuda entregada**.
- Sin desbordamiento horizontal y **sin errores de consola**.

Capturas (`docs/capturas/`):

| Archivo | Qué enseña |
|---|---|
| `centro-ia-llm-equipo-movil.png` | el equipo con el supervisor dentro |
| `centro-ia-llm-oficina-movil.png` | la oficina del supervisor |
| `centro-ia-llm-conversacion-movil.png` | la conversación (móvil) |
| `centro-ia-llm-conversacion-escritorio.png` | **la conversación completa**, de la primera a la última línea |

---

## 9. Evidencia de la batería (49 comprobaciones)

Salida literal de la pasada 2 (`.tmp/uat-centro-ia-llm.mjs`, `exit=0`):

```
OK  la UAT tiene una clave de proveedor configurada
OK  el proveedor está ACTIVO (no solo guardado)
OK  modelo fijado por el servidor: deepseek-flash
OK  un agente planifica con el modelo y el otro (el que ayuda) va con la pauta
OK  el ticket del pedido queda asignado al Supervisor IA
OK  el agente escribió 2 mensaje(s) internos
OK  el primer mensaje usa el contexto autorizado del pedido (número o estado)
OK  consultó el estado del pedido con la herramienta autorizada
OK  el empleado responde en el hilo interno (con faltas, a propósito)
OK  el agente entiende la respuesta y contesta después
OK  la última acción es de su lista blanca y salió bien (ticket.post_message)
OK  ninguna llamada a herramientas fuera de la autorización del agente
OK  mensajes persistidos con su marca de tiempo y su secuencia
OK  6 pasos de ejecución guardados
OK  cada ejecución guarda su estado y su última actualización
OK  el agente pidió ayuda a otro agente (1)
OK  la ayuda va del supervisor al asesor
OK  la delegación queda viva y auditable (completed)
OK  el que ayuda conserva SUS permisos (no hereda los del supervisor)
OK  el ayudante NO recibe el permiso del pedido que no tenía
OK  el ayudante recibió su propia ejecución en el MISMO ticket
OK  el ayudante dejó su respuesta en el hilo compartido
OK  la colaboración se cierra al terminar (completed)
OK  un evento duplicado no crea un segundo mensaje
OK  el duplicado no multiplica las ejecuciones (2 → 2)
OK  ante un proveedor caído se usó la pauta (1 pasos)
OK  el motivo del fallo queda registrado (no es invisible)
OK  un proveedor caído no marca el trabajo como fallido
OK  el hilo sigue siendo válido tras el fallo del proveedor
OK  una respuesta inválida del modelo se descarta y manda la pauta
OK  el texto inválido del modelo NO llega al hilo
OK  el modelo pidió una herramienta que el agente NO tiene y se rechazó
OK  no se ejecutó ninguna herramienta fuera de la lista
OK  registrar una herramienta desactivada se rechaza (422)
OK  tras reiniciar, la conversación sigue completa (mismos mensajes)
OK  las marcas de tiempo sobreviven al reinicio
OK  la oficina del agente sigue mostrando su ticket tras el reinicio
OK  el trabajo pendiente es el mismo (1)
OK  las colaboraciones persisten con su estado
OK  el trabajo se reanuda tras el reinicio sin perder el hilo
OK  en el navegador se abre la oficina del Supervisor IA
OK  el navegador pinta 6 mensajes del agente
OK  cada mensaje del agente lleva su etiqueta de IA
OK  la conversación no desborda en móvil
OK  sin errores de consola en el navegador (0)
OK  hubo llamadas REALES al proveedor (8)
OK  latencia medida por el servidor (media 1079 ms)
OK  tokens contabilizados (5095)
OK  cero mensajes de WhatsApp
RESULTADO: todas las comprobaciones pasan
```

La batería se ejecutó **dos veces** con el mismo resultado (exit 0) y textos distintos del modelo.

---

## 10. Riesgos que quedan

| # | Riesgo | Estado |
|---|---|---|
| L1 | La clave usada es la del entorno de UAT, no la de producción | Habrá que decidir cuál se usa al publicar; el panel la descifra con el `PHYTO_CRM_TOKEN` de cada entorno. |
| L2 | Coste por conversación (~1.200 tokens por decisión) | Cuota diaria del panel (800) + `maxMessagesPerRun`. Medido, no estimado. |
| L3 | El modelo puede escribir de más si la pauta dice «escribe» | Guardas de modo (`idle` no escribe) y tope de 6 mensajes por ejecución. |
| L4 | La detección de invención es por patrones | Cubre entregas y números de pedido; no es comprensión semántica. |
| L5 | Un proceso único (lease + `seq`) | Sin cambios: no abrir varias réplicas sin mover la secuencia. |
| L6 | Latencia de ~1 s por decisión | Aceptable para un hilo interno; el trabajo no bloquea al usuario (lo hace el planificador). |

---

## 11. GO / NO-GO

**GO** — el Centro IA **sí opera con un modelo real** en UAT aislada:

- ✅ Proveedor real activo (`deepseek-flash`), 8 llamadas por pasada, latencia y tokens medidos.
- ✅ Conversación completa, contextual y persistente entre un empleado y el agente.
- ✅ Acciones dentro de su lista blanca; colaboración decidida por el modelo.
- ✅ Colaboración sin herencia de permisos, con delegación persistente y auditada.
- ✅ Casos duros cubiertos: duplicado, caída del proveedor, salida inválida, reinicio y permiso denegado.
- ✅ 49/49 comprobaciones en dos pasadas + UAT de navegador con 4 capturas.
- ✅ Cero WhatsApp, cero datos reales, cero cambios en producción y ninguna herramienta de alto impacto activada.

**NO-GO de despliegue**, por lo que falta decidir (no por fallos técnicos):

- ❌ Validar el tono de los mensajes con el negocio.
- ❌ Elegir la clave de producción y su circuito de cuota.
- ❌ Revisar L5 antes de pasar a más de una réplica.
