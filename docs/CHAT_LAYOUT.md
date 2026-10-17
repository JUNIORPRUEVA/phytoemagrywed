# Navegación y distribución de chats

La barra inferior solo se muestra en Hoy. Sus cuatro destinos son Hoy, Chats, Pedidos y Clientes; cada celda puede encogerse dentro de la cuadrícula. La visibilidad se establece también mediante `hidden`, para retirar sus controles de la navegación por teclado en las demás pantallas.

`public/admin/navigation.css` elimina la reserva de altura de esa barra fuera de Hoy. En móvil, la bandeja tiene su propio desplazamiento vertical y el chat distribuye el alto disponible entre cabecera, hilo y compositor. Se mantiene el área segura del dispositivo. Los filtros cerrados tienen visibilidad oculta y no amplían el ancho de la página.

Por petición posterior del usuario, las acciones del cliente vuelven al botón flotante inferior original, con el mismo identificador y comportamiento. Flota 8 px sobre el compositor y el hilo reserva 64 px al final para que no tape el último mensaje. El margen derecho respeta el área segura. El título y subtítulo se ajustan al ancho entre los controles; la búsqueda sustituye la identidad sin dejar botones sueltos en otra fila.

Los campos de mensaje normal y de ventana cerrada declaran `lang="es-DO"`, `spellcheck="true"` y capitalización de frases. Además, la app incorpora ahora un corrector propio con diccionario es-DO y revisión en un Worker, descrito en `CORRECTOR.md`. No se ha conectado un servicio externo de revisión o reescritura.

La restauración del botón y las indicaciones de idioma pasan las 52 pruebas seleccionadas de shell, permisos y preferencias, junto con `npm run verify:deploy`. En navegador se comprobó que el botón está en `.wa__fab-row`, 8 px sobre el compositor, y que el campo declara el idioma y revisión ortográfica anteriores.

En escritorio se retira la cabecera general que se superponía a la cabecera del chat y se añade un botón Volver a Hoy junto al buscador de la bandeja.

## Escritorio: piel de WhatsApp Web (≥ 980 px)

La vista de ordenador se ha vuelto una copia de WhatsApp Web sin tocar el móvil. Todo vive en `public/admin/wa-desktop.css`, que se carga después de `wa-lista.css` y cuyas reglas están **todas** dentro de `@media (min-width: 980px)`: por debajo de esa medida no se aplica ninguna, así que la pantalla del teléfono queda exactamente como estaba.

- **Armazón**: el panel va de borde a borde (sin el relleno de 12 px ni las esquinas redondeadas), dos columnas de `clamp(340px, 27vw, 430px)` y el resto para el hilo.
- **Bandeja**: cabecera gris `#f0f2f5` con «Chats» (se pinta con `::before` sobre `.wa__list-head`) y el botón Volver; buscador en píldora blanca con lupa; filtros en **una sola fila** que se desliza (los grupos no se parten) y las utilidades (avisos, sonido, fecha) al final, separadas por una línea. Solo se desplaza la lista: cabecera y filtros quedan fijos. Filas de 72 px con avatar de 49 px y separador desde 78 px.
- **Conversación**: cabecera de 60 px sobre el mismo gris, con la foto del cliente siempre visible (el `hidden` del móvil se anula solo en escritorio), nombre de 16 px y meta de 13 px; iconos en círculos de 40 px. El papel tapizado es PROPIO (hojas, burbujas y estrellas dibujadas en un SVG en línea, blanco al 35 % sobre `#efeae2`), no el de WhatsApp.
- **Burbujas**: 8 px de radio, entrantes blancas y salientes verde claro `#d9fdd3`, colita del mismo color con `clip-path` y la hora abajo a la derecha (11 px). El nombre del autor se oculta en los mensajes normales, como en un chat de una persona; se conserva en los avisos del sistema. Audio, documento y ubicación pierden la tarjeta doble: el contenido va dentro de la burbuja.
- **Compositor**: barra `#f0f2f5`, campo redondeado de 44 px y botón circular verde `#00a884` para el micrófono/envío.
- **Sin conversación**: marca de la casa centrada sobre el mismo papel, con el mensaje de siempre.
- **Tema oscuro**: `#0b141a` de papel, `#111b21` de panel, `#202c33` en barras y burbujas entrantes, `#005c4b` en las salientes. Como `shell-v2-tema.css` trae reglas oscuras muy específicas para el chat viejo, al final de `wa-desktop.css` se vuelven a fijar esas superficies con más peso.
- Se añaden barras de desplazamiento finas y se mantienen las áreas de toque de 40–44 px.

Medido en el navegador a 1440 × 900 px: panel de 1425 × 900, bandeja de 389 px, cabecera de lista de 102 px, filtros de 50 px (una fila), filas de 72 px con avatar de 49 px, cabecera de chat de 60 px, burbuja de 14,2 px / 19 px con radio 8 px, compositor de 62 px y campo de 44 px. En 390 × 844 px se comprobó que el móvil conserva la burbuja de 16 px, el compositor de 61 px con micrófono azul de 48 px y el avatar oculto: `wa-desktop.css` no aplica.

## Validación local

- 119 pruebas pasan en nueve archivos de shell, tema, configuración, preferencias, contraste, perfil y push/service worker. El caso nuevo recorre los destinos de la barra y comprueba que se oculta y regresa al volver a Hoy.
- Tras los ajustes finales de HTML/CSS se repitieron shell y tema: 43 pruebas pasan. `npm run verify:deploy` pasa con los siete avisos de contenido ya existentes.
- Medidas del navegador en 320 × 550 px: ancho del documento y de la barra de Hoy de 320 px; los cuatro botones caben dentro. El compositor del chat termina en y=550, igual que la pantalla. Se comprobó además a 400 × 875 px y en escritorio.
- Se comprobó abrir/cerrar la búsqueda y el menú de acciones desde la nueva cabecera.

La revisión ampliada de `panel-conv-list-uat.test.js` da 25 pruebas correctas y 13 fallos sobre ventanas, plantillas y envío. Al reconstruir el HTML con las acciones en su posición anterior y sin la nueva hoja de distribución se repiten esos 13 fallos. Una comprobación aislada con la lógica anterior de visibilidad de la barra también reproduce el timeout de NEW_CONTACT. Entre las diferencias aparecen la plantilla esperada `phyto_followup_checkin` frente a `phyto_mensaje_personalizado_v1` y rechazos por número de parámetros. Se conserva esa lógica de negocio para resolverla por separado. También existe una aserción antigua de texto en `panel-whatsapp.test.js` que busca «Nada se envía solo.», texto que el panel actual ya no contiene.

Los cambios siguen siendo locales, sin despliegue. Vista previa UAT: http://127.0.0.1:8792/admin/?v=whatsapp.
