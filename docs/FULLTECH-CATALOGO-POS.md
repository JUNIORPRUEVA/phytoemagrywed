# Catálogo e inventario Fulltech

Implementación en la rama `feat/fulltech-pos`, dentro del worktree `FULLTECH-pos`.
La carpeta original de trabajo conserva sus cambios. El commit `dd98ef6`
conserva la base de interfaz Fulltech que ya existía antes de este módulo.
Esta entrega es local; todavía no se fusionó con `main` ni se desplegó.

## Uso

En el menú lateral, abrir **Catálogo e inventario**:

- **Productos y servicios**: listado continuo de artículos, sin grupos ni contadores de categoría, con filtros,
  búsqueda y vistas de lista o cuadrícula. El título aparece solo en el appbar;
  la barra de búsqueda permanece fija e integra el botón que abre los filtros en un drawer derecho. Solo se desplaza el listado, que conserva su posición ante actualizaciones en vivo.
  Allí se eligen categoría, producto/servicio y vista. El botón flotante **+**,
  situado abajo y respetando el área segura, agrega un
  artículo. Cada tarjeta abre una página de detalle con enlace propio y edición.
  En el formulario se puede elegir una categoría existente o usar **+** para
  crear otra con nombre e imagen opcional, sin perder los campos del producto.
  Cada producto tiene imagen, descripción,
  precio de venta, costo unitario, cantidad inicial y stock mínimo. Los
  servicios tienen precio y costo, con imagen opcional y sin existencias.
- **Ajuste de stock**: seleccionar producto, entrada o salida, cantidad y motivo.
  Una comparación muestra saldo actual, ajuste y resultado. Las existencias
  y los últimos 200 movimientos quedan plegados debajo. Cada movimiento
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
por cápsulas: no son siete almacenes independientes. Desde Ajuste de stock se
abre **Gestionar**, y desde Recuento, **Contar cápsulas**. Los ajustes y
movimientos de ese inventario siguen en su página original.

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
- Tablas aditivas: `fulltech_catalog_v1`, `fulltech_product_images_v1`,
  `fulltech_stock_movements_v1` y `fulltech_categories_v1`. Los identificadores
  históricos se conservan. Las categorías existentes se importan sin borrar
  productos; las nuevas se enlazan por ID y tienen nombre único normalizado.
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

- 87 pruebas aprobadas y una exclusiva de PostgreSQL omitida en la ejecución
  SQLite: catálogo, panel, inventario, ventas, conversaciones y atribución.
- 16 pruebas aprobadas contra PostgreSQL 17 real en una base local desechable;
  incluyen migración desde columnas de importes enteros, persistencia,
  concurrencia por la última unidad, ventas con centavos, eventos SSE y
  categorías con imagen que persisten tras reiniciar.
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
- Revisión compacta en móvil: buscador único, filtros laterales, formulario de
  categoría dentro del artículo conservando nombre/precio, Ajuste de stock y
  Recuento. El appbar vuelve del detalle al catálogo con un toque, y otro toque
  sale al inicio. Volver ya consume la entrada del detalle en lugar de crear
  una nueva entrada de catálogo en el historial.
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

Abrir `http://fulltech-pos.localhost:8817/admin/?v=catalogo` con `admin@uat.local` y la
contraseña de pruebas que imprime el script. Usa datos separados en
`data/uat/`, WhatsApp simulado y sin conversiones Meta ni notificaciones reales.
No copiar esos datos a producción.

El host de prueba independiente evita compartir la cookie con otros CRM locales
que estén abiertos en `127.0.0.1` o `localhost` con puertos distintos.

Se comprobó en navegador a 390 × 700 px y en escritorio que el listado
se desplaza dentro de su panel, conservando fija la búsqueda; las tarjetas
utilizan un contorno tenue de medio píxel sin sombra elevada.

## Facturación, cotizaciones y pedidos (16/10/2026)

El catálogo es ahora **Facturación** en el appbar. Se conserva la aplicación
web existente; el documento de referencia menciona Flutter, pero no se ha
introducido otro framework ni una segunda aplicación.

- Imagen: abre la ficha. Nombre, precio o `+`: agregan al carrito. Un indicador
  discreto muestra cuántas unidades se agregaron.
- En móvil, el carrito enseña una línea compacta y se expande tocando o
  deslizando su asa. En escritorio ocupa una columna lateral. La búsqueda y
  el resumen permanecen fijos mientras se desplazan los artículos.
- Cantidades, eliminación, descuento por línea y descuento general admiten
  monto fijo o porcentaje. El monto fijo de una línea descuenta el conjunto de
  sus unidades. Los cálculos comparten un módulo de centavos entre servidor y
  navegador; el servidor verifica precios, cliente, conversación e inventario.
- La ganancia estimada excluye el envío y solo se presenta al rol ADMIN. Los
  agentes no reciben costos ni ganancias en las respuestas de cotizaciones.
- **Cotizar** pide confirmación y guarda un documento independiente. No crea
  ventas, no reserva stock y no dispara seguimientos ni conversiones Meta.
  El icono de documento junto al cliente permite consultar, imprimir/guardar
  PDF y reutilizar cotizaciones. Al convertirlas se verifican precios actuales.
- **Guardar pedido** vive entre las opciones del carrito expandido. Guarda un
  pedido pendiente, sin registrar pago ni descontar inventario. Después puede
  continuarse la entrega mediante el circuito existente de asignación.
- **Cobrar** confirma efectivo o transferencia, importe recibido y entrega.
  Muestra cambio para efectivo; transferencia requiere el importe exacto. Se
  registra una venta entregada en el circuito existente de inventario/reportes.
  No se realiza captura de dinero con un banco o procesador de tarjetas.
- Los accesos para crear pedidos desde Chats, Clientes y Pedidos llegan al POS
  con cliente/conversación y ubicación conocida. Si se cambia de cliente con
  artículos en el carrito se confirma la reasignación. Si el cliente tiene
  pedidos abiertos se exige confirmar que se trata de un pedido nuevo.
- La edición y operación de pedidos ya guardados conserva las herramientas
  existentes. Se mantienen precios históricos y descuentos por línea al editar.
- Los comprobantes son **comerciales**. Esta implementación no incorpora NCF,
  e-CF ni una integración fiscal. El PDF existente ahora pagina pedidos largos
  y muestra descuentos por línea.

Persistencia: nueva colección `pos_documents` en el mismo backend SQL; su DDL
se crea al iniciar. Cada operación tiene una clave persistente. Repetirla
reutiliza su resultado; cambiar los datos con la misma clave se rechaza. Una
cotización solo puede convertirse una vez. Las reclamaciones son únicas en
base de datos, también entre instancias. Si una operación queda incompleta,
se recupera el resultado cuando el pedido está guardado y finalizado; en los
demás casos se pide revisar Pedidos antes de cobrar otra vez. No se reproduce
automáticamente una operación de resultado incierto.

El carrito se conserva en sessionStorage por usuario, sin costos ni ganancias,
y se limpia al cerrar sesión. Guardar/cobrar requiere conexión. Los ajustes
en vivo no reconstruyen el carrito si no cambió el catálogo.

Validación de esta etapa:

- 121 pruebas aprobadas en POS, catálogo, inventario/reportes, ventas y
  conversaciones; una prueba de concurrencia se reserva para PostgreSQL.
- PostgreSQL local aislado: 29 pruebas aprobadas, incluidas cotizaciones,
  checkout, permisos, persistencia y concurrencia del catálogo.
- UAT del panel adaptada al nuevo flujo: 21 aprobadas; conserva los mismos
  cuatro fallos previos de filtros/acciones de Pedidos documentados arriba.
- Verificación de contenido y compilación aprobadas. No se declara verde la
  batería completa del repositorio.
- Revisión en navegador móvil de 390 × 780: selección de cliente, carrito,
  resumen, confirmación y guardado de cotización, recuperación y conversión a
  cobro en efectivo con comprobante. Entorno con datos simulados.

Todo permanece en `feat/fulltech-pos`, en el worktree separado. No se ha
fusionado con principal ni desplegado a producción en esta etapa.

## Appbar, tickets y página de cotizaciones

- La lupa del appbar sustituye título/atrás por el buscador existente y su
  filtro. Cerrar búsqueda recupera la cabecera, conservando búsqueda/filtros;
  una marca en la lupa indica que siguen activos. La animación respeta la
  preferencia de movimiento reducido. El aviso de actualización reserva su
  altura para no tapar la cabecera.
- La selección de cliente muestra únicamente «Selecciona cliente» o su nombre.
- El botón flotante abre **Acciones**: nuevo ticket, guardar, lista de tickets,
  venta fuera de inventario y, para administración, alta de artículo y stock.
- Los tickets son borradores persistentes en `fulltech_pos_tickets_v1`, con
  propietario y versión. Cambiar de ticket guarda la venta actual. Los tickets
  abiertos se guardan automáticamente al modificarlos; se pueden renombrar y
  descartar. No reservan ni descuentan inventario. Un cambio simultáneo devuelve
  conflicto en lugar de sobrescribir datos. Facturar el mismo ticket reutiliza
  su operación aunque cambie la clave enviada por el navegador.
- La venta fuera de inventario admite descripción, tipo producto/servicio,
  cantidad, precio y costo unitarios. Sus líneas conservan costos/descuentos
  históricos, participan en reportes y comprobantes y no crean artículos ni
  movimientos. Los costos permanecen ocultos al consultar documentos como
  agente, incluso dentro del borrador de un ticket.
- **Cotizaciones** tiene entrada propia en Catálogo e inventario, buscador y
  detalle. Generar una cotización lleva a ese detalle y muestra una notificación
  con acceso al documento. «Pasar a ticket» recupera sus líneas y cliente para
  facturar posteriormente; cada cotización conserva un único ticket de origen
  y una única operación de conversión.
- El documento ofrece PDF real, impresión, compartir archivo, WhatsApp y
  acceso a crear ticket. Compartir usa el diálogo del dispositivo cuando admite
  archivos. Si el navegador no lo permite, descarga el PDF y explica que debe
  adjuntarse al chat abierto con WhatsApp. No envía automáticamente por la API
  de Meta ni comparte un enlace privado del CRM con el cliente.
- Validación actual: 129 pruebas aprobadas y una reservada para PostgreSQL en
  las suites de POS/catálogo/ventas/inventario/conversaciones. PostgreSQL aislado:
  35 aprobadas; se repitieron las 19 de POS tras los últimos ajustes. La UAT
  general de ventas mantiene 21 aprobadas y los cuatro fallos previos descritos.
  Contenido y compilación aprobados. La vista local continúa en el puerto 8817.

## Drawers por gestos y tickets en la cabecera

- El flotante abre un drawer derecho de altura completa y aproximadamente
  media pantalla móvil. Orden: Venta rápida fuera de inventario, Nuevo ticket,
  Guardar ticket y, para admin, Agregar stock y Nuevo producto/servicio.
- Cliente y **Tickets** comparten una fila fija encima del catálogo. El nombre
  del cliente se trunca si es largo; el acceso a tickets siempre queda visible.
- La lista de tickets muestra nombre, cliente, cantidad e importe. Cada ticket
  editable tiene tres puntos con Editar ticket y Eliminar ticket. Editar permite
  cambiar el nombre o continuar modificando productos/cliente en facturación.
  Eliminar pide confirmación y retira el borrador de los pendientes conservando
  su historial. Estas acciones no aparecen en el drawer de ventas.
- En móvil, un gesto horizontal iniciado en los primeros 20 px del borde
  izquierdo abre el menú principal; desde el borde derecho abre Acciones en
  Facturación. Los gestos verticales, centrales, sobre formularios y durante
  operaciones no abren menús. Se puede cerrar el drawer deslizando en el sentido
  contrario, tocando fuera, con Cerrar o Escape. Los dos drawers son excluyentes.
- Se conservan los diálogos nativos para foco/teclado y la preferencia de
  movimiento reducido. Los menús de tres puntos también admiten flechas/Escape.
- Validación de esta etapa: 46 pruebas aprobadas de interfaz POS, integración
  comercial y catálogo; incluye gestos sintéticos, navegación al menú principal,
  edición y eliminación desde los tres puntos. Revisión visual en navegador a
  390 × 780 y compilación aprobada. No se ha ensayado con un teléfono físico.

### Ajuste de ancho y navegación de Facturación

- Catálogo y resumen aprovechan el ancho con 4 px de margen lateral. La lista
  conserva el desplazamiento táctil y por rueda, sin barra de scroll visible.
- Título centrado y botones de regresar, búsqueda y acciones con fondo cuadrado
  de esquinas discretas. Acciones abre el mismo drawer que el botón flotante.
- Regresar sale con un toque aunque el carrito esté expandido, conservando el
  ticket. Ya no consume el primer toque para contraerlo.
- El menú principal muestra «Inventario», cerrado al abrir el drawer. Su panel
  y el filtro tienen bordes rectos; nombre y rol del usuario usan una cabecera
  más compacta y una tipografía más ligera.
- Validación: 46 pruebas aprobadas, incluyendo regreso con carrito expandido,
  conservación del cliente/ticket, acciones desde la cabecera y menú cerrado.
  Compilación y revisión visual a 390 × 780 y 1280 × 800 aprobadas; en móvil se
  verificaron 4 px de margen, título centrado y ausencia de desborde horizontal.


## Integración para producción (16/10/2026)

- Se integra la rama completa `feat/fulltech-pos` (hasta `99254b5`) con la
  actualización de marca/chat/configuración de `main` (`bfff36d`). Esta última
  ya contiene y amplía la base Fulltech `dd98ef6`; se aplica el delta POS desde
  esa base para conservar ambas líneas de trabajo. El commit de integración
  conserva los dos padres y no elimina los cambios recientes de `main`.
- El worktree original se conserva en `preserve/local-work-before-fulltech-release`;
  `main` se prepara en `FULLTECH-release` para no sobrescribir trabajo local.
- Se corrige el empaquetado Docker del módulo compartido `pos-math.js`, necesario
  para que el API pueda arrancar en la imagen final. Service worker:
  `crm-v105-fulltech-pos`.
- Antes del despliegue se conserva la imagen anterior y un dump PostgreSQL 17
  con manifiesto validado en `/root/backups/fulltech-pos-20261016` del servidor.
  El dump y la configuración privada del servicio no se versionan.
- Validación de la combinación: 185 pruebas críticas aprobadas (POS, catálogo,
  llamadas, chat compartido, corrector e imagen Docker), 35 aprobadas contra
  PostgreSQL local aislado, compilación aprobada y revisión móvil a 390 × 780.
  La suite completa no se declara verde: se contrasta con la base para registrar
  expectativas antiguas de interfaz que todavía apuntan al formulario anterior.
