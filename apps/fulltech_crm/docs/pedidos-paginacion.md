# Pedidos paginados — contrato propuesto y revisión de riesgo

Estado: **implementado** en este worktree (`server/stores.mjs`, `server/crm-server.mjs`) y consumido por
`apps/fulltech_crm`. Es una **adición compatible**: no cambia ninguna ruta existente ni el contrato del
panel PWA.

## El problema

`GET /api/admin/data` es un paquete de arranque, no un listado. El servidor pide como máximo 500
filas y **trunca en silencio**: con 520 pedidos en la UAT devolvió 500 con `partial:false`, y
`stats.total` se calculaba sobre esa misma lista recortada (500). Ninguna cifra del panel decía la
verdad, y la app nativa no tenía forma de saber que faltaban pedidos.

`GET /api/admin/orders` **no existía** (404). Se añade aquí, en lugar de "arreglarlo" con
`?offline=1` (5 000 filas) o un tope oculto más grande.

## Contrato

```
GET /api/admin/orders?limit=&cursor=&status=&from=&to=&q=
```

| Aspecto | Regla |
| --- | --- |
| Autenticación | Cookie de sesión `pe_crm` |
| Autorización | `can('admin.full')` → ADMIN. Cualquier otro rol: **403 `forbidden`** |
| `limit` | Entero 1–200. Por defecto **50**. Fuera de rango o no entero → **422 `invalid_limit`** |
| `cursor` | `base64url("<received_at>|<id>")`. Se devuelve en `nextCursor`. Inválido → **422 `invalid_cursor`** |
| Orden | `received_at DESC, id DESC` — el `id` inmutable rompe los empates de fecha, así que dos páginas consecutivas no se solapan ni pierden filas |
| `status` | Opcional. Debe estar en la lista de estados del sistema; si no → **422 `invalid_status`** |
| `from` / `to` | `YYYY-MM-DD` opcionales, comparados como texto ISO sobre `received_at` (UTC). `from > to` → **422 `invalid_date_range`** |
| `q` | Texto ≤ 80; busca en nombre, teléfono, ubicación, presentación y número de pedido (minúsculas) |
| Respuesta | `{ ok, items, nextCursor, hasMore, total, limit }` |
| `total` | `COUNT(*)` del **conjunto filtrado completo**, no del tamaño de la página |
| `items` | Cada fila pasa por `sanitizeItemForPermissions`: sin ese permiso, los importes de costo desaparecen igual que en el paquete de arranque |

`complete` no se envía: se deduce de `hasMore === false`. Con `hasMore:true` la UI **no** puede
afirmar que la lista es completa.

## Riesgos revisados

| Riesgo | Mitigación |
| --- | --- |
| Fuga por `total`/`q`/cursor | Solo ADMIN; el conteo usa **los mismos** filtros que la consulta; el cursor es opaco y se valida contra el formato exacto |
| Doble lectura / filas perdidas con inserciones concurrentes | Orden total por `(received_at, id)`; el cursor es "estrictamente anterior a". Un pedido nuevo aparece en la primera página del siguiente refresco, nunca duplica |
| Dos motores de base de datos | SQL idéntico en SQLite y Postgres; el adaptador de archivo JSON pagina en memoria (solo desarrollo) |
| Coste | `LIMIT limit+1` para saber si hay más, sin traer el resto; `COUNT(*)` con los mismos predicados. Índice existente sobre `received_at` |
| Cambiar el panel PWA | No se toca `/api/admin/data` ni ninguna respuesta existente |
| Delimitación por empresa/reparto | **Fuera de esta versión**: la ruta es solo ADMIN, que ve todo (igual que el paquete de arranque). Repartidor y agente siguen con su vista del snapshot. Es una limitación documentada, no una regresión |

## Pendiente (no en esta fase)

- Extender el listado a AGENT/DELIVERY respetando `companyScope`/`deliveryScope` requiere mover esos
  filtros a SQL. Hoy se aplican en memoria sobre el snapshot; hacerlo mal filtraría pedidos ajenos, así
  que se deja explícitamente fuera y los no-admin siguen usando su paquete de arranque acotado.
- `stats.total` del snapshot sigue calculándose sobre la lista recortada. Cambiarlo alteraría el
  significado que el panel PWA ya muestra; la cifra autoritativa es ahora `total` de este endpoint.
