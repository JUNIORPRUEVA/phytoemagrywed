# AppBar y navbar: segunda compactación

Revisión local, 23 de octubre de 2026. Cambios sobre la rama actual; sin despliegue.

| Componente | Antes | Después |
| --- | --- | --- |
| AppBar, incluido borde | 45 px | 35 px |
| Navbar móvil, incluido borde | 47 px | 39 px |
| Controles del navbar | 46 px | 38 px |
| Buscador | 40 px | 36 px |
| Reserva del buscador | 44 px + 2 px de main | 36 px |
| Tarjeta comercial, 390 px de ancho | 172,5 px | 147,5 px |
| Logo | 124 × 27,8 px | 124 × 27,8 px |

Se recuperan 53 px en el conjunto a 390 px de ancho: 10 de cabecera, 8 de navbar, 10 de buscador/reserva y 25 de tarjeta. Las áreas seguras del dispositivo se suman por separado. La altura puede crecer con texto ampliado; no hay altura máxima ni zoom global.

La causa del espacio anterior eran los mínimos explícitos de 44/46 px y el padding de los controles, no el logo. Ahora la fila superior mide 34 px, los controles 36 × 34 px, y el navbar conserva zonas independientes de 38 px de alto por el ancho de cada columna. Estas medidas son una elección más compacta que los 44 px anteriores; no se simula un área mayor con pseudo-elementos ni se solapan zonas táctiles. Los iconos conservan 21–22 px. Las etiquetas permanecen visibles y el estado activo se conserva.

Las ofertas usan una cuadrícula común y `object-fit: contain`. El botón rotativo pasa de un mínimo de 44 a 34 px y el registro flotante de 34 a 30 px. Los offsets del registro y las reservas del shell dependen de la nueva altura del navbar.

## Evidencia y validación

Capturas y métricas en `capturas/store-mobile/`, prefijos `compact-before-*`, `compact-after-*` y `compact-fixture-*`. Los dos primeros son el mismo sitio local y los mismos viewports antes y después. El tercero utiliza productos visuales interceptados únicamente en el navegador, porque el catálogo local no devuelve ofertas.

- Chromium: 320 × 568, 375 × 667, 390 × 844, 412 × 915, 430 × 932.
- También 768 × 1024, 844 × 390, 1280 × 800 y texto al 125 % en 320 × 568.
- Sin overflow horizontal en inicio, catálogo, carrito y solicitud.
- Comprobación geométrica de controles y alcance de sus centros mediante `elementFromPoint`.
- Capturas inspeccionadas de móvil pequeño y estándar.
- `npm run build` correcto; siete advertencias existentes de contenido.
- `git diff --check` correcto.

El navegador de escritorio permite revisar dimensiones y orientación, pero no reproduce el teclado nativo ni el área segura de un teléfono físico. Esas dos verificaciones quedan pendientes en dispositivo real.

Archivos de interfaz: `public/store/discovery.css`, `public/store/index.html`, `public/store/sw.js`. Verificador actualizado: `scripts/check-store-mobile.mjs`. Sin cambios de esta tarea en backend, datos ni selección comercial.

GO para revisión visual local del usuario. No se ha autorizado ni realizado despliegue.
