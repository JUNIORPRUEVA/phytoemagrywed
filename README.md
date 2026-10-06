# Phytoemagry — Landing comercial (V1)

Landing de conversión pensada para tráfico pagado (Meta/Facebook/Instagram), con
medición propia, captura de UTM y arquitectura preparada para el mini-CRM.

- **Sin frameworks.** HTML semántico generado en build + CSS propio + JavaScript
  nativo (ES modules). Cero dependencias en producción.
- **Mobile-first.** Todo elemento interactivo ≥ 48 px, barra de CTA fija en móvil.
- **Sin datos inventados.** Si un dato no está en la configuración, la sección no
  se renderiza. Ver [`docs/PENDIENTE.md`](docs/PENDIENTE.md).
- **Medición lista.** Capa propia `trackEvent()`, adaptador de Meta Pixel opcional
  (solo con consentimiento) y `purchase` reservado al CRM.

---

## Puesta en marcha

```bash
npm install          # solo herramientas de desarrollo (esbuild, vitest, jsdom)
cp .env.example .env # completa lo que exista de verdad
npm run dev          # http://localhost:5173
```

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Compila en watch y sirve `dist-dev/` con recarga automática (no toca `dist/`) |
| `npm run build` | Build de producción en `dist/` (minificado, con hash de contenido) |
| `npm run preview` | Sirve el `dist/` ya construido en `:4173` |
| `npm test` | Suite de pruebas (182 tests) |
| `npm run check` | Revisión previa a publicar: afirmaciones prohibidas, precios, fotos de los frascos, comunidad (si está activa), afirmación de confianza y datos pendientes |
| `npm run audit:content` | Solo la auditoría de afirmaciones prohibidas |
| `npm run inspect:render` | Resumen del HTML generado (secciones, precios, grupos) |
| `npm run verify` | tests + check + build |
| `npm run images` | Regenera las imágenes de marca (requiere Pillow) |
| `npm run images:hero` | Optimiza la portada panorámica (AVIF/WebP/JPG a 480/768/1200/1672) |
| `npm run images:frascos` | Optimiza la foto de cada frasco (AVIF/WebP/JPG a 320/480, recorte cuadrado) |

---

## Estructura

```
src/
  config/            ← ÚNICO sitio donde se edita el contenido
    site.config.js     marca, contacto, WhatsApp, SEO, CRM, **comunidad**, entregas, analítica, legal
    product.config.js  ficha del producto y **los 7 frascos** (cápsulas + precio)
    content.config.js  textos, FAQ, selector, comunidad, formulario, errores
  lib/               lógica isomorfa (build + navegador)
    tracking.js        eventos + adaptadores (Meta Pixel, dataLayer)
    attribution.js     UTM / fbclid, first-touch y last-touch
    variants.js        frascos: normalización, totales y validación
    community.js        grupos de WhatsApp: estado y selección automática
    content-safety.js  detección de afirmaciones prohibidas (tests + check + build)
    whatsapp.js        construcción del enlace (una sola vez en todo el código)
    api.js             contrato y cliente del CRM (cola local si no hay endpoint)
    validation.js      sanitización y reglas de validación
    consent.js         consentimiento de medición publicitaria
  render/            generación de HTML en build (SEO, sin JS necesario)
  client/            interactividad
    variant-selector.js  carrusel de frascos: deslizamiento, flechas + resumen del pedido
    selection.js         estado compartido (frasco + cantidad)
    order-message.js     mensaje de WhatsApp del pedido
    checkout.js  lead-form.js  whatsapp-actions.js  consent-banner.js
  styles/            tokens → base → layout → componentes
server/
  crm-server.mjs     API del CRM: guarda los pedidos y los contactos en PostgreSQL
                     (o SQLite si no hay base de datos), + panel y CSV. Ver docs/CRM-CONTRACT.md
scripts/
  build.mjs  dev.mjs  render-once.mjs  check-content.mjs  audit-content.mjs
  inspect-render.mjs  clean.mjs  generate-placeholder-images.py  optimize-hero-image.py
  optimize-variant-images.py
public/              assets estáticos (favicon, OG, iconos, fotos)
  assets/img/frascos/  foto de cada frasco (carrusel): frasco-<N>-{320,480}.{avif,webp,jpg}
data/                base de datos local de SQLite (solo si no usas PostgreSQL) — NO se versiona
docs/                contrato del CRM, guía del panel, pendientes y decisiones técnicas
tests/               unidades, render, flujos de cliente, API del CRM, panel y contenido
public/admin/        el mini-CRM instalable (PWA): una página, sin frameworks

### Editar contenido

1. Abre `src/config/*.config.js` y rellena **solo datos reales y aprobados**.
2. `npm run check:content` para ver qué falta.
3. `npm run build`.

Los valores que pueden cambiar por entorno (número de WhatsApp, dominio, endpoint
del CRM, Pixel) se leen de `.env` y **sobrescriben** el valor del config.
`.env.local` contiene overrides **solo para desarrollo**: `npm run dev` sí los usa,
pero `npm run build` **los ignora siempre**, así que un número de prueba local no
puede acabar publicado en `dist/`. El servidor de desarrollo sirve `dist-dev/`
(nunca se despliega); `dist/` solo lo genera `npm run build`.

---

## Cómo se renderiza

El HTML se genera en tiempo de build (`src/render/`). Ventajas:

- el contenido está en el HTML (SEO y primer pintado sin esperar JavaScript);
- el JavaScript solo añade interacción (modal, formulario, medición) y pesa
  ~35 kB sin comprimir (~11 kB gzip);
- sin hidratación, sin framework y sin `layout shift` por contenido tardío.

---

## Imágenes

Convenio: para una ruta base `/assets/img/producto-hero` deben existir

```
producto-hero-640.avif   producto-hero-640.webp   producto-hero-640.jpg
producto-hero-1024.avif  producto-hero-1024.webp  producto-hero-1024.jpg
```

y basta con indicar la base en `productConfig.images.hero`. El render genera el
`<picture>` con AVIF → WebP → JPG, `srcset`, `width`/`height` (sin CLS) y
`loading="lazy"` bajo el pliegue (la portada va con `loading="eager"` +
`fetchpriority="high"` y se **precarga** en el `<head>`).

### Portada principal (panorámica)

La portada es el panorama con la línea completa de frascos (5 → 60 cápsulas):

| Dónde | Qué |
| --- | --- |
| `assets/portadaprincipal.png` | Original (1672×941), se conserva sin tocar |
| `public/assets/img/portada-principal-<ancho>.{avif,webp}` | Versiones web (480, 768, 1200, 1672) |
| `public/assets/img/portada-principal-1672.jpg` | Fallback para navegadores antiguos |

Se regeneran con `npm run images:hero` (Pillow). Los anchos, las dimensiones
reales y el texto alternativo se declaran en `product.config.js` →
`images.hero`, `heroWidth`, `heroHeight`, `heroWidths`, `heroAlt`; si cambias de
imagen, actualiza esos valores o el `srcset`/`width`/`height` no coincidirán.

Reglas de composición (con tests):

- **Nunca se recorta ni se deforma**: `object-fit: contain` + `width`/`height`
  reales. En móvil ocupa todo el ancho; en escritorio se limita por altura.
- La portada **no repite** el nombre del producto ni los nombres de los frascos
  (ya están dentro de la imagen): el `<h1>` existe pero es `sr-only`.
- Solo aparece **el precio inicial** ("Desde RD$1,250"); los 7 precios viven en
  «Elige tu frasco».

Cada frasco tiene su propia foto real (tarjetas del carrusel): se genera con
`npm run images:frascos` y se declara en `productConfig.variants[].image` (ruta
base). Si es `null`, la tarjeta se muestra sin imagen — nunca con la foto de otro
frasco. Mientras `images.hero` sea `null` se muestra un **marcador honesto**
("Imagen pendiente"), nunca una foto inventada.

### Fotos de cada frasco (carrusel «Elige tu frasco»)

| Dónde | Qué |
| --- | --- |
| `assets/fasco <N> capsula.png` | Originales (1254×1254), se conservan sin tocar |
| `public/assets/img/frascos/frasco-<N>-{320,480}.{avif,webp}` | Versiones web |
| `public/assets/img/frascos/frasco-<N>-480.jpg` | Fallback para navegadores antiguos |

Se regeneran con `npm run images:frascos` (Pillow). El script **recorta al centro
a un cuadrado uniforme**: las 7 fotos son casi cuadradas y el frasco está
centrado, así las 7 tarjetas miden exactamente lo mismo (nada salta y ninguna
foto se deforma). Los anchos y las dimensiones se declaran en `product.config.js`
→ `images.variantWidth`, `variantHeight`, `variantWidths`.

Reglas (con tests):

- El `sizes` de la foto es el ancho **real de la tarjeta** (`240px`; `232px` en
  escritorio), no `100vw`: en móvil se descarga ~18 kB por frasco.
- Todas las fotos van `loading="lazy"`: la portada sigue siendo el LCP.
- `npm run check` **falla** si falta algún archivo declarado (una tarjeta rota no
  puede llegar a producción).

---

## Despliegue

```bash
npm run build     # genera dist/
```

`dist/` es 100 % estático: Nginx, Caddy, CDN o cualquier hosting sirven la carpeta.
Incluye un `Dockerfile` **autocontenido** (compila con tests, sirve con nginx y
levanta el API del CRM con su base de datos; lleva dentro su propia config del
servidor) y un `docker-compose.yml`.

```bash
docker compose up -d --build        # o: docker build -t phytoemagry . && docker run -p 8080:80 phytoemagry
```

Dos variables bastan para no perder datos (ni quedarte sin poder leerlos):

1. **`PHYTO_CRM_DATABASE_URL`** con la cadena de PostgreSQL (los pedidos y los
   contactos se guardan ahí, no dentro del contenedor). Si la dejas vacía, se usa
   SQLite y entonces sí necesitas un **volumen en `/data`**: Easypanel → Mounts →
   Volume → `/data`; con Compose ya está configurado.
2. **`PHYTO_CRM_TOKEN`** (clave larga y solo tuya) para poder leerlos en
   `https://tu-dominio/panel?token=...`.

Y `PHYTO_CRM_ENDPOINT` debe apuntar a `/api/crm` (o no estar declarado: ese ya es
el valor por defecto). Si lo dejas declarado pero **vacío**, la web no enviará
nada al API.

La imagen funciona tal cual en **Easypanel, Dokploy o Coolify** (servicio *App* →
Git → Dockerfile; puerto del proxy 80, o el que indique `PORT`). Guía completa,
dominio y HTTPS: [`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md).

Para un servidor con nginx del sistema, el equivalente de la config del
contenedor está en `nginx/phytoemagry.conf`.

La cabecera CSP recomendada se genera en cada build en `dist/csp-header.txt` con
los hashes reales de los scripts inline (no hace falta `'unsafe-inline'`).

---

## Móvil (prioridad del proyecto)

El tráfico llega mayoritariamente desde móvil, así que la vista móvil manda:

- **Primera pantalla = producto + precio + los dos CTA.** La foto del hero se
  limita a `clamp(190px, 32vh, 320px)` con `object-fit: contain` (nunca se recorta
  el producto). Verificado: en 360×640 y en 320×568 los dos botones entran sin
  hacer scroll.
- **Barra fija inferior** con `Comprar` + `WhatsApp` (48 px de alto) y
  `env(safe-area-inset-bottom)` para el indicador de inicio del iPhone.
- **Modal de pedido**: cabecera fija arriba, cuerpo desplazable y **botón de
  continuar siempre visible**; el resumen del pedido y el aviso de validación
  aparecen junto a ese botón. Usa `92dvh` (la barra del navegador no tapa el CTA)
  e `interactive-widget=resizes-content` para que el teclado no lo cubra.
- **Campos a 16 px** → iOS no hace zoom al enfocar un campo.
- Objetivos táctiles de 24 px mínimo (checkbox) y 44-48 px en todo lo demás
  (botones, enlaces del menú y del footer) + `touch-action: manipulation` para
  eliminar el retardo del doble toque.
- Sin scroll horizontal en 320 / 360 / 390 / 414 / 430 / 768 / 1024 / 1440 px, ni
  en horizontal (844×390).
- Capturas de referencia en `docs/capturas/`.

## Rendimiento y accesibilidad
- Fuentes del sistema (0 peticiones, 0 CLS), un solo CSS y un solo JS.
- `prefers-reduced-motion`, `prefers-color-scheme` respetados donde aplica.
- Foco visible, navegación por teclado completa, `ESC` cierra el modal
  (`<dialog>` nativo con foco atrapado e inertización del fondo).
- Acordeón de FAQ con `<details>`/`<summary>`: funciona sin JavaScript.
- Contraste de todos los textos ≥ 4.5:1 (ver `src/styles/tokens.css`).
- Formulario con etiquetas reales, `aria-invalid`, `aria-describedby` y mensajes
  de error asociados.

---

## Estado de conversión (V1)

Recorrido de la página (una sola columna, mobile-first):

`hero` → `#producto` (información + confianza) → `#frascos` (selector) →
`#preguntas` (FAQ corta) → `#contacto` (formulario) → `#comprar` (CTA final)

### La web debe ser lo más ligera posible

La página presenta el producto y lleva a comprar sin bloques que repitan lo
mismo. Qué se publica se decide en `site.config.js` → `features.sections`
(`true`/`false`, sin tocar código):

| Bloque | Estado por defecto | Por qué |
| --- | --- | --- |
| `product` | ✅ | Qué es el producto, modo de uso y la afirmación de confianza |
| `frascos` | ✅ | Los 7 tamaños con precio y el paso a la compra |
| `faq` | ✅ | Objeciones reales con datos reales (5 preguntas) |
| `leadForm` | ✅ | Deja el contacto quien todavía no quiere pedir (captura el número) |
| `finalCta` | ✅ | Cierre con los dos CTA |
| `howToBuy` | ❌ | Los 4 pasos duplicaban lo que ya explica el selector y la FAQ |

Al apagar un bloque desaparece también su enlace del menú (los enlaces pueden
declarar `requires: 'steps'` o `requires: 'community'`) y hay tests que verifican
que no quedan anclas rota.

| Acción | Comportamiento |
| --- | --- |
| **Comprar / Consultar** (hero, header, selector, CTA final, barra móvil) | Abre el modal con el frasco y la cantidad elegidos. **Sin frasco elegido NO abre nada**: muestra el aviso "Elige primero tu frasco" y baja al carrusel |
| **Frasco al entrar** | **Ninguno**: el resumen arranca vacío ("Elige tu frasco") para que el visitante tenga que tocar una tarjeta y ver su precio. La elección se recuerda solo durante la sesión |
| **Escribir por WhatsApp** | Abre WhatsApp con `Ref:` de campaña |
| **Ver frascos y precios** (hero) | Baja al selector `#frascos` |
| **Selector de frascos** | **Carrusel horizontal**: se desliza de lado (swipe/arrastre) y cada tarjeta trae la foto real del frasco, "Frasco de · N cápsulas · precio" y su botón **Pedir por WhatsApp**. La de 60 lleva la etiqueta neutra "Frasco completo" |
| **Pedir por WhatsApp** (en cada tarjeta) | Manda a WhatsApp el pedido **completo de ese frasco**: producto, frasco, cantidad, precio por frasco, cápsulas en total, total y `Ref:` de campaña. Al pulsarlo, ese frasco pasa a ser el elegido y el resumen se sincroniza |
| **Flechas del carrusel** | Avanzan una tarjeta y se desactivan en los extremos; solo aparecen con JavaScript (sin JS el carrusel se desliza igual) |
| **Cantidad** | Botones + / − y campo numérico: son **frascos**, no cápsulas |
| **Cápsulas en total** | Se calculan aparte (10 cápsulas × 2 = 20 cápsulas · RD$5,000) |
| **Número de atención a la vista** | `+1 849-424-0621` en el footer y junto al formulario (`contact.whatsapp.displayNumber`). `npm run check` falla si sus dígitos no son los mismos que los del número que recibe los pedidos |
| **Déjanos tu contacto y te escribimos** | Enlace en el propio resumen del pedido que baja al formulario: el visitante que no compra hoy también puede dejar su número |
| **Modal de pedido** | Formulario **mínimo: solo el nombre**. El frasco, la cantidad, el precio y el total ya están elegidos arriba y viajan escritos en el mensaje de WhatsApp. El modal avisa en 3 sitios de que **el pedido se finaliza por WhatsApp** (frase de entrada, línea informativa junto al botón y nota al pie) |
| **Formulario de contacto** | Valida, se envía al CRM (cola local si no hay endpoint) **y abre WhatsApp con nombre, teléfono y ubicación ya escritos**: así el contacto llega al negocio y se puede responder |
| **Base de datos** | La imagen Docker trae su propio API (`server/crm-server.mjs`): cada pedido y cada contacto se guarda en PostgreSQL (o en SQLite si no se configura) y se lee en `/panel?token=...` o en CSV. Ver «Dónde quedan los pedidos y los contactos» |
| **Pago** | *No implementado a propósito.* La venta la confirma el CRM |

### Dónde quedan los pedidos y los contactos

Hay **dos canales** y funcionan a la vez:

1. **WhatsApp `+1 849-424-0621`** (el principal): cada pedido y cada contacto
   llegan al chat ya escritos, y el negocio responde desde el móvil.
2. **La base de datos de la propia web** (`server/crm-server.mjs`): la imagen
   Docker ya la trae y la web le envía los mismos datos a `/api/crm`. Con
   `PHYTO_CRM_DATABASE_URL`, los datos van a **PostgreSQL**; sin ella, a SQLite
   dentro del contenedor. Se leen en `https://tu-dominio/panel?token=TU_CLAVE`
   (tabla con fecha, tipo, nombre, teléfono, frasco, total y ciudad) y se
   descargan en CSV desde ahí mismo. El token se define con `PHYTO_CRM_TOKEN`; sin
   él, se sigue guardando pero no se puede leer.

Si usas SQLite (sin PostgreSQL), monta un volumen en `/data` para que los datos
sobrevivan a las actualizaciones. Contrato completo, endpoints, la tabla de
PostgreSQL y alternativas (Google Sheets, Make/Zapier/n8n) en
[`docs/CRM-CONTRACT.md`](docs/CRM-CONTRACT.md).

### Frasco ≠ cantidad (importante)

- `variant` = frasco (5…60 cápsulas) con su precio.
- `quantity` = cuántos **frascos** de ese tamaño.
- 2 frascos de 10 cápsulas son RD$5,000 y 20 cápsulas en total.

El selector acepta **una sola moneda** (RD$) y no incluye pasarela de pago: el
pedido se cierra por WhatsApp y el detalle completo se envía al CRM como
`order_intent`.

### Dos caminos para el visitante que llega desde un anuncio

1. **Comprar** (modal de pedido, siempre a un toque en la barra inferior en móvil).
   Sin frasco elegido primero le pide elegirlo; después solo deja el **nombre** → se
   guardan `lead` + `order_intent` y se abre WhatsApp con el pedido completo
   (producto, frasco, cantidad, precio por frasco, cápsulas en total, total y nombre).
2. **Hablar por WhatsApp** (1:1, sin grupos: la conversación deja el número).
3. **Dejar el contacto** en el formulario si todavía no quiere pedir.

### Comunidad de WhatsApp (desactivada a propósito)

`site.config.js` → `community.enabled: false`. Los 5 grupos siguen configurados,
pero **no se publican**: si el grupo está en la web, el visitante entra al grupo
en lugar de escribir, y se pierde su número de teléfono. Con el interruptor en
`false` desaparecen a la vez la sección, el enlace de la zona de compra, la
pregunta de la FAQ y el acceso del menú (los enlaces del menú pueden declarar
`requires: 'community'`). Poniendo `enabled: true` vuelve todo.

### Afirmación de confianza (`trust.claim`)

La prueba social actual es una sola línea aprobada por el negocio:

```js
// site.config.js
trust: { claim: 'Miles de personas ya cuentan con Phytoemagry.', claimVerified: true },
```

- Solo se publica si `claimVerified === true` (poner `false` la retira de la web).
- **Solo** puede vivir en ese campo: si la misma frase se escribe en cualquier otro
  texto de la configuración, el detector de afirmaciones (`npm run check` y los
  tests) bloquea la publicación.
- Nunca se admite aquí nada sobre resultados, salud o plazos: eso lo bloquea el
  detector siempre.

Detalles del contrato de datos: [`docs/CRM-CONTRACT.md`](docs/CRM-CONTRACT.md).

---

## Confianza, clientes potenciales y ventas

Todo lo que empuja a la compra está activo y verificado con tests:

| Palanca | Dónde está |
| --- | --- |
| Pedir en un toque, sin registro | Botón **Pedir por WhatsApp** en cada frasco, con el pedido ya escrito |
| Precio claro antes de pedir | Los 7 precios en RD$, sin "consultar precio" |
| Ver el producto real | Foto propia de cada frasco en el carrusel |
| Saber con quién se habla | Número **+1 849-424-0621** a la vista (footer y formulario) |
| Sin riesgo percibido | "No se realiza ningún cobro en esta página" en el resumen, el modal y el formulario |
| Nunca un callejón sin salida | Pedir (WhatsApp/modal) **y** dejar el contacto desde el resumen |
| Prueba social aprobada | `trust.claim` (verificada por el negocio; sin cifras sueltas) |

Lo que falta es **información del negocio**, no código: entrega y pago, dominio
real (el enlace de WhatsApp no muestra imagen sin él), datos fiscales y aviso al
consumidor, horario de atención, endpoint del CRM y testimonios reales. La lista
priorizada con el campo exacto de cada dato está en
[`docs/PENDIENTE.md`](docs/PENDIENTE.md) (§7).
