# Contrato de datos con el mini-CRM Phytoemagry

La landing **ya está preparada** para enviar datos al CRM. Mientras
`PHYTO_CRM_ENDPOINT` esté vacío, los datos se guardan en una cola local del
navegador (`localStorage`, clave `pe:crm.queue`, máximo 50 elementos) y nada sale
a la red. Al configurar el endpoint, los mismos payloads viajan por HTTP sin
tocar la interfaz.

Implementación: `src/lib/api.js` (`buildLeadPayload`, `buildOrderIntentPayload`,
`createCrmClient`). Esquema actual: **`schemaVersion: "1.1"`**.

---

## ¿Dónde llegan los contactos y los pedidos?

Hay **dos canales**, y hoy funciona el primero:

| Canal | Qué llega | Cuándo |
| --- | --- | --- |
| **WhatsApp `+1 829 785 3794`** | Todo, ya escrito y listo: cada pedido (frasco, cantidad, precio, total y el nombre) y cada contacto del formulario (nombre, teléfono, ubicación) | **Ya funciona**, sin configurar nada |
| **CRM** (`PHYTO_CRM_ENDPOINT`) | El mismo dato en formato estructurado (`lead` y `order_intent`), guardado en tu sistema | Cuando exista el endpoint |

**Importante:** mientras no haya endpoint, la cola local (`pe:crm.queue`) vive en
el navegador **del visitante**, no en un servidor. Sirve como red de seguridad
(la web no pierde el dato si el envío falla), pero **no es una base de datos de
clientes**: solo se ve desde la consola de ese navegador con
`Phytoemagry.pendingCrmItems()`. La vía por la que el negocio recibe el contacto
hoy es WhatsApp.

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

Así el contacto se puede responder en minutos y también queda preparado para
enviarse al CRM cuando exista.

### Opciones para conectarlo (elige una)

| Opción | Coste | Notas |
| --- | --- | --- |
| **Google Sheets** (Apps Script publicado como Web App) | Gratis | Los leads caen en una hoja de cálculo que puedes abrir en el móvil. Apps Script no responde al preflight CORS: hay que recibirlo como `text/plain` (ajuste pequeño en `src/lib/api.js`, se hace al conectar) |
| **Make / Zapier / n8n** (webhook) | Desde gratis | Envía un correo, avisa por WhatsApp/Telegram o escribe en Sheets sin programar |
| **Formulario tipo Formspree / Getform** | Gratis con límite | Recibe el POST y te avisa por correo; luego se descarga a Excel/Sheets |
| **Backend propio** | VPS | Es el destino definitivo: ya tienes `Dockerfile` + `nginx/` en el repositorio para el despliegue |

El payload ya está definido abajo, así que cualquiera de ellos se conecta
poniendo una URL en `PHYTO_CRM_ENDPOINT` (y, si hace falta, ajustando el
`Content-Type`). **Dime cuál prefieres y lo dejo funcionando y probado.**

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
| `view_product` | Carga de la landing | `variants`, frasco preseleccionado |
| `select_variant` | El usuario elige frasco | `variantId`, `capsules`, `unitPrice`, `quantity`, `total` |
| `click_buy` | Clic en cualquier botón *Comprar* | `source` + datos del frasco |
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
- Mapeo a Meta Pixel (con Pixel ID y consentimiento): `page_view→PageView`,
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
Phytoemagry.confirmPurchase({ orderId, value, currency }); // solo desde el CRM
```

`trackPurchase()` ignora cualquier llamada sin
`{ orderId, confirmedByBackend: true }`: es imposible registrar una compra falsa
pulsando un botón.
