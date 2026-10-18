# Supervisor Inteligente de Delivery

Motor que vigila cada pedido con responsable asignado —**interno** (usuario
AGENT/DELIVERY) o **externo** (contacto de reparto guardado)— y hace que ninguno
se quede olvidado: recuerda, interpreta la respuesta, pospone con fecha, escala a
administración y deja todo registrado. **No crea un sistema de pedidos aparte** y
**no usa QR ni PIN**: trabaja sobre los pedidos y los repartidores que ya existen.

## 1. Dónde vive cada cosa

| Pieza | Archivo |
| --- | --- |
| Motor (estado, recordatorios, posposición, interpretación) | `server/delivery-supervisor.mjs` |
| Agentes internos + máquina histórica del repartidor externo | `server/delivery-courier.mjs` |
| Bitácora persistente | colección `delivery_supervision_events` (`server/collections.mjs`) |
| Ruta del panel + ajustes | `server/crm-server.mjs` |
| Pantalla «Supervisor IA» | `public/admin/supervisor.js` + `supervisor.css` |
| Pruebas | `tests/delivery-supervisor.test.js` (unidad) y `tests/delivery-supervisor-routes.test.js` (integración) |

El estado de supervisión de un pedido vive **dentro del pedido**, en
`order.delivery.supervisor`:

```json
{
  "assigned_at": "…",
  "last_reply_at": "…",
  "started_at": "…",
  "delivered_reported_at": "…",
  "pending_action": { "type": "postpone", "until": "2026-10-22", "asked_at": "…" },
  "postponed_until": "2026-10-22T12:00:00.000Z",
  "postpone_reason": "El cliente pidió otro día",
  "postpone_count": 1,
  "postpone_due_notified_at": null,
  "issue_at": null,
  "confirmed_at": null
}
```

## 2. Etapas que reconoce

| Etapa | Cuándo | Siguiente acción |
| --- | --- | --- |
| `no_responsible` | Pedido abierto sin repartidor | Asignar un responsable |
| `not_confirmed` | Externo asignado, aún sin enviar el pedido | Enviar el pedido |
| `send_failed` | El envío por WhatsApp falló | Reenviar |
| `pending_start` | Enviado / asignado, sin iniciar | Iniciar la entrega |
| `pickup_pending` | Hay recogida en tienda pendiente | Recoger los productos |
| `in_transit` | Iniciada | Entregar y confirmar |
| `awaiting_confirmation` | Reportó entregado | Confirmar la entrega |
| `issue` | Incidencia | Resolver la incidencia |
| `postponed` | Pospuesto con fecha futura | Retomar en la fecha |
| `closed` | Entregado / cancelado / perdido | — |

## 3. Recordatorios (deterministas)

Una pasada del scheduler (o «Ejecutar ahora» en el panel):

1. Primer aviso a los `firstReminderMinutes` de la asignación.
2. Repeticiones cada `followUpMinutes`.
3. **Máximo `maxAttempts`**. Al llegar al límite deja de escribir al repartidor y
   la incidencia sigue abierta en el panel.
4. **Horario de contacto** (`contactFromHour`–`contactToHour`, zona del negocio).
   Fuera de horario no se envía: se cuenta como aplazado.
5. **Pausa** si el repartidor respondió en los últimos `followUpMinutes`.
6. **Idempotencia**: cada aviso lleva clave única (`pedido:etapa:intento`), así un
   reintento del webhook o dos pasadas seguidas no duplican mensajes.
7. **Nunca se finge un envío**: si WhatsApp no está configurado o la plantilla no
   está aprobada, el evento queda `pending`/`failed` con el motivo real y se
   escala a administración.

Canal:

- **Externo**: plantilla aprobada por WhatsApp (`SUPERVISOR_REMINDER_TEMPLATE`).
- **Interno**: notificación de la aplicación + push (y la plantilla histórica de
  reparto sigue funcionando como hasta ahora).

## 4. Respuestas del repartidor (WhatsApp)

Se aceptan **solo** de un número que sea contacto de reparto guardado o de un
usuario AGENT/DELIVERY con ese teléfono personal o de flota.

| Frase (ejemplos) | Intención |
| --- | --- |
| «Ya lo recibí», «Enterado» | `ack` |
| «Voy para allá», «Estoy saliendo» | `start` |
| «Estoy recogiendo», «Ya compré los productos» | `pickup` |
| «Estoy llegando» | `arriving` |
| «Ya lo entregué» | `delivered` (pide confirmación) |
| «Sí, confirmar» / «CONFIRMAR» | `confirm` |
| «El cliente no está», «No pude conseguir el producto» | `issue` |
| «Mañana lo entrego», «No puedo hoy» | `postpone` |
| «Necesito hablar con administración» | `help_admin` |

Reglas:

- Las **negaciones** se comprueban primero («no lo entregué» no es entregado).
- Con **varios pedidos abiertos no se adivina**: se pide el número de pedido.
- Un mensaje ambiguo **pregunta** antes de actuar.
- «Entregado» **no cierra** nada: se pide una confirmación explícita y solo
  entonces se ejecuta la transición oficial (inventario, venta, avisos).

### DeepSeek

Si las reglas no reconocen la frase y el uso de IA está activo, se pide una
**intención estructurada** (`intent`, `order_number`, `date`, `confidence`) al
servicio de DeepSeek que ya existe (misma clave cifrada, mismo límite diario,
mismo registro de consumo). Se descarta si:

- la intención no está en la lista blanca,
- la confianza es menor que 0,6,
- el proveedor falla o no hay saldo.

El modelo **nunca** toca la base: solo propone. El backend valida teléfono,
asignación, estado y transición. El texto del repartidor se trata como **dato**,
no como instrucciones (protección ante mensajes maliciosos).

## 5. Posponer

Desde el panel (`POST /api/admin/orders/:id/delivery/postpone`) o por WhatsApp
(pide fecha y confirmación). Requiere **motivo**, **fecha futura**, respeta
`postponeMaxDays` y `postponeMaxCount`. Conserva el estado comercial y el pago,
suspende recordatorios hasta la fecha, avisa a administración si lo pidió el
repartidor y, al vencer, reanuda el seguimiento **una sola vez**.

## 6. Escalamiento y conciliación diaria

- Se escala a administración (avisos internos + auditoría) cuando: no hay
  responsable, hay incidencia, se agotaron los intentos o el aviso no se pudo
  enviar. Una vez por pedido, etapa y motivo.
- `POST /api/admin/delivery-supervisor/daily` genera el resumen del día
  (sin iniciar, en camino, atrasados, sin respuesta, pospuestos, incidencias) y
  deja constancia. **No cierra nada por antigüedad.**

## 7. API

| Ruta | Permiso |
| --- | --- |
| `GET /api/admin/delivery-supervisor` | `delivery.tracking.manage_all` |
| `POST /api/admin/delivery-supervisor/settings` | `delivery.tracking.manage_all` |
| `POST /api/admin/delivery-supervisor/run` | `delivery.tracking.manage_all` |
| `POST /api/admin/delivery-supervisor/daily` | `delivery.tracking.manage_all` |
| `POST /api/admin/orders/:id/delivery/postpone` | administración o repartidor asignado |

## 8. Ajustes (por defecto)

```json
{
  "enabled": true,
  "firstReminderMinutes": 10,
  "followUpMinutes": 30,
  "maxAttempts": 3,
  "lateAfterMinutes": 90,
  "escalateAfterMinutes": 120,
  "contactFromHour": 8,
  "contactToHour": 20,
  "internalNotifications": true,
  "whatsAppReminders": true,
  "useDeepSeek": true,
  "postponeMaxDays": 7,
  "postponeMaxCount": 3,
  "dailySummaryHour": 18
}
```

Se guardan en `settings` con la clave `delivery_supervisor` y se editan en la
propia pantalla («Reglas del supervisor»).

### Activación controlada (importante)

Por defecto `activationMode: 'new'` y `activatedAt: null`: **el supervisor no
escribe a ningún pedido hasta activarse**. Al guardar las reglas por primera vez
se sella `activatedAt` y solo entran los pedidos **asignados a partir de ese
momento**; los antiguos no se tocan salvo autorización expresa
(`includeOldOrders: true` o el id en `includeOrderIds`).

Límites de volumen por pasada: `maxRemindersPerTick` (8) y
`maxEscalationsPerTick` (10). Lo que no entra queda para la siguiente pasada; el
pedido no pierde su sitio.

## 9. Plantilla que hay que crear en Meta

Nombre **`phyto_supervisor_recordatorio_v1`** · categoría **UTILITY** · idioma
**es**. Cuerpo exacto:

```
Hola {{1}}, seguimos pendientes del pedido {{2}}.

Siguiente paso: {{3}}

Responde a este mensaje cuando lo tengas listo.
```

Variables: `courier_name`, `order_number`, `next_action`. Ejemplos para Meta:
`Pedro`, `PE-100001`, `Iniciar la entrega`.

Mientras no esté aprobada, el CRM registra el recordatorio como **pendiente**
(nunca como enviado) y escala a administración. Tras aprobarla: **Ajustes →
Sincronizar con Meta**.

### Plantilla del escalado

El escalado usa **`phyto_delivery_sin_atender_admin_v1`** (UTILITY · `es`) con
tres variables: número de pedido, nombre del responsable y **enlace absoluto** al
panel (`https://phytoemagryrd.lat/admin/?v=delivery&order=…`). Se envía a los
contactos de *Ajustes → Delivery* (`deliveryAdminEscalationContacts`), como mucho
a cuatro por incidencia y **una sola vez** por pedido + etapa + motivo; la campana
interna se mantiene. Si la plantilla no está aprobada no se finge el envío: queda
`pending` con el motivo (`delivery.supervisor_escalation_unavailable`).

## 10. Qué NO hace (a propósito)

- No usa QR ni PIN.
- No crea pedidos ni estados paralelos.
- No cierra un pedido por una respuesta ambigua ni por antigüedad.
- No gestiona cobros contra entrega: el importe se verifica aparte antes de
  registrar cualquier cobro.
- No inventa datos de contacto ni lee la foto de perfil de WhatsApp (Meta no la
  expone).
