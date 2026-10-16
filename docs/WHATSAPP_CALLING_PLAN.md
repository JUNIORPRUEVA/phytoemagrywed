# Integración de llamadas de WhatsApp: requisitos y plan

Revisión: 2026-10-16. Estado: módulo implementado; pendiente validación real y puesta en servicio.

La guía vigente de uso y operación está en [WHATSAPP_CALLING.md](WHATSAPP_CALLING.md).
Este documento conserva el análisis previo; las verificaciones pendientes se actualizan abajo.

## Entorno de trabajo

- Rama: `feat/whatsapp-calling`.
- Worktree: `../PHYTOEMAGRY-whatsapp-calling`.
- Base inicial: commit `54f9108` de `main`.
- Los cambios sin commit de la carpeta original no se copiaron. Antes de integrar,
  actualizar esta rama con los cambios que finalmente se confirmen en `main` y
  repetir las pruebas sobre el resultado combinado.
- No se copiaron `.env`, bases de datos ni credenciales de producción al worktree.
- Se realizaron consultas autenticadas de solo lectura a Meta. No se enviaron
  mensajes, no se iniciaron llamadas y no se activaron ajustes.

## Resultado de la comprobación inicial

El usuario confirmó que el número usa solo Cloud API.

- `GET /v21.0/<PHONE_NUMBER_ID>/settings`: HTTP 200, `calling.status=NOT_SET`,
  `call_icon_visibility=NOT_SET`. No hay SIP habilitado en la respuesta.
- `GET /v21.0/<WABA_ID>/subscribed_apps`: la app configurada sí está suscrita.
- No se verificó aún el campo `calls` de la suscripción de la app, el límite de
  mensajería, las restricciones de país aplicables ni la elegibilidad completa.
- Una respuesta HTTP 200 valida acceso a esa consulta, no la disponibilidad
  definitiva de llamadas salientes o entrantes.

### Diagnóstico reproducible

```powershell
# Solo configuración local; sin red y sin leer .env automáticamente:
node scripts/check-whatsapp-calling.mjs

# Lectura explícita del .env original y consultas GET a Meta:
node scripts/check-whatsapp-calling.mjs --env-file ../PHYTOEMAGRY/.env --online
```

El script no imprime identificadores, tokens, claves SIP ni errores crudos de
Meta. Las variables del proceso tienen prioridad sobre el archivo. El código
de salida es 0 si las comprobaciones implementadas pasan, 1 si falta
configuración o falla una consulta y 2 si la consulta funciona pero detecta
condiciones pendientes. Incluso con salida 0 queda pendiente la validación de
eventos, elegibilidad y audio: no representa una certificación de funcionamiento.
No habilita llamadas ni modifica el CRM.

Se puede fijar `WHATSAPP_CALLING_GRAPH_VERSION` únicamente para este diagnóstico;
no cambia la versión del cliente de mensajería existente.

Pruebas relevantes: `npx vitest run tests/whatsapp-calling.test.js
tests/whatsapp-webhook.test.js tests/conversations.test.js`. Las suites del CRM
usan bases temporales y clientes de WhatsApp simulados.

## Objetivo funcional propuesto

El agente debe poder llamar a un cliente por WhatsApp y atender llamadas desde
la conversación del CRM, con micrófono y auriculares. El cliente permanece en
WhatsApp. `tel:` y abrir un chat con `wa.me` no cumplen este objetivo.

Primera versión propuesta: navegador de escritorio, voz individual, llamada
manual, permiso del cliente, contestar, rechazar, silenciar, colgar e historial.
Sin grabación, transcripción, transferencias ni llamadas automáticas en esta
primera versión. Android WebView y recepción con la app cerrada requieren una
validación separada; una PWA instalada no garantiza recepción en segundo plano.

## Verificaciones externas pendientes

1. Confirmar si el número utiliza únicamente Cloud API o coexistencia con la
   aplicación WhatsApp Business. No inferir compatibilidad de llamadas a partir
   de que los mensajes funcionen; comprobar el soporte concreto antes de activar.
2. Confirmar número y WABA efectivos de producción, país del número, verificación
   comercial, elegibilidad y disponibilidad del servicio de llamadas.
3. Consultar los ajustes reales de llamadas del número y permisos del token.
   Contar con un token de mensajes no demuestra autorización para todas las
   operaciones de configuración de llamadas.
4. Confirmar versión Graph soportada por los endpoints elegidos. El código
   actual usa `v21.0` por defecto: no cambiarla globalmente sin pruebas de mensajes,
   plantillas y multimedia.
5. Verificar HTTPS público, suscripción a los eventos de llamadas y firma del
   webhook. La ausencia de `WHATSAPP_WEBHOOK_URL` en el `.env` local no demuestra
   que falte el webhook en Meta: esa variable es informativa en el código actual.
6. Confirmar facturación y tarifas vigentes antes del piloto real. Separar tarifas
   de Meta, posibles cargos del proveedor y costos de infraestructura.
7. Disponer de un cliente de prueba que conceda permiso de llamada y un agente
   de prueba; no probar sobre la lista de clientes reales.

La documentación de Twilio exige, para su integración, verificación comercial y
un límite de mensajería de al menos 2.000 conversaciones iniciadas por el negocio
en 24 horas. Esto es capacidad de la cuenta, no volumen que haya que enviar.
Confirmar las condiciones aplicables a la integración directa en la cuenta real.
Las fuentes consultadas no coinciden completamente en las exclusiones por país;
validar el país del número directamente con Meta o el proveedor elegido.

## Diagnóstico local sin revelar secretos

En `.env` de la carpeta original están declarados valores para `META_APP_ID`,
`META_APP_SECRET`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_ACCESS_TOKEN` y `WHATSAPP_VERIFY_TOKEN`. No se comprobó su vigencia.
No hay valores declarados allí para `WHATSAPP_WEBHOOK_URL`,
`WHATSAPP_GRAPH_VERSION` ni `PHYTO_META_GRAPH_VERSION`. El entorno de despliegue
puede suministrar valores diferentes; esta revisión no lo consultó.

## Arquitectura propuesta

Preferencia inicial: extender la integración oficial directa con Meta ya usada
por el proyecto. Evaluar un proveedor con SDK de voz si simplifica de forma
material la conectividad y operación; no contratar ni migrar el número durante
la preparación.

Flujo de referencia:

`Agente en CRM (WebRTC) <-> servicio de señalización del CRM <-> Meta Calling API <-> cliente en WhatsApp`

La señalización intercambia ofertas/respuestas SDP; el audio usa la conexión de
medios negociada. Los eventos SSE actuales pueden transportar avisos, pero no
transportan audio. Definir conectividad ICE/STUN/TURN según la arquitectura y
las pruebas de redes; un gateway multimedia es una alternativa, no un requisito
demostrado de este repositorio.

### Cambios previstos

| Área | Trabajo |
| --- | --- |
| Cliente Meta | Módulo separado para ajustes, permisos y acciones de llamada; timeouts y errores saneados |
| Webhook | Interpretar eventos de llamadas y permisos, validar firma, número y WABA; persistir antes de confirmar recepción |
| Datos | Colecciones de llamadas, permisos y eventos; identificadores únicos y deduplicación |
| Dominio | Máquina de estados; impedir regresión por eventos tardíos; recuperar tras reinicios |
| API del CRM | Rutas autenticadas, CSRF, permisos por agente y acceso a la conversación |
| Concurrencia | Reserva atómica de la llamada para evitar dos agentes atendiendo lo mismo |
| Panel | Controles de audio y llamada, avisos de permiso, error y desconexión |
| Eventos | Reutilizar SSE con filtrado por usuario; no exponer SDP a agentes sin acceso |
| Despliegue | Variables del servicio de voz, HTTPS y políticas de micrófono en la ruta efectiva |
| Android | Permiso RECORD_AUDIO, concesión del WebView limitada al origen autorizado y pruebas en dispositivo |

Los tokens permanecen en el servidor. No guardar SDP en logs o historial de
negocio. No permitir que el navegador elija libremente un número destinatario:
resolverlo desde la conversación autorizada en el servidor. Consultar permiso
vigente en Meta antes de llamar y reflejar revocaciones y expiración. El permiso
para mensajes o la ventana de atención de 24 horas no sustituyen el de llamadas.

## Correcciones vinculadas y límites de alcance

- Para llamadas, rechazar webhooks sin firma verificable; actualmente el servidor
  acepta eventos si falta el secreto. Definir transición compatible con los
  entornos de pruebas y con la recepción de mensajes existente.
- Guardar eventos de llamadas en una bandeja durable antes de responder `200` y
  procesarlos con reintentos; no depender de memoria para una llamada entrante.
- Auditar el permiso efectivo del agente antes de mostrar o ejecutar acciones.
- El acceso por sesión a `/api/crm/items` y `/api/crm/export.csv`, detectado en la
  auditoría estática, se debe reproducir y corregir en un cambio delimitado.
  No mezclar una refactorización general del CRM con el módulo de voz.
- Revisar la política de micrófono efectiva: hay `microphone=()` a nivel servidor
  en Nginx, pero `/admin/` declara sus propias cabeceras. No afirmar bloqueo del
  panel sin comprobar la herencia de cabeceras y la respuesta del despliegue.

## Secuencia de implementación y validación

1. Preparación (este documento): worktree aislado, inventario y pendientes.
2. Prueba técnica aislada: verificar elegibilidad y completar una llamada de
   audio bidireccional con un contacto de prueba. Resolver transporte antes de
   construir toda la interfaz.
3. Backend: cliente Meta, persistencia, permisos, estados, eventos y reserva por
   agente; módulo desactivado por defecto y configuración de pruebas separada.
4. Interfaz: controles en la conversación y audio WebRTC; errores recuperables,
   liberación del micrófono al terminar, navegación y reconexión.
5. Pruebas: mocks sin red real, integración HTTP con bases temporales y pruebas
   manuales de audio en Chrome/Edge. Validar Android aparte si entra en alcance.
6. Piloto: habilitar únicamente para agentes y contacto de prueba designados;
   registrar resultados de las llamadas reales.
7. Integración: actualizar la rama con `main`, resolver conflictos, ejecutar la
   validación combinada y recién entonces integrar los commits de llamadas.

### Criterios para considerar terminada la integración

- Llamada saliente autorizada con audio bidireccional; bloqueo si se rechaza,
  revoca o vence el permiso.
- Recepción y asignación de una llamada entrante; una sola aceptación aunque
  dos agentes intenten responder a la vez.
- Rechazar, colgar, silenciar y liberar micrófono; tratar cortes de red y cierre
  de pestaña sin dejar sesiones activas indefinidamente.
- Webhooks duplicados, tardíos o falsificados no crean llamadas duplicadas ni
  modifican llamadas ajenas.
- Historial consistente de llamada contestada, rechazada, perdida o fallida,
  sin credenciales, SDP ni audio grabado.
- Mensajería, multimedia, asignación y autenticación existentes conservan su
  comportamiento; pruebas relevantes y build pasan en el worktree.
- Sin llamadas reales si falta configuración o el módulo está deshabilitado.
- No declarar validado audio real únicamente porque pasen pruebas con mocks.

## Fuentes consultadas

- Meta, anuncio y funciones de Calling API:
  https://whatsappbusiness.com/blog/whatsapp-business-calling-api/
- Twilio, requisitos, flujos de voz y restricciones:
  https://www.twilio.com/docs/voice/whatsapp-business-calling
- AWS, disponibilidad y configuración:
  https://docs.aws.amazon.com/end-user-messaging/latest/userguide/nx-features-whatsapp-voice.html
- AWS, permiso específico de llamadas:
  https://docs.aws.amazon.com/end-user-messaging/latest/userguide/nx-features-whatsapp-voice-permission.html
- Documentación técnica de Meta que se debe contrastar antes del adaptador:
  https://developers.facebook.com/docs/whatsapp/cloud-api/calling/

En la investigación inicial, el acceso automatizado a la documentación técnica de Meta devolvió errores o
limitación de acceso durante la investigación. No se considera validado el
contrato exacto de endpoints y payloads por esa vía. Obtenerlo antes de escribir
el adaptador definitivo; no basarlo en ejemplos no oficiales sin contrastarlos.


## Avance de implementación

- Contratos oficiales verificados en el navegador, incluyendo señalización y permisos.
- Implementados cliente Meta, almacenamiento SQL, worker de webhooks, reservas
  atómicas, rutas autenticadas y controles WebRTC en el panel.
- Soporte de micrófono implementado en Android; análisis y 20 pruebas Flutter
  correctos; APK release compilado.
- Meta: llamadas ENABLED, suscripción calls confirmada y messages preservada.
  Icono entrante oculto durante la puesta en servicio. Plantilla de permiso
  creada en estado PENDING al comprobarla inicialmente.
- 41 pruebas específicas de diagnóstico, backend y panel de llamadas correctas.
- Suite completa inicial del cambio: 1027 correctas, 25 fallidas y 2 omitidas.
  Repetición sobre 1701b3f, antes del módulo: 1012 correctas, las mismas 25 fallidas
  y 2 omitidas. No se cambiaron esas pruebas ajenas a esta integración.
- 99 pruebas relevantes de llamadas, mensajería, webhook y permisos correctas
  antes de agregar cuatro casos adicionales de regresión de llamadas.
- Build web y comprobaciones de publicación correctos. El build local sin .env
  muestra las advertencias esperadas por configuración pública ausente.
- Rama publicada y desplegada en el servicio `ventas/phytoemagrywed` de Easypanel.
  `main` continúa intacta, sin fusión de la rama de llamadas.
- Estado final de configuración comprobado: llamadas ENABLED, icono DEFAULT,
  app suscrita al WABA y campo calls verificado. Plantilla de permiso APPROVED.
- Se verificó en el CRM publicado el envío y entrega de la solicitud de permiso
  a un contacto de prueba autorizado; Meta confirmó el permiso concedido.
- Pendiente: validar audio bidireccional. Chrome no completó la captura de
  micrófono durante el primer intento. Se añadieron mensajes de preparación y
  tiempo máximo para evitar una espera indefinida. No se da por validada una
  llamada que no haya conectado audio real.
- No integrar a main hasta terminar la validación funcional acordada.
