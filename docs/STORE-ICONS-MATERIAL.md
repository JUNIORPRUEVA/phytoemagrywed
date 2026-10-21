# Iconos descargados · Material Symbols Rounded (comparación)

Estado: **solo comparación, no sustituye al sistema actual**. Nada desplegado.

## Fuente y licencia (verificadas)

| Dato | Valor |
|---|---|
| API | `https://api.iconify.design` — API pública oficial de Iconify |
| Documentación | https://iconify.design/docs/api/ |
| Colección | `material-symbols` |
| Origen | Google Material Symbols (estilo **Rounded**) |
| Catálogo oficial | https://fonts.google.com/icons |
| Licencia | **Apache-2.0** |
| Texto de licencia | https://github.com/google/material-design-icons/blob/master/LICENSE |
| Descarga | 2026-10-21T02:45:19.343Z |

Cada archivo se guardó **tal como lo devolvió la API**: no se ha redibujado ni modificado ningún trazado. La única normalización es añadir un salto de línea final.

## Validación aplicada a cada descarga

HTTP 200 · `Content-Type: image/svg+xml` · XML con un único `<svg>` · `viewBox="0 0 24 24"` · uso de `currentColor` · presencia de geometría · huella SHA-256 registrada.

## Assets (22 archivos, 11 KB)

Ruta: `public/store/assets/icons/material-symbols/`

| Concepto | Variante | Archivo | Peso | SHA-256 |
|---|---|---|---|---|
| home | outline | `home-outline-rounded` | 399 B | `3d1554fbc923…` |
| home | filled | `home-rounded` | 361 B | `a1b9b239a7d9…` |
| categories | outline | `grid-view-outline` | 229 B | `215e7511ab3f…` |
| categories | filled | `grid-view-rounded` | 542 B | `170300e2a4ea…` |
| search | outline | `search-rounded` | 387 B | `2aaa046ac15d…` |
| cart | outline | `shopping-cart-outline-rounded` | 565 B | `87dab95e83a4…` |
| cart | filled | `shopping-cart-rounded` | 532 B | `ead76ae367ae…` |
| account | outline | `person-outline-rounded` | 582 B | `9bc9527514a9…` |
| account | filled | `person-rounded` | 377 B | `2e573c58838c…` |
| menu | outline | `menu-rounded` | 372 B | `ecb7962992d3…` |
| notification | outline | `notifications-outline-rounded` | 419 B | `cef645453d6a…` |
| notification | filled | `notifications-rounded` | 367 B | `6c694d398b5d…` |
| heart | outline | `favorite-outline-rounded` | 648 B | `5d08d2f98ec6…` |
| heart | filled | `favorite-rounded` | 383 B | `54d0f4fea247…` |
| truck | outline | `local-shipping-outline-rounded` | 638 B | `e09838bd499c…` |
| truck | filled | `local-shipping-rounded` | 567 B | `d8c690b398c4…` |
| security | outline | `security-outline-rounded` | 417 B | `cb9bb6c59e13…` |
| security | filled | `security-rounded` | 417 B | `cb9bb6c59e13…` |
| package | outline | `inventory-2-outline-rounded` | 403 B | `6c0e91cce225…` |
| package | filled | `inventory-2-rounded` | 385 B | `85dded435826…` |
| settings | outline | `settings-outline-rounded` | 1295 B | `34df5abf41d0…` |
| settings | filled | `settings-rounded` | 907 B | `2b848ce01a6e…` |

## Sin variante en la colección (2)

- `search` → la colección no publica esta variante
- `menu` → la colección no publica esta variante

## Observaciones honestas

- `security-rounded` y `security-outline-rounded` son **el mismo archivo** (mismo SHA-256): la colección no distingue variante para ese icono.
- La colección usa **relleno** (`fill="currentColor"`), no trazo. Lucide, el sistema actual, usa trazo de 1.75 px. Son dos lenguajes visuales distintos.
- Los nombres con guiones (`inventory-2-outline-rounded`) sustituyen a los guiones bajos de la nomenclatura de Google.

## Comparación visual

`/store/icons-compare.html` (solo UAT, `noindex`, excluida del build):
- 12 conceptos, columna izquierda Lucide y derecha Material Symbols Rounded.
- Tamaños reales **20, 24 y 28 px**.
- Variante *filled* a 24 px para los conceptos que la tienen.
- Barra inferior de 4 ítems a 20 px con activo en `#165DFF`.

### Recomendación

Mantener **Lucide (trazo 1.75)** como sistema principal del storefront: a 20 px conserva mejor el aire, pesa menos visualmente en la barra inferior de 4 ítems y es coherente con el resto del panel. Material Symbols Rounded (relleno) funciona mejor en contextos donde el icono debe destacar por sí solo —por ejemplo el estado activo de la barra inferior— o si más adelante se quiere un look más "app nativa" de Google.

Uso puntual sugerido: **filled de Material Symbols solo para el ítem activo** de la barra inferior, dejando el resto en trazo. Es la única combinación que aporta contraste real sin cambiar el lenguaje visual.

## Regenerar

```bash
npm run icons:material
```

## Script

`scripts/fetch-material-symbols.mjs` — falla con código 1 si alguna descarga no valida o si falta una variante esperada, en lugar de fabricar un icono.
