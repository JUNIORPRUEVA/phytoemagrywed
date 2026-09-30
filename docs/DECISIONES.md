# Decisiones técnicas

## 1. Sin framework (justificación exigida)

El encargo pedía explícitamente no añadir React/Vue/Angular/Flutter Web "salvo
razón técnica objetiva documentada". No se ha añadido ninguno porque no hay
razón para hacerlo:

| Requisito | Framework | Esta implementación |
| --- | --- | --- |
| Contenido visible sin JS / SEO | Requiere SSR/SSG adicional | HTML generado en build: contenido íntegro en el HTML |
| Interacciones necesarias | — | Un modal, un formulario, un banner y 6 eventos |
| Estado compartido | Store/reactividad | Objetos planos + delegación de eventos |
| JS enviado al navegador | 45–90 kB gzip (react+react-dom) | ~11 kB gzip, sin dependencias |
| Superficie de mantenimiento | Dependencias + toolchain | 3 devDependencies, 0 en producción |
| Riesgo de vulnerabilidades en deps | Alto (cadena npm) | Nulo en runtime |

Lo único que hacía falta de un "framework" era renderizar HTML desde datos, y eso
se resuelve con plantillas de string en `src/render/` ejecutadas en build.

## 2. HTML en build-time en vez de DOM generado en el cliente

- **SEO:** el contenido (título, precios, FAQ, textos) está en el HTML servido.
- **Rendimiento:** primer pintado sin esperar el JS; sin hidratación.
- **CLS:** nada se "aparece" después; las imágenes llevan `width`/`height`.
- **Robustez:** si el JS falla, la landing sigue siendo legible y los enlaces de
  WhatsApp (ya construidos) siguen funcionando.

Contrapartida asumida: cambiar textos exige `npm run build` (un solo comando) y
no hay "hot module replacement" de contenido (el dev server regenera el HTML en
~50 ms al guardar).

## 3. Una sola fuente de verdad para los datos derivados

`src/render/view.js` (`buildView()`) decide **una vez** si un dato existe y se
muestra. Lo usan el render (build) y el cliente (modal, precios, WhatsApp), de
modo que el HTML estático y el resumen del pedido nunca discrepan.

## 4. `null` = no se muestra

`isSet()` trata `null`, `''`, `[]` y marcadores tipo "PENDIENTE"/"TODO" como
ausentes. No existe ningún camino en el código que muestre un valor por defecto
inventado (ni precio, ni presentación, ni teléfono).

## 5. Cola local en lugar de backend

V1 no tiene API. En vez de dejar el formulario "enviando…" para siempre, los
payloads se validan, se registran y se guardan en `localStorage` con el contrato
final del CRM. Al configurar `PHYTO_CRM_ENDPOINT` empiezan a viajar por HTTP sin
cambios en la interfaz ni en el contrato.

## 6. `purchase` imposible de disparar por error

`trackPurchase()` exige `{ orderId, confirmedByBackend: true }`. Un clic en
*Comprar* o en WhatsApp nunca puede producir una compra registrada: hay tests
que fallarían si alguien añadiera esa llamada (`tests/tracking.test.js`).

## 7. `style-src 'self'` (sin CSS-in-JS)

Todo el CSS es estático y se minifica en un único archivo; no hay estilos en
línea, lo que permite una CSP estricta. Los hashes de los scripts inline
(JSON-LD) se calculan en cada build (`dist/csp-header.txt`), así que tampoco hace
falta `'unsafe-inline'` en `script-src`.

## 8. Accesibilidad como requisito, no como extra

- Modal con `<dialog>` nativo: foco atrapado, fondo inerte y `ESC` gratis.
- FAQ con `<details>`/`<summary>`: funciona sin JavaScript y es accesible.
- Los errores de formulario se anuncian asociando `aria-invalid` +
  `aria-describedby` al campo correspondiente.
- `:focus-visible` global, `skip link`, un solo `<h1>`, jerarquía de encabezados
  coherente y `prefers-reduced-motion` respetado.

## 9. Frasco ≠ cantidad (modelo de datos)

Se separan tres conceptos que suelen confundirse y que ya han provocado errores
en este tipo de landing:

| Concepto | Significado | Ejemplo |
| --- | --- | --- |
| `variant` | El frasco (nº de cápsulas) con su precio | `capsules_10` = 10 cápsulas · RD$2,500 |
| `quantity` | Frascos de **ese** tamaño | 2 |
| `totalCapsules` | Cápsulas totales del pedido | 20 |

Consecuencias de diseño:

- El texto nunca dice "cantidad de cápsulas" para pedir frascos: dice
  **"Cantidad de frascos"** y muestra **"Cápsulas en total"** por separado (en la
  sección y en el modal).
- El precio por frasco y el total se recalculan en un único sitio
  (`variantTotals()` en `src/lib/variants.js`) que usan el resumen, el modal, el
  mensaje de WhatsApp y el payload del CRM. Los tests comprueban que los cuatro
  coinciden (10×2=5,000 · 30×2=12,000 · 60×2=20,000 · 60×3=30,000).
- `validateVariants()` falla el build si hay frascos duplicados, precios
  no enteros, o más de uno marcado como frasco completo.

## 10. El frasco se define en configuración, no en el HTML

Añadir o cambiar un frasco (cápsulas + precio) es editar
`product.config.js` → `variants`. El render, el selector, la FAQ ("¿Qué
frascos están disponibles?" y "¿Cuál es el precio?" se generan con esa
lista), el JSON-LD (`AggregateOffer` con `lowPrice`/`highPrice`/`offerCount`) y
el contrato del CRM se derivan de ahí. No hay precios escritos a mano en las
plantillas.

## 11. Comunidad: un enlace, elegido automáticamente

> ⚠️ Hoy la comunidad está **desactivada** (`community.enabled: false`): ver
decisión 21. Lo de abajo aplica cuando se reactive.

WhatsApp limita los participantes por grupo, así que se configura una lista de
grupos con `priority` y `status` (`available` | `almost_full` | `full` |
`disabled`). La landing publica **un solo** enlace: el primer `active` +
`available`. Si no hay ninguno, la sección se oculta.

- `cleanGroupUrl()` acepta solo `chat.whatsapp.com` con un código válido y
  elimina los parámetros de sesión (`?s=...`) para no duplicar invitaciones.
- La sección no promete resultados: la comunidad es conversación entre clientes y
  lleva el aviso explícito de que no sustituye información médica. Los tests
  comprueban que ese aviso existe.

## 12. Las afirmaciones prohibidas se bloquean en tres capas

`src/lib/content-safety.js` define 15 patrones (pérdida de peso, plazos de
resultado, garantías, promesas de "resultados comprobados", autoridad médica,
enfermedades, detox, cifras de prueba social, escasez, testimonios inventados,
"antes y después", presión corporal…) y se aplica en:

1. **Tests** (`tests/content-safety.test.js`): 19 casos, incluyendo frases que
   *deben* detectarse y frases legítimas que *no*.
2. **`npm run check`**: recorre la configuración y **falla** si aparece algo.
3. **Build**: `scripts/build.mjs` avisa y marca error de salida.

El detector entiende negaciones y contexto de descargo ("no garantiza
resultados", "este producto no es un medicamento"), añadidas tras detectar un
falso positivo en el propio texto legal del sitio. Y no intenta ser un
"corrector de estilo": es un cortafuegos para las expresiones que pueden
comprometer el producto.

Frases que el negocio ha pedido bloquear expresamente y que están cubiertas por
tests: "Únete a miles de personas que ya tuvieron resultados", "Comprueba los
resultados", "Personas que ya rebajaron", "Resultados comprobados",
"Resultados reales garantizados", "más de 4,000 clientes", "miles de clientes",
"miles de personas obtuvieron resultados".

## 13. El resumen del pedido va ARRIBA del modal

Comprobado en un navegador real (390×844 px): con el resumen al final del cuerpo
desplazable, el modal se abría mostrando solo los campos y el CTA, de modo que se
podía confirmar un pedido **sin haber visto nunca** el frasco ni el total.
Ahora el primer bloque del modal es el resumen (frasco —con enlace *Cambiar
frasco*—, precio por frasco, cantidad, cápsulas en total y total) y hay un
test que verifica el orden en el DOM. Es la clase de error que un test de jsdom
no detecta por sí solo: hizo falta medir en el navegador.

## 14. "Frasco" es la palabra del cliente; `variant` sigue siendo el modelo

La interfaz dirigida al cliente usa **Frasco** ("Elige tu frasco", "Frasco de 10
cápsulas", "Cantidad de frascos", "Precio por frasco", "Cambiar frasco"). No se
usa "paquete", "plan" ni "tratamiento".

Internamente el modelo sigue llamándose `variant` (`variantId`, `select_variant`,
`product.config.js → variants`) y el payload del CRM conserva
`variantId`/`variantName`/`capsules`: cambiar el nombre visible no obliga a
tocar datos ya integrados.

El ancla de la sección es `#frascos` (antes `#presentaciones`): un enlace
`#presentaciones` en un menú con la palabra "Frascos" sería incoherente.

## 15. La selección se marca sin badges ni presión

Ninguna tarjeta lleva "Más vendido", "Mejor opción", "Recomendado", "Oferta" ni
"Ahorras": no hay datos que lo respalden. La única señal de que un frasco está
elegido es el borde de marca + un check discreto (y el radio real marcado, para
lectores de pantalla). El diseño convence con jerarquía, aire y contraste, no con
urgencia: hay un test que comprueba que esas palabras no aparecen en el hero.

## 16. La comunidad es un bloque de confianza, no un enlace perdido

> ⚠️ Hoy la comunidad está **desactivada**: ver decisión 21. Este diseño sigue en
> el código y en los tests de capacidad, listo para reactivarla.

- Va **justo antes** del contacto/CTA final, con fondo propio, título,
dos párrafos, **CTA grande** de WhatsApp y tres tarjetas de apoyo (icono +
título + texto) que hablan del espacio, no del producto ni de resultados.
- También hay un **enlace de texto discreto** bajo la zona de compra
(`#frascos` → `#comunidad`) para el visitante que todavía no está listo para
comprar: así el embudo no lo fuerza a decidir.
- Sin avatares ni fotos que aparenten clientes reales: la sección no contiene
ninguna `<img>` (hay test).
- El CTA se coloca **antes** de las tarjetas: en móvil la acción aparece a ~470 px
del inicio de la sección, sin obligar a recorrer las tres tarjetas.
- La cifra de miembros solo se publica con `memberClaimVerified === true`
(ver decisión 12 y `docs/PENDIENTE.md`).

## 17. `click_community_group` mide interés, no venta

Entrar a la comunidad **no** es un Lead ni una compra: se registra como
`click_community_group` con `groupId`, `groupName`, `sourceSection`,
`utm_campaign`, `utm_content` y `ref`. No se envía al pixel y hay tests que
verifican que el clic no dispara `click_whatsapp`, `lead` ni `purchase`.

## 18. La portada es la foto, no un bloque de texto

La imagen panorámica (línea completa de frascos, 1672×941) **ya contiene** el
nombre del producto, "Producto Fitoterápico" y los tamaños de cada frasco. Por
eso la portada no repite nada de eso:

- El `<h1>` con el nombre del producto existe pero es `pe-sr-only` (SEO y
  lectores de pantalla) en lugar de mostrarse otra vez sobre la foto.
- Debajo va **solo** el copy comercial mínimo: una frase, "Desde RD$1,250" y dos
  CTA (principal *Ver frascos y precios* → `#frascos`; secundario *Consultar por
  WhatsApp*).
- La lista de los 7 precios NO se repite aquí: vive en «Elige tu frasco».
- Sin tarjetas, badges, marcos ni sombras alrededor de la foto, y sin texto
  incrustado en la imagen (los botones son HTML real).

Hay tests que comprueban que el hero contiene la frase y el precio inicial, que
no incluye el resto de precios ni los nombres de los frascos, y que no aparece
ninguna etiqueta de presión comercial.

## 19. La foto nunca se recorta ni se deforma (ni en móvil ni en desktop)

Es una imagen horizontal y el encargo prohíbe `object-fit: cover` agresivo, así
que:

| Breakpoint | Estrategia |
| --- | --- |
| ≤ 767 px | Ancho completo (full-bleed, sin marcos) con la proporción natural |
| 768–1023 px | Centrada al 92vw, esquinas redondeadas y sombra suave |
| ≥ 1024 px | Centrada en el contenedor (1120 px) y limitada **por altura** (`min(58vh, 620px)`) para que el copy y los CTA queden cerca del pliegue |

En todos los casos el `object-fit` es `contain` y el `width`/`height` salen de
configuración: si el límite de altura aprieta, la imagen se centra y el hueco
queda del color de fondo (el `img` no pinta fondo propio), de modo que **nunca**
hay recorte, deformación ni scroll horizontal (verificado de 360 a 1440 px).

Dos reglas antiguas del CSS se eliminaron porque rompían esto: forzaban altura
fija en móvil (`--pe-hero-media-h`) y recorte cuadrado en escritorio
(`aspect-ratio: 1/1` + `object-fit: cover`).

## 20. Rendimiento de la portada

Al ser la imagen visible al cargar (candidata a LCP): 4 anchos en AVIF/WebP +
fallback JPG, `width`/`height` explícitos (CLS 0), `loading="eager"`,
`fetchpriority="high"` y `<link rel="preload" as="image" type="image/avif"
imagesrcset imagesizes>` en el `<head>` con el **mismo** `sizes` que el
`<picture>` (una sola descarga). El original PNG (2 MB) queda en `assets/` como
fuente y no se publica.

## 21. La comunidad de WhatsApp se retira de la web (decisión de negocio)

Los grupos **no se publican**. El motivo es comercial: cuando el enlace al grupo
está en la página, el visitante entra al grupo en vez de escribir directamente y
el negocio **pierde su número de teléfono**.

Implementación: `site.config.js` → `community.enabled: false` (un solo
interruptor). Con él en `false`, `view.js` no resuelve ningún grupo y desaparecen
a la vez: la sección, el enlace discreto de la zona de compra, la pregunta
generada de la FAQ, el aviso legal y **el acceso del menú** (los enlaces del menú
pueden declarar `requires: 'community'`). No queda ningún hueco ni enlace roto, y
hay tests que lo comprueban sobre el HTML renderizado.

Los 5 grupos siguen en configuración y el código (`lib/community.js`,
`renderCommunity`, evento `click_community_group`, estilos y tests de capacidad)
se conserva: poner `enabled: true` lo devuelve todo, incluido el acceso del menú.

En su lugar, la prueba social es una línea factual aprobada (decisión 22), y el
camino para quien no está listo para comprar pasa a ser el formulario, que **sí**
deja el número.

## 22. La cifra de clientes es una decisión consciente, no un texto suelto

El negocio pidió publicar que "miles de personas ya cuentan con Phytoemagry". Esa
cifra es hoy la única afirmación de prueba social de la web y está tratada como un
dato de negocio, no como copy de un párrafo:

```js
// site.config.js
trust: { claim: 'Miles de personas ya cuentan con Phytoemagry.', claimVerified: true },
```

| Regla | Por qué |
| --- | --- |
| Solo se publica si `claimVerified === true` | Retirarla es cambiar una línea, sin tocar diseño ni HTML |
| Solo puede vivir en `trust.claim` | `auditConfigs()` exceptúa **la ruta exacta** de ese campo verificado; la misma frase copiada a otro campo (p. ej. `content.hero.lead`) se bloquea |
| Nunca admite resultados, salud ni plazos | Esos patrones los bloquea el detector siempre, aquí y en cualquier otro campo |
| Hay que poder demostrarla | Una plataforma publicitaria o un consumidor pueden exigir la fuente (facturas, base de clientes, CRM) |

Se muestra como una línea discreta con icono en el bloque de información del
producto (sin cajas, badges ni contadores). Tests: se publica con la configuración
real, desaparece al retirar la verificación, y la misma frase fuera de su campo se
detecta y bloquea.

## 23. La página es lo más ligera posible (bloques activables)

El encargo: la web debe estar lo menos cargada posible y presentar la información
del producto justo antes de comprar. Aplicado:

1. **Bloques duplicados fuera por defecto**: "Cómo comprar" (los 4 pasos repetían
   lo que ya explican el selector, el modal y la FAQ) y 3 preguntas de la FAQ que
   repetían la nota de "no se realiza ningún cobro" y el proceso de pedido.
2. **Todo reversible desde configuración**: `site.config.js` → `features.sections`
   (`product`, `frascos`, `faq`, `leadForm`, `finalCta`, `howToBuy`). Apagar un
   bloque lo quita también del menú, sin anclas rota (hay test).
3. **Sin perder caminos de conversión**: se mantiene el formulario, que es el
   camino suave para quien todavía no quiere pedir y **deja el número**.

Resultado medido: 6 bloques (antes 7), FAQ de 5 preguntas (antes 8) y
`index.html` de 31,9 kB (antes 35,3 kB), con el mismo contenido esencial: qué es
el producto, su modo de uso, los 7 frascos con precio y cómo comprar.

## 24. Riesgos conocidos y mitigaciones
| Riesgo | Mitigación |
| --- | --- |
| El navegador bloquea la pestaña de WhatsApp | Se detecta (`window.open` devuelve `null`) y se muestra el enlace para pulsar; el evento se envía igual con `opened: false` |
| Bloqueadores de anuncios bloquean el pixel | Todo el tracking propio sigue funcionando; el pixel es opcional y aislado en un adaptador |
| `localStorage` deshabilitado (modo privado) | `createStorage` degrada a memoria y nunca lanza |
| Datos sin backend mientras el CRM no existe | Cola local limitada a 50 elementos, con reintento al cargar la página y visible con `Phytoemagry.pendingCrmItems()` (desde §28 el CRM y su base de datos viajan en la imagen) |
| La base de datos del contenedor se pierde al actualizar | `VOLUME /data` en el Dockerfile + volumen en Compose/Easypanel, con el aviso en tres sitios (Dockerfile, compose y guía de despliegue) |
| Cualquiera con la URL lee los teléfonos de los clientes | `PHYTO_CRM_TOKEN` obligatorio para `/panel`, `/api/crm/items` y el CSV (comparación en tiempo constante); sin la clave, el servidor responde 503 y los datos siguen guardándose |
| Atribución perdida entre navegaciones | First-touch en `localStorage` con TTL 90 días + last-touch en `sessionStorage` |
| Publicar una cifra de clientes | Solo desde `trust.claim` con `claimVerified: true`; en cualquier otro campo el detector la bloquea |
| Que no se pueda demostrar la cifra de clientes | Es responsabilidad del negocio: conviene guardar facturas/base de clientes por si una plataforma o un consumidor la cuestiona |
| Cambian precios de frascos | `validateVariants()` + tests con los importes exactos: el build falla si algo no cuadra |
| Un enlace roto en la navegación | Test que recorre todas las anclas `href="#..."` y comprueba que la sección existe; los enlaces condicionales (`requires`) desaparecen con su sección |
| Reactivar la comunidad por error en el futuro | Está tras un único interruptor y los tests de capacidad siguen verdes: activarla no rompe nada |

## 25. Carrusel horizontal de frascos, con pedido directo por WhatsApp

El encargo: ver los productos y los precios en una rejilla **horizontal** que se
pueda deslizar hacia los lados, con la foto de cada frasco, su precio y un botón
de pedir por WhatsApp que mande **el pedido completo** al chat.

Cómo está hecho:

1. **La tarjeta es la unidad comercial.** `.pe-variant` contiene la foto real
   (`variants[].image`), "Frasco de N cápsulas", el precio, la etiqueta neutra
   "Frasco completo" (solo el de 60) y su botón. La estructura separa dos
   interacciones que antes chocaban: el `<label>` (con el radio dentro) elige el
   frasco y el `<a>` de WhatsApp pide — el botón **no** está dentro del label,
   así que pulsar "pedir" no dispara la selección por accidente.
2. **Deslizamiento real**: `overflow-x: auto` + `scroll-snap-type: x mandatory`,
   a sangre en móvil (margen negativo del contenedor) y con la tarjeta siguiente
   asomando para que se entienda. Trampa resuelta: un `fieldset` **no** baja de su
   `min-content`, así que sin `min-inline-size: 0` el carrusel medía 1780 px y
   desbordaba la página en horizontal (se detectó midiendo `scrollWidth` en un
   navegador real, no leyendo el CSS).
3. **Un pedido completo por frasco**: `producto`, `frasco`, `cantidad`, `precio
   por frasco`, `cápsulas en total`, `total` y el `Ref:` de campaña. El mensaje se
   construye en build (funciona **sin JavaScript**) y el cliente lo recalcula con
   la cantidad elegida; el enlace estático y el dinámico salen del mismo
   `lib/whatsapp.js`, así que nunca dicen cosas distintas.
4. **Coherencia de estado**: al pedir un frasco, ese frasco pasa a ser el elegido
   (store `selection`) y el resumen de abajo se sincroniza; se registra
   `select_variant` (source `card`) y `click_whatsapp` (source `frascos`). Nunca
   se dispara `purchase`: la compra la confirma el CRM.
5. **Peso bajo control**: las fotos se generan a 320/480 px — el tamaño real de la
   tarjeta (`sizes: (min-width: 1024px) 232px, 240px`), recortadas al centro a un
   cuadrado uniforme — y van `loading="lazy"`. En móvil son ~18 kB por frasco
   (AVIF). `npm run check` falla si falta cualquier archivo declarado, para que
   ninguna tarjeta llegue rota a producción.
6. **Flechas como mejora progresiva**: el HTML las trae `hidden` y el JS las
   muestra y las desactiva en los extremos; sin JavaScript el carrusel se sigue
   deslizando con el dedo.

Medido en navegador real (390/430/768/1440): sin desbordamiento horizontal, el
carrusel desliza, tarjetas de 240 px (232 en escritorio) siempre iguales de alto,
botones de 44 px y la siguiente tarjeta asomando 92–162 px. Lighthouse móvil:
99/100/100/100 (LCP 1,8 s, CLS 0).

## 26. Un solo número de atención, a la vista, y dos caminos para no perder al visitante

El negocio dio el número (**829 785 3794**) para pedidos y consultas. Aplicado:

1. **Un único destino**: `.env` → `PHYTO_WHATSAPP_NUMBER=18297853794`. Todos los
   CTA (hero, cada frasco, resumen, modal, CTA final, barra móvil, footer y
   formulario) salen del mismo `lib/whatsapp.js`; hay un test que recorre TODOS
   los `a[href^="https://wa.me/"]` del HTML y exige que sean el mismo número.
2. **El número se ve**: `contact.whatsapp.displayNumber` lo muestra en el footer y
   junto al formulario. Un teléfono a la vista es la señal de confianza más
   barata: se ve que hay alguien detrás y se puede guardar para después.
   `npm run check` **falla** si sus dígitos no coinciden con los del número que
   recibe los pedidos: publicar un teléfono que no atiende es el error más caro
   posible aquí.
3. **Dos caminos desde el punto caliente**: al lado del resumen del pedido está
   "¿Todavía no estás seguro? Déjanos tu contacto y te escribimos" (baja al
   formulario). Quien no compra hoy deja igualmente su número: es la diferencia
   entre perder la visita y tener un cliente potencial al que dar seguimiento.
   El bloque es reversible desde `features.sections.leadForm`.
4. **Sin inventar nada**: la única prueba social publicada sigue siendo el claim
   aprobado. Lo que falta para vender más (entrega, pago, dominio, datos
   fiscales, aviso al consumidor, horario, CRM, testimonios reales) está listado
   en `docs/PENDIENTE.md` §7 con el campo exacto de cada dato.


## 27. Comprar cuesta un toque: sin frasco elegido de entrada, y el pedido se cierra en WhatsApp

Petición del negocio: "que el formulario de compra sea lo más simple posible,
solo el nombre; si le doy a comprar y no tengo nada elegido, que me pida elegir
primero el frasco; y que quede claro que el pedido se finaliza por WhatsApp".

1. **Al entrar no hay frasco elegido** (`product.config.js →
   defaultVariantId: null`). El resumen se dibuja vacío ("Elige tu frasco", "—")
   con un recordatorio ("Toca el frasco que quieras para ver su precio y el
   total"). Antes venía marcado el de 10 cápsulas y más de un visitante confirmó
   sin haber visto nunca los demás precios. Solo se recuerda dentro de la sesión.
2. **Comprar sin frasco no abre nada**: los dos CTA de la zona de compra (el
   botón del resumen y su enlace "Pedir por WhatsApp") muestran el aviso "Elige
   primero tu frasco: toca la foto del que quieras", bajan al carrusel y enfocan
   la primera tarjeta. Se registra `CLICK_BUY { blocked: 'no_variant' }` para saber
   cuánta gente pulsa comprar antes de elegir. El aviso se oculta solo a los 6 s.
3. **El modal pide SOLO el nombre**. Frasco, cantidad, precio por frasco, cápsulas
   en total y total ya están decididos arriba y viajan escritos en el mensaje de
   WhatsApp, así que pedir el teléfono y la ubicación era fricción pura: el número
   llega igual, en el propio chat (WhatsApp no permite escribir a un número que no
   ha escrito primero). Menos campos = menos abandono.
4. **"El pedido se finaliza por WhatsApp" está escrito tres veces** en el modal
   (frase de entrada, línea informativa junto al botón, nota al pie) y una cuarta
   bajo el resumen de la sección. El botón dice "Continuar el pedido en WhatsApp",
   no "Pagar".
5. **El panel de éxito lo confirma**: "Pedido preparado · Envíalo por WhatsApp:
   ahí confirmamos disponibilidad, pago y entrega" (y si el navegador bloquea la
   pestaña, el enlace manual queda a la vista).

Verificado en navegador real (390 y 1440): sin frasco el resumen arranca vacío y
Comprar muestra el aviso (el modal no se abre); al elegir un frasco el aviso
desaparece, el resumen se completa y el modal abre con **un solo campo**; al
enviar solo el nombre se abre `wa.me/18297853794` con frasco, cantidad, precio por
frasco, cápsulas, total y nombre; enviarlo vacío marca el campo y no abre nada.

## 28. La base de datos de los pedidos va DENTRO de la imagen (SQLite, sin dependencias)

Petición del negocio: "necesito que conecte la DB". Traducido a algo que él pueda
usar de verdad (no un concepto): los pedidos y los contactos tienen que quedar
guardados en algún sitio que pueda abrir desde el móvil, además de llegar por
WhatsApp.

1. **Se resuelve dentro de la imagen, no con un servicio externo.** `server/
   crm-server.mjs` es un servidor HTTP pequeño y **sin ninguna dependencia**: usa
   `node:sqlite` (viene dentro de Node) y `node:http`. Un servicio aparte (Postgres,
   un contenedor extra, una suscripción) añadía coste, otro despliegue y otro
   punto de fallo para un negocio que vende por WhatsApp; un `docker run` con un
   volumen hace lo mismo para este volumen de datos.
2. **El endpoint por defecto pasa a ser `/api/crm`** (mismo dominio). La web se
   construye apuntando a su propio API, así que "conectar la base de datos" no
   requiere configurar nada. `createCrmClient` acepta ahora una ruta relativa
   (`/api/...`) además de una URL absoluta; cualquier otro valor se sigue tratando
   como "sin endpoint" y usa la cola local.
3. **Idempotencia por `id`**: la cola local reintenta los envíos, así que el
   `INSERT OR IGNORE` (y la comprobación por id en el modo JSONL) evita duplicados.
   Es la clase de detalle que solo aparece cuando el transporte falla una vez.
4. **Leer los datos exige `PHYTO_CRM_TOKEN`.** Sin él, guardar funciona pero leer
   responde 503 con instrucciones: es preferible que el negocio vea "falta una
   clave" a que cualquiera con la URL descargue los teléfonos de sus clientes. La
   comparación es en tiempo constante, `/panel` va `noindex, nofollow` y
   `/api/health` (lo único público) no expone datos personales.
5. **El panel y el CSV son la respuesta a "¿dónde veo yo esto?"**: `/panel?token=`
   lista fecha, tipo, nombre, teléfono, frasco, total y ciudad, con descarga en
   CSV para Excel/Sheets. Sin panel, una base de datos es un cajón cerrado.
6. **Sin volumen no hay memoria**: el `Dockerfile` declara `VOLUME /data` y tanto
   Compose como la guía de Easypanel lo montan. Si se pierde, es culpa de un
   despliegue mal hecho, no de un error silencioso: está escrito en tres sitios
   (Dockerfile, compose y `docs/DESPLIEGUE.md`).
7. **Si SQLite no está** (una versión de Node antigua, o el flag experimental
   ausente), cae automáticamente a un archivo JSONL en el mismo directorio y lo
   dice en los logs. Degradar es mejor que no arrancar.
8. **Y la cola local ahora SÍ se reintenta.** Al construir la base de datos
   apareció el agujero: `api.js` guardaba los envíos fallidos en `localStorage`
   pero nada los reenviaba nunca (la documentación decía "se reintenta" y era
   falso). Ahora `createCrmClient().flushQueue()` reenvía hasta 10 pendientes al
   cargar la página, quitando de la cola los que el servidor acepta y parando en
   el primer fallo de red. Se puede forzar con
   `Phytoemagry.retryPendingCrmItems()`.

Verificado con peticiones HTTP reales (12 tests con el servidor arrancado de
verdad en un puerto libre): guarda un `lead` y un `order_intent`, no duplica el
mismo `id`, sobrevive al reinicio (los datos están en el archivo), rechaza
cuerpos inválidos sin guardar nada, exige la clave para leer, exporta CSV, filtra
por tipo y el modo JSONL funciona igual. Y verificado en el navegador con la
landing real (dev server + API con CORS): el lead del formulario y los dos envíos
pendientes de la cola llegaron a la base de datos, y `/panel` los lista.
## 29. Los datos van a PostgreSQL, en su propia base de datos y con su propio usuario

Cuando el negocio pidió "crear una base de datos y conectarla", el servidor ya
tenia un PostgreSQL 17 en marcha (el servicio `studio-db` de su otro proyecto).
Aplicado:

1. **Base de datos nueva y aislada**: `phytoemagry`, con su propio rol
   `phytoemagry_user` (sin superusuario, sin crear bases ni roles). No se reutiliza
   el usuario del otro proyecto: si algún día la web se viera comprometida, lo que
   hay detrás es una base con pedidos, no acceso al servidor entero.
2. **`REVOKE CONNECT ... FROM PUBLIC`** en `phytoemagry` **y en `video_studio`**:
   el usuario nuevo no puede leer el proyecto vecino, y el vecino sigue igual
   (es el propietario de su base). Un `docker exec` a `pg_hba` en la mano
   demuestra lo que pasa: reconectar como el rol nuevo pasa, lo que no pasa es
   ver datos ajenos.
3. **Almacén `pg` en el API** (`server/crm-server.mjs`), con pool (se reconecta
   solo tras una caída) y la tabla `phytoemagry_items` creada al arrancar.
   `payload jsonb` para poder consultar dentro del propio pgweb/dbgate del
   servidor, y `ON CONFLICT (id) DO NOTHING` para que los reintentos de la cola
   local no dupliquen nada. La fila se devuelve **con la misma forma que en
   SQLite**, así el panel, el CSV y los tests valen para los dos almacenes.
4. **SQLite no se borra: pasa a ser el respaldo.** Sin `PHYTO_CRM_DATABASE_URL`
   sigue siendo el almacén por defecto (cero configuración, cero dependencias), y
   si Postgres está configurado pero no responde, el API lo dice en los logs y
   sigue guardando ahí. Un pedido perdido por un problema de base de datos es el
   peor fallo posible en esta web.
5. **La imagen lleva solo `pg`** (etapa `runtime-deps` con `npm ci --omit=dev`):
   las dependencias de desarrollo se quedan en la etapa de build.

## 30. En móvil, menos aire y un escalón menos de tamaño (la página se veía "demasiado cerca")

El negocio lo describió así: "siento como si estuviera demasiado zoom, que en
móvil se vea más lejos, las letras más pequeñas y los botones más pequeños".
Antes de tocar nada se MIDIÓ en un móvil real (390×844, navegador de verdad):

| Medida | Antes | Después |
| --- | --- | --- |
| Portada | 524 px (**62%** de la pantalla) | 460 px (**54%**) |
| Párrafos | **18 px** | 16 px |
| Títulos de sección | 26 px | 22 px |
| Aire por sección (arriba + abajo) | 48 + 48 px | 32 + 32 px |
| Botón principal | 56 px de alto | 50 px |
| Tarjeta de frasco | 240 × 410 px | 216 × 378 px |
| Página completa | 5,8 pantallas | 5,2 pantallas |
| Cabecera | 64 px | 56 px |

Todo con un `@media (max-width: 767px)`: **el escritorio no cambia ni un píxel**
(verificado a 1440: párrafos 18, títulos 32, botones 56, tarjetas 232).

1. **Dos palancas, no veinte retoques.** Primero los tokens (`tokens.css`): los
   tamaños grandes bajan un escalón y se aprieta el interlineado. Después el aire
   (`layout.css` + `components.css`): secciones, portada, CTA final y footer.
   Veinte ajustes sueltos por toda la hoja habrían sido imposibles de mantener.
2. **Lo que NO se tocó, a propósito:**
   - **mínimos táctiles** (`--pe-tap: 48 px`): el botón baja a 50 px, nunca a 44
     ni menos. Un botón que se falla con el dedo cuesta más ventas que el aire
     que se gana; es la línea que no se cruza por "que se vea más fino";
   - **texto pequeño** (`--pe-fs-xs/sm`): es el que ya estaba en el límite de lo
     legible (avisos, notas, etiquetas); bajarlo habría empeorado la lectura sin
     ganar sensación de amplitud.
3. **La sensación de "zoom" casi nunca es la tipografía, es el aire.** Cuatro
   secciones con 96 px de aire cada una eran más de media pantalla de nada. Bajar
   el aire de 48 a 32 px se nota mucho más que bajar la letra de 16 a 15 px, y no
   cuesta legibilidad.
4. **La tarjeta del carrusel baja a 216 px**: la siguiente asoma 162 px (antes
   92–162), que es lo que invita a deslizar. Los `sizes` de la foto no cambian
   (216 px sigue entrando en el archivo de 320), así que el peso de la imagen es
   exactamente el mismo.

Verificado en navegador real a 360, 390 y 1440 px: sin desbordamiento horizontal
en ningún ancho, la primera pantalla ahora incluye la portada **y** el arranque de
la siguiente sección, y el modal de pedido sigue cabiendo sin scroll (724 px de
844).

## 31. El mini-CRM es una app instalable (PWA), no una pantalla más de la web

Petición del negocio: "necesito la parte administrativa, el panel donde llevar
todo: recordatorios, mensajes personalizados a los clientes… y que sea PWA para
administrarla desde el móvil".

1. **El panel es una app aparte, no una sección de la landing.** Una sola página
   en `public/admin/` (sin frameworks, sin build), servida en `/admin/`, con su
   `manifest.json`, su service worker y su icono: se instala en el teléfono con
   nombre propio ("CRM Phyto") y abre a pantalla completa. La landing no carga
   nada de esto y el panel no carga nada de la landing.
2. **La clave deja de viajar en la URL.** El panel viejo vivía en
   `/panel?token=…`: la clave quedaba en el historial, en los enlaces que se
   comparten y en cualquier captura. Ahora se escribe **una vez** y el servidor
   responde con una cookie `HttpOnly` + `SameSite=Strict` firmada con HMAC (sin
   tabla de sesiones: si cambias `PHYTO_CRM_TOKEN`, todas las sesiones mueren).
   `/panel?token=…` sigue funcionando: entra y redirige, para no romper la
   costumbre ni los enlaces guardados. Además hay límite de 10 intentos por IP
   cada 15 minutos.
3. **Sin conexión se puede trabajar.** El service worker guarda el armazón y el
   panel guarda la última copia de los datos y los cambios pendientes. En la
   calle, sin datos: se abre con lo último, se cambian estados, se apuntan notas y
   se programan recordatorios; al volver la red, los cambios se envían solos. Los
   endpoints `/api/…` **nunca** se cachean: un pedido de hace tres días no puede
   parecer el de hoy.
4. **Los recordatorios son una fecha, no una alarma.** Se guardan como
   `YYYY-MM-DD` (día, no hora) en la zona del negocio (America/Santo_Domingo), y
   la pestaña "Hoy" muestra lo de hoy y lo atrasado. Eso es lo que evita que un
   cliente se enfríe; una notificación push necesitaría claves VAPID y un
   servidor de notificaciones, y queda como siguiente paso (el panel ya lleva la
   insignia con el número de pendientes).
5. **Escribir es contactar.** Al abrir WhatsApp desde el panel, el cliente pasa a
   *contactado* y se guarda `last_contact_at`. El mensaje se puede ver antes de
   enviarlo, con las variables (`{nombre}`, `{frasco}`, `{cantidad}`, `{total}`)
   ya rellenas, y las plantillas se editan desde el propio móvil.
6. **El estado del cliente vive en la misma fila que el dato.** Añadir
   `status`, `notes`, `next_action_at`, `last_contact_at` y `updated_at` a
   `phytoemagry_items` (con `ALTER TABLE … ADD COLUMN IF NOT EXISTS`) evita una
   segunda tabla con la que habría que hacer *joins* y sincronizaciones; y como
   los tres almacenes devuelven la misma forma, el panel, el CSV y los tests
   valen igual con Postgres, SQLite o JSONL.

Tres fallos reales que aparecieron AL PROBARLO en el navegador, no leyendo el
código: (a) pulsar "Escribir por WhatsApp" dentro de una tarjeta abría la ficha
porque el botón vive dentro del elemento táctil — el orden de comprobación en el
manejador de clics es la diferencia; (b) los cambios optimistas usaban los nombres
del API (`nextActionAt`) y la pantalla pinta `next_action_at`, así que el
servidor guardaba bien y **el negocio no lo veía**; (c) sin conexión se abría la
pantalla de la clave aunque hubiera sesión y datos guardados: no se puede
preguntar al servidor si hay sesión cuando no hay servidor.

## 32. El panel tiene que estar conectado al API, también en local (y decirlo claro)

Queja del negocio, con estas palabras: "dice que no se puede entrar, no sé por
qué". No era la clave: era que **no había nada al otro lado**.

1. **El fallo real:** al abrir el panel en `http://localhost:5173/admin/` (la URL
   de `npm run dev`), el panel cargaba pero su `POST /api/admin/login` acababa en
   el servidor de ficheros del dev server, que devolvía un 404 en **HTML**. El
   panel intentaba leerlo como JSON, no lo conseguía y mostraba "No se pudo
   entrar." **sin ninguna pista** de si la clave estaba mal, si faltaba la sesión
   o si el CRM estaba apagado. Un mensaje que no distingue tres causas distintas
   no es un mensaje de error: es un callejón sin salida.
2. **El dev server ahora reenvía `/api/…` al CRM** (`scripts/crm-proxy.mjs`,
   probado en `tests/crm-proxy.test.js`: cuerpo, cabeceras, estado y `set-cookie`
   de ida y vuelta) **y lo arranca él solo** si no está encendido, con la clave
   local `phyto-local` a la vista. Un comando (`npm run dev`) y el panel funciona
   en `localhost:5173/admin/`: lo mismo que hace nginx en producción, sin tener
   que abrir dos terminales ni adivinar puertos.
3. **Si el CRM no responde, el proxy contesta 502 con un JSON legible**
   ("El CRM no está respondiendo en el puerto 8787 (no está encendido)…") y el
   panel lo pinta en la pantalla de entrada, en vez de inventarse un
   "No se pudo entrar". En local, además, `npm run dev` avisa por consola de la
   clave y de la URL del panel.
4. **Un pedido hecho en local también se guarda:** con `PHYTO_CRM_ENDPOINT` vacío
   la landing no envía los pedidos a ninguna parte (quedan en la cola del
   navegador), así que el panel salía siempre vacío y parecía roto. El dev server
   usa `/api/crm` por defecto (el mismo valor que trae la imagen Docker) y la
   revisión previa a publicar ya avisa con su efecto real: "Los pedidos NO llegan
   a la base de datos: el panel sale vacío".

## 33. El despliegue fallaba sin decirlo: `duplicate location` (y los guardas que faltaban)

Al añadir el panel PWA quedaron **dos `location = /panel`** en la config de
nginx: el nuevo (redirige a `/admin/`) y el viejo (hacía proxy al API). nginx
aborta con `[emerg] duplicate location "/panel"`, el contenedor sale con código
1 y Swarm **deja la versión anterior sirviendo**: la web seguía respondiendo, así
que desde fuera parecía que "el panel no se puede abrir", cuando en realidad el
despliegue nunca llegó a arrancar.

Lo que faltaba no era la corrección, eran las **redes de seguridad**:

1. **Un test que lee la config de nginx como la lee nginx** (`tests/render.test.js`):
   saca las claves de todos los `location` del bloque `server` y falla si alguna
   se repite, además de comprobar que las llaves están equilibradas. El test de
   paridad que ya existía (Dockerfile ↔ `nginx/phytoemagry.conf`) **no lo
   detectaba**, porque la duplicidad viajaba igual en las dos copias: comparar
   listas de directivas no es validar una config. El guarda se probó contra el
   `Dockerfile` de HEAD (el roto) y contra el arreglado: detecta `= /panel` en el
   primero y no dice nada en el segundo.
2. **Un despliegue que falla tiene que verse.** El aviso estaba en los logs de la
tarea que murió (`docker service ps` lo marca como `Failed: task: non-zero exit
   (1)`), no en la web: por eso ahora está en la tabla de problemas típicos de
   `docs/DESPLIEGUE.md` con el diagnóstico exacto.
3. **El enlace viejo entra de verdad.** `/panel?token=…` redirige a
   `/admin/?token=…` y el panel inicia sesión solo con esa clave y limpia la URL
   (`history.replaceState`): antes la promesa era solo "redirige", y quien tenía
   el enlace guardado acababa en la pantalla de la clave.
4. **PostgreSQL de verdad, no en silencio a SQLite.** El CRM arranca con
   `storage: sqlite` si Postgres rechaza al usuario (defensa buena: no se pierde
   ningún pedido), pero con la clave del rol desalineada se queda ahí para
   siempre, y sin volumen montado ese SQLite desaparece en el siguiente
   despliegue. Se alineó la clave del rol con la del servicio y ahora
   `/api/health` responde `storage: postgres`.

## 34. Meta: el píxel no estaba midiendo (y la venta solo cuenta si es una venta)

Petición del negocio: "hacer la parte de los eventos de Facebook". La auditoría
previa (exigida por el propio encargo) encontró **un fallo que invalidaba casi
toda la integración**, además de lo que faltaba por construir.

1. **El píxel recibía 2 eventos de 8.** Los adaptadores de medición (Meta Pixel y
   dataLayer) se creaban, se guardaban en un array… y **nunca se registraban en el
   tracker** (`tracker.addAdapter` no se llamaba en ningún sitio del proyecto). Lo
   único que llegaba a Meta era el `PageView`/`ViewContent` que `enableAds`
   reenvía al aceptar el consentimiento. Ni `InitiateCheckout`, ni `Lead`, ni
   `Contact`, ni un solo evento propio. La web *parecía* medida —el script se
   cargaba, la consola estaba limpia, había hits a `facebook.com/tr`— y las
   campañas se habrían optimizado con datos que no existían. Ahora los adaptadores
   se registran y un test (`tests/meta-pixel-wiring.test.js`) comprueba que el
   píxel recibe **todos** los eventos del flujo, no solo los del arranque.
2. **`Purchase` es una venta, no un clic.** Se envía **solo** cuando el negocio
   marca el pedido como `entregado` (dinero cobrado), que es el mismo criterio
   que usa el panel para su "valor entregado": la web y Meta dicen lo mismo. Ni
   al cargar, ni al elegir frasco, ni al pulsar Comprar, ni al abrir WhatsApp, ni
   al crear el lead, ni al marcar `confirmado` (un pedido confirmado todavía puede
   caerse). El estado es configurable (`PHYTO_META_PURCHASE_STATUS`) para no
   tener que tocar código si el negocio cambia de criterio.
3. **Un `event_id` por acción, compartido entre navegador y servidor.** Meta
   deduplica por `event_id`: si el píxel manda el `Lead` y el CRM lo reenvía por
   la API de conversiones con el **mismo** identificador, cuenta uno. Generar dos
   UUID distintos para la misma acción es la forma más fácil de duplicar
   conversiones sin darse cuenta. La venta usa `purchase_<id del pedido>`, que es
   estable para siempre.
4. **Idempotencia en la fila del pedido, no en memoria.** `meta_purchase_event_id`,
   `meta_purchase_sent_at`, `meta_purchase_status`, `meta_purchase_attempts` y
   `meta_purchase_error` viven en `phytoemagry_items` (migración automática en los
   tres almacenes). Si el proceso se reinicia, una venta ya enviada **no** se
   reenvía; si falló, se reintenta con tope de intentos y el panel deja
   reenviarla a mano. Una variable en memoria no habría sobrevivido al reinicio.
5. **El token de Meta es de servidor.** Vive en `server/meta-capi.mjs` y en
   ninguna otra parte: viaja en el **cuerpo** de la petición (no en la URL, para
   no acabar en logs de proxy), nunca se registra y los errores se sanean
   (`[oculto]`). Un test comprueba que el token no aparece en ninguna respuesta
   HTTP que reciba el navegador.
6. **El código de eventos de prueba no puede envenenar producción.** Con
   `APP_ENV=production` se ignora aunque esté puesto, y solo se acepta con el
   formato real (`TEST12345`). Está pensado para que un olvido no convierta el
   tráfico real en tráfico de prueba.
7. **`Contact` una vez por sesión, clics siempre.** El clic en WhatsApp es una
   interacción: el primero de la sesión cuenta como `Contact` y el resto quedan
   como evento propio (`click_whatsapp`), para no inflar conversiones repitiendo
   el mismo gesto.
8. **Si Meta se cae, el CRM sigue.** El envío a Meta es un efecto secundario: el
   lead se guarda, el pedido se crea y el estado se marca igual. El resultado
   (`sent`/`failed`) se escribe en la fila y el panel lo enseña.

Un fallo real más, encontrado al arrancar en local: la variable
`PHYTO_META_GRAPH_VERSION` vacía llegaba como `''` (no como `undefined`), así que
`??` no aplicaba el valor por defecto y la URL salía
`graph.facebook.com//<pixel>/events`. Se vio en el banner del servidor y ahora una
variable vacía usa la versión por defecto.

## 35. El número de atención es el del WhatsApp Cloud API: `+1 849-424-0621`

La decisión 26 publicó el número **`829 785 3794`**. Al pasar a WhatsApp Cloud API
se comprobó que **ese no es el número que atiende**: el negocio opera con el
número verificado **`+1 849-424-0621`** (Display Name "Phytoemagry", Phone Number
ID `1410599278794907`, WABA `2559517617897858`). Publicar un teléfono que no
atiende es exactamente el error caro que este proyecto se propuso evitar, así que
todo se unifica en el oficial:

1. **Un único sitio para el número** (no se duplica en componentes):
   `.env` → `PHYTO_WHATSAPP_NUMBER=18494240621` (el que recibe pedidos y
   consultas) y `site.config.js` → `contact.whatsapp.displayNumber =
   '+1 849-424-0621'` (lo que se enseña en el footer y junto al formulario).
   `npm run check` **sigue fallando** si los dígitos del visible y del receptor no
   coinciden.
2. **Los valores por defecto de la imagen** (`Dockerfile` y `docker-compose.yml`)
   pasan al número oficial: una imagen no puede salir apuntando al número viejo.
3. **Prueba de regresión nueva** (`tests/contact-number.test.js`): falla si el
   número viejo reaparece en cualquier superficie de ejecución (`src/`, `public/`,
   `server/`, `scripts/`, `nginx/`, `Dockerfile`, `docker-compose.yml`) o en el
   HTML renderizado, y exige que los enlaces comerciales sean
   `https://wa.me/18494240621` generados desde la configuración.
4. **Qué no se toca**: los grupos de la comunidad (`chat.whatsapp.com/…`, que no
   tienen nada que ver con el número comercial), los teléfonos de los clientes
   (ni en conversaciones ni en la base de datos) y los identificadores de Meta
   (Phone Number ID / WABA / token), que no son el número público y nunca deben
   llegar al frontend.

El número anterior queda en este registro como lo que fue: el que el negocio dio
en su momento, hoy **superado** por el verificado de Cloud API.


