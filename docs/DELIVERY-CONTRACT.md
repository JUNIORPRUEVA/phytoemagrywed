# Contrato PHYTOEMAGRY ↔ Fulltech Delivery

> Estado: **borrador técnico verificado contra el código**, no implementado. Fecha 2026-10-23.
> Rama de trabajo: `feat/phase03-continuation` (worktree `C:\Users\pc\DEV\WORKTREES\PHYTOEMAGRY\phase03-continuation`).

El CRM es la **fuente de verdad**. La app de reparto no crea base financiera propia: consulta,
reporta estado y reporta cobros; todo lo que vale dinero lo confirma el CRM.

---

## 1. Lo que el CRM YA tiene (verificado en `server/`)

### 1.1 Asignación de reparto: dos caminos, una sola idea

| Camino | Endpoint | Quién | Qué hace |
| --- | --- | --- | --- |
| Interno | `POST /api/admin/orders/:id/delivery/assign` | `delivery.tracking.manage_all` | Asigna un **usuario del CRM** con capacidad de reparto (`canDeliver`). Avisa al cliente **solo si cambia de manos**. Rechaza pedidos cerrados y entregas activas. |
| Externo | `POST /api/admin/orders/:id/courier/assign` | `orders.update_operational` / `delivery.manage` | Asigna un **contacto de reparto guardado** (no acepta un número suelto). Con `autoSend:true` manda la plantilla oficial. |
| Envío | `POST /api/admin/orders/:id/courier/send` | ídem | Reenvío explícito e idempotente. |

Decisión ya vigente y documentada (§53): **asignar no es aceptar**. Asignar es un acto interno;
el cliente debe saber de su reparto cuando el repartidor **acepta**. Hoy el CRM avisa al asignar;
mover ese aviso a la aceptación exige el paso de aceptación del móvil (§4, G2).

### 1.2 Estados operativos de la entrega

`DELIVERY_OPERATIONAL_STATUSES` (en `order.delivery.delivery_status`):
`PENDING_CONTACT · CONTACTED · READY_FOR_DELIVERY · IN_TRANSIT · ISSUE_REPORTED · DELIVERED · CANCELLED`.

Estado del vínculo con el mensajero externo (`COURIER_STATUS`):
`assigned · sent · failed · in_progress · awaiting_confirmation · delivered · issue`.

Endpoints de avance: `/delivery/contact-attempt`, `/delivery/accept`, `/delivery/start`,
`/delivery/issue`, `/delivery/issue/resolve`, `/delivery/postpone`, `/delivery-tracking/*`.

### 1.3 Dinero y custodia (la pieza clave)

`order-payments.mjs` ya separa **lo declarado** de **lo verificado**:

- `payment.entries[]` con `verification`; `isVerifiedPayment(entry)` es `false` mientras esté `pending`.
- `paymentBlockOf(order)` → `{ status, total, received, pendingVerification, due, method }`.
- **Un cobro declarado por el repartidor NO cuenta como recibido** hasta que una persona autorizada lo
  verifica (`setPaymentVerification`). Eso es exactamente «la rendición requiere confirmación
  administrativa», ya implementado, sin una contabilidad paralela.

### 1.4 Solicitudes de la web

`POST /api/crm` con `order_intent` → colección `order_requests` (precio recalculado en servidor,
`client_claim` solo para auditar). `GET /api/admin/order-requests`,
`POST .../:id/convert` (id determinista `req_<solicitud>` → **convertir dos veces no duplica**),
`POST .../:id/dismiss`.

### 1.5 Candado de edición

`PATCH /api/admin/orders/:id` con `expectedVersion` → `409 stale_order` si cambió. Importes solo antes
de despachar, salvo rectificación de `admin.full`; **nunca** con `invoice_id` o reporte a Meta (§54).

---

## 2. Lo que la app `FULLTECH-DELIVERY` espera

`lib/data/models/delivery_order.dart` → `DeliveryStatus`:
`offered · accepted · pickupPending · enRoute · arrived · delivered · exception · cancelled`.
`lib/data/models/earnings.dart` → `CustodyState`, `ShiftClose` (`ShiftCloseStatus`), `PayoutRecord`.
Reglas ya implementadas en la app: enteros de céntimos, lecturas offline con caché de 24 h, y
**toda escritura exige confirmación del servidor** (`ServerAckRequiredException`).

---

## 3. Mapa de compatibilidad

| App (`DeliveryStatus`) | CRM hoy | Brecha |
| --- | --- | --- |
| `offered` | asignación existe; no hay estado «ofrecido» ni TTL | **G1** |
| `accepted` | `delivery/accept` (interno) marca avance operativo | **G2** (falta aceptación del repartidor externo) |
| `pickupPending` | `READY_FOR_DELIVERY` | se puede mapear |
| `enRoute` | `IN_TRANSIT` | se puede mapear |
| `arrived` | no existe | **G3** (llega con GPS, fase posterior) |
| `delivered` | `DELIVERED` + estado del pedido `entregado` | se puede mapear |
| `exception` | `ISSUE_REPORTED` | se puede mapear |
| `cancelled` | `CANCELLED` | se puede mapear |
| — | `REASSIGNED` / `EXPIRED` | no existen como estado; hoy son eventos del supervisor |

| Concepto app | CRM hoy | Brecha |
| --- | --- | --- |
| `CourierIdentity` (token propio) | usuarios del CRM o contactos externos | **G4** sin autenticación para el móvil |
| `CustodyState` | `payment.entries` + `verification` | **G5** falta el saldo por repartidor |
| `ShiftClose` | — | **G6** falta cierre de jornada |
| `PayoutRecord` (ganancias) | — | **G7** no existe pago por entrega |
| `cashToCollectCents` | `paymentBlockOf(order).due` (pesos) | convertir en el borde |
| Órdenes asignadas | solo panel admin | **G8** sin `GET` para el repartidor |

---

## 4. Contrato propuesto (`/api/courier/*`, versión 1)

Autenticación **propia del repartidor** (no reutiliza la cookie del panel; un repartidor externo no es
usuario del CRM):

```
POST /api/courier/login      {phone, code}            -> {token, expiresAt, courier:{id,name}}
GET  /api/courier/orders?since=<iso>                  -> {orders:[DeliveryOrder], serverTime}
GET  /api/courier/orders/:id                          -> {order}
POST /api/courier/orders/:id/accept                   -> {order}   (409 si ya no está ofrecido)
POST /api/courier/orders/:id/reject  {reason}         -> {order}   (vuelve a la cola del supervisor)
POST /api/courier/orders/:id/pickup                   -> {order}
POST /api/courier/orders/:id/en-route                 -> {order}
POST /api/courier/orders/:id/arrived                  -> {order}
POST /api/courier/orders/:id/deliver {payment:{method,amount}}

        -> {order, payment:{status:'pending_verification'|'verified', received, due}}
POST /api/courier/orders/:id/issue   {reason,note}    -> {order}
POST /api/courier/positions          {orderId,lat,lng,accuracy,at}  -> {ok}
GET  /api/courier/custody                             -> {balance, pendingOrders[], entries[]}
POST /api/courier/custody/handover   {amount,note}    -> {handover, balance}
GET  /api/courier/earnings                            -> {entries[], pendingPayouts[]}
```

Reglas duras del contrato:

1. **Toda transición exige `expectedVersion`** y devuelve `409 stale_order` con la versión actual.
2. `deliver` con `CASH` **nunca** deja el pedido como cobrado: crea una entrada `pending` que
   administración verifica. La respuesta lo dice con `payment.status`.
3. `GET /orders` devuelve el teléfono del cliente **enmascarado** hasta que la asignación esté
   `accepted` (hoy el panel muestra el teléfono; el móvil no debe recibirlo antes).
4. Offline: solo lecturas de lo ya sincronizado. Ninguna transición ni cobro se acepta sin respuesta
   del servidor — la app ya lo impone con `ServerAckRequiredException`.
5. Idempotencia: cada transición lleva `Idempotency-Key`; repetirla devuelve el mismo resultado.

---

## 5. Custodia y ganancias (modelo, sin duplicar la caja)

- **El efectivo cobrado es de la empresa.** No se crea una cartera en el móvil: se apoya en
  `payment.entries` (ya existe) con un campo `courier_id` y `verification:'pending'`.
- **Saldo en custodia** = suma de entradas `CASH` verificadas o pendientes del repartidor **menos**
  las entregas de efectivo registradas con `registerCourierHandover` (ya existe en el CRM).
- **La rendición la confirma administración.** El repartidor declara la entrega; el estado queda
  `pending` hasta que alguien la verifica. Nada se marca solo.
- **Ganancias**: tabla **nueva** y separada (`courier_earnings`), nunca derivada de la caja: importe
  fijo por entrega o porcentaje, congelado al entregar. Un pago (`PayoutRecord`) descuenta de
  ganancias, **no** de la custodia; son dos libros distintos y no se compensan.
- **Cierre de jornada** (`ShiftClose`) es un **reporte**, no un borrado: no elimina deudas, ni
  efectivo pendiente de rendir, ni ganancias sin pagar. Si queda diferencia, se dice con el número.
- Queda **fuera** de esta fase: pago automático, facturación de la ganancia y cualquier asiento que
  toque la contabilidad sin autorización expresa.

---

## 6. Orden de implementación recomendado

1. **G4** identidad de repartidor + `login` (sin esto no hay nada).
2. **G8 + G1/G2** `GET /orders`, `accept`, `reject` → habilita la regla «el cliente sabe al aceptar».
3. **G3** `pickup`/`en-route`/`arrived`/`issue` sobre los estados operativos existentes.
4. **G5** custodia leyendo `payment.entries` (solo lectura al principio).
5. **G6/G7** cierre de jornada y ganancias, con tabla nueva y pruebas propias.
6. Push y GPS continuo: fase posterior, ya declarada así por el proyecto.

---

## 7. Estado IMPLEMENTADO en la Fase 04 (2026-10-23)

Las secciones 4 y 5 de arriba son la **propuesta**. Lo que existe de verdad hoy es esto, y solo esto:

### 7.1 Endpoints reales

| Método | Ruta | Auth | Devuelve |
| --- | --- | --- | --- |
| POST | `/api/courier/login` | `{phone, pin}` | `{token, token_type:'Bearer', expires_at, courier}` |
| POST | `/api/courier/logout` | Bearer | `{ok}` y **sube `token_epoch`** (revoca los tokens emitidos) |
| GET | `/api/courier/me` | Bearer | `{courier, company_id, session_expires_at, capabilities:{read_only:true,…}}` |
| GET | `/api/courier/orders` | Bearer | `{orders[], count, server_time, read_only:true}` |
| GET | `/api/courier/orders/:id` | Bearer | `{order, read_only:true}` |
| * | cualquier otra ruta `/api/courier/*` | — | `405 {error:'read_only'}` |

Administración de cuentas (cookie del panel, `admin.full` o `delivery.manage`):
`GET /api/admin/couriers`, `POST /api/admin/couriers` (alta con PIN),
`PATCH /api/admin/couriers/:id` (`active`, `appAccess`, `displayName`, `pin`).

### 7.2 Identidad (`courier_accounts`)

`kind` es `INTERNAL` (ligada a `user_id` del CRM) o `EXTERNAL` (ligada a `contact_id` de
`delivery_contacts`). Tener el teléfono guardado como contacto **no** crea acceso: hace falta el alta
explícita con `app_access: true` y PIN. No se puede duplicar el mismo usuario, contacto ni teléfono.

### 7.3 Sesión

Token firmado con la misma HMAC del panel: `cv1.<cuenta>.<epoch>.<caduca>.<firma>`, 8 h. Se envía como
`Authorization: Bearer` (app) o cookie `pe_courier` (navegador del panel). Se rechaza si la cuenta está
inactiva, sin autorización, de otra empresa (`PHYTO_CRM_COMPANY_ID`) o si el `token_epoch` cambió.
El PIN se guarda con pbkdf2-sha256 (210 000 iteraciones), con bloqueo tras 5 fallos y respuesta
idéntica para teléfono inexistente, sin acceso o PIN incorrecto.

### 7.4 Vista del pedido

Solo lo necesario para entregar: número, estados, cliente (nombre + teléfono), dirección/referencia/
nota, líneas (nombre, cantidad, precio de cliente), total, **importe a cobrar** y estado del cobro.
Nunca costos, márgenes, ids de cliente, conversaciones ni notas internas.
`courier_compensation` se devuelve `null` con `courier_compensation_unavailable: true`: el CRM aún no
tiene remuneración por entrega y no se inventa.

### 7.5 Lo que sigue pendiente (no implementado)

`accept` / `reject` / `pickup` / `en-route` / `arrived` / `deliver`, `positions`, `custody`,
`earnings`, `handover`, `shift-close`, push y GPS. La app los rechaza con `405 read_only` o
`UnsupportedError`, y las pantallas de dinero muestran «no disponible», nunca RD$0.00.

---

## 8. Auditoría de avisos al cliente (Fase 04B — solo lectura, sin activar nada)

Regla acordada: asignar, aceptar y recoger **no** avisan; el primer mensaje rutinario sale al
**inicio confirmado de la entrega** y el segundo al **confirmar la llegada**; entregar no manda un
tercer aviso.

Lo que hace hoy el código (`server/crm-server.mjs`):

| Momento | Qué pasa | Línea |
| --- | --- | --- |
| Asignación a repartidor **interno** que cambia de manos | **Envía** `phyto_delivery_asignado_v1` al cliente (`notifyDeliveryCustomer(..., kind:'assignment')`) | `crm-server.mjs:9426` |
| Asignación a mensajero **externo** con `autoSend:true` | **Envía** `sendOrderToCourier` → misma plantilla de asignado | `crm-server.mjs` ruta `/courier/assign` |
| **Inicio confirmado de la entrega** (`/delivery/start`) | **No envía nada** | `crm-server.mjs` ruta `/delivery/start` |
| **Llegada** | No existe el estado ni el aviso | — |
| Entrega completada | **Envía** `phyto_pedido_entregado_v1` | `crm-server.mjs:9365` |

Conclusión: hay **una violación por exceso** (se avisa al asignar) y **dos por defecto** (no se avisa
al iniciar ni al llegar), más un tercer mensaje al completar. Corrección requerida, en este orden:

1. Quitar el envío de `kind:'assignment'` de `/delivery/assign` y el `autoSend` automático de
   `/courier/assign`; la asignación deja solo la notificación **interna** al repartidor.
2. Al confirmar el inicio (`IN_TRANSIT`) enviar el primer mensaje normal al cliente.
3. Al confirmar la llegada enviar el segundo.
4. Al completar, no enviar un aviso rutinario adicional (solo el interno de administración).

**No se ha activado ni modificado ningún aviso en esta fase** y no se ha enviado ningún WhatsApp real.

---

## 9. Regla de avisos APLICADA (Fase 06) y cola de mensajes

Implementado en `server/crm-server.mjs`:

| Momento | Antes | Ahora |
| --- | --- | --- |
| Asignación (interna) | texto/plantilla al cliente | **nada** (`customerNotification.status = 'not_applicable'`) |
| Aceptación / recogida | — | nada (no aplica el aviso rutinario) |
| Inicio de entrega | solo estado del panel | **evento `delivery_started`** en la cola |
| Llegada | — | **evento `delivery_arrived`** en la cola |
| Entrega completada | texto + PDF del recibo | **se conserva el recibo** (documento, no aviso de reparto) |

La coordinación con el repartidor (interna o externa, `sendOrderToCourier`) **no se toca**.

Cola persistente (`delivery_message_outbox`): `status` ∈ `pending | pending_template | sending | sent | failed`,
`attempts` (máximo 3), `last_attempt_at`, `blocked_reason`, `idempotency_key` única
(`delivery_started:<pedido>` / `delivery_arrived:<pedido>`). Endpoints de administración:
`GET /api/admin/delivery-messages` (contadores + últimas 100) y
`POST /api/admin/delivery-messages/dispatch` (procesa; sin proveedor no marca `sent`).

**Falta para enviar de verdad**: plantillas aprobadas en Meta `phyto_pedido_en_camino_v1` y
`phyto_pedido_llegada_v1`, y el proveedor habilitado (`WHATSAPP_ACCESS_TOKEN` / `PHONE_NUMBER_ID`).
Mientras no existan, los eventos quedan `pending_template`: no se declara ningún envío.
