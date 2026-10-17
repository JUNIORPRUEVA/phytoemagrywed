# Catálogo e inventario Fulltech

Implementación en la rama `feat/fulltech-pos`, dentro del worktree `FULLTECH-pos`.
La carpeta original de trabajo conserva sus cambios. El commit `dd98ef6`
conserva la base de interfaz Fulltech que ya existía antes de este módulo.
Esta entrega es local; todavía no se fusionó con `main` ni se desplegó.

## Uso

En el menú lateral, abrir **Catálogo e inventario**:

- **Productos y servicios**: artículos agrupados por categoría, con filtros,
  búsqueda y vistas de lista o cuadrícula. El botón flotante **+** agrega un
  artículo. Cada tarjeta abre una página de detalle con enlace propio y edición.
  En el formulario se puede elegir una categoría existente o escribir una nueva.
  Cada producto tiene imagen, descripción,
  precio de venta, costo unitario, cantidad inicial y stock mínimo. Los
  servicios tienen precio y costo, con imagen opcional y sin existencias.
- **Inventario**: consultar existencias, valor a costo, stock bajo, entradas,
  salidas y los últimos 200 movimientos de productos nuevos. Cada movimiento
  conserva fecha, responsable, motivo y saldo.
- **Recuento**: registrar la cantidad física de un producto. Si alguien cambia
  su stock mientras se cuenta, el servidor exige actualizar antes de guardar.

Administración puede crear, editar, archivar y ajustar inventario. Los agentes
consultan artículos y crean ventas, sin recibir costos internos en estas API.
Archivar retira el artículo de nuevas ventas y conserva sus pedidos e historial.

Las ventas se crean desde **Chat** o **Pedidos**, no desde el catálogo. Al abrir
el formulario se consulta el catálogo vigente, conservando el soporte de
borradores offline. La venta utiliza el flujo existente: cliente identificado por
teléfono, varios artículos, descuento, pago y estado. Se pueden mezclar
productos, servicios y Phytoemagry en el mismo pedido. Las existencias se
descuentan al completar/entregar la venta; los pendientes no reservan stock.
Cancelar una venta completada devuelve sus existencias. Editarla ajusta la
diferencia y conserva el costo histórico de las líneas existentes.

## Phytoemagry y la identidad del negocio

Las siete presentaciones siguen disponibles. Comparten el inventario anterior
por cápsulas: no son siete almacenes independientes. Desde Inventario se abre
**Gestionar cápsulas**, y desde Recuento, **Contar cápsulas**. Los ajustes y
movimientos de ese inventario siguen en su página original. El resumen de
valoración cuenta ese saldo una sola vez.

La interfaz utiliza Fulltech y los comprobantes del CRM muestran Fulltech.
La página pública comercial de Phytoemagry mantiene su catálogo estático y sus
precios anteriores: editar el catálogo interno no publica precios en esa web.
Los servicios no generan seguimientos por consumo de cápsulas.

Este cambio no modifica el nombre público del número en Meta, las plantillas
aprobadas ni crea un catálogo de Commerce Manager. La sincronización con
Facebook/WhatsApp y el cambio del perfil comercial son trabajos adicionales.
El mismo CRM puede gestionar el catálogo general y los pedidos de Phytoemagry.

## Persistencia y controles

- Requiere SQLite o PostgreSQL; el almacenamiento JSONL conserva el flujo
  anterior y devuelve catálogo no disponible para este módulo.
- Tablas aditivas: `fulltech_catalog_v1`, `fulltech_product_images_v1` y
  `fulltech_stock_movements_v1`. Los identificadores históricos se conservan.
- SKU único, cantidades enteras no negativas, versiones para detectar ediciones
  obsoletas y claves de operación para evitar duplicar movimientos manuales.
- Precios/costos se guardan en centavos. En PostgreSQL, las columnas antiguas
  `unit_price` y `total` enteras se amplían a `numeric(14,2)` al iniciar. La
  migración conserva los importes existentes; antes de desplegar se debe
  respaldar la base, como en cualquier actualización de esquema.
- Las ventas y ajustes de productos nuevos usan transacciones y bloqueos de
  filas en PostgreSQL. Una cola local evita ventas simultáneas de la última
  unidad dentro del proceso. El inventario histórico por cápsulas conserva su
  servicio; en PostgreSQL sus escrituras no comparten la misma conexión de la
  transacción del catálogo. No se ha certificado recuperación ante fallos de
  proceso para pedidos mixtos entre varias instancias.
- Imágenes JPG, PNG o WebP: el navegador reduce a 1200 px y convierte a JPG.
  El servidor verifica formato y tamaño máximo de 1 MB. Se guardan en SQL y
  se sirven con sesión autenticada; no requieren R2. No se admiten SVG.
- Las operaciones de stock requieren conexión; no entran en la cola offline.
- El catálogo se actualiza por eventos SSE tras guardar productos, movimientos
  o ventas. No tiene botón de actualización manual. Hay una consulta de respaldo
  cada cinco segundos para reconexiones o cambios en otras instancias. Al
  ocultar la pestaña o salir del módulo se cierran las conexiones. La búsqueda,
  el foco y los borradores de recuento se conservan; un cambio de stock no altera
  la cantidad base contra la que se validará un conteo ya iniciado.

## Verificación

- 82 pruebas aprobadas y una exclusiva de PostgreSQL omitida en la ejecución
  SQLite: catálogo, panel, inventario, ventas, conversaciones y atribución.
- 15 pruebas aprobadas contra PostgreSQL 17 real en una base local desechable;
  incluyen migración desde columnas de importes enteros, persistencia,
  concurrencia por la última unidad, ventas con centavos y eventos SSE.
- `npm run verify:deploy`: aprobado. Advierte configuraciones comerciales
  ausentes en este worktree local, que no contiene el `.env` de producción.
- Revisión de navegador: submenú, imágenes existentes, tema claro y oscuro,
  creación de servicio y presencia en el selector de venta, entrada de mercancía
  y recuento físico con vista previa de la diferencia. La automatización
  no permitió adjuntar un archivo local; la recepción/persistencia de imágenes
  sí se comprobó mediante las pruebas HTTP de integración.
- Revisión del rediseño: lista, cuadrícula, ficha con URL propia, botón flotante
  y medidas móviles sin desbordamiento horizontal en el detalle. Se comprobó
  en navegador la actualización de una ficha tras modificarla desde otra sesión.
- Se repitieron las pruebas de interfaz de ventas: 21 pasan y los cuatro fallos
  coinciden con los fallos previos registrados en la base de comparación.
- La batería general detectó 31 fallos previos de WhatsApp/interfaz/reparto.
  Se reprodujeron los mismos 31 en el commit base `dd98ef6`. Dos expectativas
  de mensajes se actualizaron por el nuevo nombre explícito de las
  presentaciones; las pruebas de conversaciones pasan.
- La copia temporal de comparación `FULLTECH-pos-baseline` quedó conservada:
  la revisión automática bloqueó su eliminación sin indicar otro motivo.
  El contenedor PostgreSQL desechable de las pruebas sí quedó detenido.

## Vista local

```powershell
cd C:\Users\pc\DEV\PROYECTOS\INTERNO\FULLTECH-pos
node scripts/uat-env.mjs --port=8817 --sin-scheduler
```

Abrir `http://127.0.0.1:8817/admin/?v=catalogo` con `admin@uat.local` y la
contraseña de pruebas que imprime el script. Usa datos separados en
`data/uat/`, WhatsApp simulado y sin conversiones Meta ni notificaciones reales.
No copiar esos datos a producción.
