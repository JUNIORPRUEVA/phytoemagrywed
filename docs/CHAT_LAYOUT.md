# Navegación y distribución de chats

La barra inferior solo se muestra en Hoy. Sus cuatro destinos son Hoy, Chats, Pedidos y Clientes; cada celda puede encogerse dentro de la cuadrícula. La visibilidad se establece también mediante `hidden`, para retirar sus controles de la navegación por teclado en las demás pantallas.

`public/admin/navigation.css` elimina la reserva de altura de esa barra fuera de Hoy. En móvil, la bandeja tiene su propio desplazamiento vertical y el chat distribuye el alto disponible entre cabecera, hilo y compositor. Se mantiene el área segura del dispositivo. Los filtros cerrados tienen visibilidad oculta y no amplían el ancho de la página.

Las acciones del cliente pasan del botón flotante inferior a los tres puntos de la cabecera, con el mismo identificador y comportamiento. Ya no hace falta el relleno inferior para ese botón dentro del hilo. El título y subtítulo se ajustan al ancho entre los controles; la búsqueda sustituye la identidad sin dejar botones sueltos en otra fila.

En escritorio se retira la cabecera general que se superponía a la cabecera del chat y se añade un botón Volver a Hoy junto al buscador de la bandeja.

## Validación local

- 119 pruebas pasan en nueve archivos de shell, tema, configuración, preferencias, contraste, perfil y push/service worker. El caso nuevo recorre los destinos de la barra y comprueba que se oculta y regresa al volver a Hoy.
- Tras los ajustes finales de HTML/CSS se repitieron shell y tema: 43 pruebas pasan. `npm run verify:deploy` pasa con los siete avisos de contenido ya existentes.
- Medidas del navegador en 320 × 550 px: ancho del documento y de la barra de Hoy de 320 px; los cuatro botones caben dentro. El compositor del chat termina en y=550, igual que la pantalla. Se comprobó además a 400 × 875 px y en escritorio.
- Se comprobó abrir/cerrar la búsqueda y el menú de acciones desde la nueva cabecera.

La revisión ampliada de `panel-conv-list-uat.test.js` da 25 pruebas correctas y 13 fallos sobre ventanas, plantillas y envío. Al reconstruir el HTML con las acciones en su posición anterior y sin la nueva hoja de distribución se repiten esos 13 fallos. Una comprobación aislada con la lógica anterior de visibilidad de la barra también reproduce el timeout de NEW_CONTACT. Entre las diferencias aparecen la plantilla esperada `phyto_followup_checkin` frente a `phyto_mensaje_personalizado_v1` y rechazos por número de parámetros. Se conserva esa lógica de negocio para resolverla por separado. También existe una aserción antigua de texto en `panel-whatsapp.test.js` que busca «Nada se envía solo.», texto que el panel actual ya no contiene.

Los cambios siguen siendo locales, sin despliegue. Vista previa UAT: http://127.0.0.1:8792/admin/?v=whatsapp.
