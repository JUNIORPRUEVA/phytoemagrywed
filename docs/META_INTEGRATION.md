# Integración con Meta (Píxel + API de conversiones)

Qué mide la web, cómo se evita contar dos veces lo mismo, cuándo se cuenta una
venta y cómo comprobarlo en Events Manager. **Sin valores de credenciales**: aquí
solo se explica dónde vive cada cosa.

---

## 1. Arquitectura

```
                 ┌─────────────────────────── navegador ───────────────────────────┐
Anuncio Meta ───►│ landing Phytoemagry                                             │
                 │  1. guarda atribución (utm_*, fbclid, _fbc, _fbp)               │
                 │  2. Píxel (si hay ID y el visitante acepta la medición)         │
                 │     PageView · ViewContent · InitiateCheckout · Lead · Contact  │
                 │  3. el pedido viaja al CRM con sus `event_id` y su atribución   │
                 └───────────────────────────────┬─────────────────────────────────┘
                                                 │ POST /api/crm
                 ┌───────────────────────────────▼─────────────────────────────────┐
                 │ API del CRM (server/crm-server.mjs)                             │
                 │  · guarda lead / order_intent en la base de datos               │
                 │  · espejo del `Lead` por CAPI con el MISMO event_id             │
                 │  · cuando el negocio marca el pedido como ENTREGADO → Purchase  │
                 │    (una sola vez, idempotente)                                  │
                 └───────────────────────────────┬─────────────────────────────────┘
                                                 │ POST graph.facebook.com/<v>/<pixel>/events
                                                 ▼              (server/meta-capi.mjs)
                                          Meta Conversions API
```

- **Píxel del navegador**: `src/lib/tracking.js` (adaptador) +
  `src/client/init-tracking.js` (registro y consentimiento).
- **API de conversiones**: `server/meta-capi.mjs` (cliente aislado). Nunca se
  llama a Meta desde el navegador.
- **Venta**: `server/crm-server.mjs` decide y escribe el resultado en la fila del
  pedido.

---

## 2. Variables de entorno

| Variable | Dónde vive | Para qué |
| --- | --- | --- |
| `PHYTO_META_PIXEL_ID` | `.env` / build args / Environment | ID del píxel (dataset). **Público**: va dentro del HTML |
| `PHYTO_META_CAPI_ACCESS_TOKEN` | **solo servidor** (Environment) | Token de la API de conversiones. **SECRETO** |
| `PHYTO_META_CAPI_TEST_EVENT_CODE` | solo UAT | Código `TEST…` para ver los eventos en vivo |
| `PHYTO_META_GRAPH_VERSION` | opcional | Versión de la Graph API (por defecto `v21.0`) |
| `PHYTO_META_PURCHASE_STATUS` | opcional | Estado del CRM que representa una VENTA (por defecto `entregado`) |

Reglas que respeta el código:

- Sin `PHYTO_META_PIXEL_ID` **no se carga ningún script de Meta** y no aparece el
  banner de consentimiento.
- Sin `PHYTO_META_CAPI_ACCESS_TOKEN` la API de conversiones queda desactivada: el
  CRM funciona igual y guarda los pedidos.
- El token **nunca** sale del servidor: no viaja al navegador, no se registra en
  logs y los errores van saneados (`[oculto]`).
- El **pixel ID se incrusta en el build** (cambiarlo = volver a desplegar); el
  token es de ejecución (cambiarlo = reiniciar).

### Quitar el modo prueba

```env
# LOCAL / UAT
PHYTO_META_CAPI_TEST_EVENT_CODE=TEST12345

# PRODUCCIÓN
PHYTO_META_CAPI_TEST_EVENT_CODE=
```

Además hay una protección real: si `APP_ENV=production`, el código de prueba se
**ignora aunque esté puesto** (y se avisa por consola). Un código olvidado no
puede convertir el tráfico real en tráfico de prueba.

---

## 3. Eventos

| Acción real | Navegador (píxel) | Servidor (CAPI) | `event_id` |
| --- | --- | --- | --- |
| Cargar la página | `PageView` | — | `pv_<uuid>` |
| Ver el producto | `ViewContent` | — | `vc_<uuid>` |
| Elegir frasco | `select_variant` (personalizado) | — | `sv_<uuid>` |
| Pulsar Comprar | `click_buy` (personalizado) | — | `cb_<uuid>` |
| Abrir el pedido | `InitiateCheckout` | — | `ic_<uuid>` |
| Enviar el formulario | `Lead` | `Lead` (espejo) | `lead_<uuid>` |
| Clic en WhatsApp | `Contact` (1ª vez) + `click_whatsapp` | — | `contact_<uuid>` |
| **Venta cerrada** | — | **`Purchase`** | `purchase_<id del pedido>` |

Notas:

- Los eventos **propios** (`select_variant`, `click_buy`, `click_whatsapp`) se
  envían con `trackCustom`. Nunca se envían como evento estándar inventado.
- `ViewContent` e `InitiateCheckout` solo existen en el navegador: el servidor no
  tiene un punto fiable para ellos (si el visitante abandona, no hay nada que
  reenviar).
- `Lead` **sí** se reenvía desde el servidor con el **mismo `event_id`** que usó
  el píxel, para que Meta cuente una sola conversión aunque lleguen las dos
  copias. El `event_id` viaja en el payload del pedido (`payload.meta.events`).
- Un clic en WhatsApp **no es** una compra: como máximo cuenta un `Contact` por
  sesión (el resto de clics quedan como evento propio, para no inflar nada).

---

## 4. Cuándo se envía `Purchase` (regla de negocio)

`Purchase` **solo** se envía cuando el negocio marca el pedido como
**`entregado`** en el panel (dinero cobrado). No se envía al:

- cargar la página,
- elegir frasco,
- pulsar Comprar,
- abrir WhatsApp,
- crear el lead,
- ni al marcar `confirmado` (un pedido confirmado todavía puede caerse).

Es el mismo criterio que usa el panel para su cifra de *valor entregado*
(`computeStats`), así que la web y Meta dicen lo mismo. Si el negocio prefiere
otro criterio, se cambia con `PHYTO_META_PURCHASE_STATUS` **sin tocar código**;
los estados disponibles son `nuevo`, `contactado`, `interesado`, `confirmado`,
`entregado` y `perdido`.

Datos que se envían: `currency` (moneda del pedido, `DOP`), `value` (el total
REAL del pedido, nunca una cifra escrita a mano), `content_ids` con el id del
frasco, `order_id`, `event_source_url` (guardado con el pedido) y `user_data`
(`fbc`, `fbp`, teléfono hasheado si existe).

---

## 5. Idempotencia (nunca dos veces la misma venta)

La venta guarda su estado **en la propia fila del pedido**:

| Columna | Significado |
| --- | --- |
| `meta_purchase_event_id` | `purchase_<id del pedido>` (estable para siempre) |
| `meta_purchase_sent_at` | cuándo la aceptó Meta (si tiene valor, **no se reenvía**) |
| `meta_purchase_status` | `sent` / `failed` |
| `meta_purchase_attempts` | intentos acumulados (tope 5 en el reintento automático) |
| `meta_purchase_error` | último error, saneado y sin credenciales |

- Si Meta falla, el pedido **queda igual** (entregado) y el envío se marca
  `failed`: no se pierde una venta por un tercero.
- Al arrancar, el servidor reintenta lo pendiente (máximo 10 pedidos, 5 intentos
  cada uno): no hay bucles infinitos.
- El panel permite reenviar a mano desde la ficha del pedido
  (`POST /api/admin/items/:id/meta-purchase`, requiere sesión).

---

## 6. Atribución

Se guarda con el pedido y sobrevive a todo el flujo:

`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`,
`fbclid`, `gclid`, `ttclid`, `msclkid`, **`_fbc`**, **`_fbp`**, URL de llegada,
referrer y fecha (first-touch 90 días + last-touch de la sesión).

- `_fbc` / `_fbp` se leen de las cookies reales de Meta. Si `_fbc` no está pero
  hay `fbclid` en la URL, se construye con el formato oficial
  (`fb.1.<milisegundos>.<fbclid>`).
- Para CAPI: `fbc`, `fbp`, `client_ip_address` y `client_user_agent` viajan **sin
  hashear** (como pide Meta); el teléfono, el nombre y el `external_id` se
  normalizan y se hashean con SHA-256.

---

## 7. Privacidad y consentimiento

- El píxel solo se carga si el visitante **acepta** el banner de medición. Si
  rechaza, no se carga ningún script de Meta.
- El servidor guarda la decisión de consentimiento con el registro y respeta la
  misma regla para el espejo del `Lead` (si no hay consentimiento, no se envía).
- No se envían datos que el sistema no recoge (fecha de nacimiento, sexo,
  apellidos, dirección).
- `Purchase` sí se envía aunque no haya consentimiento de publicidad, porque es
  una transacción con el propio cliente (primera parte) y es la única forma de
  medir ventas reales. Si se prefiere lo contrario, se cambia en
  `server/crm-server.mjs` → `mirrorLeadToMeta`.

---

## 8. Cómo comprobarlo

1. **Events Manager → Probar eventos**: pega el `TEST…` y verás los eventos en
   vivo (navegador + servidor) con su `event_id` y si Meta los deduplicó.
2. **Panel → ficha del pedido**: la sección *Venta en Meta* dice si se envió, si
   falló o si está pendiente, y permite reenviar.
3. **CSV** (`/api/crm/export.csv`): columnas `meta_venta` y `meta_enviada`.
4. `GET /api/health`: estado del almacén (sin datos personales).
5. `GET /api/admin/data`: bloque `meta` → `{ configured, testEventCode,
   purchaseStatus, graphVersion }` (sin credenciales).

---

## 9. Problemas típicos

| Síntoma | Causa y solución |
| --- | --- |
| El píxel no envía nada | No hay `PHYTO_META_PIXEL_ID`, o el visitante no aceptó el banner |
| Llega `PageView` pero nada más | (Corregido) Los adaptadores deben registrarse en el tracker: `tracker.addAdapter`. Lo cubre `tests/meta-pixel-wiring.test.js` |
| `Purchase` nunca se envía | El pedido no está en el estado de venta (`PHYTO_META_PURCHASE_STATUS`, por defecto `entregado`), o faltan credenciales de CAPI |
| Meta devuelve `events_received: 0` | El `event_name` o el `event_id` van vacíos; mira el error saneado en la fila del pedido |
| «venta a Meta: falló · HTTP 400 · code 190» | Token caducado o sin permisos: genera uno nuevo en Events Manager → Configuración → API de conversiones |
| Los eventos salen en *Probar eventos* pero no cuentan | El código de prueba está activo: quítalo (`PHYTO_META_CAPI_TEST_EVENT_CODE=`) |
| Aparece el aviso de que el código de prueba se ignora | `APP_ENV=production`: es la protección, no un fallo |

---

## 10. Tests que cubren esto

- `tests/meta-capi.test.js` — normalización de teléfono dominicano, SHA-256,
  `fbc`/`fbp` sin hashear, payload, `test_event_code`, saneado de errores,
  versión de Graph.
- `tests/meta-purchase.test.js` — con el CRM real y un Meta simulado: cuándo se
  envía `Purchase`, idempotencia, reinicio, fallo de Meta, reenvío manual y
  «el token no aparece en ninguna respuesta».
- `tests/meta-pixel-wiring.test.js` — el píxel recibe todos los eventos, `Contact`
  una vez por sesión, los eventos propios no son estándar y sin consentimiento no
  sale nada.
- `tests/tracking.test.js` y `tests/client-flow.test.js` — la landing y el
  inventario de eventos de una compra.
