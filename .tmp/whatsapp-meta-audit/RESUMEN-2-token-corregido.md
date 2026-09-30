# Reintento con el token corregido — evidencia (solo lectura)

Fecha: 2026-09-30 · Modo: **solo lectura** (únicamente `GET` a la Graph API + lectura de logs).
**Sin tokens ni secretos en este archivo.** Nada modificado en Meta.

---

## 1. El token nuevo SÍ es el correcto

`GET /debug_token` (auto-consulta):

```json
{
  "app_id": "998220578866944",
  "application": "FULLTECH BOT",
  "type": "SYSTEM_USER",
  "is_valid": true,
  "expires_at": 0,
  "scopes": [
    "whatsapp_business_management", "whatsapp_business_messaging",
    "business_management", "ads_management", "catalog_management",
    "pages_read_engagement", "pages_manage_posts", "public_profile", "..."
  ]
}
```

`GET /me` → `{"id":"122116747437387987","name":"fullpos_whatsapp_agente"}`

| Variable | Antes | Ahora |
| --- | --- | --- |
| WHATSAPP_ACCESS_TOKEN | app `968867954936743` (CAPI), solo `read_ads_dataset_quality` | app **`998220578866944` FULLTECH BOT** con `whatsapp_business_messaging` + `whatsapp_business_management` |
| ¿igual al de CAPI? | **SÍ** (sha256:8201868f76) | **NO** (207 car. vs 202 car.) |

Huellas: `WHATSAPP_ACCESS_TOKEN` = **sha256:b2cb5785f0** (202 car.) ·
`PHYTO_META_CAPI_ACCESS_TOKEN` = sha256:8201868f76 (207 car., intacto).

**Producción ya tiene el mismo token nuevo** (202 car. · sha256:b2cb5785f0), contenedor
recreado `2026-09-30T02:34:12Z`, **healthy / 0 reinicios**, `/api/health` 200 ×3
(`storage: postgres`), sin errores de Graph en el log.

---

## 2. WABA `2559517617897858`

| Campo | Valor |
| --- | --- |
| name | Phytoemagry |
| account_review_status | **APPROVED** |
| business_verification_status | **verified** |
| message_template_namespace | 6b542e11_9e39_4e43_9b85_50a2c92343ab |
| **subscribed_apps** | **`[]` (VACÍO)** |

## 3. Número `1410599278794907`

| Campo | Valor | Lectura |
| --- | --- | --- |
| display_phone_number | +1 849-424-0621 | coincide con `WHATSAPP_PHONE_NUMBER` |
| verified_name | Phytoemagry | — |
| code_verification_status | **VERIFIED** | el número ya está verificado (SMS/llamada) |
| **name_status** | **PENDING_REVIEW** | ← el "EN REVISIÓN" del panel |
| **status** | **PENDING** | ← el "PENDIENTE" del panel |
| platform_type | NOT_APPLICABLE | sin plataforma asignada |
| throughput.level | NOT_APPLICABLE | sin capacidad de mensajería asignada |
| quality_rating | UNKNOWN | — |
| account_mode | LIVE | WABA en modo real (no sandbox) |
| is_official_business_account | false | — |

Perfil (`/whatsapp_business_profile`) → 200 con `messaging_product: whatsapp`,
`vertical: OTHER` y descripción presente.

## 4. App y webhook (sin cambios, correcto)

`GET /998220578866944/subscriptions` → 200:
`object: whatsapp_business_account` · `callback_url: https://phytoemagryrd.lat/api/webhooks/whatsapp` · `active: true` · `fields: [{name: "messages", version: "v25.0"}]`

Access log de producción: verificación de Meta **GET 200**; **cero eventos entrantes**.

---

## 5. Diagnóstico final

**A) `status: PENDING` + `platform_type: NOT_APPLICABLE` + `throughput: NOT_APPLICABLE`**
→ el número **no está registrado/conectado para Cloud API**. El número está verificado
(`code_verification_status: VERIFIED`) pero falta el **registro**.
Acción: `POST /{PHONE_NUMBER_ID}/register` con `messaging_product=whatsapp` + `pin` (2FA).

**B) `name_status: PENDING_REVIEW`**
→ el nombre visible «Phytoemagry» está **en revisión por Meta**. No se puede acelerar ni
saltar; solo esperar (típicamente horas hasta 2 días). No bloquea el envío.

**C) `subscribed_apps: []`**
→ el WABA **no tiene ninguna app suscrita** por ese endpoint, que es el paso documentado
para recibir los webhooks de mensajes entrantes. La config de webhook de la app es
correcta, pero la suscripción a nivel de WABA está vacía y el log no muestra ni un evento
entrante. Acción propuesta: `POST /{WABA_ID}/subscribed_apps`.

---

## 6. Correcciones propuestas (NO ejecutadas)

1. `POST /1410599278794907/register` — `messaging_product=whatsapp`, `pin=<PIN 2FA>`.
2. `POST /2559517617897858/subscribed_apps` — suscribir FULLTECH BOT al WABA.
3. Esperar la aprobación del nombre visible.
4. Rotar `WHATSAPP_VERIFY_TOKEN` y dejar de registrar la query string de esa ruta.
5. Solo después: prueba de envío real (requiere aprobación explícita).
