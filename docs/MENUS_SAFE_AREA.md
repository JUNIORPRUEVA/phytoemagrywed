# Menús y áreas seguras

La identidad visible del panel y el manifest es **FullTECH, SRL**. Se conservan los identificadores de instalación y las preferencias.

El menú de cada conversación muestra primero Abrir conversación y Crear pedido. Cliente reúne ficha, etapa y etiquetas; Seguimiento reúne tareas y mensajes programados. Asignación abre el selector existente de responsable, que conserva los permisos de cada rol. Archivar y selección múltiple quedan en Organizar conversación; Eliminar queda al final y conserva la confirmación anterior.

Las acciones DENTRO del chat (botón «Acciones») salen como cajón por la derecha, cuadrado y a todo el alto (`variant: 'chat-actions'`), sin subtítulos por fila y con las dos opciones de Seguimiento visibles como filas normales. Ese cajón necesita el `#sheet` en el selector porque la regla general de hojas de `menus-safe-area.css` recorta `max-height` en 12 px.

`organizeActionMenus` agrupa las listas simples de acciones al abrir una hoja: convierte los títulos en grupos con nombre accesible y presenta sus filas dentro de una tarjeta. No agrupa formularios ni contenedores complejos. Las operaciones conservan sus atributos y manejadores, y los submenús de cliente y seguimiento mantienen el contexto de la conversación.

`public/admin/menus-safe-area.css` centraliza las cuatro medidas mediante `env(safe-area-inset-*)`. Las usan cabeceras, barra inferior, compositor, botón de nuevo chat, filtros, drawer, entrada, presentación inicial, visor y ventanas. Las hojas limitan su altura y desplazan su contenido sin desplazar el cierre fuera de pantalla. En orientación horizontal, los popovers respetan los márgenes laterales sin repetir el relleno seguro dentro del panel.

Comprobaciones en navegador mediante un proxy local de UAT que sustituye únicamente los valores CSS de las áreas seguras (no se publica):

- Retrato 400 × 875 px, superior 47 e inferior 34: volver empieza en y≈53, el botón flotante termina en y=825 y el compositor tiene 40 px de relleno inferior (34 seguros + 6 de diseño). El ancho de página permanece en 400 px.
- Horizontal 850 × 400 px, laterales 44 e inferior 21: los controles de cabecera quedan dentro de x=54…796. La barra de Hoy usa relleno lateral de 48 px e inferior de 25 px; los botones terminan en y=375. Ancho de página: 850 px.
- El menú horizontal empieza en y≈16, termina en y≈363 y su cuerpo se desplaza manteniendo el cierre visible.

Validación: 126 pruebas pasan en diez archivos de shell, tema, configuración, push, contraste, preferencias, perfil y permisos. Cinco pruebas adicionales del menú de conversación pasan, incluyendo tres nuevas para agrupación, submenús y ausencia de efectos al abrirlos. `npm run verify:deploy` pasa con los siete avisos previos de contenido de la landing.

Siguen pendientes la comprobación en teléfonos físicos y el despliegue. La batería completa de conversaciones conserva los fallos previos de plantillas/envíos documentados en `CHAT_LAYOUT.md`; esta iteración valida de forma dirigida los menús afectados.
