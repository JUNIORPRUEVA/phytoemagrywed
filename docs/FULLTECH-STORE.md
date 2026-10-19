# FULLTECH Store — Fase 1

Tienda de clientes en `/store/`, separada de la PWA administrativa `/admin/`.
Usa el CRM actual y el catálogo `fulltech_catalog_v1`; no crea entidades de
producto, inventario, cliente o pedido duplicadas. La Fase 1 no procesa compras,
autenticación de clientes ni solicitudes reales.

## Publicación de artículos

La tabla aditiva `fulltech_store_publication_v1` conserva por separado el estado
de publicación, el orden y la marca de destacado. Durante el arranque se agregan
los artículos existentes como `unpublished`, sin alterar sus registros de
catálogo, pedidos, movimientos o cálculos. Los artículos creados después también
quedan ocultos hasta publicarlos.

En el CRM, abre **Catálogo e inventario → un artículo → Catálogo / Tienda**. Solo
administración puede publicar o retirar un artículo. El registro de la acción
queda en auditoría. Un artículo inactivo se omite del catálogo público y no se
puede volver a publicar hasta activarlo para nuevas ventas.

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
| `GET /api/store/home` | Categorías, productos destacados (o productos disponibles si no hay destacados) y servicios, en una respuesta |
| `GET /api/store/catalog?q=&category=&kind=&featured=&page=&limit=` | Búsqueda, filtros y paginación; `limit` máximo 48 |
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
- Sin fuente web adicional: usa fuentes del sistema y carga una sola respuesta
  inicial de portada. Las fotos se solicitan de forma diferida.

## Persistencia y rollback

La migración de esta fase solo crea dos tablas y dos índices aditivos; no cambia
DDL de artículos, pedidos, inventario o facturación. Crear índices y tablas es
idempotente al reiniciar. La app permanece en modo público vacío hasta que una
persona autorizada publique algo.

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
