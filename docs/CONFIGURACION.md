# Configuración del panel

Configuración ahora tiene una portada con filas, iconos y descripciones, y una pantalla independiente para cada opción. Las pantallas usan enlaces `#config/...`, admiten recarga y navegación atrás/adelante y conservan los controles existentes de negocio.

Opciones personales: Permisos, Notificaciones, Apariencia y La aplicación. Las opciones de negocio y datos solo se ofrecen a administración. El acceso al perfil queda en la primera fila; volver desde el perfil regresa a Configuración cuando se abrió desde ella.

La página Permisos permite solicitar notificaciones, ubicación, micrófono y cámara desde acciones explícitas. Consulta los permisos reales al entrar, al regresar a la app y al cambiar el estado del sistema. No solicita de nuevo los permisos concedidos, ni usa recuerdos locales para fingir que un permiso sigue concedido. Después de comprobar cámara o micrófono se detienen todas las pistas de captura.

La permanencia de cada permiso depende del navegador y del sistema operativo. Si el sistema concede «Solo esta vez», lo revoca o el usuario borra/reinstala la app, no puede garantizarse su permanencia desde JavaScript. Cuando Safari no permite consultar un permiso se muestra «Sin comprobar», no un estado concedido inventado.

Se habilita `camera=(self)` en la política del panel, junto con ubicación y micrófono. Se mantiene el bloqueo de cámara/micrófono en la configuración general de la landing. La pantalla no concede permisos por sí sola: el usuario sigue decidiendo en la solicitud del teléfono.

La hoja `public/admin/settings.css` se carga después del tema y usa sus variables para claro/oscuro. El service worker incluye la hoja nueva y una versión de caché actualizada.

Validación local: siete pruebas nuevas recorren las trece opciones, recarga, atrás/adelante, acceso de agentes, revocación, persistencia, cierre de captura, recuperación ante fallos y cabecera de permisos del servidor. Pasaron 69 pruebas en los siete archivos del conjunto relevante. Las doce pruebas de recordar preferencias/permisos pasaron además en su ejecución aislada; una aserción de borrado de notificaciones había fallado al ejecutarse con el conjunto en paralelo. `npm run verify:deploy` completó revisión y build, con avisos de contenido pendiente ya existentes.

Se revisó en navegador la lista, la pantalla de Permisos y el cambio de apariencia, incluyendo tamaño móvil y oscuro. Vista previa de pruebas: http://127.0.0.1:8792/admin/#config. El entorno usa SQLite de UAT y WhatsApp simulado; no envía notificaciones reales.

Los archivos de este cambio están en el workspace local, junto con otros cambios pendientes previos de panel, tema y persistencia. Esta iteración de Configuración no se ha desplegado en producción.

## Menú lateral y apariencia

El menú lateral presenta perfil, opciones agrupadas e iconos compactos, con desplazamiento independiente y controles de apariencia y cierre de sesión en el pie. El selector Claro/Oscuro/Sistema comparte la preferencia persistente de Apariencia. Cambiar el tema mantiene abierto el menú. La navegación por teclado contiene el foco en el menú, admite Escape y devuelve el foco al botón de apertura.

Se ajustaron las superficies, bordes, controles, textos y colores semánticos de ambos temas. En oscuro, los pedidos conservan colores diferenciados para pendiente, en camino, incidencia, entregado y cancelado, con texto legible. Se revisaron el menú en claro/oscuro, su geometría móvil y los colores calculados de los pedidos en el navegador.

Validación de esta iteración: 100 pruebas pasan en ocho archivos, incluyendo contraste mínimo 4,5:1 de los pares comprobados, teclado del menú, persistencia del tema, Configuración, perfil y notificaciones/service worker. `npm run verify:deploy` pasa con los siete avisos de contenido pendiente existentes. Los cambios del menú y tema siguen siendo locales.
