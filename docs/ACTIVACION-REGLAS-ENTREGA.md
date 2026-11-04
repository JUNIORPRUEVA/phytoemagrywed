# Activación de reglas de entrega por empresa

Estado: configurables, desactivadas por decisión comercial. No hay importes de producción cargados.

## Dónde se editan

En el CRM Flutter, **Entregas → Reglas de entrega** (solo administración), elegir
la empresa. Hay dos reglas independientes:

- **Tarifa al cliente:** cobertura máxima, mínimo, base y RD$ por kilómetro.
- **Pago al repartidor:** base, mínimo, RD$ por kilómetro y comisión opcional
  sobre productos. El 0 % desactiva la comisión.

Los importes se muestran en pesos dominicanos y se guardan como centavos
enteros. Cada regla se guarda por separado. El servidor calcula los importes;
Flutter solo presenta la configuración y el resultado.

## Fórmulas

- Cliente: `máximo(mínimo, base + redondear_hacia_arriba(metros × tarifa_km / 1000))`.
- Repartidor: `máximo(mínimo, base + redondear_hacia_arriba(metros × pago_km / 1000))`
  más `redondear(productos_netos × porcentaje / 100)`.
- La comisión usa las líneas vendidas netas: excluye delivery, descuentos,
  impuestos informados y líneas canceladas o devueltas. El efectivo cobrado
  al cliente permanece en custodia y no se compensa automáticamente con el pago
  del repartidor.

La distancia procede de una ruta vial con proveedor identificado. No se
sustituye por distancia en línea recta. La cotización guarda la tarifa y la
ruta utilizadas; modificar la regla invalida las cotizaciones abiertas.

## Antes de activar

1. Definir para **cada empresa** la tarifa al cliente en RD$/km, el pago al
   repartidor en RD$/km, el porcentaje de productos, bases, mínimos y cobertura.
2. Verificar el proveedor vial, el GPS de las tiendas y el destino confirmado
   del cliente. La tienda PWA requiere además una fuente real de capacidad de
   reparto; sin ella solicita revisión manual.
3. Guardar primero las dos reglas desactivadas, revisar los valores y activar
   cada una. Una regla compartida desactivada impide que una tarifa histórica
   de la PWA se aplique por accidente.
4. Validar en UAT un pedido por empresa desde Flutter: cotización, cambio de
   tarifa que invalida una cotización vieja, asignación, entrega, comisión,
   custodia y rendición. Revisar que la app Delivery no reciba el teléfono
   privado de la tienda.

**No declarar GO** hasta disponer de valores aprobados, proveedor vial y
capacidad operativos, pruebas del backend y Flutter aprobadas y UAT de Flutter
CRM y Delivery. El panel PWA no forma parte de esta liberación; no eliminarlo
antes de comprobar que ninguna ruta compartida por Flutter depende de él.

## Validación local del 3 de noviembre de 2026

- Flutter: 237 pruebas aprobadas; 4 UAT omitidas. La prueba de Reglas de entrega
  confirma que la tarifa al cliente y la comisión del repartidor se guardan por
  empresa en centavos y permanecen desactivadas.
- Node: 77 pruebas focalizadas de tarifas, comercio, asignación y avisos
  aprobadas. Se corrigió el enlace de avisos y la reanudación del agente tras
  un mensaje humano.
- Regresión general de Node: 2.584 aprobadas, 89 fallidas y 3 omitidas de
  2.676. Los 89 fallos restantes son recorridos, selectores o almacenamiento
  sin conexión del panel PWA; se registran aparte y no bloquean la liberación
  de Flutter. No se observó un fallo en las pruebas de API que completaron;
  esto no sustituye el UAT completo de Flutter y Delivery.
