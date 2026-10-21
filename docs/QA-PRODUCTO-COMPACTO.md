# Producto y servicio: rediseño compacto — UAT

Fecha: 21 de octubre de 2026. Entorno: http://127.0.0.1:8790, proceso `scripts/uat-env.mjs`, datos aislados de UAT. Sin despliegue ni push.

## Auditoría

El formulario original mostraba descripciones, publicación y garantía antes de completar los datos operativos; obligaba a recorrer una pantalla extensa. La ficha dedicaba demasiado espacio a imagen y tarjetas. Los controles y espacios amplios aumentaban el ruido visual.

Se revisaron `store.js`, `store.css`, POS, rutas y validaciones de `store-catalog`. El SKU sí es obligatorio; una imagen también es obligatoria para productos nuevos, excepto las excepciones de importación existentes. Por eso siguen visibles. El nombre, precio y costo son obligatorios. Los servicios no llevan inventario y su imagen es opcional. Las presentaciones antiguas comparten cápsulas y su costo se gestiona por separado. Solo ADMIN puede editar y ver los datos financieros restringidos. No existe un impuesto individual por producto: no se añadió ningún campo ni se alteró el cálculo del POS.

También se corrigieron dos problemas del formulario: enviar control de inventario en servicios y no enviar explícitamente la desactivación de garantía. Se aclaró el texto de publicación: crear guarda oculto; editar conserva el estado.

## Estructura resultante

**Formulario:** tipo, SKU, nombre que crece para mostrar el contenido, precio/costo en dos columnas, categoría con creación y, cuando corresponda, cantidad inicial e imagen. Información adicional, inventario, tienda, garantía y configuración adicional empiezan cerradas. Conserva los 26 campos existentes. El pie fijo muestra Guardar producto/servicio, estado de carga y errores. Evita dobles envíos y conserva el borrador ante errores. Los errores abren y enfocan su sección. Cambiar de tipo conserva los datos escritos y excluye del envío los campos que no corresponden.

**Ficha:** miniatura, nombre completo, SKU/tipo/estado y Editar; filas de precio, costo y ganancia según permisos, existencias, categoría y procedencia. Descripciones, tienda, garantía, inventario y proveedores quedan en secciones desplegables. Se mantienen publicación, destacado, archivo, consulta de stock y proveedores.

**Listado:** vista de lista con miniatura de 52 px, nombre, precio e inventario. Se conserva la preferencia lista/cuadrícula, búsqueda, filtros, paginación, añadir al carrito y acceso separado a la ficha.

## Archivos modificados

| Archivo | Cambio |
|---|---|
| `public/admin/store.js` | Formulario, ficha, errores, guardado y comportamiento por tipo |
| `public/admin/product-editor.css` | Estilos compactos, temas y adaptación móvil |
| `public/admin/index.html` | Carga y versión de los recursos |
| `public/admin/sw.js` | Actualización de caché y recurso nuevo |
| `tests/store-panel.test.js` | Siete regresiones nuevas del formulario |

Sin cambios de backend, esquema o contratos de API. El árbol de Git estaba limpio al iniciar esta tarea.

## Evidencia visual

Capturas locales en `../.tmp/product-review/` (carpeta ignorada por Git):

- [Formulario antes](../.tmp/product-review/antes-formulario-390.jpg) y [editor final a 360 px](../.tmp/product-review/despues-edicion-360-oscuro.jpg).
- [Ficha antes](../.tmp/product-review/antes-ficha-escritorio.jpg) y [misma ficha después](../.tmp/product-review/despues-ficha-escritorio.jpg).
- [Ficha móvil clara](../.tmp/product-review/despues-ficha-390-claro.jpg).
- [Cotización creada en navegador](../.tmp/product-review/uat-cotizacion.jpg).
- [Altura reducida para teclado](../.tmp/product-review/teclado-altura-reducida.jpg).

Hay capturas de formularios vacíos a 360/390/430 y de ficha clara a 360/390/430/800/1280. Las capturas intermedias del editor con nombre largo preceden al ajuste final de altura: la referencia final es `despues-edicion-360-oscuro.jpg`. Algunas capturas adicionales fallaron por timeout del navegador; no se presentan como obtenidas. El nombre del archivo inicial «390» corresponde al tamaño solicitado antes de compensar el zoom; las medidas finales usan anchuras CSS verificadas en DOM.

## Validación visual y funcional

Editor final medido en Chrome real a **360, 390, 430, 800 y 1280 px**, en claro y oscuro: sin desbordamiento horizontal, nombre extenso completamente visible y pie Guardar dentro del viewport. Resultados en [metricas-finales.json](../.tmp/product-review/metricas-finales.json). Se revisaron formularios vacíos y poblados, descripciones extensas, secciones abiertas/cerradas y borradores con importes 99,999,999.99 / 88,888,888.88, sin guardarlos. El selector de disponibilidad recibe foco por teclado y se desplaza por encima del pie. Un viewport de 390 × 420 conserva el pie visible; esto simula altura reducida y no sustituye un teclado real de teléfono.

UAT manual en navegador:

- Crear categoría y conservar los valores del formulario: correcto.
- Crear servicio sin imagen ni inventario: correcto (RD$250.50, costo RD$50.25).
- Editar producto con nombre de 91 caracteres y descripciones extensas: correcto; precio RD$1,250.50 y costo RD$400.25 persistidos.
- Invalidación dentro de sección cerrada: abre la sección y enfoca el campo.
- Añadir producto editado a ticket nuevo → generar COT-A6280D2E7E → pasar a ticket → facturar PE-24B4B5 por RD$1,250.50: correcto, sin envío al cliente. Stock del producto QA: 3 → 2.
- Los siete productos originales se compararon completos contra la instantánea previa: **sin cambios**. Se restauró el ticket original 8271B, Prueba Tres, RD$1,350.00, y la apariencia automática original.
- Los dos artículos QA quedan ocultos en tienda. Se conserva la categoría QA y los documentos de prueba exclusivamente en UAT. [Resultado de persistencia](../.tmp/product-review/uat-verification.json).

## Regresión automatizada

Comando: `npx vitest run tests/store-public-api.test.js tests/store-phase1.test.js tests/store-catalog.test.js tests/store-panel.test.js tests/pos-panel.test.js tests/pos.test.js -t '^(?!.*desde el chat real)'`.

**95 aprobadas, 2 omitidas.** Una omisión requiere PostgreSQL configurado; SQLite y concurrencia de inventario sí se ejercitaron. La otra exclusión corresponde a `desde el chat real abre Facturación...`, que falla con `Timeout acciones` por el selector antiguo `#wa-actions`. Se reprodujo con los archivos originales de HEAD, en una prueba temporal retirada después: es un fallo previo, fuera de este rediseño. No se afirma que toda la suite esté verde.

Cobertura: productos y servicios, categorías, validación de SKU, campos conservados, errores y enfoque, doble envío, garantía, precios/costos, inventario, publicación, imágenes vía API, permisos financieros, cotizaciones, facturación y persistencia. Tras el último ajuste visual se repitieron las 25 pruebas del panel, aprobadas sin errores. `node --check`, `git diff --check` y build local aprobados. El build mantiene siete avisos de contenido pendiente preexistentes de la landing.

## Limitaciones y decisión

La extensión de Chrome bloqueó la selección de archivos locales por falta de «Allow access to file URLs». No se cambió ese permiso. Por tanto, **queda pendiente subir una imagen válida desde el navegador y crear el producto completo por ese recorrido**. El producto QA se creó por API local con una imagen del repositorio; su edición, cotización y factura sí se hicieron en navegador. La API y el rechazo de archivos inválidos tienen cobertura automatizada; esto no sustituye la prueba manual pendiente.

También queda pendiente teclado nativo en Android/iOS. Se implementó adaptación a `visualViewport` y safe areas, y se comprobó con altura reducida.

**GO para revisión en UAT. NO-GO para producción** hasta completar subida real de imagen y teclado móvil. No se desplegó ni se hizo push.
