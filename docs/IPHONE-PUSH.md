# Investigación de notificaciones en iPhone

Rama: `fix/iphone-push-notifications`, basada en `54f9108`. El worktree principal tiene cambios sin confirmar que no forman parte de esta rama.

## Hallazgos comprobados en el código

- La interfaz usaba el total de suscripciones del usuario para decir «Teléfono conectado». Otro dispositivo podía hacer aparecer conectado un iPhone que nunca se había registrado.
- «Probar» enviaba a todos los dispositivos del usuario, incluso cuando el registro del dispositivo actual devolvía `false`. La aceptación de otro teléfono podía confundirse con éxito del iPhone.
- Los errores de registro solo aparecían en un toast genérico. Se perdía el motivo de rechazo de Apple incluido en el cuerpo HTTP del proveedor.
- La ayuda sugería revisar Chrome incluso en iPhone. No distinguía la app instalada de una pestaña de Safari.
- Un push con JSON `null` fallaba antes de mostrar una notificación. Safari exige que el procesamiento del push muestre un aviso visible.

## Correcciones y comprobaciones

Se confirma el registro de este navegador en memoria, sin restaurarlo del snapshot. La prueba del panel se dirige al ID de esta suscripción y valida su pertenencia al usuario autenticado. No se envía si el registro local falla. El endpoint mantiene la prueba general sin ID para clientes anteriores.

Los permisos se solicitan desde el clic antes de esperas de red. Se informa cómo instalar la app, habilitar permisos y comprobar HTTPS. Se vuelve a sincronizar al regresar a la app y se renuevan suscripciones con fecha de caducidad vencida o clave pública diferente.

Los envíos usan `aes128gcm`, prioridad alta, TTL de 24 horas y un timeout de 15 segundos. Se conserva el motivo de rechazo de Apple, incluidos `BadJwtToken` y `Unregistered`. La aceptación del servicio push se describe como tal, sin afirmar recepción física. El service worker muestra un aviso de reserva con payload vacío o inválido y tiene una nueva versión de caché.

## Validación pendiente en el iPhone afectado

No se ha accedido a producción ni a un iPhone físico. Estos hallazgos corrigen fallos comprobados, pero no identifican por sí solos la causa concreta del dispositivo reportado.

1. Confirmar iOS 16.4 o posterior, HTTPS y que se abre CRM Phyto desde el icono de la pantalla de inicio. Desde Safari: Compartir → Añadir a pantalla de inicio.
2. Tras publicar la corrección, actualizar el panel, entrar en Configuración → Notificaciones y pulsar Activar. Aceptar el permiso.
3. Pulsar Probar. Distinguir el aviso local «Prueba en este teléfono» del remoto «Prueba de notificaciones». Confirmar ambos en el centro de notificaciones.
4. Revisar Ajustes → Notificaciones → CRM Phyto, modos de concentración y resumen programado. Repetir el envío con la app cerrada y la pantalla bloqueada usando un mensaje entrante de WhatsApp o una asignación real de prueba.
5. Si falla el remoto: inspeccionar `/api/admin/push-status` con sesión autorizada; revisar `recentJobs.error` y `subscriptions.last_error`. No copiar endpoints completos, claves privadas ni cookies a informes.
6. Para `BadJwtToken`: verificar que las llaves VAPID corresponden, el reloj del servidor está sincronizado y `PHYTO_WEB_PUSH_SUBJECT` identifica un contacto público válido. El valor predeterminado del proyecto es `mailto:admin@phytoemagry.local`; reemplazarlo en producción por el correo real. No se ha comprobado que ese valor sea el origen del fallo reportado. No regenerar llaves sin plan de reinscripción de los dispositivos.

Fuentes primarias: [Web Push en iOS y iPadOS](https://webkit.org/blog/13878/), [requisito de aviso visible](https://webkit.org/blog/12945/meet-web-push/), [web-push y la limitación de localhost en VAPID](https://github.com/web-push-libs/web-push#using-vapid-key-for-applicationserverkey).

## Pruebas

Pruebas del panel con CRM real y APIs del navegador simuladas; pruebas del envío con proveedor simulado (selección del iPhone, aislamiento entre usuarios, rechazo de Apple y expiración); ejecución real del service worker en VM para payload normal, vacío, inválido, null y array. Estas pruebas no prueban recepción por APNs en un iPhone físico.

Las tres aserciones sobre el formato `Nombre · Delivery` de `tests/delivery-assignment-notifications.test.js` ya fallan usando `server/crm-server.mjs` de `HEAD`, antes de esta corrección: el código base emite `DELIVERY · Nombre`.

Resultado local: 36 pruebas pasaron en 5 archivos. `npm run verify:deploy` completó revisión de contenido y build; mostró avisos de configuración pendiente porque este worktree no copia el .env del directorio principal.


## Aclaración del síntoma: aparece el número en el icono, sin aviso en pantalla

El usuario confirma que ve el contador en el icono. El código ejecuta `navigator.setAppBadge(pendientes + whatsappPendiente)` al renderizar el panel (`renderBadges`), independientemente del flujo de Web Push. Ese número por sí solo no demuestra que APNs haya entregado un mensaje ni que se haya ejecutado `showNotification`.

El manejador push sí invoca `showNotification` sin condicionar su ejecución a que la app esté visible y sin establecer `silent: true`. No hay evidencia de un envío deliberado solo al contador. Se deben distinguir dos casos: (a) el aviso existe en el centro de notificaciones pero iOS no muestra tiras o pantalla bloqueada, y (b) solo se actualiza el contador al abrir el panel y el push no llega.

Primero comprobar Ajustes → Notificaciones → CRM Phyto → Permitir notificaciones, Pantalla bloqueada, Centro de notificaciones y Tiras. Comprobar entrega inmediata, Concentración/No molestar y Resumen programado. Probar fuera de la app y con pantalla bloqueada. Si no aparece ni el aviso local de prueba, revisar la presentación en iOS; si aparece el local pero no el remoto, investigar el registro y envío APNs. La aplicación web no puede imponer las preferencias de presentación elegidas por el usuario en iOS.

Referencia: [Ajustes de notificaciones del iPhone](https://support.apple.com/guide/iphone/change-notification-settings-iph7c3d96bab/ios), [Badging en WebKit](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/).


## Investigación tras confirmar el fallo en varios iPhones

El usuario confirma que permisos y presentación están activados y que afecta a varios iPhones. No se considera comprobado que sea un ajuste individual de iOS. Se necesita la URL del panel y el estado de los envíos de producción para aislar el fallo real.

Comprobaciones locales sin exponer secretos:

- Las llaves VAPID del `.env` del worktree principal corresponden entre sí (verificación criptográfica P-256).
- Ese archivo no define `PHYTO_WEB_PUSH_SUBJECT` ni un correo público de contacto. Por ello, con esos valores el servidor usa el respaldo `.local`. Esto no demuestra que el servidor desplegado tenga la misma configuración ni que Apple esté rechazándola: se añadió un aviso visible en el estado push.
- La base SQLite local no contiene suscripciones ni trabajos push; no sirve como evidencia de entrega de producción.
- Compose no reenviaba las variables VAPID del `.env` al contenedor. Se añadieron como entorno de ejecución, con los alias existentes de llaves. Este defecto afecta al despliegue por Compose; no se atribuye al servidor actual sin comprobar su método de despliegue.

Se añadió confirmación del worker para nuevos envíos. Cada mensaje cifrado lleva una credencial HMAC limitada al ID del trabajo. El worker primero solicita la creación de la notificación y luego confirma `displayed` o `display_failed` en `/api/push/receipts`, sin necesitar cookie de sesión. El endpoint verifica firma, edad máxima de siete días y estado permitido. No publica endpoints completos, tokens ni datos del cliente. El worker no espera red antes de mostrar el aviso; el diagnóstico tiene un timeout de cuatro segundos.

El servidor guarda el trabajo antes de enviarlo para admitir confirmaciones rápidas. `push-status` diferencia `status` del proveedor y `deviceStatus`, `deviceError`, `deviceReceivedAt`, `workerVersion`. La prueba del panel actualiza el resultado durante diez segundos. `displayed` significa que `showNotification` resolvió; no prueba que el usuario haya visto una tira. La ausencia de confirmación tampoco prueba falta de recepción: puede faltar conectividad en el retorno o quedar un worker anterior.

Validación ampliada: 46 pruebas pasan en seis archivos, incluyendo firma inválida, separación entre usuarios, confirmación sin sesión, preservación de una confirmación temprana, fallo de presentación y fallo de red del diagnóstico. Continúa pendiente probar el servidor publicado y la recepción en los iPhones afectados.


## Auditoría SSH de producción — 16 de octubre de 2026

Se accedió con la clave SSH existente, sin leerla ni mostrarla. Servicio: `ventas_phytoemagrywed`, gestionado por Easypanel. Panel identificado: https://phytoemagryrd.lat/admin/ (también tiene rutas www y easypanel.host).

Hechos comprobados mediante consultas PostgreSQL en transacción READ ONLY:

- Hay dos suscripciones Apple activas de iPhone.
- En los últimos 200 trabajos consultados: 88 envíos Apple fallaron con HTTP 403, otros dos fallaron sin código HTTP, y 98 envíos Google figuraban como enviados. Las agrupaciones no incluyen los registros sin endpoint de proveedor reconocible.
- Las llaves VAPID activa pública/privada corresponden criptográficamente.
- El servicio usaba el contacto de respaldo `mailto:admin@phytoemagry.local`, sin un subject explícito en Easypanel. El rechazo de autenticación está probado; el motivo específico del cuerpo HTTP no se almacenaba en la versión publicada. No se afirma `BadJwtToken` sin capturarlo.

Cambio de producción aplicado:

- Se fijó `PHYTO_WEB_PUSH_SUBJECT=https://phytoemagryrd.lat` en el servicio Swarm activo. La estrategia ya configurada era `start-first`.
- Se guardó el mismo valor mediante la API documentada `updateAppEnv` de Easypanel, conservando las demás variables y `dotEnvPath`; se verificó que el resto de campos del servicio quedó igual. Se usó una sesión administrativa disponible exclusivamente dentro del servidor; ninguna credencial se imprimió ni se copió al workspace.
- Tras la actualización se comprobó el nuevo subject en el contenedor activo, las llaves correspondientes y respuesta HTTP 200 de `/api/health` y `/admin/`.
- No se regeneraron llaves, borraron suscripciones, modificaron pedidos ni enviaron mensajes WhatsApp. Los cambios amplios de código/diagnóstico de esta rama aún no se desplegaron: la intervención en producción fue únicamente la configuración VAPID.
- Se dejó respaldo privado de la especificación Swarm en `/root/phytoemagry-push-20261016T215456Z/service-before.json` y del registro de configuración Easypanel en `/etc/easypanel/data/phyto-push-service-before-20261016.json`, con permisos restrictivos.
- Se cambió también el respaldo del servidor en esta rama y el valor de ejemplo/Compose al dominio público verificado para prevenir la reincidencia por falta de variable.

Pendiente: autorización explícita para enviar la prueba real a los dos iPhones registrados. No se envió esa prueba durante la auditoría. La corrección de configuración está activa; su efecto sobre la aceptación por Apple y la presentación física todavía requiere un nuevo envío. Las 46 pruebas locales y la validación de Compose pasan.
