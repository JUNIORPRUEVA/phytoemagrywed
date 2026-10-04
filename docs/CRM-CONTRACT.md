# Contrato de datos con el mini-CRM Phytoemagry

La landing envía cada contacto y cada pedido al CRM por HTTP. La imagen Docker ya
incluye ese CRM (`server/crm-server.mjs`) con su propia base de datos SQLite, así
que **funciona sin configurar nada**. Si prefieres otro destino (Google Sheets,
Make/Zapier/n8n, tu backend), basta poner su URL en `PHYTO_CRM_ENDPOINT`: el
payload no cambia. Y si el envío falla, el dato se queda en una cola local del
navegador (`localStorage`, clave `pe:crm.queue`, máximo 50 elementos) para
reintentarlo: la web nunca pierde un contacto.

Implementación: `src/lib/api.js` (`buildLeadPayload`, `buildOrderIntentPayload`,
`createCrmClient`) y `server/crm-server.mjs`. Esquema actual:
**`schemaVersion: "1.1"`**.

---

## ¿Dónde llegan los contactos y los pedidos?

Hay **dos canales**, y funcionan los dos a la vez:

| Canal | Qué llega | Cuándo |
| --- | --- | --- |
| **WhatsApp `+1 849-424-0621`** | Todo, ya escrito y listo: cada pedido (frasco, cantidad, precio, total y el nombre) y cada contacto del formulario (nombre, teléfono, ubicación) | **Ya funciona**, sin configurar nada |
| **La base de datos de la propia web** (`/api/crm`, dentro de la imagen) | El mismo dato en formato estructurado (`lead` y `order_intent`), guardado en PostgreSQL (o en `/data/phytoemagry.sqlite`) | **Ya funciona** en la imagen Docker; se lee en `/panel?token=...` |

### La base de datos de la web (PostgreSQL o SQLite)

`server/crm-server.mjs` es un servidor HTTP pequeño que habla con la base de
datos que le indiques. Dos almacenes, y elige solo:

| Almacén | Cuándo se usa | Dónde quedan los datos |
| --- | --- | --- |
| **PostgreSQL** (recomendado en producción) | Si defines `PHYTO_CRM_DATABASE_URL` | En el servidor de base de datos (tabla `phytoemagry_items`) |
| **SQLite** (por defecto, cero configuración) | Si no hay `PHYTO_CRM_DATABASE_URL` | `/data/phytoemagry.sqlite`, dentro del contenedor (monta ahí un volumen) |

Además, si el módulo SQLite de Node no existiera, cae a un archivo `.jsonl`. Y si
PostgreSQL está configurado pero no responde, lo avisa en los logs y **sigue
guardando en SQLite**: la web nunca pierde un pedido por un problema de la base de
datos.

Con la imagen Docker:

- nginx sirve la web y le pasa `/api/` y `/panel` a este proceso;
- **`PHYTO_CRM_TOKEN`** es la clave para leer los datos. Sin ella, la web sigue
  guardando, pero leer queda desactivado (respuesta `503` con el aviso).

Rutas:

| Ruta | Qué hace |
| --- | --- |
| `POST /api/crm` | Recibe un `lead` o un `order_intent` (o una lista de hasta 25). Responde `202`. Si repites el mismo `id` (la cola reintenta) **no duplica**: `duplicate: true` |
| `GET /api/health` | Estado: `{ ok, storage, items }`. Sin datos personales |
| `GET /api/crm/items?token=...` | Los registros en JSON (más nuevo primero). Acepta `limit` (máx. 1000, por defecto 100) y `type=lead` / `type=order_intent` |
| `GET /api/crm/export.csv?token=...` | El mismo listado en CSV (se abre en Excel o Google Sheets) |
| `GET /panel?token=...` | Panel en HTML: fecha, tipo, nombre, teléfono, frasco, total y ciudad, con el botón de descargar el CSV |

### API del panel (mini-CRM)

La app instalable vive en `/admin/` y usa estos endpoints. Todos piden **sesión**
(cookie `pe_crm`, que se obtiene del login) y responden `401` si no la hay:

| Ruta | Qué hace |
| --- | --- |
| `POST /api/admin/login` | Cambia la clave por la cookie de sesión (10 intentos por IP cada 15 min) |
| `POST /api/admin/logout` | Borra la cookie |
| `GET /api/admin/session` | `{ ok }`: sirve para saber si hay sesión sin pedir nada más |
| `GET /api/admin/data` | Todo lo que pinta el panel en **una** petición: registros (500), estados, cuentas (`stats`), plantillas, clientes con estado comercial, conversaciones, seguimientos, **mensajes programados**, ajustes, catálogo, auditoría y el bloque `hoy` |
| `PATCH /api/admin/items/:id` | `{ status, notes, nextActionAt, contacted }`. Valida el estado contra la lista; `nextActionAt: ''` quita el recordatorio |
| `POST /api/admin/messages` | Crea o actualiza una plantilla (`{ id?, name, body, position? }`) |
| `DELETE /api/admin/messages/:id` | Borra una plantilla |

### Centro de ventas (S4 / S5 / S6)

| Ruta | Qué hace |
| --- | --- |
| `GET /api/admin/catalog` | Catálogo oficial (frascos y precios). **Única fuente**: sale de `src/config/product.config.js` |
| `POST /api/admin/orders` | Crea un pedido (`{ customerId o phone+name, conversationId?, items[], discount?, notes?, delivery?, status?, date? }`). El precio SIEMPRE sale del catálogo |
| `GET /api/admin/orders/:id` | Detalle del pedido + comprobante + seguimientos y programados ligados |
| `PATCH /api/admin/orders/:id` | Modifica frascos, descuento, notas y entrega; recalcula el total |
| `GET /api/admin/orders/:id/receipt` | **Comprobante de compra** en HTML imprimible/descargable (teléfono enmascarado; nunca «factura fiscal») |
| `GET /api/admin/orders/:id/invoice-whatsapp` | **Vista previa** del envío de la factura: `{ filename, order_number, customer_name, sendable, insideWindow, greeting, template, conversation_id }`. Lo decide el servidor; el panel solo lo enseña |
| `POST /api/admin/orders/:id/invoice-whatsapp` | **Envía la factura por WhatsApp** desde el CRM (API oficial). El cuerpo solo lleva `{ idempotencyKey }`: el destinatario, la conversación y el PDF salen del PEDIDO. Dentro de la ventana: texto corto + documento nativo. Fuera: SOLO `phyto_envio_factura_v1` (aprobada y con cabecera de documento) o `409` explicado |
| `GET`/`POST /api/admin/scheduled` | Cola de mensajes programados: listar (con resumen para HOY) y programar |
| `GET /api/admin/scheduled/suggestion?customerId=` | **Qué proponer** para programar: con compra entregada → `phyto_seguimiento_compra_v1` (mensaje de 6+ o de menos frascos); sin compra → `phyto_seguimiento_interes_v1`. Lo decide el servidor; el panel solo lo enseña |
| `PATCH /api/admin/scheduled/:id` | `{ action: 'cancel' \| 'reschedule' }` |
| `GET`/`POST /api/admin/settings[/followup]` | Ajustes del negocio (hoy: qué días del plan de postventa están activos) |
| `GET /api/admin/audit` | Traza comercial (`?entity=`, `?entityId=`, `?limit=`) |
| `GET /api/admin/metrics?period=` | Números por período (`hoy` \| `7d` \| `30d`), sin doble conteo |

Estados del pedido: `nuevo`, `confirmado`, `en_preparacion`, `enviado`, `entregado`,
`cancelado`, `perdido` (más `contactado`/`interesado`, que son de la conversación).
Estados comerciales del cliente (derivados, con `INTERESADO`/`PERDIDO` manuales):
`NUEVO`, `EN_CONVERSACION`, `INTERESADO`, `PEDIDO_CREADO`, `CONFIRMADO`,
`ENTREGADO`, `SEGUIMIENTO`, `RECOMPRA`, `PERDIDO`.

Mensajes programados: `SCHEDULED → PROCESSING → SENT → DELIVERED → READ`, o
`FAILED` / `CANCELLED` / `BLOCKED`. Si al llegar la hora ya no se puede enviar
legalmente (ventana de 24 h, opt-out, plantilla sin aprobar) **no se fuerza**:
queda `BLOCKED` y se crea una tarea de aviso para el operador.

Un mensaje programado con plantilla guarda su **contenido congelado**:
`template_language`, `template_components` (los parámetros exactos) y
`template_body` (el texto final que el agente revisó). Al llegar la hora se envía
**eso**, sin volver a calcularlo: si el cliente o su pedido cambian entre medias,
el mensaje programado NO cambia. Además, la programación **rechaza** una plantilla
que Meta todavía no ha aprobado (`409 template_not_approved`) y una conversación
que no sea del cliente (`409 conversation_mismatch`); el envío vuelve a comprobar
cliente → conversación → plantilla antes de mandar nada.

Plantillas de seguimiento (nacen `pending_approval`, `sendable: false`; se
desbloquean cuando Meta las aprueba y el CRM sincroniza):

| Nombre | Para qué | Variables |
| --- | --- | --- |
| `phyto_contacto_personalizado_v1` | **Chat directo** fuera de la ventana de 24 h | `customer_name`, `mensaje` |
| `phyto_seguimiento_compra_v1` | Mensaje programado de quien YA compró | `customer_name`, `mensaje` |
| `phyto_seguimiento_interes_v1` | Mensaje programado de quien NO ha comprado | `customer_name`, `mensaje` |
| `phyto_envio_factura_v1` | **Factura por WhatsApp** fuera de la ventana de 24 h (cabecera `DOCUMENT`) | `customer_name`, `order_number` |

El mensaje sugerido de una compra usa el de «6 frascos o más» cuando el pedido
trae esa cantidad (`order_json.units`, o la suma de las líneas); si no se puede
saber, usa el general y lo dice. Nunca se menciona un «grupo» de WhatsApp: el CRM
no guarda esa pertenencia por cliente.

**Factura por WhatsApp** (`POST /api/admin/orders/:id/invoice-whatsapp`). La
factura la manda el CRM al chat del cliente con la API oficial; NO se abre
WhatsApp Web, ni la app, ni el menú de compartir del teléfono, ni se obliga a
descargar el PDF. Reglas:

- **A quién se le envía lo decide el servidor** desde el pedido: cliente →
  conversación (tiene que ser SUYA; si no hay, no se inventa) → PDF regenerado del
  pedido actual. Nada de lo que manda el panel (ni ids, ni teléfonos) se usa para
  decidir el destinatario.
- Bloqueos que **no** se saltan: pedido sin cliente (`409 order_without_customer`),
  cliente sin teléfono (`409 missing_phone`), opt-out (`409 do_not_contact`),
  sin conversación (`409 no_conversation`) y WhatsApp sin configurar (`503`).
- **Dentro de la ventana de 24 h**: un texto corto («Hola <nombre>, te compartimos
  la factura de tu pedido.») y después el PDF como **documento nativo** de
  WhatsApp, con nombre `Factura-<numero_pedido>.pdf`, por la misma puerta que las
  fotos y los audios (guardado en R2, idempotencia y registro en el hilo).
- **Fuera de la ventana de 24 h**: solo sale con la plantilla aprobada
  `phyto_envio_factura_v1`, que **debe llevar cabecera de documento** en Meta. Si
  no está aprobada (`409 template_not_approved` / `invoice_template_missing`) o no
  tiene esa cabecera (`409 template_without_document_header`), no se envía nada y
  se explica en palabras. El PDF **no se guarda** en R2 en ese camino: queda
  registrado en el hilo con su nombre de archivo (`invoice_filename`) y se puede
  regenerar del pedido.
- **Idempotencia**: `idempotencyKey` (una por confirmación). Un doble clic o un
  reintento con la misma clave NO manda una segunda factura: el texto se salta si
  ya salió y el documento lo reconoce el pipeline de archivos. Un envío ambiguo
  (Meta no confirma) responde `409 send_unknown` **sin reenviar**.
- El hilo queda como **evidencia**: mensaje del documento con el nombre del PDF, su
  archivo (servido en `/api/admin/media/:id`) y quién lo envió. Los ids técnicos no
  se enseñan en el panel.

Campos de gestión que se añaden a cada registro: `status` (los del pedido),
`notes`, `next_action_at` (`YYYY-MM-DD`), `last_contact_at`, `updated_at`,
`conversation_id`, `order_number` y el detalle completo del pedido en
`order_json`. El CSV los incluye todos.

Guía de uso (la que lee el negocio): [`PANEL.md`](PANEL.md).

La clave se puede pasar como `?token=` o en la cabecera `x-crm-token`. Se compara
en tiempo constante, y el panel se marca `noindex, nofollow`.

Probar en local (sin Docker):

```bash
npm run crm            # arranca el API en http://127.0.0.1:8787
```

Variables (solo servidor, nunca llegan al navegador): `PHYTO_CRM_DATABASE_URL`,
`PHYTO_CRM_TOKEN`, `PHYTO_CRM_DATA`, `PHYTO_CRM_PORT`, `PHYTO_CRM_HOST`,
`PHYTO_CRM_ALLOWED_ORIGIN` (esta última solo si sirves la web desde otro dominio).
Ver `.env.example`.

#### Tabla de PostgreSQL

```sql
CREATE TABLE phytoemagry_items (
  id text PRIMARY KEY, type text NOT NULL, received_at text NOT NULL,
  name text, phone text, location text,
  variant_id text, variant_name text, capsules integer,
  quantity integer, unit_price integer, total integer, currency text,
  source text, session_id text,
  payload jsonb NOT NULL, stored_at timestamptz NOT NULL DEFAULT now()
);
```

El API la crea sola al arrancar (`CREATE TABLE IF NOT EXISTS`), con índices por
`received_at` y `type`. El `id` es la clave primaria y el `INSERT` usa
`ON CONFLICT (id) DO NOTHING`: la cola local puede reintentar sin duplicar. Los
intentos `testpg-...` que crean los tests se borran al terminar, así que se puede
apuntar la suite a una base de datos real sin dejar basura:

```bash
PHYTO_CRM_TEST_DATABASE_URL=postgres://... npm test
```

**Nota:** mientras no exista ni endpoint ni base de datos (por ejemplo si sirves
`dist/` en un hosting estático sin el API), la cola local (`pe:crm.queue`) vive en
el navegador **del visitante**: sirve de red de seguridad, pero **no es una base
de datos de clientes** (se ve con `Phytoemagry.pendingCrmItems()` y se reenvía
al cargar la página siguiente). La vía por la que el negocio recibe el contacto
es WhatsApp.

### Cómo se comporta el formulario "quiero que me escriban"

1. El visitante rellena nombre, teléfono y (opcional) ubicación.
2. Al enviar, **se abre WhatsApp con sus datos escritos** (él solo pulsa enviar).
   Es síncrono dentro del gesto del usuario, así el navegador no bloquea la
   pestaña; si la bloqueara, el panel de éxito muestra el mismo enlace con sus
   datos como botón.
3. Además se registra el `lead` en el CRM (o en la cola local) y se envía el
   evento `lead` a la medición.

### Cómo se comporta el modal de pedido (Comprar)

1. El visitante elige el frasco en el carrusel (al entrar **no hay ninguno
   elegido**: si pulsa Comprar sin elegir, la web se lo pide y baja al carrusel).
2. El modal pide **solo el nombre** y muestra el resumen del pedido. No pide
   teléfono ni ubicación a propósito: son fricción y el número llega igual, en el
   propio chat (WhatsApp no permite escribir a quien no ha escrito antes). Por
   eso el `lead` de origen `checkout` va con `phone: null` y `location: null`.
3. Al enviar se abre WhatsApp con el pedido completo ya escrito (producto,
   frasco, cantidad, precio por frasco, cápsulas en total, total y nombre) y se
   registran `lead` + `order_intent` en el CRM (o en la cola local).

Así el contacto se puede responder en minutos (WhatsApp) y queda además
registrado en la base de datos del servidor.

### Opciones para cambiar el destino (si no quieres la base de datos incluida)

| Opción | Coste | Notas |
| --- | --- | --- |
| **La base de datos incluida** (por defecto en la imagen Docker) | Incluida | PostgreSQL si le das `PHYTO_CRM_DATABASE_URL` (recomendado) o SQLite dentro del contenedor. Panel y CSV incluidos |
| **Google Sheets** (Apps Script publicado como Web App) | Gratis | Los leads caen en una hoja de cálculo que puedes abrir en el móvil. Apps Script no responde al preflight CORS: hay que recibirlo como `text/plain` (ajuste pequeño en `src/lib/api.js`, se hace al conectar) |
| **Make / Zapier / n8n** (webhook) | Desde gratis | Envía un correo, avisa por WhatsApp/Telegram o escribe en Sheets sin programar |
| **Formulario tipo Formspree / Getform** | Gratis con límite | Recibe el POST y te avisa por correo; luego se descarga a Excel/Sheets |
| **Backend propio** | VPS | Es el destino definitivo, y ya está hecho: `server/crm-server.mjs` sobre el `Dockerfile` del repositorio |

El payload ya está definido abajo, así que cualquiera de ellos se conecta
poniendo una URL en `PHYTO_CRM_ENDPOINT` (y, si hace falta, ajustando el
`Content-Type`). Si prefieres otro destino, dime cuál y lo dejo funcionando y
probado.

---

## Modelo clave: frasco ≠ cantidad

| Concepto | Qué es | Ejemplo |
| --- | --- | --- |
| `variant` | **Frasco** (cápsulas) con su propio precio | `capsules_10` · 10 cápsulas · RD$2,500 |
| `quantity` | **Frascos** de ese tamaño que pide la persona | 2 |
| `total` | `unitPrice × quantity` | RD$5,000 |
| `totalCapsules` | Cápsulas totales del pedido | 20 |

Presentaciones reales: `capsules_5`, `capsules_7`, `capsules_10`, `capsules_15`,
`capsules_20`, `capsules_30`, `capsules_60` (esta última es el **frasco
completo**: se identifica con la etiqueta neutra "Frasco completo", nunca con
"mejor oferta" ni "más vendido").

---

## Transporte

- `POST` con `Content-Type: application/json`.
- `credentials: 'omit'` (endpoint público, sin cookies).
- Sin secretos ni tokens en el frontend.
- Timeout de 8 s (`siteConfig.crm.timeoutMs`).
- Si la respuesta no es `2xx` (o falla la red) el payload se reintenta desde la
  cola local: el usuario nunca ve un error y no se pierde el contacto.

---

## 1. `lead`

```jsonc
{
  "schemaVersion": "1.1",
  "type": "lead",
  "id": "9f1c…-uuid",
  "name": "Ana Gómez",
  "phone": "+18095551234",
  "location": "Higüey, La Altagracia",
  "source": "checkout",              // formulario | checkout | selector | hero | header | mobilebar | final | footer
  "productId": "phytoemagry-v1",
  "variantId": "capsules_10",        // null si viene del formulario general
  "variantName": "10 cápsulas",
  "capsules": 10,
  "quantity": 2,
  "consent": true,                  // un aviso: al pulsar el botón la persona inicia la conversación
  "consentVersion": "v1",
  "sessionId": "s_xxx",
  "attribution": {
    "source": "facebook",
    "utm_source": "facebook",
    "utm_medium": "cpc",
    "utm_campaign": "lanzamiento",
    "utm_content": "video-a",
    "utm_term": null,
    "fbclid": "IwAR…",
    "clickIds": { "fbclid": "IwAR…" },
    "landingPage": "/?utm_source=facebook&utm_campaign=lanzamiento",
    "referrer": "https://facebook.com/ads",
    "capturedAt": "2026-09-28T12:00:00.000Z",
    "touch": "first"
  },
  "landingPage": "/?utm_source=facebook",
  "createdAt": "2026-09-28T12:03:11.000Z"
}
```

> Si `source` es `checkout` (modal de compra), **`phone` y `location` van a
> `null`**: ese formulario solo pide el nombre, y el teléfono llega en el propio
> chat de WhatsApp. El ejemplo de arriba es del formulario de contacto, que sí
> los pide.

## 2. `order_intent`

```jsonc
{
  "schemaVersion": "1.1",
  "type": "order_intent",
  "id": "uuid",
  "leadId": "uuid-del-lead",

  "product": { "id": "phytoemagry-v1", "name": "Phytoemagry", "presentation": "10 cápsulas", "currency": "DOP" },

  "variantId": "capsules_10",
  "variantName": "10 cápsulas",
  "capsules": 10,

  "quantity": 2,               // frascos de ese tamaño
  "totalCapsules": 20,         // cápsulas totales
  "currency": "DOP",
  "unitPrice": 2500,           // precio por frasco
  "total": 5000,               // unitPrice × quantity

  "source": "checkout",
  "status": "pending_confirmation",
  "customer": { "name": "Ana Gómez", "phone": null, "location": null },
  "attribution": { "…": "igual que en el lead" },
  "sessionId": "s_xxx",
  "createdAt": "2026-09-28T12:03:11.000Z"
}
```

### Ejemplos de cálculo (verificados por tests)

| Presentación | Frascos | Total |
| --- | --- | --- |
| 10 cápsulas (RD$2,500) | 2 | **RD$5,000** |
| 30 cápsulas (RD$6,000) | 2 | **RD$12,000** |
| 60 cápsulas (RD$10,000) | 2 | **RD$20,000** |

### Reglas del contrato

1. **`order_intent` no es una venta.** El CRM la confirma (pago/entrega) y solo
   entonces pide el evento `purchase`.
2. La atribución es *first-touch* con TTL de 90 días (`src/lib/attribution.js`).
3. No se envían datos sensibles: nombre, teléfono, ciudad/país y el pedido. Nunca
   datos de pago ni documentos.
4. Todos los textos llegan saneados (sin caracteres de control ni `<>`); aun así
   **el CRM debe escapar al mostrar**.

---

## Eventos internos (`trackEvent`)

| Evento | Cuándo | Datos relevantes |
| --- | --- | --- |
| `page_view` | Carga de la landing | `page`, `landingPage`, `referrer`, `hasCampaign` |
| `view_product` | Carga de la landing | `variants` (y `variantId: null`: al entrar no hay frasco elegido) |
| `select_variant` | El usuario elige frasco | `variantId`, `capsules`, `unitPrice`, `quantity`, `total` |
| `click_buy` | Clic en cualquier botón *Comprar* | `source` + datos del frasco. Si no hay frasco elegido: `blocked: 'no_variant'` (y no se abre el modal) |
| `begin_checkout` | Se abre el modal de pedido | `variantId`, `capsules`, `quantity`, `totalCapsules`, `unitPrice`, `total` |
| `lead` | Formulario o pedido iniciado | `source`, `channel`, `leadId`/`orderIntentId` + frasco |
| `click_whatsapp` | Clic en un enlace de WhatsApp | `context: link\|selector\|checkout`, `variantId`, `quantity`, `total`, `opened` |
| `click_community_group` | Clic en el CTA de la comunidad | `groupId`, `groupName`, `sourceSection`, `utm_campaign`, `utm_content`, `ref` |
| `purchase` | **Solo** con confirmación del CRM | `orderId`, `value`, `currency` |
| `form_error` | Validación fallida | `fields` |

- `select_variant` **no** dispara `purchase`: elegir frasco no es una compra.
- `click_community_group` mide **interés**, no venta: se registra aparte de
  `click_whatsapp`, **nunca** cuenta como `lead` ni como `purchase` y no se envía
  al pixel. Un visitante que entra a la comunidad puede volver y comprar después;
  por eso no debe contaminar el embudo.
- Mapeo a Meta Pixel (con Pixel ID; hoy se mide sin aviso de cookies y, si
  `tracking.consentRequired` vuelve a `true`, tras aceptar): `page_view→PageView`,
  `view_product→ViewContent`, `begin_checkout→InitiateCheckout`, `lead→Lead`,
  `purchase→Purchase`.
- Los últimos 100 eventos quedan en `localStorage` (`pe:analytics.log`).

---

## Comunidad (grupos de WhatsApp) — desactivada por defecto

> ⚠️ **Estado actual:** `site.config.js` → `community.enabled: false`. La web no
> publica ningún grupo (el enlace al grupo hace que el visitante no escriba y se
> pierda su número). `view.js` no resuelve ningún grupo y, con eso, desaparecen la
> sección, el enlace de la zona de compra, la pregunta de la FAQ y el acceso del
> menú. El evento `click_community_group` sigue implementado y probado, pero hoy
> no puede dispararse desde la web.

- Configuración: `siteConfig.community.groups[]` con
  `id`, `name`, `url`, `active`, `priority`, `status`
  (`available` | `almost_full` | `full` | `disabled`), más el interruptor
  `siteConfig.community.enabled`.
- Activada, la landing publica **un solo** enlace: el primer grupo `active` +
  `available` por `priority`. Si no hay ninguno, el CTA se oculta.
- Los parámetros de sesión de la URL copiada se eliminan y solo se aceptan
  enlaces de `chat.whatsapp.com`.
- La comunidad es un canal de conversación: no se promete ningún resultado y la
  sección incluye el aviso de que no sustituye información médica.
- **Cifra de miembros:** el negocio ha comentado que existen "más de 4.000
  clientes", pero es un dato **sin verificar**. Se configura en
  `siteConfig.community.memberClaim` + `memberClaimVerified` y **solo se publica
  si `memberClaimVerified === true`**. Mientras no lo esté, la landing no muestra
  ninguna cifra de clientes ni promesa de resultados (lo bloquean `npm run check`
  y los tests).

### Afirmación de confianza publicada

La prueba social activa no es la comunidad sino una línea aprobada:

```js
// site.config.js
trust: { claim: 'Miles de personas ya cuentan con Phytoemagry.', claimVerified: true },
```

Se acepta **únicamente** desde ese campo y con `claimVerified: true`; copiada a
cualquier otro texto de configuración, el detector de afirmaciones la bloquea
(`npm run check` y tests). No admite resultados, salud ni plazos.

---

## Conectar el CRM (pasos)

1. Crear el endpoint público, p. ej. `POST https://crm.phytoemagry.com/api/public/events`.
2. Permitir CORS para el dominio de la landing (`POST`,
   `Content-Type: application/json`).
3. Definir `PHYTO_CRM_ENDPOINT` en `.env` y ejecutar `npm run build`.
4. Verificar que llegan ambos `type` y que `leadId` relaciona el pedido con su lead,
   y que `variantId` + `quantity` coinciden con lo que vio el cliente.
5. Añadir rate-limit por IP y validación de payload en el servidor.

### API pública del navegador

```js
Phytoemagry.getSelection();                     // { variant, quantity, totals }
Phytoemagry.selectVariant('capsules_30', 2);    // útil para pruebas
Phytoemagry.pendingCrmItems();                  // cola local pendiente
Phytoemagry.retryPendingCrmItems();             // reenvía la cola ahora mismo
Phytoemagry.confirmPurchase({ orderId, value, currency }); // solo desde el CRM
```

`trackPurchase()` ignora cualquier llamada sin
`{ orderId, confirmedByBackend: true }`: es imposible registrar una compra falsa
pulsando un botón.

### La cola local sí se reintenta

Cuando un envío no llega (el visitante se quedó sin datos justo en ese momento,
o el servidor se estaba reiniciando), el payload queda en `localStorage` con su
`queuedAt`. Al cargar la siguiente página, el cliente **reenvía hasta 10
pendientes** (uno por uno, y para en cuanto vuelve a fallar la red). Si el envío
se recupera, el registro entra en la base de datos y la cola se vacía. También se
puede forzar a mano con `Phytoemagry.retryPendingCrmItems()`.

Sin esto, la frase "no se pierde ningún contacto" era media verdad: el dato
sobrevivía, pero se quedaba para siempre en el navegador del visitante.
