# FULLTECH Store: compactación móvil

Validación local del 23 de octubre de 2026. Sin despliegue.

## Alcance

Se modificaron `public/store/discovery.css`, `public/store/index.html` y `public/store/sw.js`. Se añadió el verificador `scripts/check-store-mobile.mjs` y evidencia en `docs/capturas/store-mobile/`. Los cambios ajenos presentes en backend se conservaron.

La cabecera ya medía 45 px; se mantiene esa altura para conservar controles táctiles de 44 px. El logo conserva exactamente 124 × 27,8 px. Se eliminan márgenes verticales sobrantes y se centra el conjunto.

La navegación inferior móvil pasa de 53 a 47 px, con controles de 46 px e iconos de 21 px. El área segura se suma a la altura. La reserva inferior del contenido y la posición del registro siguen la misma medida.

El buscador mantiene 40 px de altura visual, reduce su reserva de 50 a 44 px y equilibra sus márgenes laterales a 8 px. El input utiliza 1rem para evitar el zoom automático de iOS.

La tarjeta principal pasa de 220 a aproximadamente 167–179 px en móvil. Las dos tarjetas laterales tienen la misma anchura, se alinean en una cuadrícula y sus imágenes usan `object-fit: contain`. Se mantiene la lógica comercial y los enlaces existentes. Tipografía en rem, tamaños fluidos, orientación, altura disponible y áreas seguras controlan la adaptación.

## Evidencia

Capturas `before-*` y `after-*` y métricas JSON en `capturas/store-mobile/`:

- 320 × 568, 375 × 667, 390 × 844, 412 × 915, 430 × 932.
- 768 × 1024, 844 × 390 y 1280 × 800.
- 320 × 568 con texto raíz al 125 %.

Chromium real en modo headless: sin desbordamiento horizontal en inicio, catálogo, carrito y solicitud. Capturas inspeccionadas en móvil pequeño y estándar. Las tarjetas de oferta se verificaron además mediante respuestas temporales interceptadas únicamente en el navegador: capturas `fixture-*`. Esos productos visuales no se guardan ni se publican. El catálogo local no devolvía ofertas reales durante la revisión. El escalado de texto no equivale a una prueba física del teclado, del zoom del navegador o de las áreas seguras de iOS: quedan pendientes en dispositivo real.

## Comprobaciones

- `npm run build`: correcto; conserva siete advertencias existentes de contenido/configuración.
- `npm test -- --run tests/store-daily-offers.test.js`: cuatro pruebas aprobadas.
- Lógica comercial, base de datos, selección automática de ofertas y separación de tiendas sin modificaciones de esta tarea.

GO para revisión local. NO-GO para producción hasta completar la comprobación en dispositivo físico y obtener autorización de despliegue.
