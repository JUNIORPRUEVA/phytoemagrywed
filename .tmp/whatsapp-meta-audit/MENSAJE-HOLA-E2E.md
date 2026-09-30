# Auditoría end-to-end del mensaje real "Hola" — (SOLO LECTURA, sin cambios)

Fecha: 2026-09-30 · **Sin tokens, sin App Secret, sin PIN, sin Verify Token en este archivo.**
Ningún POST, ningún deploy, ninguna variable modificada, ningún dato creado.

Mensaje auditado: **"Hola"** enviado manualmente a **+1 849-424-0621** alrededor de las
**14:00 UTC** del 30/09/2026.

---

## PASO 1 — Estado del número (GET)

| Campo | Valor |
| --- | --- |
| `display_phone_number` | +1 849-424-0621 |
| `verified_name` | Phytoemagry |
| `code_verification_status` | VERIFIED |
| `name_status` | PENDING_REVIEW |
| **`status`** | **CONNECTED** |
| **`platform_type`** | **CLOUD_API** |
| `account_mode` | LIVE |
| `quality_rating` | UNKNOWN |
| `throughput.level` | STANDARD |

## PASO 2 — Suscripción del WABA (GET)

```json
{"data":[{"whatsapp_business_api_data":{"name":"FULLTECH BOT","id":"998220578866944"}}]}
```

**FULLTECH BOT suscrita: SÍ.**

## PASO 3 — Webhook de producción

| Comprobación | Resultado |
| --- | --- |
| Entregas `POST /api/webhooks/whatsapp` (toda la vida del contenedor) | **1** |
| Fecha / user-agent | **30/Sep/2026:14:00:27 +0000** · `facebookexternalua` |
| Código HTTP devuelto | **200** |
| Cuerpo (27 bytes) | `{"ok":true,"received":true}` |
| Firma `X-Hub-Signature-256` | **ACEPTADA** (si fallara, el handler responde 401 antes de procesar; no hay ninguna línea `firma no válida`) |
| Mensaje detectado | **SÍ** — entró a `processWebhookPayload` |
| Error durante el procesamiento | **SÍ**: `[crm] webhook: column "wa_message_id" does not exist` |
| `wa_message_id` | **NO DISPONIBLE** — la app no lo registra en logs y no llegó a almacenarse |
| Teléfono remitente | **NO DISPONIBLE** (mismo motivo) |
| Tipo de mensaje / timestamp | **NO DISPONIBLE** (mismo motivo) |

## PASO 4 — Base de datos (solo lectura)

| Comprobación | Resultado |
| --- | --- |
| `phytoemagry_customers` | **0 filas** |
| `phytoemagry_conversations` | **0 filas** |
| `phytoemagry_messages` | **5 filas**, todas plantillas legacy (`msg-saludo`, `msg-pedido`, `msg-recordatorio`, `msg-seguimiento`, `msg-gracias`) |
| Mensaje "Hola" almacenado | **NO** |
| Contacto / cliente asociado | **NO existe** |
| Conversación | **NO existe** |
| `wa_message_id`, `direction`, `status` | **NO existen** (no hay fila) |
| Duplicados del mismo `wa_message_id` | **Imposible**: no se guardó nada. Además el índice único de deduplicación **no existe** (solo `phytoemagry_messages_pkey`) |

Esquema real de la tabla colisionada:

```
phytoemagry_messages
  id (text, PK) | name (text) | body (text) | position (int) | updated_at (text)
```

## PASO 5 — CRM

| Comprobación | Resultado |
| --- | --- |
| `GET /api/admin/data` (lo que pinta el panel) | **HTTP 500** (`column "wa_message_id" does not exist`) |
| Clientes / Conversaciones / Mensajes | **vacíos** (0 filas en BD) → no hay nada que mostrar |
| Registros creados | **ninguno** (auditoría sin escrituras) |

---

## CAUSA RAÍZ (única, confirmada en código + BD + logs)

**Colisión de nombres de tabla.** El almacén nuevo
(`server/collections.mjs`) construye los nombres como `${prefix}${colección}` y define la
colección `messages` → tabla **`phytoemagry_messages`**, con columnas indexadas
`conversation_id, customer_id, wa_message_id, idempotency_key, direction, status, created_at`
y único `(wa_message_id, idempotency_key)`.

Pero **`phytoemagry_messages` ya existía** desde antes: es la tabla **legacy de plantillas de
mensaje** del CRM (`id, name, body, position, updated_at`) — otro significado, mismo nombre.

Como el DDL es:

```js
await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id text PRIMARY KEY, doc jsonb NOT NULL, ${indexColumns})`);
```

`IF NOT EXISTS` **no toca la tabla existente**: se queda con el esquema legacy y las columnas
nuevas nunca se crean. En cuanto cualquier código toca la colección `messages`, la creación del
índice único / el `INSERT ... wa_message_id` falla con
`column "wa_message_id" does not exist`.

Consecuencias (las dos vistas en esta auditoría):
1. **El procesamiento del webhook entrante falla** → el mensaje real se pierde.
2. **`GET /api/admin/data` devuelve 500** → el panel no pinta.

Agravante de diseño: el handler responde **200 antes de procesar** (correcto para que Meta no
reintente en bucle), así que **Meta considera la entrega exitosa y no reintenta**: el mensaje no
queda en ninguna cola. La pérdida es silenciosa salvo por la línea de error en el log.

Por qué los tests no lo detectaron: usan una base temporal limpia, sin la tabla legacy.

---

## CAMBIO MÍNIMO PROPUESTO (NO ejecutado)

**Opción A (recomendada) — renombrar la colección nueva `messages` → `wa_messages`.**
Evita tocar la tabla legacy (que sigue usándose para las plantillas del CRM) y no migra datos.

- `server/collections.mjs`: cambiar la clave `messages` por `wa_messages` en `COLLECTIONS`.
- `server/customers.mjs`: actualizar las llamadas `db.findBy('messages', …)`, `insert('messages', …)`,
  `list('messages', …)`, etc.
- `server/crm-server.mjs`: rutas que leen mensajes (`/api/admin/conversations/:id/messages`,
  contadores de no leídos).
- Tests que usan `'messages'`.

**Opción B — renombrar la tabla legacy en Postgres.** Más arriesgada: el CRM antiguo seguiría
leyendo `phytoemagry_messages` para sus plantillas; rompería esa función si no se actualiza su código.

**Opción C (complementaria, defensiva)** — que `ensure()` de Postgres compruebe las columnas de una
tabla preexistente y lance un error claro y accionable (`la tabla X ya existe con otro esquema:
renombra la colección`) en vez del error SQL crudo, con un test que cree una tabla legacy y espere
ese mensaje.

**Después del arreglo**: el mensaje "Hola" está perdido (no se puede recuperar); habrá que **reenviar
un mensaje real** para validar el flujo completo.
