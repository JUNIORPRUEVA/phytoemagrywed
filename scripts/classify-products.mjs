/**
 * REPORTE DE CLASIFICACIÓN DE PRODUCTOS (no escribe nada por sí solo).
 *
 * Se ejecuta SOBRE UNA COPIA de lo que devuelve el catálogo, para revisar antes
 * de tocar nada:
 *
 *   node scripts/classify-products.mjs productos.json            → informe
 *   node scripts/classify-products.mjs productos.json --json     → informe en JSON
 *
 * `productos.json` puede ser la respuesta de `/api/admin/store/products`
 * (`{ok:true,products:[…]}`) o directamente la lista `[…]`.
 *
 * REGLAS (a propósito, ninguna clasifica «todo» como propio):
 *   · `legacy: true`                      → PROPIO (inventario real de Phytoemagry).
 *   · `product_type` ya presente           → se RESPETA, sin discusión.
 *   · `imported_from` (viene de FullPOS)   → candidato a DE TERCEROS: hay que
 *                                            confirmarlo, por eso va aparte.
 *   · `track_stock: false`                 → candidato a DE TERCEROS (sin stock).
 *   · servicio (`kind: service`)           → propio (no se compra en tienda).
 *   · cualquier otro                       → SIN CLASIFICAR (a revisar a mano).
 *
 * No crea tiendas, ni existencias, ni cambia IDs.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--'));
const asJson = args.includes('--json');
const outIndex = args.indexOf('--out');
const outFile = outIndex >= 0 ? args[outIndex + 1] : null;

if (!file) {
  console.error('Uso: node scripts/classify-products.mjs <productos.json> [--json] [--out informe.json]');
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error('No se pudo leer el archivo:', error.message);
  process.exit(1);
}
const products = Array.isArray(raw) ? raw : raw.products;
if (!Array.isArray(products)) {
  console.error('El archivo no trae una lista de productos.');
  process.exit(1);
}

const report = { propio: [], terceros: [], terceros_candidato: [], revisar: [], resumen: {} };

for (const product of products) {
  const row = {
    id: product.id,
    sku: product.sku ?? null,
    nombre: product.name ?? product.label ?? '(sin nombre)',
    kind: product.kind ?? null,
    track_stock: product.track_stock ?? null,
    legacy: Boolean(product.legacy),
    imported_from: product.imported_from ?? null,
    product_type: product.product_type ?? null,
  };
  if (row.product_type === 'own') report.propio.push(row);
  else if (row.product_type === 'third_party') report.terceros.push(row);
  else if (row.legacy || row.kind === 'service') report.propio.push({ ...row, motivo: 'legacy o servicio' });
  else if (row.imported_from) report.terceros_candidato.push({ ...row, motivo: 'importado de FullPOS' });
  else if (row.track_stock === false) report.terceros_candidato.push({ ...row, motivo: 'sin control de inventario' });
  else report.revisar.push(row);
}

report.resumen = {
  total: products.length,
  propio: report.propio.length,
  terceros: report.terceros.length,
  terceros_candidato: report.terceros_candidato.length,
  requiere_revision: report.revisar.length,
  nota: 'Nada se ha modificado: este informe solo clasifica para revisión.',
};

if (outFile) writeFileSync(outFile, JSON.stringify(report, null, 2));

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const line = (row) => `  ${String(row.sku ?? row.id).padEnd(18)} ${row.nombre}${row.motivo ? `  · ${row.motivo}` : ''}`;
console.log('\nCLASIFICACIÓN PROPUESTA (no se aplica nada todavía)\n');
console.log(`PROPIOS (${report.propio.length})`);
report.propio.slice(0, 40).forEach((row) => console.log(line(row)));
if (report.propio.length > 40) console.log(`  … y ${report.propio.length - 40} más`);
console.log(`\nDE TERCEROS confirmados (${report.terceros.length})`);
report.terceros.slice(0, 40).forEach((row) => console.log(line(row)));
console.log(`\nDE TERCEROS candidatos — requieren confirmación (${report.terceros_candidato.length})`);
report.terceros_candidato.slice(0, 40).forEach((row) => console.log(line(row)));
if (report.terceros_candidato.length > 40) console.log(`  … y ${report.terceros_candidato.length - 40} más`);
console.log(`\nSIN CLASIFICAR — a revisar (${report.revisar.length})`);
report.revisar.slice(0, 40).forEach((row) => console.log(line(row)));
if (report.revisar.length > 40) console.log(`  … y ${report.revisar.length - 40} más`);
console.log('\nResumen:', JSON.stringify(report.resumen));
if (outFile) console.log(`Informe completo: ${outFile}`);
