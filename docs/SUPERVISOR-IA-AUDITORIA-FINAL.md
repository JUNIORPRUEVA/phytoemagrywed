# Auditoría FINAL de preproducción — Supervisor IA Delivery

Fecha: 2026-10-18 · Alcance: Supervisor IA de delivery y módulos acumulados (catálogo, proveedores,
recogidas, facturas de proveedor, «Mis entregas», conversaciones, permisos).

**Método:** auditoría de solo lectura sobre el código y las suites; WhatsApp simulado; sin escrituras en
producción; sin commit, push, merge ni deploy. La única consulta externa fue un `GET` a Meta Graph
(`/{WABA}/message_templates`), que no envía ni modifica nada.

---

## 1. Resumen ejecutivo

| Dimensión | Estado |
| --- | --- |
| Técnica (código, pruebas, idempotencia, permisos) | **APTO** |
| Meta / plantillas de WhatsApp | **NO-GO** (las 3 plantillas del supervisor no existen en la cuenta) |
| Seguridad de datos (histórico, aislamiento, respaldo) | **APTO con condiciones** (falta el respaldo antes de desplegar) |
| Listo para producción | **NO-GO hoy**: falta crear/aprobar plantillas y ejecutar el arranque gradual |

El supervisor **no escribe nada por sí solo hasta que administración lo activa** y, si la plantilla no está
aprobada, **no finge el envío**: deja el intento registrado como `pending` con el motivo real y escala por
la campana/push interna. Es decir: se puede activar en producción sin riesgo de mensajes masivos ni de
mensajes falsos, pero los recordatorios por WhatsApp a repartidores externos **no saldrán** hasta aprobar
`phyto_supervisor_recordatorio_v1`.

---

## 2. Verificación por prioridad

### P1 · Nunca arranca solo sobre pedidos históricos, cerrados, cancelados, de prueba o sin asignar — CUMPLE

`supervisionEligibility()` en `server/delivery-supervisor.mjs` es la única puerta de entrada del tick y del
panel. Devuelve motivo explícito y el tick cuenta los excluidos en lugar de actuar:

| Motivo | Significado |
| --- | --- |
| `closed` | estado final (entregado/cancelado): se ignora |
| `unassigned` | sin repartidor interno ni externo vigente |
| `delivery_cancelled` | entrega cancelada |
| `not_activated` | supervisor sin fecha de activación (estado de fábrica) |
| `before_activation` | asignado antes de la fecha de activación |
| `no_assignment_date` | no hay fecha de asignación para decidir |
| `authorized_old` / `all` | únicos caminos por los que entra un pedido antiguo (autorización) |

*Evidencia:* pruebas unitarias `tests/delivery-supervisor.test.js` (cerrado, sin asignar, anterior a la
activación, sin activar, sin escrituras al activar) + snapshot con bloque `activation` y `excluded`.

### P2 · Elegibilidad definida: inicio controlado y autorización para antiguos — CUMPLE

- Por defecto `activationMode: 'new'` y `activatedAt: null`: **no se supervisa nada** hasta que el
  administrador guarda/activa. Al activarse se **sella la fecha**.
- Un pedido anterior solo entra con `includeOldOrders: true` o con su id en `includeOrderIds` (lista blanca).
- La activación **no se borra** al cambiar otros ajustes (minutos, intentos, IA): si el POST no trae
  `activatedAt`, se conserva el que había. *Esto era un fallo real detectado en esta auditoría y está
  corregido* (`saveSupervisorSettings`).
- `GET /api/admin/delivery-supervisor/preview` y `POST .../settings` exigen
  `delivery.tracking.manage_all`: un repartidor o agente no puede activar nada.

### P3 · Sin recordatorios masivos al activar — CUMPLE

1. Ventana de activación (P2): lo asignado antes no entra.
2. **Tope de volumen por pasada**: `maxRemindersPerTick: 8` y `maxEscalationsPerTick: 10`; lo que no entra
   se cuenta como `limited` y se envía en la pasada siguiente (el pedido no se mueve de estado).
3. **Vista previa con destinatarios** antes de arrancar: `GET .../preview` devuelve quién recibiría aviso,
   con teléfono enmascarado, etapa y minutos de espera, además de los excluidos por motivo.
4. Frecuencia y techo por pedido: `firstReminderMinutes`, `followUpMinutes`, `maxAttempts` (+ escalado).
5. Horario de contacto y pausa si el repartidor acaba de responder.

### P4 · Estado real de las plantillas en Meta — NO-GO (verificado, no asumido)

`GET /{WABA}/message_templates` → **HTTP 200, 13 plantillas**. De las tres que necesita el supervisor:
**0 encontradas**.

| Plantilla | Uso | Estado real en Meta |
| --- | --- | --- |
| `phyto_supervisor_recordatorio_v1` | recordatorio al repartidor externo | **NO EXISTE** |
| `phyto_pedido_repartidor_v1` | envío del pedido al repartidor externo | **NO EXISTE** |
| `phyto_delivery_sin_atender_admin_v1` | escalado por WhatsApp a administración | **NO EXISTE** |

Aprobadas hoy (las 13): `fulltech_contacto_personalizado_v1`, `fulltech_contacto_personalizado_v2`,
`phyto_permiso_llamada_v1`, `phyto_aviso_fulltech_v1`, `phyto_mensaje_personalizado_v1`,
`phyto_retomar_pedido_v1`, `phyto_recompra_cliente_v1`, `phyto_pedido_listo_v1`,
`phyto_ubicacion_entrega_v1`, `phyto_delivery_asignado_v1`, `phyto_confirmacion_pedido_v1`,
`phyto_seguimiento_cliente_v1`, `hello_world`.

Consecuencias reales (comprobadas en el código, ninguna inventada):

- **Repartidor INTERNO** (agente con cuenta): no usa WhatsApp. Recibe aviso interno en la campana/push
  (`DELIVERY_SUPERVISOR_REMINDER`). **Funciona hoy.**
- **Repartidor EXTERNO**: el intento queda `pending` con `template_not_approved` y se escala a
  administración por la campana. **No sale WhatsApp.**
- **Enviar pedido a repartidor externo** (`phyto_pedido_repartidor_v1`): responde **409
  `template_not_approved`** con mensaje claro. No hay envío simulado.
- Otras plantillas referenciadas por el código que tampoco están en Meta y afectan a módulos ya en uso:
  `phyto_delivery_pedido_pendiente_v1`, `phyto_pedido_entregado_v1`, `phyto_delivery_entregado_admin_v1`,
  `phyto_envio_factura_v1`, `phyto_compartir_ubicacion_v1`, `phyto_seguimiento_compra_v1`,
  `phyto_seguimiento_interes_v1`, `phyto_envio_cotizacion_v1`, `phyto_contacto_personalizado_v1`
  (la familia libre en Meta es `fulltech_contacto_personalizado_v1/v2`).

### P5 · E2E pedido ↔ repartidor ↔ número ↔ recordatorio ↔ confirmación ↔ posposición ↔ histórico ↔ pagos — CUMPLE (simulado)

Cubierto por `tests/delivery-supervisor-validation.test.js` (15 casos) con WhatsApp simulado:

- asignación → aviso interno → «voy para allá» → `IN_TRANSIT` → «ya lo entregué» →
  `awaiting_confirmation` (no cierra) → «CONFIRMAR» → `entregado/DELIVERED`;
- con dos pedidos abiertos **no adivina**: pide el número de pedido y el número elige el correcto;
- repartidor ≠ cliente, repartidor ≠ otro repartidor (no puede mover ni posponer pedido ajeno);
- webhook repetido (mismo `wamid`) **no duplica** la acción;
- posposición vencida reanuda **una sola vez**; conciliación diaria deja constancia y no cierra nada;
- **pago**: el reporte «entregado» no toca el pago; la confirmación es la que cierra.

### P6 · Módulos acumulados funcionando juntos — CUMPLE

Ejecución conjunta (16 archivos):

```
Test Files  16 passed (16)
Tests       264 passed | 1 skipped (265)
```

Incluye: `delivery-supervisor`, `delivery-supervisor-routes`, `delivery-supervisor-validation`,
`supervisor-deepseek`, `delivery-courier`, `delivery-assignment-notifications`, `delivery-tracking`,
`delivery-frontend-uat`, `order-pickups`, `supplier-invoices`, `suppliers`, `store-catalog`, `variants`,
`conversations`, `agent-privacy`, `followup-engine`.

### P7 · Permisos, idempotencia, histórico y scheduler tras reinicio — CUMPLE

- **Permisos**: rutas del supervisor con `delivery.tracking.manage_all`; `agent-privacy` y los casos de
  repartidor cruzado en verde.
- **Idempotencia**: recordatorios con clave `supervisor-reminder:{pedido}:{etapa}:{intento}`; escalados con
  `supervisor-escalation:{pedido}:{etapa}:{motivo}`; conciliación diaria con `supervisor-daily:{día}`.
- **Histórico**: el supervisor **no** cierra pedidos ni modifica pagos; solo escribe bitácora
  (`delivery_supervision_events`) y el bloque `delivery.supervisor` del pedido.
- **Scheduler tras reinicio**: `scheduler.mjs#tick()` llama a `deliverySupervisorTick` en cada pasada
  (`server/crm-server.mjs` lo inyecta) y los intentos se leen de la bitácora persistida, así que un
  reinicio **no reinicia los intentos**. Verificado apagando y volviendo a arrancar el servidor en la UAT:
  el mismo pedido no recibe un segundo aviso.

---

## 3. Lo que falta EXACTAMENTE para habilitar el Supervisor IA

**Bloqueante (sin esto no hay WhatsApp real):**

1. Crear y aprobar en Meta `phyto_supervisor_recordatorio_v1` (3 variables: nombre, número, siguiente paso).
2. Crear y aprobar `phyto_pedido_repartidor_v1` (8 variables) — sin ella no se puede enviar el pedido a un
   repartidor **externo** (responde 409).
3. Crear y aprobar `phyto_delivery_sin_atender_admin_v1` (escalado por WhatsApp a administración).
4. Tras aprobar: pulsar «Sincronizar con Meta» en el panel (o `syncWhatsAppTemplatesFromMeta`) para que el
   estado local deje de decir `pending_approval`.
5. Decidir si los repartidores externos de hoy deben recibir también las plantillas heredadas
   (`phyto_delivery_pedido_pendiente_v1`, `phyto_pedido_entregado_v1`, `phyto_delivery_entregado_admin_v1`).

**No bloqueante, pero necesario para operar con seguridad:**

6. Respaldo de la base antes de activar (`.sqlite` + WAL, o el volcado de Postgres del entorno real).
7. Activar el supervisor en el panel (sella `activatedAt`) y revisar la **vista previa de destinatarios**.
8. Primer día: dejar `maxRemindersPerTick` en 8 o menos y comprobar en la bitácora
   (`delivery.supervisor_reminder_sent` / `_failed`) que no hay `pending` inesperados.
9. Confirmar credenciales y webhook del entorno real (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
   `META_APP_SECRET`) antes de que el scheduler haga la primera pasada.

---

## 4. Plan de despliegue (documentado, NO ejecutado)

**Respaldo**
1. Copia del archivo SQLite (`data/*.sqlite` + `-wal` + `-shm`) o `pg_dump` del entorno.
2. Exportar la colección `settings` (ajustes del supervisor) y contar `orders` abiertos.
3. Verificar que el respaldo restaura en local antes de tocar producción.

**Despliegue gradual**
1. Desplegar el código con el supervisor **desactivado** (`activatedAt: null`, estado de fábrica): no
   supervisa nada, no escribe nada.
2. Comprobar panel, «Mis entregas» y una asignación interna (solo campana).
3. Activar el supervisor y ejecutar **una** pasada manual (`POST .../run`): revisar `reminders`,
   `escalations`, `limited` y `excluded`.
4. Dejar el scheduler con el tope por defecto (8/10) durante 24–48 h.
5. Subir el tope solo si la bitácora no muestra `limited` acumulado.

**Rollback**
1. `POST .../settings` con `enabled: false` (efecto inmediato, sin reiniciar).
2. Si hiciera falta revertir código: `docker service rollback <servicio>` (Swarm guarda la versión previa)
   o el tag anterior de la imagen.
3. Los datos son aditivos (bitácora nueva + bloque `delivery.supervisor`): revertir código **no** pierde
   pedidos ni pagos.

---

## 5. Matriz GO / NO-GO

| Criterio | Veredicto | Motivo |
| --- | --- | --- |
| Técnico (código y pruebas) | **GO** | 264 pruebas en verde, 1 omitida por diseño |
| Meta / plantillas | **NO-GO** | las 3 plantillas del supervisor no existen en la cuenta |
| Seguridad de datos | **GO con condición** | sin escrituras automáticas, histórico intacto; falta ejecutar el respaldo |
| Arranque controlado | **GO** | activación explícita + ventana + topes + vista previa |
| Listo para producción (envío real) | **NO-GO** | depende de Meta (puntos 1–3 del §3) |
| Producción con repartidores INTERNOS | **GO** | canal campana/push, no necesita plantilla |

---

## 6. Cambios realizados en esta auditoría

| Archivo | Cambio |
| --- | --- |
| `server/delivery-supervisor.mjs` | `saveSupervisorSettings` ya **no borra** `activatedAt` al guardar otros ajustes (conserva la ventana de activación). Retiradas las trazas temporales de depuración. |
| `tests/delivery-supervisor-validation.test.js` | La UAT activa el supervisor como lo hace el panel (verifica que `activatedAt` se sella) y el caso de reinicio comprueba que **ese pedido** no recibe un segundo aviso, sin confundir la cola por tope de volumen con un duplicado. |

---

## 7. Riesgos residuales

1. Sin plantillas aprobadas, un repartidor externo **no recibe nada** por WhatsApp; la incidencia se ve en la
   campana de administración (no se pierde, pero puede tardar en notarse).
2. El tope por pasada retrasa avisos cuando hay muchos pedidos vencidos a la vez (por diseño).
3. `phyto_contacto_personalizado_v1` sigue declarada en el catálogo local y **no existe en Meta**: los avisos
   de esa familia deben usar `fulltech_contacto_personalizado_v1/v2`.
