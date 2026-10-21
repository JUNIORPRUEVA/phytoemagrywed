# Galería de productos — implementación y UAT

21/10/2026. CRM: http://127.0.0.1:8790/admin/. Tienda de prueba: http://127.0.0.1:8791/store/. El segundo puerto sirve el build local y reenvía el API exclusivamente al backend UAT de 8790. Producción, despliegues y push no se tocaron.

## Arquitectura y auditoría inicial

El catálogo guarda cada producto como documento JSON en `fulltech_catalog_v1`. Las imágenes ya se almacenaban como MIME/base64 en `fulltech_product_images_v1`, con una sola imagen identificada por el ID del producto. Las categorías comparten ese almacén. Las siete presentaciones históricas también pueden recuperar su imagen desde los recursos incluidos en el repositorio. La publicación se guarda separadamente en `fulltech_store_publication_v1`.

Antes de cambiar el servidor se creó un respaldo SQLite consistente de UAT y una instantánea del catálogo. Había nueve productos y dos publicaciones: las dos imágenes publicadas se descargaron y decodificaron correctamente. No se migró, borró ni retiró ningún producto histórico. La auditoría de producción no se realizó porque está fuera del alcance autorizado.

Se conservaron las modificaciones previas del formulario compacto, sus estilos y pruebas. Este trabajo amplía ese formulario y cambia expresamente la regla anterior que exigía foto al crear un producto.

## Modelo y compatibilidad

No hay DDL ni tablas o columnas nuevas. El documento del producto puede incluir `gallery: [{id, created_at}]`, con hasta tres entradas. El orden del array es el orden de presentación; la primera es la principal. La respuesta añade `images`, con URL, orden e indicador de principal, sin incluir binarios en el catálogo.

Si no existe `gallery`, se interpreta la imagen única anterior como la primera entrada. Un array vacío significa explícitamente cero imágenes. Se conserva `image_url`, la ruta `/image` y el envío antiguo `image` para clientes existentes. Editar sin `images` no reemplaza ni vacía las fotos. Enviar `images` expresa deliberadamente la nueva lista completa, validada con la versión del producto.

Las imágenes nuevas reciben identificadores inmutables y se guardan en la tabla existente. No se sobrescribe ni elimina la fila de una imagen anterior. Quitar una foto modifica las referencias activas: las rutas por ID comprueban que la imagen siga perteneciendo al producto. Los binarios retirados se conservan; no se ejecuta recolección destructiva. El endpoint administrativo `GET /api/admin/store/gallery-audit` informa publicaciones incompatibles y cantidad de imágenes retenidas sin referencia actual.

**Rollback:** conservar respaldo consistente de base y versión de código como pareja. Para revertir después de operar con galerías, respaldar/exportar primero los documentos y binarios nuevos. La versión antigua no entiende todos los IDs de galería: no se recomienda retroceder solo el binario. En UAT existe el respaldo previo en `.tmp/gallery-review/uat-before.sqlite`; no se restauró ni se borró trabajo posterior.

## Cambios funcionales

**CRM:** tres espacios compactos, principal identificada, contador 0/3–3/3, agregar, reemplazar, quitar, elegir principal y mover a la izquierda. Al completar tres desaparecen las opciones de agregar. Procesamiento de archivos secuencial, bloqueo durante preparación/guardado, mensajes de progreso y errores sin borrar el formulario ni las fotos anteriores. Cambiar tipo conserva las imágenes. La ficha muestra miniaturas seleccionables y el catálogo conserva una sola imagen principal.

**Tienda:** tarjetas con una sola imagen principal; galería completa en la ficha. Una imagen no muestra miniaturas vacías ni flechas. Dos o tres muestran sus miniaturas en el orden del CRM, selección destacada, navegación con flechas del teclado y gesto horizontal. El gesto se comprobó con entrada de puntero en viewport móvil. Las imágenes usan `object-fit: contain`, espacio reservado y carga ligera. Hay fallback de imagen dañada tanto en ficha como en tarjetas históricas, sin manejadores inline nuevos.

**Publicación, obligatoria en servidor:**

- Guardar oculto con cero imágenes: permitido.
- Publicar sin imagen: rechazado con mensaje claro.
- Publicar verifica que cada referencia exista y que sus píxeles puedan decodificarse.
- Quitar la última foto publicada: bloqueado en editor y API; primero hay que retirar la publicación.
- Una actualización de un artículo publicado también verifica sus imágenes. Una imagen histórica dañada debe repararse antes de guardar.
- Auditoría identifica problemas históricos sin retirar automáticamente publicaciones.
- Guardado y publicación usan transacción y el mismo bloqueo de fila: una carrera entre publicar y quitar fotos no deja un producto publicado sin imagen.

## Archivos

| Área | Archivos |
|---|---|
| Catálogo/API | `server/store-catalog.mjs`, `server/store-catalog-routes.mjs`, `server/store-public-routes.mjs` |
| CRM | `public/admin/store.js`, `product-editor.css`, `offline.js`, `index.html`, `sw.js` |
| Tienda | `public/store/product-gallery.js`, `product-gallery.css`, `store.js`, `index.html`, `sw.js` |
| Dependencia | `package.json`, `package-lock.json`: Sharp para decodificación, orientación y optimización |
| Pruebas | `tests/product-gallery.test.js`, `product-gallery-ui.test.js`, `store-panel.test.js`, `store-catalog.test.js`, `store-public-api.test.js`, `offline-24h.test.js` |
| Fixtures PNG válidos | `tests/pos.test.js`, `store-accounts.test.js` y fixtures compartidos en pruebas anteriores |

El PNG de prueba anterior tenía cabecera válida pero fallaba al decodificar sus píxeles. Se sustituyó por un PNG pequeño válido; no se relajó la validación para mantener esas pruebas.

## Almacenamiento, límites y fiabilidad

Se reutiliza SQL: SQLite vive en `/data/phytoemagry.sqlite` con el volumen `/data` declarado por Docker, o en PostgreSQL cuando está configurado. Las galerías no dependen del filesystem temporal del contenedor. No se cambiaron volúmenes, infraestructura ni almacenamiento de producción.

El editor admite JPG/PNG/WebP de hasta 12 MB para procesarlos localmente a un máximo de 1200 px y un payload compatible con 1 MB por imagen. El servidor limita el tamaño de entrada por imagen, decodifica con límite de 40 millones de píxeles y normaliza las imágenes nuevas de galería a WebP, hasta 1200 px, respetando orientación EXIF. No se guardan URLs externas arbitrarias como fotos válidas. Un archivo truncado o una operación parcial se rechazan y revierten dentro de la transacción.

El límite JSON del catálogo pasa de 1.5 a 4.5 MB para tres imágenes base64. El proxy nginx existente admite 110 MB para API: no se modificó. Sharp se añadió como dependencia de ejecución; el build Docker Alpine y PostgreSQL requieren todavía validación en sus entornos de prueba correspondientes.

**Sin conexión:** se mantienen los recorridos anteriores de consulta, producto sin cambios de galería y carga única antigua. Los cambios nuevos de galería/publicación exigen conexión, muestran error y no se encolan como éxito local. Esto evita IDs provisionales ambiguos y publicar sin verificar el archivo. El borrador permanece abierto. Las imágenes privadas no se consideran disponibles offline por el solo hecho de tener una URL en el catálogo.

## Evidencia y UAT real

Fixture nuevo: `QA-GAL-20261021`, producto `product_46ab8302-96ea-40f4-8152-c58d0624b0ae`. Las fotos son recursos del repositorio usados solo como medios de prueba, no corresponden al nombre comercial del fixture.

| Caso | Evidencia |
|---|---|
| Crear producto con cero fotos y guardarlo oculto | Realizado en navegador |
| Intentar publicar sin foto | Rechazo visible en navegador |
| Agregar una foto válida y publicar | Foto cargada por API local; publicación realizada en navegador |
| Una, dos y tres imágenes | Persistencia por API y visualización real en CRM/tienda |
| Cambiar principal y reordenar | Guardado desde el editor y mismo orden confirmado en tienda |
| Quitar secundarias y bloquear la última publicada | Realizado en navegador |
| Reemplazar principal, cuarta imagen, referencias ajenas, corrupción y concurrencia | Pruebas de API aprobadas |
| Miniaturas, teclado y gesto horizontal | Realizado en tienda, viewport móvil |
| Refresco y reinicio controlado | Tres IDs, orden y hashes SHA-256 idénticos después del reinicio |
| Productos anteriores | Los nueve registros originales conservan todos los campos de la instantánea; sin cambios de precio, stock o publicación |

CRM verificado a **360, 390, 430, 800 y 1280 px**, claro y oscuro: sin overflow horizontal y Guardar visible. La medición clara de los cinco tamaños está en [metricas-crm.json](../.tmp/gallery-review/metricas-crm.json); las oscuras en [metricas-crm-oscuro.json](../.tmp/gallery-review/metricas-crm-oscuro.json), más la captura oscura de 390 px. Tienda oscura verificada en los mismos cinco tamaños, con tres miniaturas y la imagen principal cargada: [metricas-tienda.json](../.tmp/gallery-review/metricas-tienda.json).

![Editor CRM oscuro a 390 px](../.tmp/gallery-review/crm-390-oscuro.jpg)

![Galería de tienda a 390 px](../.tmp/gallery-review/tienda-390-oscuro.jpg)

Otras capturas: [CRM claro](../.tmp/gallery-review/crm-360-claro.jpg), [tienda escritorio](../.tmp/gallery-review/tienda-1280-oscuro.jpg), [tarjetas de catálogo](../.tmp/gallery-review/tienda-catalogo.jpg). Los archivos de evidencia locales están ignorados por Git. Algunas capturas iniciales fallaron al usar dimensiones CSS con el zoom del navegador; las finales oscuras usan el tamaño físico correcto del viewport y verifican la anchura CSS real.

Resultado de conservación y reinicio: [final-verification.json](../.tmp/gallery-review/final-verification.json). Se restauró la apariencia automática del CRM. El ticket anterior 8271B permanece sin modificar. El fixture de galería queda publicado únicamente en la tienda local UAT para revisión.

## Pruebas automatizadas

Batería de 11 archivos: **179 aprobadas y 4 omitidas**, registrada en [regression.log](../.tmp/gallery-review/regression.log). Incluye galería, catálogo público/privado, POS, pedidos, cotizaciones, inventario, permisos, cuentas, SEO y operación sin conexión. Después se añadió y aprobó una prueba del fallback de tarjetas: la última ejecución específica tiene **5 pruebas de galería pública y 28 de panel aprobadas**; el servidor de galería tiene **12 aprobadas**.

Las cuatro omisiones se explican así:

- Una prueba opcional necesita PostgreSQL local de QA.
- Acceso a facturación desde chat: fallo previo `Timeout acciones` documentado en la tarea anterior.
- Dos pruebas offline (`prepara los módulos...`, `aísla rechazos históricos...`) fallaron en la ejecución amplia. Se reprodujeron con `offline.js` y `store.js` originales de HEAD: snapshot `auth` nulo y marca histórica ausente. No se modificó esa funcionalidad ni se presenta la suite completa como verde. La copia temporal de prueba se retiró.

El comando final filtra explícitamente esos tres nombres, además de la omisión PostgreSQL que realiza la propia suite. La prueba nueva que exige conexión para galerías/publicación pasó. Build local, comprobación sintáctica y `git diff --check`: aprobados. La landing mantiene siete avisos de contenido pendiente preexistentes.

## Pendientes y decisión

1. **Carga de archivo desde navegador:** la extensión bloquea `setFiles` por falta de «Allow access to file URLs». No se cambió el permiso. El editor abrió correctamente el selector múltiple, pero la transferencia real por ese recorrido queda pendiente. Las fotos UAT se cargaron por API y se editaron después en el navegador; no se afirma que esto sustituya la carga manual completa.
2. **Tienda clara:** sus colores usan los tokens existentes, pero el navegador de prueba está en preferencia oscura. La revisión automática bloqueó abrir `chrome://settings/appearance` porque el protocolo interno no está permitido. No se eludió ese bloqueo. El CRM sí se verificó en claro y oscuro mediante su propia configuración.
3. La carga lenta y la imagen rota tienen cobertura del estado de carga/fallback en pruebas automatizadas; no se simuló una red lenta real en navegador. El gesto se probó con puntero en viewport móvil, no en hardware Android/iOS.
4. No se construyó una imagen Docker ni se ejecutó la variante PostgreSQL. La persistencia SQLite del UAT real sí se comprobó tras reinicio. Antes de producción se debe auditar allí la compatibilidad de las publicaciones existentes, sin retirarlas automáticamente.

**GO para revisión funcional en UAT. NO-GO para producción** hasta cerrar la carga manual de archivos, la inspección clara de tienda y las comprobaciones de ejecución indicadas. No hubo despliegue ni push.
