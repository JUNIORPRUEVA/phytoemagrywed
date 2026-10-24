# FULLTECH Store — Microajustes de portada

## Ajuste final de espacio, Menú y Nosotros — 24 de octubre de 2026

- Hero: las dos imágenes son ligeramente más grandes. Se redujo el espacio interior inferior, el slider informativo quedó en 33 px y se eliminó el contenedor vacío que separaba el encabezado de «Entrega rápida». La distancia verificada entre ambos es de 4 px. El título del hero y los mensajes del slider siguen en una sola línea.
- Etiquetas de categorías: se muestra únicamente el prefijo de enlaces que cabe completo en la ventana. Los demás quedan ocultos en esa fila y se accede a las categorías desde la página del catálogo. El cálculo se repite al cambiar el ancho; no deja etiquetas cortadas ni usa un scroller interno.
- Menú: junto al logo hay accesos de perfil y configuración. Se retiró «A un toque»; Favoritos, catálogo, ofertas y ayuda aparecen como opciones directas para visitantes. Para usuarios registrados permanecen pedidos, direcciones cuando están habilitadas y ajustes. Las únicas tarjetas de otros proyectos son FULLPOS Cloud y la web independiente de Phytoemagry.
- Nosotros: la foto original abre la página a todo el ancho y ocupa 70 % de la altura visible, con regreso superpuesto. Debajo se muestran FULLTECH, SRL y toda la información de la empresa sin tener que expandir «Conocer más». La zona de otros proyectos muestra solo FULLPOS y Phytoemagry; no mezcla sus productos con el carrito de la tienda.

Verificación local: **118/118 pruebas** en 17 archivos, build correcto, portada en ocho anchos sin etiquetas truncadas ni desbordamiento y flujos de Menú/Nosotros en siete anchos con sesión y sin sesión. Los recorridos de búsqueda, ofertas, carrito, catálogo, precios regionales y scroll nativo siguieron pasando. Se usó SQLite temporal y se bloquearon solicitudes externas en las pruebas de navegador. `https://phytoemagryrd.lat/` respondió 200 en la comprobación local; `https://fullpos.fulltechrd.com/` agotó el tiempo de espera, así que el destino de FULLPOS debe comprobarse manualmente antes de publicar. No se hizo deploy, commit ni push. Archivos: `compact-masthead.css`, `account-hub.css`, `account-hub.js`, `store.js`, `index.html`, `sw.js`, las pruebas y los scripts de navegador correspondientes. Versión final de caché: CSS 15/5, JS 74/4, service worker 98.

## Corrección de portada y Menú — 24 de octubre de 2026

Por petición posterior, el titular blanco del hero vuelve a ocupar **una sola línea**, tanto con ofertas como sin ellas. Se aumentó el espacio de la columna de texto y se redujeron moderadamente las dos imágenes del hero en móvil. El carrusel informativo vuelve a **una sola línea por mensaje**, con una acción breve a la derecha y alto máximo de 40 px; los tres destinos se conservan. La franja del anuncio pasó a 32 px visibles dentro de un enlace de 44 px de alto, que conserva su área táctil y la reserva estable contra saltos de diseño.

El Menú utiliza menos separación entre secciones, tarjetas y botones más compactos, soluciones en dos columnas también en móvil y el título «Soluciones FULLTECH». Se conservaron todos los accesos, los datos de usuario, productos y controles de ubicación e instalación. Los ajustes compartidos del perfil y Nosotros se dejaron con sus dimensiones anteriores. Versiones de caché: `compact-masthead.css?v=13`, `account-hub.css?v=4`, `store.js?v=72`, `account-hub.js?v=3`, service worker `v95`.

Validación de esta corrección: el hero y el slider se midieron en 320, 360, 375, 390, 414, 430, 768 y 1440 px, sin desbordamiento ni errores JS; la variante sin oferta se comprobó a 320 px. El recorrido completo de Menú pasó en siete anchos para visitante y usuario registrado, con cuenta, pedidos, favoritos, direcciones, precio regional, carrito, productos publicados, scroll y enlaces. Pasaron **118/118 pruebas** en 17 archivos, `npm run build` y `git diff --check`. Las capturas `after-*.png` y `account-hub/menu-guest-*.png` corresponden al estado visual verificado. No se desplegó ni se comprobó en un teléfono físico. Las notas inferiores documentan las iteraciones anteriores y deben leerse como historial.

## Ajuste visual posterior — 24 de octubre de 2026

El logo oficial sigue en el hero y se alinea con el margen izquierdo del texto. Su fondo rectangular azul claro se reemplazó por un degradado radial que se desvanece hacia el azul de la tarjeta; el archivo original conserva su transparencia y no tiene filtro. Se bajó 6 px respecto al ajuste anterior y se redujo 1 px el padding vertical para que no toque el titular en 320 px. El título promocional usa una tipografía de mayor peso, con salto natural de línea cuando falta espacio, sin desplazar las imágenes.

Las franjas de entrega/garantía y de información tienen ahora degradados azul marino diferenciados y borde muy tenue. El carrusel presenta titulares más visibles, una segunda línea descriptiva y la acción a la derecha: «Conoce quiénes somos», «Precios especiales para ti» y «Te ayudamos a elegir». Conserva sus destinos y funcionamiento. El tamaño de la segunda línea subió a 10 px; la franja informativa sigue compacta y sin controles visibles.

Archivos de este ajuste: `public/store/compact-masthead.css`, `public/store/store.js`, `public/store/index.html`, `public/store/sw.js` y las comprobaciones de `scripts/check-store-compact-masthead.mjs` y `scripts/check-store-micro-refinement.mjs`. Se actualizaron las versiones de caché a CSS 12, JS 71 y service worker 94. No hubo cambios de productos, backend, autenticación, PWA ni lógica comercial.

Verificación posterior: **118/118 pruebas** en 17 archivos, `npm run build` correcto (331 archivos; persisten siete avisos de contenido anteriores), `git diff --check` correcto. El navegador local pasó el control completo en 320, 360, 375, 390, 414, 430, 768 y 1440 px, sin desbordamiento ni errores JS. Pasaron también la navegación de ofertas, búsqueda, carrito, slider con flechas y gesto táctil simulado, y el control de scroll nativo en 320/390/768/1440 px con fixtures sin oferta y con una oferta. Las capturas `after-*.png` en la ruta mencionada más abajo muestran el estado de este ajuste; la tabla original compara el estado anterior a este ajuste y se conserva como historial. No se verificó en teléfono físico ni se desplegó.

Fecha: 24 de octubre de 2026. Trabajo local, sin deploy, commit ni push. Se preservó el trabajo local previo de Menú, cuenta, Nosotros y scroll nativo.

## Cambios mínimos realizados

- **Logo:** arriba a la izquierda del mismo hero, alineado con su texto: 10 px en móvil y 16 px desde 760 px. Conserva dimensiones, proporción, archivo oficial y colores originales. Fondo del contenedor `#DCEAFF → #BBD5FF`; retirado el halo blanco. Sin nuevas sombras. La altura del hero no cambió en ninguno de los ocho anchos medidos.
- **Beneficios:** mismo contenido y condiciones, dos columnas, fondo azul oscuro compartido con el slider, titulares blancos, descripciones e iconos azul claro. Altura medida: 40–41.8 px, sin imponer un alto fijo que recorte texto. Separador discreto y radio de 8 px.
- **Slider:** retirado del HTML el bloque de anterior/siguiente/pausa. Una sola columna usa todo el ancho disponible. Conserva enlaces y desplazamiento horizontal nativo; autoplay cada seis segundos cuando corresponde, pausa durante foco, hover, interacción de puntero y pestaña oculta. Flechas y espacio funcionan sobre la pista enfocada. Respeta cambios de preferencia de movimiento reducido y no pierde una pausa explícita del usuario. Los controles opcionales del módulo siguen siendo compatibles con las pruebas existentes, pero no se renderizan en la portada.
- **Anuncio/registro:** franja visual de 36 px mediante fondo interior, con enlace completo de al menos 44 px de alto. Icono/texto a la izquierda y acción a la derecha. El contenedor reserva 48 px, frente a los 60 anteriores, para evitar saltos al mostrar el anuncio. No se modificó la rotación de anuncios ni la autenticación.
- **Espacios:** márgenes horizontales comunes de 10 px en móvil y 16 px en escritorio para registro, beneficios, slider, accesos a ofertas y listado. Separaciones de 8 px; padding inferior de tarjetas de oferta de 9 a 3 px; menos espacio entre título, imagen, precio y enlace. Enlaces inferiores alineados y fotografías centradas, sin reducir su tamaño. Se conservaron los fondos, tipografía, enlaces, precios y selección de ofertas.

## Archivos de esta tarea

- `public/store/compact-masthead.css`: únicamente estilos de componentes existentes de portada.
- `public/store/info-slider.js`: funcionamiento sin controles visibles, teclado, pausa de interacción y preferencia de movimiento.
- `public/store/store.js`: import del slider versionado y retirada de su bloque de controles del template de portada; sin cambios en funciones comerciales.
- `public/store/index.html`, `public/store/sw.js`: versiones de recursos/caché; sin cambios en manifest ni instalación PWA.
- `tests/store-info-slider.test.js`: cuatro casos nuevos; se conservaron sus seis pruebas anteriores.
- `scripts/check-store-compact-masthead.mjs`: sustituye comprobaciones de controles retirados por teclado y ausencia de controles, y comprueba el alto compacto del anuncio. Conserva búsqueda, filtros, carrito, gestos y restauración.
- Nuevo `scripts/check-store-micro-refinement.mjs` y este informe.

No se tocaron backend, esquemas, bases existentes, productos, tarifas, precios regionales, GPS, checkout, CRM ni proveedores.

## Comparación medida antes/después

Fixtures aislados con ocho productos publicados y dos ofertas; mismos datos y tamaños de ventana antes y después. Medidas en píxeles CSS. Las imágenes de prueba no sustituyen las de la tienda.

| Ancho | Beneficios antes → después | Tarjeta de oferta antes → después | Inicio del listado antes → después |
| --- | --- | --- | --- |
| 320 | 58.4 → 41.8 | 247.0 → 225.9 | 682.5 → 623.8 |
| 360 | 45.4 → 40.0 | 265.2 → 244.1 | 701.8 → 654.3 |
| 375 | 45.4 → 40.0 | 272.0 → 250.9 | 713.9 → 666.4 |
| 390 | 45.4 → 40.0 | 279.8 → 258.7 | 727.0 → 679.5 |
| 414 | 45.4 → 40.0 | 290.7 → 269.6 | 746.4 → 698.9 |
| 430 | 45.4 → 40.0 | 299.0 → 277.9 | 760.3 → 712.8 |
| 768 | 50.6 → 40.0 | 371.0 → 349.0 | 827.1 → 773.5 |
| 1440 | 50.6 → 40.0 | 371.0 → 349.0 | 827.1 → 773.5 |

Hero: diferencia de alto **0 px** en todos los tamaños. El ancho de las imágenes promocionales no se redujo. Sin desbordamiento horizontal ni errores JavaScript en las ocho vistas. Capturas comparativas y mediciones: `docs/capturas/micro-refinement/before-*.png`, `after-*.png`, `before.json`, `results.json`. Captura adicional del registro: `registration-390.png`.

## Pruebas ejecutadas

- **118/118 pruebas aprobadas**, 17 archivos: frontend, slider, galería, feeds, navegación, scroll nativo, ofertas, cuentas, identidad, favoritos y aislamiento de tiendas. JSON: `.tmp/store-micro-refinement-tests.json`. No equivale a una aprobación de toda la suite general del CRM.
- `check-store-micro-refinement.mjs --before` y después sin el argumento: ocho anchos; alineaciones, logo legible y sin solaparse con el texto, altura del hero, área clicable, beneficios, ausencia de controles, fotos, dos columnas de productos y navbar. Flechas en todas las vistas; swipe mediante CDP en 320 px; rotación al anuncio de registro y apertura de su ruta en 390 px; enlaces de ofertas, agregar al carrito, búsqueda y buscador sticky blanco.
- `check-store-compact-masthead.mjs`: aprobado en 320/390/768/1440 px y fixtures de cero/una oferta. Conserva scroll vertical nativo con gestos, sin interceptores globales, filtros, búsqueda, cantidades del carrito y restauración de posición al regresar de un producto.
- `npm run build`: aprobado, 331 archivos. Permanecen los siete avisos previos de configuración de la landing; no se ocultaron ni se modificaron en esta tarea.
- `git diff --check`: sin errores.

Los scripts de navegador crean su propio servidor y SQLite temporal, bloquean destinos externos y no usan bases de producción ni envían mensajes o pagos reales. Se ejecutaron con Playwright/Chromium local mediante `PLAYWRIGHT_MODULE`.

## Ajustes descartados y límites

La primera compactación del anuncio quitaba toda reserva de alto y produjo un salto al volver a la portada cuando el contenido aparecía. Se restituyó una reserva compacta de 48 px, manteniendo la reducción visual; la regresión de restauración aprobó después. Al alinear las tarjetas con flex, se corrigió su mínimo intrínseco de imagen para conservar el tamaño anterior. No se comprometieron los controles de negocio ni el tamaño de las fotos para obtener el ajuste.

La comprobación del buscador espera que termine su transición visual a blanco; la navegación espera la pantalla de destino y el render completo, no solo el cambio de URL. Se mantuvieron las comprobaciones, sin desactivar pruebas ni ocultar fallos.

Validación realizada en Chromium de escritorio con viewports y gestos emulados, **no en un teléfono físico**. Sigue pendiente comprobar el aspecto con fotos reales y el teclado en Android/iOS, y el colapso real de la barra de Chrome Android. No se modificó dicha barra ni se afirma haberla certificado. No se desplegó ni se cambió infraestructura o comportamiento de instalación PWA.

Para revertir esta tarea, retirar solo estos microajustes de CSS, markup del slider y su soporte adicional, coordinando las versiones de caché. Preservar las mejoras locales anteriores. No requiere reversión de base de datos.

## Ajuste posterior: comportamiento táctil y Menú (24-10-2026)

- Se solicitó impedir el zoom y la selección accidental de texto. La portada/PWA y la página independiente de verificación usan viewport con escala máxima 1 y `touch-action: pan-x pan-y` en el shell, preservando el desplazamiento nativo y los carruseles. El texto de interfaz no es seleccionable; los campos de entrada y áreas editables sí lo son.
- La segunda imagen promocional ahora es más alta que la primera, también en escritorio. Se redujo la altura visual de la franja rotativa mediante sus espacios internos, conservando sus 44 px de área táctil.
- Menú incorpora botón de regreso de 44 px, conectado al mismo manejo de historial que el resto de la tienda, con fallback a Inicio.
- Se incrementaron las versiones de recursos y caché PWA para que la actualización llegue a instalaciones existentes; no se cambió la lógica de instalación.
- Regresión: 118/118 pruebas seleccionadas; navegador local en ocho anchos (320–1440 px), sin desbordamiento horizontal ni errores JS, con búsqueda, ofertas, carrito y registro; Menú invitado/autenticado y regreso en siete anchos; build correcto con siete avisos previos de la landing. No hay pruebas en Android/iOS físico.
- Límite: navegadores, opciones de accesibilidad y controles propios del navegador pueden ignorar la restricción de zoom. Quitar zoom reduce accesibilidad para personas con baja visión; se recomienda reconsiderarlo antes de producción. No se interceptan gestos ni se modifica la barra nativa de Chrome.

## Etiquetas bajo el buscador (corrección posterior)

Por solicitud posterior, se retiró la regla que ocultaba etiquetas incompletas: ahora la fila conserva todas las categorías y permite desplazamiento horizontal. En 320 px se ve parcialmente la siguiente etiqueta como pista visual; se comprueban el gesto táctil y la ausencia de scroll horizontal de la página. Esto sustituye la validación anterior de «solo etiquetas completas». La versión de caché se incrementó a `fulltech-store-v100`. Las 118 pruebas seleccionadas y el build continúan aprobados; no se desplegó.
