# Aislamiento de catálogos — FULLTECH Store ↔ Phytoemagry

Fecha: 2026-10-23 · Entorno: UAT local (`data/uat/phyto-uat.sqlite`). **Sin deploy, sin push.**

## 1. Causa raíz

Había **un solo catálogo para todo el negocio** y ningún campo que dijera a quién pertenece cada artículo:

| Pieza | Estado encontrado |
| --- | --- |
| Tabla de artículos | `fulltech_catalog_v1` (fila con `doc` JSON + `quantity`). Sin campo de tienda. |
| Categorías | `fulltech_categories_v1`, `category_key` **único por nombre**: dos tiendas no podían tener una categoría con el mismo nombre. |
| Publicación | `fulltech_store_publication_v1` (`status`, `featured`, `sort_order`), por artículo y **global**. |
| Inyección de Phyto | `createStoreCatalog()` inserta las 7 presentaciones `PHYTO-*` de `product.config.js` en el MISMO catálogo, con `category: 'Phytoemagry'` y `legacy: true`. |
| API pública | `publicProducts()` devolvía **todo lo publicado**, sin filtrar dueño. De ahí salían portada, catálogo, categorías, buscador, ofertas diarias, sitemap y fichas. |
| Frontend | `/store/` es una sola SPA; no filtra nada (ni debe: el filtro va en el backend). |

**Por qué se mezclaban:** al publicar cualquiera de los 7 `PHYTO-*` desde el panel, entraba al escaparate de FULLTECH con su categoría «Phytoemagry». No había ningún punto del backend donde se preguntara «¿de qué tienda es esto?».

**Nota de auditoría:** no existe un segundo escaparate en este repositorio (la landing `/` de Phytoemagry es otra pieza, sin catálogo). El aislamiento se implementó igualmente por **dueño del artículo**, de modo que una tienda Phytoemagry (otra instalación con `PHYTO_STORE_KEY=phytoemagry`) muestre solo lo suyo sin tocar código.

## 2. Corrección implementada

### Modelo (aditivo, no destructivo)
- Cada artículo lleva `store` (`fulltech` | `phytoemagry`) dentro de su `doc`. No se borra ni se reescribe nada más.
- Cada categoría lleva `store`; las nuevas usan clave `<tienda>:<nombre>`, así que **«Accesorios» puede existir en ambas tiendas**. Las claves históricas se siguen leyendo si su dueño coincide.
- `storeOfProduct()` centraliza la verdad: campo explícito o, en registros históricos, la evidencia `legacy: true` → `phytoemagry`; el resto → `fulltech`.

### Backend (filtro obligatorio en servidor)
- `createStoreCatalog({ storeKey })` fija el **contexto de tienda al arrancar** desde `PHYTO_STORE_KEY` (por defecto `fulltech`). Los endpoints ignoran `?store=`, cabeceras y cookies: no hay forma de pedir el catálogo ajeno.
- `publicProducts()` descarta todo artículo cuyo dueño no sea la tienda activa → arrastra portada, catálogo, categorías, ofertas, novedades, destacados, buscador, sitemap y `#/product/:id`.
- `publicImage()` devuelve 404 para imágenes de otra tienda (ni con la URL exacta).
- `publicOrderItems()` (checkout) se apoya en el mismo catálogo: comprar un artículo de la otra tienda es imposible.
- Rutas SEO: un artículo de otra tienda responde **404** (no 410, para no revelar que existe).
- Admin: el catálogo sigue siendo **compartido** (facturación intacta) y ahora expone `store`, `storeKey` y `stores`. Un artículo no puede colgarse de la categoría de otra tienda (`409 category_store_mismatch`).
- Los `PHYTO-*` legacy no se pueden mover de tienda desde la API (se fuerza `phytoemagry`).

### Clasificación de históricos (sin adivinar)
1. Producto sin `store` → `phytoemagry` si es legacy (`PHYTO-*`), `fulltech` en cualquier otro caso.
2. Categoría sin `store` → se deduce de los productos que la usan **solo si todos son de la misma tienda**. Si la usan dos tiendas (o ninguna) queda **`unassigned`**: no se publica en ninguna y queda para decisión humana.
3. Ficha con categoría por nombre y sin `category_id` → se enlaza a la categoría **de su propia tienda**.

Todo es idempotente y ocurre al arrancar (un `UPDATE` por registro desclasificado, con comparación optimista del doc).

## 3. Resultado en UAT (verificado en vivo)

| Comprobación | Antes | Después |
| --- | --- | --- |
| Portada Fulltech (total) | 54 (incluía 2 Phyto) | **52** |
| Categorías del carrusel | 8 (con «Phytoemagry») | **7** |
| «Phytoemagry» en la portada | sí | **no** (`textoPhyto: false`) |
| Buscar «phyto» | devolvía 2 | **0 resultados** |
| `/api/store/products/capsules_5` | 200 | **404** |
| Imagen de `capsules_5` | 200 | **404** |
| Admin: artículos | 61 sin dueño visible | **54 fulltech + 7 phytoemagry** |
| Admin: categorías | 8 sin dueño | **8 fulltech + 1 phytoemagry** |

Nada se borró: los 7 `PHYTO-*` siguen en el catálogo administrativo (facturación y POS) con su categoría.

## 4. Pruebas

`tests/store-isolation.test.js` (nuevo, 5 casos):
1. Portada, catálogo, categorías y buscador solo devuelven artículos propios; `?store=phytoemagry` no cambia nada; ficha e imagen ajenas → 404.
2. El panel etiqueta el dueño, admite la **misma categoría** en ambas tiendas y rechaza colgar un artículo de la categoría ajena.
3. **Misma base, contexto `phytoemagry`**: el resultado se invierte (solo Phyto; Fulltech → 404).
4. Instalación sin `PHYTO_STORE_KEY` = FULLTECH y nunca incluye Phytoemagry.
5. El checkout de una tienda no puede comprar un artículo de la otra.

Suites de tienda completas: **113 pasan, 1 omitida** (`store-isolation`, `store-phase1`, `store-catalog`, `store-public-api`, `store-seo-indexing`, `store-panel`, `store-accounts`, `store-auth-uat`).
En navegador (390×844): 0 errores de consola, sin «Phytoemagry» en el HTML renderizado y estado vacío correcto al buscar «phyto».

## 5. Riesgos y pendientes

1. **Al desplegar**, el arranque escribe `store` en los registros que no lo tengan (aditivo). Aun así: respaldo de BD y ventana de validación antes de publicar.
2. **Categorías `unassigned`**: si en producción una categoría la usan artículos de dos tiendas, quedará sin publicar hasta que alguien decida. No se adivina a propósito; hay que revisar el informe tras el primer arranque.
3. **Pantalla del panel**: hoy el dueño se puede fijar por API (`store` en el alta/edición) y se muestra en el listado, pero **no hay selector en la UI**. Pendiente para administración cómoda.
4. `PHYTO_STORE_KEY` debe fijarse solo en la instalación que sirva Phytoemagry; por defecto es `fulltech`.
5. La landing Phytoemagry (`/`) no usa este catálogo: su aislamiento no depende de este cambio.

## 6. Veredicto

**GO** para llevar a producción *después* de autorización expresa, con respaldo previo y revisión de las categorías `unassigned`.
**NO-GO** para desplegar sin ese respaldo ni sin fijar `PHYTO_STORE_KEY` en la instalación correspondiente.
