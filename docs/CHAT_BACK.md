# Flecha de regreso en la conversación

En móvil (hasta 979 px), el encabezado del contacto muestra `#wa-back`, con área de toque de 40 × 44 px. El botón existente vuelve a la lista de conversaciones. La barra general `#mobile-header` se oculta mientras se muestra el chat, evitando dos encabezados y flechas duplicadas. Se conserva el safe area superior y lateral. Los iconos de llamada/búsqueda y el compositor circular permanecen.

Prueba funcional: `chat-sharing-uat` pulsa la flecha del contacto, comprueba la vuelta a la lista en la misma sección y vuelve a abrir el hilo.
