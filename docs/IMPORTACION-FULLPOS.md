# Importación FULLTECH (FullPOS / DaleVentas) → CRM

Procedimiento, decisiones de mapeo y conciliación. **La importación a producción NO se ha
ejecutado**: requiere autorización tras revisar el dry-run.

## 1. Origen de los datos

| Dato | Valor |
| --- | --- |
| Servidor | `31.97.99.70` (SSH con clave autorizada, solo lectura) |
| Base de datos | PostgreSQL `daleventa` en el contenedor `daleventapos_database` |
| Empresa | **FULLTECH, SRL** — `companies.id = 165e3fca-6225-479b-8805-d2205f10536c` |
| Validación | `app_config.rnc = 133080206` (coincide exactamente) |
| Alcance | Solo filas con `company_id = 165e3fca-…`. La base es multi-empresa (36 empresas): no se ha leído ni escrito nada de las demás. |

Consultas ejecutadas: `SELECT` con filtro por `company_id`. Ni un `INSERT`, `UPDATE` ni `DELETE`.
No se ha extraído ninguna tabla financiera (ventas, pagos, facturas).

## 2. Volcado obtenido

| Tabla | Filas | Contenido |
| --- | --- | --- |
| `Client` | 227 | nombre, teléfono, teléfono normalizado, email, dirección, notas, RNC, razón social |
| `Product` | 110 | nombre, categoría, costo, precio, código, stock, `track_inventory`, unidad |

Archivos locales (en `data/`, ignorado por git): `clients.ndjson`, `products.ndjson`.

**Codificación**: la primera extracción salió con los acentos rotos porque PowerShell 5.1 decodifica
la salida de `ssh` con la página de códigos del sistema. Se corrigió fijando
`[Console]::OutputEncoding = UTF8` antes de la tubería. Comprobado: 0 secuencias inválidas.

## 3. Modelo del CRM: qué se toca y qué no

El CRM guarda clientes y productos como **documentos JSON**, así que la clasificación nueva es
**aditiva y compatible hacia atrás**: no hay `ALTER TABLE`, no se renombra nada y los registros
existentes siguen siendo válidos sin tocarlos.

| Entidad | Campo añadido | Compatibilidad |
| --- | --- | --- |
| Cliente (`phytoemagry_customers`, doc) | `groups: [string]`, `business_name`, `tax_id`, `external_ids`, `imported_from` | Si el campo no existe se interpreta `['PHYTOEMAGRY']`: los clientes actuales quedan clasificados sin migrarlos. |
| Producto (`fulltech_catalog_v1`, doc) | `business_group`, `external_ids`, `imported_from` | Los 7 productos existentes no se tocan. |
| Categoría (`fulltech_categories_v1`, doc) | `business_group` | Mismo criterio. |
| Inventario | `track_stock` (ya existía) | `false` = «sin control de inventario». No se creó ningún campo nuevo ni se modificó el flujo de stock. |

## 4. Deduplicación

- Normalización con la función del propio CRM (`normalizePhone`): dígitos, se descarta `00` inicial,
  se añade el país 1 a los 10 dígitos, se rechazan los de menos de 8.
- 227 filas → **221 clientes únicos**; **6 con teléfono inválido** (no identifican a nadie: se
  quedan fuera y se listan en el informe).
- Comparación contra los **40 clientes reales de producción** (solo se exportaron sus teléfonos
  normalizados; ningún nombre ni dato adicional).
- Resultado: **8 ya existen** (se les añadirá el grupo, conservando id, conversación, pedidos e
  historial) y **213 nuevos**.
- Dentro del volcado no había teléfonos repetidos.

## 5. Clasificación propuesta

FullPOS **no distingue** ventas generales de sistemas de seguridad: es un mismo catálogo con una
columna de categoría de texto. Por eso:

- **Clientes**: todos entran como `FULLTECH — Ventas generales`, salvo que el nombre, la razón
  social o las notas contengan palabras de seguridad (cámara, CCTV, DVR, NVR, alarma, vigilancia,
  monitoreo, control de acceso…). El grupo es una **propuesta** y está marcado como tal.
- **Productos**: el grupo se deduce de la categoría y del nombre. 59 → ventas generales,
  44 → sistemas de seguridad, en 7 categorías reales del Excel/origen.
- **Inventario**: todos los productos entran con `track_stock: false` («sin control de
  inventario») y existencias 0. En FullPOS **102 de 103** llevan control de stock, pero ese
  saldo no es un almacén físico de PHYTOEMAGRY: no se traslada.

## 6. Resultado en UAT (ejecutado)

| Concepto | Antes | Después |
| --- | --- | --- |
| Clientes | 11 | **232** (11 + 221) |
| Conversaciones | 11 | 232 |
| Productos | 7 | **110** |
| Categorías | 1 | **8** |
| Teléfonos duplicados | 0 | **0** |

Idempotencia comprobada: la segunda ejecución dio `created: 0`, `unchanged: 221`,
`skipped_existing: 103`, `existing: 7`. Dos filas de auditoría (una por ejecución), con origen,
fecha y totales.

Los 11 clientes de demostración **no se modificaron**: siguen sin `groups`, por tanto cuentan como
PHYTOEMAGRY.

## 7. Cómo se repite

```powershell
# 1. Analizar (no escribe nada)
node scripts/fullpos-dry-run.mjs --existing-phones=data/uat/import/fullpos/prod-phones.txt

# 2. Simular la importación (trabaja sobre una copia temporal)
node scripts/fullpos-import.mjs

# 3. Aplicar sobre la base indicada
node scripts/fullpos-import.mjs --apply --db=data/uat/phyto-uat.sqlite
```

## 8. Antes de producción (pendiente de autorización)

1. Copia de seguridad verificable de la base del CRM (`pg_dump` del contenedor `ventas_studio-db`,
   base `phytoemagry`) y restaurarla en un entorno de prueba para confirmar que abre.
2. Volver a generar `prod-phones.txt` el mismo día de la importación (puede haber clientes nuevos).
3. Ejecutar el importador contra producción con `--apply` (los 8 duplicados se fusionan por grupo).
4. Verificar: 40 → 253 clientes, 0 teléfonos duplicados, 7 → 110 productos, 8 categorías,
   y que los 40 clientes anteriores conservan nombre, teléfono y pedidos.
5. Ejecutar por segunda vez y comprobar que no crea nada (idempotencia).

## 9. Pendiente de desarrollo (no bloquea los datos)

- Selector de grupos en la ficha del cliente y filtro por grupo en la lista.
- Etiquetas compactas de grupo en la lista y en el perfil.
- Filtro de productos por grupo de negocio y política de inventario.
- Distinguir visualmente **«Sin control de inventario»** de **«Agotado»**.
- Administración de categorías con su grupo de negocio.

## 10. Decisiones aplicadas (2026-10-18)

1. **8 clientes existentes**: no se duplican; se les añade el grupo de FULLTECH conservando id,
   conversación, pedidos e historial.
2. **6 registros sin teléfono válido**: excluidos de la importación y conservados para revisión en
   `data/uat/import/fullpos/revision-telefonos-invalidos.csv` (nombre, razón social, teléfono tal
   como venía, dirección, notas y id de origen).
3. **103 productos** importados sin control de inventario, con nombre, categoría, costo, precio,
   unidad y `external_ids` (id de FullPOS y código original).
4. **7 categorías** de FullPOS conservadas tal cual (sin renombrar a las sugeridas), con su grupo de
   negocio.
5. **Interfaz**: grupos en la lista, filtros, edición en la ficha, filtro de catálogo por grupo y
   distinción «Sin control de inventario» / «Agotado».
6. **Nada existente se tocó**: 11 clientes de demostración, 219 pedidos y el stock de PHYTOEMAGRY
   siguen igual; 0 teléfonos duplicados.

## 11. Interfaz implementada

| Pieza | Dónde | Qué hace |
| --- | --- | --- |
| Etiquetas de grupo | lista de Clientes | Una etiqueta compacta por grupo, con color por actividad. |
| Filtro por grupo | encima de la lista | Chips con el número de clientes; se combina con los filtros de segmento. |
| Edición de grupos | ficha del cliente | Sección «Grupos de negocio»: se toca y se guarda; nunca permite dejar el cliente sin grupo. |
| Filtro de catálogo | catálogo → Filtros | «Grupo de negocio», con recuento por grupo. |
| Política de inventario | catálogo / ficha del producto | Nota «Sin control de inventario» bajo el precio, dato «Inventario» en la ficha y casilla «Controlar existencias» al editar. «Agotado» solo aparece en productos que sí llevan stock. |

Archivos: `server/business-groups.mjs` (nuevo), `server/customers.mjs`, `server/crm-server.mjs`,
`server/store-catalog.mjs`, `public/admin/app.js`, `public/admin/index.html`, `public/admin/store.js`,
`public/admin/admin.css`, `public/admin/store.css`.

Cambiar la política de inventario de un producto **con existencias** está bloqueado: primero hay que
dejarlas en cero con un ajuste, para que el historial de movimientos siga cuadrando.

## 12. Copia de seguridad y prueba de restauración (2026-10-18 03:24 UTC)

| Dato | Valor |
| --- | --- |
| Archivo | `/root/backups/phytoemagry/phytoemagry-20261018-0324.dump` (formato custom) |
| Tamaño | 608 KB |
| SHA-256 | `5b31aefb1b4a8007fedcd3e0010327dc5b13e6f66abff02ad11e4e8d997061b6` |
| Restauración | Base temporal `phytoemagry_restore_test`, restaurada con `pg_restore` |
| Verificación | Clientes 40 = 40 · Conversaciones 40 = 40 · Productos 7 = 7 · Categorías 1 = 1 · Pedidos 7 = 7 |
| Limpieza | Base temporal eliminada tras comprobar los conteos |

Producción **no** se modificó: solo se leyó y se creó/eliminó una base aparte.

## 13. Conciliación final (contra producción, hoy)

| Concepto | Valor |
| --- | --- |
| Filas de clientes en el origen | 227 |
| Clientes únicos por teléfono | 221 |
| Sin teléfono válido (a revisión) | 6 |
| Ya existen en producción (solo se añade grupo) | 8 |
| Nuevos a crear | 213 |
| Conflictos de nombre | 0 |
| Productos en el origen | 110 (7 archivados) |
| Productos únicos | 103 → 103 nuevos (producción tiene 7, distintos) |
| Categorías | 7 |

## 14. Pendiente de tu autorización

1. Ejecutar `fullpos-import.mjs --apply` contra la base de producción del CRM.
2. Volver a generar `prod-phones.txt` el mismo día (por si entra un cliente nuevo).
3. Verificar después: 40 → 253 clientes, 0 duplicados, 7 → 110 productos, 8 categorías, y segunda
   pasada sin crear nada.
4. Desplegar el código (los cambios de interfaz) cuando lo autorices.

## 15. Ejecución en producción (2026-10-18 03:32 UTC)

Autorizada expresamente («adelante»). Antes de escribir se hizo una copia adicional
`phytoemagry-20261018-0332-preimport.dump` (608 KB, SHA-256
`1b309f159227d8690b10e9a10f7c6be8fd9a220748219776c1afa34fb8595b74`).

**Ensayo previo:** se creó `phytoemagry_rehearsal` restaurando la copia, se ejecutó el importador
con `--backend=postgres --apply` y se comprobó el resultado; después se eliminó la base de ensayo.

| Concepto | Antes | Después |
| --- | --- | --- |
| Clientes | 40 | **253** (213 nuevos + 8 con grupo añadido) |
| Conversaciones | 40 | 253 |
| Productos del catálogo | 7 | **110** |
| Categorías | 1 | **8** |
| Pedidos (`phytoemagry_items`) | 7 | **7** (intactos) |
| Teléfonos duplicados | 0 | **0** |
| Con grupo FULLTECH | — | 221 |
| Con grupo PHYTOEMAGRY | 40 | 40 (los 8 cruzados tienen los dos) |

Segunda pasada inmediata: `created: 0 · unchanged: 221 · skipped_existing: 103 · existing: 7`
→ **idempotencia confirmada en producción**.

El panel productivo respondió `HTTP 200` después de la importación. El servicio sigue `Running`.
Los archivos temporales del servidor y la base de ensayo se eliminaron; quedan las dos copias de
seguridad.

**Lo único pendiente es desplegar el código** (interfaz de grupos, filtros y distinción de
inventario). Hasta entonces los datos ya están en producción pero el panel antiguo no muestra las
etiquetas ni los filtros nuevos, y los 103 artículos aparecen en el catálogo sin imagen.

## 16. Bandeja sin los contactos importados vacíos (2026-10-18)

Los 213 contactos nuevos (más los 8 existentes) tienen conversación creada para poder escribirles,
pero **no aparecen en la bandeja mientras no haya ni un mensaje**: la lista se habría llenado de 221
filas «sin mensajes» y habría tapado a quien sí escribe.

- Se ocultan solo si el cliente viene de una importación (`imported_from`), no tienen mensajes, no
  tienen no leídos y no están archivadas. Una conversación abierta a mano sigue apareciendo.
- **No se borra nada**: el cliente sigue en Clientes, su botón de chat abre la conversación, el
  buscador de la bandeja la encuentra por nombre o teléfono, y en cuanto hay un mensaje vuelve sola.
- En producción eso deja la bandeja en 40 conversaciones (de 253) tras el despliegue.
