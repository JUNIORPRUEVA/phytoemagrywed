# Comprobante PDF sin conexión

La venta offline guardaba HTML imprimible, pero no bytes PDF. Además, abrir una
página nueva en `/api/admin/.../receipt` salía del alcance `/admin/` del service
worker, por lo que la navegación podía fallar sin red aunque existiera una copia.

Ahora se genera el PDF vectorial en el dispositivo con el mismo generador del
servidor. Se guarda como `application/pdf` en IndexedDB, junto con el documento
comercial. No incluye ganancias ni costos internos. El número sigue siendo
provisional hasta sincronizar la venta.

Los enlaces de Facturación, Pedidos, cotizaciones y tickets abren el visor
`/admin/receipt-viewer.html`, dentro del alcance de la PWA. Este dibuja todas las
páginas del PDF mediante PDF.js, sin depender de un visor nativo, Google Drive
ni una CDN. El módulo, worker y fuentes necesarias se descargan con la app.
Permite descargar, compartir mediante las aplicaciones del dispositivo e imprimir;
el envío externo de WhatsApp sigue necesitando internet.

Se pueden reconstruir comprobantes locales anteriores cuando su documento sigue
en la cola pendiente. Los PDF de ventas del servidor se descargan anticipadamente
al preparar la copia offline. Se conserva el acceso separado por cuenta y la
ventana de 24 horas.

Validación: 71 pruebas aprobadas en ocho archivos, incluyendo PostgreSQL local,
cobro offline, reapertura desde IndexedDB, lectura del PDF con el motor real,
renderizado multipágina, privacidad de costos, enlaces dentro del alcance PWA,
arranque móvil y empaquetado Docker. Compilación y revisión de contenido aprobadas.
Se renderizó e inspeccionó visualmente un comprobante de prueba. No hubo un
navegador conectado disponible; falta verificar la actualización en el teléfono.

Referencia del visor: [ejemplos oficiales de PDF.js](https://mozilla.github.io/pdf.js/examples/).
