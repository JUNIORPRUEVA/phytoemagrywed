# Pedido al repartidor externo (WhatsApp)

Flujo para mandar el pedido a un mensajero **sin cuenta en el CRM**, recibir sus respuestas y cerrar
la entrega sin perder ninguna garantía del sistema.

## Cómo funciona

1. En el pedido → **Repartidor externo** se elige un contacto **guardado** (los mismos que se crean al
   compartir una ubicación). Solo se guarda la asignación; no se envía nada.
2. En el pedido → **Enviar pedido al repartidor** se manda la plantilla aprobada.
3. El repartidor responde con los botones de la plantilla (**Iniciar entrega**, **Entregado**,
   **Reportar problema**) o escribiendo.
4. **Entregado** NO cierra el pedido: pide una confirmación («CONFIRMAR»). Solo entonces se ejecuta la
   transición oficial a entregado (inventario, venta, postventa), la misma que usa el panel.

## Estados (viven en el pedido: `delivery.external.status`)

`assigned` → `sent` → `in_progress` → `awaiting_confirmation` → `delivered`, con `issue` y `failed`
como ramas. «Iniciar entrega» **no** cambia el estado del pedido: un mensajero externo no comparte
GPS, así que no se puede marcar «en camino» sin una entrega activa del CRM.

## Blindaje (lo que el sistema impide)

| Riesgo | Regla |
| --- | --- |
| Mandar la dirección a un número cualquiera | El destinatario debe estar en `delivery_contacts`; si no, `403 contact_not_saved` |
| Contacto que no quiere recibir pedidos | `shareOrders: false` → `403 contact_sharing_disabled` |
| Enviar al teléfono del propio cliente | `422 contact_is_customer` |
| Mandar un pedido sin dirección | `422 missing_destination` |
| Duplicar el envío | `409 already_sent` salvo `resend: true` (auditado, con contador) |
| Saltarse Meta | Si la plantilla no está aprobada → `409 template_not_approved`. No se envía nada |
| Datos de más | Solo número de pedido, cliente y teléfono, productos, importe, dirección, mapa e instrucciones |
| Respuesta de un desconocido | Se ignora: sigue su curso normal como cliente |
| Cambiar el pedido equivocado | Solo pedidos **suyos** y **abiertos**. Con varios abiertos, pide el número de pedido y no toca ninguno |
| Cerrar sin querer | «Entregado» solo pide confirmación; el cierre exige el segundo mensaje |
| Webhook caído | La máquina de estados va en `try/catch`: un error se registra y nunca tumba el webhook |
| Repetir por reintento de Meta | El mensaje entrante es idempotente (lo garantiza `recordInbound`) y la auditoría usa claves de idempotencia |

## Piezas

| Archivo | Qué hace |
| --- | --- |
| `server/delivery-courier.mjs` | Contactos, datos que viajan, envío, máquina de estados |
| `server/crm-server.mjs` | Plantilla `phyto_pedido_repartidor_v1`, rutas `/courier/assign` y `/courier/send`, enlace con el webhook |
| `public/admin/app.js` | Entrada «Repartidor externo» / «Enviar pedido al repartidor» en las acciones del pedido, y contactos en la hoja de reparto |
| `tests/delivery-courier.test.js` | 25 pruebas del flujo y del blindaje |

## Plantilla

`phyto_pedido_repartidor_v1` — categoría **UTILITY**, idioma `es`, 8 variables y 3 botones de
respuesta rápida. En **UAT está aprobada a propósito**. En **producción la tiene que aprobar Meta**:
hasta entonces el envío responde `template_not_approved` y no manda nada.

## Validado en UAT

- Asignar contacto guardado → `200`.
- Enviar → `200` con `wamid` y estado `sent`.
- Segundo envío → `409 already_sent`; reenvío explícito → `200`, intentos `2`.
- Número no guardado → `403 contact_not_saved`.
- Enviar sin asignar → `409 courier_not_assigned`.
- 25 pruebas unitarias del flujo (incluye negaciones, ambigüedad y pedidos ajenos) + 81 de regresión.

## Pendiente

1. **Aprobar la plantilla en Meta** (producción). Sin eso, el botón avisa y no envía.
2. Desplegar el código.
3. Si se quiere avisar al equipo cuando el repartidor reporta un problema, añadir una notificación
   interna (hoy queda en la auditoría y en el estado del pedido).
