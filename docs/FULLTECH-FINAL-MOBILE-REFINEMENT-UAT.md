# FULLTECH Store — refinamiento móvil final

Fecha: 23 de octubre de 2026. Entorno: desarrollo local aislado, `http://127.0.0.1:4177/store/`. Sin deploy, push ni cambios en producción.

## Resultado y hallazgos iniciales

Se conservan buscador, identidad azul, tamaños de imágenes, componentes de tarjeta, navegación y reglas comerciales existentes.

- Las descripciones estaban en los datos y existía `cardSummary`, pero las tarjetas no llamaban al componente. Se restauró esa llamada, sin inventar texto.
- Los favoritos eran transparentes con poco contraste sobre las imágenes azules. Se añadió una base circular discreta, no un nuevo botón grande.
- El aviso de Google es un enlace propiedad de la aplicación (`#signup-prompt`), no Google One Tap ni un iframe. Su posición fija causaba la obstrucción.
- Categorías y Ofertas compartían buscador, pero no la persistencia al desplazarse. Ahora la misma fila, incluida la flecha, es sticky.
- Ofertas repetía títulos y subtítulos; el carrusel exponía scrollbar y solo tenía controles manuales.
- El árbol de Git ya contenía cambios de tareas anteriores. Se conservaron; no se limpió ni restauró el árbol. Los cambios previos en servidor/administración no pertenecen a este refinamiento.

## Implementado

### Componentes compartidos y tarjetas

Se reutilizan `productCard`, `homeCard`, `cardSummary`, `favoriteButton`, `syncFavoriteButtons`, `searchMarkup`, `galleryMarkup` y la delegación de favoritos existente.

- Favoritos: icono blanco, círculo negro al 22% (30% al guardar), estado activo rosado claro y foco visible. El objetivo táctil permanece de 44 px; el círculo visible es menor. Se aplica a portada, catálogo, ofertas y favoritos.
- Detalle: favorito agregado a las acciones existentes, conservando la API autenticada de favoritos. Regresar, buscar y compartir reciben el mismo tratamiento de contraste. Sin reducir la imagen.
- Descripciones: datos reales, texto escapado, máximo dos líneas, fuente pequeña y tenue, sin altura mínima. Sin descripción se omite el elemento. Se conserva el límite compacto existente de 84 caracteres.
- Disponibilidad: `Disponible` continúa como texto verde discreto. Sin fondo, borde, punto ni línea. Transición breve de color, desactivada con movimiento reducido. Los estados comerciales siguen viniendo del servidor.
- No se cambiaron precios, vigencias, publicación ni elegibilidad de ofertas.

### Categorías y Ofertas

- Misma fila de búsqueda, misma geometría, borde, icono y botón negro. Sticky con fondo opaco y offset de área segura; no se vuelve fija la cabecera completa.
- Rejilla de categorías de tres columnas en móvil conservada, filtros y productos debajo.
- Ofertas mantiene `Ofertas especiales`; elimina de la vista subtítulo y encabezado repetidos, y utiliza `Destacadas` para la selección superior.
- Contenedores con `min-width:0` y ancho acotado del carrusel para evitar expansión de la página. No se añadió un `overflow-x:hidden` global como parche.
- Icono de Ofertas: archivo original `etiqueta.png`, máscara proporcional de 21 px que hereda el color activo/inactivo. SHA256 idéntico al archivo de Descargas: `7867D5A53A88EA4411DB068D28C268563E1E912F26BE77E444BDB8C3B3ADFD57`.

### Carrusel y accesibilidad

- Scrollbar oculto, scroll horizontal nativo y snap conservados. Controles anterior/siguiente con nombre accesible, foco visible y flechas del teclado.
- Se comprobó arrastre de ratón sin abrir accidentalmente el producto, desplazamiento táctil y pausa por trackpad.
- Autoplay cada tres segundos solo para tres o más productos. Sin duplicar productos dentro de la selección; la rejilla completa permanece debajo.
- Cero ofertas: sin selección superior. Una: tarjeta estática. Dos: presentación manual sin timer. Tres o más: controles y reproducción pausables.
- Pausa por hover, foco, documento oculto, fuera de pantalla o movimiento reducido. Una interacción manual pausa hasta reanudación explícita.
- Botón Pausar/Reproducir con `aria-pressed`; reproducción desactivada y control oculto con `prefers-reduced-motion`.
- Un solo timer por montaje; limpieza al cambiar de ruta, actualizar resultados o desmontar. Sin dependencias nuevas.

### Registro y autenticación

El aviso de registro se coloca al final del contenido en flujo normal, alineado a la derecha y separado de la navegación; ya no flota sobre precios ni botones. Se conserva el enlace de autenticación existente, sin modificar contenido de Google ni configuración OAuth.

Se verificaron visitante y cuenta registrada: al reconocer una cuenta también se oculta inmediatamente el aviso, incluso cuando la sesión se actualiza desde favoritos. No se cambió el mecanismo de autenticación.

## Archivos de este refinamiento

- `public/store/store.js`: descripciones, montaje/limpieza del carrusel, favorito en detalle y sincronización del aviso.
- `public/store/offer-carousel.js`: controlador aislado del carrusel.
- `public/store/final-refinements.css`: ajustes compartidos de contraste, descripciones, sticky, títulos e invitación de registro.
- `public/store/index.html`: carga del CSS, icono suministrado y versión del script.
- `public/store/assets/icons/custom/etiqueta.png`: copia binaria exacta del archivo del usuario.
- `public/store/sw.js`: caché v71 y activos nuevos; sin modificar el flujo de instalación PWA.
- `tests/store-offer-carousel.test.js`: siete pruebas de interacción y ciclo de vida.
- `scripts/check-store-final-visual.mjs`: pruebas y capturas con datos UAT reales.
- `scripts/check-store-carousel-interactions.mjs`: prueba de gestos y reproducción en Chromium.
- `scripts/check-store-master-ui.mjs`: expectativa actualizada para selección estática de una/dos ofertas.
- Este informe. Los demás archivos sucios pertenecen al trabajo previo y se conservaron.

## Pruebas ejecutadas

| Comprobación | Resultado |
| --- | --- |
| Vitest: 10 archivos seleccionados | **93/93 aprobadas**, cero fallos |
| Carrusel unitario | 7/7: intervalo, vuelta al principio, pausa, teclado, trackpad, remount sin duplicados, desmontaje y una/dos ofertas sin timer |
| Integración seleccionada | Cuentas, API pública, ofertas diarias, aislamiento, favoritos, OAuth, SEO, checkout y flujo delivery |
| Responsive con 51 productos UAT existentes | 320, 360, 375, 390, 430, 768 y 1440 px, sin errores JavaScript ni desbordamiento horizontal |
| Buscador sticky | Categorías y Ofertas en los siete tamaños; fila visible arriba después de scroll y búsqueda editable |
| Favoritos | Alta/baja desde detalle con cuenta UAT en los siete tamaños; aviso de registro oculto al autenticar |
| Chromium: carrusel real | Avance automático, pausa hover/foco, teclado, arrastre, gesto táctil emulado, búsqueda real, cero/una oferta y movimiento reducido aprobados |
| Regresión visual master con fixtures | Ocho anchos (incluido 1024 px), ofertas 0/1/2/4/6, carrito, categorías, navegación e historial aprobados; sin errores JavaScript |
| `npm run build` | Aprobado; siete advertencias de configuración/contenido preexistentes de la landing Phytoemagry |
| `npm run check` | Aprobado, con campos informativos pendientes de la landing Phytoemagry |
| `node --check` | `store.js` y `offer-carousel.js` aprobados |
| `git diff --check` | Sin errores de whitespace; avisos CRLF/LF en archivos previamente modificados |

Resultados detallados: `.tmp/store-final-targeted.json`, `docs/capturas/store-final/after-results.json` e `interaction-results.json`.

La suite completa del repositorio **no se volvió a ejecutar en este refinamiento**. La corrida previa, registrada en `.tmp/full-suite-master.json`, tenía 2169 aprobadas, 98 fallidas y tres omitidas de 2270; no se presenta esa suite como verde ni se modificaron áreas ajenas para arreglarla.

## Evidencia visual

Capturas locales en `docs/capturas/store-final/`, excluidas por Git; conservar/copiar esta carpeta si se necesita compartir la evidencia. Se capturaron antes y después con los mismos viewports. Algunas tomas iniciales registraron estados de carga; las finales esperan el contenido y la red antes de capturar. La comparación válida de Ofertas a 320 px muestra ambos estados completamente cargados.

- [Antes: Ofertas 320](capturas/store-final/before-offers-320.png) / [Después: Ofertas 320](capturas/store-final/after-offers-320.png).
- [Inicio 390](capturas/store-final/after-home-390.png).
- [Categorías 375](capturas/store-final/after-catalog-375.png).
- [Ofertas 430](capturas/store-final/after-offers-430.png).
- [Buscador / Ofertas 768](capturas/store-final/after-offers-scroll-768.png).
- [Categorías escritorio](capturas/store-final/after-catalog-1440.png).
- [Detalle 360](capturas/store-final/after-product-360.png).
- [Favorito guardado 320](capturas/store-final/after-favorite-active-320.png).
- [Registro al final del contenido](capturas/store-final/after-registration-flow-390.png).

Se inspeccionaron visualmente muestras renderizadas de los siete anchos: portada, catálogo, ofertas, detalle, favoritos y registro. La navegación inferior puede cubrir temporalmente contenido durante el desplazamiento, pero hay espacio inferior para descubrir los últimos controles; el registro ya no lo tapa. Las tarjetas parcialmente visibles en el borde del carrusel indican continuidad y son desplazables.

## Pendientes y GO / NO-GO

- **GO para revisión local**: implementación, pruebas seleccionadas y revisión responsive completadas. No hubo cambios de producción.
- **Pendiente UAT manual**: teléfono físico Android/iOS, Safari, lector de pantalla, teclado virtual, áreas seguras e instalación PWA real. Los gestos probados aquí son emulados en Chromium.
- **OAuth real pendiente**: el entorno UAT tiene proveedores externos desactivados; se probaron sesiones/cuentas y la lógica OAuth automatizada, no un acceso vivo con Google.
- **NO-GO para despliegue automático**: no solicitado y prohibido por esta tarea. Deben revisarse los fallos previos de la suite global y aprobarse la UAT física antes de recomendar producción.
- El icono definitivo de Ofertas, pendiente en el informe anterior, queda resuelto con el archivo suministrado. Otros pendientes anteriores, como la verificación del enlace externo Fullpos, no se consideran resueltos por este trabajo visual.
