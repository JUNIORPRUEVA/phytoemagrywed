# FULLTECH Smart Commerce — matriz UAT

23 de octubre de 2026. Esto es un registro de pruebas automatizadas y un plan de aceptación humana, **no una declaración de UAT de negocio completada**. No se activaron ciudades reales. Las zonas A/B de pruebas no representan los polígonos oficiales de Higüey/La Romana.

Evidencias: `tests/store-smart-rules.test.js` (R), `tests/store-smart-commerce.test.js` (C), tests existentes de checkout/aislamiento/API (L), `scripts/check-store-smart-uat.mjs` y `docs/capturas/smart-commerce/results.json` (B). Ejecuciones Vitest en `.tmp/store-smart-targeted.json` y `.tmp/store-smart-full.json`.

| # | Escenario | Resultado esperado | Resultado real / evidencia / pendiente |
| --- | --- | --- | --- |
| 1 | Cliente en Higüey | Resolver zona operativa y origen configurados, nunca inferir cobertura solo por ciudad | Polígono sintético validado R/C; Higüey real pendiente de configuración y UAT |
| 2 | Cliente en La Romana | Otra zona y reglas comerciales autorizadas | Dentro/fuera probado R/C; La Romana real pendiente, no activada por defecto |
| 3 | Mismo producto, precios por zona | Precio regional del servidor, no del navegador | C cambia base1000 a regional2000; B pedido3100 con entrega; dos zonas reales pendientes |
| 4 | Disponible solo en otra ciudad | Mostrar origen; no llamar “stock local”; transporte por confirmar | Ciudad de despacho en C/B; reserva y existencia real por ubicación pendientes |
| 5 | Entrega de un producto | Subtotal + tarifa vial exacta, pago pendiente | C/B aprobado con ruta sintética10790 m y fee1100 |
| 6 | Varios productos, un origen | Una agrupación, cantidades y subtotal correctos | C aprobado agrupación única/subtotal1500; promesa/reserva operativa pendiente |
| 7 | Carrito multi-proveedor | Separar orígenes y no aplicar una tarifa local a todo | C agrupa dos orígenes, totalnull, revisión; liquidación y aceptación no implementadas |
| 8 | Retiro en FULLTECH | Reserva y autorización antes de entregar | C devuelve `pickup_reservation_contract_pending`; bloqueado, ningún código |
| 9 | Retiro en tercero | Proveedor confirma y sucursal autorizada valida entrega | Bloqueado: no se confunde con recogida del repartidor |
| 10 | Proveedor confirma | Aceptación autenticada, auditable e idempotente | NO IMPLEMENTADO; oferta que requiere confirmación fuerza revisión C |
| 11 | Proveedor rechaza | Liberar reserva y recotizar sin promesa falsa | NO IMPLEMENTADO; no existe reserva nueva que liberar |
| 12 | Proveedor no responde | Vencimiento/reasignación con estados y avisos reales | NO IMPLEMENTADO; no se afirma que haya mensaje enviado |
| 13 | Cliente cambia destino | Invalidar cotización y exigir revisión | C liga snapshot/carrito/config; UI invalida cambios; aceptación humana pendiente |
| 14 | Transferencia bancaria | Datos receptores autorizados y pago no verificado | C/B selección y creación pendientes aprobadas; ningún pago real |
| 15 | Transferir después | Intención registrada sin confirmar pago | Método elegible validado C; UX manual pendiente |
| 16 | Subir comprobante | Archivo privado con límites; pago sigue pendiente | NO IMPLEMENTADO en checkout nuevo; no se simuló subida ni pago |
| 17 | Admin verifica pago | Rol y evidencia; registro contable idempotente | Módulo existente sin cambios; integración/UAT financiera nueva pendiente |
| 18 | Cliente recibe código retiro | Código privado, no antes de reserva/autorización | BLOQUEADO; no se emiten códigos utilizables |
| 19 | Tienda valida y entrega | Consumir autorización una vez y ajustar reserva/stock | BLOQUEADO; contrato transaccional faltante |
| 20 | Ruta >15 km | No cobrar tarifa local ni confirmar entrega | R/C15001 m → manual y totalnull, aprobado |
| 21 | Servicio vial falla | Revisión, sin distancia recta ni cargo inventado | R/C aprobado; proveedor real no llamado |
| 22 | Envío interciudad | Solicitud, propuesta y aceptación explícita | C request202 idempotente sin pedido; propuesta/aceptación NO IMPLEMENTADAS |
| 23 | Catálogo PHYTO aislado | No mezclar productos ni activar módulo en otra tienda | L aislamiento aprobado; R servicio devuelve null para otra tienda |
| 24 | Pedidos CRM existentes | Conservar flujo; pedidos smart usan el mismo motor | L checkout aprobado y C/B pedidos nativos; suite global fallida, no certificación total |
| 25 | Delivery existente | Conservar contrato y validar integración sin mensajes de prueba reales | Campos fee/GPS reutilizados; operación real/capacidad no probadas, fallos globales de notificación pendientes |

## Comprobaciones adicionales ejecutadas

- Tarifas de borde y muestreo de todos los tramos: enteros/mínimo, nunca125, rechazo de overflow.
- Cotización vencida y cambio de configuración/cart/banco no permiten pedido usando valores obsoletos.
- Otro cliente no puede leer cotización ni reutilizar dirección ajena; origen cruzado rechazado.
- Dos request keys concurrentes con una cotización generan un solo pedido.
- Manipular total, deliveryFee, paid o fulfillment no impone esos valores al servidor.
- GPS poco preciso, cobertura ausente, capacidad ausente y horarios cerrados producen revisión.
- Direcciones solo se guardan como preferencia con consentimiento; GPS de navegación no se guarda por defecto.
- GPS denegado en B: dirección escrita → revisión, carrito conservado y ningún segundo pedido.
- B verifica siete tamaños, summary único, campos bancarios sintéticos, pago pendiente y cero errores JS/overflow.

## Defectos y barreras de aceptación

La suite general no pasa; ver informe principal. Falta probar PostgreSQL, crash/reconciliación entre claim y pedido, múltiples procesos y stock por ubicación. Editor de cobertura actual es JSON, no mapa; polígonos deben revisarse con herramienta GIS antes de activación. Proveedor de ruta/capacidad de UAT es sintético. No aprobar proveedores, retiros ni finanzas solo porque la pantalla se renderice.

Para UAT humana: responsables de tienda/CRM/reparto deben registrar fecha, operador, dispositivo, zona configurada, request key/quote/order ID, esperado, obtenido, evidencia y defecto. Usar sandbox bancario y de mensajería autorizado; esta implementación no habilita pruebas con dinero o mensajes reales automáticamente.

## Actualización de continuidad: reservas, proveedores y retiro

La matriz anterior es el diagnóstico de la primera entrega. Los escenarios8–12 y18–19 ya tienen implementación local; sus límites actuales están en la sección24 del informe principal. No reemplazar la UAT humana pendiente por el resultado automatizado.

| Escenario adicional | Evidencia automatizada actual | UAT pendiente |
| --- | --- | --- |
| Dos compradores compiten por última unidad | Un pedido201 y otro409, una sola reserva | Dos dispositivos y red variable |
| Dos servidores comparten BD | Dos instancias SQLite, conexiones separadas, sin sobreventa | PostgreSQL/múltiples procesos reales |
| Reiniciar servidor con reservas | Reserva persistente, nuevo pedido no puede revenderla | Crash durante commit/conciliación |
| Cancelar/vencer | Liberación idempotente y evento de escalación | Reembolso si hubo pago; caso parcial |
| Proveedor reporta disponibilidad | Sin reserva ni aceptación hasta `supplier_confirmed` | Recuento físico y permisos reales |
| Proveedor acepta/rechaza/no responde | Sesión + grant, reserva al aceptar; rechazo/vencimiento liberan | Persona responsable, sandbox de avisos, turnos |
| WhatsApp enviado | Adaptador falso, `sent` no cambia `pending` a `accepted` | Contrato e idempotencia del proveedor real; no se probó envío real |
| SUPPLIER intenta entrar a clientes/chats/datos | API403, permisos por sucursal y revocación probados | Auditoría integral de rol y sesiones |
| Retiro antes de listo/pago | Código y entrega manual bloqueados | Operación de mostrador, cobro parcial/rechazado |
| Retiro pagado y preparado | Código privado128 bits, expiración5 min, consumo único con inventario | Captura/lector, dispositivos, pérdida de red |
| Multi-origen | Todos listos antes de código, una entrega por grupo y un pedido final | Entrega parcial y procedimiento de devolución |
| Delivery reservado | Motor nativo consume sucursal/maestro sin doble descuento | Courier/cobertura operativos reales |

`tests/store-fulfillment.test.js`:17 casos aprobados. Selección de regresión ampliada:103/103. Browser: siete tamaños previos y tres retiros completos a320/390/1024 px, sin overflow ni page errors. Las entradas de pago y los proveedores de estas pruebas son ficticios en SQLite temporal. Producción sigue NO-GO por los defectos generales y las validaciones pendientes descritas en el informe.
