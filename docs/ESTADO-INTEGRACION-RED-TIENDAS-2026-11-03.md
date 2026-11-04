# Estado de integración: CRM, tiendas y Fulltech Delivery

Fecha: 2026-11-03. Integración local sin push, deploy ni cambios en 8815.

## Integración local en main

El CRM está reunido en `C:\Users\pc\DEV\WORKTREES\PHYTOEMAGRY\crm-main-integration`
(rama `main`). Incluye backend, panel PWA, app Flutter CRM, controles de IA y
correcciones de medios. La app Fulltech Delivery está reconciliada en el
working tree de `C:\Users\pc\DEV\PROYECTOS\INTERNO\FULLTECH-DELIVERY`
(rama `master`). Las fuentes originales de las sesiones paralelas se conservan
sin checkout, stash ni reset. La rama `main` del CRM todavía requiere cerrar
la validación de regresión antes de usarla en el servidor compartido.

## Código disponible en worktrees aislados

| Componente | Ruta durable | Estado |
|---|---|---|
| Backend, PWA y Flutter CRM | `C:\Users\pc\DEV\WORKTREES\PHYTOEMAGRY\crm-delivery-architecture` · `feat/crm-delivery-architecture` | Fuente original preservada; selección integrada en el worktree local de `main`. |
| Flutter Delivery | `C:\Users\pc\DEV\WORKTREES\PHYTOEMAGRY\fulltech-delivery-network` · `feat/crm-delivery-network` | Fuente original preservada; selección integrada en el working tree local de `master`; falta dispositivo. |

El backend propietario indicado en `apps/fulltech_crm/docs/TRABAJO-PARALELO.md`
es `C:\Users\pc\AppData\Local\Temp\phyto-order-edit`; el Flutter CRM
propietario es `C:\Users\pc\DEV\WORKTREES\PHYTOEMAGRY\crm-pos-fullpos`.
No se sobreescribió ninguno. El candidato UAT tampoco se modificó.
La copia principal `C:\Users\pc\DEV\PROYECTOS\INTERNO\PHYTOEMAGRY`
mantiene sus cambios visuales locales en `feat/crm-shell-fullpos`; esa sesión
es independiente de la consolidación del servidor en `main` y no se ha
restablecido ni descartado.

## Flujo cubierto en código

1. Registrar una tienda por empresa y vincular productos existentes sin duplicarlos.
2. Filtrar la venta por tienda y conservarla en el ticket y pedido.
3. Cotizar ruta vial entre recogida y destino confirmado con política de tarifa al cliente.
4. Bloquear el despacho de pedidos con varias tiendas en la versión de una recogida.
5. Asignar un repartidor y fijar su remuneración separada del cobro y de la custodia.
6. Mostrar GPS de recogida/destino y ruta verificada en Fulltech Delivery.
7. Contactar la tienda mediante un hilo interno por pedido y repartidor; un operador media desde Pedidos. El repartidor no recibe el teléfono de la tienda.
8. Consultar el libro de ganancias y gestionar liquidaciones desde Entregas, con inicio, confirmación o fallo separados de Custodia.

## Pendientes antes de declarar GO

- Cerrar la regresión del panel PWA: la suite general integrada registra 104 fallos; el `main` limpio anterior registra también 104. La comparación por nombre de prueba no identificó una regresión reproducible: un fallo adicional de la pasada paralela desapareció al repetir el archivo aislado. El panel y otros módulos mantienen fallos previos que requieren corrección; no se debe declarar GO con esa suite roja.
- Reconciliar cualquier cambio nuevo que las sesiones propietarias hayan añadido después del snapshot integrado.
- Atribuir tiendas históricas a empresas con revisión de datos reales. No se hizo migración en UAT ni producción.
- Configurar y verificar el proveedor de rutas y las reglas comerciales reales por empresa. Sin ruta o política válida, no inventar kilómetros ni tarifas.
- Por decisión del usuario, las reglas por kilómetro y la comisión sobre productos permanecen configurables pero desactivadas hasta recibir importes, porcentaje y cobertura reales. La tarifa compartida de la empresa tiene prioridad en POS y tienda PWA; una regla compartida desactivada bloquea la cotización automática aunque exista una regla PWA histórica.
- Resolver explícitamente el cumplimiento de pedidos de varias tiendas mediante repartos vinculados o paradas múltiples; mantener el bloqueo actual hasta entonces.
- Conectar una tienda externa mediante un canal autorizado, o definir quién media el mensaje manualmente. El hilo actual no envía por WhatsApp de la tienda.
- Conciliar configuraciones anteriores de Smart Commerce con la regla de delivery única, incluidos precios vigentes y ajuste por zona.
- Contrato de solicitud de rendición desde Delivery, verificación administrativa y conciliación de fallos parciales. Hoy la rendición administrativa y los libros existen, pero el contrato móvil no está cerrado.
- Política fiscal y documento definitivo para ventas externas. La factura inmediata está bloqueada para productos con recogida pendiente.
- UAT de tres frentes con datos efímeros, tres tamaños de Windows y dispositivo Delivery; verificar privacidad, dinero, idempotencia y fallos de red. No se ejecutó esta UAT ni se tocó el proceso compartido 8815.

## Verificación dirigida

- Backend: acceso courier 24/24; cotización 1/1; ciclo Delivery 21/21; POS 20/20; reglas/tiendas 40/40; libro de ganancias 19/19.
- Flutter Delivery: 21/21 pruebas dirigidas de cliente, adaptador y navegación GPS.
- `dart analyze lib` en ambas apps: sin errores; solo avisos informativos de estilo.
- `git diff --check` en el CRM: limpio. En Delivery, los archivos tocados aquí están limpios; el snapshot de la fuente UAT contiene avisos de espacio ya presentes en otros archivos.
- En `main` local: `npm run build` y `node --check server/crm-server.mjs` pasan; 100 pruebas dirigidas del backend, 82 de medios, 2 de controles IA y 1 E2E de preferencias IA pasan. Flutter CRM: 236 pruebas aprobadas, 4 UAT omitidas por falta de URL; `dart analyze lib` sin errores.
- El contrato de entrega repetida exige la misma clave de idempotencia: un segundo intento sin clave devuelve 409. La prueba antigua y la prueba del cliente actualizado están alineadas con ese comportamiento.
- Tarifas: las pruebas dirigidas de PWA, políticas de cliente/repartidor y reservas pasan. Flutter permite editar cobro al cliente y pago al repartidor por kilómetro y la comisión porcentual; el servidor conserva los campos avanzados al editar y rechaza una tarifa por kilómetro activa de RD$0.
- La tienda PWA guarda en el pedido la ruta vial y el origen de recogida de su cotización. Una prueba de pedido real en backend efímero calcula después la remuneración por kilómetros y el 3 % de productos sin usar la tarifa de delivery como base de comisión.

**Estado:** NO-GO operativo. No se afirma que un pedido real pueda despacharse con este snapshot hasta completar la integración y UAT.
