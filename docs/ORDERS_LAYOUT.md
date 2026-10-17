# Pedidos alineados desde arriba

Causa: el contenedor móvil compartía una rejilla de dos filas (`auto minmax(0,1fr)`) con otras pantallas, aunque Pedidos tiene filtros, contador, selección y lista como hijos separados. El contador ocupaba la fila flexible y dejaba un bloque vacío antes de los pedidos.

Corrección: columna flex para Pedidos hasta 979 px; filtros y contador de altura natural y lista flexible, alineada al inicio y con desplazamiento propio. Se conserva el espacio final para acceder al último pedido bajo los botones flotantes y el safe area inferior. No cambia el orden de los pedidos ni sus filtros o datos.

Validación: 91 pruebas de ventas/POS, Hoy, shell, arranque y service worker; compilación correcta. El diseño se contrastó con la estructura y la causa de la distribución CSS. Falta comprobación visual en el teléfono del usuario.
