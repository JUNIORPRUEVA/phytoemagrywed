# FULLTECH Store — experiencia de compra móvil

23 de octubre de 2026. Desarrollo local: <http://127.0.0.1:4177/store/>. **Sin deploy, push, migraciones ni cambios en datos de producción.**

## 1. Auditoría inicial

Se revisaron layout, tokens, portada, catálogo/categorías, ofertas, búsqueda, detalle, carrito/checkout, cuentas, pedidos, drawer, navegación, paginación pública, aislamiento y estilos responsive. Se registró el Git inicial en `.tmp/store-shopping-initial-git.txt`; ya había cambios de tareas anteriores en frontend, servidor, administración y tests, que se preservaron.

Hallazgos principales:

- La API limitaba las páginas a 48; la interfaz solicitaba 24 y ofrecía «Ver más».
- La navegación tenía tres destinos. `custom-icons.js` utilizaba siluetas PNG outline e ignoraba en esos casos la solicitud de variante filled.
- Dos hojas antiguas ocultaban Carrito en móvil. Se corrigió la precedencia para mostrarlo sin alterar la altura del dock.
- Había fondos grises y scrollbars verticales ocultos también en escritorio.
- Inicio fijaba solo la búsqueda mediante una fila existente, sin chips de categorías.
- Las rejillas igualaban filas; un nombre de tarjeta todavía tenía altura fija de dos líneas.
- Al cambiar a una ficha, el evento de scroll producido al reducirse el documento sobrescribía la posición guardada del catálogo. Se corrigió esa carrera.
- El drawer cerrado proyectaba una sombra sobre el borde izquierdo; ahora solo el drawer abierto conserva su sombra.

Se utilizó la guía de Sites en modalidad **local-only**: revisión del sitio existente, preview, pruebas y build, sin crear hosting ni publicar.

## 2. Cambios implementados

Fondo principal blanco en todas las pantallas de la tienda. Se conservan imágenes, fondos azules de producto, hero, logo, tipografía, botones y superficies promocionales deliberadas. Los estilos nuevos están exclusivamente en `/store/`, no en CRM.

No se reescribieron cuentas, checkout, pedidos ni delivery. Se reutilizan tarjetas, buscador, filtros, carrito persistente, favoritos, API pública y reglas comerciales.

## 3. Navegación: outline / filled reales

Cuatro destinos, en este orden: **Inicio, Categorías, Ofertas y Carrito**. Carrito reutiliza `#/cart` y su badge se calcula con las cantidades reales del mismo `localStorage` existente.

Cada destino tiene dos variantes distintas:

- Inactiva: icono outline existente, color neutro.
- Activa: geometría SVG sólida con `fill="currentColor"`, usando el token `--ft-primary` existente (`#165dff`). No es simplemente un fondo azul detrás del icono outline.
- Etiqueta activa azul y `aria-current="page"`; foco visible y dimensiones del dock conservadas.
- Carrito sigue siendo outline neutro cuando tiene artículos pero no es la pestaña activa; el badge sí puede ser azul.
- Ofertas mantiene el `etiqueta.png` original del usuario como outline y utiliza una variante sólida con recortes para el porcentaje.
- Checkout marca Carrito. Las demás pantallas sin pestaña propia no inventan una quinta opción.

## 4. Buscador y filtros sticky

Inicio conserva la fila y la apariencia aprobada del buscador: fondo claro, esquinas, borde y botón negro con icono blanco. Debajo hay chips horizontales tomados de los `categoryCards` reales: Todos, las categorías publicadas y acceso a Ofertas.

La fila combinada se mantiene arriba mediante el mecanismo existente de fijación; se reserva su altura para evitar saltos. No se fija el hero completo. Se respetan áreas seguras.

Todos es el filtro inicial. Seleccionar una categoría actualiza el feed en el servidor, guarda el filtro en el hash y lleva al feed filtrado con margen para la búsqueda fija. Los bloques comerciales de Inicio permanecen disponibles arriba. Ofertas lleva al destino dedicado.

Categorías y Ofertas conservan su misma fila sticky con flecha. Búsqueda reutiliza ahora catálogo, filtros y feed incremental en lugar de una lista limitada a 12 resultados. El input recibe foco sin provocar scroll.

## 5. Paginación automática

`product-feed.js` solicita **100 productos por lote**, empezando en página 1. `IntersectionObserver` solicita la siguiente página al acercarse a 600 px del final. No hay botón «Ver más» en funcionamiento normal.

- Una solicitud activa por feed; `AbortController` y descarte de respuestas al desmontar/cambiar filtros.
- IDs estables en tarjetas y deduplicación dentro y entre páginas.
- Se agregan tarjetas sin reconstruir las anteriores.
- Si falla una página, se mantienen las tarjetas confirmadas y aparece Reintentar para **esa misma página**. No hay bucle automático de errores.
- Fin de selección solo tras la confirmación de `pagination.pages` del servidor. Vacío sin spinner infinito.
- Si una página no agrega IDs nuevos pero el servidor confirma más páginas, se rearma la observación para no quedarse detenido.
- Snapshot en memoria de hasta 12 selecciones, con todos los lotes ya cargados, para volver de fichas sin volver a pedir páginas anteriores. No persiste precios como fuente de verdad.
- La actualización periódica existente puede refrescar las páginas cargadas de forma atómica, conservando los resultados si falla la red. Checkout mantiene su validación del servidor.
- Fallback manual únicamente para navegadores sin `IntersectionObserver`; no es la experiencia normal.

Servidor: el máximo compatible cambia de 48 a 100, conservando el valor predeterminado de 24 para clientes antiguos. Se usa paginación offset existente con desempate determinista por ID para todos los órdenes. El catálogo público sigue aplicando la publicación y el aislamiento FULLTECH; no se cambió su proyección ni se amplió acceso a PHYTOEMAGRY.

## 6. Masonry y tarjetas

Masonry ordenado mediante CSS Grid y medición con `ResizeObserver`: cada tarjeta ocupa la columna más corta, manteniendo el DOM y un orden visual de coordenada vertical no decreciente. No se usa `grid-auto-flow:dense`, orden CSS arbitrario ni columnas que desorganicen el tabulado.

- Dos columnas en móvil, tres desde 600 px, cuatro desde 900 y cinco desde 1200.
- Alturas derivadas de contenido real. Sin alturas aleatorias ni altura fija del nombre.
- Imágenes y proporciones existentes conservadas; carga lazy y tamaños declarados.
- Nombre y descripción de hasta dos líneas; categoría y descuentos únicamente de datos reales.
- Precio, precio anterior válido, Disponible verde sin fondo, favorito contrastado y carrito compacto conservados.
- El carrusel destacado de Ofertas sigue horizontal, sin scrollbar expuesto, con autoplay/pausa accesibles del refinamiento anterior. No se le aplica masonry.
- Carrito, formularios y pedidos mantienen estructuras convencionales; no se fuerzan a masonry.

## 7. Scroll y vuelta atrás

Se mantiene el scroll nativo del documento, sin invertir gestos, duplicar contenedores verticales ni imponer smooth scrolling global. En escritorio con ratón se recupera un scrollbar fino. Los controles horizontales conservan swipe.

Se evita guardar posiciones transitorias durante cambios de ruta. Al volver de una ficha se reconstruyen las páginas guardadas, se calcula el masonry y se restaura la posición anterior. Validado con 251 tarjetas y posición de scroll de 2200 px.

## 8. Archivos de este alcance

| Archivo | Cambio |
| --- | --- |
| `public/store/store.js` | Integración de feeds, chips, navegación, caché por selección y scroll/back |
| `public/store/index.html` | Cuatro destinos, hooks de iconos y carga de CSS / script v54 |
| `public/store/product-feed.js` | Carga incremental, deduplicación, cancelación, retry, snapshots y refresh |
| `public/store/masonry.js` | Layout ordenado y limpieza de observadores |
| `public/store/navigation-icons.js` | Pares outline / SVG filled |
| `public/store/shopping-experience.css` | Lienzo blanco, cuatro pestañas, sticky/chips, masonry y scrollbar desktop |
| `public/store/sw.js` | Caché v72 con módulos y estilos nuevos |
| `server/store-public-routes.mjs` | Tope 100 y desempate por ID, sin cambiar aislamiento |
| `tests/store-public-api.test.js` | Expectativa del nuevo máximo de 100 |
| `tests/store-product-feed.test.js` | Siete pruebas de lotes, error, duplicados, abort, snapshots y refresh |
| `tests/store-shopping-pagination.test.js` | Dos pruebas de API pública con 251 fixtures y orden determinista |
| `tests/store-navigation-icons.test.js` | Cuatro pruebas de variantes por destino |
| `tests/store-masonry.test.js` | Alturas naturales y conservación de orden |
| `scripts/check-store-shopping.mjs` | Responsive, navegación, filtros, carrito, 251 productos y vuelta atrás |
| `scripts/check-store-shopping-pwa.mjs` | Service worker, caché pública, offline y sesión / favoritos / carrito |
| `scripts/check-store-master-ui.mjs` | Expectativa de cuatro destinos |

Los archivos sucios de administración, OAuth, manifest y otros cambios anteriores se preservaron y no se consideran cambios nuevos de esta tarea. No se editaron registros financieros ni se hicieron migraciones.

## 9. Pruebas automatizadas

**Selección final: 107/107 aprobadas, en 14 archivos.** Incluye feed, paginación, masonry, iconos, carrusel, cuentas, API pública, ofertas diarias, aislamiento, favoritos, OAuth, SEO, checkout y flujo unificado de delivery. Resultado: `.tmp/store-shopping-targeted.json`.

La suite completa se ejecutó durante la implementación: **2290 pruebas, 2188 aprobadas, 99 fallidas y tres omitidas**, 162 archivos (28 con fallos). Archivo `.tmp/store-shopping-full.json`. El test unitario adicional de masonry se añadió después de esa corrida y pasó dentro de la selección final; no se presenta como una nueva corrida completa.

Los fallos globales incluyen panel/CRM, notificaciones, delivery-assignment, offline, ventas y operaciones. La corrida previa tenía 98 fallos; **no se afirma que los 99 actuales sean todos los mismos**. Se compararon los nombres de los fallos y se repitieron cuatro archivos fuera del alcance: 73/78 aprobadas y cinco fallidas en esa selección (`.tmp/store-shopping-extra-failures.json`). No se corrigieron áreas ajenas ni se atribuyeron automáticamente esos fallos al frontend.

Las pruebas específicas de tienda de la selección final no fallaron. La suite global **no está verde**.

## 10. Navegador y responsive

Chromium, tamaños 320, 360, 375, 390, 430, 768, 1024 y 1440 px, altura 844:

- Inicio, Categorías, Ofertas, búsqueda, detalle, Carrito, registro y pedidos de visitante.
- Cuatro destinos visibles, filled activo y outline inactivo, color corporativo real.
- Lienzo blanco; sin desbordamiento horizontal ni errores JavaScript.
- Buscador fijo en Inicio/Categorías/Ofertas; chips de Inicio visibles al desplazarse.
- Columnas y orden visual de masonry comprobados.
- Filtro real Hogar, Todos = 51 productos demo publicados; agregado al carrito y contador real.

Prueba de catálogo grande en un contexto de navegador separado: **251 fixtures**, lotes 100 + 100 + 51. Falla deliberada de página 2, reintento correcto, cero duplicados, fin confirmado, filtro a Hogar con reinicio en página 1, cancelación de consulta antigua y recuperación de scroll al volver de una ficha.

Los 251 fixtures se interceptan únicamente en ese navegador: **no se insertan en una base de datos**. El preview visible conserva 51 productos DEMO UAT, siete categorías y 14 ofertas del catálogo UAT existente, copiado en un SQLite temporal aislado. Se reinició solamente ese servidor de prueba para cargar el límite de API actualizado. La base UAT fuente se abrió en modo solo lectura; proveedores externos y scheduler permanecen desactivados.

Evidencia estructurada: `docs/capturas/store-shopping/results.json`.

## 11. PWA, autenticación, favoritos y carrito

Prueba adicional con service worker habilitado:

- `fulltech-store-v72` controla la página y contiene los cuatro activos nuevos.
- Tras una visita online controlada, el feed público previamente almacenado carga offline.
- No hay respuestas de cuentas ni administración en Cache Storage.
- Cuenta UAT autenticada: desaparece la invitación de registro, se guarda favorito y se conserva Carrito al navegar.

Resultado: `docs/capturas/store-shopping/pwa-auth-results.json`. Esto **no equivale** a probar instalación en un teléfono ni checkout offline. El acceso real a Google no se realizó: proveedor externo desactivado en UAT; su lógica automatizada sí está incluida en las pruebas específicas.

Se repitió la prueba del carrusel anterior: autoplay, pausa hover/foco, teclado, arrastre de ratón, swipe táctil emulado, búsqueda, cero/una oferta, registro sin solapamiento y movimiento reducido aprobados (`docs/capturas/store-final/interaction-results.json`).

## 12. Build y verificación

- `npm run build`: aprobado, incluye los módulos nuevos en `dist/store`.
- Siete advertencias previas de contenido/configuración de la landing PHYTOEMAGRY; no se inventó contenido para resolverlas.
- `node --check` y `git diff --check`: sin errores; Git avisa de normalización CRLF/LF en algunos archivos previamente editados.

## 13. Comparación visual

Capturas locales en `docs/capturas/store-shopping/`, excluidas de Git por la configuración local existente. Antes: siete anchos coincidentes; después: ocho, incluido 1024. Se inspeccionaron muestras renderizadas de los ocho anchos. La selección diaria puede variar al recrear la UAT; no se considera una comparación de píxeles idénticos de datos promocionales.

- [Inicio antes, 390](capturas/store-shopping/before-home-390.png) / [Inicio después, 390](capturas/store-shopping/after-home-390.png).
- [Categorías antes, 375](capturas/store-shopping/before-catalog-375.png) / [Categorías después, 375](capturas/store-shopping/after-catalog-375.png).
- [Ofertas antes, 360](capturas/store-shopping/before-offers-360.png) / [Ofertas después, 360](capturas/store-shopping/after-offers-360.png).
- [Sticky de Inicio, 390](capturas/store-shopping/after-home-scroll-390.png).
- [Masonry y sticky, 1024](capturas/store-shopping/after-catalog-scroll-1024.png).
- [Búsqueda, 375](capturas/store-shopping/after-search-375.png).
- [Carrito activo sólido, 390](capturas/store-shopping/after-cart-390.png).
- [Escritorio, 1440](capturas/store-shopping/after-catalog-1440.png).
- [Fin confirmado de 251 productos](capturas/store-shopping/after-feed-251-390.png).

## 14. Riesgos y UAT pendiente

1. Teléfono físico Android/iOS, Safari, áreas seguras, teclado virtual y lector de pantalla. Las comprobaciones táctiles actuales son emuladas en Chromium.
2. Instalación PWA y Google Sign-In reales con configuración del entorno final.
3. Rendimiento de sesiones de miles de tarjetas en dispositivos de poca memoria. No se añadió virtualización sin evidencia de necesidad; se validaron 251 tarjetas, lazy images y append incremental.
4. El offset es determinista, pero un catálogo modificado entre peticiones puede desplazar posiciones. Hay deduplicación y refresh; no se promete un snapshot transaccional de publicaciones en vivo.
5. Los snapshots de navegación son de memoria de la pestaña, no persistencia de scroll entre cierres del navegador.
6. Suite global fallida: requiere diagnóstico separado antes de recomendar producción.

## 15. GO / NO-GO

**GO para revisión local del alcance:** implementación completada, 107 pruebas específicas aprobadas, revisión responsive, paginación >200 y PWA/autenticación verificadas en navegador.

**NO-GO para afirmar preparación de producción:** suite global con 99 fallos y UAT física / OAuth real pendientes. No se desplegó ni se hicieron commits o push en esta tarea.
