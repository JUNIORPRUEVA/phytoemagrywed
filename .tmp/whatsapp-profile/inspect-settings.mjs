/*
 * Inspección READ-ONLY de la base local del CRM: ¿guarda algún ajuste de
 * WhatsApp (nombre de columna) o hay datos que sirvan para el perfil?
 * Solo imprime NOMBRES de tablas/columnas y recuentos: nunca valores de ajustes.
 *
 * Uso: node --experimental-sqlite .tmp/whatsapp-profile/inspect-settings.mjs
 */
import { DatabaseSync } from 'node:sqlite';

const ruta = 'data/phytoemagry.sqlite';
const db = new DatabaseSync(ruta, { readOnly: true });
try {
  const tablas = db
    .prepare("select name from sqlite_master where type='table' order by name")
    .all()
    .map((r) => r.name);
  console.log('tablas:', tablas.join(', '));

  for (const tabla of tablas) {
    if (!/settings|ajustes|config/i.test(tabla)) continue;
    const columnas = db
      .prepare(`pragma table_info(${tabla})`)
      .all()
      .map((c) => c.name);
    const filas = db.prepare(`select count(*) as n from ${tabla}`).get().n;
    console.log(`ajustes → ${tabla}: ${filas} fila(s) · columnas: ${columnas.join(', ')}`);
  }
} finally {
  db.close();
}
