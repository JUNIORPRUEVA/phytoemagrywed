# S3 — Multimedia de WhatsApp (backend aislado)

Estado: **implementado y probado en aislamiento**. Nada de esto está registrado
todavía en `crm-server.mjs`; el patch de integración exacto está al final.

Objetivo de la fase: el CRM puede **recibir** y **enviar** imágenes y audios de
WhatsApp sin arriesgarse a mandar el mensaje dos veces, sin guardar binarios en
PostgreSQL y sin que un fallo de almacenamiento haga desaparecer una conversación.

---

## 1. Reparto de responsabilidades

Cinco piezas, cada una con un oficio, y ninguna conoce a las demás por dentro.

| Módulo | Habla con | Qué hace |
|---|---|---|
| `server/s3.mjs` | Cloudflare R2 | AWS SigV4 a mano (sin SDK): `put`, `get`, `head`, `remove` |
| `server/storage.mjs` | R2 (reglas) | Tipos permitidos, límites, MIME por *magic bytes*, claves de objeto |
| `server/media.mjs` | PostgreSQL | Tabla `phytoemagry_wa_media`: metadata y los dos estados |
| `server/whatsapp-media.mjs` | Graph de Meta | Metadata, descarga, subida y envío. Es el único que ve el token |
| `server/media-pipeline.mjs` | (orquesta) | Descarga→validar→guardar; y el envío con su máquina de estados |
| `server/media-routes.mjs` | el navegador | Las tres rutas HTTP del CRM |

**El binario nunca está en PostgreSQL.** PostgreSQL guarda metadata y el
`object_key`; el archivo vive en R2. No se guardan claves, ni URLs firmadas, ni
tokens: la URL de Graph caduca en minutos y una fila no es sitio para un secreto.

---

## 2. Las DOS máquinas de estado (a propósito, en dos columnas)

Mezclarlas es lo que provoca que un fallo de envío parezca un fallo de archivo
—y que un reintento reenvíe un mensaje que ya llegó—. Por eso son dos columnas:

```
status  (¿dónde está el archivo?)
   entrante:  PENDING → DOWNLOADING → STORED
   saliente:  UPLOADING → STORED
   fallo:     FAILED        (SENDING/SENT existen solo por filas antiguas)

send_status  (¿llegó el mensaje?)          [NULL en las entrantes]
   PREPARING → READY_TO_SEND → SENDING → SENT
                                  │
                                  └→ SEND_UNKNOWN   (no se reintenta solo)
                                  └→ FAILED         (Meta rechazó: reintentable)
```

Ejemplo de por qué importa: si Meta rechaza el envío de una imagen, el archivo
**sigue guardado** (`status = STORED`) y lo que falla es la entrega
(`send_status = FAILED`). Antes toda la fila quedaba `FAILED` y una imagen que sí
estaba en R2 parecía perdida.

---

## 3. La puerta: `SENDING` se graba ANTES del envío irreversible

El envío a Meta no se puede deshacer. Así que el orden es:

```
1. buscar la operación por su idempotency_key   (la intención, ya persistida)
2. validar el archivo                            (ni R2 ni Meta)
3. crear la fila si no existe                    PREPARING
4. subir a R2                                    READY_TO_SEND
5. subir a Meta → media_id                       READY_TO_SEND
6. >>> grabar SENDING + send_attempted_at <<<    ← la puerta
7. enviar (UNA vez)
8. grabar SENT + wa_message_id + sent_at
```

Si el proceso muere **después** del paso 6 y antes del 8, lo que queda escrito es
«hubo un intento y no sé el resultado»: eso es exactamente `SEND_UNKNOWN`.

```js
export function resumeActionFor(row) {
  if (!row) return 'continue';
  if (row.send_status === SENT || row.wa_message_id) return 'done';   // nunca reenviar
  if (row.send_status === SENDING || row.send_status === SEND_UNKNOWN) return 'unknown';
  return 'continue';                                                  // se puede retomar
}
```

Esa función es la única que decide si algo se puede reintentar, y está en un solo
sitio a propósito.

### Qué evita cada pieza

| Situación | Qué pasa | Por qué no hay doble mensaje |
|---|---|---|
| Cae antes de R2 | La fila queda `PREPARING` | Al retomar se reanuda la MISMA operación |
| Cae después de R2 | La fila conserva su `object_key` al retomar | La clave es determinista: mismo objeto, no huérfano |
| Cae después de subir a Meta | La fila conserva `wa_media_id` | No se resube: se reutiliza el mismo `media_id` |
| Cae durante/después del envío | Fila en `SENDING` | Al retomar se declara `SEND_UNKNOWN` y **se para** |
| Timeout o 5xx en el envío | `SEND_UNKNOWN` | No se sabe si entró: no se reintenta solo |
| Meta rechaza con 4xx | `send_status = FAILED` | Meta no creó mensaje: reintentar es seguro |
| `wa_message_id` conocido | `resumeActionFor` → `'done'` | No se vuelve a llamar a Meta jamás |
| Misma `idempotency_key` repetida | Índice único + `ON CONFLICT DO NOTHING` | Una operación = una fila = un envío |

**Resultado:** at-least-once en el procesamiento interno (se puede reintentar sin
miedo lo que no salió), y **at-most-once hacia el cliente** (nunca dos mensajes).

---

## 4. Política de reintento (explícita)

| Estado | ¿Se puede reintentar? | Quién |
|---|---|---|
| `FAILED` antes de Meta (validación, R2) | **Sí** — nada se envió, y a Meta no se le llamó | Automático o desde el panel |
| `FAILED` en la subida a Meta | **Sí** — Meta no creó ningún mensaje | Automático o desde el panel |
| `FAILED` de R2 | **Sí**, y **nunca** se contacta con Meta | Automático o desde el panel |
| `SENDING` / `SEND_UNKNOWN` | **NO automático** — exige reconciliación | Una persona |
| `SENT` con `wa_message_id` | **No** se repite el envío | — |

### Reconciliación (la única salida de `SEND_UNKNOWN`)

No llama a Meta: solo corrige el estado local con información ya verificada. Se
hace por el **mismo** endpoint de reintento, para no inventar rutas nuevas:

```
POST /api/admin/media/retry/:id?outcome=sent&wa_message_id=<id>   → pasa a SENT
POST /api/admin/media/retry/:id?outcome=not_sent                  → vuelve a READY_TO_SEND
```

---

## 5. Rutas (aprobadas, **no** registradas todavía)

| Ruta | Método | Qué hace |
|---|---|---|
| `/api/admin/media/:id` | GET | Sirve el archivo con sesión del CRM |
| `/api/admin/media/retry/:id` | POST | Reintento o reconciliación (ver arriba) |
| `/api/admin/conversations/:id/media` | POST | Subida del panel: bytes crudos, `?kind=image|audio`, `?caption=`, `?key=` |

Todas exigen sesión. Sirven el archivo con `Content-Type` validado,
`Content-Length`, `X-Content-Type-Options: nosniff`,
`Cache-Control: private, no-store` y `Content-Disposition: inline`. Nunca exponen
bucket, `object_key`, endpoint de R2, tokens ni URL de Graph.

---

## 6. Saneado de secretos

Ningún texto del proveedor llega a ninguna salida. Se guarda solo lo que sirve
para diagnosticar:

`provider` · `operation` · `http_status` · `safe_code` · `error_at` (+ `error_code`)

Las respuestas HTTP se construyen con textos **nuestros**, elegidos por código de
error: aunque un mensaje interno traiga una URL firmada con credenciales, no puede
acabar en una respuesta. Hay pruebas que meten
`access_token=SUPER_SECRET`, `R2_SECRET_ACCESS_KEY=SUPER_SECRET` y una URL
`lookaside.fbsbx.com` en un error falso y comprueban que no aparecen **ni en la
respuesta, ni en la fila guardada, ni en los logs**.

---

## 7. Límites y formatos

- Imagen y audio: máximo 5 MB / 16 MB, audio de 300 s (`server/storage.mjs`).
- El tipo real se decide por **magic bytes**, no por el `Content-Type` ni la
  extensión: un HTML disfrazado de JPEG se rechaza.
- `webm`/Matroska **no** se reconoce: si el navegador graba en webm, el archivo se
  rechaza como tipo no reconocido (queda `webm → NEEDS_VALIDATION`, ver §9).
- El cuerpo de subida se corta a 16 MB en el servidor (`413`), sin fiarse del
  tamaño declarado por el cliente.

---

## 8. Migración: aditiva, sin tocar nada existente

La tabla nace con `CREATE TABLE IF NOT EXISTS` y, para bases que ya la tengan,
se aplica una migración aditiva:

```sql
ALTER TABLE ... ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE ... ADD COLUMN IF NOT EXISTS send_status text;
ALTER TABLE ... ADD COLUMN IF NOT EXISTS send_attempted_at text;
ALTER TABLE ... ADD COLUMN IF NOT EXISTS sent_at text;
ALTER TABLE ... ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE ... ADD COLUMN IF NOT EXISTS operation text;
ALTER TABLE ... ADD COLUMN IF NOT EXISTS http_status integer;
ALTER TABLE ... ADD COLUMN IF NOT EXISTS safe_code text;
ALTER TABLE ... ADD COLUMN IF NOT EXISTS error_at text;
CREATE UNIQUE INDEX IF NOT EXISTS ..._idem ON ... (idempotency_key);
CREATE INDEX IF NOT EXISTS ..._send ON ... (send_status);
```

No se reescribe ninguna fila, no se borra nada y no se toca
`phytoemagry_wa_messages` ni la tabla legacy `phytoemagry_messages`. En PostgreSQL
un índice único admite varios `NULL`, así que todas las filas anteriores siguen
siendo válidas.

**No se creó ninguna tabla nueva**: la operación de envío persistente es la propia
fila de media, que ya existía antes de tocar Meta.

---

## 9. Decisiones pendientes (no bloquean el resto)

- **FFmpeg: NO instalado.** La documentación oficial de formatos de audio de
  WhatsApp Cloud API no está accesible desde este entorno, así que **no se afirma
  compatibilidad**. Cuando haya evidencia real (MIME que graba el navegador,
  archivo real validado, respuesta real de Cloud API) se decide. La interfaz de
  procesado de audio está pensada para admitir un transcodificador sin rehacer UI
  ni almacenamiento. Mientras tanto: `webm/ogg/mp4 → NEEDS_VALIDATION`.
- **`media_type = receipt`** y la clave `phytoemagry/receipts/YYYY/MM/<pedido>/…`
  quedan preparadas en `storage.mjs`, pero son del trabajo comercial (S4/S5/S6):
  no se implementan aquí.

---

## 10. Integración mínima en `crm-server.mjs` (NO aplicada)

```js
// 1) imports
import { createMediaStore }      from './media.mjs';
import { createStorageService }  from './storage.mjs';
import { createWhatsAppMedia }   from './whatsapp-media.mjs';
import { createMediaPipeline }   from './media-pipeline.mjs';
import { createMediaRoutes }     from './media-routes.mjs';

// 2) después de crear las colecciones (una sola vez)
const mediaStore = createMediaStore(db.pool);           // tabla phytoemagry_wa_media
const storage = createStorageService({
  endpoint: process.env.R2_ENDPOINT,
  bucket: process.env.R2_BUCKET_NAME,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
});
const whatsappMedia = createWhatsAppMedia({
  accessToken: <el token que ya usa el CRM>,
  phoneNumberId: <el phone_number_id que ya usa el CRM>,
});
const mediaPipeline = createMediaPipeline({ mediaStore, storage, whatsappMedia, logger: console.log });
const handleMediaRoute = createMediaRoutes({
  mediaStore, storage, pipeline: mediaPipeline,
  isAuthorized: <el MISMO guard de /api/admin/*>,   // imprescindible
  resolveConversation: async (id) => { /* conversación + cliente */ },
  persistOutbound: async (input) => { /* guardar el mensaje saliente */ },
  findMessageByKey: async (key) => { /* mensaje por idempotency_key, si ya existe */ },
});

// 3) en el enrutador, ANTES del 404
if (await handleMediaRoute({ route, req, res, url })) return;

// 4) en el webhook, DESPUÉS de responder 200 a Meta (nunca antes):
//    mediaPipeline.processInbound({ messageId, conversationId, media })
```

Puntos que no se pueden saltar:

- `POST /register` y el ACK a Meta **no** dependen de R2: el pipeline entrante se
  encola después de responder, para que un R2 caído no provoque reintentos de Meta.
- Las variables `R2_*` tienen que existir en el contenedor de producción.
  Hoy **no están** en el servicio desplegado.
- `isAuthorized` debe ser el mismo guard que usa el resto de `/api/admin/*`.
- Las claves de idempotencia las genera el panel; sin `key`, no hay garantía de
  no duplicar (el pipeline lo documenta así).

---

## 11. Pruebas

`tests/s3-storage.test.js` (19) + `tests/media-routes.test.js` (52) — **71/71**:

- SigV4, claves de objeto, MIME por bytes, límites, R2 desactivado, errores.
- Rutas: sin sesión (401), 404, en curso (409), fallo (409), R2 caído (502),
  cabeceras privadas, sin fugas, reintento idempotente, reconciliación.
- Graph: metadata, descarga, subida, envío, 4xx/5xx, timeout, `200` sin
  identificador (ambiguo) y errores saneados.
- **Seguridad ante caídas**: antes de R2, después de R2, después de subir a Meta y
  antes del envío, durante el envío (ambiguo), `wa_message_id` conocido y clave
  repetida. En todos: **un solo envío** y **una sola operación**.

```bash
npx vitest run tests/s3-storage.test.js tests/media-routes.test.js
```

Ese es el gate de S3. La suite completa **no** sirve de gate mientras haya otro
trabajo (S4/S5/S6) editando archivos compartidos en el mismo árbol.
