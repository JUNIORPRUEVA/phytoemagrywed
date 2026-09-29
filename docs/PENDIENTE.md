# Información pendiente

Ejecuta **`npm run check`** para ver el estado actual: lista las afirmaciones
prohibidas detectadas, la coherencia de los frascos, el grupo de comunidad
que se publicará y los datos que faltan.

> Regla del proyecto: **lo que no está configurado no se muestra**. Nunca se
> inventa información del producto, ni precios, ni entregas, ni testimonios.

---

## 1. Ya implementado con información real

| Dato | Dónde | Estado |
| --- | --- | --- |
| 7 frascos con precio en RD$ (5, 7, 10, 15, 20, 30, 60) | `product.config.js` → `variants` | ✅ |
| "Frasco completo" en el frasco de 60 cápsulas | `variants[].completeBottle` | ✅ |
| **Portada principal** con la línea completa de frascos | `images.hero` (+ `assets/portadaprincipal.png`) | ✅ |
| **Foto propia de cada frasco** en el carrusel | `variants[].image` (+ `assets/fasco <N> capsula.png`) | ✅ |
| **Número de WhatsApp de atención** (pedidos y dudas) | `.env` → `PHYTO_WHATSAPP_NUMBER` | ✅ `18297853794` |
| **Número a la vista** del visitante (footer y contacto) | `site.config.js` → `contact.whatsapp.displayNumber` | ✅ `+1 829 785 3794` |
| **Descripción del producto** y **modo de uso** | `product.config.js` → `description`, `usage` | ✅ |
| Moneda y formato dominicano (RD$1,250) | `site.config.js` → `commerce.currency/locale` | ✅ |
| 5 grupos de WhatsApp con selección automática por prioridad | `site.config.js` → `community.groups` | ✅ (no publicados) |
| Textos de comunidad, selector, FAQ y WhatsApp | `content.config.js` | ✅ |

## 2. Imprescindible antes de publicar

| Dato | Dónde | Sin él... |
| --- | --- | --- |
| **Datos de la empresa** (razón social, RNC, domicilio, país) | `site.config.js` → `privacy.company` | Páginas legales con marcas `[PENDIENTE]`: es lo que más resta credibilidad |
| **Dominio final** | `.env` → `SEO_SITE_URL` | Sin `canonical` ni `sitemap.xml`, y **el enlace compartido por WhatsApp no muestra imagen** |
| **Plazo de conservación de datos** | `site.config.js` → `privacy.retentionDays` | Política de privacidad incompleta |
| **Mensaje y zonas de entrega** | `site.config.js` → `commerce.deliveryMessage`, `deliveryAreas` | "¿Llega a mi zona?" queda sin responder |
| **Métodos de pago reales** | `site.config.js` → `commerce.paymentMethods` | "¿Cómo pago?" queda sin responder |
| **Aviso al consumidor** aprobado | `product.config.js` → `disclaimer` | CTA final sin aviso legal |
| **Descripción corta (hero)** aprobada | `product.config.js` → `shortDescription` | Hero sin bajada (funciona, pero comunica menos) |
| **Horario de atención** | `site.config.js` → `contact.whatsapp.hours` | El visitante no sabe cuándo le responderán |
| **Endpoint del CRM** | `.env` → `PHYTO_CRM_ENDPOINT` | Los contactos viven solo en el navegador del visitante (cola local) |
| **Meta Pixel** | `.env` → `PHYTO_META_PIXEL_ID` | ✅ Configurado. Ver `docs/META_INTEGRATION.md` |
| **API de conversiones** (`Purchase` real) | Easypanel → `PHYTO_META_CAPI_ACCESS_TOKEN` | Quitar `PHYTO_META_CAPI_TEST_EVENT_CODE` en producción (con `APP_ENV=production` se ignora igualmente) |

## 3. Fotos

### Portada principal (ya integrada)

`assets/portadaprincipal.png` (1672×941) → versiones web generadas con
`npm run images:hero` en `public/assets/img/portada-principal-<ancho>.{avif,webp}`
+ fallback JPG. Si se cambia la foto, hay que actualizar también `heroWidth`,
`heroHeight` y `heroWidths` en `product.config.js`.

### Fotos por frasco (ya integradas)

Los originales viven en `assets/fasco <N> capsula.png` (el número de cápsulas es
obligatorio en el nombre) y se convierten a web con `npm run images:frascos` en
`public/assets/img/frascos/frasco-<N>-{320,480}.{avif,webp}` + fallback JPG de
480. Cada tarjeta del carrusel usa la foto de SU frasco: si un frasco no tuviera
foto, esa tarjeta se muestra sin imagen, nunca con la de otro.

Para cambiar una foto: sustituye el PNG en `assets/`, ejecuta
`npm run images:frascos` y (si cambia el tamaño) actualiza
`images.variantWidth/Height/Widths` en `product.config.js`. `npm run check`
falla si falta cualquier archivo declarado.

## 4. Comunidad: retirada de la web (y cómo volver a publicarla)

**Los grupos no se publican**: `site.config.js` → `community.enabled: false`.
Motivo comercial: si el enlace al grupo está en la página, el visitante entra al
grupo en lugar de escribir, y se pierde su número de teléfono.

Con el interruptor en `false` desaparecen a la vez: la sección, el enlace de la
zona de compra, la pregunta de la FAQ y el acceso del menú. Para volver a
publicarla basta con `enabled: true` (los 5 grupos siguen configurados).

Si se reactiva, mantener el `status` de cada grupo al día:

```js
{ id: 'group_1', … status: 'full' },   // deja de publicarse
```

La landing pasa automáticamente al siguiente `active` + `available`. Si ninguno
está disponible, el CTA de comunidad se oculta solo.

### Afirmación publicada: "Miles de personas ya cuentan con Phytoemagry."

Es la única cifra de prueba social de la web y está **aprobada por el negocio**:

```js
// site.config.js → trust
claim: 'Miles de personas ya cuentan con Phytoemagry.',
claimVerified: true,   // ⚠️ con `false` la línea desaparece de la web
```

- **Pendiente (negocio):** poder demostrarla si alguien la cuestiona (facturas,
  base de clientes, CRM). Una plataforma publicitaria puede pedir la fuente.
- Solo puede vivir en ese campo: copiada a cualquier otro texto, el detector la
  bloquea y `npm run check` falla.
- La cifra de la comunidad (`community.memberClaim` + `memberClaimVerified`)
  sigue disponible y sin usar; hoy está en `null` / `false`.

> Ni con una cifra verificada se puede escribir "miles de personas obtuvieron
> resultados" ni "resultados comprobados": eso lo bloquea el detector de
> afirmaciones (`content-safety`) en tests, en `npm run check` y en el build.

### Bloques de la página (qué se publica)

La web se mantiene lo más ligera posible desde `site.config.js` →
`features.sections`. Hoy está apagado `howToBuy` (los 4 pasos duplicaban el
proceso que ya explican el selector y la FAQ). Para volver a mostrarlo:
`howToBuy: true` (y su enlace del menú vuelve solo).

## 5. Datos que NO se deben rellenar sin documentación oficial

Regla reforzada por tests automáticos (`tests/content-safety.test.js` y
`npm run check`, que **fallan** si aparecen):

- Beneficios médicos, enfermedades tratadas o curación.
- Pérdida de peso, libras/kilos, plazos de resultados.
- Ingredientes, modo de uso o información nutricional no aprobados.
- Registro sanitario, fabricante, origen o certificaciones no confirmadas.
- Avales (FDA, OMS, EMA, Digemaps), "100 % natural/efectivo", "sin efectos
  secundarios", "clínicamente probado".
- Cifras de clientes, estadísticas, estrellas o "antes y después".
- "Únete a miles de personas que ya tuvieron resultados", "Comprueba los
  resultados", "Resultados comprobados", "Resultados reales garantizados",
  "Personas que ya rebajaron".
- Escasez o urgencia artificial ("últimas unidades", "solo hoy", contadores).
- Etiquetas de presión comercial en los frascos ("Más vendido", "Mejor opción",
  "Recomendado", "Oferta", "Ahorras"): hoy no hay datos que las respalden.
- Métodos de pago, plazos de entrega o garantías no confirmados.
- Testimonios inventados o copiados de grupos privados sin autorización.

## 6. Decisiones operativas pendientes
- ¿Se publica con `noindex` mientras el contenido no está aprobado?
  (`site.config.js` → `seo.noindex`, hoy en `false`).
- ¿Se activa Meta Pixel? (`PHYTO_META_PIXEL_ID`). El banner de consentimiento
  aparece automáticamente y el pixel solo carga si se acepta.
- ¿Endpoint definitivo del CRM para dejar de usar la cola local?
  (`PHYTO_CRM_ENDPOINT`).
- Confirmar si hay entrega en Higüey y zonas aledañas, punto de entrega y envíos
  nacionales (`commerce.pickupAvailable`, `shippingAvailable`).

## 7. Revisión: ¿esta web puede generar confianza, clientes y compras?

### Lo que ya empuja a la venta (no tocar)

| Palanca | Cómo está |
| --- | --- |
| Pedir en 1 toque, sin registrarse | Cada frasco tiene su botón de WhatsApp con el pedido ya escrito (producto, frasco, cantidad, precio, total) |
| Pedido sin fricción | El modal de compra pide **solo el nombre**; el frasco/cantidad/total ya están elegidos y viajan en el mensaje |
| Nada de callejones | Comprar sin frasco elegido no falla ni abre el modal: pide elegir el frasco y baja al carrusel |
| Dónde se cierra la venta, dicho claro | "El pedido se finaliza por WhatsApp" en el resumen, en el modal (3 sitios) y en el panel de éxito |
| Precio claro antes de pedir | Los 7 precios en RD$, a la vista, sin "consultar precio" |
| Foto real por frasco | Carrusel deslizable; el cliente ve justo el frasco que va a pedir |
| Número a la vista | `+1 829 785 3794` en el footer y junto al formulario: se ve que hay alguien detrás |
| Sin riesgo percibido | "No se realiza ningún cobro en esta página" (resumen, modal y formulario) |
| Nada se pierde | Si un envío falla (móvil sin datos), el dato queda en una cola local y se reenvía al cargar la siguiente página |
| Panel para el negocio | `/admin/` se instala en el móvil como app (PWA): recordatorios, notas, estados y mensajes de WhatsApp con plantillas. Ver [`PANEL.md`](PANEL.md) |
| Dos caminos, nunca un callejón | Pedir (WhatsApp/modal) **y** dejar el contacto desde el propio resumen |
| Prueba social aprobada | "Miles de personas ya cuentan con Phytoemagry." (verificada por el negocio) |
| Cero afirmaciones que resten | Sin promesas médicas ni de resultados: nada que un consumidor pueda rebatir |
| Móvil primero | Barra fija con Comprar + WhatsApp y carrusel táctil; Lighthouse 99 con CLS 0 |

### Los 3 datos que más ventas desbloquean (solo los tiene el negocio)

1. **Entrega y pago** (`commerce.deliveryMessage`, `deliveryAreas`,
   `pickupAvailable`, `shippingAvailable`, `paymentMethods`). Son las dos dudas
   que frenan a casi todo el que escribe: "¿llega a mi zona?" y "¿cómo pago?".
   Cuando se rellenen, aparecen solos en el footer y en la FAQ.
2. **Dominio real** (`SEO_SITE_URL`). Sin él, el enlace que se comparte por
   WhatsApp **no muestra imagen** ni texto enriquecido: es la primera impresión
   de quien recibe el link, y hoy es la vía principal de entrada.
3. **Datos de la empresa** (`privacy.company`) y **aviso al consumidor**
   (`product.disclaimer`). Un fitoterápico con datos legales visibles (razón
   social, RNC, domicilio, registro) vende mucho más que uno sin ellos, y es
   exigible al vender al público.

### Para captar clientes potenciales de verdad

- **Dónde llegan los contactos**: hoy **al WhatsApp del negocio**
  (`+1 829 785 3794`) **y a la base de datos de la propia web** (incluida en la
  imagen Docker). Los **pedidos** llegan completos (frasco, cantidad, precio por
  frasco, cápsulas, total y el nombre que se escribe en el modal); los
  **contactos del formulario** llegan con nombre, teléfono y ubicación ya
  escritos. El visitante solo pulsa enviar. Se leen en
  `tu-dominio/panel?token=TU_CLAVE` y se descargan en CSV. Detalle y opciones en
  [`CRM-CONTRACT.md`](CRM-CONTRACT.md) → "¿Dónde llegan los contactos?".
- **Lo que hay que hacer una vez en el servidor** (si despliegas con Docker):
  definir `PHYTO_CRM_DATABASE_URL` (la base de datos PostgreSQL donde se guardan
  los pedidos y los contactos), `PHYTO_CRM_TOKEN` (la clave para leerlos) y
  `PHYTO_CRM_ENDPOINT=/api/crm` (para que la web envíe los datos al API; si se
  queda vacío, la web no envía nada). Si no configuras PostgreSQL, hay que montar
  un volumen en `/data` (ahí queda el archivo de SQLite). Paso a paso en
  [`DESPLIEGUE.md`](DESPLIEGUE.md) → §3.
- **Horario de atención** (`contact.whatsapp.hours`): decir cuándo se responde
  sube la tasa de respuesta del primer mensaje.
- **Testimonios reales** (`content.testimonials.items` + su `disclaimer`): la
  sección está lista y oculta; se publica en cuanto haya testimonios con
  autorización.
- **Meta Pixel** (`PHYTO_META_PIXEL_ID`): sin medición no se puede saber qué
  anuncio trae compradores.

### Riesgo a vigilar

Mientras `privacy.company` siga vacío, las páginas legales muestran `[PENDIENTE]`.
Si la web va a recibir tráfico de pago o va a indexarse, conviene cerrar esos
datos **antes** (o publicar con `seo.noindex: true` hasta tenerlos).

