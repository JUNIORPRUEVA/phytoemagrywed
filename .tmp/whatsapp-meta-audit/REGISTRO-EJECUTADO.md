# Ejecución controlada del registro en Cloud API — resultado (evidencia saneada)

Fecha: 2026-09-30 · **Sin PIN, sin tokens, sin secretos en este archivo.**

Autorizado y ejecutado: `POST /{WABA}/subscribed_apps` (1) y `POST /{PHONE_NUMBER_ID}/register` (1).
Nada más se modificó: ni código, ni producción, ni base de datos, ni webhook, ni versión de Graph.

---

## 1. PREFLIGHT

| Comprobación | Resultado |
| --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | PRESENTE (202 car.) — valor no mostrado |
| `code_verification_status` | **VERIFIED** ✔ |
| `status` | PENDING |
| `platform_type` | NOT_APPLICABLE |
| `throughput.level` | NOT_APPLICABLE |
| `last_onboarded_time` / `messaging_limit_tier` | vacíos |
| `name_status` | PENDING_REVIEW |
| `account_mode` | LIVE |
| `subscribed_apps` | **`[]`** |

Evidencia de registro previo: **ninguna** → autorizado continuar.

## 2. SUSCRIPCIÓN DEL WABA

`POST /2559517617897858/subscribed_apps` → **HTTP 200** · `{"success":true}`

`GET /2559517617897858/subscribed_apps` → **HTTP 200**:

```json
{"data":[{"whatsapp_business_api_data":{"link":"https://www.facebook.com/games/?app_id=998220578866944","name":"FULLTECH BOT","id":"998220578866944"}}]}
```

**FULLTECH BOT (998220578866944) suscrita: SÍ.**
(Nota: la app aparece anidada en `whatsapp_business_api_data`; un primer verificador propio
dio un falso STOP por leer `id`/`name` en la raíz. Corregido y re-verificado.)

## 3. REGISTRO

`POST /1410599278794907/register` → **HTTP 200** · **`success: true`**
El PIN se introdujo en la terminal por el usuario, sin eco, y **no** se guardó ni se imprimió
(ni en este archivo, ni en el código, ni en el historial, ni en los logs).

## 4. ESTADO POST-REGISTRO (GET, no forzado)

| CAMPO | ANTES | DESPUÉS |
| --- | --- | --- |
| `code_verification_status` | VERIFIED | VERIFIED |
| **`status`** | PENDING | **BANNED** |
| **`platform_type`** | NOT_APPLICABLE | **CLOUD_API** |
| **`throughput`** | NOT_APPLICABLE | **STANDARD** |
| `last_onboarded_time` | (vacío) | (vacío) |
| `name_status` | PENDING_REVIEW | PENDING_REVIEW |
| `account_mode` | LIVE | LIVE |
| `quality_rating` | UNKNOWN | UNKNOWN |
| `messaging_limit_tier` | (vacío) | (vacío) |
| `is_official_business_account` | false | false |

Confirmado con **dos** lecturas independientes: `status: BANNED` (no `CONNECTED`).

## 5. WEBHOOK

`GET /2559517617897858/subscribed_apps` → FULLTECH BOT presente: **SÍ** (se mantiene).

## 6. PRODUCCIÓN

- `https://phytoemagryrd.lat/api/health` → **HTTP 200 ×3**, `ok=true`, `storage=postgres`.
- Contenedor `ventas_phytoemagrywed.1.huvamcs0qpvbodk0r0qhif149` → **healthy**, **0 reinicios**.
- Logs: **sin** errores de WhatsApp, Graph, webhook ni `OAuthException`.
- ⚠️ **1 error 500 detectado**: `GET /api/admin/data` → 500. Causa en el log de la app:
  `error: column "wa_message_id" does not exist`.

### Causa del 500 (diagnóstico, solo lectura)

`phytoemagry_messages` **no es la tabla de mensajes de WhatsApp**: es una tabla **legacy** con
esquema genérico (`id, name, body, position, updated_at`) — probablemente del sistema de
contenido antiguo.

Las tablas que sí creó el código nuevo: `phytoemagry_customers`, `phytoemagry_conversations`,
`phytoemagry_items`, `phytoemagry_messages`.

El código nuevo (`server/collections.mjs`) espera y consulta `wa_message_id`
(`server/customers.mjs` lo usa en `findBy`/inserts, y hay un índice único
`(wa_message_id, idempotency_key)`). Al **colisionar el nombre** con la tabla legacy, la
creación de la colección no aplicó el esquema nuevo → cualquier consulta que toque mensajes
falla → `/api/admin/data` (que alimenta el panel en una sola petición) devuelve **500**.

Por eso no lo detectaron los tests: usan una base temporal limpia, sin tabla legacy.

**No se ha modificado nada** para arreglarlo (fuera del alcance autorizado).
