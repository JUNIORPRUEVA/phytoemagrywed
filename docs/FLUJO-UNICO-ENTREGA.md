# Flujo único de entrega y un solo Supervisor IA

Fecha: 2026-10-22 · Alcance: CRM (UAT aislada). **No se ha desplegado nada.**

## Problema que corrige

La auditoría forense del módulo «Mis entregas» encontró cuatro fallos de fondo:

1. **Dos motores de aviso** sobre el mismo pedido: `deliveryControlTick` (5 min / 30 min, con
   teléfonos de administración fijos en el código) y `deliverySupervisorTick`.
2. **Dos acciones primarias contradictorias** en la pantalla: «Iniciar entrega» arriba y un texto
   que decía «Primero contacta al cliente» — regla que el backend **nunca** aplicó.
3. **El repartidor no podía anotar el cobro** desde su pantalla (le falta
   `orders.update_operational`), aunque el servidor ya lo autorizaba para su propio pedido.
4. **Offline mentía**: finalizar sin red marcaba el pedido «entregado» en el teléfono antes de la
   transición real (inventario, postventa, Meta).

## Arquitectura final

### Un solo supervisor

- El motor que queda es `server/delivery-supervisor.mjs`. `crm-server.mjs` **ya no conecta** el
  motor heredado al scheduler.
- `DELIVERY_SUPERVISION_POLICY` documenta la política vigente; los valores viven en **un** documento
  de ajustes (`delivery_supervisor`) y se editan en «Supervisor IA → Reglas del supervisor».
- **Migración de la política antigua**: si existe el documento `delivery_control`, sus minutos
  (recordatorio y escalado) se importan **una sola vez** (`importLegacyControlPolicy`, marca en
  `delivery_supervisor_legacy_import`). Solo se aceptan valores operativos (recordatorio ≤ 60 min,
  escalado 15-240): un 100000 era la forma de *apagar* el motor viejo, no una política.
- El documento antiguo **no se borra** (es historia) y la bitácora `delivery_supervision_events`
  tampoco. Una pasada del scheduler devuelve `delivery: null` (motor retirado) y `supervisor: {...}`.

### Un solo flujo del repartidor

`accepted → contacted → on_the_way → delivered`

`publicDeliveryOrder()` publica `next_step`, calculado en el servidor (`deliveryNextStepOf`). La app
solo lo representa: **una acción primaria por paso**.

| Paso | Acción primaria | Qué hace |
| --- | --- | --- |
| `accepted` | **Aceptar entrega** | `POST /orders/:id/delivery/accept` — hecho propio, idempotente, **no envía nada** al cliente |
| `contacted` | **Contactar cliente** | hoja con Llamar / WhatsApp / Mensaje del CRM / «No pude contactar» |
| `on_the_way` | **Iniciar entrega** | `POST /orders/:id/delivery/start` (exige destino y asignación; pide GPS antes de crear la sesión) |
| `delivered` | **Finalizar entrega** | hoja compacta de confirmación + cobro |

Hechos separados y auditables: `delivery_accepted_at`, `delivery_contact_attempts[]`,
`delivery_contacted_at`, sesión de tracking, `delivered_at`.

**Política de contacto**: ajuste `requireContactBeforeStart` (por defecto **apagado**). Encendido,
`/delivery/start` exige al repartidor un intento registrado (llamada, WhatsApp o mensaje). Se acepta
el teléfono como contacto válido: exigir un WhatsApp entregado bloquearía entregas legítimas.

### Cobro al finalizar (integridad financiera)

`POST /api/admin/delivery-tracking/:id/complete` acepta `payment: { outcome: 'cash'|'transfer'|'none',
amount, note, expectedDue }`.

- **Ya pagado** (saldo 0): no se pide nada; no se duplica el recibo.
- **Efectivo**: `registerCustomerPayment` con el repartidor como actor. Queda como **efectivo en su
  poder** (`payment.courier.pending`) hasta la rendición, que sigue siendo de administración.
- **Transferencia**: se registra `verification: 'pending'`. **No reduce el saldo** hasta que
  administración la verifica (`POST /orders/:id/payments/:paymentId/verify`, solo ADMIN). Verificar
  dos veces no duplica nada; rechazar no borra el registro.
- **Sin pago**: no se inventa nada; el saldo sigue y se audita `delivery.payment_not_received`.
- El cobro va **antes** de cerrar y con clave de idempotencia estable
  (`delivery-complete:<sesión>:<medio>`): si la finalización falla y se reintenta, el cobro se
  reutiliza. Si el cobro falla, **la entrega no se cierra**.

### Incidencias

- Una incidencia abierta a la vez (`409 issue_pending`); cada una tiene `id`, motivo, nota, actor y hora.
- `POST /orders/:id/delivery/issue/resolve` (ADMIN) exige nota y acción (`resume`/`cancel`), deja
  `issue_resolution`, `issue_resolved_at` y auditoría `delivery.issue_resolved`.
- Si administración **reinicia** una entrega con incidencia abierta, la incidencia se cierra con
  `resolution: 'restarted_by_admin'`: ya no desaparece en silencio.

### Offline

`public/admin/offline.js`:

- **Finalizar** sin red deja la sesión en `pending_status: 'completed'` y el pedido **no** cambia de
  estado. La app enseña «Pendiente de sincronización» y deshabilita la acción primaria.
- **Cobrar** sin red se rechaza (`503`): el dinero no se anota sin conexión.
- **Detener el GPS** sí se aplica en local (no hay dinero ni venta de por medio).

### Privacidad

`GET /api/admin/orders/:id` para el rol `DELIVERY` devuelve una proyección (`delivery_view: true`)
con lo operativo y el saldo: **sin** `timeline`, `followups`, `scheduled` ni `payment.entries`.
La oficina sigue viendo la ficha completa.

### ETA

Una sola velocidad media (25 km/h) en cliente (`fmtEta`) y servidor (`routeSummary`). Se sigue
diciendo que es una estimación **en línea recta**. Si el teléfono niega la ubicación, la cabecera
muestra «Ubicación no disponible» con botón **Reintentar** (nunca «Calculando» para siempre).

## Endpoints nuevos

| Ruta | Permiso |
| --- | --- |
| `POST /api/admin/orders/:id/delivery/accept` | repartidor asignado o `delivery.tracking.manage_all` |
| `POST /api/admin/orders/:id/delivery/contact-attempt` | ídem |
| `POST /api/admin/orders/:id/delivery/issue/resolve` | `delivery.tracking.manage_all` |
| `POST /api/admin/orders/:id/payments/:paymentId/verify` | ADMIN |

Ninguno concede permisos financieros amplios al rol `DELIVERY`: el cobro del repartidor entra por
`paymentAuthorization` (ya existente), que solo le deja cobrar **su** pedido.

## Pruebas

- `tests/delivery-unified-flow-uat.test.js` (15): aceptar, contacto, política de contacto, efectivo,
  transferencia reportada/verificada, sin pago, sobrepago, privacidad, incidencias (duplicado,
  resolución, reinicio) y «un solo supervisor».
- `tests/delivery-assignment-notifications.test.js` (15): los dos casos del motor heredado se
  reescribieron para afirmar que **el motor antiguo ya no corre** y que el supervisor avisa una vez.
- `tests/delivery-frontend-uat.test.js` (24): aserciones estructurales actualizadas al flujo único.
- Sin regresiones en: `delivery-tracking`, `order-payments`, `delivery-courier`,
  `delivery-supervisor*`, `supervisor-autonomia`, `supervisor-reparto-integral-uat`.

## Riesgo conocido

`tests/offline-24h.test.js` y `tests/panel-offline-uat.test.js` presentan fallos **ajenos a este
cambio** (contadores de HOY y sincronización POS offline), presentes ya en el árbol de trabajo.
