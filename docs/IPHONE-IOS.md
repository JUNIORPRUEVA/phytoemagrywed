# iPhone / iPad — capa de adaptación

Qué hay detrás de que el panel se vea «como una app» en un iPhone, y qué falta por
comprobar en un teléfono de verdad.

## 1. Cómo está montado

| Pieza | Archivo | Qué hace |
| --- | --- | --- |
| Detección | `public/admin/index.html` (script del `<head>`) | Pone `data-ios` en `<html>` leyendo el user-agent de Apple (`iPhone|iPad|iPod`, y iPadOS 13+ que se presenta como Mac con táctil). Si va instalada, añade `data-ios-standalone`. |
| Capa visual | `public/admin/ios.css` | Todas sus reglas cuelgan de `html[data-ios]`. En Android y en escritorio **no se aplica ninguna**. |
| Teclado | `public/admin/ios.js` | Traduce `window.visualViewport` a dos variables: `--ios-vvh` (alto visible) y `--ios-kb` (alto del teclado, 0 cuando está cerrado), y marca `body[data-ios-kb]`. Además deja a la vista el campo enfocado dentro de una hoja. |

Lo que ya estaba resuelto antes y aquí **no** se repite:

- márgenes seguros (`env(safe-area-inset-*)`) en cabeceras, barra inferior, hojas y cajón →
  `menus-safe-area.css`, `navigation.css`;
- alto real del viewport en el chat (`100dvh`) → `navigation.css`;
- el compositor de WhatsApp siguiendo el teclado → `composer-mobile.js` / `composer-mobile.css`.

## 2. Qué corrige esta capa

1. **Zoom al escribir.** iOS amplía la página entera cuando el campo tiene menos de 16 px y ese
   zoom se queda puesto. Los campos de texto llevan `font-size: max(16px, 1em)` en móvil iOS
   (con `!important`, porque cada pantalla fija su tamaño con su propia clase).
2. **Hojas detrás del teclado.** Con el teclado abierto se sube el borde inferior de `#sheet`
   lo que ocupa el teclado y se limita el alto del panel a lo que se ve. Igual para
   `.order-flow-panel` (se recentra) y `.calling`.
3. **Campo tapado al enfocar.** `scrollIntoView({ block: 'nearest' })` sobre la caja que
   desplaza la hoja, sin mover la página.
4. **Aspecto nativo.** `-webkit-appearance: none` en campos (quita la sombra interior de
   Safari), `-webkit-tap-highlight-color: transparent`, `text-size-adjust: 100%` (evita que iOS
   hinche la letra al girar), scroll con inercia y `prefers-reduced-motion`.
5. **iOS antiguo.** Si el navegador no entiende `dvh` (iOS < 15.4), un bloque `@supports not`
   da los mismos altos con `vh`.
6. **Visor de PDF** (`receipt-viewer.html`): `viewport-fit=cover`, cabecera y acciones con
   márgenes seguros, y en Safari los controles alcanzan 44 pt.

## 3. Cómo verificarlo en UAT

```powershell
node scripts/uat-env.mjs --port=8801 --sin-scheduler
```

Abrir `http://127.0.0.1:8801/admin/?token=phyto-uat` y en las herramientas del navegador
elegir un iPhone. Para ver el efecto de la capa iOS sin un iPhone, ejecutar en la consola:

```js
document.documentElement.dataset.ios = 'true';
```

## 4. Lo que NO se puede dar por bueno sin un iPhone real

La emulación no reproduce `env(safe-area-inset-*)` (siempre valen 0), ni el comportamiento
real del teclado de iOS, ni el modo instalado. Queda pendiente comprobar en un teléfono:

- [ ] Notch / isla dinámica: cabecera, tarjetas de Hoy y botón de menú no quedan debajo.
- [ ] Barra inferior de Hoy por encima del indicador de inicio (vertical y horizontal).
- [ ] Chat: al abrir el teclado el compositor sube pegado y la lista no salta.
- [ ] Hojas con formulario (pedido, cliente, campaña) visibles con el teclado abierto.
- [ ] Ningún campo hace zoom al enfocarlo (login, búsqueda, chat, pedido).
- [ ] Apaisado: nada cortado en los bordes izquierdo/derecho.
- [ ] Instalada en la pantalla de inicio (PWA): arranque sin barra de Safari y sin huecos.
- [ ] Safari y PWA: volver de segundo plano sin descuadrar la pantalla.
- [ ] Visor de PDF: cabecera y botones de acción accesibles, PDF desplazable.
- [ ] Mapa y delivery: se puede mover el mapa y pulsar marcadores.

## 5. Android

Nada de esta capa se aplica en Android (`data-ios` no existe), así que su aspecto y su
comportamiento quedan como estaban. La única pieza compartida que cambia con respecto a antes
en un móvil no-Apple es el visor de PDF: gana `viewport-fit=cover` en el viewport (sin efecto
si el teléfono no recorta pantalla) y nada más.
