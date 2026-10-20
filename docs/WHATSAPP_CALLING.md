# Llamadas por WhatsApp desde el CRM

## Uso

En una conversación autorizada, pulsa el teléfono «Llamar por WhatsApp».
Solicita permiso si el cliente todavía no lo concede. Cuando lo acepte en
WhatsApp, actualiza el permiso y pulsa «Llamar por WhatsApp». El navegador
solicita micrófono; usa auriculares y mantén el CRM abierto durante la llamada.
Puedes silenciar, colgar o cerrar el diálogo sin finalizar la llamada; el botón
flotante permite regresar a los controles. Las llamadas entrantes autorizadas
se muestran allí con opciones para contestar y rechazar.

Al cerrar la pestaña se intenta colgar con una petición `keepalive`. Si se pierde
la conexión, el servidor termina las llamadas sin heartbeat después de 45 s.
La recepción con el navegador o la app cerrados no forma parte de esta versión.

## Requisitos y configuración

- Número únicamente Cloud API; llamadas habilitadas en Meta.
- App suscrita al WABA y al campo `calls`, conservando `messages`.
- HTTPS, micrófono permitido para el propio CRM y webhook con firma comprobable.
- PostgreSQL o SQLite. El módulo no se activa con almacenamiento JSONL.
- Credenciales de WhatsApp y `META_APP_SECRET` solo en el servidor.

Variables adicionales de ejecución:

```dotenv
WHATSAPP_CALLING_ENABLED=1
WHATSAPP_CALLING_GRAPH_VERSION=v21.0
WHATSAPP_CALLING_PERMISSION_TEMPLATE=phyto_permiso_llamada_v1
WHATSAPP_CALLING_PERMISSION_LANGUAGE=es
WHATSAPP_CALLING_ICE_SERVERS=[]
```

La versión Graph de llamadas se puede ajustar sin cambiar la de mensajes.
Para redes que bloquean UDP o el acceso directo a Meta, configura servidores
TURN propios en `WHATSAPP_CALLING_ICE_SERVERS`, en formato de configuración
WebRTC. Se entregan únicamente a usuarios autenticados con permiso de chat.
No se garantiza conectividad en toda red sin probar su política de firewall.

Dentro de la ventana de atención de 24 h, el permiso se solicita con un mensaje
interactivo. Fuera de ella se usa la plantilla configurada: debe estar aprobada,
tener el componente `call_permission_request` y no contener parámetros de texto.
El servidor revalida aprobación y lenguaje antes de enviar. Si falta plantilla
aprobada, el cliente debe escribir primero para abrir la ventana. Nunca se
considera autorizado al cliente solo por tener una conversación abierta.

## Preparación de Meta

El script siguiente conserva la URL del webhook existente y sus campos. No
cambia credenciales y no envía mensajes a clientes. Lee explícitamente el archivo
indicado; las variables del proceso tienen prioridad.

```powershell
# Solo verificar suscripciones y ajustes:
node scripts/configure-whatsapp-calling.mjs --env-file ../PHYTOEMAGRY/.env

# Habilitar llamadas, añadir calls sin quitar messages y solicitar plantilla:
node scripts/configure-whatsapp-calling.mjs --env-file ../PHYTOEMAGRY/.env --apply --create-template

# Mostrar icono de llamadas entrantes cuando el backend ya esté desplegado:
node scripts/configure-whatsapp-calling.mjs --env-file ../PHYTOEMAGRY/.env --apply --show-icon
```

La aprobación de la plantilla depende de Meta. El primer comando de activación
oculta el icono para permitir configurar y probar antes de recibir llamadas.

## Datos, permisos y seguridad

Tablas aditivas: `phytoemagry_calls_v1`, `phytoemagry_call_locks_v1` y
`phytoemagry_call_events_v1`. No se modifican las tablas comerciales existentes.
Las reservas y los cambios de estado usan operaciones atómicas SQL. Se limita
a una llamada simultánea por agente y conversación. Los reintentos con el mismo
id de operación no generan otra llamada.

El destinatario se resuelve desde el cliente de la conversación en el servidor;
el navegador no puede suministrar otro teléfono. Las rutas exigen sesión,
permiso `chats.reply`, acceso efectivo a la conversación y control de origen para
operaciones POST. Cada llamada activa pertenece a quien la inició o respondió.
El SDP se entrega solo a ese agente, o a un agente autorizado antes de contestar.

Los eventos de llamadas se validan con firma, WABA y phone number ID y se guardan
antes de responder HTTP 200. Un worker recupera pendientes tras reinicios. Los
eventos duplicados no duplican llamadas y los eventos tardíos no reabren sesiones
terminadas. El SDP se conserva solo durante el establecimiento (máximo 120 s en
una sesión activa); se elimina del evento al procesarlo y de la llamada al
terminar. Los eventos procesados conservan solo su huella para deduplicar. Las
huellas caducan a los siete días. No se graba ni transcribe audio.

Una operación de Meta con respuesta incierta no se reenvía automáticamente.
Se conserva su id local para reconciliar el webhook. El historial distingue
estados de llamada y duración reportada por Meta; no deduce una conversación
conectada únicamente de un HTTP 200 de inicio.

## Validación

```powershell
npx vitest run tests/calling-integration.test.js tests/calling-panel.test.js tests/whatsapp-calling.test.js
npm run verify:deploy
```

Las pruebas con mocks verifican estados, permisos, controles, reintentos,
concurrencia y liberación del micrófono. No sustituyen una llamada real con audio
bidireccional. Antes de considerar concluida la puesta en servicio deben
probarse permiso, llamada saliente, recepción, silencio, colgado y reconexión
en los equipos y redes de uso real.

## Fuentes técnicas oficiales

- https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-call-permissions/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/reference/

Los contratos se verificaron en el navegador el 2026-10-16. El endpoint de permiso
publica `temporary`, `permanent`, `no_permission` y acciones `start_call` y
`send_call_permission_request`; se respetan sus límites actuales, sin fijar en
código las cifras de documentos antiguos.
