# WhatsApp + CRM: clientes, seguimiento y conversaciones

Este documento explica la fase de WhatsApp del CRM: qué hace, qué **no** hace a
propósito, cómo se configura y cómo se comprueba que funciona.

> **Lo primero, para que no haya dudas: aquí nada se envía solo.**
> El sistema recibe mensajes, guarda clientes y compras, y **crea tareas de
> seguimiento con fecha**. Esas fechas sirven para que una persona vea en la
> pantalla HOY a quién le toca escribir. El envío siempre lo pulsa una persona
> desde el panel. No hay respuestas automáticas, ni mensajes generados por IA, ni
> envíos disparados por `scheduled_at`.

---

## 1. Qué entra en esta fase

| Capacidad | Estado |
| --- | --- |
| Integración con WhatsApp Cloud API (enviar/recibir) | ✅ |
| Webhook de Meta (`GET` verificación + `POST` eventos) | ✅ |
| Recepción y registro de mensajes del cliente | ✅ |
| Clientes unificados por teléfono (un cliente = una persona) | ✅ |
| Registro manual de compras + relación con el cliente | ✅ |
| Seguimiento al marcar una compra como ENTREGADA | ✅ |
| Ver próximos / vencidos y pantalla HOY | ✅ |
| Perfil 360 del cliente (compras, chat, seguimiento, consentimiento) | ✅ |
| Envío manual cuando las reglas de WhatsApp lo permiten | ✅ |
| Infraestructura de plantillas oficiales (nombres + variables) | ✅ |
| Estados enviado / entregado / leído / fallido | ✅ |
| Opt-in y opt-out | ✅ |
| Posponer, cancelar y completar seguimiento | ✅ |
| Idempotencia (no duplicar mensajes, clientes, ventas ni tareas) | ✅ |
| **IA de cualquier tipo** | ⛔ **NO** (ver §11) |
| **Envío automático de seguimiento** | ⛔ **NO** (a propósito) |

---

## 2. Arquitectura

```
Cliente (WhatsApp)
      │
      │  mensaje
      ▼
Meta  ──POST /api/webhooks/whatsapp──►  server/crm-server.mjs
      ◄────── 200 (contestado al momento) ───┘
                                              │  (en segundo plano)
                                              ▼
                                   server/whatsapp.mjs   (normaliza el evento)
                                   server/customers.mjs   (cliente + conversación + mensaje)
                                              │
              ┌───────────────────────────────┴──────────────────────────┐
              ▼                                                          ▼
   clientes / conversaciones / mensajes                    compras (fila del pedido)
   (server/collections.mjs)                                (server/stores.mjs)
              │
              ▼
   server/followups.mjs   → tareas con fecha (PENDIENTE / HOY / VENCIDO)
              │
              ▼
   Panel (public/admin)  → HOY · WhatsApp · Cliente · Enviar (manual)
```

Módulos nuevos, cada uno con una responsabilidad:

| Archivo | Qué hace |
| --- | --- |
| `server/collections.mjs` | Almacén de documentos con índices y claves únicas, sobre el MISMO backend que los pedidos (Postgres / SQLite / JSONL). |
| `server/whatsapp.mjs` | Cliente de WhatsApp Cloud API + verificación de webhook + normalización de eventos + reglas por texto (sin IA). |
| `server/customers.mjs` | Clientes unificados por teléfono, conversaciones, mensajes, compras, consentimiento y métricas. |
| `server/followups.mjs` | Plan de seguimiento: crea tareas con fecha y las clasifica. **Nunca envía.** |

Se reutiliza lo que ya existía: `server/stores.mjs` (pedidos), `server/meta-capi.mjs`
(venta a Meta), `src/config/product.config.js` (precios y presentaciones),
`src/lib/content-safety.js` (filtro de contenido médico prohibido).

---

## 3. Variables de entorno

Todas son **solo de servidor** (ninguna llega al navegador). Ver `.env.example`.

| Variable | Para qué | Secreta |
| --- | --- | --- |
| `META_APP_ID` | Identifica la app de Meta | No |
| `META_APP_SECRET` | Comprueba la firma del webhook | **Sí** |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Cuenta de WhatsApp Business (WABA) | No |
| `WHATSAPP_PHONE_NUMBER_ID` | Número que envía | No |
| `WHATSAPP_PHONE_NUMBER` | Número visible del negocio (el panel lo muestra) | No |
| `WHATSAPP_ACCESS_TOKEN` | Token de envío | **Sí** |
| `WHATSAPP_VERIFY_TOKEN` | Secreto de la verificación del webhook | **Sí** |
| `WHATSAPP_WEBHOOK_URL` | URL pública del webhook (informativa) | No |
| `PHYTO_FOLLOWUP_PLAN` | Plan de seguimiento en JSON (días configurables) | No |
| `PHYTO_DAILY_CAPSULES` | Cápsulas al día (por defecto 1, el uso aprobado) | No |

**Si falta `WHATSAPP_ACCESS_TOKEN` o `WHATSAPP_PHONE_NUMBER_ID`**, el cliente de
WhatsApp queda desactivado y el panel lo dice en pantalla. Todo lo demás sigue
funcionando: se pueden registrar clientes y compras y ver la ficha de cada uno.
El CRM nunca depende de Meta para guardar un dato.

### Dónde se leen estas variables (importante)

El servidor del CRM lee **las variables del proceso** (`process.env`). No lee
ningún archivo `.env`: el `.env` del repositorio lo usa el BUILD de la web (para
lo público) y `npm run dev`.

- **En producción**: van en el contenedor (Environment de Easypanel, `-e` de
  `docker run` o `env_file` de Compose).
- **En local**, para probar el envío de verdad: pásalas en la misma línea
  (`$env:WHATSAPP_ACCESS_TOKEN='…'; node server/crm-server.mjs`) o arranca con
  `node --env-file=.env.local server/crm-server.mjs` usando un archivo ignorado
  por Git.
- Nunca las pongas en `.env` si ese archivo acaba en el build: son de servidor.

Los secretos nunca se imprimen: los errores de Meta se sanean
(`sanitizeMetaError`) y en el panel solo se envían booleanos
(`configured`, `verifyTokenConfigured`, `appSecretConfigured`).

---

## 4. Webhook de Meta

### Verificación (una vez, al configurarlo en Meta)

```
GET /api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
```

- Si `hub.mode=subscribe` y el token coincide con `WHATSAPP_VERIFY_TOKEN`, se
  devuelve el `hub.challenge` **tal cual** (texto plano, `200`).
- Si no coincide, o el modo no es `subscribe`, se responde `403`. Sin token
  configurado **no se acepta nada**: antes no verificar que aceptar cualquier cosa.

### Eventos

```
POST /api/webhooks/whatsapp
X-Hub-Signature-256: sha256=…
```

1. Se lee el cuerpo **crudo** (la firma se calcula sobre los bytes exactos, no
   sobre un JSON recomponido).
2. Se comprueba la firma HMAC-SHA256 con `META_APP_SECRET` (comparación en tiempo
   constante). Si no es válida → `401` y **no se procesa nada**.
3. Se responde `200` **de inmediato** (Meta reintenta si tardas) y el guardado se
   hace justo después. El guardado es idempotente, así que un reintento no
   duplica mensajes.
4. Se guardan los mensajes entrantes y los estados de los salientes
   (`sent`/`delivered`/`read`/`failed`). Los eventos desconocidos se ignoran sin
   romper nada.

Si `META_APP_SECRET` no está configurado, el mensaje se procesa igual (para no
perder una conversación real) y se registra un aviso en el log. **Configurarlo es
obligatorio antes de producción.**

Permisos que hay que conceder al token en Meta: `whatsapp_business_messaging` y
`whatsapp_business_management`. El webhook se suscribe al campo `messages`.

---

## 5. Modelo de datos

Los pedidos siguen viviendo en `phytoemagry_items` (una fila por pedido, con
`customer_id` para enlazarlos con el cliente). Las entidades nuevas son
colecciones de documentos (`server/collections.mjs`) en la **misma base de datos**:

| Colección | Contenido | Clave única (idempotencia) |
| --- | --- | --- |
| `customers` | Cliente unificado (nombre, teléfono E.164, origen, consentimiento, totales, próximo seguimiento) | `phone_e164` |
| `conversations` | Conversación de WhatsApp (estado, sin leer, último mensaje) | — |
| `wa_messages` | Mensaje entrante o saliente (texto, intención, estado, errores) | `wa_message_id`, `idempotency_key` |
| `followups` | Tarea de seguimiento (fecha, tipo, motivo, estado) | `idempotency_key` = `fu:<pedido>:<día>` |
| `wa_templates` | Plantillas oficiales (nombre, categoría, idioma, texto, variables, botones, estado real en Meta) | `name` |
| `content` | Reservado para la fase de contenido (vacío en esta fase) | — |

**Un cliente es una persona, no un canal.** El teléfono normalizado a E.164
(`+18095551234`) es el identificador: da igual si llegó por la landing, por
WhatsApp o si la venta se registra a mano — si el número coincide, es el mismo
cliente. La clave única impide duplicados incluso con dos peticiones a la vez.

Teléfonos dominicanos: `8095551234`, `809-555-1234`, `+1 809 555 1234` y
`18095551234` producen todos `+18095551234`.

---

## 6. Compras

Una compra puede entrar por tres caminos y todos acaban en el mismo sitio:

1. **Landing** → `POST /api/crm` con el teléfono → se enlaza (o se crea) el cliente.
2. **WhatsApp** → el mensaje del cliente crea su ficha; la venta se registra luego.
3. **Manual** → `POST /api/admin/purchases` desde el panel (efectivo, transferencia,
   pedido por teléfono).

El precio **no lo inventa el panel**: sale de `src/config/product.config.js`
(catálogo oficial). El panel pide el catálogo al servidor y solo elige frasco y
cantidad. El servidor calcula el total con ese precio.

Los totales del cliente (`total_purchases`, `total_spent`, `last_purchase_at`) se
**calculan a partir de los pedidos ENTREGADOS**, no se incrementan. Por eso no
pueden desincronizarse ni contar dos veces la misma venta.

---

## 7. Seguimiento: tareas, no envíos

Cuando un pedido pasa a **ENTREGADO** (el único estado que representa dinero
cobrado; configurable con `PHYTO_META_PURCHASE_STATUS`) ocurren tres cosas, todas
idempotentes:

1. Se envía la **venta a Meta** una sola vez (igual que antes de esta fase).
2. Se recalculan los totales del cliente.
3. Se crea su **plan de seguimiento**: una tarea por día del plan.

Plan por defecto (configurable con `PHYTO_FOLLOWUP_PLAN`):

| Día | Tipo | Para qué |
| --- | --- | --- |
| 1 | `thanks` | Agradecer y orientar el uso |
| 3 | `checkin` | ¿Cómo va? |
| 7 | `education` | Información aprobada |
| 14 | `checkin` | Seguimiento |
| 21 | `education` | Información aprobada |
| 30 | `reorder` | Recompra cuando corresponda |

Cada tarea lleva su clave `fu:<pedido>:<día>`. Volver a marcar el pedido como
entregado, reiniciar el servidor o recibir dos peticiones a la vez **no duplica
ninguna tarea**.

**El plan no envía nada.** `followups.buckets()` solo clasifica:

- `today` → para hoy
- `overdue` → vencidas (la fecha pasó y nadie hizo nada)
- `upcoming` → próximas
- `completed` / `cancelled`

En el panel, cada tarea tiene acciones humanas: **Escribir ahora**, **Hecho**,
**+3 días**, **Cancelar**. Al enviar desde una tarea, la tarea se marca como
hecha con el mensaje que la cerró (`message_id`), así queda el rastro.

Duración estimada del frasco: cápsulas × cantidad ÷ dosis diaria. Sirve para
avisar de la próxima recompra; no promete nada al cliente.

---

## 8. Opt-in y opt-out

- **Opt-in**: el formulario de la landing guarda `consent` y el cliente queda
  con `whatsapp_opt_in = true`.
- **Opt-out automático**: si el cliente escribe algo como "no me escriban más",
  "basta", "stop", "cancelar", "no quiero recibir mensajes", "dejen de
  escribirme", "quiten mi número" (`detectOptOut`), se marca `do_not_contact`, se
  apaga el opt-in y **se cancelan las tareas de marketing pendientes**. La
  decisión del cliente manda sobre cualquier plan.
- **Opt-out manual**: en su ficha, "No contactar nunca más" (dos toques: confirmar
  que dejas de escribirle a alguien para siempre no puede ser un roce con el dedo).
- **Volver a permitir**: "Volver a permitir mensajes" reactiva el contacto con
  consentimiento explícito.

Con `do_not_contact`, el servidor **rechaza** cualquier envío (`409`) aunque se
pulse el botón. No es un aviso: no se envía.

---

## 9. Reglas de envío (las pone WhatsApp, no nosotros)

| Situación | Qué permite WhatsApp | Qué hace el CRM |
| --- | --- | --- |
| El cliente escribió hace menos de 24 h | Texto libre | Envía el texto que escribas |
| Pasaron más de 24 h | Solo **plantilla aprobada** | Rechaza el texto libre (`409 outside_window`) y ofrece la plantilla |
| El cliente pidió no recibir mensajes | Nada | Rechaza el envío (`409 do_not_contact`) |
| La plantilla no está aprobada en Meta | Nada | Rechaza (`409 template_not_approved`) |
| WhatsApp sin configurar | Nada | Rechaza (`503`) y lo dice en pantalla |

Las plantillas se registran con su **estado real**: nacen como
`pending_approval`/`sendable: false` y solo se pueden enviar cuando el negocio,
después de aprobarlas en Meta, las marca como `approved` en el CRM. Así el CRM no
intenta nunca un envío que WhatsApp va a rechazar (error 132001).

Plantillas de partida (`wa_templates`): `phyto_purchase_thanks`,
`phyto_followup_checkin`, `phyto_weekly_education`, `phyto_reorder_reminder`.

### Enviar la factura de un pedido (`phyto_envio_factura_v1`)

La factura de un pedido se envía al chat del cliente **desde el CRM** con la API
oficial (documento nativo de WhatsApp). El panel no abre WhatsApp Web, ni la app,
ni el menú de compartir del teléfono, y no obliga a descargar el PDF.

| Situación | Qué hace el CRM |
| --- | --- |
| Dentro de la ventana de 24 h | Un texto corto + el PDF como **documento** (`Factura-<pedido>.pdf`) |
| Fuera de la ventana, plantilla aprobada con cabecera `DOCUMENT` | Plantilla con el PDF en la **cabecera** y el nombre y el pedido en el cuerpo |
| Fuera de la ventana, plantilla sin aprobar o sin esa cabecera | **Nada**: `409` explicado (`template_not_approved` / `template_without_document_header`) |
| Meta rechaza | `502` con el motivo en palabras; el texto ya enviado queda registrado |
| Meta no confirma si llegó | `409 send_unknown` **sin reenviar** (para no duplicar) |

Para registrarla en Meta (paso manual) hace falta, además del cuerpo, un **ejemplo
de documento** (`header_handle`): Meta no aprueba una cabecera de documento sin su
muestra. Definición exacta: nombre `phyto_envio_factura_v1`, categoría `UTILITY`,
idioma `es`, cabecera de tipo **Documento**, cuerpo
`Hola {{1}}, te compartimos la factura correspondiente a tu pedido {{2}}.`,
variables `customer_name` y `order_number` (ejemplo: `Ana Volumen` / `PE-00125`),
sin botones. Hasta que Meta la apruebe, el CRM la guarda como
`pending_approval`/`sendable: false` y lo dice en pantalla: no se finge la
aprobación.

Ficha completa de una plantilla (todos los campos existen ya en el CRM):

| Campo | Quién lo rellena |
| --- | --- |
| `name` | El negocio (debe coincidir EXACTAMENTE con el de Meta) |
| `language` | El negocio (`es`) |
| `category` | El negocio (`UTILITY` / `MARKETING`) |
| `status` | El negocio, según lo que diga Meta (`pending_approval` / `approved` / `rejected` / `disabled`) |
| `body` | El negocio (texto neutro y aprobado) |
| `variables` | El negocio (`{{\u20091}}` → `nombre`) |
| `buttons` | El negocio (respuestas rápidas, si las hay) |
| `meta_template_id` | **Meta** (se copia a mano tras registrarla allí; el CRM no lo inventa) |
| `last_synced_at` | **Meta** (fecha de la última revisión en Meta) |

El CRM **no crea ni modifica plantillas en Meta**: no llama a esa API. Registrar
las plantillas en Meta y aprobarlas es un paso manual del negocio; el CRM solo
guarda su ficha y decide si se pueden usar (`status === 'approved'`).

**Contenido**: el texto de las plantillas es deliberadamente neutro y descriptivo
(agradecer, preguntar cómo va, informar del uso). No hay promesas de resultados,
ni plazos, ni beneficios médicos: lo que el negocio no pueda sostener por escrito
no se escribe.

Estados de un mensaje saliente: `pending` → `sent` → `delivered` → `read`, o
`failed` con `error_code`/`error_message` (saneados). El webhook los actualiza;
repetir el mismo estado no cambia nada.

---

## 10. Estados de la conversación (quién atiende)

| Estado | Significado |
| --- | --- |
| `AUTOMATIC` | Puede recibir el seguimiento previsto |
| `HUMAN_REQUIRED` | El cliente pidió hablar con una persona o planteó un tema de salud |
| `HUMAN_ACTIVE` | Una persona del negocio ya está escribiendo |
| `PAUSED` | Seguimiento detenido (opt-out, decisión del negocio) |
| `CLOSED` | Cerrado |

La detección es por reglas de texto (`server/whatsapp.mjs`), **sin IA**: busca
palabras de precio, de uso, de pedido, de saludo, y frases que indican "quiero
hablar con alguien" o un tema de salud. Nada de esto responde solo: solo marca la
conversación para que una persona la mire.

---

## 11. FASE FUTURA — IA ASISTIDA

**No hay nada de esto implementado.** Se deja escrito para la siguiente fase,
sin código ni dependencias añadidas.

Flujo previsto (la primera implementación **siempre con control humano**):

```
IA genera borrador
      ↓
aparece en el CRM (nunca en el chat del cliente)
      ↓
la persona administradora revisa
      ↓
editar / aprobar / rechazar
      ↓
la persona administradora pulsa ENVIAR
      ↓
WhatsApp
```

**La IA NO enviará directamente al cliente sin control humano en la primera
implementación.** El botón de enviar sigue siendo humano, igual que en esta fase.

Ideas concretas para esa fase:

- `AIContentService`: generar borradores de contenido (nunca publicar solo).
- Asistencia para **redactar** el mensaje de seguimiento (borrador editable).
- Clasificación de intención con IA (hoy se hace con reglas, que son explicables
  y gratis).
- Resumen de conversaciones largas para el negocio.
- Variables previstas: `AI_API_KEY`, `AI_MODEL`, `AI_MAX_TOKENS` (hoy no existen).

Reglas que **seguirán** siendo ciertas cuando llegue esa fase:

1. La IA propone; una persona decide y envía. El envío automático no entra en este
   producto.
2. Nada de la IA puede saltarse `src/lib/content-safety.js` (beneficios médicos,
   plazos, garantías, testimonios).
3. Sin claves de IA configuradas, el CRM funciona exactamente igual que hoy.

---

## 12. Seguridad

- **Secretos solo en el servidor.** `WHATSAPP_ACCESS_TOKEN`, `META_APP_SECRET` y
  `WHATSAPP_VERIFY_TOKEN` no salen nunca en una respuesta HTTP ni en un log.
- **Firma del webhook** comprobada en tiempo constante antes de procesar.
- **CORS cerrado** salvo `PHYTO_CRM_ALLOWED_ORIGIN`.
- **Sesión del panel**: cookie HMAC `HttpOnly`, `SameSite=Strict`, `Secure` detrás
  de HTTPS; límite de intentos de clave por IP.
- **Sin secretos en el navegador**: el panel solo recibe booleanos de configuración.
- **Datos personales**: el CRM guarda nombre, teléfono, ciudad y notas. El
  teléfono se guarda normalizado para poder unificar al cliente; no se envían
  datos de clientes a terceros salvo la venta a Meta (que ya existía) y los
  mensajes que se deciden enviar.
- Si rotas `PHYTO_CRM_TOKEN`, todas las sesiones del panel dejan de valer.

---

## 13. API (para el panel y para scripts)

Todas las rutas del panel piden la cookie de sesión (`POST /api/admin/login`).

| Método | Ruta | Para qué |
| --- | --- | --- |
| GET | `/api/admin/data` | Todo lo que pinta el panel en una petición |
| GET | `/api/admin/metrics` | Números del negocio |
| GET | `/api/admin/customers?q=` | Buscar clientes |
| GET | `/api/admin/customers/:id` | Perfil 360 (compras, chat, seguimiento, consentimiento) |
| PATCH | `/api/admin/customers/:id` | Nombre, ciudad, notas |
| POST | `/api/admin/customers/:id/opt-out` \| `/opt-in` \| `/automation` | Consentimiento y estado |
| POST | `/api/admin/purchases` | Registrar una compra a mano |
| GET | `/api/admin/conversations` | Bandeja de WhatsApp |
| GET | `/api/admin/conversations/:id/messages` | Hilo completo |
| POST | `/api/admin/conversations/:id/messages` | **Enviar** (texto o plantilla) |
| POST | `/api/admin/conversations/:id/read` | Marcar como leída |
| GET | `/api/admin/followups` | Tareas: hoy, vencidas, próximas |
| POST | `/api/admin/followups` | Crear tarea manual |
| PATCH | `/api/admin/followups/:id` | `complete` \| `skip` \| `cancel` \| `postpone` \| `reschedule` |
| GET \| POST | `/api/admin/wa-templates` | Plantillas oficiales y su estado |
| GET \| POST | `/api/webhooks/whatsapp` | Meta (verificación y eventos) |

---

## 14. Cómo probarlo (UAT)

1. **Sin configurar nada**, arranca el CRM (`npm run crm`) y abre `/admin/`:
   registra una compra a mano con estado *entregado* en un cliente nuevo y
   comprueba en HOY que aparecen las 6 tareas (1, 3, 7, 14, 21 y 30 días) y que
   las vencidas se marcan como vencidas.
2. **Con WhatsApp configurado**, escribe al número del negocio: el mensaje debe
   aparecer en la bandeja con el nombre del perfil, y el cliente debe quedar
   creado (o reutilizado si ya existía por teléfono).
3. Escribe "precio" → la conversación se marca con la intención; escribe "quiero
   hablar con una persona" → `HUMAN_REQUIRED`; escribe "no me escriban más" → el
   cliente queda como *no contactar* y sus tareas de marketing se cancelan.
4. Contesta desde el panel con texto (dentro de la ventana de 24 h) y comprueba
   que el estado pasa a `sent` → `delivered` → `read` según los webhooks de Meta.
5. Fuerza una conversación de más de 24 h (o espera): el panel debe rechazar el
   texto libre y ofrecer solo plantillas aprobadas.
6. Marca una plantilla como aprobada (tras aprobarla en Meta) y envíala.
7. Reinicia el servidor: no debe duplicar clientes, mensajes, ventas ni tareas.

Pruebas automáticas de todo lo anterior (`npm test`):

| Archivo | Qué cubre |
| --- | --- |
| `tests/whatsapp-webhook.test.js` | Verificación, firma válida/inválida, idempotencia, estados, mensajes ignorados |
| `tests/customers-followups.test.js` | Cliente unificado, compras con precio oficial, plan, clasificación HOY, posponer/completar/cancelar, opt-out |
| `tests/conversations.test.js` | Bandeja, hilo, ventana de 24 h, no contactar, fallos, plantillas, seguimiento cerrado al enviar, sin configurar |
| `tests/panel-whatsapp.test.js` | El panel llama a los endpoints nuevos y no envía nada solo |

---

## 15. Despliegue

1. Añade las variables de WhatsApp al contenedor del CRM (Environment de
   Easypanel o `docker run -e`). **Nunca en el build**: no llegan al navegador.
2. La base de datos necesita las tablas nuevas; se crean solas al arrancar
   (`CREATE TABLE IF NOT EXISTS`), también en Postgres. La columna `customer_id`
   se añade con `ADD COLUMN IF NOT EXISTS`.
3. Configura el webhook en Meta con la URL pública
   (`https://<tu-dominio>/api/webhooks/whatsapp`) y el `WHATSAPP_VERIFY_TOKEN`.
   nginx ya reenvía `/api/` al CRM; no hace falta tocar la configuración.
4. **Comprueba desde fuera que la URL responde ANTES de registrarla en Meta**
   (si no responde, Meta no podrá verificar el webhook y no llegará ningún
   mensaje). Desde cualquier equipo con internet:

   ```bash
   curl -i "https://TU-DOMINIO/api/health"
   curl -i "https://TU-DOMINIO/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=UN_TOKEN_QUE_NO_SEA_EL_TUYO&hub.challenge=123"
   ```

   Lo esperado: `200` en `/api/health`, y `403` en el webhook (rechaza el token
   falso). Un `404` significa que ese dominio NO está sirviendo esta aplicación:
   hay que apuntarlo primero (dominio → contenedor, puerto del proxy → 80).
4. Comprueba en el panel → Ajustes → WhatsApp que todo aparezca en verde
   (envío, webhooks, firma).
5. Los reintentos de ventas a Meta y la reparación del plan de seguimiento se
   ejecutan solos al arrancar, con tope de intentos.

---

## 16. Lo que esta fase NO hace (a propósito)

- No envía ningún mensaje automáticamente (ni por `scheduled_at`, ni por plan).
- No responde solo a los mensajes del cliente.
- No usa IA para nada.
- No genera contenido ni mensajes motivacionales.
- No cambia la regla de la venta: se le cuenta a Meta solo cuando el pedido está
  ENTREGADO, y una sola vez.
- No toca el píxel ni la API de conversiones de la fase anterior.
