/**
 * ADAPTADOR SQL — un solo `query()` para los dos motores del CRM.
 *
 * POR QUÉ EXISTE
 * `server/media.mjs` (fase S3) habla PostgreSQL: usa `$1, $2…`, `RETURNING` y
 * `ADD COLUMN IF NOT EXISTS`. El CRM, en cambio, funciona con PostgreSQL, con
 * SQLite (desarrollo local, sin configuración) o con JSONL. Sin este adaptador,
 * la multimedia solo existiría con PostgreSQL y no se podría probar ni usar en
 * local.
 *
 * Este módulo NO reimplementa nada del dominio de media: solo traduce el dialecto
 * para que el MISMO `createMediaStore` siga siendo la única fuente de verdad del
 * esquema y de la máquina de estados.
 *
 *   postgres → se pasa tal cual (el pool ya expone `query`)
 *   sqlite   → traduce `$n` a `?`, expande `= ANY($n)` y tolera la migración
 *              repetida (`duplicate column name`, `already exists`)
 *   jsonl    → desactivado (no hay SQL): la multimedia se apaga con un aviso y el
 *              CRM sigue funcionando igual
 *
 * Todo lo que entra por aquí es SQL NUESTRO (nunca texto de un usuario).
 */

/**
 * Traduce `$1, $2…` al marcador posicional de SQLite y reordena los valores.
 * Se resuelve por índice (no por orden de aparición), así que un `$1` repetido
 * sigue siendo correcto. Un valor que sea ARRAY se expande a varios marcadores:
 * así `= ANY($1)` (PostgreSQL) y `IN ($1)` funcionan igual en SQLite.
 *
 * @param {string} sql
 * @param {any[]} values
 * @returns {{ sql: string, values: any[] }}
 */
export function toSqlite(sql, values = []) {
  // `= ANY($n)` se consume entero (no queda un `= (?, ?)` inválido).
  const pattern = /=\s*ANY\s*\(\s*\$(\d+)\s*\)|\$(\d+)/gi;
  const source = String(sql);
  let text = '';
  /** @type {any[]} */
  const bound = [];
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    text += source.slice(last, match.index);
    const index = Number(match[1] ?? match[2]);
    const value = values[index - 1];
    if (Array.isArray(value)) {
      text += value.length ? `IN (${value.map(() => '?').join(', ')})` : 'IN (NULL)';
      bound.push(...value);
    } else {
      text += '?';
      bound.push(value);
    }
    last = match.index + match[0].length;
  }
  text += source.slice(last);
  return { sql: text, values: bound };
}

/** ¿Esta sentencia devuelve filas? (`SELECT …` o cualquier `… RETURNING …`) */
function returnsRows(statement) {
  const text = statement.trim().toUpperCase();
  return text.startsWith('SELECT') || text.startsWith('WITH') || text.includes('RETURNING');
}

/** Errores que la migración aditiva produce de forma esperada al repetirse. */
function isBenignRepeat(error) {
  const message = String(error?.message ?? '');
  return /duplicate column name|already exists|duplicate key name/i.test(message);
}

/** Sentencias sueltas de un guion SQL (el DDL trae varias, separadas por `;`). */
function statementsOf(script) {
  return String(script)
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** Columnas reales de una tabla en SQLite (vacío si la tabla no existe). */
function sqliteColumns(handle, table) {
  try {
    return handle
      .prepare('SELECT name FROM pragma_table_info(?)')
      .all(String(table).replace(/["'`\[\]]/g, ''))
      .map((row) => row.name);
  } catch {
    return [];
  }
}

/**
 * Traduce `ALTER TABLE t ADD COLUMN IF NOT EXISTS c …`.
 *
 * SQLite NO admite `IF NOT EXISTS` en `ADD COLUMN` (da «near "EXISTS": syntax
 * error», incluso si la columna ya existe). Aquí se decide de verdad: si la
 * columna ya está, la sentencia se OMITE; si no está, se ejecuta sin el `IF NOT
 * EXISTS`. Así la migración sigue siendo idempotente y aditiva, y aplica de
 * verdad los cambios pendientes en vez de fallar en silencio.
 *
 * @returns {{ skip: true } | { skip: false, sql: string }}
 */
function translateAddColumn(handle, statement) {
  const match = /^ALTER\s+TABLE\s+([\w."'`[\]]+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([\w."'`[\]]+)([\s\S]*)$/i.exec(
    statement,
  );
  if (!match) return { skip: false, sql: statement };
  const [, table, column, rest] = match;
  const existing = sqliteColumns(handle, table);
  const nombre = column.replace(/["'`\[\]]/g, '');
  if (existing.includes(nombre)) return { skip: true };
  return { skip: false, sql: `ALTER TABLE ${table} ADD COLUMN ${column}${rest}` };
}

/**
 * Crea el ejecutor SQL del backend activo.
 *
 * @param {{ backend: 'postgres'|'sqlite'|'jsonl', handle: any }} input
 * @returns {{ backend: string, enabled: boolean, query: (sql: string, values?: any[]) => Promise<{ rows: any[], changes?: number }> }}
 */
export function createSqlQuery({ backend, handle }) {
  if (backend === 'postgres' && handle?.query) {
    return {
      backend,
      enabled: true,
      async query(sql, values = []) {
        const result = await handle.query(sql, values);
        return { rows: result?.rows ?? [], changes: result?.rowCount ?? 0 };
      },
    };
  }

  if (backend === 'sqlite' && handle?.prepare) {
    return {
      backend,
      enabled: true,
      async query(sql, values = []) {
        const script = String(sql);
        // Un guion con varias sentencias (DDL/migración) no se puede preparar de
        // una vez en SQLite: se ejecuta sentencia a sentencia, tolerando solo los
        // errores de "esto ya existía" (la migración es idempotente a propósito).
        const parts = statementsOf(script);
        const multiple = parts.length > 1;
        /** @type {any[]} */
        let rows = [];
        let changes = 0;
        for (const statement of parts.length ? parts : [script]) {
          const alter = /^ALTER\s+TABLE/i.test(statement) ? translateAddColumn(handle, statement) : { skip: false, sql: statement };
          if (alter.skip) continue;
          const translated = toSqlite(alter.sql, values);
          try {
            if (!multiple && returnsRows(alter.sql)) {
              rows = handle.prepare(translated.sql).all(...translated.values);
            } else {
              const result = handle.prepare(translated.sql).run(...translated.values);
              changes += Number(result?.changes ?? 0);
            }
          } catch (error) {
            if (multiple && isBenignRepeat(error)) continue;
            throw error;
          }
        }
        return { rows, changes };
      },
    };
  }

  return {
    backend: backend ?? 'none',
    enabled: false,
    async query() {
      return { rows: [], changes: 0 };
    },
  };
}
