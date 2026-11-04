# Red de tiendas y recogidas: arquitectura propuesta

> Actualización 2026-11-03: la tabla de auditoría y el párrafo de «Estado de
> esta rama» reflejan el punto de partida. El avance implementado más reciente
> está en [PLAN-IMPLEMENTACION-POR-BLOQUES.md](PLAN-IMPLEMENTACION-POR-BLOQUES.md):
> tarifa vial al cliente, pago y comisión courier separados, snapshots, libro
> de ganancias y pantallas Flutter administrativas ya existen en esta rama
> aislada. Aún no se han integrado en el UAT compartido ni en Delivery móvil.

Fecha: 2026-11-03. Contrato de diseño para el flujo único de Ventas y Entregas. Estado: **NO-GO operativo** hasta reconciliar el backend UAT y aprobar los contratos por archivo. Este documento no autoriza migraciones, precios ni comunicaciones automáticas.

**Avance aislado al 2026-11-03:** tienda reutilizable por empresa, vínculo
producto–tienda, filtro en Ventas, snapshot de recogida, tarifa vial al cliente,
remuneración separada, bloqueo de pedido multitienda y contacto operativo
mediado por CRM ya tienen código y pruebas dirigidas en
`crm-delivery-architecture`. Flutter CRM contiene pantallas de tiendas,
productos relacionados, reglas y liquidaciones. Fulltech Delivery tiene GPS
de recogida/destino y pantalla «Contactar tienda» en el worktree aislado
`fulltech-delivery-network`. El hilo aún requiere intervención de un operador;
ninguna tienda externa recibe mensajes automáticamente. Estos cambios no están
integrados en las sesiones propietarias ni en el servidor compartido. UAT
integral y aprobación de contratos siguen pendientes.

## Auditoría del punto de partida

| Necesidad | Reutilizable hoy | Brecha comprobada |
|---|---|---|
| Tienda reutilizable | `suppliers`, `normalizeSupplier`, `/api/admin/suppliers` | Faltan aislamiento obligatorio por `company_id`, tipo, WhatsApp, responsable e instrucciones. La clave de duplicado usa nombre y teléfono; el teléfono no puede ser identidad. `DELETE` físico rompe referencias históricas. |
| Producto en varias tiendas | `product_suppliers`, índice único `link_key`, `/api/admin/products/:id/suppliers` | Faltan tenant, precio comercial autorizado y estado del vínculo. Ya existen referencia, costo, disponibilidad y fecha de verificación. Preservar catálogos Phyto y Fulltech. |
| Compras por tienda | `order_pickups`, `groupItemsBySupplier` | Son grupos de abastecimiento; no equivalen a paradas aceptadas por courier. Falta snapshot versionado de la ubicación. |
| Ubicación del cliente | `locations`, `order.delivery.location` | Confirmar pertenencia de cliente y empresa; fijar snapshot de destino. |
| Distancia | `createRoadRouter`, proveedor OSRM compatible HTTPS | No existe tarifa general basada en ruta vial verificable. Si falla la ruta, bloquear cálculo automático y exigir intervención autorizada; nunca sustituir por línea recta. |
| Dinero | `/api/admin/delivery-rate`, pagos, custodia y políticas courier del backend candidato | Revisiones divergentes; falta regla compartida, versionada y separada de tarifa cliente, remuneración y comisión. |
| Contacto | WhatsApp del cliente y mensajería operativa | No hay conversación segura repartidor-tienda. La revisión de origen de `suppliers` permite lectura courier y devuelve `phone`; esta rama aislada bloquea esas rutas para courier, aún sin integrar al backend destino. |

## Modelo mínimo y migración

1. Reutilizar `suppliers` como **Tiendas de recogida**, con ID estable y `company_id` obligatorio. Ampliar tipo (tienda/proveedor/almacén/otro), dirección, GPS, mapa, horario, responsable, instrucciones, activo y fechas. Guardar teléfono y WhatsApp como campos privados. La deduplicación será por empresa, nombre normalizado y dirección o identificador comercial verificado, con revisión de coincidencias; nunca teléfono como identificador principal. Asignar empresa a filas antiguas mediante migración auditada antes de mostrarlas. Inactivar en vez de borrar tiendas referenciadas.
2. Reutilizar `product_suppliers` como relación muchos a muchos. Conservar ID de producto y tienda, referencia/código local, costo, disponibilidad, fecha de verificación y notas. Añadir `company_id`, precio comercial autorizado, vigencia y estado. La clave única debe incluir empresa y ambos IDs. El producto conserva el catálogo Phyto o Fulltech. La disponibilidad declarada por un tercero no equivale a stock físico propio; no descontar inventario externo.
3. Conservar `order_pickups` para abastecimiento. Para ejecución logística, añadir paradas versionadas ligadas a `order_id` y reparto: tipo `pickup`/`dropoff`, secuencia, tienda opcional, nombre/dirección/GPS/instrucciones como snapshot, estado y fechas. V1 usa una recogida y una entrega; la estructura admite más paradas. Si las líneas apuntan a varias tiendas, bloquear la oferta de una sola recogida hasta dividir el cumplimiento o admitir ruta multiparada. Cambios tras aceptación exigen actor autorizado, nueva versión, recálculo, aviso y nueva aceptación según política.
4. Reutilizar pagos, `delivery_cash_ledger` y `courier_earnings`; reconciliar políticas versionadas por empresa y zona. Snapshot por reparto: versión, metros de ruta, proveedor, origen/destino, desglose en centavos, moneda y fecha. Tarifa al cliente, remuneración courier y comisión adicional quedan separados. La comisión opcional se calcula sobre productos netos elegibles, excluyendo delivery; tratamiento de impuestos, descuentos, devoluciones y redondeo debe aprobarse. Sin política aprobada no generar importe inventado. La remuneración no reduce automáticamente la custodia.
5. Contacto seguro requiere conversación operativa separada y particionada por empresa, pedido, tienda y repartidor. Cuando la tienda no tenga acceso, el CRM presenta solicitud al operador para mediar. No usar el hilo comercial del cliente ni enviar al teléfono privado sin autorización.

## Contratos por superficie

| Superficie | Contrato requerido | Autoridad y privacidad |
|---|---|---|
| Entregas > Tiendas de recogida | Lista/búsqueda, alta, edición, inactivación y productos vinculados, reutilizando `/api/admin/suppliers` tras migración | Empresa en cada consulta y mutación; teléfono/WhatsApp solo para roles CRM autorizados. |
| Ventas único | Filtro Tienda y productos por tienda; línea de ticket retiene `supplier_id`, `product_supplier_id` y referencia de precio | Backend verifica vínculo, empresa, precio y disponibilidad; propone origen si las líneas coinciden. Sin carritos paralelos. |
| Pedido y reparto | Destino confirmado, parada(s) y snapshots; `requestId` y versión | Cotizar no crea reparto ni descuenta stock. Pedido multitienda requiere resolución explícita. |
| Entregas > Reglas de entrega | Política administrativa versionada y cotización calculada en servidor con ruta vial y desglose | Roles de edición distintos del operador; excepciones auditadas; importe Flutter no es autoridad. |
| Delivery | DTO con próxima parada: nombre, dirección, GPS, referencia e instrucciones; acción Contactar tienda solo en canal operativo | Lista blanca: sin teléfono/WhatsApp privado, costo de adquisición ni URL con número, incluso en JSON, errores, logs, notificaciones y caché offline. |
| CRM supervisor | Conversación operativa por pedido y mediación, separada del cliente | Rol y empresa aplicados en servidor. |

## Flujo y secuencia

El empleado trabaja en el mismo editor de Ventas: productos → modalidad → tienda propuesta o seleccionada → destino confirmado → cotización vial y pago → repartidor → confirmar. Tiendas de recogida y Reglas de entrega se administran dentro de Entregas. Delivery muestra la próxima parada y el canal operativo cuando exista.

Estado de esta rama al 2026-11-03: se reutiliza el formulario PWA de tiendas con empresa obligatoria; POS Flutter conserva la tienda elegida por línea y el backend rechaza un producto externo sin origen. La asignación bloquea un origen sin GPS y las respuestas al agente no contienen costo del vínculo. Smart Commerce no cotiza automáticamente cuando falta una tarifa explícita. Falta unificar esa política con `delivery_rate`, definir tarifa por carretera y remuneración/comisión del repartidor, implementar paradas y comunicación operativa, y completar UAT. El campo `defaultOriginId` legado de Smart Commerce aún necesita una migración de contrato para eliminar su supuesto de origen habitual sin alterar cotizaciones existentes.

1. **A:** Reconciliar backend UAT, contratos de las tres apps, permisos y migración tenant; cerrar la fuga de `suppliers` antes de exponer Delivery.
2. **B:** Migrar `suppliers` y proyecciones por rol/empresa; alta, reutilización, edición e inactivación sin alterar históricos.
3. **C:** Migrar `product_suppliers`, preservar catálogos e inventario propio/externo.
4. **D:** Filtro Tienda y asociación de línea en POS único; bloqueo multitienda sin ruta compatible.
5. **E:** Políticas versionadas, ruta vial y snapshots; tarifa cliente y remuneración separadas.
6. **F:** Comisión opcional, descuentos, devoluciones, redondeo y pruebas al centavo.
7. **G:** Paradas y DTO seguro a Delivery; aceptación única y cambios de ruta autorizados.
8. **H:** Canal operativo de tienda mediado por CRM y probado contra exposición privada.
9. **I:** Cobro contra entrega, custodia, rendición y remuneración independientes.
10. **J:** UAT integral y conciliación de las tres apps sin datos de producción.

Cada fase se integra tras aprobar las invariantes de la anterior; los cambios de otras sesiones se revisan por archivo.

## Avance de implementación aislada

La rama `feat/crm-delivery-architecture` ya contiene parte de B–D: esquema aditivo `company_id` en tiendas y vínculos, rutas con alcance por empresa, contacto privado fuera de la proyección ordinaria, atribución administrativa explícita de filas históricas, filtro Tienda en el POS Flutter y vínculo validado por el checkout. Una tienda única queda guardada como snapshot de recogida; dos tiendas bloquean la asignación/envío de una sola ruta. Estas piezas no están integradas al backend UAT ni constituyen aprobación de los bloques B–D. El precio por tienda que difiere del catálogo se rechaza hasta implementar cálculo autorizado; no se cobra un valor ambiguo.
