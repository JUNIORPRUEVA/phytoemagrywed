# Secuencia de PRIMER REGISTRO del número en WhatsApp Cloud API — auditoría (solo lectura)

Fecha: 2026-09-30 · Modo: **SOLO LECTURA** (únicamente `GET`). **Ninguna escritura contra Meta.**
Sin tokens ni secretos en este archivo.

Cuenta auditada: app `998220578866944` (FULLTECH BOT) · WABA `2559517617897858` (Phytoemagry) ·
número `1410599278794907` (+1 849-424-0621) · webhook `https://phytoemagryrd.lat/api/webhooks/whatsapp`

---

## FASE 1 — Estado actual del número (reconsultado)

`GET /1410599278794907` (v21.0 **y** v25.0, idéntico en ambas):

| Campo | Valor |
| --- | --- |
| id | 1410599278794907 |
| display_phone_number | +1 849-424-0621 |
| verified_name | Phytoemagry |
| code_verification_status | **VERIFIED** |
| name_status | **PENDING_REVIEW** |
| status | **PENDING** |
| platform_type | **NOT_APPLICABLE** |
| quality_rating | UNKNOWN |
| throughput.level | **NOT_APPLICABLE** |
| account_mode | LIVE |
| is_official_business_account | false |

`GET /2559517617897858/phone_numbers` → 200, un único número (el mismo, mismo estado).
`GET /2559517617897858/subscribed_apps` → 200 **`{"data":[]}`** (sin cambios).
`GET /2559517617897858` → `account_review_status: APPROVED`, `business_verification_status: verified`.

**El estado NO ha cambiado desde la auditoría anterior.**

## FASE 3 — ¿Existe algún campo/edge oficial que exponga el 2FA?

Sondeos `GET` (solo lectura):

| Sondeo | Resultado |
| --- | --- |
| `GET /{PNID}?fields=two_step_verification` | 400 · code **100** · `Tried accessing nonexisting field (two_step_verification)` |
| `GET /{PNID}/two_step_verification` | 400 · code **2500** · `Unknown path components: /two_step_verification` |
| `GET /{PNID}?fields=verification_status` | 400 · code **100** · `Tried accessing nonexisting field (verification_status)` |

**Conclusión Fase 3: NO existe campo ni edge oficial legible para consultar el estado de la
verificación en dos pasos.** No se puede saber por API si el 2FA está activo. No se inventa estado.

Campos documentados de onboarding/limits (aceptados por Graph, **sin valor** devuelto):

| Sondeo | Resultado |
| --- | --- |
| `GET /{PNID}?fields=messaging_limit_tier` | 200 · `{"id":"1410599278794907"}` (campo válido, sin valor) |
| `GET /{PNID}?fields=last_onboarded_time` | 200 · `{"id":"1410599278794907"}` (campo válido, **sin valor**) |
| `GET /{PNID}?fields=certificate` | 200 · `{"id":"1410599278794907"}` (campo válido, sin valor) |

Graph omite los campos válidos que están vacíos/nulos. `last_onboarded_time` sin valor es
evidencia coherente con **un número que nunca ha sido onboardeado/registrado**.

## FASE 4 — Suscripción del WABA

`GET /2559517617897858/subscribed_apps` → `{"data":[]}` (confirmado, sigue vacío).

---

## Fuentes

**DOCUMENTACIÓN OFICIAL (recuperada del índice de docs de Graph API):**

- `GET /{whats-app-business-account-id}/subscribed_apps`
  — *"Retrieves a list of apps subscribed to webhooks for the specified WhatsApp Business Account"*
  · Respuesta de ejemplo `{"data": [], "paging": {}}`
  → `https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/subscribed_apps`
- `POST /{whats_app_business_account_id}/phone_numbers` — crear/migrar número en el WABA; requiere
  `whatsapp_business_management` + `whatsapp_business_messaging`
  → `https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/phone_numbers`
- Webhooks de WhatsApp Business Account (eventos del WABA)
  → `https://developers.facebook.com/docs/graph-api/webhooks/reference/whatsapp-business-account`

**EVIDENCIA DE NUESTRA CUENTA:**
los `GET` de Fase 1/3/4 de arriba + el mensaje literal de WhatsApp Manager:

> «The PIN could not be changed for +1 849-424-0621.»
> «La cuenta no existe en la API de la nube. Usa '/register API' para crear una cuenta.»

**INFERENCIA (no verificada con documentación en este entorno):**
la semántica del parámetro `pin` del endpoint `/register`. La herramienta de consulta de
documentación disponible en este entorno **no indexa la página del endpoint `/register`**
(se intentó explícitamente y no hay resultados). Por tanto, todo lo relativo a «el PIN se elige
en el primer /register» queda marcado como **inferencia de alta confianza**, a confirmar con la
respuesta real de Graph o con la doc oficial abierta.

---

## Riesgos identificados

1. **PIN incorrecto en un `/register` posterior** → Graph devuelve error de PIN de 2FA inválido
   (familia `133005`); un intento fallido no registra el número.
2. **El número sigue activo en la app WhatsApp / WhatsApp Business (teléfono)** → el registro
   falla porque el número ya está en uso como cuenta; primero debe eliminarse desde la app.
3. **Pérdida del PIN elegido** → no se puede volver a registrar hasta restablecerlo (el
   restablecimiento desde el panel puede tener espera).
4. **`name_status: PENDING_REVIEW` puede pasar a `DECLINED`** → habría que cambiar el nombre visible
   y reiniciar la revisión.
5. **Cambio de estado visible en Meta**: el registro asocia el número a Cloud API de forma
   permanente mientras no se elimine; el número deja de ser utilizable en la app normal.
6. **Riesgo de mensajería/consumo** una vez registrado: el número empieza a poder enviar y recibir
   (los envíos posteriores están sujetos a las tarifas vigentes de Meta, que deben verificarse
   aparte; no se afirma ninguna tarifa aquí).
