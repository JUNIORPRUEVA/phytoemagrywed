# FULLTECH — favoritos de cliente y publicidad, UAT local

## Cambios autorizados

- Acceso «Regístrate con Google» encima del navbar, próximo al extremo derecho y oculto para clientes autenticados.
- Publicidad: imágenes mayores, separadas 16 px verticalmente; la inferior se desplaza más a la izquierda. Las imágenes rellenan el contenedor con `object-fit: cover`.
- Controles de favoritos sobre las imágenes de las tarjetas de inicio, catálogo y lista de favoritos.
- «Mis favoritos» en el drawer, catálogo privado que permite comprar o quitar productos guardados.
- Invitados: al seleccionar un favorito deben crear una cuenta o iniciar sesión. La selección pendiente se conserva en la pestaña y se guarda después de completar el acceso desde esa pantalla.

## Persistencia y protección

Tabla aditiva `fulltech_customer_favorites_v1`, clave `(account_id, product_id)`. No se alteran precios, pedidos, inventario ni el catálogo existente. Las rutas de lectura, alta y eliminación exigen una sesión de cliente; una sesión administrativa no es suficiente. Se usa la identidad de sesión, sin aceptar identificadores de cuentas del navegador. Escrituras protegidas por la comprobación existente de origen.

- `GET /api/store/account/favorites`: IDs y productos públicos guardados.
- `GET /api/store/account/favorites?ids=1`: estado compacto para los controles de las tarjetas.
- `POST /api/store/account/favorites/:productId`: guardar un producto publicado, de forma idempotente.
- `DELETE /api/store/account/favorites/:productId`: quitar únicamente de la cuenta actual.
- Productos retirados dejan de mostrarse, sin revelar campos internos ni borrar su selección guardada.

## Validación

`npx vitest run tests/store-favorites.test.js tests/store-accounts.test.js tests/store-public-api.test.js`: 19 pruebas aprobadas, incluyendo aislamiento entre cuentas, invitados/administradores rechazados, origen externo rechazado, persistencia tras reinicio, duplicados y archivo de productos.

`node --experimental-sqlite scripts/check-store-favorites.mjs`: Chromium a 360, 390, 430 y 1280 px; imágenes separadas y con cobertura, acceso de registro a la derecha, sin desbordamiento. Recorrido real de inicio de sesión, selección pendiente, persistencia al recargar, drawer, catálogo privado de favoritos, agregar al carrito y eliminar favorito aprobado. La prueba de cuentas utiliza SQLite desechable, proveedores externos apagados y archivos estáticos de la tienda local. Capturas en `docs/capturas/store-favorites/`.

## Límite de Google

En esta UAT, `/api/store/account/providers` devuelve `google: false`. El acceso «Regístrate con Google» conduce a la pantalla de registro existente; solo apunta al inicio OAuth cuando el servidor informa que Google está configurado. No se activaron credenciales ni se simuló un acceso real a Google.

Resultado: GO para favoritos y presentación en UAT; acceso real mediante Google pendiente de configuración del proveedor. Sin commit, push ni despliegue. Se preservaron los cambios existentes en el workspace.
