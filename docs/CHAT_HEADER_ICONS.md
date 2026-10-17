# Iconos del encabezado del chat

Se adaptaron los PNG aportados por el usuario (`viber.png` y `lupa (3).png`) a 96 × 96 px con transparencia y remuestreo bicúbico. Se usan como máscaras CSS para respetar los colores de ambos temas, con glifos de 20–21 px y botones de 44 × 44 px. Se mantienen las etiquetas accesibles y los manejadores existentes de llamada y búsqueda. El botón de llamada conserva las reglas de disponibilidad del servicio.

Peso original conjunto: 19.206 bytes. Peso publicado conjunto: 4.115 bytes (reducción aproximada del 79 %). Recursos: `public/admin/assets/icons/chat-call.png` y `chat-search.png`, precargados por el worker `crm-v109-chat-header-icons`.

La implementación parte de main con la corrección de arranque móvil, preservando el trabajo pendiente de otras sesiones.
