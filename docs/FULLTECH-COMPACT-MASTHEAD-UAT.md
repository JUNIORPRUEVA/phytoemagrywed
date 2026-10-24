# FULLTECH — cabecera sin appbar y navegación compacta

Fecha: 24/10/2026. Cambios locales, sin commit, push ni deploy en esta tarea.

- Se elimina el appbar del HTML, no solo se oculta. El drawer se abre desde **Menú**, antes de Carrito en el navbar de cinco opciones.
- Cuenta y perfil siguen en el drawer. Instalar y ubicación voluntaria también quedan allí; no se elimina el flujo de checkout ni se pide GPS automáticamente.
- Logo transparente pequeño dentro del héroe, arriba a la derecha. Se retira «Encuentra tu próximo favorito».
- Buscador, lista fina de categorías sin tarjetas y héroe comparten degradado. El buscador solo se fija al salir del inicio, evitando el corte blanco que aparecía al eliminar el appbar.
- Scroll vertical invertido en fase de captura: dedo hacia abajo avanza; hacia arriba regresa. Se evita mover la página detrás del drawer y se desactiva el rebote/recarga por sobrepasar los extremos donde el navegador lo permite. Carruseles horizontales, zoom, campos editables y desplazamiento propio del drawer no se invierten.
- Versiones de assets actualizadas y caché PWA `fulltech-store-v78`. No se borran carrito, cuentas ni datos locales.

## Evidencia automatizada

`scripts/check-store-compact-masthead.mjs`: SQLite temporal propia, proveedores y scheduler desactivados, solicitudes externas bloqueadas. Chromium con eventos táctiles CDP (no eventos DOM simulados), ratón y navegación entre inicio/catálogo/producto. Tamaños **320, 390, 768 y 1440 px**: sin appbar, cinco tabs, drawer funcional, logo en tarjeta, categorías de texto y sin desbordamiento horizontal ni errores JS.

En los cuatro tamaños: gesto descendente desde scrollY=0 termina en 160 sin recargar; desde 400 termina en 560; gesto ascendente regresa a 400. El wheel negativo avanza hacia productos. Esto no certifica Safari/iOS ni un teléfono físico; queda UAT manual del gesto y de la actualización de PWA instalada. Se inspeccionaron capturas de 390 y 1440 px.

Resultados: `docs/capturas/compact-masthead/results.json`; capturas `home-320.png`, `home-390.png`, `home-768.png`, `home-1440.png` en esa carpeta. La skill Sites orientó la comprobación local sin publicar ni registrar otro sitio.

Pruebas dirigidas: **26/26 aprobadas**, cinco archivos (scroll, iconos navbar, carrusel, feed y paginación). Build: **328 archivos**, aprobado con las siete advertencias anteriores de contenido/configuración. No se repitió la suite general en esta modificación visual; sus fallos documentados siguen pendientes.

```powershell
$env:PLAYWRIGHT_MODULE='file:///C:/Users/pc/DEV/PROYECTOS/PRODUCTOS/DaleVentas%20POS/.tmp-playwright/node_modules/playwright-core/index.mjs'
node --experimental-sqlite scripts/check-store-compact-masthead.mjs
npx vitest run tests/store-reverse-scroll.test.js tests/store-navigation-icons.test.js tests/store-offer-carousel.test.js tests/store-product-feed.test.js tests/store-shopping-pagination.test.js --reporter=dot
npm run build
git diff --check
```

Los servidores del arnés y Chromium se cierran al finalizar. La prueba no toca bases productivas ni cambia flags de producción. El NO-GO de Smart Commerce no se revoca por esta comprobación de interfaz.

## Ajuste de densidad solicitado

Logo ampliado de 78 a 96 px en móvil y de 90 a 108 px en escritorio. Héroe sin altura mínima artificial: padding 34/10/12 px en móvil y separación de 6 px entre ofertas; dos imágenes completas bajo el logo, sin solaparse ni salir del contenedor. Beneficios reducidos a una franja de 24 px, sin tarjetas independientes; etiquetas de 8.5 px e iconos de 12 px. Encabezados de secciones de 12 px y peso 600; enlaces de 10 px. No se modifican precios, catálogo ni reglas de selección de ofertas.

El arnés ahora publica dos ofertas ficticias en su SQLite temporal y comprueba sus límites geométricos respecto al héroe y al logo en los cuatro tamaños. Pasa nuevamente sin errores ni overflow; capturas de 320 y 390 px inspeccionadas. **16/16 pruebas** adicionales de ofertas diarias, scroll e iconos aprobadas; build de 328 archivos aprobado con las mismas siete advertencias previas. Caché PWA actualizada a `fulltech-store-v79` y CSS compacta a `v=2`. Vista existente en `http://127.0.0.1:8898/store/`; no se reinicia el backend ni se escribe en esa base para ejecutar el QA.

## Portada con un solo feed

Se retiran del render de inicio los bloques separados Destacados, Ofertas, Novedades y Descubrir más, y sus preparaciones de datos sin uso. Se conserva la lista visual de categorías, el filtro fino bajo el buscador, el héroe con sus ofertas, los beneficios y un único feed paginado con título «Productos». La pestaña Ofertas y los filtros de catálogo siguen disponibles; no se retiran productos ni datos del servidor. El feed conserva estados vacíos/error y paginación existentes.

QA Chromium aprobado en 320/390/768/1440 px: ocho productos ficticios aparecen exactamente una vez, cero bloques repetidos; filtrar POS muestra sus tres productos y volver a Todos recupera los ocho. También pasan las comprobaciones anteriores de imágenes, menú, scroll y ausencia de errores/overflow. Captura de 390 px inspeccionada. **32/32 pruebas dirigidas** aprobadas (seis archivos), build 328 archivos aprobado. Assets: `store.js?v=60`, caché PWA `fulltech-store-v80`. Sin commit/push/deploy de esta modificación.

## Versión vigente: portada promocional azul oscuro

Esta iteración reemplaza la distribución anterior según la nueva referencia del usuario. Se quitan tanto las categorías de texto bajo el buscador como las tarjetas de categorías del inicio; el acceso y los filtros se conservan en la pestaña Categorías. El buscador queda dentro del mismo fondo azul marino con degradado, sin appbar. Logo transparente en blanco para contraste, título promocional de una línea, subtítulo corto y CTA a la izquierda; dos imágenes en paralelo a la derecha. Fila independiente de al menos 60 px reservada para los anuncios rotativos existentes.

La promoción refleja ofertas activas del servidor y el mayor porcentaje real de las seleccionadas. Si faltan ofertas, se completa el par de imágenes con novedades, sin productos repetidos ni descuento inventado. Bajo el banner hay una franja verde grisácea con «Entrega rápida» (coordinada según destino) y «Productos con garantía» (condiciones de la ficha). No se añade promesa de plazo fijo, envío gratis ni garantía uniforme.

Se incorpora, por solicitud expresa, un bloque de **hasta dos ofertas activas** con imagen, precio, precio anterior y porcentaje reales; no se restauran los antiguos bloques Destacados/Novedades/Descubrir más. Si no hay ofertas ese bloque no se renderiza; el feed general sigue paginado y el catálogo no cambia.

QA actualizado: cuatro tamaños, imágenes en la misma fila sin solaparse ni salir del héroe, CTA abre Ofertas, filtro POS funciona en Categorías, ocho productos únicos en el feed, menú y scroll conservados, sin errores JS ni overflow. Casos adicionales con payload UAT de una y cero ofertas: muestran respectivamente una y cero tarjetas promocionales, manteniendo dos imágenes del catálogo y sin badges ficticios. Capturas de 320 y 390 px inspeccionadas con la skill Sites; pruebas locales únicamente. **32/32 tests dirigidos**, build 328 archivos y `git diff --check` aprobados; mismas siete advertencias históricas de contenido. Assets vigentes `store.js?v=61`, `compact-masthead.css?v=3`, caché `fulltech-store-v81`. Sin commit/push/deploy.

## Último ajuste: navegación reforzada, información y tarjetas editoriales

Por nueva indicación se recupera únicamente la lista horizontal de texto bajo el buscador (Todos, categorías y Ofertas), ahora con peso 750 y 12 px; no vuelve la lista de tarjetas de categorías del inicio. El logo usa sus colores originales, sin filtro blanco, sobre un fondo blanco degradado con halo suave. Se oculta el contador del feed de inicio; la paginación continúa usando los totales internos sin mostrarlos.

La fila informativa debajo de entrega/garantía tiene tres mensajes enlazados, desplazamiento horizontal nativo, anterior/siguiente, posición y pausa/reanudación. `info-slider.js` avanza cada seis segundos, pausa con hover, foco o pestaña oculta y arranca pausado con movimiento reducido. Se dispone su timer y listeners al cambiar de ruta. Los textos no prometen envío gratuito, plazos garantizados ni condiciones comerciales inexistentes.

Las dos tarjetas de ofertas pasan a una composición editorial: fondos azul marino y verde petróleo, iluminación radial, imagen en primer plano con sombra/inclinación, nombre/precio/porcentaje reales y CTA. **Ambas enlazan a la pantalla Ofertas**, también accesible desde el texto bajo el buscador y el drawer. Se retira exclusivamente su tab del navbar, que ahora tiene Inicio, Categorías, Menú y Carrito. Si hay una o ninguna oferta, se conserva la lógica de una o cero tarjetas, sin inventar datos.

Comprobación vigente: **37/37 pruebas**, siete archivos, incluyendo cinco pruebas nuevas de controles, autoplay, pausa, movimiento reducido y disposición del slider. Chromium pasa 320/390/768/1440 px y casos de cero/una oferta, confirma cuatro tabs sin Ofertas, contador invisible, texto reforzado, logo sin filtro, controles del slider, fondos/sombras y apertura correcta de Ofertas. Sin errores JS ni overflow. Capturas de 320 y 390 px inspeccionadas siguiendo la skill Sites local. Build **329 archivos** aprobado, con las mismas siete advertencias previas. Assets: `store.js?v=62`, `compact-masthead.css?v=4`, `info-slider.js?v=1`, caché `fulltech-store-v82`. No se repitió la suite general ni se hizo commit, push o deploy en esta iteración.

## Corrección vigente: fila fina y dos accesos permanentes

La fila informativa se compacta de dos alturas a una sola de **34 px**, con controles en línea y degradado negro/burdeos. Las dos tarjetas inferiores se diferencian con fondos burdeos oscuro y carbón, conservando imagen en primer plano y CTA a Ofertas. Se retira el encabezado adicional para aproximarlas a la fila informativa.

Se confirmó la causa de tarjetas ausentes en la vista local: dependían de que `dailyOffers` tuviera elementos. Por el nuevo requisito, **ahora son dos accesos permanentes**, no dos ofertas ficticias. Si no hay descuentos, usan imágenes reales de novedades/catálogo y omiten precios/porcentajes; si faltan imágenes, usan un icono neutro. Se combina novedades con el resto del catálogo para completar dos imágenes distintas siempre que existan. La página Ofertas sigue indicando la disponibilidad real.

QA aislado: cuatro tamaños aprobados, casos de una/cero ofertas mantienen dos accesos con respectivamente una/cero etiquetas/precios reales, sin overflow ni errores JS. Se corrigió una carrera del arnés: espera a que el primer producto de Ofertas termine de cargar antes de comprobar el listado; no se modifica la condición esperada. En `8898` se comprobó por lectura que hay dos tarjetas, dos imágenes delante, dos imágenes en el héroe y slider de 34 px, sin modificar esa base. Captura local inspeccionada con la skill Sites. **37/37 tests dirigidos**, build329 y `git diff --check` aprobados; permanecen las advertencias y fallos generales previamente documentados. Assets `store.js?v=63`, `compact-masthead.css?v=5`, caché `fulltech-store-v83`. Sin commit/push/deploy.

## Ajuste de color y controles del slider

Franja informativa con el **mismo degradado azul oscuro del banner**, compartido mediante variable CSS. Se recupera el texto derecho en móvil (antes se ocultaba por media query) y se acortan las tres frases para que izquierda y derecha se vean completas en una sola fila de 34 px. Controles anterior/siguiente y pausa/reproducción en SVG embebido, sin depender de glifos de la fuente; se conservan etiquetas accesibles, pausa y movimiento reducido.

QA aprobado en 320/390/768/1440 px: igualdad de fondos, tres SVG, texto derecho visible sin colisión ni truncado, además de los recorridos previos. Captura de 320 px inspeccionada con la skill Sites. **38/38 tests dirigidos** (incluido el nuevo test de iconos), build329 y diff-check aprobados; siete advertencias de contenido previas sin cambios. Assets vigentes: `store.js?v=64`, `compact-masthead.css?v=6`, `info-slider.js?v=2`, caché `fulltech-store-v84`. Sin commit/push/deploy.

## Integración con el fondo blanco al desplazar

El buscador y las etiquetas, al quedar fijos, cambian a blanco opaco con texto azul oscuro y foco visible. En el inicio conservan el banner azul aprobado. Las dos tarjetas promocionales mantienen su parte superior burdeos/carbón y terminan en blanco puro desde el 85% de su altura; nombre, precio y CTA pasan a tonos oscuros para conservar contraste. No cambian enlaces, contenido ni datos.

Chromium comprobó fondo blanco y color de etiquetas después del scroll en 320/390/768/1440 px, además del degradado blanco de ambas tarjetas y los recorridos previos. Se espera el estado visual final del sticky antes de comprobarlo, no solo la clase asignada. Capturas de inicio y `sticky-white-390.png` inspeccionadas con la skill Sites local. **38/38 tests dirigidos**, build329 y diff-check aprobados, mismas advertencias de contenido históricas. Assets: CSS compacta `v=7`, caché PWA `fulltech-store-v85`; JS conserva `v=64`. Sin commit/push/deploy.
