# FULLTECH Smart Commerce — validación PostgreSQL, recuperación y UAT

Fecha: 24 de octubre de 2026. **GO para continuar UAT aislado; NO-GO para producción.** Continuidad incremental, sin reconstruir los flujos existentes. No hubo despliegue, cambios de flags productivas, acceso a bases productivas, mensajes WhatsApp reales ni operaciones bancarias reales.

## 1. Entorno positivamente identificado

PostgreSQL **17.9 real**, ejecutado desde los binarios instalados, en un clúster temporal creado exclusivamente para estas pruebas. No se usaron los servicios PostgreSQL 16/17 existentes ni `DATABASE_URL` del entorno.

- Base final: `fulltech_uat_39413a375bf847138557ab48abcb885f`.
- Usuario: `fulltech_uat`; dirección: `127.0.0.1`; puerto: `64617`.
- Directorio: `C:/Users/pc/AppData/Local/Temp/fulltech-pg-uat-8ACGJW/data`.
- Guarda SQL: propósito `FULLTECH_DESTRUCTIVE_UAT_ONLY` y nonce `39413a375bf847138557ab48abcb885f`.

El arnés comprueba nombre, usuario, dirección, puerto, directorio y guarda antes de las pruebas. El proceso API hijo verifica también su identidad antes de migrar. Si no coinciden, se rechaza la ejecución. `pg_terminate_backend` se aplicó solo a una sesión cuya base coincidía con esta UAT. Los cortes abruptos terminaron únicamente procesos API hijos creados por el arnés.

El clúster final y las APIs se cerraron al terminar. Una ejecución previa terminó por un error de conexión no manejado: se verificó su nonce/directorio y se detuvo exclusivamente ese clúster propio. Se conservaron los directorios temporales para diagnóstico, sin borrar bases del usuario. La autenticación `trust` es exclusiva de este clúster efímero en loopback; **no es una configuración recomendada de despliegue**.

## 2. Transacciones, concurrencia e integridad

**29/29 comprobaciones PostgreSQL aprobadas**, registradas individualmente en `.tmp/store-postgres-uat.json`. Hay dos instancias API con pools independientes y dos pruebas adicionales con un proceso API hijo terminado abruptamente.

Se verificaron carreras por la última unidad y varios holds sobre la misma sucursal; checkout repetido; cancelación y confirmación tardía bloqueada; rechazo y liberación idempotente; rollback por excepción y CHECK; índices UNIQUE; claves foráneas; stock nunca negativo; retiro concurrente por dos operadores con un solo consumo; separación de cuenta/tienda; expiración y liberación; recuperación después de reinicios y de interrupción real de sesión SQL.

Las reservas y transiciones se serializan con el bloqueo SQL de la configuración y las filas involucradas. Esta evidencia demuestra los casos ejecutados, **no una prueba de carga, ausencia universal de deadlocks ni certificación de throughput**. La cancelación seguida de confirmación tardía se probó secuencialmente; no se presenta como una carrera simultánea de esos dos endpoints.

La migración aditiva PostgreSQL valida cuatro relaciones: stock → catálogo FULLTECH, reserva → solicitud, reserva → stock compuesto y outbox → solicitud. Usa bloqueo asesor transaccional para dos arranques concurrentes. Los huérfanos previos hacen fallar la validación: no se borran ni reparan silenciosamente. No hay FK de cada intención de reserva al pedido CRM, porque la intención debe persistirse antes de crear el pedido; tampoco se afirma que estas cuatro FK cubran por sí solas toda la separación de negocio. SQLite no equivale a esta certificación PostgreSQL.

Stock `supplier_report` sigue siendo disponibilidad declarada, no reservable. El escenario de proveedor exige cambiarlo a `supplier_confirmed` mediante la operación autorizada antes de aceptar/reservar; no consume stock propio.

## 3. Fallos encontrados y correcciones

1. Una conexión PostgreSQL terminada podía reciclarse al pool. Ahora se descarta ante errores de conexión o rollback fallido.
2. Un evento `error` del cliente prestado durante la transacción podía terminar Node sin captura. Ahora se escucha durante el préstamo, se marca para descarte y se devuelve/destruye sin reutilizarlo. La repetición de interrupción SQL y reintento pasó.
3. El aviso podía leer una solicitud antes de expirar reservas. Ahora barre vencimientos antes de volver a leer el estado y decidir si puede enviarse.
4. Un crash dejaba el outbox indefinidamente en `sending`. Se agregó una concesión de 10 segundos y transición auditada a `unknown` al vencer; **no se reenvía automáticamente ni se interpreta como aceptación**.
5. Había una ventana entre consumo SQL del retiro y finalización del pedido CRM. Se agregó conciliación ADMIN explícita e idempotente: `POST /api/admin/store/commerce/operations/reconcile`, hasta 100 pedidos nativos pendientes por llamada. El filtro excluye los ya entregados para evitar que bloqueen el siguiente lote. Repetir la misma entrega no descuenta otra unidad.

La revisión también comprobó la lectura fresca del catálogo en las validaciones críticas de checkout/pedido, conservando la caché de las lecturas públicas. No se cambió el maestro ni se añadió un catálogo paralelo.

## 4. Recuperación demostrada y sus límites

| Punto probado | Resultado |
|---|---|
| Excepción antes del COMMIT de reserva | Rollback; reintento válido sin hold duplicado |
| Terminación abrupta del proceso dentro de la transacción | PostgreSQL revierte; reintento crea una sola reserva |
| Terminación abrupta después del COMMIT de reserva | Hold durable; reintento crea un solo pedido/hold |
| Excepción después de crear el pedido CRM y reinicio | Respuesta duplicada recuperada, sin otro pedido |
| Conexión SQL terminada durante reserva | Rollback, proceso sobrevive y reintento válido |
| Excepción después del consumo de retiro y reinicio | Conciliación ADMIN, sin repetir movimiento |
| Fallo tras reclamar aviso, antes de enviar | Tras reinicio/lease, `unknown`; cero envíos |
| Fallo después del envío simulado, antes de registrar | Un envío simulado; `unknown`, sin reenvío |
| Código simultáneo en dos operadores | Un éxito y un conflicto; un movimiento |
| Código vencido / aceptación tardía | Bloqueo sin consumir inventario / liberación |
| Verificación de pago repetida | Continúa elegible sin crear otro cobro |
| Asignación a repartidor inexistente | Rechazo; pedido preparado no se finaliza |
| Timeout real de AbortSignal, proveedor inyectado | Sin metros inventados ni tarifa automática |

Los fallos de notificación se inyectaron con excepción y reinicio del servicio; **no se certificó un worker externo ni se terminó abruptamente un proceso WhatsApp real**. Los dos cortes abruptos de proceso corresponden al checkout. El fallo posconsumo usa excepción/reinicio, no corte eléctrico. Estos límites importan al interpretar la evidencia.

`unknown` requiere conciliación humana/proveedor, no se garantiza entrega exactamente una vez en un canal externo sin contrato de idempotencia. Mantenimiento/conciliación son operaciones administrativas: sigue pendiente un job operativo supervisado con alertas. No se garantiza escalación puntual en ausencia de tráfico o mantenimiento. No se hicieron cargos reales; se verificó idempotencia del libro ficticio, no la de un adquirente bancario.

## 5. UAT operacional automatizado

| Escenario | Evidencia y resultado |
|---|---|
| A: delivery local | Coordenadas y polígono ficticios → precio regional RD$2000 → ruta sintética 10790 m → RD$1100 → total RD$3100 → CRM → asignación válida → entrega nativa. Pago permanece pendiente bajo la política existente; no se lo marca pagado por entregar. |
| B: retiro | Proveedor existente ficticio → aviso simulado sin aceptación implícita → stock confirmado → aceptación/reserva → preparación/listo → pago pendiente bloquea → ADMIN verifica → código → entrega única. |
| C: rechazo | Proveedor rechaza, estado visible al cliente, sin código; liberación de hold confirmada además en caso independiente. |
| D: dos proveedores/orígenes | Dos grupos; solicitud manual, sin tarifa ni total automático inventados. No certifica liquidación ni entrega parcial. |
| E: interciudad | Dirección ficticia La Romana y origen Higüey: producto público visible por ID, solicitud 202, sin tarifa local. No se confundió la paginación de 24 productos con falta de publicación. |
| F: GPS no disponible | Dirección manual confirmada → solicitud 202 sin selector de ciudad obligatorio. Caída de routing también obliga revisión, sin distancia recta. |
| G: transferencia pendiente | Entrada ficticia pendiente no habilita código; verificación ADMIN repetida sí, sin duplicar pago. Integrado en B. |

Estos son recorridos automatizados con datos de prueba. **No hubo UAT con operador humano**, recuento físico, desplazamiento real de un repartidor ni aceptación comercial de un proveedor.

## 6. Seguridad y tarifa

Las 103 pruebas seleccionadas preservan autorización SUPPLIER por sucursal, revocación, denegación por defecto, ausencia de márgenes/costos en proyecciones, acceso por propietario, precios del servidor, permisos financieros y separación FULLTECH/Phytoemagry. PostgreSQL añade verificación real de acceso de otra cuenta rechazado, producto Phyto rechazado como stock FULLTECH y consumo SQL único. No equivale a pentest ni acredita que los defectos antiguos de privacidad AGENT estén solucionados.

Tarifa comprobada con metros enteros:

| Metros | RD$ |
|---:|---:|
| 1000 | 100 |
| 1001 | 150 |
| 1500 | 150 |
| 1501 | 200 |
| 10790 | 1100 |
| 15000 | 1500 |
| 15001 | No disponible |

Los 23 tests de reglas comprueban por separado el polígono (no radio circular), sus bordes, precios regionales y la lectura de distancia vial OSRM, redondeada hacia arriba. El adaptador usa `/route/v1/driving`, no Haversine; sin ruta válida no cotiza automáticamente. El timeout añadido usa un AbortSignal real y fetch inyectado, sin red externa. **No se consultó un proveedor vial operativo real ni se validó la cobertura comercial real de Higüey/La Romana**; los polígonos y los 10790 m son fixtures.

## 7. Regresiones e intermitencia

Baseline de esta fase, capturado antes de cambiar código: **2344 tests, 2243 aprobados, 98 fallidos, 3 omitidos; 167 archivos, 28 con fallos**. Evidencia `.tmp/store-final-validation-baseline.json`. Los resultados de cierre y comparación assertion por assertion están en la sección 25 del informe principal y `.tmp/store-final-validation-failures.json`.

El caso de descartes masivos de `notifications-user-persistence.test.js` pasa aislado, pero volvió a fallar en ejecuciones generales. La instrumentación optativa capturó en GET `/api/admin/notifications`: **`fetch failed`, causa `ECONNRESET`, `read ECONNRESET`**. Evidencia `.tmp/store-notification-transport.ndjson`. Esto identifica el mecanismo de fallo, **no su causa raíz definitiva**.

Se ensayó la hipótesis de starvation del event loop: 5005 marcas y seis segundos de bloqueo controlado, con/sin cesión de I/O; ambas variantes pasaron (`.tmp/store-notification-starvation.json`). No basta para atribuirlo a carga, orden de tests, estado compartido, limpieza de base, mocks externos o agotamiento. Sigue pendiente una reproducción determinista con trazas de cierre de socket/servidor y aislamiento del paralelismo. No se introdujo reintento para disimularlo, no se elevaron timeouts ni se debilitaron assertions.

No se declara la suite general verde. Las coincidencias con baseline prueban reproducción anterior a esta fase, no que los defectos sean inocuos o históricamente ajenos a todo Smart Commerce.

## 8. Frontend y comandos reproducibles

Build aprobado: **327 archivos**, con siete advertencias previas de contenido/configuración. Chromium automatizado: siete tamaños 320/375/390/430/768/1024/1440 px y tres retiros completos 320/390/1024 px, sin errores JS ni overflow horizontal. Captura de retiro de cliente a 390 px inspeccionada visualmente en esta fase. La skill Sites se utilizó solo para orientar la comprobación local, sin publicación ni rediseño. Resultados: `docs/capturas/smart-commerce/results.json`.

```powershell
node --experimental-sqlite scripts/check-store-postgres-uat.mjs
npx vitest run tests/store-fulfillment.test.js tests/store-smart-rules.test.js tests/store-smart-commerce.test.js tests/store-checkout-uat.test.js tests/store-isolation.test.js tests/store-public-api.test.js tests/auth-users-assignment.test.js tests/order-payments.test.js --reporter=json --outputFile=.tmp/store-final-validation-targeted.json
$env:FULLTECH_NOTIFY_DIAGNOSTICS='1'
npx vitest run --reporter=json --outputFile=.tmp/store-final-validation-full.json
node scripts/audit-store-critical-tests.mjs .tmp/store-final-validation-baseline.json .tmp/store-final-validation-full.json .tmp/store-final-validation-failures.json
npx vitest run tests/notifications-user-persistence.test.js -t 'descartes no caducan' --reporter=json --outputFile=.tmp/store-notification-isolated-validation.json
node --experimental-sqlite scripts/check-notification-starvation.mjs
$env:PLAYWRIGHT_MODULE='file:///C:/Users/pc/DEV/PROYECTOS/PRODUCTOS/DaleVentas%20POS/.tmp-playwright/node_modules/playwright-core/index.mjs'
node --experimental-sqlite scripts/check-store-smart-uat.mjs
npm run build
git diff --check
```

La ejecución filtrada de notificaciones es solo diagnóstico, no reemplaza la suite completa. El arnés PostgreSQL requiere binarios locales PG17 (Windows); falla sin alternativa a una base existente. Los JSON `.tmp` son evidencia local generada, no infraestructura de producción ni necesariamente archivos versionados.

## 9. Archivos y alcance

Extendidos durante esta fase: `server/smart-fulfillment.mjs`, `server/smart-commerce.mjs`, `server/smart-commerce-routes.mjs`, `server/crm-server.mjs`, `server/store-catalog.mjs`, `scripts/check-store-postgres-uat.mjs`, `scripts/lib/fulltech-uat-postgres.mjs`, `tests/notifications-user-persistence.test.js` (solo diagnóstico optativo, conserva expectativas), informe principal y baseline. Incorporados: `scripts/lib/fulltech-uat-api-child.mjs`, `scripts/check-notification-starvation.mjs` y este documento. El árbol compartido puede incluir cambios previos u otros commits; no se atribuye todo el diff a esta fase.

Los checkpoints de fallo son funciones inyectadas por configuración programática UAT, no endpoints ni variables que permitan dispararlos desde el cliente. Por defecto no ejecutan nada. No se tocaron módulos de negocio ajenos para hacer pasar el baseline.

## 10. Bloqueos, requisitos y rollback

Antes de considerar release candidate: resolver privacidad AGENT y defectos persistentes de permisos/panel/avisos/CRM; cerrar causa raíz de `ECONNRESET`; auditar semántica histórica de pagos rechazados; verificar reglas de cobro de delivery con negocio; aprobar UAT humano y seguridad; probar red lenta/desconexión y dispositivos reales; configurar recuentos físicos y roles mínimos; validar proveedor vial y zonas reales; disponer de job supervisado de expiración/conciliación y métricas; cerrar contrato sandbox de notificaciones/idempotencia sin presumir aceptación. Los reembolsos, liquidación multi-proveedor y entregas parciales requieren su propia validación.

Rollback: no eliminar tablas, auditoría, holds ni pagos para volver al binario anterior. Detener nuevas entradas, respaldar y conciliar primero retiros consumidos/pedidos nativos; liberar solo reservas no consumidas; resolver outbox `unknown` sin reenvío ciego; preservar protección del stock asignado. Las nuevas columnas/FK son aditivas y pueden conservarse; si existen huérfanos, planificar reparación auditada antes de arrancar la versión nueva. No usar borrados masivos para superar una migración. Revocar SUPPLIER antes de volver a una versión que lo interprete como AGENT. No se ejecutó ningún rollback productivo.

**Veredicto: NO-GO para producción.** La validación PostgreSQL y los flujos automatizados avanzaron sustancialmente, pero no eliminan los defectos críticos generales ni sustituyen la validación humana y de integraciones reales.
