# Plantilla comercial Fulltech

Se reproduce la distribución A4 del PDF de referencia facilitado por el usuario:
logo tridimensional del negocio, razón social, RNC, teléfono y dirección;
recuadro superior de documento y fechas; datos del cliente; tabla de descripción,
cantidad, precio unitario, ITBIS y total; notas y resumen; total azul y pie
«FullPOS Cloud» con numeración de páginas.

Datos del emisor tomados de la referencia: FULLTECH, SRL, RNC 133080206,
teléfono 8295319442 y dirección Centro calle beller 9 local n2 higuey la
altagracia R.D. Cotizaciones y facturas usan el mismo generador vectorial,
tanto en servidor como en el dispositivo sin internet. El logo está embebido;
las tres fuentes del visor quedan incluidas en la preparación offline.

Cada documento conserva su número, cliente, artículos e importes. Las
cotizaciones muestran vencimiento a 15 días cuando no existe una fecha explícita;
las facturas muestran su forma de pago. Los descuentos generales se distribuyen
entre las líneas en centavos sin alterar el total registrado. Se mantienen el
descuento por artículo, delivery, envío y las notas cuando existen. Los pedidos
pendientes y facturas canceladas conservan su indicación; los recibos locales
siguen marcados como provisionales hasta sincronizar.

Las facturas mantienen el teléfono del cliente enmascarado; las cotizaciones
muestran el teléfono asociado al cliente. No se añaden NCF ni impuestos nuevos
a la lógica de ventas. Los documentos locales conservados se regeneran con la
nueva plantilla cuando se abren; el PDF del servidor se actualiza al descargar
de nuevo la copia offline.

Validación: 76 pruebas aprobadas en ocho archivos con PostgreSQL local aislado;
18 comprobaciones finales de plantilla, estados, visor y arranque aprobadas.
Compilación aprobada. Cotización y factura de muestra renderizadas e inspeccionadas
visualmente contra la referencia; comprobados nombres largos, cien artículos,
varias páginas, logo y conservación de importes. Las muestras quedan localmente
en `output/pdf/`, excluidas de Git y del contexto Docker.
