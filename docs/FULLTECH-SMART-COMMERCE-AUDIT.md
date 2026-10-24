# Auditoría previa — FULLTECH Smart Commerce

23 de octubre de 2026. Trabajo local sobre el árbol existente con cambios anteriores conservados. No se usan BD de producción, mensajes reales, pagos reales ni despliegues.

## Arquitectura verificada

- Frontend: `public/store/store.js`, módulos ES y hojas compartidas; carrito único `fulltech_cart_v1` con ID/cantidad. Precios obtenidos del servidor.
- Servidor: `server/crm-server.mjs`, rutas separadas de cuenta, catálogo, proveedores y delivery. Cuentas de tienda con cookie propia, permisos administrativos separados.
- Persistencia: PostgreSQL/SQLite y fallback JSONL. `createSqlQuery` y migraciones aditivas existentes. El catálogo posee transacciones y un lock de pedidos por proceso.
- Pedidos: `createStoreOrder` -> `createOrderUnlocked` -> `purchaseRow`. ID idempotente por cliente/requestKey, snapshots, etiqueta «Pedido tienda». No crear otro motor de pedidos.
- Catálogo: `fulltech_catalog_v1`, publicación y aislamiento por storefront. Inventario global por SKU; la venta y movimientos están coordinados por `store-catalog`.
- Proveedores: colección `suppliers`, enlaces `product_suppliers` y `order_pickups`. Estas recogidas representan compras del repartidor, **no** autorización de retiro de un cliente.
- GPS: `locations.mjs`, `customers.saveLocation/listLocations`; datos sensibles con propietario y procedencia.
- Dinero: `order-payments.mjs` separa cobro, verificación y rendición. Una transferencia reportada no equivale a pagada.
- Reparto: contratos CRM existentes, supervisor determinista y tracking. No hay evidencia de una interfaz transaccional de capacidad que pueda garantizar un courier disponible para checkout.

## Clasificación

| Área | Estado inicial | Decisión |
| --- | --- | --- |
| Carrito, cuentas, publicación, aislamiento | Implementado / reutilizable | Conservar |
| Pedido tienda y clave idempotente | Implementado / reutilizable | Extender con cotización validada, sin segundo pedido |
| GPS y direcciones en CRM | Parcial / reutilizable | Reutilizar datos, solicitar GPS solo por acción explícita |
| Tarifa 100/50 por 500m y límite 15km | Faltante en checkout | Motor puro con enteros y tests de frontera |
| Rutas viales y polígonos comerciales | Faltante | Adaptador configurable, ninguna ciudad activada automáticamente |
| Sucursales, orígenes, reglas regionales | Parcial / faltante | Configuración aditiva asociada a proveedores/productos reales |
| Cotización y aceptación de cargos | Faltante | Persistencia con propietario, caducidad, versiones y snapshots |
| Pagos y verificación | Implementado / reutilizable | Solo intención en checkout; libro existente sigue siendo autoridad |
| Stock por ubicación y reservas | Faltante / alto riesgo | No crear un stock paralelo que contradiga el inventario actual |
| Código de retiro y entrega atómica | Faltante / alto riesgo | Bloqueado hasta contrato con reservas y autorización de sucursal |
| WhatsApp a proveedores | Parcial / alto riesgo | No enviar; fallback administrativo y estados sin «enviado» ficticio |
| Multi-origen / interciudad | Parcial | Solicitud de cotización, nunca precio local inventado |

## Límites de seguridad

Las funciones nuevas estarán apagadas por defecto. Configurar no activa ciudades ni proveedores por omisión. Sin proveedor vial/capacidad operativa se mostrará cotización pendiente, no entrega garantizada. GPS de navegación y destino confirmado serán separados; no se guarda una preferencia sin consentimiento.

No se activará retiro automatizado ni se presentará el inventario como reservado sin resolver la coordinación transaccional con el motor existente. El alcance final y sus pendientes se documentarán separadamente de lo probado.
