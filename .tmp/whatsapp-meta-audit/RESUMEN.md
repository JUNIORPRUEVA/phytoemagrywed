# Auditoría WhatsApp Cloud API — evidencia (solo lectura)

Fecha: 2026-09-30 · Modo: **solo lectura** (únicamente peticiones `GET` a la Graph API y
pruebas HTTP al webhook). No se modificó nada en Meta, ni en el número, ni en el WABA,
ni en el webhook, ni en producción.

**Este archivo no contiene tokens, secretos ni URLs con credenciales.**

---

## 1. Credenciales del entorno (presencia y huella, nunca el valor)

| Variable | Estado | Huella |
| --- | --- | --- |
| META_APP_ID | PRESENTE | 15 caracteres (coincide con `998220578866944`) |
| META_APP_SECRET | PRESENTE | 32 car. · sha256:49b814d86e |
| WHATSAPP_BUSINESS_ACCOUNT_ID | PRESENTE | coincide con `2559517617897858` |
| WHATSAPP_PHONE_NUMBER_ID | PRESENTE | coincide con `1410599278794907` |
| WHATSAPP_PHONE_NUMBER | PRESENTE | coincide con `+18494240621` |
| WHATSAPP_ACCESS_TOKEN | PRESENTE | 207 car. · sha256:8201868f76 |
| WHATSAPP_VERIFY_TOKEN | PRESENTE | 64 car. · sha256:ff8932a6a6 |

Local (`assets/.env`) y **producción tienen exactamente las mismas credenciales**
(huellas idénticas) → esta auditoría aplica a producción.

---

## 2. Hallazgo principal: el token de WhatsApp es el token de la CAPI

`GET /debug_token` (auto-consulta del propio token) devuelve:

```json
{
  "app_id": "968867954936743",
  "type": "SYSTEM_USER",
  "application": "Conversions API Application",
  "is_valid": true,
  "expires_at": 0,
  "scopes": ["read_ads_dataset_quality"],
  "granular_scopes": [
    { "scope": "read_ads_dataset_quality", "target_ids": ["2215831389345467"] }
  ],
  "user_id": "122210667584385562"
}
```

- El token pertenece a la app **968867954936743 («Conversions API Application»)**, NO a
  **FULLTECH BOT (998220578866944)**.
- Sus permisos son **solo `read_ads_dataset_quality`** (el dataset/píxel
  `2215831389345467`). **No tiene** `whatsapp_business_messaging` ni
  `whatsapp_business_management` ni `business_management`.
- `WHATSAPP_ACCESS_TOKEN` y `PHYTO_META_CAPI_ACCESS_TOKEN` tienen **el mismo valor**
  (misma huella sha256:8201868f76, 207 caracteres): el token de WhatsApp es una copia
  del token de la API de Conversiones.

### Lecturas con ese token (todas fallan, como corresponde a un token ajeno al WABA)

| Consulta | Resultado |
| --- | --- |
| `GET /2559517617897858` (WABA) | 400 · code 100 · subcode 33 (sin permisos / no accesible) |
| `GET /2559517617897858/phone_numbers` | 403 · code 200 `You do not have permission to access this field` |
| `GET /1410599278794907` (número) | 400 · code 100 · subcode 33 |
| `GET /1410599278794907/whatsapp_business_profile` | 400 · code 100 · subcode 33 |
| `GET /2559517617897858/subscribed_apps` | 403 · code 200 |
| `GET /me/permissions` | solo `read_ads_dataset_quality` (granted) |
| `GET /me/businesses` | 400 · code 100 Missing Permission |

Con la misma token-version que usa la suscripción (v25.0) los resultados son idénticos.

### Lecturas con el **app access token** (`APP_ID|APP_SECRET`, que sí es correcto)

| Consulta | Resultado |
| --- | --- |
| `GET /{WABA}` | 401 · code 190 Authentication Error |
| `GET /{PHONE_NUMBER_ID}` | 400 · **code 102 «A user access token is required to request this resource»** |
| `GET /{WABA}/phone_numbers` | 403 · code 200 |

`code 102` es la respuesta oficial cuando se pide un nodo de WhatsApp sin token de
usuario/sistema: **no existe ningún camino de lectura del número con las credenciales
actuales**.

---

## 3. Lo que SÍ está correcto (token de app y webhook)

`GET /998220578866944` (app) → **200** `{"id":"998220578866944","name":"FULLTECH BOT"}`

`GET /998220578866944/subscriptions` (app token) → **200**:

```json
[
  {
    "object": "whatsapp_business_account",
    "callback_url": "https://phytoemagryrd.lat/api/webhooks/whatsapp",
    "active": true,
    "fields": [{ "name": "messages", "version": "v25.0" }]
  }
]
```

→ La app **FULLTECH BOT** es la suscrita, el callback es el nuestro, está **activo** y el
campo **`messages`** está suscrito (en v25.0).

Pruebas HTTP al webhook de producción (sin imprimir el verify token):

| Prueba | Resultado |
| --- | --- |
| `GET` con el verify token real | **200** y devuelve el challenge |
| `GET` con verify token falso | **403** |
| `POST` con firma inválida | **401** `invalid_signature` |
| Verificación de Meta en los logs | `facebookplatform/1.0` → **GET 200** (verificado por Meta) |

---

## 4. Hallazgo de seguridad: el verify token queda escrito en los logs

El access log de nginx registra la URL completa de la verificación de Meta, y el
`hub.verify_token` viaja como parámetro de consulta → **el valor del verify token aparece
en texto plano en los logs del contenedor** (y en cualquier recolector de logs).

- No es un token que dé acceso a la mensajería, pero sí permite a quien lo lea
  responder la verificación del webhook.
- Recomendación (no ejecutada): **rotar `WHATSAPP_VERIFY_TOKEN`** y dejar de registrar la
  query string en esa ruta (`access_log off;` o un `log_format` sin `$request` para
  `location = /api/webhooks/whatsapp`).

---

## 5. Estado del número (lo que NO se pudo verificar por API)

Los campos que responderían a «¿por qué PENDIENTE?» (`status`, `name_status`,
`code_verification_status`, `platform_type`, `quality_rating`, `health_status`) **no se
pueden leer** con las credenciales actuales (ver §2). Queda pendiente de confirmar con un
token correcto:

```bash
# PROPUESTA (NO ejecutada): con un token de FULLTECH BOT que tenga
# whatsapp_business_messaging + whatsapp_business_management
curl -s "https://graph.facebook.com/v25.0/1410599278794907?fields=id,display_phone_number,verified_name,code_verification_status,platform_type,name_status,status,health_status,quality_rating,account_mode,messaging_limit_tier" \
  -H "Authorization: Bearer <TOKEN_CORRECTO>"
```

Evidencia indirecta disponible (no de la API):

- Un WhatsApp normal no encuentra el número → el número **no está operativo** todavía.
- El webhook está suscrito y activo (la app tiene el WABA asignado).
- Meta Business muestra «Número: Pendiente» y «Nombre visible: En revisión».

Esto es compatible con: número **añadido al WABA**, nombre en revisión y **registro para
Cloud API no completado** (o verificación del número pendiente). No es una hipótesis
demostrada por API: falta el token correcto para confirmarlo.

---

## 6. Archivos de esta auditoría

- `graph-api.json` — todas las respuestas (saneadas) de las consultas del WABA/número/app.
- `graph-api-2.json` — token (debug), permisos, negocios, v25.0 y suscripciones.
- `RESUMEN.md` — este resumen.

Sin tokens ni secretos en ninguno de ellos.
