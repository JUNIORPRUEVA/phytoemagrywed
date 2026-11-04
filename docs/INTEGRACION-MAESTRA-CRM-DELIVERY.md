# Integración maestra CRM + Delivery

Fecha: 2026-11-03. **Arquitectura y avances parciales en rama aislada; no es aprobación UAT.** Rama `feat/crm-delivery-architecture`, base `bb53861a7720499076437f8a36de1d2c3bc5bcbb`, ancestro común de CRM Flutter `54e4fbf910ce66655952180b1970e7b83950d7d3` y backend candidato `c7f3852129bbfaaf74a0076efb39ad1a4b5a8b5a`. Delivery es otro repositorio, revisión `adc387c792ea1c89fc05cdd33f3d08ad9bfa16ee`; no comparte base Git. La app Flutter y sus cambios locales se copiaron como snapshot a esta rama aislada; los worktrees de origen permanecen intactos.

## Fuentes verificadas

Se leyeron los cuatro documentos completos, todos **sin seguimiento Git** en sus worktrees de origen. SHA-256 para identificar exactamente el contenido auditado:

| Fuente | SHA-256 |
|---|---|
| `crm-pos-fullpos/apps/fulltech_crm/docs/AUDITORIA-PWA-PEDIDOS-COTIZACIONES-DELIVERY.md` | `7B27651B3A0823A18C9238F02CF5E51829A6007AE799A7EE3C0880` |
| `crm-pos-fullpos/apps/fulltech_crm/docs/FLUJO-OPERATIVO-VENTAS-FLUTTER.md` | `FA142E7273A8CD49DC35F36F171C89CC4A53CCE883070539688B49E0BC9D3470` |
| `FULLTECH-DELIVERY-multitenant/docs/AUDITORIA-DELIVERY-INTEGRACION-CRM.md` | `D6FBDCB91D0C6669CBF25BE6B3E39EF48A05CDC9701627026596A9985B36A6F9` |
| `FULLTECH-DELIVERY-multitenant/docs/FLUJO-DELIVERY-COBROS-CUSTODIA.md` | `4BA2568EF97AB67CD7745A56D5EB902D2760BF09AF3155F25255C2BBD3BA5F20` |

El plan recibido tiene SHA-256 `5A835973BA764CC4C25034F1EE3A8CF52925623D4EE0B0EE78FE270032AB5121`. Los hashes, más los HEAD indicados, son el respaldo verificable del punto de partida; no sustituyen un commit. Se contrastaron rutas y referencias con los archivos fuente. Los documentos previos de etapas y contratos son contexto histórico; el código de la revisión indicada prevalece si discrepan.

## Decisiones canónicas de producto

**Ampliación aprobada para red de tiendas:** no existe origen habitual de recogida. El pedido puede salir de una tienda, proveedor, almacén u otro punto autorizado. El empleado selecciona una tienda reutilizable en el mismo editor de Ventas; si los productos ya señalan una tienda única, se propone. Una mezcla de tiendas no se despacha como recogida única. Se preservan por separado los snapshots de recogida y entrega. El modelo, APIs, migración, permisos y orden A–J están en [RED-TIENDAS-RECOGIDA-CONTRATOS.md](RED-TIENDAS-RECOGIDA-CONTRATOS.md).

La tarifa que paga el cliente, la remuneración del repartidor, su comisión opcional sobre productos y el efectivo bajo custodia son conceptos contables independientes. El servidor debe calcular con ruta vial verificable, regla vigente y redondeo aprobado; todavía no hay valores comerciales fijados. El teléfono privado de la tienda nunca forma parte del DTO Delivery. El contacto con ella exige un canal operativo propio y supervisable por CRM.

1. El **pedido** pertenece al CRM y mantiene `order.id`, cliente, conversación y empresa. PWA y Flutter llaman al mismo servicio de negocio; Delivery consulta y solicita transiciones sobre ese ID. La app courier jamás crea otro pedido.
2. `Ventas` es el único editor: ticket/cotización/productos, después entrega y pago, después confirmar. Chat y ficha del cliente son entradas contextualizadas. En el snapshot de origen, Chat abría POS sin pasar cliente ni conversación; esta rama aislada ya incorpora `PosLaunchContext` y selección de tickets, pendientes de integración y UAT.
3. Ticket (`fulltech_pos_tickets_v1`), cotización (`pos_documents`), pedido, entrada de pago, documento, tarea de entrega, evento, cargo de custodia, rendición y ganancia son hechos diferentes. No se crea otra tabla de tickets ni otro ledger de efectivo. La matriz de contratos identifica la autoridad de cada uno.
4. El backend valida empresa, roles, precio, stock, saldo, estados, asignación y operaciones idempotentes. Las apps solo presentan los datos y ejecutan comandos autorizados. Tras respuesta incierta se consulta el estado antes de reintentar.
5. Recogida y destino necesitan snapshots confirmados antes de la oferta. El GPS recibido por WhatsApp se guarda en `locations`, pero se selecciona explícitamente para un pedido. `order_pickups` documenta abastecimiento de proveedor y no equivale automáticamente a parada courier.
6. Tarifa al cliente, remuneración courier, comisión opcional, efectivo bajo custodia y margen comercial son montos distintos. La administración de tarifas se concentra en `Entregas > Reglas de entrega`; el pedido conserva snapshots versionados. El cálculo vial y la regla comercial aún no están aprobados: no se inventan kilómetros ni precios.
7. Código de entrega acredita recepción física, no pago. Transferencia declarada permanece pendiente de verificación. La emisión fiscal/e-CF no se presume: `server/orders.mjs` indica ausencia de integración fiscal.

## Mapa de pantallas y operaciones

| Pantalla | Acción primaria | Acceso secundario | Autoridad |
|---|---|---|---|
| Chat CRM | Crear pedido/cotización con contexto | Abrir expediente | Ventas y backend POS |
| Ventas > ticket | Continuar ticket o confirmar venta | Cotizar, aparcar | `pos-tickets.mjs`, `pos-routes.mjs` |
| Ventas > entrega/pago | Confirmar origen, destino y modo de cobro | Revisar tarifa autorizada | Pedido y configuración backend |
| Ventas > pedidos | Siguiente acción permitida por estado | Documento, historial | `crm-server.mjs`, `orders.mjs` |
| CRM > entrega | Asignar/ofrecer repartidor | Reasignar/incidencia | Backend logística |
| Delivery > pedido | Siguiente acción de `available_actions` | Navegación/incidencia | Backend logística |
| Delivery > Mi dinero | Solicitar rendición cuando exista contrato | Historial | Ledger CRM |
| CRM > custodia | Verificar rendición | Conciliar | Ledger CRM/admin |
| Entregas > Tiendas de recogida | Mantener tiendas reutilizables y vínculos de productos | Contactos privados por rol | Backend CRM |
| Entregas > Reglas de entrega | Mantener política aprobada de cobro y remuneración | Historial de versiones | Backend CRM |

No se abre un segundo editor dentro de Chat ni un formulario de pedido en Delivery. La UI visual corresponde al frente visual del CRM; este documento define flujos y contratos sin editar shell, tema ni widgets.

## Conciliación de revisiones y operación actual

El proceso que escucha `127.0.0.1:8815` es Node PID 27836, invocado con `--experimental-sqlite server/crm-server.mjs`, padre PowerShell PID 29744. La línea de comando usa ruta relativa y **no identifica su directorio de trabajo ni revisión cargada**. No se consultó su base de datos, no se cambió el proceso y no se atribuyen sus rutas a una rama. En fuente, el backend candidato tiene `/api/courier/earnings` y `/shifts/*` (`PHYTOEMAGRY-candidato/server/crm-server.mjs:7348,7415-7500`); el backend del worktree Flutter carece de esas rutas y conserva `/api/courier/custody` (`crm-pos-fullpos/server/crm-server.mjs:7300`). Ninguno de **esos dos worktrees de origen** contiene `/api/courier/availability` llamada por Delivery (`crm_courier_client.dart:309`). Esta rama aislada ya implementa `GET/POST /api/courier/availability` y lo prueba con DB efímera; sigue pendiente integrarlo con el backend y la app destino.

## Decisiones pendientes del propietario

1. Fijar revisión/backend destino y propietario exclusivo de `server/crm-server.mjs`, `collections.mjs` y módulos de courier. `TRABAJO-PARALELO.md` reserva el backend al frente `feat/crm-order-edit-guard` en Temp; el candidato UAT tiene cambios ajenos sin commit. Ningún archivo compartido se fusiona a ciegas.
2. La política de origen ya quedó definida: no hay ubicación habitual. Falta aprobar la migración de tiendas por empresa, política de tarifa/remuneración, comisión, cobertura y cambio de ruta; y fijar el momento de snapshot/oferta.
3. Definir regla fiscal vigente y qué documento se emite en cada estado. El PDF actual de invoice no demuestra e-CF.
4. Aprobar contrato de solicitud de rendición, validación admin e incidencias con custodia física del paquete.

## Informe UX estático

La propuesta de pedido ordinario tiene **tres pasos visibles** (`Productos → Entrega/Pago → Confirmar`) y una acción primaria por paso; la entrega contra efectivo tiene **una acción primaria contextual por estado** (`Aceptar → Recoger → Salir → Llegar → Confirmar cobro/prueba → Entregar`). Son pasos de diseño, no clics observados. El conteo actual de clics de PWA/Flutter/Delivery no se certificó porque no hubo recorrido UI. Antes del GO visual debe medirse en 1280×720, 1366×768, 1920×1080 y móvil; comprobar que Chat y Ventas abren el mismo editor, que no aparecen dos menús de cobro y que la app courier no ofrece dos cierres de custodia.

## Estado

**NO-GO para flujo integral.** La arquitectura y los propietarios propuestos quedan documentados. En esta rama aislada se agregaron disponibilidad courier persistente por empresa, serialización local más `compareOrder` para transiciones, y DTO con origen, GPS destino y requisito de código. Pasaron 78 pruebas dirigidas de backend con DB efímera. Faltan contratos P0 y pruebas UAT entre las tres apps. Ver [MATRIZ-CONTRATOS-PWA-FLUTTER-DELIVERY.md](MATRIZ-CONTRATOS-PWA-FLUTTER-DELIVERY.md), [MAQUINAS-DE-ESTADO-VENTAS-DELIVERY-CUSTODIA.md](MAQUINAS-DE-ESTADO-VENTAS-DELIVERY-CUSTODIA.md), [UAT-INTEGRACION-ECONOMICA.md](UAT-INTEGRACION-ECONOMICA.md) y [PLAN-IMPLEMENTACION-POR-BLOQUES.md](PLAN-IMPLEMENTACION-POR-BLOQUES.md).
