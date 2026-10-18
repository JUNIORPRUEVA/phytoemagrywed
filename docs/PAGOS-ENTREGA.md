# Pagos, entrega y rendición — regla financiera

Fecha: 2026-10-20 · Alcance: CRM (UAT). **No se ha desplegado nada.**

## La regla

Entregar **no** es cobrar. Son tres hechos distintos y ahora se guardan por separado:

| Hecho | Dónde vive | Quién lo escribe |
| --- | --- | --- |
| La entrega física | `order.status`, `order.delivered_at`, `delivery.delivery_status` | panel, repartidor, supervisor |
| El cobro al cliente | `order.payment.entries[]` + `payment_status` | una persona autorizada (panel/app) |
| La rendición del repartidor | `order.payment.courier.handovers[]` | solo administración |

`payment_status` conserva sus valores de siempre (`pending` | `paid` | `void`) y **solo pasa a
`paid`** cuando los cobros registrados cubren el total. Un pedido ya pagado nunca se revierte.

## Causa raíz del fallo

1. `server/crm-server.mjs` → `updateOrderStatus()` marcaba `payment_status: 'paid'` al pasar el
   pedido a un estado final. **Era el único punto que convertía una entrega en un cobro** y lo
   ejecutaban todos los caminos de cierre (panel, `/finish`, `/delivery-tracking/:id/complete`,
   supervisor). Eliminado.
2. `server/orders.mjs` → `buildOrder()` dejaba `payment_status: 'paid'` cuando nadie decía lo
   contrario, así que **todo pedido creado desde el panel nacía cobrado**. Ahora nace `pending`
   salvo que quien crea el pedido afirme `paymentStatus: 'paid'` (venta facturada en caja/POS).

Ni el supervisor de delivery, ni la lectura de WhatsApp, ni la IA de DeepSeek escriben pagos: el
motor sólo propone y la confirmación ejecuta la transición de entrega.

## Datos guardados (dentro de `order_json.payment`, sin migración)

```json
{
  "version": 1,
  "entries": [{ "id", "amount", "method": "CASH|TRANSFER", "at", "by_user_id", "by_display_name",
                "note", "evidence_url", "idempotency_key" }],
  "received_total": 0,
  "due": 0,
  "status": "pending|partial|paid|void",
  "last_payment_at": null,
  "courier": { "user_id", "name", "handovers": [{ "id", "amount", "at", "by_user_id", "note" }],
               "handed_over_total": 0, "pending": 0 }
}
```

- No se toca ningún pedido histórico: si un pedido antiguo ya dice `paid` y no tiene cobros
  registrados, se respeta como «pagado heredado» (no se degrada ni se le añaden importes).
- Pago parcial: `payment_status` sigue `pending` (compatibilidad con cierre, POS y pruebas) y el
  saldo real vive en `payment.due`.

## Endpoints

| Ruta | Permiso | Notas |
| --- | --- | --- |
| `POST /api/admin/orders/:id/payments` | `orders.update_operational` + (ADMIN, repartidor asignado o ventas) | importe > 0, método `CASH`/`TRANSFER`, no puede superar el saldo; `idempotencyKey` evita cobros dobles |
| `POST /api/admin/orders/:id/payments/handover` | ADMIN | efectivo del repartidor que llega a la empresa; nunca supera lo cobrado en efectivo |
| `GET /api/admin/orders/:id` | `orders.read` | ahora devuelve `payment` (cobros, saldo, rendición) |
| `GET` de delivery | — | `publicDeliveryOrder()` expone `payment.{status,due,received,total,method}` |

Auditoría: `order.payment_registered`, `order.courier_handover_registered` (con importe, medio y
saldo resultante; nunca datos del cliente).

## Panel

- Menú del pedido → **Registrar cobro** (solo si falta dinero). Pide importe, medio, nota y enlace
  de evidencia; manda una clave de idempotencia por hoja abierta.
- Si el pedido tiene efectivo sin rendir y el usuario es administrador, la misma hoja ofrece
  **Registrar rendición**.
- La ficha de entrega muestra el saldo real («Faltan RD$ X») y el aviso al finalizar dice que
  finalizar no registra el cobro.

## Pruebas

`tests/order-payments.test.js` (14 casos, servidor real): pedido nace por cobrar, finalizar deja
saldo, pedido pagado no se revierte, dos finalizaciones no duplican, cobro en efectivo con
constancia y auditoría, pago parcial conserva saldo, no se cobra de más ni sobre cancelado,
idempotencia, confirmación por WhatsApp externo no cobra, agente interno no cobra, repartidor no
cobra pedidos ajenos, rendición con tope y solo administración.

Regresión ejecutada: supervisor (unidad, rutas, validación, DeepSeek), POS y usuarios/asignaciones.
**125 pruebas en 7 archivos, todas en verde.**

## Riesgos de compatibilidad

- Pedidos nuevos del panel ya no aparecen «pagados»: es el cambio buscado, pero quien mirara el
  listado para saber si cobró verá «pendiente» hasta registrar el cobro.
- El POS no cambia: una factura sigue naciendo `paid` (se cobra en mostrador) y la venta directa
  desde el POS entregada sigue saliendo pagada.
- El cierre diario no depende de `payment_status` (usa `payment_method` + entregado): no cambia.
- Pedidos históricos intactos: sin reescritura, sin recálculo, sin migración.

## Plan de integración para la rendición completa (requiere aprobación)

Lo anterior es el mínimo correcto; **no** se ha construido un módulo contable nuevo. Para cerrar
el ciclo del dinero haría falta, en este orden:

1. **Arqueo por repartidor y día**: consolidar `courier.pending` de todos sus pedidos y una
   pantalla de «efectivo en la calle» (solo lectura al principio).
2. **Cierre de caja con métodos**: sumar cobros registrados por medio y día y compararlo con el
   cierre actual (que hoy usa el método del pedido, no los cobros).
3. **Rendiciones parciales con comprobante**: ya se guardan; faltaría exigir referencia y permitir
   adjuntar imagen (hoy el enlace es opcional).
4. **Reversión autorizada**: anular un cobro mal registrado con nota y auditoría (hoy se bloquea en
   lugar de inventar una corrección).
5. **Notas de crédito / devoluciones** enlazadas al cobro, no al pedido suelto.

Cada paso implica decidir contabilidad (qué es ingreso del día, cómo se trata un cobro anulado,
qué pasa con un pedido entregado y devuelto), por eso se deja para aprobación expresa en lugar de
improvisarlo.
