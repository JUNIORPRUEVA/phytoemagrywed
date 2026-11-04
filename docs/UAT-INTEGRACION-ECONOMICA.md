# UAT de integración y conciliación económica

Fecha: 2026-11-03. **Plan de UAT integral: 0 recorridos de tres apps ejecutados.** Sí se ejecutaron 78 pruebas dirigidas de backend con instancias `startCrmServer` y DB SQLite efímera, incluidos disponibilidad persistente, auth multiempresa, transición courier y carrera entre dos servidores sobre la misma base. Ninguna fila de la matriz integral representa resultado aprobado. No se inició ni reinició el servidor compartido 8815, ninguna app ni DB real. Ejecutar únicamente con DB efímera, empresas/usuarios ficticios, GPS simulado, WhatsApp/pagos/push/facturación externos en mock. Registrar en cada caso: versión backend y apps, empresa/rol, hora, ID de pedido/ticket/documento/evento/asiento, petición y respuesta sin secretos, estado antes/después, captura UI cuando aplique y conciliación SQL/JSON. Las pruebas dirigidas son evidencia complementaria, no sustituyen la observación UAT.

| # | Escenario y evidencia mínima de aceptación | Estado |
|---|---|---|
| 01 | Chat A abre Ventas con `customer_id` y `conversation_id` de A, nunca de B; una sola pantalla de edición. | No ejecutado |
| 02 | Cliente sin ticket: exactamente un borrador persistido y retomable tras reinicio. | No ejecutado |
| 03 | Un ticket editable: continuar o crear nuevo de forma explícita; misma versión. | No ejecutado |
| 04 | Varios tickets: selector con fecha/total/estado, elección correcta sin duplicados. | No ejecutado |
| 05 | Doble clic y dos operadores: una intención crea un ticket; conflicto de versión visible. | No ejecutado |
| 06 | Cotización guarda y comparte PDF sin pedido, pago ni movimiento de stock. | No ejecutado |
| 07 | Convertir cotización una vez; reintento devuelve mismo pedido/documento. | No ejecutado |
| 08 | Precio o stock cambió: recalcular y requerir revisión, sin factura silenciosa. | No ejecutado |
| 09 | Recogida en almacén: fuente, contacto, dirección, GPS y snapshot correctos. | No ejecutado |
| 10 | Recogida en proveedor/sucursal: parada distinta, múltiples orígenes si aplica, sin confundir `order_pickups`. | No ejecutado |
| 11 | GPS WhatsApp persiste, fuente/fecha y mismo cliente; aislamiento multiempresa. | No ejecutado |
| 12 | GPS viejo o ausente: operador confirma destino o abre incidencia, sin coordenadas inventadas. | No ejecutado |
| 13 | Zona/km y comisión: regla/version/importe aprobados y snapshot de tarifa cliente/courier separados. | No ejecutado; política pendiente |
| 14 | Cambio de tarifa futura no altera pedido/oferta ya confirmados. | No ejecutado |
| 15 | Dos aceptaciones concurrentes: un ganador, conflicto del otro y un solo evento. | No ejecutado |
| 16 | Disponibilidad/turnos: ruta real, permisos, reinicio y desconexión; no mostrar en línea falso. | No ejecutado; ruta ausente |
| 17 | Courier rechaza; CRM reasigna, anterior pierde acceso, venta sigue abierta. | No ejecutado |
| 18 | Recogida e inicio de trayecto con hora, evidencia y GPS de edad visible. | No ejecutado |
| 19 | Efectivo total: pago, entrega y un cargo de custodia por importe recibido. | No ejecutado |
| 20 | Doble cobro y timeout: consulta de resultado, sin segundo pago/cargo/evento. | No ejecutado |
| 21 | Pago parcial o no pago: saldo residual correcto, bloqueo o excepción según política. | No ejecutado |
| 22 | Transferencia con soporte: pendiente hasta verificación admin, sin cargo de efectivo. | No ejecutado |
| 23 | PIN correcto, incorrecto, vencido, reutilizado e intentos agotados; auditoría. | No ejecutado |
| 24 | Entrega fallida: paquete localizado, responsable y plan de retorno; no estado entregado. | No ejecutado; contrato incidencia pendiente |
| 25 | Rendición parcial: solicitud no cambia saldo; admin verifica y crea un asiento. | No ejecutado; solicitud ausente |
| 26 | Transferencia de courier declarada no recibida: solicitud pendiente, custodia intacta. | No ejecutado; solicitud ausente |
| 27 | Dos solicitudes/aprobaciones concurrentes: no exceden saldo, sin doble remittance. | No ejecutado; solicitud ausente |
| 28 | Ganancia/payout/turno independientes de custodia; ninguna compensación implícita. | No ejecutado |
| 29 | Empresa ajena: 403/404 sin datos cruzados en pedido, GPS, código, dinero ni caché. | No ejecutado |
| 30 | Móvil offline/reinicio: lecturas marcadas antiguas; ninguna acción financiera automática duplicada. | No ejecutado |
| 31 | Reasignación y avisos: un mensaje por evento autorizado; `pending_template` cuando corresponda. | No ejecutado |
| 32 | Documento/factura: no emisión prematura; e-CF solo si contrato fiscal aprobado. | No ejecutado; contrato fiscal pendiente |
| 33 | Conciliación PWA/CRM Flutter/Delivery al centavo: total, pagos, saldo, custodia, ganancia y payout. | No ejecutado |
| 34 | Roles y auditoría: solo admin verifica/ajusta; courier ve solo su empresa/pedidos. | No ejecutado |
| 35 | Navegación: un centro Ventas y uno Custodia, sin dos editores ni acciones ambiguas. | No ejecutado |
| 36 | Windows/Android con tamaños acordados; iOS solo si hay dispositivo/entorno Apple. | No ejecutado |

## Casos adicionales de red de tiendas (todos sin ejecutar)

| # | Criterio de aceptación |
|---|---|
| T01–T04 | Registrar tienda con empresa/GPS/contacto; reutilizarla sin duplicar; detectar posible duplicado aunque cambie teléfono; inactivar sin alterar repartos históricos. |
| T05–T08 | Asociar producto a dos tiendas con códigos/costos distintos; preservar catálogo Phyto/Fulltech; filtrar Ventas por tienda; retener vínculo elegido en ticket y pedido. |
| T09–T11 | Distinguir stock propio de disponibilidad declarada o pendiente; no descontar stock externo; bloquear despacho si falta confirmación exigida. |
| T12–T15 | Proponer origen cuando las líneas coinciden; seleccionar tienda alternativa autorizada; snapshots de recogida/destino sobreviven ediciones posteriores; mezcla de tiendas se bloquea o se divide explícitamente. |
| T16–T19 | Ruta vial con proveedor/metraje; fallo de ruta sin distancia inventada; tarifa cliente y remuneración courier calculadas por regla/versiones distintas; cambio posterior no altera reparto aceptado. |
| T20–T23 | Comisión 0% y activada; base solo de productos elegibles, descuentos/impuestos según política; devolución y redondeo al centavo; pago courier no netea custodia. |
| T24–T27 | Courier no recibe teléfono/WhatsApp de tienda en JSON, errores, notificaciones, logs ni caché; acceso cruzado por empresa rechazado; una conversación de tienda separada de chat cliente y reparto; tienda sin cuenta requiere mediación CRM. |
| T28–T30 | Contacto con tienda autorizado, reintento idempotente y supervisión; cambio de ubicación activa requiere permiso, recálculo y aviso; PWA, Flutter CRM y Delivery concilian el mismo pedido. |

Las 30 comprobaciones se agregan a las 36 existentes y a las 28 de Delivery; ninguna está aprobada por la inspección de código. Antes del UAT, la ruta general de proveedores debe negar acceso a repartidores y probarse con una cuenta courier real en entorno efímero.

## Cobertura adicional de la auditoría Delivery

Los 28 escenarios originales de `FULLTECH-DELIVERY-multitenant/docs/FLUJO-DELIVERY-COBROS-CUSTODIA.md` permanecen obligatorios. La matriz anterior cruza: contra entrega (19), almacén (09), proveedor (10), GPS (11), dirección incompleta (12), rechazo (17), dos aceptan (15), efectivo completo (19), efectivo parcial (21), no paga (21), corte tras cobrar (20), misma clave (20), PIN incorrecto/válido/sin PIN (23), entrega fallida (24), cargo (19), rendición parcial (25), transferencia declarada/rechazada/verificada (26-27), comisión (28), cambio de tarifa (14), reasignación (17/31), cancelación (24), otra empresa (29), conciliación (33), aviso (31). Deben conservarse además las variantes de **PIN sin código con aprobación admin, pérdida de red durante PIN, GPS en dispositivo real, múltiples paradas, persistencia tras reinicio del backend y fallo entre escritura del pedido y ledger**. Ninguna de estas variantes se ejecutó.

## Reglas de evidencia y GO

Para cada escenario guardar artefacto con ID de ejecución, revisión Git o hash de cambios sin commit, configuración mock, petición/respuesta redactada, IDs, asientos antes/después y captura cuando sea visual. Automatizar primero pruebas de idempotencia, permisos, empresa y concurrencia. Se ejecutaron `tests/courier-access.test.js`, `delivery-lifecycle.test.js`, `delivery-payment.test.js`, `delivery-proof.test.js` y `delivery-cash.test.js`: **78/78 aprobadas**. Otras suites de compensación, turnos, conciliación, Flutter y UAT de tres aplicaciones siguen pendientes.

El GO integral requiere: 36/36 escenarios originales pertinentes, 28/28 Delivery y 30/30 de red de tiendas aprobados, invariantes de dinero al centavo, regresión PWA, `flutter analyze`, `flutter test`, pruebas de API y builds pertinentes, además de UAT visual/dispositivo. Casos legalmente no aplicables se marcan «no aplica» con motivo, nunca «aprobado». Por ahora el resultado es **NO-GO**.
