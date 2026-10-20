# Release SEO de FULLTECH Store — baseline, cambios y puertas de salida

Fecha: 2026-10-20 · Rama `main` · HEAD `00af106` · **Estado: NO-GO para despliegue (bloqueo técnico documentado en §7)**

## 1. Baseline de producción (medido, no supuesto)

| Recurso | URL | HTTP | Directivas observadas |
| --- | --- | --- | --- |
| Portada tienda | `https://fulltechrd.com/store/` | 200 | **Sin canonical, sin `meta robots`, sin Open Graph** |
| Producto | `https://fulltechrd.com/store/p/capsules_5` | 200 | `X-Robots-Tag: noindex, nofollow` + `meta robots=noindex,nofollow`; canonical → `https://ventas-fulltech-tienda-pwa.gcdndd.easypanel.host/store/p/capsules_5` |
| robots raíz | `https://fulltechrd.com/robots.txt` | 200 | `User-agent: *` `Allow: /` y el comentario `# PENDIENTE: define SEO_SITE_URL…`; **sin línea `Sitemap:`** |
| robots tienda | `https://fulltechrd.com/store/robots.txt` | 200 | `Disallow: /` (entorno no indexable) |
| sitemap tienda | `https://fulltechrd.com/store/sitemap.xml` | 200 `application/xml` | **8 `<loc>` con el host interno** `ventas-fulltech-tienda-pwa.gcdndd.easypanel.host`, sin `lastmod` |

Servicios y revisiones:

| Servicio | Imagen | `GIT_SHA` | Env SEO |
| --- | --- | --- | --- |
| `ventas_fulltech-tienda-pwa` (sirve `fulltechrd.com` por Traefik) | `easypanel/ventas/fulltech-tienda-pwa` | `af91481` | `PHYTO_PUBLIC_URL=https://ventas-fulltech-tienda-pwa.gcdndd.easypanel.host` (interno). **Sin** `PHYTO_STORE_PUBLIC_URL`, **sin** `PHYTO_STORE_INDEXABLE` |
| `ventas_phytoemagrywed` (sirve `phytoemagryrd.lat`) | `easypanel/ventas/phytoemagrywed` | `00af106` | **Sin** variables SEO de la tienda |

Ruteo real (nginx dentro de la imagen): `= /store/robots.txt`, `= /store/sitemap.xml` y `^~ /store/p/` van al Node (8787); **todo lo demás de `/store/` es estático**, por eso la portada no tiene canonical.
Producto de datos: 8 artículos publicados en producción, 2 en la base UAT.

## 2. Causas raíz de los defectos

| # | Defecto | Causa raíz exacta |
| --- | --- | --- |
| 1 | Sitemap con host interno | `STORE_SEO.publicUrl` caía a `PHYTO_PUBLIC_URL` (URL interna de EasyPanel) y `storeOrigin()` aceptaba cualquier host |
| 2 | Productos `noindex` | `PHYTO_STORE_INDEXABLE` nunca se definió en el servicio |
| 3 | Portada sin canonical | `/store/` es un archivo estático; el Node nunca ve esa petición |
| 4 | robots sin sitemap | `renderRobots` del build solo emitía `Sitemap:` con `SEO_SITE_URL`, que no está definido at runtime de build |
| 5 | Google no reconoce URLs | Consecuencia de 2 y 4 (verificado con URL Inspection: `NEUTRAL`, «Google no reconoce esta URL») |
| 6 | Sitemap FullPOS con 1 error | `fullpos.fulltechrd.com` resuelve a `187.77.196.196` y **no responde** (timeout HTTPS) |
| 7/8 | Código y flags incompletos | Confirmado: la imagen desplegada no trae estas correcciones |

## 3. Cambios de código (sin desplegar)

| Archivo | Cambio |
| --- | --- |
| `server/store-seo.mjs` | `isPublicOrigin()` (rechaza localhost, IP privadas, `.internal`, `.easypanel.host`), `storeOrigin()` endurecido, `renderSitemap` con dedupe + orden determinista + `lastmod` real y **`xml: null` si no hay origen público**, `renderRobots` con allow/disallow + `Sitemap:` absoluto, nuevo `renderStoreShell()` (canonical/OG/noindex + enlaces en `<noscript>`) |
| `server/store-seo-routes.mjs` | Portada `/store/` servida con la cabecera SEO inyectada (mismo HTML de la PWA), `/store` → 301 a `/store/` sin bucle, sitemap responde **503** si falta dominio público, producto indexable solo con origen válido |
| `server/store-catalog.mjs` | `publicProducts()` expone `updatedAt` (fecha real de publicación) para `lastmod` |
| `server/crm-server.mjs` | `STORE_SEO.publicUrl` deja de caer a `PHYTO_PUBLIC_URL` (origen del defecto 1) |
| `src/render/seo-files.js` | robots del build anuncia **ambos** sitemaps (`/sitemap.xml` y `/store/sitemap.xml`) |
| `nginx/phytoemagry.conf` | `location = /store/` y `= /store` al Node, con `error_page` hacia el HTML estático si el servicio no responde |
| `tests/store-seo-indexing.test.js` | 15 pruebas nuevas (origen, sitemap, robots, canonical, structured data, portada, ciclo de vida) |

Verificación local (UAT, `http://127.0.0.1:8790`):

- Con `PHYTO_STORE_PUBLIC_URL=https://fulltechrd.com` y `PHYTO_STORE_INDEXABLE=false`: portada `noindex` sin canonical, sitemap con URLs canónicas, robots cerrado.
- Con `PHYTO_STORE_INDEXABLE=true`: portada con `canonical https://fulltechrd.com/store/`, Open Graph completo, robots `index,follow`, 2 enlaces rastreables; producto con canonical e `index,follow`; `/store` → 301 `/store/`; robots con `Sitemap: https://fulltechrd.com/store/sitemap.xml`.
- Pruebas: **61 pasan, 1 omitida** (`store-seo-indexing`, `search-console`, `store-public-api`, `store-catalog`).

## 4. Política de indexabilidad (Fase 4)

`publicProducts()` ya impone la política y se conserva:

1. Solo entran al sitemap los artículos con `fulltech_store_publication_v1.status = 'published'`.
2. `active = false` (archivados o dados de baja) quedan fuera de `list()` y por tanto del sitemap.
3. `kind = 'service'` se excluye explícitamente (Fase 1: la tienda vende productos).
4. Disponibilidad honesta: `AVAILABLE_NOW → InStock`, `ON_REQUEST → BackOrder`, `UNAVAILABLE → OutOfStock`; `purchaseable` solo con stock real.
5. Sin precio real no se emite `Offer.price`.
6. Un artículo despublicado que aún existe devuelve **410**; uno inexistente, **404**; ambos `noindex`.
7. Publicar un artículo NO publica el resto del inventario (~110 registros del CRM siguen sin publicar).

## 5. Search Console (real, no mock)

| Operación | Resultado |
| --- | --- |
| `listSites` | `sc-domain:fulltechrd.com` — `siteFullUser` |
| `searchAnalytics` 28 días | 200 OK, 0 filas |
| `listSitemaps` | Solo `https://fullpos.fulltechrd.com/sitemap-index.xml` (1 error, 3 avisos) |
| `inspectUrl` | `NEUTRAL` / «Google no reconoce esta URL» |
| `submitSitemap` | Bloqueado por `PHYTO_GSC_ALLOW_SITEMAP_SUBMIT=0` |

**Nota de permisos:** el token actual usa `webmasters.readonly`. Un `PUT` de sitemap exige el alcance de escritura; habilitarlo obliga a cambiar el alcance y reemitir el token (no se hizo, sigue bloqueado).

## 6. Puertas antes de indexar (checklist)

- [x] Código: canonical, robots, sitemap y política de indexabilidad corregidos y probados.
- [x] Dominio canónico definido: `https://fulltechrd.com`.
- [ ] `PHYTO_STORE_PUBLIC_URL=https://fulltechrd.com` en el servicio que sirve el dominio.
- [ ] `SEO_SITE_URL=https://fulltechrd.com` en el build (hoy `/sitemap.xml` responde **404**).
- [ ] `PHYTO_STORE_INDEXABLE=true` (solo tras aprobar contenido definitivo).
- [ ] Auditoría SEO en verde (`/opt/fulltech-gsc/run.sh audit --origin https://fulltechrd.com`).
- [ ] `PHYTO_GSC_SEO_AUDIT_OK=1` + `PHYTO_GSC_ALLOW_SITEMAP_SUBMIT=1` y alcance de escritura.
- [ ] Sitemap FullPOS: **no se toca**; su host `187.77.196.196` no responde.

## 7. NO-GO de despliegue (bloqueo exacto)

El candidato **no es limpio**:

1. `Dockerfile` y `nginx/phytoemagry.conf` tienen, **sin commitear**, la eliminación del bloque `client_max_body_size 110m` de las subidas del panel. Producción **sí** lo tiene (verificado: línea 109 de `/etc/nginx/nginx.conf` en el contenedor). Commitear el archivo nginx para publicar la portada arrastraría esa regresión: las subidas de audio/PDF del panel volverían a fallar con **413**.
2. Publicar requiere commit + push + build de imagen + `docker service update`; el push no está autorizado y la imagen se construye desde el repositorio, no desde el árbol local.
3. Gates de contenido sin cumplir: `/sitemap.xml` 404, indexabilidad sin aprobar, auditoría SEO pendiente de despliegue.

**Runbook cuando se autorice** (no ejecutado):

```bash
# 1. Restaurar client_max_body_size 110m en nginx/phytoemagry.conf y Dockerfile (decisión del otro agente)
# 2. Commit SOLO de: server/store-seo*.mjs, server/store-catalog.mjs, server/crm-server.mjs,
#    src/render/seo-files.js, nginx/phytoemagry.conf, tests/store-seo-indexing.test.js, docs/
# 3. push + docker build con SEO_SITE_URL=https://fulltechrd.com
# 4. docker service update --env-add PHYTO_STORE_PUBLIC_URL=https://fulltechrd.com \
#      --env-add PHYTO_STORE_INDEXABLE=false --update-order start-first ventas_fulltech-tienda-pwa
# 5. verificar canonical/robots/sitemap; luego PHYTO_STORE_INDEXABLE=true
# 6. /opt/fulltech-gsc/run.sh audit --origin https://fulltechrd.com  (todo ok)
# 7. solo entonces habilitar envío de sitemap con alcance de escritura
```

Rollback: `docker service rollback ventas_fulltech-tienda-pwa` (imagen anterior `af91481`).
