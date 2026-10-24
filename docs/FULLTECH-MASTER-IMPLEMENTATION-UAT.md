# FULLTECH Store — implementación coordinada y UAT

Fecha: 23 de octubre de 2026. Rama inicial y conservada: `release/google-oauth-20261023`.

## A. Resumen ejecutivo

Se integraron la navegación de tres destinos, Categorías, Ofertas adaptativas, tarjetas compactas, ajuste del logo, selección diaria automática y drawer con ecosistema. Se retiró el servicio de búsqueda por solicitud tanto para clientes como para gestión activa del CRM, conservando su archivo administrativo de solo lectura.

La implementación puede revisarse localmente. No se ejecutó commit, push ni despliegue. No se modificaron bases de producción, variables de producción ni secretos.

## B. Auditoría inicial

- Entrada: `public/store/index.html`; rutas por hash y componentes en `store.js`.
- Diseño existente: `design-system.css`, `discovery.css`, `storefront.css`, `customer-ui.css`. Se reutilizan las fuentes, colores, búsqueda, proporciones, barra inferior y componentes de tarjetas. `commerce-ui.css` concentra el refinamiento de esta entrega.
- Buscador compartido: `searchMarkup` / `searchEntryMarkup`, fondo claro y botón negro con icono blanco.
- Carrito: almacenamiento local de identificadores y cantidades. Precio, disponibilidad, pertenencia a tienda y creación de pedido se validan en servidor.
- Catálogo público: `store-public-routes.mjs` y proyección autorizada de `store-catalog.mjs`; separación existente FULLTECH/PHYTOEMAGRY y SEO conservados.
- Ofertas: precios en centavos, activación, precio anterior, fechas de inicio/final, publicación y selección diaria persistente existentes. Se amplió su uso, sin crear otro modelo de promociones.
- Autenticación: contraseña, Google, sesiones y bienvenida opcional ya presentes en el árbol de trabajo. Se preservaron y volvieron a probar.
- CRM: gestión de productos en `public/admin/store.js`, solicitudes heredadas en `store-requests.js` y endpoints dedicados. No se encontró un generador externo ni un job de sourcing independiente; las escrituras del servicio retirado quedan bloqueadas también en el modelo.
- Estado inicial: ya había cambios sin commit en tienda, cuentas, pruebas de autenticación e iconos. Se conservaron; esta entrega se organizó por grupos funcionales, sin crear un commit que mezclara trabajo ajeno.
- Evidencia anterior a cambios: `docs/capturas/store-master/before-*` en ocho anchos, con productos visuales interceptados en el navegador. No se guardaron como catálogo comercial.

## C. Cambios implementados

### Retiro del servicio heredado

Se eliminaron formulario, historial y decisiones del cliente, promociones, enlaces, tarjeta de cuenta y estado específico del frontend. Las direcciones antiguas `#/request` y `#/account/requests` llevan al catálogo.

`/api/store/requests` y sus subrutas, más `/api/store/account/requests`, responden **410 Gone**, con código estable `sourcing_retired` y sin exponer datos. El campo compatible `requests_count` de la sesión devuelve cero. Los métodos internos de creación, decisión, transferencia y actualización de solicitudes rechazan escrituras con el mismo código.

En CRM queda **Archivo de solicitudes**. GET de listado, detalle e imágenes conserva autorización y registros históricos; los demás métodos responden 410. `canManage` es falso: desaparecen formularios de cotización y botones específicos de anticipos. Cotizaciones POS, pedidos, pagos ordinarios, tickets, conversaciones y entregas no se retiraron.

### Navegación y encabezado

Navbar con exactamente Inicio, Categorías y Ofertas. Se conservan altura, tratamiento activo y área segura. Carrito sigue accesible desde el drawer y su acceso existente cuando contiene artículos. Logo oficial de la cabecera pasa de 124 a 114 px de ancho, manteniendo proporción y altura de barra.

PWA mantiene el botón de instalación; se retiró su repetición promocional y el globo que podía tapar contenido. No se quitó el comportamiento de instalación del navegador.

### Tarjetas

Se conservan contenedores y dimensiones de imagen. Debajo: categoría discreta, nombre limitado a dos líneas, precios y disponibilidad en texto. Se retiraron descripciones redundantes, fondos verdes, puntos decorativos y espacios artificiales. Carrito usa icono azul sin fondo sólido; cantidad, validaciones y feedback siguen funcionando. Los precios anteriores solo aparecen cuando el backend determina una oferta válida.

También se corrigió un desbordamiento real del carrito lleno a 320 px: información y controles se distribuyen en dos filas en móvil, conservando los cálculos y acciones.

### Categorías

Se reemplazó la cabecera convencional de esta página por una fila compacta de regreso y búsqueda compartida. Filtros funcionales en dos filas cortas, selección de categoría y orden. Grilla de tres columnas en móvil, cuatro en tablet y seis en escritorio; se muestran únicamente categorías reales. Las imágenes provienen del catálogo y tienen fallback ante error.

Después se muestran productos y paginación existentes. Relevancia prioriza destacados explícitos y productos disponibles; no se añadió una clasificación ficticia de ventas.

### Ofertas

Ruta `#/offers`, título compacto y filtros reales de categoría, destacados, precio, fecha, relevancia y mayor descuento. Cero ofertas muestra estado vacío con regreso al catálogo; una o dos muestran tarjetas sin carrusel; tres o más incorporan una selección horizontal seguida de grilla y carga incremental.

El carrusel usa scroll nativo táctil, botones anterior/siguiente, flechas de teclado y scroll-snap. No tiene autoplay y respeta movimiento reducido. Cada selección contiene productos distintos. El nuevo orden `discount` funciona en backend sobre descuentos vigentes calculados.

### Promociones diarias

Hasta dos productos publicados, autorizados, disponibles y con oferta vigente. Se reutiliza la tabla de selección diaria y la fecha comercial de República Dominicana. La selección permanece estable durante el día y rota utilizando el historial cuando hay candidatos suficientes. Sin ofertas se muestra un mensaje neutral; con una se muestra una, sin inventar otra.

Toda oferta válida participa automáticamente; se retiró de administración el checkbox anterior de participación individual para evitar un control que ya no representaba ese comportamiento. Su dato histórico no se borra. Precios, activación y fechas existentes siguen disponibles. Se endureció el cálculo contra valores no finitos o centavos inválidos.

### Drawer y ecosistema

Se mantiene la sección personal adaptada a la sesión. Se incluyen accesos reales a catálogo, ofertas, carrito, pedidos, perfil y atención por WhatsApp. Se eliminó el enlace de servicios que reutilizaba un filtro público ya no soportado.

Ecosistema secundario, con enlaces seguros en pestaña nueva:

- Phytoemagry: `https://phytoemagryrd.lat/`, establecido en configuración/documentación del proyecto.
- Fullpos Cloud: `https://fullpos.fulltechrd.com/`, registrado en `docs/SEO-RELEASE.md` y `docs/SEARCH-CONSOLE.md`. Su disponibilidad en HTTPS no pudo confirmarse: agotó el tiempo de espera. No se inventó otra URL.

### Integridad

La selección de tienda se aplica en la proyección del servidor y se conserva en inicio, búsqueda, categorías, ofertas, imágenes, detalle, SEO, carrito y checkout. Los tests verifican ambas tiendas y rechazan compras de artículos ajenos. El checkout conserva pedido pendiente de confirmación; no se añadió pasarela ni cobro obligatorio.

## D. Archivos modificados por este alcance

| Archivos | Propósito |
| --- | --- |
| `public/store/store.js`, `index.html` | Rutas, retiro del servicio, tarjetas, categorías, ofertas y navegación |
| `public/store/commerce-ui.css` | Refinamiento responsive, logo, grillas, carrusel, ecosistema y carrito |
| `public/store/sw.js` | Versionado de recursos y actualización de caché |
| `public/admin/index.html`, `store-requests.js` | Archivo histórico y retirada de controles activos |
| `public/admin/store.js` | Explicación de selección diaria automática |
| `server/store-account-routes.mjs` | Compatibilidad 410 para servicio retirado y conteo de sesión |
| `server/store-requests-admin-routes.mjs` | Acceso administrativo de solo lectura |
| `server/store-accounts.mjs` | Bloqueo de escrituras específicas de sourcing; conserva cambios de bienvenida anteriores |
| `server/store-catalog.mjs` | Elegibilidad diaria y precios finitos |
| `server/store-public-routes.mjs` | Orden por descuento real y relevancia disponible |
| `tests/store-accounts.test.js` | Retiro, conservación literal de historial/pagos y protección de autenticación |
| `tests/store-daily-offers.test.js` | Rotación entre días, ofertas automáticas y orden por descuento |
| `scripts/check-store-master-ui.mjs` | Capturas y verificaciones en ocho anchos |
| `scripts/check-store-customer-uat.mjs` | UAT de cliente adaptada al servicio retirado y vista aislada |

Los cambios previos de launcher transparente, detalle, Nosotros y bienvenida siguen presentes; no se descartaron ni se atribuyen como nuevas funciones de este alcance.

## E. Base de datos

**Sin migraciones nuevas ni borrado de datos.** Se reutilizan catálogo, publicaciones, selección diaria, cuentas y tablas de solicitudes existentes. La prueba de retiro inserta una solicitud histórica aislada con cotización y pago, bloquea modificaciones y comprueba que su JSON siga idéntico. No cambia pedidos, pagos normales, auditorías ni registros financieros.

Pruebas de backend con SQLite temporal. UAT local en `http://127.0.0.1:4177/store/`, con base temporal nueva y scheduler, WhatsApp, CAPI, correo, SMS y OAuth externos desactivados. La base de la previsualización anterior se conserva en su directorio temporal.

## F. Resultados de pruebas

Comandos ejecutados:

```text
npm test -- --reporter=json --outputFile=.tmp/full-suite-master.json
npm test -- --run tests/store-accounts.test.js tests/store-public-api.test.js tests/store-daily-offers.test.js tests/store-isolation.test.js tests/store-favorites.test.js tests/google-oauth-hardening.test.js tests/store-seo-indexing.test.js tests/store-checkout-uat.test.js tests/delivery-unified-flow-uat.test.js --reporter=json --outputFile=.tmp/store-master-targeted.json
npm test -- --run tests/store-accounts.test.js tests/store-checkout-uat.test.js tests/store-public-api.test.js tests/store-daily-offers.test.js tests/store-isolation.test.js tests/delivery-unified-flow-uat.test.js tests/delivery-assignment-notifications.test.js
npm run build
node --check public/admin/store.js
node --check public/admin/store-requests.js
git diff --check
```

- **Conjunto específico:** 86/86 aprobadas en nueve archivos; incluye checkout real contra CRM y el flujo unificado de reparto.
- **Suite completa:** 158 archivos; 132 aprobados y 26 fallidos. 2,169 pruebas aprobadas, 98 fallidas y 3 omitidas, sobre 2,270 ejecutadas/registradas en esa corrida. No se presenta como verde.
- Entre los fallos completos están panel, notificaciones, privacidad de agentes, offline y operaciones. No se diagnosticó cada fallo ni se afirma que todos sean anteriores.
- **Prueba ampliada de notificaciones de delivery:** 13 aprobadas y 2 fallidas: recordatorio único del supervisor y aviso tras reasignación. No se modificó el motor de notificaciones para ocultar esos fallos.
- **Build:** correcto, con siete advertencias existentes de contenido/configuración de la landing.
- **Sintaxis y diff:** correctos, sin errores de espacios al cierre.

El conjunto completo se ejecutó durante la integración. Tras el cierre se repitieron los archivos relevantes para las últimas modificaciones. Los JSON de resultados permanecen en `.tmp/` como evidencia local.

## G. Validación visual

Chromium real, viewports de 320, 360, 375, 390, 430, 768, 1024 y 1440 px de ancho, altura 844 px. Capturas `before-*` y `after-*` en `docs/capturas/store-master/`: inicio, categorías, ofertas, drawer, detalle y carrito. Los productos/categorías de esas capturas son fixtures interceptados solamente en el navegador; la persistencia y reglas comerciales se verificaron por separado contra el servidor real de UAT.

En cada ancho se comprobaron 0, 1, 2, 4 y 6 ofertas, grilla móvil de tres columnas, selección de categoría, regreso del navegador, teclado del carrusel, disponibilidad sin fondo, agregado al carrito y ausencia de formularios retirados. Sin errores JavaScript ni overflow horizontal al cierre. El carrito lleno recibió una comprobación adicional y corrección específica a 320 px. La captura inicial del carrito estaba vacía; la final también muestra la comprobación con artículos.

La UAT real de cliente pasó en 320×568, 375×667, 390×844, 412×915 y 430×932: registro, errores de guardado, persistencia, edición, favoritos, pedidos, logout/login, omisión persistente y rechazo 410 de sourcing. Resultados en `docs/capturas/customer-uat/results.json`.

Se inspeccionaron capturas representativas de móvil pequeño, ofertas y drawer. No se realizó validación física en iOS/Android ni inicio de sesión con una identidad Google real.

## H. Pendientes

1. **Icono definitivo de Ofertas no proporcionado/encontrado:** se utiliza un tag SVG provisional documentado en el HTML. No se considera activo final aprobado.
2. **Fullpos Cloud:** confirmar disponibilidad de la URL oficial registrada; no respondió a la comprobación HTTPS.
3. Resolver los fallos de la suite completa y de recordatorios de delivery antes de considerar producción.
4. Revisión del usuario y prueba en teléfono físico: teclado, gestos, áreas seguras e instalación real.

## I. Riesgos y mitigaciones

Los clientes antiguos que intenten crear solicitudes recibirán 410; el mensaje es explícito y la PWA tiene versión nueva. Los enlaces antiguos de la web llevan al catálogo. El archivo CRM conserva el acceso autorizado al historial y no permite modificaciones. La selección diaria ahora incorpora todas las ofertas válidas disponibles, comportamiento señalado en administración. Los casos de precio y vigencia siguen siendo del servidor.

La suite completa fallida y el enlace externo no verificado impiden recomendar un despliegue. No se hicieron cambios de configuración de OAuth ni del motor de reparto para resolver problemas ajenos al refinamiento.

## J. GO / NO-GO

| Área | Estado |
| --- | --- |
| Implementación en desarrollo | GO para revisión local; alcance implementado con icono provisional identificado |
| Pruebas específicas de tienda | GO, 86/86 |
| Suite automatizada completa | NO-GO, 98 fallidas en la corrida completa |
| UAT visual de navegador | GO para revisión local con fixtures y evidencias; falta aprobación final del usuario/dispositivo físico |
| Producción | **NO-GO**: icono definitivo, fallos automatizados, enlace externo y revisión física pendientes |

No se desplegó producción.
