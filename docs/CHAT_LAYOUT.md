# Navegación y distribución de chats

La barra inferior solo se muestra en Hoy. Sus cuatro destinos son Hoy, Chats, Pedidos y Clientes; cada celda puede encogerse dentro de la cuadrícula. La visibilidad se establece también mediante `hidden`, para retirar sus controles de la navegación por teclado en las demás pantallas.

`public/admin/navigation.css` elimina la reserva de altura de esa barra fuera de Hoy. En móvil, la bandeja tiene su propio desplazamiento vertical y el chat distribuye el alto disponible entre cabecera, hilo y compositor. Se mantiene el área segura del dispositivo. Los filtros cerrados tienen visibilidad oculta y no amplían el ancho de la página.

Por petición posterior del usuario, las acciones del cliente vuelven al botón flotante inferior original, con el mismo identificador y comportamiento. Flota 8 px sobre el compositor y el hilo reserva 64 px al final para que no tape el último mensaje. El margen derecho respeta el área segura. El título y subtítulo se ajustan al ancho entre los controles; la búsqueda sustituye la identidad sin dejar botones sueltos en otra fila.

Los campos de mensaje normal y de ventana cerrada declaran `lang="es-DO"`, `spellcheck="true"` y capitalización de frases. Además, la app incorpora ahora un corrector propio con diccionario es-DO y revisión en un Worker, descrito en `CORRECTOR.md`. No se ha conectado un servicio externo de revisión o reescritura.

La restauración del botón y las indicaciones de idioma pasan las 52 pruebas seleccionadas de shell, permisos y preferencias, junto con `npm run verify:deploy`. En navegador se comprobó que el botón está en `.wa__fab-row`, 8 px sobre el compositor, y que el campo declara el idioma y revisión ortográfica anteriores.

En escritorio se retira la cabecera general que se superponía a la cabecera del chat y se añade un botón Volver a Hoy junto al buscador de la bandeja.

## Validación local

- 119 pruebas pasan en nueve archivos de shell, tema, configuración, preferencias, contraste, perfil y push/service worker. El caso nuevo recorre los destinos de la barra y comprueba que se oculta y regresa al volver a Hoy.
- Tras los ajustes finales de HTML/CSS se repitieron shell y tema: 43 pruebas pasan. `npm run verify:deploy` pasa con los siete avisos de contenido ya existentes.
- Medidas del navegador en 320 × 550 px: ancho del documento y de la barra de Hoy de 320 px; los cuatro botones caben dentro. El compositor del chat termina en y=550, igual que la pantalla. Se comprobó además a 400 × 875 px y en escritorio.
- Se comprobó abrir/cerrar la búsqueda y el menú de acciones desde la nueva cabecera.

La revisión ampliada de `panel-conv-list-uat.test.js` da 25 pruebas correctas y 13 fallos sobre ventanas, plantillas y envío. Al reconstruir el HTML con las acciones en su posición anterior y sin la nueva hoja de distribución se repiten esos 13 fallos. Una comprobación aislada con la lógica anterior de visibilidad de la barra también reproduce el timeout de NEW_CONTACT. Entre las diferencias aparecen la plantilla esperada `phyto_followup_checkin` frente a `phyto_mensaje_personalizado_v1` y rechazos por número de parámetros. Se conserva esa lógica de negocio para resolverla por separado. También existe una aserción antigua de texto en `panel-whatsapp.test.js` que busca «Nada se envía solo.», texto que el panel actual ya no contiene.

Los cambios siguen siendo locales, sin despliegue. Vista previa UAT: http://127.0.0.1:8792/admin/?v=whatsapp.

## Lista de chats con el aspecto de WhatsApp (2026-10-17)

La bandeja se rediseñó para que se vea como la lista de chats de WhatsApp. La piel vive en
`public/admin/wa-lista.css`, que se carga **la última** y solo actúa sobre `body[data-tab='whatsapp']`;
el resto del panel no cambia.

- **Filas de 72 px de lado a lado**, sin tarjetas ni bordes redondeados. Separador de 1 px que empieza
  donde termina el avatar (78 px), para que el texto quede alineado.
- **Avatar redondo de 49 px** a la izquierda: la foto del cliente si la tiene y, si no, sus iniciales
  sobre un color fijo por cliente (`waAvatarTone()` en `app.js`, suma del id: siempre el mismo color).
  Al seleccionar, el visto tapa el avatar, como en WhatsApp.
- **Dos líneas**: nombre (16,5 px) y hora arriba; último mensaje (14 px) y contador de no leídos abajo.
  La hora usa el formato de WhatsApp: la hora si es de hoy, «Ayer», el día de la semana dentro de la
  semana y `dd/mm/aaaa` para lo antiguo.
- **Contador verde** de 20 px de alto; en la fila no se pintan las etiquetas de gestión (asignación,
  etapa, pedido): siguen en el DOM y en el menú «⋯», pero no ocupan línea.
- **Barra superior** blanca (gris oscuro en tema oscuro) con el título **«WhatsApp»** e iconos de buscar
  y filtrar.
- **Selección de conversaciones**: al elegir una fila (pulsación larga o menú «⋯» → Seleccionar varias)
  se despliega un **panel lateral derecho que flota por encima de la lista**, con velo detrás. Lleva
  icono grande (26 px), nombre y explicación corta por acción: Más acciones de la conversación,
  Seleccionar todas, Marcar como leídas, Archivar, Eliminar chats y Mensaje a varios. La cabecera (con
  «WhatsApp») y los filtros **no se ocultan**: el panel se abre encima. El velo cierra el panel **sin
  borrar la selección** (queda una píldora verde «Acciones N» para reabrirlo); la ✕ cancela la
  selección.
- **Botón flotante** redondo y verde con el icono de chat, en la esquina.
- En escritorio, la columna lleva título «WhatsApp», buscador en píldora y filtros en una sola fila
  deslizable; el «⋯» de cada fila solo aparece al pasar el ratón o al enfocar.

Comprobado en navegador a 430×900, 360×640, 320×568, 1280×800 y en tema oscuro: filas de 72 px, sin
desbordes horizontales, y abrir conversación, volver y la pulsación larga (selección) siguen igual.

### Foto del cliente (por qué a veces se ven iniciales)

La fila usa la foto del cliente **si la tiene guardada** (`photo_url`); si no, pinta sus iniciales sobre
un color fijo. WhatsApp **no entrega la foto de perfil de los contactos por su API** (verificado: el
webhook solo trae el nombre y no existe endpoint de foto de contacto), así que la foto la sube el equipo:

- En la lista: menú «⋯» de la conversación → **Poner foto / Cambiar foto**.
- En el chat: el avatar de la cabecera lleva una pestaña de cámara cuando no hay foto; al tocarlo se abre
  la ficha, donde está **Poner foto** (o **Cambiar foto** / **Quitar foto** si ya la tiene).
- La imagen se reduce a 192 px antes de guardarse y se ve en la lista, en la cabecera del chat y en la ficha.

### Compositor desajustado (corregido el 2026-10-17)

El compositor salía partido: el «+»/«Plantilla» arriba del texto, el campo a media anchura y el botón
redondo suelto. Eran **dos fallos de CSS**, no de `app.js`:

1. `navigation.css` tenía **una llave `}` sin cerrar** en la regla de `#wa-back` con la búsqueda abierta.
   Con la llave suelta, el navegador interpreta el resto como reglas anidadas de esa regla y **deja de
   aplicar todo lo que viene después** (todo el compositor, los iconos de la cabecera y el layout de
   Pedidos). Se cerró la llave y se añadió una prueba (`composer-mobile.test.js`) que vigila que las
   hojas del chat tengan las llaves equilibradas.
2. `composer-mobile.css` pedía **tres columnas** (`auto 1fr auto`) al `.composer-bar`, pero el marcado
   actual mete el «+»/«Plantilla» y el textarea dentro de `.composer-field` (dos hijos). Ahora pide
   **dos columnas** (`minmax(0,1fr) auto`) y el campo se queda con todo el ancho libre.

Comprobado a 390×844 en claro y oscuro: ventana abierta (adjuntar · texto · micro/enviar) y ventana
cerrada (Plantilla · texto · enviar), vacío y con texto, sin solapamientos. El corrector vuelve a
mostrar su caja de sugerencias encima del campo.



