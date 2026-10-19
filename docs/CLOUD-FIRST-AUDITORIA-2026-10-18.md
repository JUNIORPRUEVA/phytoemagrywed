# Cloud First: auditoría e implementación local

Fecha: 18 de octubre de 2026. Dictamen: **NO-GO para despliegue** hasta cerrar las validaciones indicadas al final. No hubo commit, push, merge, despliegue ni modificación de datos productivos.

## Base comprobada

- Repositorio: `C:\Users\pc\DEV\PROYECTOS\INTERNO\PHYTOEMAGRY`, rama `main`, HEAD `0e91ae84969878ef91b3d18086002a916ddd65ae`.
- Había ocho archivos modificados y `uat-salida.txt` sin seguimiento. Se conservaron sus cambios; no se atribuye autoría individual sin evidencia.
- Los dos worktrees `PHYTOEMAGRY-chat-1` y `PHYTOEMAGRY-chat-2` señalan el mismo HEAD, pero tienen numerosas diferencias, incluyendo archivos eliminados de SSE, recogidas, Supervisor y pagos. No se utilizaron.
- Consulta SSH de solo lectura: servicio `ventas_phytoemagrywed`, imagen `easypanel/ventas/phytoemagrywed:offline-p0-20261019`, ID `sha256:5a58e06d62a19ff44566901d17fc83aea3c76e5ec482032624e0049a06d44e49`.
- Comparación inicial de `/app/server` y `/app/admin`: 110 archivos idénticos por SHA-256. Para los módulos del backend que diferían se comparó además el texto normalizando CRLF: solo difirieron `audit.mjs`, `offline-operations.mjs` y `crm-server.mjs`. También difieren los dos módulos offline del frontend examinados. Se detectó un archivo de licencia de PDF que se genera en build y no existe en `public`.
- Esto valida los módulos examinados, no constituye equivalencia binaria de toda la imagen ni de `origin/main`. No se hizo fetch ni se alteraron ramas. Las copias de comparación están en el directorio temporal `phyto-cloud-audit-094dc17f26614b13ab8da15d4ec773a9` del usuario local.

## Por qué se priorizaba la caché

`offline.js` devolvía caché antes de intentar la red si había una operación pendiente. Cualquier entrada en la cola también forzaba escrituras a almacenamiento local. `warm()` dejaba de descargar y `putRemote()` se negaba a actualizar respuestas si existían operaciones. La corrección heredada distinguía pendientes de rechazos para algunas lecturas, pero no eliminaba esos bloqueos.

## Cambios implementados

1. Lecturas de red primero, independientemente de la cola. `navigator.onLine` se usa como orientación de timeout, no como prueba suficiente para omitir una escritura de red. Los 404/409/422 conservan su significado de respuesta del servidor.
2. Escrituras independientes directas al backend con identificador de idempotencia. Las dependientes de IDs locales se conservan en orden hasta resolver sus referencias. La copia de lectura puede actualizarse aunque existan pendientes o rechazos.
3. Reconexión: consulta real de sesión, actualización de identidad, comprobación del propietario esperado, respaldo verificable, consulta del estado de cada operación, envío o revisión, descarga actualizada y reanudación SSE. Se preservan los eventos usados por POS y catálogo.
4. Las respuestas confirmadas se conservan bajo `confirmed:<cuenta>:<id>` antes de retirar la entrada activa. Una respuesta HTTP 200 sin JSON `ok:true` no confirma una operación durante sincronización.
5. La consulta de estado ya no intenta parsear solo los primeros 200 caracteres del JSON persistido. El servidor consulta el resultado íntegro internamente y devuelve metadatos de estado asociados al actor autenticado.
6. Para una operación ya aplicada se usa la reproducción idempotente de la respuesta persistida, con la misma clave y validación de huella. No se vuelve a ejecutar el negocio; se recuperan los IDs reales necesarios para dependencias. Estados inciertos o rechazos registrados pasan a revisión.
7. La reparación manual de descartes requiere respaldo y evidencia de rechazo definitivo; no descarta silenciosamente claves desconocidas. Una resolución manual fallida permanece en revisión. El backend exige ADMIN y un registro efectivo de auditoría.
8. Diálogo offline reparado: `count` y `review` estaban fuera de alcance. Añadidos estados comprensibles y detalles técnicos restringidos a ADMIN. La exportación de recuperación incluye original, última copia, versiones y cola actual de la cuenta.
9. Protección de respuestas tardías al cambiar cuenta, validación del propietario al descargar y al consultar estados. Se mantiene el límite de 24 horas y se rechaza una fecha local anterior a `verifiedAt`.
10. Recursos locales versionados: `crm-v166-cloud-first`, `offline.js?v=14`, `offline-ui.js?v=6`, almacén v2 del archivo JS. **Esto no está desplegado.**

## Almacenamiento y reparación segura

La base IndexedDB continúa llamándose `fulltech-offline-v1`, versión física 1, almacén `records`. No usa índices secundarios: no hay índices que crear o borrar. Se mantiene compatibilidad con el service worker existente. El cierre `onversionchange` permite futuras migraciones sin bloquear otras pestañas.

- `response:<cuenta>:<url>`: copia de lectura. Se actualiza con respuestas del servidor sin tocar la cola.
- `queue:<cuenta>`: diario de escrituras, estados `preparing`, `pending`, `review` y resolución manual histórica.
- `confirmed:<cuenta>:<id>`: evidencia local de confirmación.
- `mapping:<cuenta>`: referencias locales a IDs reales.
- `respaldo:<cuenta>`: primer respaldo conservado.
- `respaldo-ultimo:<cuenta>` y `respaldo-version:<cuenta>:<secuencia>`: instantáneas transaccionales v2 con firma del contenido completo y verificación de lectura antes de sincronizar.
- `migration:queue-v1:*`, `migration-backup:*`, `migration-conflict:*`: migración transaccional e idempotente de identidades antiguas. No borra la fuente ni la vuelve a importar después de confirmar operaciones. Los IDs duplicados incompatibles conservan ambas evidencias.
- `repair-backup:*`, `repair:*`: respaldo y diagnóstico de registros de lectura estructuralmente dañados reemplazados con una respuesta válida del servidor. Las lecturas dañadas no provocan una excepción sin manejar.

No se vacía IndexedDB ni se reconstruye una cola a partir de la nube. Una corrupción física del archivo IndexedDB, falta de espacio, almacén ausente o versión futura incompatible no se considera reparable automáticamente: debe conservarse y diagnosticarse. La recuperación implementada cubre estructuras y migraciones conocidas, no corrupción arbitraria del navegador.

## Validación reproducible

La ronda final SQLite ejecuta 95 pruebas en siete archivos: `offline-24h`, `offline-worker`, `panel-offline-uat`, `realtime`, `order-payments`, `delivery-supervisor-routes`, `auth-users-assignment`. Incluye dos sesiones SSE con servidor real, respaldo fallido, respuestas perdidas, no duplicación de stock, caché antigua con pendientes, 404/422, sesión revocada, migración repetida, copia dañada, reapertura y 24 horas.

```powershell
npx vitest run tests/offline-24h.test.js tests/offline-worker.test.js tests/panel-offline-uat.test.js tests/realtime.test.js tests/order-payments.test.js tests/delivery-supervisor-routes.test.js tests/auth-users-assignment.test.js
```

PostgreSQL se ejecuta exclusivamente en un contenedor local desechable, base `fulltech_qa`, con un esquema nuevo por caso. La primera ronda obtuvo 27/28: un timeout de 5 s, no una aserción fallida. La repetición final, incorporando el caso de dos sesiones SSE, obtuvo **29/29 aprobadas** con `--testTimeout=20000 --hookTimeout=20000` en 54,07 segundos. SQLite obtuvo **95/95 aprobadas** en 16,97 segundos. El contenedor temporal fue detenido al terminar; no se utilizaron datos productivos.

`npm run check` y `npm run build` finalizaron correctamente. Mantienen advertencias preexistentes de contenido/configuración de la landing. No se enviaron mensajes reales; las pruebas del Supervisor usan WhatsApp simulado.

## Operaciones reales del Android

| Operación observada | Estado de investigación |
| --- | --- |
| `invalid_dismissals` | Falta payload e ID originales; no se afirma recuperada. |
| 404 del 17/10 | Falta ruta, payload, ID y resultado persistido. No se descarta. |
| 404 del 18/10 | Falta ruta, payload, ID y resultado persistido. No se descarta. |
| Respaldo con cinco operaciones | Falta archivo real para comparar con la cola activa. |

Procedimiento: descargar el JSON desde el teléfono, adjuntarlo de forma privada y conservar el original fuera de Git. Comparar cada ID y cualquier clave de reintento con el estado del servidor; revisar ruta, método, cuerpo y dependencias. Solo una confirmación persistida permite conciliar como aplicada. Un 404 por sí solo no autoriza eliminar ni resolver. No publicar datos de clientes en un issue, log o informe.

## Archivos y límites

Editados en esta intervención: `offline.js`, `offline-storage.js`, `offline-ui.js`, `store.js` (evita iniciar sondeo tras cerrar la ventana), `index.html`, `sw.js`, `server/offline-operations.mjs`, `server/crm-server.mjs`, `tests/offline-24h.test.js` y este informe. `app.js` y `server/audit.mjs` ya estaban modificados y se conservaron.

Pendientes para GO:

- Conciliación individual del JSON real del teléfono.
- UAT en Android y Safari/iPhone físicos, actualización real del service worker con operaciones pendientes y cuotas de almacenamiento.
- Validar el conjunto completo de conflictos de versiones de las operaciones financieras existentes. Se conserva la idempotencia y las validaciones actuales; no se ha añadido un protocolo universal de control optimista de versiones a todos los endpoints del CRM.
- Validar que las proyecciones de operaciones locales pendientes se reconstruyan correctamente en todos los módulos tras refrescar la copia desde nube. El diario permanece separado y protegido; no se afirma haber reconstruido automáticamente todas las proyecciones financieras heredadas.
- Revisar conservación/retención de versiones de respaldo sin eliminar evidencias pendientes; actualmente crecen y una cuota agotada bloquea de forma segura la sincronización.
- Antes de cualquier despliegue autorizado: respaldo nuevo de la base productiva correcta, restauración aislada verificada, comparación final de artefactos y plan de rollback.

La arquitectura central Cloud First y las correcciones anteriores están implementadas localmente. La totalidad del objetivo empresarial no se declara cerrada mientras existan estos pendientes.
