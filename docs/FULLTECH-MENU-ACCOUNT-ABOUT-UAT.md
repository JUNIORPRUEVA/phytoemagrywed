# FULLTECH Store — Menú, cuenta y Nosotros

Fecha: 24 de octubre de 2026. Implementación y validación exclusivamente locales; sin deploy, push, migraciones ni cambios en bases existentes.

## Resultado y alcance

El Menú de la navegación inferior ahora abre una página completa en `#/menu`, con marca compacta, cuenta, accesos, presentación corporativa, soluciones y productos. Se retiraron el drawer, scrim y controladores de apertura/cierre; permanece la navegación inferior y su estado activo. El logo pasa de los 208 px del drawer a 112 px.

Se preservan la portada, búsqueda, filtros, carrito, checkout, precios, reglas comerciales, publicación y aislamiento de tiendas. Se conservaron los cambios locales previos de scroll nativo. No se cambió ningún archivo del backend.

## Auditoría y componentes reutilizados

- SPA y rutas hash existentes de `store.js`, sesión y proveedores de autenticación existentes.
- Perfil y preferencias mediante `/api/store/account/me`; pedidos, favoritos y cierre de sesión existentes. No hay un segundo sistema de cuentas.
- `productCard`, favoritos, imágenes/fallbacks, ofertas, disponibilidad, agregar al carrito y detalle del catálogo existente.
- `createProductFeed`, `mountMasonry`, abortado de solicitudes, reintento, deduplicación y snapshots existentes. Los nuevos bloques usan lotes de 12; los otros feeds conservan su valor predeterminado de 100.
- `/api/store/catalog?kind=product`, con `zonePath`: publicación y separación FULLTECH/Phytoemagry siguen siendo responsabilidad del servidor existente.
- Logo oficial `fulltech-store-horizontal-240.webp`, imagen corporativa existente y los iconos lineales locales.
- Ubicación y direcciones de Smart Commerce: solo se ofrecen si su configuración pública confirma que está habilitado. No se activaron flags de producción.

## Rutas y experiencia

| Ruta | Comportamiento |
| --- | --- |
| `#/menu` | Página de Menú, sin overlay ni drawer. Invitados: bienvenida, acceso y registro, sin datos privados. Clientes: nombre, avatar y accesos reales. |
| `#/account` | Perfil existente; conserva campos, preferencias, pedidos/favoritos y logout. Añade «Recomendados para ti». |
| `#/account/settings` | Reutiliza el perfil y sus preferencias persistentes; título «Configuración». No crea una configuración ficticia. |
| `#/account/addresses` | Consulta autenticada de direcciones guardadas; estado vacío, error y reintento. No inventa edición o eliminación de direcciones. |
| `#/orders`, `#/favorites` | Rutas y autenticación existentes. |
| `#/nosotros` | Introducción compacta, «Conocer más» accesible con `details/summary`, seis soluciones y «Explora nuestros productos». |
| `#/nosotros?solution=…` | Destino informativo real para las cuatro soluciones del Menú; abre la información adicional. |

«Nosotros» conserva información de Higüey, tecnología/accesorios, herramientas, cámaras, portones, asesoría, almacén/proveedores, electricidad/redes, entrega y recogida coordinadas, pagos pendientes de verificación, garantía según ficha y contacto oficial. No se inventaron historia, certificaciones, cifras o cobertura.

FULLPOS Cloud y Phytoemagry se presentan como otros productos del ecosistema, no como inventario de esta tienda. Los accesos usan la página informativa implementada, sin inventar destinos externos. Se intentó verificar los dominios públicos que ya figuraban en el drawer: Phytoemagry respondió HTTP 200 mediante la comprobación local; FULLPOS agotó el tiempo de espera. La disponibilidad y aprobación de enlaces externos queda pendiente; no se presenta un timeout como inexistencia del sitio. No hay afirmaciones médicas.

Los tres bloques de productos declaran que la selección es general, no personalizada. Se conservan precios regionales, ofertas reales, disponibilidad y publicación. Los snapshots acotados permiten volver desde un producto conservando páginas y posición; elegir otra ubicación invalida los snapshots.

## Archivos de esta mejora

- Nuevos: `public/store/account-hub.js`, `public/store/account-hub.css`, `tests/store-account-hub.test.js`, `scripts/check-store-account-hub.mjs` y este informe.
- Modificados: `public/store/index.html`, `store.js`, `navigation-icons.js`, `product-feed.js`, `smart-commerce-ui.js`, `sw.js`; `tests/store-product-feed.test.js`, `tests/store-navigation-icons.test.js`; `scripts/check-store-compact-masthead.mjs` adapta su comprobación de drawer al nuevo Menú real y conserva las comprobaciones de portada y scroll.
- `compact-masthead.css`, `tests/store-native-scroll.test.js` y el informe de Chrome ya tenían cambios locales anteriores; se preservaron.
- El service worker solo actualiza versiones y recursos de caché. El control de instalación pasa a la página Menú con el mismo diálogo nativo y fallback del navegador, sin cambiar manifest ni forzar instalación.

## Pruebas y evidencia

### Pruebas automatizadas

**114/114 pruebas seleccionadas aprobadas**, 17 archivos, cero fallos, en dos ejecuciones sin solapamiento: 86 casos frontend/catálogo/aislamiento en `.tmp/store-account-hub-final.json` y 28 casos existentes de cuentas, identidad y favoritos en `.tmp/store-account-hub-auth.json`.

Incluye los 71 casos frontend de la validación anterior, nuevos casos del hub, lotes pequeños/refresco/rearmado del sentinel, variante activa de Menú, cinco pruebas de aislamiento FULLTECH/Phytoemagry y 28 casos existentes de cuentas/identidad/favoritos. El controlador legado de scroll invertido conserva sus pruebas unitarias, pero NO se importa ni se activa en la tienda.

Comando ejecutado:

```powershell
npx vitest run tests/store-account-hub.test.js tests/store-native-scroll.test.js tests/store-info-slider.test.js tests/store-reverse-scroll.test.js tests/store-navigation-icons.test.js tests/store-offer-carousel.test.js tests/store-product-feed.test.js tests/store-shopping-pagination.test.js tests/store-daily-offers.test.js tests/store-masonry.test.js tests/product-gallery.test.js tests/product-gallery-ui.test.js tests/store-phase1.test.js tests/store-isolation.test.js --reporter=json --outputFile=.tmp/store-account-hub-final.json
npx vitest run tests/store-accounts.test.js tests/store-favorites.test.js tests/store-auth-uat.test.js --reporter=json --outputFile=.tmp/store-account-hub-auth.json
npm run build
git diff --check
```

Build aprobado: 331 archivos. Permanecen siete avisos previos de configuración de la landing, no corregidos ni ocultados en esta tarea. `git diff --check` sin errores. No se ejecutó ni se declara aprobada toda la suite general del CRM.

### Navegador Chromium local

Los scripts arrancan servidor y SQLite temporales propios, proveedores externos deshabilitados y navegación externa bloqueada. No usan las bases del usuario ni envían WhatsApp, OAuth o pagos reales.

- `check-store-account-hub.mjs`: 7 tamaños, 320/375/390/430/768/1024/1440 px. Invitado y cliente autenticado; URL directa y recarga del Menú; navegación atrás; perfil y preferencias guardados y releídos; pedidos; favoritos persistidos; direcciones de la cuenta; información expandible; seis soluciones; agregar al carrito; 26 productos publicados cargados por lotes y borrador excluido. Comprueba precio regional de RD$2,000 tras GPS simulado, restauración de los 26 productos y posición al volver del detalle, scroll de documento, estado de app instalada, logout sin datos privados y cero desbordamientos/errores JS. Evidencia: `docs/capturas/account-hub/results.json` y capturas de invitado, cliente, Nosotros y perfil por tamaño.
- `check-store-compact-masthead.mjs`: auditoría de regresión de portada, búsquedas, filtros, carrito, sticky y scroll. **Tres ejecuciones completas consecutivas aprobadas**, cada una con cuatro tamaños y fixtures de cero/una oferta. Evidencia de la última: `docs/capturas/compact-masthead/results.json`.
- `check-store-smart-uat.mjs`: 10/10 escenarios aprobados. Siete tamaños con cotización regional RD$2,000 + RD$1,100 de entrega = RD$3,100, pago pendiente, GPS simulado y fallback manual conservando carrito. Tres tamaños con retiro autorizado: bloqueo por impago, código de un solo uso e integración CRM. Evidencia: `docs/capturas/smart-commerce/results.json`.

Para repetir los scripts de navegador se requiere Playwright/Chromium disponible; en este entorno se utilizó el módulo local indicado por `PLAYWRIGHT_MODULE`.

### Incidencias detectadas durante la implementación

Se corrigió una incidencia real del feed con lotes pequeños: si el sentinel seguía en el margen de precarga después de agregar productos, podía no solicitar la siguiente página en escritorio. Ahora se rearma tras cada página válida; se añadió una prueba específica y se verificaron las tres páginas del fixture.

La repetición de la auditoría detectó un salto intermitente al volver a la portada: la llamada de restauración pedía 400 px y la posición acababa en 435 px, sin otra llamada JavaScript de desplazamiento. Se observó durante la organización inicial del contenido. La restauración de navegación ahora espera dos frames de layout de masonry/ResizeObserver y vuelve a comprobar que la ruta siga vigente antes de efectuar la única restauración existente. `aria-busy` comunica el estado de renderizado; el arnés espera que termine antes de empezar otro gesto. Las tres repeticiones finales conservaron exactamente la posición de salida. No se añadieron desplazamientos durante los gestos, temporizadores correctivos ni exclusiones globales de anclaje. El ajuste automático ante cambios de layout es un mecanismo del navegador descrito por [CSS Scroll Anchoring, W3C](https://www.w3.org/TR/css-scroll-anchoring-1/); esta referencia no sustituye las mediciones locales ni certifica Android.

Se corrigieron supuestos del arnés de pruebas, no reglas comerciales: teléfono sintético de longitud inválida y comprobación del navbar que inicialmente omitía los 12 px inferiores que ya usa el diseño de escritorio. Para navegación atrás se registra la posición real en el click, sin asumir que la automatización nunca ajusta el viewport al hacer click. Se conservó la comprobación exacta y se mantuvo diagnóstico detallado ante fallos. No se desactivaron pruebas ni se ocultaron fallos de aplicación.

## Límites, UAT manual y reversión

- Pendiente revisar en teléfono real Android/iOS, teclado, lector de pantalla, OAuth real autorizado e instalación PWA real. La prueba de estado instalada usa el evento/estado simulado, no una instalación efectiva.
- Se mantiene `document.documentElement` como scroll principal, sin contenedores de alto fijo ni interceptación global de gestos. **El colapso real de la barra de Chrome Android NO está certificado**: sigue la limitación documentada en `FULLTECH-NATIVE-CHROME-SCROLL-UAT.md`.
- Direcciones: consulta de registros existentes y guardado mediante el checkout existente con consentimiento; esta mejora no ofrece CRUD adicional.
- Las recomendaciones no son personalizadas. Los textos empresariales provienen de la información existente y requieren revisión editorial del negocio antes de publicación.
- Revisar caché con una sesión existente al hacer un despliegue futuro; esta tarea no desplegó nada.
- Reversión: revertir únicamente los cambios frontend/QA de esta mejora, coordinando `index.html`, imports y versiones de `sw.js`; retirar los dos archivos del hub si dejan de referenciarse. Conservar el arreglo previo de scroll nativo. No requiere rollback de base ni migraciones. No se ejecutaron comandos destructivos.

**Resultado: mejora frontend apta para revisión local. No constituye autorización de despliegue ni certificación general de producción.**
