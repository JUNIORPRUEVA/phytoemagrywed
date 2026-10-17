# Iconos del encabezado del chat

Se adaptaron los PNG aportados por el usuario (`viber.png` y `lupa (3).png`) a 96 × 96 px con transparencia y remuestreo bicúbico. Se usan como máscaras CSS para respetar los colores de ambos temas, con glifos de 20–21 px y botones de 44 × 44 px. Se mantienen las etiquetas accesibles y los manejadores existentes de llamada y búsqueda. El botón de llamada conserva las reglas de disponibilidad del servicio.

Peso original conjunto: 19.206 bytes. Peso publicado conjunto: 4.115 bytes (reducción aproximada del 79 %). Recursos: `public/admin/assets/icons/chat-call.png` y `chat-search.png`, precargados por el worker `crm-v109-chat-header-icons`.

La implementación parte de main con la corrección de arranque móvil, preservando el trabajo pendiente de otras sesiones.

## Corrección de ubicación y visibilidad

El encabezado del cliente coloca primero búsqueda y después llamada a la derecha. Usa los PNG como imágenes reales de 22 px, con filtro inverso en oscuro, para que sigan siendo reconocibles sin soporte de máscaras CSS. Se corrigió el símbolo telefónico antiguo que permanecía en el HTML. Al abrir búsqueda se ocultan ambas acciones para dejar solo los controles de esa búsqueda.

El teléfono permanece visible cuando hay contexto de conversación. Solo se habilita si el servicio confirma disponibilidad, conservando todas las comprobaciones de permisos y consentimiento del cliente. La ausencia del servicio lo deshabilita y muestra un título explicativo. Las pruebas comprueban orden, imágenes, visibilidad, no iniciar audio automáticamente y los flujos de llamadas.
