# FULLTECH Smart Commerce — informe de implementación y GO/NO-GO

> **Actualización vigente, 24/10/2026:** validación adicional en PostgreSQL 17.9 real y aislado, recuperación ante fallos y UAT automatizado. Ver sección 25 y [auditoría PostgreSQL/UAT](FULLTECH-SMART-COMMERCE-POSTGRES-UAT.md). Las secciones 1–24 conservan el historial, no el estado vigente de los pendientes. **Se mantiene NO-GO para producción.** Las pruebas locales no certifican operación real.

Fecha: 23 de octubre de 2026. Alcance: trabajo local; no despliegue, cobros, envíos de mensajes ni modificación de bases de producción. Los cambios anteriores del árbol de trabajo se conservaron.

## 1. Resumen ejecutivo

**NO-GO para habilitar el sistema completo en producción.** Se implementó una base integrada y probada de configuración comercial, precios regionales, GPS voluntario, tarifa vial, cotizaciones con propietario y caducidad y checkout sobre el motor real de pedidos del CRM. No se completó la misión integral: inventario por sucursal, reservas, aceptación de proveedores, autorización de retiro y operación financiera multi-proveedor siguen pendientes o bloqueados.

Todo permanece apagado por defecto. Con la función encendida, una condición operativa no confirmada produce una solicitud de revisión, nunca una entrega, reserva, pago o retiro ficticiamente confirmados. Una solicitud de cotización no es un pedido comercial confirmado.

## 2. Hallazgos de auditoría inicial

Ver [auditoría previa](FULLTECH-SMART-COMMERCE-AUDIT.md). La tienda ya tenía cuentas, catálogo/publicación, carrito, inventario global, pedidos idempotentes, GPS de clientes, proveedores, pagos y reparto. No existía un contrato transaccional reutilizable de inventario por ubicación + reserva + entrega autorizada al cliente. Las recogidas de compras del repartidor existentes no son autorizaciones de retiro del comprador. Tampoco se encontró un adaptador de capacidad operativa que pudiera prometer reparto en checkout.

## 3. Funciones existentes reutilizadas

Se mantienen `fulltech_cart_v1`, cuentas/cookie/CSRF, clientes y direcciones, publicación y aislamiento del catálogo, `publicOrderItems`/`checkOrder`, clave idempotente de pedido, `createStoreOrder` → `createOrderUnlocked`, `purchaseRow`, snapshots, cálculo nativo de subtotal/entrega/total, auditoría y módulo existente de pagos. No se creó otro motor de pedidos, otro catálogo ni otro libro contable.

## 4. Funciones nuevas y clasificación

| Función | Estado y evidencia |
| --- | --- |
| Configuración versionada de sucursales, orígenes, polígonos, horarios, ofertas y bancos receptores | IMPLEMENTADO Y VERIFICADO en SQLite; permisos ADMIN y control de edición concurrente |
| Precios regionales y origen de despacho | IMPLEMENTADO Y VERIFICADO; catálogo público y checkout usan reglas del servidor |
| GPS por acción explícita, coordenadas/dirección alternativas y confirmación de destino | IMPLEMENTADO Y VERIFICADO en Chromium; permisos reales móviles pendientes de UAT |
| Direcciones del cliente y consentimiento | IMPLEMENTADO Y VERIFICADO por API; reutiliza almacenamiento existente |
| Tarifa exacta y adaptador vial OSRM | IMPLEMENTADO Y VERIFICADO con respuestas sintéticas; proveedor real pendiente |
| Cotización privada, caducidad, carrito ligado, revalidación y claim único | IMPLEMENTADO Y VERIFICADO; tests de manipulación, concurrencia e idempotencia |
| Pedido nativo con precio regional y entrega | IMPLEMENTADO Y VERIFICADO; total 3100 y pago pendiente en prueba end-to-end |
| Bandeja administrativa de solicitudes | IMPLEMENTADO Y VERIFICADO para lectura y configuración; no resuelve automáticamente la solicitud |
| Cotización interciudad y multi-origen | PARCIALMENTE IMPLEMENTADO: solicitud y grupos; falta propuesta, aceptación y ejecución |
| Sucursales/proveedores | PARCIALMENTE IMPLEMENTADO: relaciones con proveedores existentes; no aceptación/rechazo operacional |
| Inventario por ubicación y reservas | BLOQUEADO: falta coordinación transaccional con inventario real; no se simula stock local |
| Código, autorización y validación de retiro | BLOQUEADO por reserva/stock/permisos de sucursal; no se emiten códigos utilizables |
| Mensajes y tiempos de confirmación a proveedores | NO IMPLEMENTADO en el flujo nuevo; ningún envío ficticio ni real |
| Comprobante del cliente, conciliación multi-proveedor y rendición nueva | NO IMPLEMENTADO; no se sustituye la autoridad del módulo de pagos existente |
| Disponibilidad real de courier | BLOQUEADO: adaptador de capacidad aún no conectado al proveedor operativo |

## 5. Archivos de este alcance

Nuevos:

- `server/smart-commerce-rules.mjs`: cantidades, dinero entero, tarifa, coordenadas, polígonos, vigencia y horarios.
- `server/smart-commerce-routing.mjs`: adaptador vial, timeout, caché corta, deduplicación y límite de concurrencia.
- `server/smart-commerce.mjs`: configuración, persistencia, precios, planificación, cotizaciones y consumo.
- `server/smart-commerce-routes.mjs`: APIs públicas, privadas y ADMIN.
- `public/store/smart-commerce-ui.js` y `smart-commerce.css`: ubicación y checkout.
- `public/admin/smart-commerce.html`, `.js`, `.css`: configuración y solicitudes.
- `tests/store-smart-rules.test.js`, `tests/store-smart-commerce.test.js`.
- `scripts/check-store-smart-uat.mjs`: navegador con backend real aislado y proveedores sintéticos.
- Este informe, auditoría y [matriz UAT](FULLTECH-SMART-COMMERCE-UAT.md).

Extendidos: `server/crm-server.mjs`, `server/store-account-routes.mjs`, `server/store-public-routes.mjs`, `public/store/store.js`, `public/store/index.html`, `public/store/sw.js`, `public/admin/index.html`. Hay otros archivos modificados previamente: no deben atribuirse a esta implementación ni descartarse.

## 6. Migraciones y datos

DDL aditivo e idempotente en `createSmartCommerce`, ejecutado solo con feature flag activa, catálogo FULLTECH y adaptador SQL habilitado:

- `fulltech_smart_config_v1`: singleton FULLTECH, versión y documento de configuración.
- `fulltech_checkout_quotes_v1`: ID, propietario, estado, request key, pedido nativo, caducidad y snapshot privado.
- Índices por cuenta/fecha y estado/fecha.

No se altera ni elimina ninguna tabla existente. No se crean saldos o existencias paralelos. Configuración inicial vacía: ninguna ciudad, sucursal o banco operativo se activa automáticamente. JSONL no habilita estas funciones. PostgreSQL usa el adaptador SQL existente, pero **no se ejecutó UAT en PostgreSQL**; no equivale a compatibilidad certificada.

## 7. APIs añadidas o cambiadas

| Método/ruta | Acceso y efecto |
| --- | --- |
| GET `/api/store/commerce/config` | Público; capacidad/flag y cuentas receptoras autorizadas, no credenciales |
| POST `/api/store/commerce/resolve` | Público, rate limit; devuelve zona, no persiste el GPS de navegación |
| GET/POST `/api/store/account/commerce/addresses` | Cliente autenticado; lectura propia y escritura con consentimiento |
| POST `/api/store/account/commerce/quotes` | Cliente, CSRF y rate limit; cotización ligada a su carrito/destino |
| GET `/api/store/account/commerce/quotes/:id` | Solo propietario |
| POST `/api/store/account/commerce/quotes/:id/request` | Solo propietario; solicitud administrativa, sin crear pedido |
| GET/PUT `/api/admin/store/commerce/config` | ADMIN; validación y versión esperada obligatoria al guardar |
| GET `/api/admin/store/commerce/quotes` | ADMIN; últimas 200 cotizaciones/solicitudes |
| GET catálogo/home/categorías/producto con `?zone=ID` | Precio regional público; nunca coordenadas en el query string del storefront |
| POST `/api/store/orders` | Con flag activa exige cotización propia válida; ignora importes y fulfillment alterados por el cliente |

Flag apagada conserva el flujo anterior. Las rutas privadas nuevas llevan `Cache-Control: no-store`; el service worker no debe almacenar APIs de cuenta.

## 8. Pantallas actualizadas

Header: selector voluntario «Usar ubicación» solo con flag activa; guarda la zona en memoria, sin seguimiento ni GPS en localStorage. Catálogo: precio y ciudad de despacho, sin afirmar existencia local. Checkout: destino, GPS o alternativa, confirmación, consentimiento opcional, resumen revalidado, pago y segunda acción explícita para enviar. Se oculta el resumen antiguo para no mostrar dos totales contradictorios. CRM: acceso desde Tiendas a configuración/solicitudes; edición avanzada JSON, no editor cartográfico completo.

El skill Sites se utilizó para conservar el proyecto local, comprobar el render real y no publicar. Se inspeccionaron capturas y se corrigió el contraste de los botones nuevos.

## 9. Proveedores y retiro

Una sucursal puede referenciar un proveedor real existente; las ofertas referencian un producto maestro y un origen, sin duplicar el SKU. Cualquier proveedor externo o oferta que requiera confirmación fuerza revisión. No hay aceptación/rechazo, reintentos, timeout de respuesta comercial, reservas, códigos ni entrega de retiro implementados. Elegir retiro genera revisión y no un permiso de recogida. El flujo de recogidas del repartidor no se reutiliza indebidamente.

## 10. Precio de entrega

Con `d` entero positivo en metros: `max(100, 100 + ceil(max(0,d−1000)/500)×50)` pesos dominicanos, hasta 15000 m inclusive. Más de 15000 m → sin tarifa final y revisión. Se usan centavos enteros para líneas, entrega y total; se rechazan overflow y cantidades no enteras.

Ejemplos probados: 1000→100; 1001→150; 1500→150; 1501→200; 2000→200; 2100→250; 10790→1100; 15000→1500; 15001→no elegible. No se interpola un cargo de 125. Las distancias fraccionarias recibidas del proveedor se redondean hacia arriba antes de aplicar la regla.

## 11. GPS, cobertura y rutas

Solo se solicita GPS al pulsar; timeout de 10 s y alternativa de dirección/coordenadas. Destino del pedido separado del GPS de navegación. Guardado permanente de preferencia condicionado a consentimiento. Precisión GPS >100 m requiere revisión. Polígono habilitado, origen permitido, horario local RD y ruta/capacidad son validaciones distintas. No se usa cercanía en línea recta para cotizar ni se inventan rutas ante errores.

El adaptador OSRM configurable emplea distancia vial en metros, HTTPS sin credenciales en URL, sin redirects, timeout, caché exitosa de 30 s y máximo cuatro rutas concurrentes. Capacidad tiene espera máxima de 3 s y señal de abort; su implementador debe respetarla. El proveedor vial real debe revisarse por privacidad, disponibilidad y cobertura. Los polígonos se validan por coordenadas, cierre y área, **no tienen validación GIS completa de auto-intersecciones**: revisión cartográfica operativa pendiente.

Referencias verificadas: [API oficial OSRM](https://project-osrm.org/docs/v5.24.0/api/), [Geolocation de MDN](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/getCurrentPosition).

## 12. Pago

Se ofrecen intención de transferencia ahora/después si hay banco activo, acuerdo posterior y efectivo solo cuando configuración y capacidad confirman cobro. Se muestra banco/titular/cuenta, nunca credenciales. El pedido queda pendiente de pago: seleccionar transferencia o enviar un valor `paymentStatus: paid` no lo acredita. El módulo contable existente conserva la autoridad. Subida de comprobante y vínculo de verificación específico del nuevo flujo quedan pendientes; no se probó ni efectuó verificación financiera real.

## 13. Integración CRM

La cotización se revalida y reclama antes del pedido; precio y entrega se inyectan desde servidor al motor existente. Se conserva snapshot comercial, dirección/GPS del pedido y clave idempotente. Reintentar el mismo request key devuelve el mismo pedido. Reclamar la misma cotización con dos keys produce un solo pedido en el test concurrente. Una respuesta ambigua debe reintentarse con la misma key. No se creó un pedido paralelo para la solicitud de cotización.

## 14. FULLTECH Delivery

El pedido conserva fee y ubicación en los campos nativos; no se cambia el motor de reparto existente. Se añadió un punto de inyección `storeSmartCommerce.capacityProvider`, no un operador de flota ficticio. Falta conectarlo y validar la creación/seguimiento real del servicio con el contrato existente. No se asignó un courier ni se envió aviso durante las pruebas. La regresión global contiene fallos de notificaciones de delivery, por lo que no se certifica el flujo operativo completo.

## 15. Pruebas ejecutadas

```powershell
npx vitest run tests/store-smart-rules.test.js tests/store-smart-commerce.test.js tests/store-checkout-uat.test.js tests/store-isolation.test.js tests/store-public-api.test.js --reporter=json --outputFile=.tmp/store-smart-targeted.json
npx vitest run --reporter=json --outputFile=.tmp/store-smart-full.json
npx vitest run tests/offline-24h.test.js --reporter=json --outputFile=.tmp/store-smart-offline-recheck.json
$env:PLAYWRIGHT_MODULE='file:///C:/Users/pc/DEV/PROYECTOS/PRODUCTOS/DaleVentas%20POS/.tmp-playwright/node_modules/playwright-core/index.mjs'
node --experimental-sqlite scripts/check-store-smart-uat.mjs
npm run build
```

El script de navegador crea SQLite temporal y usa geografía, cuentas bancarias, capacidad y rutas **sintéticas**, sin llamadas a proveedores externos. La dependencia Playwright puede reemplazarse por una instalación local mediante `PLAYWRIGHT_MODULE`; la ruta mostrada es la utilizada en este equipo.

## 16. Resultados satisfactorios

Selección final: **50/50 tests** en cinco archivos, incluyendo 32 tests nuevos. Cubre tarifa y límites, overflow, GPS/polígono, vigencias, proveedor fallido, flag off/aislamiento, propietario/CSRF, caducidad, carrito manipulado, método de pago, configuración concurrente, múltiples orígenes, proveedor pendiente, direcciones y pedido nativo idempotente.

Navegador: **7/7 viewports** (320, 375, 390, 430, 768, 1024, 1440). En cada uno: producto regional RD$2000 + entrega vial sintética RD$1100 = RD$3100, pedido real en CRM, pago pendiente, carrito vaciado solo tras éxito; GPS denegado → solicitud manual, sin otro pedido y con carrito conservado. Sin page errors ni desbordamiento horizontal. Administración inspeccionada a 390 px. Evidencia: `docs/capturas/smart-commerce/results.json`, `checkout-*.png`, `manual-*.png`, `admin-390.png`.

Build aprobado: 324 archivos. Siete advertencias de contenido de landing ya presentes, no errores de compilación. `node --check` sobre módulos modificados y `git diff --check` aprobados.

## 17. Fallos y regresión global

La suite global **no está verde**. Última ejecución sobre el código final: **2327 tests, 2226 aprobados, 98 fallidos, 3 omitidos; 166 archivos, 28 con fallos** (`.tmp/store-smart-full.json`). No aparecen nombres de assertions fallidas adicionales respecto al baseline local anterior; eso no sustituye una prueba de ausencia de regresiones. El baseline tenía 2290 tests y 99 fallos; una prueba de persistencia de notificaciones que antes fallaba por `fetch failed` pasó en este último intento, lo que evidencia variabilidad y no una corrección realizada aquí.

En el primer pase global (antes de las últimas pruebas nuevas) hubo 2322 tests/99 fallos y apareció además un fallo de ejecución en la prueba de cobro offline; al repetir `offline-24h` aislado pasó esa prueba, quedando 44 aprobadas y dos fallos que también están en el baseline: acceso a `auth` nulo (línea 218) y aislamiento de rechazos históricos (línea 515). En la última ejecución global tampoco reapareció aquel fallo adicional de cobro. No se modificaron esos tests para ocultar fallos. No se afirma que todos los fallos globales sean ajenos al cambio sin una bisect reproducible.

## 18. UAT manual pendiente

Ver [25 escenarios y criterios](FULLTECH-SMART-COMMERCE-UAT.md). Ubicaciones reales de Higüey/La Romana, cobertura vial, dispositivos Android/iOS, GPS con permisos del sistema, múltiples instancias, PostgreSQL, proveedor/courier reales, bancos y usuarios autorizados no se sustituyen por fixtures. Los escenarios de reserva, comprobantes y retiro no están habilitados para prueba de aceptación completa.

## 19. Seguridad e integridad

Precios finales y delivery vienen del servidor; una zona pública no autoriza entrega. SQL parametrizado, propietario en cada consulta privada, ADMIN para configuración, proyecciones públicas explícitas, CSRF existente, límites de body y rate limit. Los logs de auditoría nuevos contienen IDs/acciones, no GPS ni datos bancarios completos. El stock consultado es global y se revalida en el motor actual; no se presenta como reservado por sucursal. No se vuelven pagados pedidos por datos del navegador.

Rate limit y deduplicación de rutas son por proceso; requieren infraestructura compartida antes de escalar. Quote claim y escritura del pedido no comparten una única transacción: se permite recuperar con la misma key, pero falta prueba de crash/reconciliación distribuida. No se certifica anti-sobreventa multi-instancia ni retención/expurgo de GPS y cotizaciones.

## 20. Riesgos restantes

Inventario por ubicación y reservas; separación financiera por proveedor; autorización y consumo atómico de códigos de retiro; mensajería y respuestas; resolución de solicitudes manuales; conciliación de pagos; capacidad/horarios reales; polígonos revisados; PostgreSQL y concurrencia distribuida; privacidad/retención; accesibilidad y dispositivos reales; suite global fallida. Estas limitaciones impiden marcar la misión como terminada.

## 21. Prerrequisitos de producción

No activar automáticamente. Primero resolver los bloqueos anteriores, acordar contratos operativos y pruebas con responsables de tienda/CRM/reparto, respaldar y ensayar migración en staging, completar UAT y corregir regresión global.

Configuración técnica documentada, **no ejecutada en producción**: `FULLTECH_SMART_COMMERCE_ENABLED=true`; `FULLTECH_ROUTING_OSRM_URL=https://<proveedor-autorizado>`; perfil opcional `FULLTECH_ROUTING_PROFILE=driving`; inyección de capacidad real en `startCrmServer`. Sin capacidad confirmada todo reparto queda para revisión aunque exista URL vial. La opción de arranque explícita `storeSmartCommerce.enabled:false` prevalece sobre la variable de entorno.

Dar de alta exclusivamente proveedores/sucursales/coords/polígonos/bancos reales autorizados desde ADMIN; no copiar la configuración UAT. Verificar HTTPS, cookies, CSP, cachés/CDN y nuevo service worker; la ubicación del navegador requiere un contexto seguro en producción. Monitoreo y procedimiento de recuperación de quotes claimed son obligatorios.

## 22. Rollback

Desactivar la flag explícitamente y reiniciar backend controladamente; servir frontend y SW consistentes. Las tablas aditivas se conservan para auditoría, sin `DROP`, reset ni borrado de pedidos. Antes de volver al checkout antiguo, detener nuevas aceptaciones y revisar pedidos/cotizaciones en vuelo: el flujo antiguo vuelve a “entrega por confirmar” y no debe reinterpretar cargos ya aceptados. Recuperar primero cualquier pedido persistido con su request key. No reutilizar stock reservado ficticio ni eliminar snapshots.

Restaurar desde artefacto/back-up probado si una migración o regresión lo requiere, no mediante `git reset --hard` sobre este árbol compartido. Se mantiene la BD temporal de las pruebas para diagnóstico; no es una base operativa ni se publica su contenido.

## 23. Veredicto

**GO solo para evaluación local/staging aislado de las funciones verificadas. NO-GO para producción y para afirmar “sistema completo listo”.** No se hicieron commit, push, deploy, movimientos financieros, asignaciones de reparto ni notificaciones reales. El siguiente hito obligatorio es diseñar y probar la reserva transaccional por ubicación y su contrato con proveedores/retiro, junto con cerrar la regresión global; no basta activar una bandera.

## 24. Continuidad — reservas, proveedores y retiro autorizado

### 24.1 Alcance ejecutado y estado vigente

Se continuó sobre la implementación existente, sin rehacer catálogo, cuenta, carrito, precios, tarifa o libro de pagos. Se leyó este informe antes de modificar código y se ejecutó una suite general de baseline antes de los cambios: **2327 tests, 2226 aprobados, 98 fallidos, 3 omitidos, 28 archivos fallidos**. La comparación es contra este árbol de desarrollo previo a la continuidad, no contra un supuesto commit limpio de producción; el árbol ya contenía cambios sin commit de tareas anteriores.

| Flujo | Estado actual y alcance probado |
| --- | --- |
| Inventario y reservas por origen/sucursal | IMPLEMENTADO Y VERIFICADO en SQLite; reserva atómica, vencimiento, cancelación, liberación, consumo y protección del inventario maestro |
| Confirmación/rechazo del proveedor | IMPLEMENTADO Y VERIFICADO con usuario CRM autenticado, rol SUPPLIER y permisos específicos de sucursal; aceptación distinta del aviso enviado |
| Retiro autorizado | IMPLEMENTADO Y VERIFICADO de checkout a CRM, incluyendo preparación, listo, pago, código privado, entrega única e inventario |
| Notificaciones de WhatsApp | PARCIAL: outbox durable y adaptador inyectable con prueba falsa; proveedor real no conectado ni llamado |
| Timeout y escalación | IMPLEMENTADO Y VERIFICADO al operar/consultar/ejecutar mantenimiento; no se habilitó un scheduler de producción ni un envío automático de escalación |
| Concurrencia PostgreSQL y operación real de sucursales | PENDIENTE DE UAT; no se accedió a una BD PostgreSQL externa |
| Suite general | NO APROBADA; clasificación y repeticiones documentadas debajo y en el informe de baseline |

La funcionalidad comercial sigue desactivada por defecto. Un origen entra al nuevo flujo solo después de que un operador autorizado registre su inventario; los orígenes no configurados conservan el comportamiento anterior y las 50 pruebas originales.

### 24.2 Reservas e inventario: fuente de verdad

Nuevo módulo `server/smart-fulfillment.mjs`, integrado con `smart-commerce`, `store-catalog` y los pedidos nativos. La sucursal se determina desde el origen de despacho del servidor, nunca desde un ID de sucursal propuesto por el comprador.

Procedencias explícitas:

- `local_count`: recuento propio asignado del inventario maestro FULLTECH. La suma asignada no puede superar el maestro. No significa una segunda existencia adicional.
- `supplier_report`: disponibilidad declarada por un tercero. **No admite reserva ni aceptación comercial como stock confirmado.**
- `supplier_confirmed`: disponibilidad físicamente confirmada por el proveedor autorizado. Respalda su compromiso, pero nunca se presenta como stock propio local ni descuenta el maestro propio.

El checkout muestra esta distinción en la cotización. El catálogo conserva su contrato público previo; una etiqueta genérica de disponibilidad de catálogo no reemplaza una reserva validada.

Las operaciones de inventario utilizan transacciones: `BEGIN IMMEDIATE` en SQLite y conexión dedicada + bloqueo del singleton comercial en PostgreSQL. Dentro de la transacción se verifican versión, propiedad, existencias libres y estado; `UPDATE ... WHERE on_hand-held >= cantidad RETURNING ...` evita la reserva con saldo negativo. Las restricciones impiden `held < 0`, `on_hand < 0` y `held > on_hand`. Se revalida el contexto del producto/origen bajo el bloqueo, no solo antes de abrir la transacción.

Los ajustes y ventas nativos del catálogo no pueden consumir stock asignado a sucursales. El consumo del retiro actualiza sucursal, reservas, movimiento único en el maestro y código en la misma transacción; el motor nativo reconoce ese movimiento y no vuelve a descontarlo. Para delivery reservado, el consumo de sucursal se integra en la transacción de venta existente. Cambiar un SKU con historial de sucursal a Phytoemagry queda bloqueado.

Reservas y solicitudes vencen a los **15 minutos** en esta versión; el código dura como máximo **5 minutos**, sin exceder la reserva. Los límites requieren aprobación de negocio antes de producción. El vencimiento se aplica en operaciones, consultas de solicitudes/stock y mantenimiento: no depende de un navegador abierto. No existe un daemon habilitado que notifique por WhatsApp al cumplirse el plazo. La próxima operación recupera las existencias vencidas y persiste la escalación. Vencimiento no equivale a refund ni anulación financiera automática del pedido nativo.

### 24.3 Solicitudes a proveedores y permisos

Cada pedido/origen genera una solicitud única asociada al mismo ID del pedido CRM y a las mismas líneas; no se crea otro pedido comercial. Las sucursales siguen referenciando los registros de `suppliers` existentes. El estado inicial es `pending`. Stock propio contado se reserva al enviar; stock de tercero se reserva al aceptar, después de confirmar su procedencia. Sin suficiente stock confirmado no hay aceptación.

Se añadió el rol **SUPPLIER**, sin permisos generales heredados de AGENT. El backend niega por defecto el resto de `/api/admin` para ese rol, salvo autenticación/cambio de contraseña y las rutas de operaciones comerciales. La concesión por sucursal permite únicamente `inventory`, `confirm`, `prepare` y/o `handover`; administración valida que el usuario exista y esté activo. Revocar permisos afecta a la sesión ya abierta. No se entregan costos, pagos completos ni datos de chats al operador por estas rutas.

Aceptar/rechazar requiere sesión autenticada y permiso de la sucursal correspondiente; no se acepta una respuesta de texto libre de WhatsApp, un “mensaje entregado” ni un parámetro del comprador. Repeticiones no duplican solicitud, reserva, consumo ni auditoría de transición. Rechazo y vencimiento liberan las reservas y crean evento de escalación; no autorizan un pedido alternativo ni un cobro nuevo.

El outbox distingue `pending`, `sending`, `sent`, `unsupported`, `failed` y `unknown`. Solo una acción ADMIN explícita puede solicitar el aviso mediante el adaptador inyectado; no hay credenciales ni envío automático por entorno. La clave del proveedor es estable por solicitud. Un timeout/resultado ambiguo se conserva como `unknown`, sin reintento automático que pueda duplicar el mensaje. `sent` siempre responde `accepted:false`. El único adaptador usado en pruebas devolvió un ID falso; no se conectó WhatsApp real.

### 24.4 Retiro: condiciones obligatorias y consumo

Secuencia: pedido nativo → solicitud → aceptación y reserva → preparación → listo → cobro verificado completo → emisión privada de código → operador autorizado valida y entrega → consumo atómico → conciliación con el pedido CRM.

Para un carrito con varios orígenes, **todos deben estar listos** antes de autorizar el primer código. Cada grupo tiene autorización propia; el pedido CRM solo se completa después del último grupo. Si ya hubo una entrega parcial, la cancelación simple se rechaza y exige un proceso protegido de devolución, no una liberación que reponga mercancía ya entregada.

El código contiene 128 bits aleatorios, se devuelve únicamente al propietario autenticado, no se guarda en claro, no aparece en URLs ni auditoría y expira. Se almacena un hash ligado a la solicitud. Emitir otro invalida el anterior; cinco fallos bloquean esa autorización. El consumo es atómico con el inventario. Repetir la misma clave de handover recupera el mismo resultado sin otra entrega; otra clave no reutiliza el código consumido.

El pago se lee del pedido y del libro existente. Una intención de transferencia, un comprobante, un importe parcial, una entrada pendiente/rechazada o el flag histórico `paid` sin cobros no habilitan este retiro. Se revalida al emitir y al entregar; no se agrega un endpoint de pago del proveedor. La lectura de handover usa la transacción SQL y bloqueo de fila en PostgreSQL. **No se efectuó una operación bancaria real:** las pruebas registran entradas ficticias en SQLite temporal.

Se bloquea marcar entregado desde las rutas manuales del CRM antes del handover autorizado, y se bloquean las ediciones genéricas de líneas/importes/destino de un pedido reservado: debe cancelarse y recotizarse. La cancelación del propietario y de administración reutiliza la transición nativa y libera reservas. Los retornos al cliente/proveedor se proyectan para no filtrar el `order_json` interno ni costos.

### 24.5 Persistencia y nuevas interfaces

Tablas aditivas e idempotentes bajo la flag existente: `fulltech_branch_stock_v1`, `fulltech_fulfillment_v1`, `fulltech_reservations_v1`, `fulltech_branch_grants_v1`, `fulltech_fulfillment_events_v1`, `fulltech_supplier_outbox_v1`, más índices de cuenta/pedido/vencimiento. No se migraron cantidades reales ni se sembraron sucursales operativas. El maestro y los movimientos siguen siendo los existentes.

APIs autenticadas nuevas, todas privadas/no-store:

| API | Función |
| --- | --- |
| GET/PUT `/api/admin/store/commerce/operations/stock` | Consulta autorizada y recuento versionado por origen |
| GET `/api/admin/store/commerce/operations/requests` | Solicitudes visibles por permisos de sucursal |
| PUT `/api/admin/store/commerce/operations/grants` | Conceder/revocar permisos, solo ADMIN |
| POST `/api/admin/store/commerce/operations/requests/:id/{accept,reject,prepare,ready,handover,notify}` | Transiciones protegidas; `notify` solo ADMIN |
| POST `/api/admin/store/commerce/operations/maintenance` | Vencimiento/escalación, solo ADMIN |
| GET `/api/admin/store/commerce/operations/audit` | Eventos, solo ADMIN |
| GET `/api/store/account/commerce/fulfillments` | Estado de los grupos del propietario |
| POST `/api/store/account/commerce/fulfillments/:id/code` | Código solo cuando se cumplen las condiciones |
| POST `/api/store/account/commerce/fulfillments/:id/cancel` | Cancelación del pedido completo por su propietario |

Pantalla de operador: `/admin/fulfillment.html`, con sesión existente o formulario propio de acceso, inventario, solicitudes, preparación, código y permisos. Enlace desde configuración Smart Commerce. Cliente: “Preparación y retiro” dentro de “Mis pedidos”, con actualización manual, código y cancelación. Se mantuvieron las vistas responsive anteriores y el scroll solicitado previamente.

### 24.6 Pruebas y auditoría de integración

**103/103 tests seleccionados**, en ocho archivos: los 50 anteriores, 17 nuevos de fulfillment, 22 de usuarios/asignación y 14 de pagos. Evidencia: `.tmp/store-critical-targeted.json`. Los tests existentes no se deshabilitaron ni se cambiaron assertions para alterar el resultado.

Los 17 tests nuevos cubren: carrera por la última unidad; cancelación/liberación; vencimiento y escalación idempotentes; bloqueo temprano de código y bypass manual; retiro pagado de una sola vez; intento inválido/rotación/caducidad; stock versionado y asignación máxima; permisos/revocación/denegación de chats y datos; proveedor declarado → confirmado → aceptado → retiro sin descontar stock propio; rechazo idempotente; cancelación por propietario sin fuga de costos; configuración y edición bloqueadas; elegibilidad financiera; producto Phyto rechazado; dos orígenes; reinicio con reserva persistente; dos servidores con conexiones separadas a la misma SQLite; delivery nativo consumiendo la reserva una vez.

Navegador Chromium, ejecutado con backend real aislado y proveedores sintéticos:

- Se conservan **7/7 tamaños** anteriores, 320–1440 px: precio regional 2000 + tarifa vial sintética 1100 = 3100, pedido CRM, pago pendiente, GPS denegado y solicitud manual conservando el carrito.
- Se agregan **3/3 recorridos completos** de retiro (320, 390, 1024 px): checkout, solicitud, aceptación/preparación/listo desde pantalla de operador, código bloqueado sin pago, cobro ficticio administrativo, código, handover, inventario y CRM, desaparición del código después del consumo.
- Sin errores JS ni desbordamiento horizontal. Capturas inspeccionadas; se corrigieron el formulario de login que CSS mostraba pese a `hidden`, el contraste/estilo de controles y la colocación del retiro antes del footer.
- Se detectó y corrigió la validación de Origin detrás del proxy local: admite el origen público **configurado** y no confía en `X-Forwarded-Host` para ampliar permisos administrativos.

Evidencia: `docs/capturas/smart-commerce/results.json`, `pickup-customer-*.png`, `pickup-operator-*.png`, capturas anteriores y `scripts/check-store-smart-uat.mjs`. El script cierra sus servidores y navegador al terminar. Build: **327 archivos**, aprobado con las mismas siete advertencias de contenido; comprobaciones de sintaxis y `git diff --check` aprobadas.

Comandos reproducibles añadidos a los de la sección 15:

```powershell
npx vitest run tests/store-fulfillment.test.js tests/store-smart-rules.test.js tests/store-smart-commerce.test.js tests/store-checkout-uat.test.js tests/store-isolation.test.js tests/store-public-api.test.js tests/auth-users-assignment.test.js tests/order-payments.test.js --reporter=json --outputFile=.tmp/store-critical-targeted.json
npx vitest run --reporter=json --outputFile=.tmp/store-critical-full.json
node scripts/audit-store-critical-tests.mjs
```

La tarifa exacta no se modificó: los 23 tests de reglas conservan RD$100 hasta 1000 m, RD$50 por cada 500 m o fracción adicional y máximo inclusivo de 15000 m. Precios regionales, GPS alternativo, caducidad/revalidación de quotes, pedido nativo, pago pendiente y separación de Phyto siguen dentro de las pruebas preservadas.

### 24.7 Investigación de los 98 fallos y correcciones propias

Ver [auditoría de baseline y fallos](FULLTECH-SMART-COMMERCE-TEST-BASELINE.md) y `.tmp/store-critical-failures.json`, generado sin filtrar pruebas. El baseline de 98 fallos se obtuvo antes de cambiar código. Se repitieron además cuatro archivos problemáticos: 57 tests, 49 pasan y 8 fallan; los 8 fallos persistentes ya estaban en el baseline.

Las suites completas fluctúan entre 98 y 99 fallos por pruebas de notificaciones/fetch y descarga local APK. Las incidencias adicionales se reejecutaron de forma aislada: el test de descartes masivos de notificaciones pasó en la repetición, y el de descarga APK pasó en su repetición específica. Esto permite clasificarlos como sensibles a ejecución/entorno, **no certificar su causa raíz como solucionada**. No se retiraron ni se aumentaron artificialmente timeouts para ocultarlos. El resultado cuantitativo de la última suite completa se registra al cierre de este informe.

Los problemas de privacidad de AGENT reproducen un contrato real de permisos distinto al esperado por los tests y siguen bloqueando producción. No se “corrigieron” cambiando el rol de usuarios existentes. El nuevo SUPPLIER tiene denegación por defecto y pruebas independientes de aislamiento. Los problemas de UI de panel, conversaciones, POS y notificaciones no se atribuyen automáticamente al nuevo fulfillment: fueron reproducidos antes de la continuidad y no forman parte de una supuesta suite aprobada.

Correcciones verificadas durante esta implementación: whitelist de alta de usuario que convertía SUPPLIER a AGENT; aislamiento por instancia del rate limiter de cuentas (mantiene límite de 20 por IP/acción, no lo desactiva); Origin de proxy configurado; controles de edición/entrega genéricos; proyección sin costos al cancelar/conciliar; invalidación del checkout y request key nuevo tras error definitivo de reserva; comprobación adicional para que una entrada bancaria rechazada no habilite retiro aun si un resumen histórico la clasifica indebidamente. No se reescribió el libro de pagos para darlo por resuelto: su semántica de entradas rechazadas requiere auditoría financiera específica.

### 24.8 Riesgos, UAT manual y límites restantes

**Todavía NO-GO para producción**, aunque los tres núcleos funcionales estén implementados y pasen las pruebas locales. Pendientes obligatorios:

1. PostgreSQL real aislado: migración, bloqueos, deadlocks, rollback y múltiples procesos. Las pruebas de dos instancias efectuadas usan SQLite, no equivalen a certificación PostgreSQL.
2. Fallo de proceso exactamente entre consumo SQL y actualización final del pedido CRM. El código consumido y el movimiento quedan persistidos y la misma clave permite reintentar la conciliación, pero falta fault-injection automatizado para todos esos puntos y un reconciliador operativo independiente. Nunca repetir físicamente una entrega por un error de respuesta.
3. Outbox real de WhatsApp: plantillas autorizadas, canal/credenciales de sandbox, contrato de idempotencia, entrega fallida y conciliación de `sending/unknown` tras crash. No activar reintentos automáticos sin ese contrato.
4. Aprobación de ventanas 15 min/5 min, cobro, vencimiento tras pago, rechazo y entrega parcial. Reembolso/devolución, liquidación multi-proveedor y propuesta/aceptación interciudad no se implementaron en esta continuidad.
5. Enlazar mantenimiento/escalación a un job operativo controlado. Hoy se aplica en consultas/acciones y endpoint ADMIN; no hay notificación puntual garantizada sin actividad.
6. Alta real de sucursales, conciliación del maestro con existencias físicas y pedidos antiguos pendientes, usuarios SUPPLIER y permisos mínimos. Los IDs y recuentos de fixtures no deben copiarse a producción.
7. Android/iOS reales, red lenta/perdida durante handover, captura/rotación del código, lector en mostrador, negativa de GPS, accesibilidad y revisión humana de los tres tamaños nuevos. Ningún screenshot sustituye UAT de negocio.
8. Cerrar los defectos de privacidad, notificaciones, panel/CRM y semántica financiera de la suite general. No se declara que esos defectos sean inocuos por ser anteriores.

### 24.9 Rollback actualizado

No basta apagar la flag si hay reservas activas: el inventario maestro incluye unidades asignadas a sucursales. **No volver a un binario sin protección de sucursales** mientras existan asignaciones o retiros consumidos sin conciliar. En staging, detener nuevas aceptaciones, exportar/respaldar config, stock, reservas, solicitudes, outbox y eventos; conciliar movimientos nativos y pedidos primero. Resolver reservas/pagos/entregas parciales con operadores autorizados, liberar las reservas no consumidas y desasignar físicamente los pools mediante recuentos versionados cuando corresponda. No restituir unidades ya entregadas al liberar una reserva.

Conservar las tablas y auditoría, revocar grants/códigos cuando se retire el piloto, no borrar movimientos ni pedidos, y mantener inventario/protección hasta completar la reconciliación. Revertir artefactos de frontend/SW coherentemente. El rol SUPPLIER no debe quedar reinterpretado como AGENT en una versión anterior: inactivar/revocar esas sesiones y cuentas antes de un rollback de usuarios. No se ejecutó rollback destructivo ni se eliminaron datos del usuario.

### 24.10 Veredicto vigente

**GO para seguir UAT en el desarrollo aislado de los flujos implementados. NO-GO para habilitación de producción.** No se desplegó, no se activó una flag productiva, no se accedió a bases de producción y no se enviaron WhatsApp ni se hicieron pagos reales. El próximo hito es UAT operativo y fault-injection/PostgreSQL, junto con resolver los defectos generales; no recrear los tres flujos desde cero.

### 24.11 Cierre cuantitativo de la continuidad

Última suite completa sobre el backend final: **2344 tests, 2242 aprobados, 99 fallidos, 3 omitidos; 167 archivos, 28 con fallos**. Comparación con baseline: los98 fallos anteriores persisten y se añade la prueba intermitente de descartes masivos de `notifications-user-persistence.test.js`. Ese caso pasó en la repetición aislada de los cuatro archivos, y ya había oscilado en ejecuciones de la entrega anterior; se mantiene registrado como fallo sensible a ejecución/entorno, no como resuelto ni excluido del conteo. El fallo transitorio de descarga APK observado en otro pase no aparece en el último y también pasó al repetirse específicamente. No se identificó una nueva regresión persistente de los tres flujos en las pruebas ejecutadas.

Selección final: **103/103 aprobados**, incluidos los50 originales y los17 nuevos de fulfillment. Navegador: **7 recorridos responsive anteriores + 3 recorridos completos de retiro** aprobados; build327 archivos aprobado. Los últimos ajustes visuales del frontend se verifican con navegador y compilación, no se presentan como una corrección de los99 fallos globales. La evidencia cuantitativa queda en los JSON indicados; no se declara la suite general aprobada.

### 24.12 Archivos de esta continuidad

Nuevos: `server/smart-fulfillment.mjs`; `public/admin/fulfillment.html` y `.js`; `public/store/pickup-orders.js`; `tests/store-fulfillment.test.js`; `scripts/audit-store-critical-tests.mjs`; `docs/FULLTECH-SMART-COMMERCE-TEST-BASELINE.md`.

Extendidos: `server/smart-commerce.mjs`, `server/smart-commerce-routes.mjs`, `server/crm-server.mjs`, `server/store-catalog.mjs`, `server/store-account-routes.mjs`, `server/users.mjs`; `public/admin/smart-commerce.html` y `.css`; `public/store/store.js`, `smart-commerce-ui.js`, `smart-commerce.css`, `index.html`, `sw.js`; `scripts/check-store-smart-uat.mjs`; este informe y la matriz UAT existente. Las capturas/resultados son artefactos de QA local. Los demás cambios iniciales del árbol compartido se conservan y no se atribuyen a esta continuidad.

## 25. Cierre vigente: PostgreSQL real, recuperación y UAT — 24/10/2026

Informe detallado en español: [validación PostgreSQL, recuperación y UAT](FULLTECH-SMART-COMMERCE-POSTGRES-UAT.md). Esta sección actualiza los pendientes históricos de la sección 24; no borra ni sustituye su evidencia.

### 25.1 Resultado verificable

| Comprobación | Resultado final |
|---|---|
| PostgreSQL 17.9 real, clúster efímero positivamente identificado | **29/29 aprobadas** |
| Selección dirigida, incluidos los 50 originales | **103/103 aprobados**, sin omisiones |
| Suite general | **2344 total: 2244 aprobados, 97 fallidos, 3 omitidos** |
| Archivos de la suite general | 167; 27 con fallos |
| Chromium responsive | 7 tamaños anteriores + 3 retiros completos, sin errores JS/overflow |
| Build | 327 archivos, aprobado; siete advertencias previas de contenido |
| `git diff --check` | Aprobado |

Evidencia local: `.tmp/store-postgres-uat.json`, `.tmp/store-final-validation-targeted.json`, `.tmp/store-final-validation-full.json`, `.tmp/store-final-validation-failures.json` y `docs/capturas/smart-commerce/results.json`. Los comandos exactos, identidad SQL, límites y archivos intervenidos se detallan en el informe enlazado.

### 25.2 Correcciones y recuperación

Se validaron constraints/FK PostgreSQL, sesiones concurrentes, reservas/liberación, códigos de un solo uso y aislamiento. Se corrigieron descarte de conexiones PostgreSQL rotas y captura de su evento de error durante el préstamo: una repetición había terminado Node, por lo que no se atribuyó ese defecto al entorno. La repetición final comprueba rollback y reintento correcto. Se conservan las FK aditivas validadas y la lectura fresca en comprobaciones críticas del catálogo.

Se añadieron checkpoints programáticos UAT, dos cortes abruptos de procesos API hijos (dentro de la transacción y tras persistir la reserva), reinicios después de crear pedido y después de consumir retiro, y fallo real de sesión SQL. Se agregó conciliación ADMIN de retiros consumidos cuyo pedido nativo no quedó finalizado. El outbox ahora vence reclamos `sending` a `unknown` con auditoría; no reenvía automáticamente ni confunde mensaje enviado con aceptación. También se corrige lectura de estado anterior al barrido de vencimientos.

Las pruebas del ciclo de notificaciones usan adaptador simulado, excepción y reinicio del servicio: no certifican un worker WhatsApp externo ni su entrega real. Mantenimiento/conciliación siguen requiriendo un job operativo supervisado. Ninguna prueba produjo un pago o cargo bancario real.

### 25.3 UAT y tarifa

Escenarios A–G automatizados: delivery con precio regional RD$2000 + tarifa RD$1100 = RD$3100 y pedido CRM; proveedor/stock confirmado/pago verificado/retiro; rechazo; dos orígenes con cotización manual; interciudad La Romana/Higüey con producto visible y sin tarifa local inventada; dirección manual sin GPS; transferencia pendiente hasta verificar. Delivery conserva la política nativa de entrega con saldo pendiente; no declara pago por una entrega. Las condiciones comerciales de esa política requieren aprobación.

Se comprueban 1000→100, 1001→150, 1500→150, 1501→200, 10790→1100, 15000→1500 y 15001 m→no disponible. Polígono y máximo de distancia se validan separadamente. Timeout de AbortSignal real con proveedor inyectado: sin distancia ni tarifa fabricadas. Las rutas/geografías de UAT son sintéticas, no acreditan un proveedor vial comercial ni cobertura real. **No hubo UAT manual con operador humano.**

### 25.4 Baseline e intermitencia: no se ocultan fallos

Baseline de esta fase: **2344/2243 aprobados/98 fallidos/3 omitidos**, capturado antes de modificar código. Cierre: **2344/2244/97/3**. Coinciden **96 fallos anteriores**; aparecen aprobadas dos assertions antes fallidas (HOY «Seguimientos de hoy» y filtro combinado etapa+fecha de inbox). Como no se corrigieron esos módulos, no se cuentan como dos arreglos: son variación de ejecución/contrato pendiente de diagnóstico.

El fallo adicional es el descarte masivo de notificaciones. Se capturó dos veces **`ECONNRESET: read ECONNRESET`** en GET de notificaciones durante ejecuciones generales; pasa aislado. El ensayo controlado de 5005 marcas y bloqueo de seis segundos, con/sin cesión de I/O, no lo reprodujo. Se conoce el error de transporte, **no la causa raíz definitiva**. No se añadieron reintentos, skips ni timeouts mayores; el test solo incorpora instrumentación optativa y vuelve a lanzar el error original. No se identificó una nueva regresión persistente en los tres flujos, pero la suite general sigue fallando y no se certifica como inocua.

### 25.5 Veredicto y siguientes condiciones

**GO para seguir pruebas en desarrollo aislado. NO-GO para producción o declaración de release candidate seguro.** PostgreSQL y recuperación ya tienen evidencia real adicional; quedan privacidad AGENT y otros defectos generales, causa raíz de la conexión intermitente, semántica financiera histórica, revisión humana de reglas/roles, pruebas de dispositivos y redes reales, proveedor vial, contrato sandbox de notificación/idempotencia y job supervisado de mantenimiento/conciliación. No se desplegó ni se habilitaron flags productivas.

Rollback conserva la protección de inventario y auditoría: detener entradas, respaldar, conciliar retiros y pedidos, liberar solo reservas no consumidas, resolver `unknown` sin reenvío ciego y revocar sesiones incompatibles antes de volver de versión. No borrar tablas o movimientos para superar FK ni volver a un binario sin protección de stock con reservas activas. El clúster UAT final quedó detenido; se conservaron sus datos temporales de diagnóstico.
