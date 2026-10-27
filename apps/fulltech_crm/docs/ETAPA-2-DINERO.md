# Etapa 2 — dinero, pedidos, custodia y cierre

Estado: implementado en la app nativa (`apps/fulltech_crm`) **reutilizando** los
endpoints y permisos del servidor. No se ha duplicado ninguna regla de negocio:
las validaciones de saldo, los topes, la idempotencia y los permisos siguen
viviendo en `server/` y son los mismos que usa la PWA.

## Matriz: acción → dónde vive → PWA → app nativa

| Acción | Endpoint real | PWA | App nativa | Nota |
| --- | --- | --- | --- | --- |
| Registrar cobro (efectivo/transferencia) | `POST /api/admin/orders/:id/payments` | Sí | **Sí** | Manda `expectedDue` (saldo que vio la persona) |
| Comprobante de la transferencia | `evidenceUrl` del mismo endpoint | Sí | **Sí** | Referencia o enlace; queda guardado con el cobro (verificado en UAT) |
| Cobro con la conexión caída | `ApiException.statusCode == 0` | Sí | **Sí** | Se avisa «no sabemos si entró» y **no** se reintenta a ciegas |
| Cobro parcial | mismo endpoint | Sí | **Sí** | El pedido sigue «por cobrar» hasta cubrir el total |
| Reintento / cobro duplicado | `idempotencyKey` + `x-fulltech-operation` | Sí | **Sí** | Repite la respuesta guardada, no anota otro cobro |
| Verificar un cobro declarado | `POST .../payments/:paymentId/verify` | Sí | **Sí** | Solo ADMIN |
| Rechazar un cobro | mismo endpoint (`decision: rejected`) | Sí | **Sí** | Solo cobros en estado `pending` (los declara el repartidor) |
| Rendición de efectivo de un pedido | `POST .../payments/handover` | Sí | **Sí** | Solo ADMIN, con `expectedPending` |
| Rendición por cuenta de repartidor | `POST /api/admin/delivery-cash/remittance` | Sí | **Sí** | Importes en **centavos** |
| Custodia: saldos por repartidor | `GET /api/admin/delivery-cash` | Sí | **Sí** | El efectivo del reparto no se suma a caja; cada fila muestra su estado de **liquidación** (`pendiente` / `liquidado`) |
| Custodia: libro de movimientos | `GET /api/admin/delivery-cash/movements` | Sí | **Sí** | Solo lectura |
| Conciliación e incidencias | `GET .../incidents`, `GET .../reconciliation` | Sí | **Sí** | Describe; no corrige dinero |
| Resolución administrativa | `POST .../resolutions` | Sí | **Sí** | No mueve dinero; queda «pendiente de autorización» |
| Confirmar pedido | `POST /api/admin/orders/:id/confirm` | Sí | **Sí** | — |
| Finalizar / entregar | `POST /api/admin/orders/:id/finish` | Sí | **Sí** | — |
| Cambiar estado | `PATCH /api/admin/orders/:id/status` | Sí | **Sí** | Con `expectedStatus` (evita pisar cambios ajenos) |
| Editar líneas, descuento, envío, notas | `PATCH /api/admin/orders/:id` | Sí | **Sí** | El total lo recalcula el servidor |
| Reparto interno | `POST .../delivery/assign` | Sí | **Sí** | — |
| Reparto externo (mensajería) | `POST .../courier/assign` (+`autoSend`) | Sí | **Sí** | El teléfono lo escribe una persona |
| Reenviar al externo | `POST .../courier/send` | Sí | **Sí** | Método disponible en el repositorio |
| Incidencia de entrega | `POST .../delivery/issue` | Sí | **Sí** | Motivos del catálogo del servidor |
| Resolver incidencia | `POST .../delivery/issue/resolve` | Sí | **Sí** | Solo ADMIN (`delivery.tracking.manage_all`) |
| Confirmar entrega a mano | `POST .../delivery/confirm` | Sí | **Sí** | Solo ADMIN y solo con la entrega **en camino** (las transiciones las decide el servidor) |
| Cancelar venta entregada | `POST /api/admin/orders/:id/cancel` | Sí | **Sí** | Restaura inventario y anula el pago |
| Borrar pedido sin historial | `DELETE /api/admin/orders/:id` | Sí | **Sí** | El servidor lo impide si hay historial |
| Factura en PDF | `GET .../factura` | Sí | **Sí** | Antes la app pedía el HTML del recibo |
| Enviar factura por WhatsApp | `GET/POST .../invoice-whatsapp` | Sí | **Sí** | Primero pregunta si se puede; luego envía con clave |
| Historial del pedido | `status_history`, `delivery.issues`, `payment.entries` | Sí | **Sí** | Auditoría completa sigue en la PWA |
| Cierre del día (cifras) | `/metrics`, `/reports/sales`, `/delivery-cash` | Sí | **Sí** | Mismas fuentes ⇒ mismos números |
| Cierre formal con bloqueo del día | — (no existe endpoint) | Solo PWA | **No** | Documentado abajo |
| Paginación de pedidos | `GET /api/admin/orders?limit=&cursor=` | N/A | **Sí** | Extensión **aditiva** del backend |
| Nota de voz grabada en la app | `POST .../conversations/:id/media?kind=audio` | Sí (web) | **Sí** | Micrófono + grabar/escuchar/cancelar/enviar |

## Diferencias aceptadas (y por qué)

1. **Cierre formal del día.** La PWA tiene una pantalla de cierre con arqueo,
   bloqueo e impresión, pero **no existe un endpoint** que lo respalde: se calcula
   en el navegador. La app muestra las mismas cifras (ventas, cobrado, por cobrar,
   efectivo en custodia y rendido) y lo dice explícitamente. Inventar un «cierre
   bloqueado» en el móvil habría creado un segundo criterio de verdad sobre dinero.
2. **Verificación de transferencia declarada por el repartidor**
   (`POST /api/admin/orders/:id/payment/transfer`) está en la PWA y **no** en la
   app: pertenece al flujo del repartidor, no al de oficina. Los cobros que anota
   la app son de caja (se registran ya verificados, como en el panel).
3. **Auditoría completa** (`/api/admin/audit`) sigue solo en la PWA. La app enseña
   el historial del pedido, que es lo que se necesita para operar y cobrar.
4. **Devoluciones**: el servidor modela la devolución como *cancelación de venta*
   (restaura inventario y anula el pago). La app hace exactamente eso; no inventa
   un flujo de «nota de crédito» que el backend no tiene.

## Cambio de backend (aditivo)

`GET /api/admin/orders` no existía (solo `POST`). Se añadió con permisos
(`orders.read`), alcance por empresa y cursor `<fecha>|<id>`, para poder recorrer
más de 150 pedidos sin duplicar ni saltarse filas. Ningún cliente existente se ve
afectado: la PWA no llamaba a esa ruta y sigue usando `/api/admin/data`.

## Protecciones que se mantienen

- Ninguna operación de dinero se ejecuta sin clave de idempotencia.
- El saldo que vio la persona viaja como `expectedDue` / `expectedPending`: si
  cambió, el servidor rechaza en vez de cobrar sobre datos viejos.
- Rendir de más, cobrar de más o rendir custodia sin ADMIN: rechazado por el
  servidor (verificado en la UAT).
- El efectivo en manos del repartidor **no** cuenta como dinero de caja en
  ninguna pantalla.
