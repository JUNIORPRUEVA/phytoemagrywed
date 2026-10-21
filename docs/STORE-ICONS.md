# Sistema de iconos · FULLTECH Store

Estado: **Fase 1B (local, sin desplegar)**. Todo se genera con un comando; no se descarga nada a mano.

## Fuente y licencia

| Dato | Valor |
|---|---|
| Librería | [`lucide-static`](https://www.npmjs.com/package/lucide-static) |
| Versión instalada | **1.60.0** (devDependency) |
| Licencia | **ISC** — uso comercial permitido, sin obligación de mostrar atribución en la interfaz |
| Texto de licencia | https://github.com/lucide-icons/lucide/blob/main/LICENSE |
| Iconos propios | Ninguno se mantiene: los 24 anteriores se sustituyeron por equivalentes de Lucide |
| Flaticon | **No se usa.** No hay credenciales de API ni autorización comercial verificada en este proyecto, así que no se ha descargado ni scrapeado nada de Flaticon |

## Automatización

```bash
npm install          # instala lucide-static (devDependency)
npm run icons:store  # regenera todo el sistema de iconos
```

`scripts/build-store-icons.mjs` lee los SVG de `node_modules/lucide-static/icons/`, normaliza el trazado y escribe tres salidas:

| Salida | Para qué |
|---|---|
| `public/store/icons.js` | Registro único que consume la PWA (SVG inline, sin dependencias en runtime) |
| `public/store/icons/<nombre>.svg` | 24 SVG sueltos con `stroke-width="1.75"`, reutilizables en Flutter u otras plataformas |
| `public/store/icons/manifest.json` | Manifiesto con nombre, grupo, equivalente en Lucide, fuente, versión y licencia |

Para añadir un icono: añade una línea en el objeto `REGISTRY` del generador y ejecuta `npm run icons:store`. El resto (registro, ficheros, manifiesto) es automático.

## Reglas visuales

- `viewBox="0 0 24 24"` en todos.
- Trazo **1.75** (Lucide publica 2; el generador impone 1.75 para el look compacto de FULLTECH).
- `stroke="currentColor"`: el color lo decide el CSS (`--ft-primary` activo, `--ft-muted` inactivo).
- Extremos y uniones redondeados.
- Tamaños soportados: **20** (barra inferior) y **24** (contenido). `icon(name, '', { size })` acepta cualquier tamaño.

## Registro (24 iconos)

### Navegación (4)
| Nombre en la app | Lucide |
|---|---|
| `home` | `house` |
| `categories` | `layout-grid` |
| `search` | `search` |
| `menu` | `menu` |

### Compra (7)
| Nombre | Lucide |
|---|---|
| `cart` | `shopping-cart` |
| `heart` | `heart` |
| `plus` | `plus` |
| `minus` | `minus` |
| `close` | `x` |
| `arrow-right` | `arrow-right` |
| `chevron-right` | `chevron-right` |

### Cuenta (5)
| Nombre | Lucide |
|---|---|
| `user` | `user` |
| `bell` | `bell` |
| `orders` | `clipboard-list` |
| `support` | `headset` |
| `settings` | `settings` |

### Entrega (3)
| Nombre | Lucide |
|---|---|
| `truck` | `truck` |
| `map-pin` | `map-pin` |
| `package` | `package` |

### Garantía (1)
| Nombre | Lucide |
|---|---|
| `shield-check` | `shield-check` |

### Categorías del catálogo (4)
| Nombre | Lucide |
|---|---|
| `laptop` | `laptop` |
| `router` | `router` |
| `headphones` | `headphones` |
| `camera` | `camera` |

## Uso

```js
import { icon, categoryIcon, hydrateIcons, ICON_SOURCE, ICON_GROUPS, iconNames } from '/store/icons.js';

icon('cart');                                   // 24 px, trazo 1.75, currentColor
icon('cart', 'ft-icon--sm', { size: 20 });      // 20 px
icon('search', '', { label: 'Buscar' });        // accesible (role="img" + aria-label)
categoryIcon('Seguridad');                      // → 'shield-check'

hydrateIcons();                                 // rellena los <svg data-icon="…"> del HTML
```

La cabecera y la barra inferior del HTML **no repiten trazados**: llevan `<svg data-icon="home" data-icon-size="20">` y `store.js` los hidrata al arrancar con `hydrateIcons()`. Así el registro es la única fuente de verdad.

## Previsualización

`/store/icons-preview.html` (marcada `noindex`): muestra los 24 iconos a 20 y 24 px agrupados, y la barra inferior en estado normal y activo.

## Auditoría rápida

```bash
node -e "import('./public/store/icons.js').then(m=>console.log(m.ICON_SOURCE, m.ICON_NAMES.length))"
```

## Integración futura con Flutter

`public/store/icons/<nombre>.svg` está pensado para `flutter_svg`:

```dart
SvgPicture.asset('assets/icons/cart.svg', width: 20, height: 20, colorFilter: ColorFilter.mode(color, BlendMode.srcIn));
```

Los nombres coinciden con el registro JS, así que un mapa 1:1 (`home`, `categories`, `cart`, `user`, …) sirve para las dos plataformas. El manifiesto `icons/manifest.json` permite generar ese mapa automáticamente.
