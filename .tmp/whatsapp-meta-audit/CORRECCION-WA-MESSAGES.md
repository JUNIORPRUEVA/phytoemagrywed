# Corrección del NO-GO — separación de la colección de mensajes de WhatsApp

Fecha: 2026-09-30 · Commit candidato: **526d1e3** (local, **NO** pusheado, **NO** desplegado)
Sin secretos en este archivo. Producción sin tocar.

---

## 1. Causa raíz

Colisión de nombres de tabla. `server/collections.mjs` construye la tabla como
`${prefijo}${colección}` con prefijo `phytoemagry_`; la colección nueva se llamaba
`messages` → **`phytoemagry_messages`**, que **ya existía** como tabla **legacy de
plantillas** del CRM (`id, name, body, position, updated_at`).

El DDL es `CREATE TABLE IF NOT EXISTS` → **no toca la tabla existente**: el esquema nuevo
(`doc jsonb`, `wa_message_id`, `direction`, `status`, …) nunca se creó. El primer uso
reventaba con `column "wa_message_id" does not exist`. Consecuencias:
1. el **webhook entrante fallaba** y el mensaje real se **perdía** (el handler ya había
   respondido 200, así que Meta **no reintenta**);
2. `GET /api/admin/data` devolvía **500**.

## 2. Archivos modificados

| Archivo | Cambio |
| --- | --- |
| `server/collections.mjs` | colección `messages` → **`wa_messages`** (+ comentario del porqué) y **validación defensiva** de esquema (`expectedColumns`, `assertTableShape`) aplicada en SQLite y Postgres |
| `server/customers.mjs` | 8 referencias a la colección `'messages'` → `'wa_messages'` |
| `server/crm-server.mjs` | 1 referencia (`/api/admin/data`) → `'wa_messages'` |
| `docs/WHATSAPP_INTEGRATION.md` | documenta la colección `wa_messages` |
| `tests/collections-legacy-collision.test.js` | **nuevo** (312 líneas, 8 tests) |

## 3. Diff conceptual

```diff
 COLLECTIONS = {
-  messages: { indexed: { …, wa_message_id, idempotency_key, … }, unique: [wa_message_id, idempotency_key] },
+  // La tabla física es phytoemagry_wa_messages. NO puede llamarse `messages`:
+  // ese nombre ya lo ocupaba la tabla legacy de plantillas del CRM.
+  wa_messages: { indexed: { …, wa_message_id, idempotency_key, … }, unique: [wa_message_id, idempotency_key] },
 }

+function assertTableShape({ collection, table, expected, actual }) { /* falla con diagnóstico explícito */ }

 // Postgres
 await pool.query(`CREATE TABLE IF NOT EXISTS …`);
+const existing = await pool.query(`SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass($1) …`, [table]);
+assertTableShape({ collection: name, table, expected: expectedColumns(name), actual: existing.rows.map(r => r.column_name) });

 // SQLite
 db.exec(`CREATE TABLE IF NOT EXISTS …`);
+assertTableShape({ collection: name, table, expected: expectedColumns(name),
+  actual: db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(r => r.name) });

-db.list('messages', …)   →   db.list('wa_messages', …)   (customers.mjs ×8, crm-server.mjs ×1)
```

## 4. Tests ejecutados

`npx vitest run tests/collections-legacy-collision.test.js` → **8 passed (8)**
`npm test` (suite completa) → **20 archivos, 353 passed, 2 skipped, 0 failed**
(antes: 19 archivos / 345 passed / 2 skipped / 0 failed → **+1 archivo, +8 tests, 0 regresiones**)
`npm run verify` (= test + check:content + build) → **PASS** (build: `dist/` 63 archivos)

Los 2 skipped son los de PostgreSQL de `tests/crm-server.test.js`, que necesitan
`PHYTO_CRM_TEST_DATABASE_URL` (no hay Postgres local).

## 5. Resultado UAT local

Flujo completo sobre una base temporal **con la tabla legacy presente** (nada de producción):

| Paso | Resultado |
| --- | --- |
| CRM arranca sobre la base con la legacy | OK, sin errores |
| `POST /api/webhooks/whatsapp` (firmado) | **HTTP 200** `{"ok":true,"received":true}` |
| `GET /api/admin/data` | **HTTP 200** (antes 500) · `storage: sqlite` |
| `GET /api/admin/conversations` | 200 · 1 conversación |
| `GET /api/admin/conversations/:id/messages` | 200 · 1 mensaje |
| `GET /api/admin/customers` / `metrics` | 200 / 200 |
| Tabla legacy | **idéntica** (5 plantillas, mismas columnas) |
| `phytoemagry_wa_messages` | 1 fila: `body="Hola"`, `direction=inbound`, `status=received`, `wa_message_id=wamid.UAT1` |
| Índices únicos | `phytoemagry_wa_messages_u_wa_message_id`, `..._u_idempotency_key` |
| 2 reintentos del MISMO webhook | **1 sola fila** (no duplica) · clientes 1 · conversaciones 1 |
| Lo que ve el CRM | `inbound: "Hola" (received)` |

## 6. Compatibilidad legacy

- Producción (solo lectura, antes del deploy): `phytoemagry_messages` con **5 filas**
  (`msg-saludo`, `msg-pedido`, `msg-recordatorio`, `msg-seguimiento`, `msg-gracias`) y
  columnas `id, name, body, position, updated_at`. **Sin cambios.**
- `phytoemagry_wa_messages` **no existe** todavía en producción (se creará sola, vacía, en el
  primer uso tras el deploy).
- En el UAT, la tabla legacy quedó **byte a byte igual** (mismos ids, nombres y posiciones).

## 7. Migraciones / DDL

**No hay migraciones y no se toca la tabla legacy.** Todo es DDL aditivo y automático en el
primer uso de cada colección:

```sql
CREATE TABLE IF NOT EXISTS phytoemagry_wa_messages (
  id text PRIMARY KEY, doc jsonb NOT NULL,
  conversation_id text, customer_id text, wa_message_id text,
  idempotency_key text, direction text, status text, created_at text);

CREATE UNIQUE INDEX IF NOT EXISTS phytoemagry_wa_messages_u_wa_message_id
  ON phytoemagry_wa_messages (wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS phytoemagry_wa_messages_u_idempotency_key
  ON phytoemagry_wa_messages (idempotency_key) WHERE idempotency_key IS NOT NULL;
```

Sin `ALTER TABLE`, sin `DROP`, sin `DELETE`, sin renombrar nada.

Validación del camino Postgres contra el Postgres real (solo lectura):

```sql
SELECT attname FROM pg_catalog.pg_attribute
 WHERE attrelid = to_regclass('phytoemagry_messages') AND attnum > 0 AND NOT attisdropped;
-- devuelve: id, name, body, position, updated_at  → la validación detectaría el desajuste
-- y contra una tabla inexistente devuelve 0 filas, sin error
```

## 8. Riesgos restantes

1. **El webhook responde 200 antes de procesar** (por diseño, para que Meta no reintente). Si
   en el futuro falla cualquier otra cosa, el mensaje se perderá en silencio salvo por la
   línea de error del log. Mitigación futura (fuera de alcance): guardar el payload crudo
   antes de responder o una cola de reintentos.
2. El camino **Postgres** de la validación defensiva no tiene test automatizado local (no hay
   Postgres aquí); su SQL sí se ejecutó contra el Postgres real y devuelve lo esperado.
3. `name_status: PENDING_REVIEW` sigue pendiente: es de Meta, no del código.
4. El **PIN de 2FA que se filtró** antes en el historial de PowerShell debería cambiarse en
   WhatsApp Manager.
5. `phytoemagry_wa_messages` no existe en producción: se creará en el primer uso tras el
   deploy (comportamiento esperado, verificado en UAT).
6. `.tmp/` (evidencia de auditoría) sigue **sin trackear** en git: no se ha commiteado.
7. El commit **no se ha pusheado**: producción sigue con `8a7ee71`.
