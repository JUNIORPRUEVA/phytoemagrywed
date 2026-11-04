# Auditoría del recorrido comercial y de reparto

Fecha: 2026-11-03. Alcance: lectura del código de `public/admin`, `server`, `apps/fulltech_crm` en la rama `feat/crm-pos-fullpos`, y de `C:\Users\pc\DEV\PROYECTOS\INTERNO\FULLTECH-DELIVERY`. No es una certificación UAT ni una inspección de datos de producción. Las referencias siguientes son al código fuente actual; la documentación histórica se usó solo como contexto. No se modificaron esos sistemas.

## Fuentes y límites de coordinación

- Worktree Flutter: `C:\Users\pc\DEV\WORKTREES\PHYTOEMAGRY\crm-pos-fullpos\apps\fulltech_crm`. `docs/TRABAJO-PARALELO.md` asigna Chat, POS y Pedidos/Entregas a sesiones distintas y reserva `lib/data/crm_repository.dart` al chat principal. El backend compartido tiene otro responsable. Este informe propone cambios, no los aplica.
- PWA: `public/admin/app.js` (pedidos, WhatsApp, entrega, custodia) y `public/admin/pos.js` (tickets, cotizaciones, checkout). Backend: `server/crm-server.mjs`, `server/customers.mjs`, `server/pos-routes.mjs`, `server/pos-tickets.mjs`, `server/orders.mjs`, `server/order-payments.mjs`, `server/delivery-lifecycle.mjs`, `server/delivery-courier.mjs`, `server/delivery-cash.mjs`, `server/collections.mjs`.
- App Delivery: `lib/data/repositories/crm_courier_client.dart`, `api_delivery_data_source.dart`, `crm_courier_adapter.dart` y `lib/features`. Sus fixtures de demo no prueban una operación real. No se consultaron sesiones HTTP, base de datos ni dispositivos.

## Recorrido real: 20 comprobaciones

| # | Hecho comprobado en el código | Ruta o persistencia principal | Límite o hueco |
|---|---|---|---|
| 1 Cliente | El webhook busca o crea por teléfono; POS exige cliente al finalizar. | `customers.mjs::recordInbound`, `pos-routes.mjs::handlePosRoute`; `customers` | Resolver explícitamente empresa y propiedad al abrir POS desde Flutter. |
| 2 Mensajes | Entrantes se guardan en `wa_messages`, enlazados a `conversation_id` y `customer_id`, con unicidad por `wa_message_id`. | `customers.mjs:1547-1605`, `collections.mjs` | No inferir una venta a partir de un mensaje. |
| 3 GPS WhatsApp | El mensaje de tipo ubicación se normaliza, se guarda en `locations` con origen, instante, mensaje y cliente; el mensaje lleva `location_id`. Duplicados del webhook reutilizan la ubicación. | `whatsapp.mjs::locationFromInbound`, `customers.mjs:1606-1629,1802-1840`, `locations.mjs` | Elegirla explícitamente para el pedido; no sustituir otra dirección en silencio. |
| 4 Crear pedido | PWA POS envía `requestId`, cliente, conversación, líneas y total esperado. Backend usa el mismo `createOrder` que `POST /api/admin/orders`. | `pos.js::complete`, `pos-routes.mjs:148-270`, `crm-server.mjs:3818-4000,10051` | Crear no equivale a cobrar ni a entregar. |
| 5 Abiertos | POS consulta `/api/admin/pos/context/:customerId`; PWA ofrece continuar uno o crear otro y exige reconocimiento si hay abiertos. | `pos.js:303-347,394-410`; `pos-routes.mjs:63-67` | El selector PWA de pedidos no equivale a reabrir un ticket. |
| 6 Cantidades | El carrito PWA y Flutter permiten líneas, cantidad y descuento; la edición de un pedido guardado usa otra operación. | `pos.js::lineEditor`, `apps/fulltech_crm/lib/features/ventas/pos_screen.dart`, `crm-server.mjs:12492+` | No reutilizar un pedido cerrado como borrador. |
| 7 Precios | El servidor recalcula desde catálogo y compara `expectedTotal`; responde `price_changed` o falta de stock. | `pos-routes.mjs:216-228`, `server/pos-math.mjs` | Un ticket o cotización antiguos no garantizan precio ni disponibilidad. |
| 8 Cotización | `POST /api/admin/pos/quotes` crea `pos_documents.kind=quote`, número COT y PDF. No crea pedido. | `pos-routes.mjs:92-94,130-143,148-270` | No encontré campo de vigencia ni edición de documento publicado; diseñarlo como ampliación, no afirmar que existe. |
| 9 Conversión | Checkout con `quoteId` o ticket ligado a ella usa ID derivado de la cotización; marca `converted`, enlaza `order_id`; una repetición devuelve resultado o conflicto. | `pos-routes.mjs:111-116,161-185,230-261` | Tras fallo incierto consultar documento/pedido antes de reintentar. |
| 10 Confirmación | `POST /api/admin/orders/:id/confirm` cambia etapa, puede asignar a la vez, no cobra. | `crm-server.mjs:12137-12184` | Respeta `orders.update_operational`; asignación interna requiere `delivery.tracking.manage_all`. |
| 11 Entrega/retiro | POS guarda `deliveryMethod`, dirección, ubicación y costo; pedido guiado exige coordenadas solo cuando saldrá con mensajero. | `pos.js::complete`, `pos-routes.mjs:189-215` | El costo es entrada manual; no se halló cotizador por carretera o zona en checkout. |
| 12 Asignación | Existen flujos para repartidor interno y contacto externo y autorización diferenciada. | `crm-server.mjs:10810-11007`, `delivery-courier.mjs` | Asignar y enviar oferta son pasos distintos; no asumir aceptación. |
| 13 Pago | `POST /api/admin/orders/:id/payments` añade entrada con importe, método, actor y clave idempotente; saldo y parcial son independientes del estado comercial. | `crm-server.mjs:12301-12357`, `order-payments.mjs` | No registrar por imagen o texto del chat. |
| 14 Transferencia | Declaración del repartidor queda pendiente; administración verifica/rechaza con `/payments/:paymentId/verify`. Existe además ruta de revisión de transferencia de entrega. | `crm-server.mjs:12359-12396,7514-7572`; `order-payments.mjs` | `payment_status=paid` solo tras cobro verificado o registro autorizado. |
| 15 Documento | POS factura usa `pos_documents.kind=invoice`, `invoice_id/number` en pedido y PDF; pedido usa recibo. | `pos-routes.mjs:130-143,234-255`; `orders.mjs` | `orders.mjs` aclara que no hay integración fiscal. No llamar a este PDF comprobante fiscal/e-CF. |
| 16 Compartir | Cotización tiene envío WhatsApp dedicado; pedidos tienen `invoice-whatsapp` y recibo. | `crm-server.mjs:8763+,11535+`, `pos-routes.mjs:43-52` | Verificar ventana/plantilla y evitar aviso duplicado; no enviar automáticamente tras guardar. |
| 17 Entrega/cierre | Máquina logística valida aceptar, recoger, iniciar, llegar y entregar; código de prueba o confirmación administrativa según caso. | `delivery-lifecycle.mjs`, `crm-server.mjs:6947-7170,7610-7639` | Sin prueba configurada, el courier declara entrega pendiente de verificación; no presentarla como cerrada. |
| 18 Efectivo courier | Al confirmar entrega se registra cargo de custodia por efectivo declarado, acotado al saldo, con clave `charge:orderId`. | `crm-server.mjs:7149-7230`, `delivery-cash.mjs` | Transferencia declarada no es efectivo en custodia. |
| 19 Rendición | Existe `POST /api/admin/delivery-cash/remittance` y, por pedido, `/payments/handover`, ambos separados del pago cliente. | `crm-server.mjs:7660-7706,12398-12426`, `order-payments.mjs` | Conciliar las dos vistas antes de cualquier unificación visual; no sumar dos veces. |
| 20 Cierre | `finish`, `status` y `delivery/confirm` permiten cierres operativos con restricciones; cancelación tiene permiso separado. | `crm-server.mjs:12186-12300,12428+`, `orders.mjs` | Un cierre logístico no liquida automáticamente custodia, comisión o transferencia. |

## Qué tiene hoy cada cliente

**PWA.** `public/admin/pos.js` conserva un carrito local (`localStorage`) y lo aparca en tickets del servidor; al elegir cliente busca su ticket editable, consulta pedidos abiertos y muestra selector. `complete` guarda una operación estable y distingue `quote`, `order` e `invoice`. Para pedido guiado conserva el ID tras guardar para continuar entrega. La interfaz de `app.js` contiene además gestión de pedidos, mapa, custodia y WhatsApp. No se hizo recorrido visual ni prueba con servidor; los hechos anteriores proceden de handlers, no de botones.

**Flutter CRM.** `CrmRepository` ya consume tickets, contexto POS, cotizaciones, checkout, pedidos, pagos, entregas, GPS y custodia. `PosScreen` puede aparcar/reabrir tickets, precargar cotización y abrir pedido; `PedidoActions` confirma, cobra, asigna, comparte y rinde. `ChatOptionsPanel` ofrece «Crear pedido», pero `chat_screen.dart:1408-1411` llama únicamente `onNavigate('pos')`; `crm_shell.dart:355` construye `PosScreen` sin cliente ni conversación inicial. Tampoco hay «Crear cotización» equivalente en esa acción. La recuperación del cliente/ticket del chat y la decisión ante varios borradores deben integrarse. `PosScreen` conserva una referencia estética a FullPOS en un comentario; para el siguiente bloque rige la referencia visual PWA pedida aquí.

**Delivery Flutter.** El cliente tipado usa `/api/courier/login`, `/me`, `/availability`, `/orders`, `/orders/:id`, `/orders/:id/:event`, `/location` y `/logout`; la app adapta estados del backend sin tratarlos como equivalentes ciegos. Envía clave de idempotencia y datos de efectivo/transferencia al declarar la entrega. El backend valida pertenencia del pedido a courier y empresa, versión esperada, caducidad y transiciones. El modelo de Delivery distingue remuneración y efectivo en custodia, pero esos campos de modelo no prueban que exista un cálculo por distancia ni liquidación real. No se abrió la app ni se validó push, GPS en segundo plano o historial UAT.

## Contratos y permisos que se reutilizan

| Área | Contrato existente | Protección observada |
|---|---|---|
| POS | `GET /api/admin/pos/context/:customerId`, `GET/POST /tickets`, `POST /quotes`, `POST /checkout` | `orders.read`, `orders.create`; ticket visible por actor; versión y `requestId`; `expectedTotal`. |
| Expediente | `customers`, `conversations`, `wa_messages`, `locations`; ubicación como snapshot de pedido | `wa_message_id` e `idempotency_key` únicos, relación cliente-conversación comprobada. |
| Pedidos | `POST /api/admin/orders`, `/:id/confirm`, `/:id/status`, `/:id/finish`, `/:id/courier/assign`, `/:id/courier/send` | Permisos por acción; aislamiento por empresa y estado cerrado. |
| Pago y custodia | `/:id/payments`, `/:paymentId/verify`, `/:id/payments/handover`, `/api/admin/delivery-cash/*` | Verificación/rendición solo administración; deduplicación de movimientos. |
| Courier nativo | `/api/courier/*` | Bearer y alcance de empresa, pedido asignado, estados y versión. |

`server/collections.mjs` define colecciones JSON persistentes (`pos_documents`, `wa_messages`, `locations`, `delivery_events`), mientras `server/pos-tickets.mjs:9-37` crea `fulltech_pos_tickets_v1` en SQL con `version`, `operation_id`, `status` y `doc`. Una tabla de tickets nueva duplicaría lo que ya existe. Debe confirmarse en UAT que el backend levantado corresponde a esta revisión del worktree antes de concluir que sus rutas están operativas.

## Desajustes y riesgos prioritarios

1. **Entrada desde chat a POS.** Flutter pierde contexto; el operador puede seleccionar otro cliente por error. Propagar y comprobar IDs en servidor, sin introducir otro `createOrder`.
2. **Ticket frente a pedido.** Ambos son cosas distintas. El ticket permite volver a editar; el pedido ya tiene efectos comerciales. La PWA ofrece ambos recorridos, pero la especificación Flutter debe mostrar cuál se continúa.
3. **Venta y factura.** El checkout de factura marca entregado/pagado de inicio; solo debe ofrecerse si realmente hubo cobro confirmado y entrega. Una transferencia por verificar exige pedido pendiente y comprobación posterior. El PDF actual no es e-CF.
4. **Inventario.** `createOrder` llama `ensureInventoryForSale`; no afirmar que toda creación de pedido descuenta stock inmediatamente. La transición final y `inventory_deducted_at` necesitan prueba dirigida de stock en UAT.
5. **Tarifas.** `delivery_fee` entra desde POS; `delivery_rate` es una tarifa fija de ganancias por entrega (`crm-server.mjs:7866-7887`, `delivery-cash.mjs:170-181`). `app.js` contiene cálculos/presentaciones de delivery y comisiones; no constituyen por sí solos una política única validada. Falta contrato de distancia por carretera, zona/tramos, vigencia, excepción y snapshot de remuneración en asignación.
6. **Cierre económico.** Confirmar entrega, cobrar, rendir y liquidar son hechos separados. No descontar remuneración del efectivo custodiado sin asiento aprobado.
7. **Concurrencia.** Checkout protege `requestId`/huella; tickets usan versión; courier usa eventos y versión. Mantener esos valores al pasar de una pantalla a otra y tratar respuesta incierta como consulta, no reenvío automático.
8. **Ámbito de empresa y roles.** No mezclar clientes, repartidores, pedidos o documentos entre Phytoemagry y FullTECH. El permiso `cost.view` gobierna cifras sensibles; el diseño no debe revelarlas por agregados o snapshots.

## Evidencia pendiente

No se ejecutaron pruebas funcionales, UAT, SQL, HTTP ni dispositivos en esta fase. Quedan por confirmar con datos ficticios: ruta exacta de cada botón PWA en uso, persistencia real tras reinicio, sincronía de GPS y avisos, fiscalidad aplicable y facturación electrónica, política comercial vigente de zonas/distancias/comisiones, conciliación de las dos vistas de custodia, y correspondencia entre el backend UAT en ejecución y el código auditado. La documentación de `docs/DELIVERY-CONTRACT.md` y `docs/PAGOS-ENTREGA.md` describe fases anteriores; la fuente para las afirmaciones anteriores fue el código actual.
