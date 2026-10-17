# Carrito de facturación

La lista muestra una cantidad compacta por artículo. Al pulsarla (o pulsar su nombre), se abre un editor con cantidad manual, botones de incremento y decremento, descuento fijo o porcentual y total de la línea. Los cambios solo se aplican al confirmar. Quitar un artículo requiere confirmación.

El menú de acciones sustituye «Guardar ticket» por «Agregar nota». La nota se conserva con el ticket y se envía con la venta, pedido o cotización. La gestión de tickets y «Guardar pedido» permanecen disponibles.

La integración conserva los cambios de PDF, uso sin conexión, navegación y chat, incluida la finalización de conversaciones, el compositor móvil y los descartes de notificaciones por usuario.

Validación de la versión integrada:

- 18 archivos de pruebas: 204 aprobadas y 1 omitida.
- 2 casos adicionales del carrito: cancelación/validación sin alterar importes y recuperación de notas al cambiar de ticket; las 14 pruebas del panel POS pasan.
- `npm run verify:deploy` aprobado, con avisos de contenido preexistentes.

La comprobación visual en un teléfono físico queda pendiente; las pruebas del panel usan JSDOM.
