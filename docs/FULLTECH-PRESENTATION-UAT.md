# FULLTECH — presentación empresarial mobile first

**Ubicación corregida por indicación del usuario:** presentación en http://127.0.0.1:8898/store/#/nosotros. Inicio restaurado a su presentación anterior.

La imagen, textos y servicios nuevos se movieron a Nosotros, conservando la información empresarial existente. Cabecera, catálogo y checkout intactos. Cache v37, store.js v31 y presentation.css v2. Evidencia de la corrección en docs/capturas/store-presentation-placement/ (home-* = inicio restaurado; after-* = Nosotros).

El informe siguiente conserva el registro de la implementación inicial; sus capturas de portada son históricas, no la ubicación actual.

Se reemplazó únicamente la presentación inicial y el bloque comercial de la portada existente. Se conservaron búsqueda, categorías, productos, precios, autenticación, carrito, checkout, logo aprobado de cabecera e iconos. No se modificaron backend, APIs, base de datos ni configuración de producción en esta tarea. Cambios previos y concurrentes conservados; sin commit, push ni despliegue.

## Imagen y contenido

La imagen suministrada se editó con imagegen para eliminar textos, tarjetas, iconos y adornos del volante y recomponer una escena fotográfica 4:3. Conserva las categorías visuales solicitadas: tecnología/accesorios, herramientas, cámaras, motor y portón en una instalación moderna. No contiene textos comerciales ni botones simulados. Es una composición publicitaria ilustrativa, no evidencia de inventario o de una instalación real.

Original de Downloads intacto. Fuente limpia en assets/branding/presentation/fulltech-clean-source.png (1448×1086, 2.554.484 bytes). Variantes en public/store/assets/presentation/:

| Archivo | Dimensiones | Bytes |
|---|---|---:|
| fulltech-scene-480.webp | 480×360 | 49.808 |
| fulltech-scene-800.webp | 800×600 | 112.426 |
| fulltech-scene-1200.webp | 1200×900 | 198.156 |
| fulltech-scene-1448.webp | 1448×1086 | 253.580 |

La fotografía se muestra completa con proporción reservada, width/height, srcset/sizes y prioridad alta. No se recortan productos ni se estira la versión móvil. Escritorio usa dos columnas; móvil mantiene título, imagen y descripción separados. El nombre FULLTECH de la presentación es HTML (FULL azul / TECH negro); el logo 3D existente de la cabecera permanece intacto.

Título, descripción, Higüey, cinco servicios, mensaje de búsqueda y botones son HTML seleccionable. Explorar productos abre el catálogo existente; Solicitar un producto usa la ruta comercial existente /store/#/request; Consultar instalación usa el WhatsApp ya configurado 18494240621. No se envió ningún mensaje. Conoce nuestras soluciones desplaza dentro de la página sin interferir con el router SPA y respeta prefers-reduced-motion.

## Archivos

- public/store/store.js: presentación y bloque de soluciones; conserva lógica previa.
- public/store/presentation.css: estilos aislados, responsive y temas.
- public/store/index.html: hoja nueva y store.js v30.
- public/store/sw.js: shell v36, hoja nueva y versión del script; iconos PWA intactos.
- assets/branding/presentation/fulltech-clean-source.png: fuente limpia de alta resolución.
- public/store/assets/presentation/: cuatro WebP y manifiesto.
- scripts/build-store-presentation.mjs: optimización reproducible con sharp.
- scripts/check-store-presentation.mjs: navegador Chromium (PLAYWRIGHT_MODULE y CHROMIUM_PATH opcionales).

## Validación

Chromium real a DPR 2: **10/10 combinaciones** — 360, 390, 430, 768 y 1440 px en claro y oscuro. Sin pageerror ni desbordamiento horizontal. Cabecera mantiene 45 px. Imagen cargada y relación de aspecto comprobada. Catálogo, solicitud/autenticación, desplazamiento a servicios, menú y carrito comprobados. WhatsApp validado por destino sin abrir/enviar. Revisión visual de primera vista móvil y escritorio oscuro. Sintaxis JavaScript/service worker y git diff --check correctos.

Transferencia inicial local: móvil 543.692 bytes después frente a 529.643–540.805 antes; tablet 684.846; escritorio 715.958. Aumenta la imagen principal para aportar la escena solicitada. DOMContentLoaded después 44–79 ms en estas muestras locales; no se afirma una mejora de velocidad ni un benchmark de producción. Las dimensiones reservadas evitan cambios de tamaño por decodificación de la imagen; no se afirma CLS cero de toda la tienda.

Métricas: [antes](capturas/store-presentation/before-metrics.json), [después](capturas/store-presentation/after-metrics.json).

## Capturas

| Tema / ancho | Primera vista antes | Primera vista después | Servicios |
|---|---|---|---|
| light / 360 | [Antes](capturas/store-presentation/before-light-360.png) | [Después](capturas/store-presentation/after-light-360.png) | [Servicios](capturas/store-presentation/services-light-360.png) |
| light / 390 | [Antes](capturas/store-presentation/before-light-390.png) | [Después](capturas/store-presentation/after-light-390.png) | [Servicios](capturas/store-presentation/services-light-390.png) |
| light / 430 | [Antes](capturas/store-presentation/before-light-430.png) | [Después](capturas/store-presentation/after-light-430.png) | [Servicios](capturas/store-presentation/services-light-430.png) |
| light / 768 | [Antes](capturas/store-presentation/before-light-768.png) | [Después](capturas/store-presentation/after-light-768.png) | [Servicios](capturas/store-presentation/services-light-768.png) |
| light / 1440 | [Antes](capturas/store-presentation/before-light-1440.png) | [Después](capturas/store-presentation/after-light-1440.png) | [Servicios](capturas/store-presentation/services-light-1440.png) |
| dark / 360 | [Antes](capturas/store-presentation/before-dark-360.png) | [Después](capturas/store-presentation/after-dark-360.png) | [Servicios](capturas/store-presentation/services-dark-360.png) |
| dark / 390 | [Antes](capturas/store-presentation/before-dark-390.png) | [Después](capturas/store-presentation/after-dark-390.png) | [Servicios](capturas/store-presentation/services-dark-390.png) |
| dark / 430 | [Antes](capturas/store-presentation/before-dark-430.png) | [Después](capturas/store-presentation/after-dark-430.png) | [Servicios](capturas/store-presentation/services-dark-430.png) |
| dark / 768 | [Antes](capturas/store-presentation/before-dark-768.png) | [Después](capturas/store-presentation/after-dark-768.png) | [Servicios](capturas/store-presentation/services-dark-768.png) |
| dark / 1440 | [Antes](capturas/store-presentation/before-dark-1440.png) | [Después](capturas/store-presentation/after-dark-1440.png) | [Servicios](capturas/store-presentation/services-dark-1440.png) |
