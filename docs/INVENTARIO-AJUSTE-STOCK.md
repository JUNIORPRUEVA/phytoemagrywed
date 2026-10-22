# Inventario y ajuste de stock — cómo funciona hoy (auditoría)

**Fecha:** 2026-10-22 · **Alcance:** solo lectura + pruebas contra un servidor local aislado.
**No se ha cambiado ninguna lógica de inventario.**

La pregunta era concreta: *«tengo varios frascos; cómo maneja el sistema el ajuste de stock de un
producto como la pastilla»*. La respuesta corta es que en el sistema **conviven dos inventarios
distintos** y cuál se aplica depende de cómo esté dado de alta el artículo:

| | Presentaciones antiguas de Phytoemagry | Productos del catálogo (modernos) |
| --- | --- | --- |
| Qué es | `capsules_5`, `capsules_7`, `capsules_10`… (los siete frascos de Phytoemagry) | Cualquier artículo dado de alta en Catálogo |
| Unidad de stock | **cápsulas** (un saldo único compartido) | **unidades vendibles** (1 frasco = 1 unidad) |
| Dónde vive | `inventory_movements` (producto `phytoemagry`) | `fulltech_catalog_v1.quantity` + `fulltech_stock_movements_v1` |
| Se toca desde | «Ajuste de stock» con la etiqueta **Cantidad de cápsulas** (las filas dicen «Saldo compartido de cápsulas») | «Ajuste de stock» con la etiqueta **Cantidad de unidades** |
| Recuento físico | **no aparece** en la pantalla de Recuento (el endpoint existe, la pantalla no lo ofrece) | sí: «Unidades contadas» |
| Costo | costo **por cápsula** (RD$126.66 por defecto) × cápsulas de la presentación | costo **por unidad** del artículo |

---

## 1. Las presentaciones antiguas: un solo saldo en cápsulas

Las siete presentaciones (`5, 7, 10, 15, 20, 30, 60 cápsulas`) **no tienen stock propio**. Todas
comparten un único saldo en **cápsulas**, y los frascos disponibles se calculan:

```
frascos completos de una presentación = floor(saldo_en_cápsulas / cápsulas_de_la_presentación)
```

Medido en un servidor limpio, tras una entrada de **25 cápsulas** (`POST /api/admin/inventory/adjust`,
`{direction:'in', quantity:25}`):

| Presentación | cápsulas por frasco | Frascos que muestra | Saldo compartido |
| --- | --- | --- | --- |
| Phytoemagry · 5 cápsulas | 5 | 5 | 25 cáps. |
| Phytoemagry · 7 cápsulas | 7 | 3 | 25 cáps. |
| Phytoemagry · 10 cápsulas | 10 | 2 | 25 cáps. |
| Phytoemagry · 15 cápsulas | 15 | 1 | 25 cáps. |
| Phytoemagry · 20 cápsulas | 20 | 1 | 25 cáps. |
| Phytoemagry · 30 cápsulas | 30 | 0 | 25 cáps. |
| Phytoemagry · 60 cápsulas | 60 | 0 | 25 cáps. |

**Consecuencias prácticas:**

- Ajustar («Ajuste de stock») una presentación antigua **suma o resta cápsulas**, no frascos. La
  pantalla lo dice: al elegir «Phytoemagry · 5 cápsulas» el campo pasa a llamarse **«Cantidad de
  cápsulas»** y la vista previa dice «Registrado 25 · Ajuste +1 · Quedará 26». Si escribes 3, estás
  metiendo **3 cápsulas** (no 3 frascos).
- Vender 2 frascos de 10 descuenta **20 cápsulas** del saldo compartido.
- Las cápsulas que sobran de un frasco **no se ven** en la lista: con 25 cápsulas, la presentación de
  10 muestra «2 frascos» y las 5 cápsulas sueltas solo aparecen en el saldo cuando abres la ficha.
- El recuento físico de cápsulas **no está en la pantalla de Recuento** (su tabla excluye las
  presentaciones antiguas a propósito). El endpoint `POST /api/admin/inventory/count` sí lo hace.

## 2. Los productos modernos: una cantidad por artículo (unidades)

Cada artículo del catálogo lleva su propia `quantity` en **unidades vendibles** (un frasco, una caja,
un servicio no lleva), con `min_stock` y `cost_cents`. Se guarda en `fulltech_catalog_v1` y cada
cambio deja un movimiento en `fulltech_stock_movements_v1` con `quantity_before`, `quantity_after`,
tipo, motivo, quién y `operation_key`.

Medido en el mismo servidor:

| Acción | Resultado |
| --- | --- |
| Alta con **5** unidades | `quantity: 5` |
| Ajuste **salida 2** («Rotura») | `quantity: 3` |
| **Recuento** contando **4** (esperaba 3) | `quantity: 4` |
| Recuento con `expected` viejo | **409** `stale_count` — «El stock cambió durante el recuento» |
| Salida de **99** con 4 en stock | **409** `insufficient_stock` — «hay 4 unidades» |

Detalles del ajuste moderno (`POST /api/admin/store/products/:id/stock`):

- Tipos: `in` (entrada), `out` (salida), `count` (recuento que **fija** el valor contado).
- `requestId` obligatorio y **idempotente**: repetir la misma petición no duplica el movimiento.
- Nunca deja stock negativo; si el producto es un servicio, se rechaza (`service_has_no_stock`).
- Si el artículo es una presentación antigua, el endpoint responde **422 `legacy_stock`** y manda al
  control de cápsulas. La pantalla evita ese error porque decide la ruta según el artículo.

## 3. Qué pasa al vender

- **Productos modernos** (`server/store-catalog.mjs → syncSale`): por cada artículo se recalcula el
  objetivo (`target = suma de cantidades de las líneas del pedido`), se resta lo ya vendido de ese
  pedido (`sold`) y solo se aplica **la diferencia**. Eso hace que editar una venta, entregarla dos
  veces o corregirla **no descuente dos veces**; y si se quitan líneas, devuelve el stock
  (`SALE_REVERSAL`). Nunca deja `quantity` negativa (409 `insufficient_stock`).
- **Presentaciones antiguas** (`server/inventory.mjs → syncSale`): se descuentan
  `total_capsules = cápsulas_por_frasco × cantidad` de **cada línea**, contra el saldo compartido, con
  la misma lógica de diferencia (`SALE` / `SALE_REVERSAL`) y con bloqueo (`withInventoryLock` +
  `pg_advisory_lock` en PostgreSQL) para que dos ventas simultáneas no se pisen.
- El costo histórico se congela en cada línea (`unit_cost_snapshot_cents`), así que cambiar el costo
  después no reescribe la ganancia de ventas pasadas.

## 4. Hallazgos y riesgos

| # | Hallazgo | Gravedad | Qué haría |
| --- | --- | --- | --- |
| 1 | **Dos inventarios en paralelo** (cápsulas vs unidades) con dos juegos de tablas y endpoints. Funciona, pero es la raíz de la confusión al contar. | Media (diseño) | Documentarlo en la pantalla (ya se hace parcialmente) y unificar a medio plazo en un solo modelo con «unidades por empaque». |
| 2 | **Recuento de cápsulas no disponible en la pantalla**: `#view-recuento` solo lista productos modernos, así que el recuento físico de Phytoemagry no se puede hacer desde ahí aunque el endpoint exista. | Media (operativa) | Añadir las presentaciones antiguas al recuento llamando a `/inventory/count` (el código ya está preparado). |
| 3 | **Frascos parciales invisibles**: con 25 cápsulas y presentación de 10 se muestran 2 frascos; las 5 cápsulas sueltas no se ven hasta abrir la ficha. | Baja | Mostrar «2 frascos + 5 cáps.» en la fila del saldo compartido. |
| 4 | **Costo en dos unidades distintas** (por cápsula en legacy, por unidad en moderno). Un cambio de costo en un mundo no toca al otro. | Baja | Dejar claro en la ficha qué unidad es cada costo (la ficha de cápsulas ya dice «Costo/cáps.»). |
| 5 | **No hay conversión automática** frasco → cápsulas: si alguien da de alta «30 cápsulas» como producto moderno, vender 1 descuenta **1 unidad**, no 30 cápsulas. | Media (si se mezclan modelos) | Regla: las presentaciones de Phytoemagry se quedan como legacy; lo nuevo que sea «por frasco» se da de alta como producto moderno con stock en frascos. |
| 6 | El ajuste legacy usa `idempotencyKey`, el moderno `requestId`: dos nombres para lo mismo. | Baja (técnica) | Unificar nombres al refactorizar. |

## 5. Recomendación operativa (para lo de hoy)

- **Frascos de Phytoemagry**: usa «Ajuste de stock» eligiendo la presentación; recuerda que el número
  es de **cápsulas** (el campo lo dice). Para fijar un saldo real, `POST /api/admin/inventory/count`
  (o pídeme que lo ponga en la pantalla de Recuento).
- **Cualquier otro producto**: el número es de **unidades** (frascos/cajas), con entrada, salida o
  recuento, y queda su historial con motivo y autor.

## 6. Evidencia

- Código: `server/inventory.mjs` (`BASE_UNIT='capsule'`, movimientos y `syncSale` de cápsulas),
  `server/store-catalog.mjs` (`adjust`, `checkOrder`, `syncSale` por producto),
  `public/admin/store.js` (pantallas «Ajuste de stock» y «Recuento»).
- Pruebas en verde: `tests/inventory-reports.test.js` y `tests/store-catalog.test.js`
  (**34 pasan, 1 omitida**), incluida «editar una venta entregada solo mueve la diferencia y conserva
  su costo histórico».
- Medición reproducida en un servidor local con base temporal (los números de las tablas de arriba).
