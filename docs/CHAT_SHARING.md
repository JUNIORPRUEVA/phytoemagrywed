# Opciones para compartir desde el chat

Administración configura los datos en **Configuración → Opciones para compartir** (`#config/compartir`). El equipo los consulta desde **+ → Ubicación / Cuentas bancarias / Catálogo**. Imagen y Audio conservan sus flujos anteriores. Bancos, enlaces y ubicaciones no dependen del almacén multimedia.

## Configuración persistente

- Hasta diez ubicaciones del negocio con nombre, dirección, latitud y longitud. Se puede pedir la ubicación del dispositivo desde un clic explícito y previsualizar el punto en un mapa. No se solicita geolocalización al abrir la pantalla.
- Hasta diez cuentas con banco, titular, número, tipo, moneda (DOP/USD/EUR) y nota opcional. Los números se guardan como texto, conservando ceros iniciales y separadores. Se elige la alternativa de texto ordenado solicitada por el usuario; no se genera una imagen de las cuentas.
- Hasta diez catálogos con nombre, enlace HTTPS y texto de presentación. Al agregar el primero se propone Phytoemagry con su URL pública como valor editable. Se pueden agregar otras webs; no se inventa la URL del segundo negocio.

Agregar, quitar o editar no persiste hasta pulsar **Guardar opciones para compartir**. El formulario guarda y hace una lectura nueva del servidor antes de confirmar. Una inicialización repetida no duplica los botones ni las filas. Los repintados de la misma pantalla no recargan el formulario ni borran lo que se está editando.

Los datos viven en `settings.chat_sharing`, compartidos por el equipo y persistentes entre visitas y reinicios. No se cargaron cuentas ficticias ni coordenadas del negocio en el ambiente local del usuario; debe introducir sus datos reales.

## Uso desde el botón +

**Cuentas bancarias:** cada tarjeta ofrece Copiar número y Usar esta cuenta. Si hay varias, Usar todas las cuentas prepara un solo mensaje con bloques legibles. Copiar funciona dentro de la app; si falla el portapapeles, se abre un campo seleccionable. WhatsApp recibe texto normal, sin prometer botones nativos de copia en el teléfono del destinatario.

**Catálogo:** se elige una web, se ve su texto y enlace, se puede abrir la página y después pulsar Usar este catálogo. El enlace seleccionado se incorpora al compositor.

Los textos se agregan al borrador existente, sin borrarlo, y se dejan listos para revisar y pulsar Enviar. Esto conserva el envío habitual, el corrector, su confirmación y las reglas del servidor. Si exceden 4.000 caracteres, se pide compartir por separado. Cambiar de conversación impide aplicar al nuevo chat una selección de la anterior.

**Ubicación:** se elige un punto del negocio, se previsualiza y se pulsa Enviar ubicación para enviar un mapa nativo por la ruta existente. Elegir otra ubicación mantiene el selector previo de ubicaciones del cliente, GPS del dispositivo y coordenadas manuales. Las reglas de permisos, asignación, no contactar, ventana de WhatsApp y confirmación permanecen en el servidor.

Las ubicaciones del negocio se guardan como referencias globales sin cliente asociado. Enviarlas reutiliza esa referencia y no las convierte en domicilios del destinatario. Guardar un punto sin cambios reutiliza la referencia; modificarlo crea una nueva, conservando intactos los puntos de mensajes anteriores.

## Rutas y fuentes

- `GET /api/admin/chat-sharing`: requiere sesión y `chats.reply`.
- `POST /api/admin/settings/chat-sharing`: requiere sesión, origen permitido y `settings.manage`.
- El mapa se envía mediante `/api/admin/conversations/:id/location` con la referencia global y confirmación explícita.

Fuentes: `server/chat-sharing.mjs`, integración en `server/crm-server.mjs`, menú y previsualización en `public/admin/app.js`, formulario en `public/admin/chat-sharing-settings.js`, estilos en `public/admin/chat-sharing.css`. Se incluyeron los recursos en la caché del SW `crm-v102-sharing-pages`.

## Validación

91 pruebas pasan en siete archivos: 15 UAT de compartir, 13 de ubicación, 10 de multimedia, 7 de configuración, 29 del shell, 9 de privacidad del SW y 8 de push. Cubren persistencia tras reinicio, edición inmutable de puntos, permisos/CSRF, URLs y coordenadas inválidas, ceros iniciales, copiar, preparar una/todas las cuentas, selección de dos webs, previsualización, envío nativo confirmado, agregar/eliminar cuentas y geolocalización solo con clic. La prueba antigua de multimedia se adaptó para entrar explícitamente en Configuración → Multimedia antes de revisar envíos ambiguos.

`npm run verify:deploy` completa con los siete avisos previos de contenido de la landing. El formulario se inspeccionó visualmente en Chrome local; falta comprobar en teléfonos físicos. Los envíos de la batería son simulados. Los cambios siguen locales, sin despliegue.

Acceso local: http://127.0.0.1:8792/admin/?v=ajustes#config/compartir.

## Navegación y selección de lugares

Compartir muestra una lista de tres destinos. Cada categoría tiene su ruta (`#config/compartir-ubicaciones`, `#config/compartir-bancos`, `#config/compartir-catalogos`) y Volver regresa a Compartir. Las categorías ocultas no bloquean la validación del formulario; guardar conserva los otros grupos.

Seleccionar en el mapa abre Leaflet con OpenStreetMap: tocar el lugar o arrastrar el marcador y pulsar Usar esta ubicación. Cancelar conserva las coordenadas anteriores. Guardar persiste el punto confirmado. El GPS se solicita únicamente al pulsar Usar mi ubicación actual. El mapa requiere conexión para cargar sus imágenes.

En móvil, el appbar superior es el único lugar con botón de regreso: desde un chat vuelve a la lista y desde la lista a Hoy. El encabezado del contacto no repite la flecha ni el safe area superior.
