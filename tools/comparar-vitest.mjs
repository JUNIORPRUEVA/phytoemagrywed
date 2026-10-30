// Compara dos informes JSON de Vitest por archivo: fallos y pendientes.
import { readFile } from 'node:fs/promises';

const [a, b] = process.argv.slice(2);
const carga = async (ruta) => {
  const raw = JSON.parse(await readFile(ruta, 'utf8'));
  const mapa = new Map();
  for (const suite of raw.testResults ?? []) {
    const archivo = suite.name.split(/[\\/]/).slice(-2).join('/');
    const tests = suite.assertionResults ?? [];
    mapa.set(archivo, {
      total: tests.length,
      fallos: tests.filter((t) => t.status === 'failed').length,
      pendientes: tests.filter((t) => t.status === 'pending' || t.status === 'skipped').length,
    });
  }
  return { mapa, raw };
};

const izq = await carga(a);
const der = await carga(b);

const claves = [...new Set([...izq.mapa.keys(), ...der.mapa.keys()])].sort();
const filas = [];
for (const k of claves) {
  const x = izq.mapa.get(k) ?? { fallos: 0, pendientes: 0, total: 0 };
  const y = der.mapa.get(k) ?? { fallos: 0, pendientes: 0, total: 0 };
  if (x.fallos !== y.fallos || x.pendientes !== y.pendientes) {
    filas.push({ k, izq: x, der: y, delta: y.fallos - x.fallos });
  }
}

console.log(`A=${a}: ${izq.raw.numFailedTests} fallos, ${izq.raw.numPendingTests} pendientes`);
console.log(`B=${b}: ${der.raw.numFailedTests} fallos, ${der.raw.numPendingTests} pendientes`);
console.log('\nARCHIVO | fallos A→B | pendientes A→B');
for (const f of filas.sort((p, q) => q.delta - p.delta)) {
  console.log(`${f.k} | ${f.izq.fallos}→${f.der.fallos} | ${f.izq.pendientes}→${f.der.pendientes}`);
}
console.log(`\narchivos que empeoran: ${filas.filter((f) => f.delta > 0).length}`);
console.log(`archivos que mejoran: ${filas.filter((f) => f.delta < 0).length}`);
