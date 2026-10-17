# Recuperación del arranque móvil

Diagnóstico del servidor (17 de octubre de 2026): servicio saludable; HTTPS /admin/ y /api/health responden 200. Sesión y datos responden 200 en milisegundos; sin errores en los últimos 500 renglones de registros revisados. Entorno de base de datos y clave del CRM coinciden con el respaldo anterior. No se reinició ni modificó la base de datos para diagnosticar.

Fallos reproducidos y corregidos:
- El worker devolvía index.html para un JS/CSS ausente al fallar la red. Ahora reserva ese respaldo a navegaciones y recupera el recurso base cuando la URL contiene ?v.
- Rechaza respuestas HTML recibidas como JS/CSS y conserva la copia válida.
- Una instalación con archivos esenciales ausentes falla sin activar el worker ni eliminar la caché anterior.
- Lecturas de localStorage bloqueado interrumpían el script antes de mostrar la entrada. Ahora se manejan sin bloquear el inicio.
- La consulta de sesión carecía de límite de espera. Ahora deja de bloquear el inicio a los ocho segundos.
- Una pantalla de recuperación permite recargar ante errores del arranque, conservando almacenamiento y operaciones pendientes.

No se dispone de acceso a las pantallas físicas de los teléfonos; estos fallos son reproducibles en pruebas y cubren causas de bloqueo, pero requieren confirmación del usuario tras actualizar en sus dispositivos. La conexión de navegador de automatización no estaba disponible durante esta revisión.

Pruebas específicas: mobile-startup, sw-privacy, sw-push y panel-settings. La prueba antigua de pedidos offline contiene dos fallos de flujo en el estado integrado con POS; no se modificó ese flujo para esta corrección.
