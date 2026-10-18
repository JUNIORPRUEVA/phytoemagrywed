# WhatsApp, inventario y errores intermitentes — corrección (2026-10-18)

## 1. Causa de los avisos contradictorios

Dos mensajes escritos a mano en dos pantallas, alimentados por el MISMO booleano:

- lista de chats: «WhatsApp todavía no está configurado… el panel no envía ni recibe mensajes»;
- dentro del chat: «…se reciben mensajes, pero no se pueden enviar».

Los dos se pintaban cuando `state.whatsapp.configured` era falso o ausente, y afirmaban cosas
distintas. Además ese booleano solo significaba «hay token y phone number id escritos»: no distinguía
token rechazado, Meta caído ni entorno simulado.

**Estado real verificado contra Meta (solo lectura, 2026-10-18):**

| Comprobación | Resultado |
| --- | --- |
| `GET /{phone-number-id}` | `status: CONNECTED`, calidad `GREEN` |
| `webhook_configuration.application` | `https://phytoemagryrd.lat/api/webhooks/whatsapp` |
| `GET /{WABA}/message_templates` | 200 (16 plantillas: 13 aprobadas + 3 nuevas en revisión) |
| Debug del token | usuario de sistema, válido, sin caducidad, con `whatsapp_business_management` |

→ WhatsApp **sí está configurado** en el entorno cuyo `.env` se usó: el aviso era del panel, no de Meta.
Con las mismas credenciales, el CRM ahora reporta `send: ok`, `receive: ok`, `checked: live`.

## 2. Lo que se corrigió

### Una sola fuente de verdad (`server/whatsapp-status.mjs`)

Comprueba de verdad contra Meta con `listTemplates()` (GET, sin enviar nada), en caché de 60 s y en
segundo plano: abrir el panel nunca espera a Meta. Estados separados:

`send`: `ok` · `mock` · `not_configured` · `token_invalid` · `unknown`
`receive`: `ok` · `not_configured`
`reason`: `missing_credentials` · `missing_webhook_config` · `token_invalid` · `unreachable` · `meta_error`

Se expone en `/api/admin/data`, `/api/admin/conversations` y `/api/admin/session`. **Un timeout ya no
se convierte en «falta configuración».**

### Un único aviso en el panel (`waConnectionNotice()` en `app.js`)

Lista y chat usan la misma función: sin conexión → se dice eso; estado desconocido → «no se pudo
verificar»; credencial rechazada → se nombra; un solo lado caído → se dice cuál; todo bien → **no se
muestra nada**. El compositor solo se oculta cuando el envío está realmente deshabilitado.

### Inventario: tres resultados inequívocos

| Situación | Qué dice ahora |
| --- | --- |
| Servidor confirma | «Inventario actualizado.» |
| Sin conexión, entra en la cola local | «Guardado en el dispositivo · pendiente de sincronizar.» |
| Rechazado (permisos / conflicto / stock) | motivo concreto: «Otro usuario cambió el stock mientras contabas…», «Tu cuenta no puede cambiar el inventario», «Stock insuficiente de …» |
| Sin respuesta del servidor | «El servidor falló al guardar. El cambio NO se aplicó; vuelve a intentarlo.» |

Otros arreglos del mismo camino:

- **El aviso sobrevivía mal al tiempo real**: el SSE repintaba el inventario justo después de guardar y
  borraba el mensaje (parecía que no había guardado). Ahora el texto se conserva entre repintados.
- **El ajuste sin conexión dependía de una copia incompleta**: si `/api/admin/inventory` no traía el
  bloque del producto, el espejo local RECHAZABA el ajuste con «Descarga primero el inventario» y la
  operación se perdía. Ahora la referencia local es el catálogo (el saldo de cápsulas que se ve).
- **Recuento por su ruta**: el recuento de cápsulas se enviaba a `/inventory/adjust`, que solo entiende
  entrada/salida (un recuento habría sumado). Va a `/inventory/count`, que fija el valor contado.
- Un `fetch` rechazado ya no muestra «Failed to fetch»: se distingue falta de red de error del servidor.

## 3. Pruebas

- `tests/whatsapp-status.test.js` (nuevo, 8): sin credenciales, solo envío, todo bien, **timeout ≠ no
  configurado**, token 190/401, 500, modo local, y que el snapshot no espera a Meta.
- Suites afectadas: 11 archivos, **153 pruebas verdes** (offline 24 h, panel offline, worker, store,
  catálogo, shell, mensajes, WhatsApp, conversaciones, webhook).
- Supervisor y reparto: 5 archivos, **95 verdes** (sin regresión).
- UAT Chromium con emulación Android (412×915) contra UAT aislada 8811:
  - lista: un solo aviso («modo local»), sin textos contradictorios;
  - chat: abre, compositor disponible, sin aviso dentro;
  - inventario: en línea «actualizado», sin conexión «pendiente de sincronizar», conflicto con motivo.
- **Pendiente de verificar en teléfono real**: producción sirve `app.js?v=consolidado-141` / `sw.js
  crm-v147`; el árbol corregido va en `wa-estado-real-149` / `crm-v163`. Hasta desplegar, el teléfono
  seguirá mostrando el aviso viejo.

## 4. Fallo ajeno a este cambio (no tocado)

`tests/mobile-startup.test.js` espera que la instalación del service worker FALLE cuando falta un
archivo esencial. Otra sesión cambió `sw.js` (sin commitear) para que **nunca** falle (anota `missing` y
sigue), y ese cambio es deliberado: sin él el panel se quedaba sin service worker. La prueba quedó
obsoleta; no se modificó.
