# Auditoría y propuesta UAT — logística multiempresa FULLTECH

Fecha: 24-10-2026. Alcance exclusivo: worktree `integracion/smart-commerce-delivery` y datos UAT temporales. Sin escritura en producción, despliegue, push ni merge.

## Estado comprobado antes de implementar

| Dominio | Aislamiento actual | Riesgo |
| --- | --- | --- |
| Productos | `store-catalog.mjs` filtra el escaparate por `store` del servidor; `FULLTECH_STORE` valida contra sus productos publicados. | Un producto no legacy sin `store` explícito cae por defecto en `fulltech`; falta un registro extensible de empresas. |
| Categorías | Clave compuesta por tienda y nombre para nuevas categorías; reparación conservadora de algunas legacy. | Las categorías históricas sin dueño pueden quedar ambiguas; no son una frontera para otros datos. |
| Clientes | Cuentas web FULLTECH en `fulltech_customer_accounts_v1`, separadas de sesión CRM. | La ficha CRM se comparte; `ordersForCustomer` y la prueba de vínculo por número de pedido no filtran empresa. |
| Pedidos | Los pedidos públicos FULLTECH llevan `origin: FULLTECH_STORE`; la app courier comprueba asignación por usuario/contacto. | No hay `company_id` obligatorio; pedidos manuales/históricos ambiguos y la API courier no valida una autorización empresarial independiente. |
| Repartidores | `courier_accounts` guarda un único `company_id`; el backend aplica `PHYTO_CRM_COMPANY_ID ?? 'phytoemagry'`. | No soporta una persona autorizada para varias empresas. Aceptar `company_id` del alta sin validar contra un registro permite etiquetas arbitrarias. |
| Pagos | `order-payments.mjs` guarda cobros en el pedido, con verificación para transferencias. | El bloque de pago y sus operaciones no están particionados por empresa; el id del pedido por sí solo no expresa jurisdicción. |
| Custodia | Libro append-only `delivery_cash_ledger`, claves idempotentes y resumen por `courier_account_id`. | Cargos y rendiciones carecen de empresa; un repartidor multiempresa mezclaría efectivo de negocios distintos. La conciliación también agrega globalmente. |
| App Android | Token por repartidor y caché local por `courierId`. | No ofrece selección de empresa ni separa la caché de un mismo repartidor por empresa. |

Baseline UAT previo: `courier-access`, `delivery-cash` y `store-isolation`, **29/29 pruebas**. El backend de producción responde en `phytoemagryrd.lat` para courier; el dominio FULLTECH carece de esa ruta. Ambas instancias actuales usan la misma base `phytoemagry`; en producción hay cero cuentas courier y cero usuarios DELIVERY. Este dato se obtuvo de forma solo lectura y **no se usa para escribir ni migrar producción**.

## Arquitectura objetivo

Un solo servicio logístico y una base compartida, con identificadores estables de empresa. `phytoemagry` conserva su significado histórico; `fulltech` representa FULLTECH Store. El diseño de registro y concesiones admite nuevas empresas sin crear otra base ni duplicar el backend.

1. Registrar empresas activas y autorizaciones `courier_id + company_id` en tablas/colecciones aditivas. Una cuenta puede pertenecer a varias empresas; sin concesión activa no hay lectura ni acción. Las cuentas legacy de Phyto mantienen acceso solo a Phyto hasta que se migren explícitamente. Revocar una concesión debe invalidar sesiones/caché o revalidarse en cada petición.
2. Estampar `company_id` fiable al crear cada pedido. FULLTECH Store siempre lo fija el servidor en `fulltech`; los flujos Phyto históricos se preservan mediante evidencia verificable. Pedidos sin dueño demostrable quedan en cuarentena, nunca se adjudican a otra empresa por defecto.
3. La API courier deriva identidad del token y selecciona una empresa **entre concesiones activas**. Si hay varias, exige selección explícita; no acepta que una cabecera o parámetro amplíe permisos. Lista, detalle, transiciones, perfil, ubicación, ganancias y custodia deben usar la misma frontera.
4. Todo cargo, ajuste y rendición lleva `company_id` y conserva orden de origen. El saldo es por pareja `(courier_id, company_id)`; una rendición de FULLTECH no cancela deuda de Phyto. Los movimientos legacy se clasifican por su pedido; los ambiguos se reportan para revisión sin reescritura.
5. La app selecciona empresa después del login, envía el contexto validado, y particiona su caché por `(courier_id, company_id)`. La UI nunca suma saldos de empresas distintas como si fuesen dinero de una sola.
6. Administración ordinaria se limita a sus empresas; solo superadministración central puede ver un consolidado claramente etiquetado. Cualquier corrección histórica requiere proceso explícito y auditoría, no una actualización masiva silenciosa.

## Pruebas de aceptación

- Dos empresas y un mismo repartidor con concesiones separadas: ve solo pedidos de la empresa seleccionada; otra empresa o una empresa revocada responde 403/404 sin filtrar PII.
- Pedidos, clientes, pagos y productos de una empresa no aparecen en respuestas de la otra; pedidos sin dueño verificable no salen a la app.
- Cobrar en A y rendir en B no reduce el saldo de A; idempotencia y libro append-only siguen intactos. Reconciliación histórica no altera filas.
- Phyto legacy conserva sus pedidos y sesiones autorizadas. Catálogo FULLTECH/Phyto y los 29 tests baseline siguen pasando.
- SQLite temporal y PostgreSQL UAT identificado positivamente; nunca usar el host/DB de producción en el arnés.

## Implementación parcial en UAT (24-10-2026)

- `server/logistics-tenancy.mjs`: clasifica pedidos FULLTECH por origen/empresa y pedidos históricos Phyto por variantes de cápsulas; los ambiguos quedan fuera de la app. Resuelve las concesiones activas del repartidor y exige seleccionar empresa si tiene varias. La compatibilidad de cuentas Phyto anteriores se mantiene cuando aún no poseen fila de concesión.
- `courier_company_grants` agrega la relación muchos-a-muchos sin cambiar IDs ni borrar filas. El alta crea una concesión inicial; la ruta administrativa `POST /api/admin/couriers/:id/companies` la añade o revoca, exige `admin.full`, invalida tokens y audita. No se crean cuentas en producción.
- Las rutas `/api/courier/orders`, detalle, transiciones, ubicación y custodia filtran por empresa concedida y por asignación. `/me` y login enumeran las empresas disponibles. Las posiciones GPS nuevas tienen clave `(repartidor, empresa)`; las posiciones históricas sin dueño quedan fuera de las vistas empresariales. Los pedidos nuevos del checkout FULLTECH llevan `company_id: fulltech`; los pedidos nuevos no FULLTECH solo reciben `company_id` si el snapshot permite deducir Phyto.
- Los cargos nuevos llevan empresa; la rendición exige una empresa autorizada y su saldo propio. Los cargos legacy ligados a pedidos se clasifican en lectura; rendiciones legacy sin evidencia quedan excluidas del saldo empresarial y requieren conciliación manual. Las vistas administrativas de custodia, movimientos, posición y cuentas de repartidor limitan el acceso FULLTECH a `admin.full`. La lista de pedidos de la cuenta web FULLTECH filtra por origen antes de vincular o mostrar pedidos CRM.
- La app Android se modificó **solo** en un worktree UAT separado: selector de empresa tras login, cabecera de empresa en sus peticiones, sesión y caché por pareja `(repartidor, empresa)`. La rama `master` de la app conserva sus cambios previos intactos.

Pruebas dirigidas en SQLite temporal: **52/52** (4 archivos de OAuth, cuentas, acceso courier y custodia), más **41/41** (acceso, GPS y custodia). El test anterior que permitía `otra-empresa` para después negar el login cambió de significado: ahora verifica rechazo 422 al crear una identidad no registrada. Se agregaron pruebas HTTP para repartidor multiempresa, aislamiento de lista/detalle, revocación, cargos y rendiciones independientes, y cuarentena de pedido/movimiento ambiguo. Los tests de cuenta y OAuth ahora comprueban que un pedido Phyto no autoriza el vínculo FULLTECH. `npm run build` pasó. En el worktree Android, `flutter analyze` pasó y `flutter test` terminó **87/87** (incluye cabecera empresarial y caché particionada).

Comparación reproducible de suite general sobre el commit UAT original `d30b2ac`: **104 fallas, 2394 aprobadas, 3 omitidas y 1 error** en 2501 pruebas/180 archivos. La corrida final del candidato: **100 fallas, 2400 aprobadas, 3 omitidas y 1 error** en 2503 pruebas/180 archivos. Los 100 casos fallidos del candidato también fallaron en el baseline; **ninguna falla nueva persistió**. Cuatro fallas del baseline no se repitieron (contact-number, dos de notificaciones y offline-24h), así que hay variación entre corridas. Una corrida intermedia tuvo dos fallas causadas por fixtures OAuth que trataban pedidos Phyto como FULLTECH; se corrigieron con casos positivos/negativos sin relajar la frontera. Los fallos generales restantes incluyen esperas del panel/chat y son anteriores a este corte o dependen del entorno; no se ocultaron ni deshabilitaron. Logs en `C:\Users\pc\DEV\UAT\fulltech-tenancy-{baseline,final}-tests.log`.

UAT manual pendiente: entrar con un repartidor autorizado a ambas empresas en Android; elegir cada una, comprobar lista, PII, mapa, movimientos y saldo, cambiar de red/offline, revocar una autorización y verificar que la sesión antigua deje de funcionar. En PostgreSQL UAT: ensayar alta/revocación, pedidos históricos ambiguos, libro de efectivo, idempotencia y reversión con respaldo restaurable. Ningún ensayo debe usar credenciales, mensajes WhatsApp ni dinero reales.

## Riesgos y pendientes que bloquean producción

1. **Administración CRM y pagos:** `admin.full` es un operador central; otras rutas de CRM, pagos, clientes y conciliación aún necesitan permiso empresarial por recurso y pruebas de acceso cruzado. `delivery.manage` sigue siendo global para varias vistas. Por ello no se puede afirmar que *ninguna API* exponga otra empresa.
2. **Catálogo histórico:** los productos no legacy sin `store` explícito se interpretan como FULLTECH en el código existente. Cambiarlo sin inventario histórico/migración verificada puede ocultar productos. Requiere clasificación de registros y un rechazo cerrado para futuros registros ambiguos.
3. **Registro de empresas:** la primera fase valida dos identidades fijas (`phytoemagry`, `fulltech`). Antes de incorporar una tercera tienda debe existir registro persistente, configuración, permisos administrativos y migración aditiva probada.
4. **Custodia histórica:** movimientos sin pedido o empresa no se adjudican automáticamente. Deben auditarse y resolverse con asiento compensatorio trazable; la reconciliación global actual todavía no está agrupada por empresa.
5. **App:** falta UAT visual y funcional en emulador/Android real con dos empresas, cambio de empresa, recuperación de sesión offline y rechazo tras revocación. No se probó contra producción ni se generó APK de producción.
6. **PostgreSQL:** falta ensayo de migración y concurrencia en un clúster PostgreSQL UAT identificado, con copia depurada y restauración ensayada. Las pruebas actuales son SQLite temporal.

## Veredicto y reversión

**NO-GO.** El corte UAT reduce filtraciones de la app de reparto y separa su custodia, pero la autorización de todas las APIs empresariales y la conciliación aún no están completas. Mantener cerrado el lanzamiento multiempresa. Si hay que revertir este corte, restaurar el código del worktree UAT; las colecciones nuevas son aditivas. No reescribir ni borrar movimientos históricos de efectivo ni pedidos. Una activación futura requiere inventario de filas ambiguas, migración reversible, pruebas PostgreSQL, UAT humana y aprobación explícita.

## Continuación UAT: registro, permisos, finanzas y Android

Esta sección actualiza los pendientes de la fase anterior. Todo se ejecutó en los dos worktrees UAT; no se consultó ni modificó producción en esta fase. No hubo despliegue, push, merge, WhatsApp real, dinero real ni cuenta real. Los datos creados por las pruebas fueron sintéticos.

### Cambios implementados

- Se añadió `logistics_companies`, registro persistente que admite identificadores válidos nuevos mediante una ruta de administración central. `phytoemagry` y `fulltech` son semillas idempotentes, no una lista cerrada de autorización. Las concesiones de repartidor requieren una empresa activa del registro.
- Se añadió `courier_applications`: Flutter lee la lista de empresas y permite solicitar ingreso sin PIN ni token. La revisión administrativa aprueba o rechaza **la empresa solicitada** y deja auditoría. Aprobar la solicitud no crea cuenta, no entrega credenciales y no concede acceso operativo; el alta operativa sigue siendo un acto administrativo separado. Repetir una solicitud ya revisada devuelve acuse sin reabrirla; falta definir un procedimiento de nueva postulación.
- Los pedidos nuevos estampan empresa cuando el servidor puede probarla. Se agregó bloqueo por ID para pedidos FULLTECH conocidos ante sesiones CRM ordinarias de Phyto; asignar un repartidor interno o externo a una empresa ajena exige cuenta activa y concesión. También se filtran las sesiones de seguimiento conocidas de otra empresa. La app selecciona solo entre empresas devueltas por el servidor; cambiar su cabecera a una tercera empresa recibe 403. Caché y última posición de la app se particionan por repartidor y empresa.
- La rendición nueva se escribe dentro de una transacción por pareja repartidor–empresa, con bloqueo asesor en PostgreSQL y `BEGIN IMMEDIATE` en SQLite. Un intento simultáneo que excede el saldo se rechaza; un reintento con la misma clave es idempotente. La conciliación de lectura agrupa por empresa y reporta movimientos sin dueño demostrable como `unresolved`, sin reescribirlos.
- Android UAT exige backend HTTPS explícito y datos demo desactivados. La APK debug del emulador usó un certificado local de pruebas confiado únicamente para `https://10.0.2.2:8443` en modo debug UAT; la clave privada quedó fuera de los repositorios. El servidor HTTPS local usa SQLite temporal, tiene WhatsApp deshabilitado y no usa ningún URL productivo. La build release no añade esa raíz local. Certificado de pruebas de corta duración: regenerarlo antes de un ensayo futuro.

### Evidencia ejecutada

| Prueba | Resultado |
| --- | --- |
| SQLite dirigida: courier, solicitud, custodia y conciliación | 67/67 aprobadas tras distinguir pedido Phyto probado y pedido ambiguo rechazado, y añadir una denegación CRM por ID para pedido FULLTECH. |
| PostgreSQL 17 UAT identificado | 6/6 verificaciones: respaldo `pg_dump -Fc` anterior al arranque, registro aditivo, solicitud sin acceso, pedidos de dos empresas para un repartidor, rendición concurrente/idempotente, restauración del respaldo en otra base aislada. Un rechazo concurrente no dejó asiento adicional. Se trató de una base sintética recién creada; falta repetir con una copia histórica depurada antes de cualquier migración real. |
| Flutter | `flutter analyze` sin errores; 89/89 tests después de añadir el requisito HTTPS UAT. |
| Android 15, emulador `emulator-5554` | APK debug construida e instalada. La app mostró `https://10.0.2.2:8443` y el formulario de ingreso con la empresa cargada por el backend HTTPS; no se envió solicitud. Una primera prueba falló al confiar en el certificado solo por Android Network Security Config: Dart `HttpClient` lo rechazó. Se corrigió añadiendo la raíz local al contexto TLS de Dart exclusivamente para debug UAT y se repitió la prueba sin error TLS nuevo. |
| Calidad estática | `node --check` y `git diff --check` sin errores; solo avisos de normalización CRLF. |
| Build web/backend | `npm run build` completó; el generador señaló contenido comercial Phyto pendiente ajeno a esta fase. |

Logs UAT: `C:\Users\pc\DEV\UAT\fulltech-tenancy-phase2-tests.log`, `C:\Users\pc\DEV\UAT\fulltech-tenancy-phase2-verified-tests.log`, `C:\Users\pc\DEV\UAT\fulltech-delivery-multitenant-phase2-flutter-final.log` y `C:\Users\pc\DEV\UAT\fulltech-delivery-android-build-final.log`. Captura local: `C:\Users\pc\DEV\UAT\fulltech-android-uat.png`.

La primera corrida general de esta fase dio **102 fallas, 2401 aprobadas, 3 omitidas y 1 error** (2506 pruebas). Frente a las 100 fallas de la fase anterior, `delivery-courier` falló por un fixture sin empresa y se reparó ampliando la prueba con rechazo explícito de ambiguos. La **última corrida verificada** dio **101 fallas, 2404 aprobadas, 3 omitidas** (2508 pruebas, 181 archivos). De las 101 fallas, **100 coinciden exactamente** con el baseline original `d30b2ac` (104 fallas); la adicional es `panel-sales-uat > desde el pedido se pasa a un delivery de verdad`, que espera una fila del panel. La prueba aislada también agota su espera de 5 segundos, pero depende de pedidos creados por otras pruebas del mismo archivo; por ello no se atribuye a una causa nueva ni se declara resuelta. Los 100 fallos compartidos se concentran en panel y chat (principalmente carga, selectores y timeouts), notificaciones/operaciones, y offline; el log completo conserva los nombres y trazas. No se deshabilitó ninguna prueba ni se aumentó su tiempo de espera para mejorar las cifras.

### Brechas observadas antes de resolver las políticas

Los puntos 1 y 2 reflejan el estado anterior; las decisiones autorizadas y su implementación UAT se documentan al final de este reporte.

1. **CRM histórico:** `/api/admin/data` todavía incluye fichas de clientes y conversaciones globales para roles no centrales. Se bloquearon pedidos con propietario FULLTECH conocido, pero no se puede afirmar aislamiento total. Se solicitó decisión sobre los registros históricos sin empresa verificable: cuarentena solo para superadministración o compatibilidad Phyto heredada. No se aplicó una atribución automática.
2. **Custodia heredada:** las rendiciones antiguas sin pedido ni empresa no se imputaron. La suma empresarial actual puede diferir del efectivo histórico real hasta conciliación manual. Se solicitó decisión sobre bloquear nuevas rendiciones del repartidor afectado o permitirlas con revisión. No se implementó una política irreversible por su cuenta.
3. **Superadministración central:** `admin.full` conserva acceso global previsto; faltan permisos de oficina explícitos por empresa para permitir que administradores delegados operen FULLTECH sin acceso a Phyto. Rutas globales como fichas CRM, eventos y algunos reportes deben auditarse por recurso antes de habilitar esos roles.
4. **Android UAT funcional:** falta un ensayo humano completo con una cuenta sintética autorizada a dos empresas en un backend HTTPS de pruebas persistente: login, pedidos, GPS, red desconectada, revocación y rendición. La prueba del emulador llegó al formulario por HTTPS; no efectuó entrega ni cobro.
5. **Finanzas:** falta una conciliación histórica aprobada por una persona responsable, con comprobantes y asientos compensatorios donde proceda. No hay evidencia para declarar balances iniciales reconciliados.

**Veredicto actualizado: NO-GO.** La separación técnica de la app y el libro nuevo mejoró, pero el CRM histórico y la custodia ambigua todavía pueden mezclar contexto o saldos. No activar ni migrar producción. Rollback UAT: detener la app y el servidor local; restaurar el código del worktree y, si hiciera falta, el respaldo pre-migración probado. Las colecciones nuevas son aditivas y ningún asiento histórico fue modificado o borrado.

## Decisiones de titularidad y conciliación aplicadas en UAT

El usuario autorizó explícitamente: **(a)** poner en cuarentena los clientes y conversaciones sin empresa demostrable hasta revisión y **(b)** bloquear nuevas rendiciones de un repartidor con movimientos históricos de custodia sin empresa verificable hasta conciliación manual.

- `crmCompanyEvidence` combina etiquetas explícitas y pedidos vinculados. Si un cliente figura en pedidos de dos empresas, o la etiqueta contradice el pedido, no lo atribuye automáticamente. Una conversación no hereda la empresa solo por compartir cliente: necesita vínculo directo con pedido o etiqueta propia. La propiedad sin evidencia se devuelve `null`.
- Las listas `/api/admin/data`, `/customers`, `/conversations`, `/followups`, `/locations` y `/scheduled` filtran para roles no centrales; las rutas por ID de cliente y conversación devuelven 404 para la cuarentena. Los contadores de conversaciones se calculan sobre filas visibles. La superadministración central conserva la vista íntegra para investigar. Los webhooks firmados del canal legado Phyto etiquetan filas aún sin dueño; una firma ausente no sirve de prueba y una etiqueta ajena no se sobrescribe. No se ejecutó una reclasificación masiva histórica.
- `recordRemittanceAtomic` inspecciona el libro entero **dentro** del bloqueo transaccional. Si el repartidor tiene un movimiento de empresa no demostrable, devuelve 409 `historical_custody_unresolved` y no inserta nada; un reintento idempotente de un asiento anterior sigue devolviendo el resultado existente. La conciliación presenta las filas pendientes de revisión y no las edita.
- Pruebas PostgreSQL UAT aislado: **8/8** verificaciones, ahora incluyen cuarentena de ficha/chat, bloqueo contable sin nuevo asiento y restauración del backup. Pruebas SQLite dirigidas a política, lifecycle, reparto y custodia: **100/100**. Una prueba de conversación histórica se amplió con clasificación manual sintética para comprobar que los permisos de dueño siguen aplicándose después de la revisión; no se relajó una aserción para ocultar acceso cruzado.

El gate continúa **NO-GO**: faltan una copia histórica depurada para cuantificar y conciliar filas ambiguas, revisión exhaustiva de canales de eventos en tiempo real y reportes administrativos, y UAT Android de entregas y saldos con dos empresas. Las políticas se aplicaron solamente a datos UAT; ningún saldo histórico se reasignó.

## Cierre de los canales en vivo y política única de empresa (24-10-2026)

### Estado recuperado antes de tocar código

- CRM UAT `C:\Users\pc\DEV\UAT\PHYTOEMAGRY-candidato`: rama `integracion/smart-commerce-delivery`, HEAD `d30b2ac`, **15 archivos modificados y 6 nuevos sin seguimiento** (nada estaba commiteado).
- Flutter UAT `C:\Users\pc\DEV\UAT\FULLTECH-DELIVERY-multitenant`: **detached HEAD** `0c83e70`, 12 modificados y 2 nuevos.
- No se ejecutó `reset`, `clean` ni `checkout`: el corte anterior quedó intacto y se continuó desde ahí.

### Cambios de esta fase

1. **Una sola política, no copias.** `server/logistics-tenancy.mjs` pasa a ser la única definición de visibilidad (`crmOwnership`, `crmRowVisible`, `actorSeesCompany`, `explicitCrmCompany`); `crm-server.mjs` ya no mantiene su propia copia de las dos primeras. Es la condición para que HTTP, SSE y agentes no acaben diciendo cosas distintas.
2. **Bus de eventos en vivo** (`server/realtime.mjs`): cada evento lleva `company` y `companyScoped`. `clientAccepts` no entrega al panel ordinario un evento de otra empresa **ni de un registro cuya empresa no se puede demostrar**. Los avisos dirigidos a una persona (`order.assigned`, `delivery.started`) no se tocan: se rigen por identidad, para que un repartidor autorizado siga recibiendo su propia entrega aunque el pedido sea de la otra empresa.
3. **Aviso de chat en vivo** (`emitChatEvent` → `/api/admin/whatsapp/events` y `whatsapp.message_received`): se resuelve la empresa con las etiquetas de conversación y ficha (sin recorrer el almacén en cada mensaje) y el aviso no se reparte a quien no puede ver esa empresa. Si no hay etiqueta, no se inventa pertenencia: el aviso sigue su curso y el acceso al hilo lo sigue cerrando la cuarentena en la ruta HTTP.
4. **Mapa de reparto en vivo** (`emitDeliveryEvent`): aplica **la misma** regla que la lista del mapa. Antes el aviso en vivo se saltaba ese filtro y podía enviar sesión, pedido y posición de otra empresa a un cliente SSE con permiso de tracking.
5. **Herramientas del agente de IA** (`server/ops/read-tools.mjs`): dejan de ser una puerta trasera. Las conversaciones pasan por la cuarentena y los pedidos por la empresa, con la misma función que usan las rutas.

### Evidencia ejecutada

| Prueba | Resultado |
| --- | --- |
| Dirigidas tenancy, reparto, custodia y tracking (12 archivos) | **158/158** aprobadas. |
| Nuevas pruebas de canales (`company-isolation-channels`) | **10/10**: empresa ajena no llega al panel, ambiguo solo a la central, PHYTOEMAGRY sí, evento global no se filtra, aviso a una persona sigue por identidad, hub real y herramientas del agente. |
| Canales + tiempo real + cuarentena (4 archivos) | **32/32** aprobadas. |
| PostgreSQL 17 UAT aislado (`scripts/check-logistics-postgres-uat.mjs`) | **8/8**: migración aditiva, solicitud sin alta, cuarentena de ficha y chat, reparto multiempresa, rendición concurrente e idempotente, bloqueo contable con rollback y restauración del respaldo. Log: `fulltech-postgres-after-channels.log`. |
| Suite general | **101 fallas, 2416 aprobadas, 3 omitidas y 1 error** (2520 pruebas, 183 archivos). Log: `fulltech-tenancy-after-channels.log`. |
| Comparación por nombre con la corrida anterior | 100 fallas idénticas; solo cambia un caso en cada sentido (`offline-24h` y `notifications-user-persistence`), y **ambos ya fallaban en la baseline `d30b2ac`**. Las 10 pruebas nuevas suben el total aprobado de 2406 a 2416. |
| Comparación por nombre con la baseline `d30b2ac` (104 fallas) | Las 101 actuales coinciden con la baseline salvo **una**: `panel-sales-uat > desde el pedido se pasa a un delivery de verdad`, ya documentada en la fase anterior (espera una fila que crean otras pruebas del mismo archivo). No hay falla nueva atribuible a este corte. |
| Flutter UAT | `flutter analyze` sin problemas; `flutter test` **89/89**. Log: `fulltech-delivery-after-channels-flutter.log`. |
| Android UAT | APK debug `app-debug.apk` (170,6 MB, 16:57) posterior al último cambio de `lib/` (16:52): se construyó desde este mismo código y no hubo cambios Flutter en esta fase, así que no se recompiló sin motivo. |
| Certificado UAT | `assets/uat-ca.pem`: **1 certificado y 0 claves privadas**, validez 24→31 oct 2026. Se carga solo con `kDebugMode && uat && apiBaseUrl == https://10.0.2.2:8443`; no hay `badCertificateCallback` ni se desactiva la validación TLS. `android/app/src/debug/` solo contiene el manifiesto (no se pudo reintroducir la raíz por Network Security Config porque Dart la ignoraba). |
| Calidad estática | `node --check` en los cuatro archivos modificados, sin errores. |

### Lo que sigue abierto

- **UAT Android funcional** con una cuenta sintética autorizada a dos empresas (login, pedidos, GPS, offline, revocación de concesión, pago y rendición). El emulador está disponible, pero este ensayo es manual y **no se ejecutó en esta fase**: no se declara hecho.
- **Copia histórica depurada** para cuantificar y conciliar las filas ambiguas antes de cualquier migración real.
- **Catálogo histórico**: los productos no legacy sin `store` explícito se siguen interpretando como FULLTECH; cambiarlo sin inventario previo puede ocultar productos.
- **`delivery.manage`** continúa siendo global en varias vistas administrativas; el aislamiento por empresa de todos esos reportes no está demostrado al 100 %.

### Estado por funcionalidad

| FUNCIONALIDAD | IMPLEMENTADO | PROBADO | PENDIENTE | RIESGO |
| --- | --- | --- | --- | --- |
| Cuarentena de clientes y conversaciones | Sí | 100 % (rutas por lista e ID, SQLite y PostgreSQL) | Conciliar filas históricas reales | Medio: depende de etiquetas explícitas |
| Canales en vivo (bus SSE) | Sí | 100 % (10 pruebas nuevas) | — | Bajo |
| Aviso de chat en vivo | Sí | Sí (wa-realtime + canales) | — | Bajo |
| Mapa de reparto en vivo | Sí | Sí (regla igual a la lista) | Prueba con dos empresas y GPS real | Bajo |
| Herramientas del agente de IA | Sí | Sí (prueba con agente y dos fichas) | Revisar el resto de consultas del Centro IA | Bajo |
| Rendiciones atómicas por empresa | Sí | 100 % (concurrencia, idempotencia, bloqueo) | Conciliación manual auditada | Medio |
| Registro persistente de empresas | Sí | Sí (alta de tercera tienda en PostgreSQL) | Permisos de oficina por empresa | Medio |
| Registro de repartidores desde la app | Sí | Sí (solicitud, revisión, alta separada) | Nueva postulación tras rechazo | Bajo |
| Flutter multiempresa y caché por empresa | Sí | 89/89 + analyze | UAT manual con dos empresas | Medio |
| GPS | Backend y envío probado | Sí (tracking y reparto) | Verificación en vivo en emulador | Medio |
| Pagos y custodia (4 opciones) | Sí en la app y el backend | Sí (custodia y conciliación) | Ensayo completo en emulador | Medio |
| PostgreSQL UAT | Sí | 8/8 | Copia histórica depurada | Bajo en UAT |
| Android HTTPS UAT | Sí, solo debug | Certificado y guardas revisados | Ensayo funcional | Bajo |

### Veredicto

**NO-GO para producción** (sigue cerrado el lanzamiento multiempresa). Avance real de esta fase: los tres canales que se saltaban el aislamiento —bus de eventos, aviso de chat y mapa en vivo— y las herramientas del agente ya aplican la misma regla que las rutas, sin fallas nuevas en la suite completa. Lo que falta para GO es ensayo humano en Android con dos empresas, conciliación histórica con evidencia y cierre de permisos de oficina por empresa.

### Reanudar

```powershell
cd C:\Users\pc\DEV\UAT\PHYTOEMAGRY-candidato
npx vitest run                                            # suite general
npx vitest run tests/company-isolation-channels.test.js   # canales por empresa
node scripts/check-logistics-postgres-uat.mjs             # PostgreSQL UAT aislado
cd C:\Users\pc\DEV\UAT\FULLTECH-DELIVERY-multitenant; flutter analyze; flutter test
```

Ningún saldo histórico se reasignó, no se envió ningún WhatsApp real y no se tocó producción.

## Permisos por empresa, auditoría real y registro de repartidores (24-10-2026, continuación)

### Estado de partida

Los dos worktrees conservaban todo el corte anterior sin commitear (CRM: 17 modificados + 7 nuevos; Flutter: 12 modificados + 2 nuevos). No se ejecutó ningún `reset`/`clean`/`checkout`.

### Cambios

1. **`delivery.manage` deja de ser global.** Se añadió `crm_company_grants` (usuario → empresa) y la ruta `POST /api/admin/users/:id/companies` (solo superadministración, auditada). El alcance se calcula por petición (`adminCompanyScope`) y se aplicó en **14 puntos** que antes preguntaban por `'phytoemagry'` fijo: detalle de pedido, custodia, movimientos, posiciones, cuentas de reparto (lista, alta, edición), mapa de seguimiento, listado del panel, reportes de ventas y de entregas, y reenvío a Meta. **Sin concesiones se mantiene el comportamiento histórico**, así que ninguna cuenta existente cambia de alcance por este corte.
2. **Auditoría que se estaba perdiendo.** `record()` descarta en silencio las acciones fuera de su lista blanca: las concesiones de empresa del repartidor y las decisiones de la solicitud nunca se escribieron. Se añadieron 11 acciones (`courier.company_granted/revoked`, `courier.application_*`, `courier.app_access_granted`, `user.company_scope_*`, …).
3. **Registro de repartidores.** El alta exige ahora vehículo (MOTO/CARRO/BICICLETA/A_PIE), zona de trabajo y aceptación **expresa** de las condiciones; devuelve un recibo aleatorio para consultar el estado sin exponer el teléfono; la revisión admite `info_required` (pide motivo y no aprueba nada); tras un rechazo se puede volver a postular con una fila nueva; alta y consulta tienen limitador por IP.
4. **App Flutter** actualizada al mismo contrato: el formulario pide vehículo, zona y condiciones antes de enviar.

### Evidencia

| Prueba | Resultado |
| --- | --- |
| `crm-company-scope` (nuevas) | 5/5: sin concesión solo PHYTOEMAGRY; con FULLTECH solo esa; revocación inmediata; solo la central reparte; la lista de repartidores y la auditoría respetan el alcance. |
| `courier-application` (ampliadas) | 3/3: sin acceso automático, validación de vehículo/zona/condiciones, estado por recibo, pedir información, rechazo y nueva postulación, auditoría escrita. |
| Dirigidas de alcance, canales, cuarentena, reparto, custodia y tracking | 100/100 |
| PostgreSQL 17 UAT aislado | 8/8 (incluye la consulta de estado de la solicitud) |
| Flutter | `flutter analyze` limpio; `flutter test` 89/89 |
| Suite general | **100 fallas / 2424 aprobadas / 3 omitidas** (2527 pruebas, 184 archivos). Frente a la corrida anterior: **0 fallas nuevas**. Frente a la baseline `d30b2ac` (104): 99 coinciden y queda la conocida `panel-sales-uat > desde el pedido se pasa a un delivery de verdad`. |
| APK UAT | Recompilada tras los cambios: 170,6 MB, SHA-256 `BD312C0A…B314167`, `1.0.0+1`, `com.fulltech.delivery`, defines UAT. Firma de **debug**. |

### Regresión investigada

`panel-sales-uat > desde el pedido se pasa a un delivery de verdad` no es una regresión del producto: depende de pedidos «sin delivery» que crean pruebas anteriores del **mismo archivo**. En este entorno esas pruebas expiran (5 s) con frecuencia, la fila no llega a existir y la prueba cae en cascada; aislada también expira porque su fixture queda saltado. Se deja documentada, no se «arregla» subiendo el tiempo de espera ni relajando la aserción.

### Pendiente que impide GO

Ensayo humano en Android con dos empresas (login, pedidos, GPS, offline, revocación, pago y rendición); pantalla de conciliación de movimientos ambiguos y copia histórica depurada; UI del panel para repartir empresas y revisar solicitudes; documentos del repartidor. Detalle y veredicto en `docs/FULLTECH-DELIVERY-RELEASE-READINESS.md`.

## Panel de repartidores y lectura de concesiones (24-10-2026)

Se añadió la pantalla administrativa que faltaba, sin abrir una segunda navegación:

- `public/admin/couriers.html` + `couriers.js`: solicitudes (buscador, filtro por estado y empresa, teléfono parcial), panel lateral con datos reales y acciones **pedir información / aprobar / rechazar** (aprobar avisa de que no concede acceso), y tabla de repartidores con acceso donde se **conceden y revocan empresas** una por una.
- Enlace en el menú «Entregas» junto a Custodia, con permiso `delivery.manage`.
- Nueva lectura `GET /api/admin/couriers/:id/companies` (fecha y responsable de cada concesión), sujeta al alcance por empresa; sin ella el panel tendría que adivinar el estado.

Evidencia: **47/47** en el bloque dirigido (panel, alcance, registro, acceso, canales, cuarentena, SSE de chat); **4/4** pruebas nuevas del panel; PostgreSQL UAT **8/8**; suite general **100 fallas / 2428 aprobadas / 3 omitidas** (2531 pruebas) con **0 fallas nuevas** frente a la corrida anterior. Estado completo en `docs/FULLTECH-DELIVERY-OPERATIVE-UAT.md`.

## Expediente documental, estado en la app y alcance por usuario (24-10-2026)

- **Documentos del repartidor** (`server/courier-documents.mjs` + 5 rutas): subida con el recibo de la solicitud, validación por **bytes reales** (se rechaza un ejecutable renombrado), 4 MB por archivo, almacenamiento privado con nombre generado, descarga solo autenticada (`no-store`, `nosniff`), revisión administrativa (aceptar / pedir otro / rechazar) auditada y sin dos documentos vigentes del mismo tipo. Lo exigido depende del vehículo: moto/carro piden identidad, licencia y vehículo; bicicleta y a pie, solo identidad.
- **App**: consulta de estado con el recibo guardado en el almacén seguro (`ApplicationReceiptStore`) y botón «Consultar mi solicitud»; 4 pruebas nuevas.
- **Panel**: el detalle de cada solicitud muestra el expediente con faltantes y las acciones de revisión; nueva sección de **usuarios del CRM** para conceder/revocar empresas (`GET` + `POST /api/admin/users/:id/companies`).

Evidencia: documentos **6/6**; suite general **100 fallas / 2434 aprobadas / 3 omitidas** (2537 pruebas) con **0 fallas nuevas**; Flutter `analyze` limpio y **93/93**; APK UAT recompilada (SHA-256 `AE1E576B…A404417`). Sigue pendiente la subida de documentos **desde el teléfono** y el ensayo manual en Android; el veredicto continúa **NO-GO**.

## Documentos desde la app, GPS real y conciliación (24-10-2026, cierre)

- **Subida de documentos desde Android**: `file_picker` + pantalla propia con faltantes, reemplazo y estado de revisión; filtro local de 4 MB/tipo y el mismo filtro en el servidor.
- **GPS**: la app **no tenía geolocalización** (hallazgo). Se añadió `geolocator`, permisos de ubicación en el manifiesto (pedidos en tiempo de ejecución), `LocationTracker` con filtros (2 min de antigüedad, 200 m de precisión, 25 m/15 s) y arranque/parada ligados a la entrega y al cierre de sesión. **Sin servicio en primer plano**: con la app cerrada no se rastrea.
- **Conciliación**: revisión administrativa con justificación y evidencia en un registro aparte (`cash_resolutions`); **no toca el libro ni desbloquea rendiciones** hasta autorización explícita, y una segunda resolución del mismo movimiento se rechaza.

Evidencia: conciliación **5/5**; Flutter `analyze` limpio y **105/105**; suite general **100 fallas / 2439 aprobadas / 3 omitidas** con **0 fallas nuevas**; PostgreSQL UAT **8/8**; APK UAT 171,9 MB, SHA-256 `40374225…68806B`. El veredicto sigue **NO-GO**: falta el ensayo en teléfono real (GPS en segundo plano incluido) y la autorización financiera.

### Servicio en primer plano para el GPS (24-10-2026)

- `flutter_foreground_task` con **tipo `location`** y notificación visible/permanente; arranca solo con entrega activa y se para al cerrarla, al rechazarla o al cerrar sesión. `allowWakeLock`, `autoRunOnBoot` y `allowAutoRestart` en `false`, y se **eliminaron** del manifiesto `WAKE_LOCK` y `RECEIVE_BOOT_COMPLETED`.
- Permisos verificados en el manifiesto fusionado: INTERNET, ubicación aproximada y precisa, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`; `<service android:foregroundServiceType="location"/>`.
- **Límites honestos:** sin prueba en dispositivo; sin rastreo con la app forzada a cerrar; falta justificar la ubicación en segundo plano ante Google Play. No hay endpoint UAT público, así que el APK actual (`10.0.2.2`) sirve para emulador, no para un teléfono.

Evidencia: Flutter `analyze` limpio y **107/107**; APK 208,7 MB, SHA-256 `64143B00…E2BE5`. Veredicto sin cambios: **NO-GO** hasta la aceptación en dispositivo real.

### Entorno UAT en LAN, APK para teléfono y E2E real (24-10-2026)

- `scripts/uat-https-lan.mjs`: CRM UAT aislado (SQLite temporal) servido por HTTPS en la LAN, validando vigencia y SAN del certificado antes de arrancar. Verificado: `https://192.168.1.13:8443` responde 200 con las dos empresas usando la CA.
- **Defecto real corregido:** `POST /api/courier/location` pasaba `getCustomer: null` a la lista de pedidos; la lista fallaba, el `.catch` la vaciaba y la ruta respondía **siempre** `409 no_active_delivery`. El repartidor no podía enviar ni una posición. Lo detectó el E2E nuevo.
- **E2E multiempresa automatizado** (`tests/e2e-multiempresa-uat.test.js`): **5/5**, cubre registro → documentos → revisión → aprobación → alta de acceso → pedido → GPS → entrega con efectivo → custodia → rendición → segunda empresa → revocación, sin mocks.
- **APK para teléfono físico**: `C:\Users\pc\DEV\UAT\fulltech-lan-uat\fulltech-delivery-uat-lan.apk` (208,7 MB, SHA-256 `5CAB20386299CBA3CDA1E9486848F82C6DD4BAFAFF3FE18ED1E5F2EE73867E08`) contra `https://192.168.1.13:8443`. Falta permitir el puerto 8443 en el Firewall de Windows (requiere administrador) y confiar la CA en el teléfono.

Veredicto: **NO-GO** hasta la aceptación en dispositivo real; el camino para hacerla ya está montado y probado hasta donde se puede sin teléfono.

### Firma de release y backend UAT en la nube (25-10-2026)

- El build `release` se firmaba con la clave **debug**. Corregido: `build.gradle.kts` lee
  `android/key.properties`, registra `signingConfigs.release` y avisa en el log si falta
  el llavero. Llavero en `C:\Users\pc\DEV\UAT\fulltech-release\fulltech-release.jks`
  (fuera de los repositorios, ignorado por Git). **Hay que respaldarlo.**
- APK de release **52,5 MB**, SHA-256 `E29D58DCDB65E4C6178EE41DDFD46670781DBA5CDDD4814BBD2358892401D175`;
  firmante `CN=FULLTECH Delivery` (SHA-256 `fd7dc2ba…ffc2a00`), verificado con `apksigner`.
- Las CA de laboratorio siguen en `assets/` pero solo se cargan con `kDebugMode && uat`:
  en release no se confía en ellas.
- `deploy/uat/` deja definido un backend UAT **aislado** (Postgres sin puerto publicado,
  `APP_ENV=uat`, cookies seguras, healthcheck, etiquetas `production: "false"`) con
  instrucciones, verificación y rollback. No se desplegó nada.
- Verificación: Flutter `analyze` limpio, **107/107**; backend dirigido **25/25**;
  PostgreSQL 17 UAT **8/8**.

Veredicto sin cambios: **NO-GO** hasta dominio real, autorización de despliegue y
aceptación en teléfono físico.

### Asistente de ingreso del repartidor (25-10-2026)

**Qué cambió.** El alta dejó de repartirse entre «Solicitar ingreso» y «Mis documentos»:
ahora es un asistente de seis pasos dentro de la misma pantalla (datos personales,
vehículo, disponibilidad, documentos, normas de operación y revisión). La solicitud se
crea en el servidor al salir del paso de disponibilidad —el recibo es lo que autoriza
cada subida— y el envío final es idempotente: repetirlo devuelve el mismo recibo.

**Backend** (`server/courier-application-profile.mjs`, nuevo):
- Valida fecha real (incluye 29 de febrero), edad mínima configurable (18 por defecto),
  correo, documento, placa, tipo de bicicleta y disponibilidad. Devuelve el **campo** con
  error para que la app lo señale.
- Los bloques nuevos son opcionales: un cliente antiguo (solo nombre, teléfono, vehículo,
  zona y condiciones) sigue funcionando; se guardan en el mismo registro, sin segunda base.
- `requiredDocumentsFor` ahora pide selfie y foto del vehículo, y mantiene la licencia
  solo para carro. La selfie es revisión **humana**: no hay reconocimiento facial.
- El panel recibe el perfil completo (la lista de solicitudes ya devolvía la fila entera)
  y `couriers.js` lo pinta en el cajón: documento, nacimiento, correo, residencia,
  emergencia, marca/modelo, placa, disponibilidad, horario, experiencia y versión de normas.

**App**: `courier_onboarding_screen.dart` sustituye al formulario en un diálogo
(eliminado). Borrador en almacén seguro con **solo texto** y paso actual; nunca bytes de
documentos. Al enviar, el borrador se descarta.

**Verificado**
| Prueba | Resultado |
| --- | --- |
| `courier-application-profile` (unidad + HTTP real) | 9/9 |
| `courier-documents` + E2E + aplicación | 23/23 |
| `couriers-panel` + documentos (panel) | 10/10 |
| Flutter `analyze` | limpio |
| Flutter `test` (incluye `application_onboarding_test`) | 115/115 |

**Emulador (capturas reales, APK de release contra UAT)**: se comprobó el acceso sin
modo demostración, con las tres opciones, y el **paso 1 de 6** del asistente con barra de
progreso, secciones, campos redondeados y pie Cancelar/Continuar.

**Sin verificar en emulador todavía**: pasos 2 a 6 con datos reales, subida de cada
documento, reanudación del borrador tras cerrar la app y envío completo con referencia.
Quedan cubiertos por pruebas automatizadas y revisión de código, no por una pasada manual.

**Bloqueos conocidos**: la captura con cámara no está implementada (solo selector de
archivos); la declaración de política de privacidad para la selfie y el certificado de
buena conducta quedan pendientes de decisión legal.
