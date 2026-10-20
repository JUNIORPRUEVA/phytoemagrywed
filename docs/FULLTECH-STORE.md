# FULLTECH Store — Fase 1

Tienda de clientes en `/store/`, separada de la PWA administrativa `/admin/`.
Usa el CRM actual y el catálogo `fulltech_catalog_v1`; no crea entidades de
producto, inventario, cliente o pedido duplicadas. La Fase 1 no procesa compras,
autenticación de clientes ni solicitudes reales.

## Publicación de artículos

La publicación es un acto deliberado. Todo artículo nuevo —producto o
servicio— nace oculto en FULLTECH Store y solo aparece cuando una persona
autorizada lo publica desde **Catálogo e inventario → un artículo → Catálogo /
Tienda**. La tabla aditiva `fulltech_store_publication_v1` conserva por separado
el estado de publicación, el orden y la marca de destacado, sin alterar los
registros de catálogo, pedidos, movimientos o cálculos.

Una vez publicado, la tienda lee siempre el registro vivo del catálogo: nombre
público, precio, imagen y disponibilidad se actualizan solos al editar el
artículo o al moverse el inventario. Retirar de la tienda o desactivar el
artículo (`active: false`) lo oculta de inmediato. Solo administración puede
publicar, retirar, destacar o archivar; el registro de la acción queda en
auditoría.

**Archivar** (`DELETE /api/admin/store/products/:id`) es la baja segura: el
artículo deja de venderse y desaparece del catálogo público y del buscador, pero
conserva su registro, su imagen, sus movimientos de inventario y las referencias
de pedidos, facturas y auditoría ya emitidos. No se borran filas físicamente.
Las presentaciones Phytoemagry no se archivan porque comparten el inventario de
cápsulas: se desactivan desde su ficha.

**Restaurar** (`POST /api/admin/store/products/:id/restore`) devuelve el artículo
con la misma identidad: mismo id, SKU, imagen y movimientos. Queda **inactivo y
sin publicar**, de modo que reaparece solo cuando administración lo activa y lo
publica expresamente. Solo ADMIN puede archivar o restaurar; ambos quedan en
auditoría (`store.product_archived`, `store.product_restored`). Los archivados se
listan en **Catálogo → Archivados** (`GET /api/admin/store/products?archived=1`).

## Cuentas de cliente

`fulltech_customer_accounts_v1` enlaza una cuenta con UN cliente del CRM. La
identidad fuerte sigue siendo el teléfono E.164:

- Cuenta nueva con un teléfono desconocido: se crea el cliente en el CRM
  (`source: tienda`) y la cuenta nace activa.
- Teléfono que ya tiene historial: la cuenta solo se vincula con **prueba de
  propiedad** (el número de un pedido de ese cliente). Sin prueba se rechaza con
  `verification_required`; nunca se expone el historial de otra persona.
- Un teléfono y un correo solo pueden pertenecer a una cuenta.

Las sesiones de cliente son propias: cookie `ft_store_session`, `HttpOnly`,
`SameSite=Lax`, 30 días, con token aleatorio guardado como hash en
`fulltech_customer_sessions_v1`. No comparten cookie ni permisos con el panel
administrativo (`pe_crm`). El panel muestra la cuenta dentro de la ficha del
cliente (`store_account`) y sus últimas solicitudes, solo en lectura.

### Acceso con Google y Apple

`PHYTO_GOOGLE_CLIENT_ID`, `PHYTO_GOOGLE_CLIENT_SECRET`, `PHYTO_APPLE_CLIENT_ID`,
`PHYTO_APPLE_TEAM_ID`, `PHYTO_APPLE_KEY_ID` y `PHYTO_APPLE_PRIVATE_KEY` activan
cada proveedor; sin credenciales el proveedor queda apagado y la tienda ofrece
teléfono y contraseña. El flujo usa `state` en cookie `ft_oauth_state` y valida
el `id_token` de Apple contra sus claves públicas. Si la identidad no se puede
enlazar con seguridad (sin correo verificado ni cliente conocido), la cuenta
queda `pending_link` y el cliente completa nombre y teléfono en
`/store/#/account/complete`; si ese teléfono ya tiene historial, se exige el
número de un pedido.

## Solicitudes «Lo conseguimos por ti»

`fulltech_store_requests_v1` guarda cada solicitud real enviada desde la tienda:

- Requiere sesión de cliente; se guarda con `customer_id` y `account_id`.
- `request_key` (idempotencia del formulario) evita duplicados por reintento y
  una solicitud idéntica del mismo cliente en 10 minutos devuelve la existente.
- Hasta tres fotos (comprimidas en el teléfono) en
  `fulltech_store_request_images_v1`, servidas solo al dueño o a administración.
- Estados: `nuevo`, `en_revision`, `cotizado`, `aprobado`, `en_proceso`,
  `completado`, `rechazado`, `cancelado`, con línea de tiempo visible al cliente.
- Administración (`/api/admin/store/requests`) cambia el estado y envía la
  cotización (monto, nota y validez); queda en auditoría.
- El cliente acepta o rechaza la cotización y eso cambia el estado; una segunda
  decisión se rechaza.

| Ruta pública | Resultado |
| --- | --- |
| `GET /api/store/account/providers` | Proveedores de acceso habilitados |
| `POST /api/store/account/register` \| `login` \| `logout` | Sesión de cliente |
| `GET`/`PATCH /api/store/account/me` | Cuenta, preferencias y contadores |
| `GET /api/store/account/orders` | Pedidos del cliente (sin costos) |
| `GET /api/store/account/requests` | Solicitudes del cliente |
| `POST /api/store/requests` | Crear solicitud (idempotente) |
| `GET /api/store/requests/:id` | Detalle con línea de tiempo |
| `GET /api/store/requests/:id/image/:n` | Foto (solo dueño) |
| `POST /api/store/requests/:id/decision` | Aceptar o rechazar cotización |

Las escrituras de la tienda rechazan peticiones de otro origen (CSRF) y las
rutas de administración siguen exigiendo sesión del panel y permisos.

La ficha separa la descripción interna del contenido opcional para la tienda:
nombre público, marca, descripción corta y descripción pública. Si se dejan en
blanco, se usa el nombre operativo y no se muestra descripción. El contenido
interno nunca se copia a la respuesta pública.

## API pública de solo lectura

Todas las rutas ignoran cookies administrativas y devuelven una proyección de
campos permitidos. No incluyen SKU, costo, proveedor, stock exacto, notas,
costos históricos ni metadatos de administración.

| Ruta | Resultado |
| --- | --- |
| `GET /api/store/home` | Categorías, hasta ocho productos (destacados primero), servicios y total de artículos publicados |
| `GET /api/store/catalog?q=&category=&kind=&featured=&page=&limit=` | Búsqueda, filtros y paginación; `kind` acepta `product`, `service` o `all`; `limit` máximo 48 |
| `GET /api/store/categories` | Categorías presentes en artículos publicados |
| `GET /api/store/products/:id` | Detalle público de un artículo publicado y activo |
| `GET /api/store/products/:id/image` | Imagen solo mientras el artículo siga publicado y activo |

Los términos de búsqueda se normalizan sin acentos y se buscan como prefijos de
tokens de nombre, SKU, categoría y descripción. Los tokens se guardan en
`fulltech_store_search_terms_v1`, con índice por token. La disponibilidad se
resume en `Disponible`, `Pocas unidades`, `Bajo pedido`, `Agotado` o `Consultar
disponibilidad`; nunca se publica el saldo exacto.

Las respuestas públicas tienen caché compartida de cinco segundos. El catálogo
se invalida en el proceso que recibe cambios de catálogo o publicación; los
cambios hechos en otra instancia se reflejan al vencer ese TTL. La PWA usa
red primero para el catálogo y conserva su última respuesta pública solo para
consulta offline. No hay compra posible desde esos datos.

## PWA y pantalla

- Manifest y service worker propios, ambos limitados a `/store/`.
- La PWA administrativa mantiene su scope `/admin/` y su caché existente.
- La tienda tiene shell independiente, tema claro/oscuro del dispositivo, área
  segura para móviles, búsqueda, categorías, detalle, compartir y drawer.
- La barra inferior solo aparece en inicio.
- Carrito, pedidos, cuentas y formularios son visibles como preparación, pero no
  envían información ni aparentan confirmar una compra.
- El catálogo público tiene pestañas **Todos**, **Productos** y **Servicios**, con
  búsqueda, filtro por categoría y paginación; la portada enlaza al catálogo completo.
- En el menú lateral del CRM, **Compartir → Tienda online** comparte el enlace
  directo `/store/` (hoja nativa en el móvil, copia en el escritorio y respaldo
  por WhatsApp).

## Servicios desplegados (EasyPanel)

El mismo artefacto sirve dos servicios del proyecto `ventas`:

| Servicio | Dominio | Uso |
| --- | --- | --- |
| `ventas_phytoemagrywed` | `https://phytoemagryrd.lat` | CRM completo y tienda en `/store/` |
| `ventas_fulltech-tienda-pwa` | `https://ventas-fulltech-tienda-pwa.gcdndd.easypanel.host` | Solo tienda pública, misma base de datos |

### Configuración del servicio de tienda en el panel

`ventas_fulltech-tienda-pwa` está dado de alta **dentro de EasyPanel** (proyecto
`ventas`), no solo como contenedor suelto:

- **Fuente:** imagen `easypanel/ventas/fulltech-tienda-pwa:latest`.
- **Build:** el `Dockerfile` de este repositorio (mismo artefacto que el CRM).
- **Dominio:** `ventas-fulltech-tienda-pwa.gcdndd.easypanel.host`, HTTPS con el
  certificado wildcard del panel, puerto interno `80`. La ruta de Traefik la
  genera EasyPanel (`https-ventas_fulltech-tienda-pwa-0`).
- **Redes:** `easypanel` y `easypanel-ventas` (Traefik resuelve por la primera).
- **Variables:** `PORT`, `APP_ENV`, `PHYTO_CRM_PORT`, `PHYTO_CRM_HOST`,
  `PHYTO_CRM_DATA`, `PHYTO_CRM_ENDPOINT`, `PHYTO_PUBLIC_URL`,
  `PHYTO_CRM_DATABASE_URL`, `PHYTO_CRM_TOKEN`, `PHYTO_CRM_NO_SCHEDULER=1`,
  `PHYTO_WHATSAPP_MOCK=1`, `PHYTO_WHATSAPP_NUMBER`, `PHYTO_META_PIXEL_ID`.

Comparte la base de datos del CRM. `PHYTO_CRM_NO_SCHEDULER=1` y
`PHYTO_WHATSAPP_MOCK=1` evitan duplicar tareas programadas y envíos de WhatsApp:
las notificaciones las manda solo el servicio del CRM.

### Publicar una versión nueva

1. Empaquetar el proyecto y subirlo: `scp store-build.tar.gz root@31.97.99.70:/root/`.
2. En el servidor: `/root/fulltech-store-rebuild.sh` (solo tienda) o
   `/root/fulltech-store-rebuild.sh /root/store-build.tar.gz ambos`.
3. El script etiqueta la imagen con la fecha y también como `:latest`, y
   actualiza el servicio en modo `start-first` (sin corte).

El botón **Deploy** de EasyPanel también sirve: la fuente apunta a `:latest`,
que es la etiqueta que deja el script.

**Precaución:** la fuente configurada en el panel para el CRM
(`ventas_phytoemagrywed`) sigue siendo el repositorio de GitHub en `main`.
Mientras `main` no incluya estos cambios de tienda, pulsar **Deploy** en ese
servicio rebuildaría desde GitHub y dejaría fuera cuentas, solicitudes y la
tienda pública. Antes de desplegar el CRM desde el panel hay que subir la rama
con el código nuevo.

- Sin fuente web adicional: usa fuentes del sistema y carga una sola respuesta
  inicial de portada. Las fotos se solicitan de forma diferida.

## Persistencia y rollback

La migración de esta fase solo crea dos tablas y dos índices aditivos; no cambia
DDL de artículos, pedidos, inventario o facturación. Crear índices y tablas es
idempotente al reiniciar. La tienda muestra únicamente los artículos publicados
de forma explícita en `fulltech_store_publication_v1`.

Para revertir antes de publicar: retirar el servicio de la tienda y deshacer el
código/rutas de Fase 1. Si ya hay artículos publicados, primero exportar el
estado editorial para conservarlo. Solo si se decide desechar ese estado, estas
sentencias revierten exclusivamente las estructuras nuevas:

```sql
DROP INDEX IF EXISTS fulltech_store_search_token_product_idx;
DROP TABLE IF EXISTS fulltech_store_search_terms_v1;
DROP INDEX IF EXISTS fulltech_store_publication_status_order_idx;
DROP TABLE IF EXISTS fulltech_store_publication_v1;
```

No se ejecutó esta migración en una base de producción.
