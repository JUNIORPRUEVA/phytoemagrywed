# FULLTECH — ajustes de descubrimiento, UAT local

Alcance autorizado: conservar el diseño existente y modificar únicamente la agrupación superior, buscador fijo, dos imágenes pequeñas en publicidad, acciones compactas de carrito y presentación clara. No añadir márgenes laterales a la columna principal móvil.

- Buscador, publicidad, beneficios y categorías agrupados en un bloque sin margen lateral exterior.
- La publicidad conserva el azul, los textos y la identidad existentes; usa dos imágenes disponibles en la tienda.
- Al desplazarse, únicamente el buscador permanece fijo arriba; el logo y el resto del bloque salen de la vista.
- Lupa de 29 px blanca sobre una superficie negra.
- Acciones de agregar de 44 × 44 px en las tarjetas de inicio y catálogo, con nombre accesible.
- Carrito flotante oculto cuando está vacío, visible al agregar y oculto al eliminar el último producto.
- Carrito separado del aviso flotante de solicitud para permitir pulsarlo durante el desplazamiento.
- Fondo claro independiente de la preferencia de color del dispositivo; navegación móvil al ancho completo.

Validación: `node scripts/check-store-discovery.mjs`, Chromium real, anchos 360, 390, 430, 768 y 1280 px, preferencias de color clara y oscura. Diez escenarios aprobados: imágenes cargadas, sin desbordamiento, buscador fijo incluso después de salir de la tarjeta, controles compactos y flujo agregar/abrir/quitar del carrito. Capturas de inicio y desplazamiento en `docs/capturas/store-discovery/`.

Resultado: GO en UAT local (`http://127.0.0.1:8898/store/`). Sin commit, push ni despliegue. Sin cambios en precios, pedidos, checkout ni datos del catálogo.

## Refinamientos posteriores solicitados

- Logo de 132 px, buscador de 40 px con lupa blanca a la derecha sobre negro; retirada la sombra/contenedor decorativo del buscador.
- Imágenes de publicidad escalonadas en diagonal, con la superior próxima al extremo derecho; texto de marca repetido sustituido por «Encuentra tu próximo favorito».
- Acceso al perfil en el extremo derecho del AppBar. En la navegación inferior, «Lo conseguimos» abre la solicitud existente.
- Invitación «Crea tu cuenta» encima del navbar solo para visitantes, oculta en páginas de cuenta, solicitud y checkout. No interfiere con el carrito ni el aviso flotante de solicitud.
- Tarjetas de inicio y catálogo con imagen, categoría, título, extracto de hasta 84 caracteres, precio destacado y disponibilidad real; se conservan los botones compactos de agregar.
- Chromium: diez escenarios de tamaño/preferencia de color aprobados, navegación de perfil y solicitud validada. La ocultación del aviso para una cuenta autenticada se verificó simulando únicamente la respuesta de sesión en el navegador de pruebas.

## Iconos y separación publicitaria

- Archivos proporcionados copiados sin alterar: `lupa-grande.png` → `public/store/assets/icons/custom/search-large.png`; `buscar.png` → `public/store/assets/icons/custom/find-for-you.png`. Se emplean como máscaras para conservar sus formas y adaptar el color a cada control.
- Publicidad: imágenes separadas verticalmente y desplazadas hacia extremos opuestos, sin superposición.
- Registro: «¿Aún no tienes cuenta? Regístrate ahora», acción azul destacada, superficie clara y brillo suave limitado a dos ciclos, desactivado con reducción de movimiento.
- Diez escenarios Chromium aprobados, incluyendo separación de imágenes, ausencia de desbordamiento, iconos correctos y espacio entre invitación y navbar. Se conserva la validación del carrito y la supresión del registro para clientes autenticados.
