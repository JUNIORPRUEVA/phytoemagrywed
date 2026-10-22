# FULLTECH Store — Portada comercial (Fase 2)

Fecha: 2026-10-22 · Alcance: UAT local. Sin commit, sin push, sin deploy.

## 1. Auditoría previa (resumen)

| Pieza | Estado encontrado |
| --- | --- |
| Rutas | SPA con hash: `/store/` (portada), `#/catalog`, `#/product/:id`, `#/search`, `#/cart`, `#/checkout`, `#/request`, `#/orders`, `#/account`. |
| API pública | `GET /api/store/home`, `/api/store/catalog`, `/api/store/categories`, `/api/store/products/:id`, imágenes. Todo deriva de productos **publicados** (`fulltech_store_publication_v1`). |
| Modelo | `fulltech_catalog_v1` (doc JSON) + publicación (status/featured/sort_order) + galería en `fulltech_product_images_v1`. Precio en `price_cents`. **No existía precio anterior ni fecha de publicación expuesta**. |
| Búsqueda | `searchPublicProducts` con tokens (`fulltech_store_search_terms_v1`), insensible a acentos, incluye SKU. |
| Paginación | `page` + `limit` (máx. 48) con `pagination.total/pages`. |
| Carrito | `localStorage` (`fulltech_cart_v1`) con id + cantidad; el precio se revalida contra el catálogo. |
| Service worker | `fulltech-store-v31`, precachea shell y hace network-first del catálogo. |
| Huecos reales | Sin ofertas (no había precio anterior), sin fecha de publicación, sin fichas de categoría con imagen, el carrito solo resolvía los primeros 48 artículos (`limit=60` recortado a 48 en servidor). |

## 2. Cambios de servidor

- `server/store-catalog.mjs`
  - `compare_at_cents` opcional en la ficha. Se rechaza si no es mayor que el precio de venta (`invalid_compare_at`).
  - Proyección pública con `compareAtPrice`, `discountPercent` (**calculado en servidor**), `createdAt`.
- `server/store-public-routes.mjs`
  - `categoryCards` (nombre, `count` real, imagen representativa tomada del catálogo) en `/api/store/home` y `/api/store/categories`. `categories` sigue siendo lista de textos (compatibilidad).
  - `sections` en `/api/store/home`: `featured`, `offers`, `newArrivals`, `discover`, **sin productos repetidos** entre bloques.
  - `/api/store/catalog`: `sort=relevance|recent|price-asc|price-desc|name` y `offers=true`. Sin orden por «más vendido» (no hay historial de ventas verificado).

## 3. Semilla UAT (`scripts/seed-store-uat.mjs`)

- 50 artículos **ficticios** en 7 categorías (Tecnología, Accesorios, Hogar, Seguridad, Cámaras, Redes y conectividad, Electricidad) + accesorios de demo en Phytoemagry.
- Idempotente por SKU `UAT-###`; la descripción **interna** empieza por `DEMO UAT` (la pública va limpia).
- Precios en RD$ realistas, 14 con precio anterior, stock variado (agotados incluidos) y 2 «bajo pedido».
- Imágenes generadas con `sharp` (gradiente por categoría + pictograma vectorial): activos de prueba propios, sin fuentes externas ni derechos de terceros.
- Fechas de publicación escalonadas en la base UAT para que «Novedades» sea real.
- Guardas: solo `127.0.0.1:8790-8799`, solo si `/api/health` responde `storage: sqlite`, y la base debe existir en `data/uat/`.

## 4. Portada y navegación

Orden final: buscador → héroe → confianza → **categorías con imagen (scroll horizontal)** → **Destacados** → **Ofertas** → **Novedades** → **Descubrir más** → **Nosotros** → banner «Lo conseguimos por ti» → pie.

- Tarjetas: distintivo `-N%` solo si el servidor lo confirma, precio anterior tachado, disponibilidad real, CTA compacto.
- Catálogo: chips (Todo / Ofertas / Destacados / categorías con conteo), select de categoría, select de orden, contador, «Quitar filtros», estado vacío honesto y paginación «Ver más».
- La búsqueda en el catálogo **no re-renderiza** la pantalla (no se pierde el foco) y el estado queda en el hash, así que al volver de una ficha se recupera.
- Carrito: se resuelve por ficha individual si el artículo no entra en la primera página.
- «Nosotros»: entrada en el menú lateral y enlace de cabecera en tablet/escritorio; contenido solo con datos verificables (FULLTECH, SRL · WhatsApp oficial +1 849-424-0621 · confirmación antes de cobrar · garantía según ficha).

## 5. Decisiones de contenido

- **Sin «más vendidos»**: no hay historial de ventas verificado en UAT; nunca se presenta una semilla como ventas reales.
- **Ofertas**: solo con precio anterior configurado; el porcentaje lo calcula el servidor.
- **Vídeo**: no existe material aprobado en el repositorio. No se añade reproductor; ubicación recomendada: bloque compacto entre «Novedades» y «Descubrir más», con póster propio, reproducción a petición y subtítulos.

## 6. Medición (UAT, Chromium aislado)

- 5 viewports (360×800, 390×844, 430×932, 820×1180, 1440×900): **0 px de desbordamiento horizontal**, **0 imágenes rotas** (35 por portada).
- Portada: 41 peticiones, ~640 KB transferidos, `DOMContentLoaded` 19–65 ms en local.
- API: `/api/store/home` 31,7 KB · `/api/store/categories` 1,4 KB · `/api/store/catalog?limit=24` 25,1 KB.
- CSS nuevo: `storefront.css` 12,2 KB (una sola hoja, sin dependencias).

## 7. Pruebas

- `vitest`: `store-phase1`, `store-catalog`, `store-public-api`, `store-seo-indexing`, `store-panel` → **84 pasan, 1 omitida**.
- Navegador: filtro por categoría (8 accesorios), ofertas (14 con descuento y `-N%`), orden por precio ascendente, búsqueda «camara» (2 resultados, 0 duplicados), ficha, carrito, checkout (pide sesión), «Nosotros», paginación 24→48→54 sin duplicados, categoría vacía y búsqueda sin resultados.

## 8. Pendiente / requiere aprobación

1. El arte del logo (`fulltech-store-*-144/192`) trae un glifo superpuesto sobre «FULL» a tamaños pequeños; se conserva tal cual (no se altera la marca). Conviene un export limpio.
2. Copiar `compare_at_price` a la ficha del panel (hoy solo se configura por API/semilla) antes de usar ofertas en producción.
3. Nada de esto está desplegado: la portada vive en UAT (`dist/` local).
