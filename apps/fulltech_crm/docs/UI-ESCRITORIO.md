# UI de escritorio (Windows) — app Flutter del CRM

Regla del proyecto: **lo que se vea en PC con Windows tiene que verse completo**. El móvil ya
está resuelto; aquí se fija el criterio de escritorio para que nada se rompa al cambiar de
tamaño de ventana.

## Medidas de referencia

| Zona | Valor | Nota |
|---|---|---|
| Rail de navegación | 54 px | Fijo, sin scroll |
| Lista de chats | 372 px | `ChatDesktopMetrics.listWidth` |
| Fila de chat | 68 px | Nombre 13.6 / preview 12.2 |
| Cabecera del hilo | 42 px | Compacta |
| Paneles laterales (acciones / IA / rápidas) | **30 % del ancho** con tope 280–460 | Se abren sobre el hilo, con fondo desenfocado |
| Ancho máximo de burbuja | 40 % del hilo | Texto grande, tarjetas estrechas |

## Comprobaciones obligatorias

- **1280×720** y **1366×768**: con un panel abierto, el compositor sigue visible y el hilo
  conserva scroll.
- **1920×1080**: los paneles no se estiran más de 460 px; el hilo no queda desproporcionado.
- **Ventana estrecha** (<980 px): la app usa la disposición de móvil; ningún panel de escritorio
  debe montarse encima del compositor.

## Reglas de composición

1. Nada de alturas fijas con contenido variable: `Expanded` / `Flexible` / `ListView`.
2. Paneles: `(ancho * 0.30).clamp(280, 460)`; cierre con ✕ y tocando el fondo.
3. Textos: títulos ≥ 15, cuerpo ≥ 12, secundarios ≥ 11; `ellipsis` en una línea, varias líneas
   cuando el dato importa.
4. Diálogos: ancho 420–520 y contenido desplazable; alto máximo 85 % de la ventana.
5. Avisos: `crmToast` arriba a la derecha (apilables, cierran solos). No usar `SnackBar`.
6. `flutter analyze` limpio y tests del widget tocado en verde antes de cerrar el cambio.

## Paneles del chat (estado actual)

- **Derecha, 30 %** — **Pedidos del cliente**: columna a **todo el alto**, por encima de la cabecera
  y del compositor (con velo detrás). Abre en el pedido en curso (estado, fecha, líneas, total,
  pago, envío y entrega) y un botón «Ver lista» con todos sus pedidos.
- **Derecha, 40 %** — **Ficha del cliente**: misma presentación; nombre, teléfono, ciudad, etapa,
  nº de pedidos, total comprado, notas y los últimos movimientos del expediente.
- **Cabecera del hilo (escritorio):** lupa, llamada, **carrito ámbar (pedidos)** y **persona
  (ficha)**, estos dos más grandes (40 px) y con fondo propio.
- **Enter en dos pasos:** con una corrección pendiente, el primer Enter corrige y pide una segunda
  pulsación; el segundo envía. Sin corrección, envía al primero. El botón de enviar siempre envía.
- **Lista de chats:** tarjetas con esquinas redondeadas (radio 10), hover y selección con borde
  suave; nombre 14, último mensaje 13, hora 11; etiquetas tipo *pill* pastel debajo del mensaje.

- **Derecha, 30 %** — Asistente IA: corregir el mensaje, sugerir respuesta, resumen del cliente y
  asistente contextual. No envía nada solo.
- **Derecha, 30 %** — Acciones: crear pedido, enviar plantilla, datos de pago/ubicación,
  asignación, finalizar/reabrir, recargar y conciliar un envío.
- **Derecha, ancho fijo 320–360 px** — Acciones rápidas (icono de la barra de escritura):
  respuestas de siempre (se escriben en el compositor) y datos para compartir (página web,
  tienda, ubicación, cuentas, catálogos). **Empuja** el hilo, no lo tapa: la lista de chats queda
  intacta y el compositor sigue visible. En móvil se abre como hoja desde abajo al 80 % del alto.
