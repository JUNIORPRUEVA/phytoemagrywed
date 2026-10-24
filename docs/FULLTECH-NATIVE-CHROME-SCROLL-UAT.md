# FULLTECH — scroll nativo y barra de Chrome

Fecha: 24/10/2026. Alcance exclusivo: compatibilidad del desplazamiento con los controles del navegador. Sin deploy, commit, push, cambios de backend, flags o bases existentes.

## Diagnóstico y cambio mínimo

La portada ya usa el documento como scroller principal; no había que migrarla desde un contenedor interno. En Chromium, `document.scrollingElement === document.documentElement`; `.app-shell` y `#main` son estáticos con `overflow-y: visible`. La altura mínima del shell no es una altura fija con scroll interno. Los `overflow: hidden` de imágenes/tarjetas son recortes visuales; el drawer conserva su desplazamiento independiente. No se alteran esos elementos.

El arranque cargaba `mountReverseScroll`, que cancelaba `touchmove`/wheel y convertía el gesto en `window.scrollBy`, incluyendo inercia propia. Eso sustituía el gesto vertical nativo que necesita el navegador. Se retiraron solamente su import y montaje de `store.js`. La utilidad histórica `reverse-scroll.js` y sus seis pruebas no se borraron ni se deshabilitaron, pero **ya no están cargadas por la tienda**.

Se eliminó la regla global `html,body { overscroll-behavior-y: none; }`. Las reglas existentes dejan ambos valores en `auto`, verificado en navegador. No se añadió otro controlador de scroll, fullscreen, scroll forzado para esconder barras ni APIs de Chrome. La rueda y el tacto vuelven al sentido nativo: dedo hacia arriba avanza por productos; hacia abajo regresa. Las llamadas ya existentes para restaurar una ruta o enfocar un resultado se preservan, no se usan para manipular la barra.

## Diseño e instalación preservados

- `index.html` es idéntico a HEAD si se normalizan únicamente las versiones de assets.
- CSS compacta es idéntica a HEAD salvo la regla global retirada; no cambian colores, tamaños, cards, header, categorías, filtros ni posiciones del navbar/buscador fijo.
- El bloque de instalación PWA permanece byte-equivalente tras normalizar saltos de línea. SHA-256: `ae01aa4b1fc09235b627821256b2961fa66d02bcc7368d6a5b0f087ac7905171`.
- Service worker: únicamente revisión de caché/URLs y retirada del módulo inactivo del precache, sin cambiar handlers, política de red, instalación ni modo standalone. Assets: `store.js?v=65`, CSS `v=8`, caché `fulltech-store-v86`.

## Pruebas ejecutadas

**71/71 tests aprobados**, 12 archivos, cero fallos/omisiones: galería (UI y lógica), ofertas diarias, slider informativo, masonry, navbar, carrusel, fase1, feed, paginación, utilidad histórica de inversión y tres nuevos contratos de scroll nativo. No se cambiaron las assertions de las suites anteriores. No se repitió la suite general del CRM ni se la declara aprobada.

```powershell
npx vitest run tests/store-native-scroll.test.js tests/store-info-slider.test.js tests/store-reverse-scroll.test.js tests/store-navigation-icons.test.js tests/store-offer-carousel.test.js tests/store-product-feed.test.js tests/store-shopping-pagination.test.js tests/store-daily-offers.test.js tests/store-masonry.test.js tests/product-gallery.test.js tests/product-gallery-ui.test.js tests/store-phase1.test.js --reporter=json --outputFile=.tmp/store-native-scroll-frontend.json
$env:PLAYWRIGHT_MODULE='file:///C:/Users/pc/DEV/PROYECTOS/PRODUCTOS/DaleVentas%20POS/.tmp-playwright/node_modules/playwright-core/index.mjs'
node --experimental-sqlite scripts/check-store-compact-masthead.mjs
node --experimental-sqlite scripts/check-store-smart-uat.mjs
npm run build
git diff --check
```

Chromium automatizado en 320/390/768/1440 px: scroller raíz del documento, cero listeners globales táctiles/wheel bloqueantes, overscroll `auto`, wrappers sin scroll interno; gesto nativo asciende de 0 a 165 px y gesto opuesto regresa a 0, sin una llamada JS a `scrollBy` durante los gestos. Rueda nativa, sticky blanco, búsqueda, categoría POS, navegación por producto, restauración a 400 px y cantidades del carrito aprobados. Sin errores JS ni overflow horizontal. Se conservan los casos de cero/una oferta y accesos a ofertas.

También pasan los **10 recorridos existentes** de Smart Commerce: siete tamaños 320/375/390/430/768/1024/1440 px con checkout, cotización, pago pendiente, GPS simulado y denegación con dirección manual/carrito preservado, más tres retiros en 320/390/1024 px. Son fixtures en SQLite temporales propias, sin proveedores externos, cargos reales ni escrituras en bases existentes. No son una prueba de GPS físico ni de barra Android.

Build: **329 archivos**, aprobado; permanecen las siete advertencias históricas de contenido/configuración. `git diff --check` y sintaxis aprobados. La skill Sites se usó exclusivamente para QA local; captura `sticky-white-390.png` inspeccionada. La comparación de fuentes confirma que no se hizo rediseño.

Evidencia: `.tmp/store-native-scroll-frontend.json`, `docs/capturas/compact-masthead/results.json`, `docs/capturas/smart-commerce/results.json` y capturas existentes actualizadas por los arneses. Los JSON de Chromium marcan explícitamente `androidToolbarVerified:false`.

## Android: límite real de esta verificación

ADB no detectó un teléfono físico. Se encontraron tres AVD y se arrancó exclusivamente `fulltech-debug` en `emulator-5580`, con `-read-only`, sin snapshots, audio ni ventana. Android API35 arrancó (`sys.boot_completed=1`); Chrome instalado: **124.0.6367.219**. La política del entorno **bloqueó el lanzamiento de Chrome mediante ADB**. No se intentó eludir ese bloqueo ni cambiar flags/ajustes del navegador. Se identificó el AVD propio y se cerró; `adb devices -l` quedó sin dispositivos.

Por ello **no se verificó el ocultamiento/restauración visual de la barra en Chrome Android**, ni se afirma que la emulación responsive de escritorio lo demuestre. Tampoco se atribuye un fallo remanente a un bug de Chrome: falta la prueba en ese navegador. Esta limitación es de acceso a la sesión Android, no evidencia de que Chrome rechace el arreglo.

Pendiente manual: abrir la web actualizada en una pestaña normal de Android Chrome (no PWA), esperar la actualización del service worker y recargar, deslizar hacia arriba dentro del listado largo y comprobar que la barra se retrae; deslizar hacia abajo y comprobar que regresa. Revisar sticky, categorías, carrito, búsqueda y teclado/GPS. Registrar dispositivo, Android, Chrome y video/alturas antes/después. En standalone no existe barra de direcciones de Chrome; no se cambió ese comportamiento. Chrome administra su propia barra y una web no puede garantizar su estado.

Referencias primarias: [controles de navegador en Chromium](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/ui/android/browser_controls.md), [Chrome Android y viewport dinámico](https://developer.chrome.com/docs/css-ui/edge-to-edge), [listeners táctiles y scroll nativo](https://developer.chrome.com/blog/passive-event-listeners). Respaldan la decisión técnica, no sustituyen la prueba en Android.

## Archivos cambiados y estado

Producción: `public/store/store.js`, `public/store/compact-masthead.css`, `public/store/index.html`, `public/store/sw.js`. QA: `scripts/check-store-compact-masthead.mjs`, nuevo `tests/store-native-scroll.test.js` y este informe.

**Corrección local del bloqueo de scroll completada y regresiones seleccionadas aprobadas. Validación de la barra real Android pendiente.** No se desplegó ni se cambiaron infraestructura, lógica comercial, instalación PWA o bases existentes. El NO-GO general previo no se revoca con este ajuste.
