// Clasifica los fallos de un informe JSON de Vitest en grupos de causa.
import { readFile } from 'node:fs/promises';

const raw = JSON.parse(await readFile(process.argv[2], 'utf8'));
const grupos = new Map();
const filas = [];
for (const suite of raw.testResults ?? []) {
  const archivo = suite.name.split(/[\\/]/).slice(-1)[0];
  const malos = (suite.assertionResults ?? []).filter((t) => t.status === 'failed');
  if (!malos.length) continue;
  for (const t of malos) {
    const msg = (t.failureMessages?.[0] ?? '').split('\n')[0];
    let causa = 'otra';
    if (/timeout|fetch failed|ECONN|socket/i.test(msg)) causa = 'entorno/timing (timeout o red)';
    else if (/to contain|to deeply equal|to match object/.test(msg)) causa = 'expectativa de contenido (PWA/texto)';
    else if (/expected \d{3} to be \d{3}/.test(msg)) causa = 'contrato HTTP (código de estado)';
    else if (/undefined|null/.test(msg)) causa = 'dato ausente (fixture o contrato)';
    else if (/STACK_TRACE/.test(msg)) causa = 'error interno del test';
    grupos.set(causa, (grupos.get(causa) ?? 0) + 1);
    filas.push({ archivo, test: t.fullName.slice(0, 70), causa, msg: msg.slice(0, 90) });
  }
}
console.log('TOTAL fallos:', filas.length);
console.log('\nPOR CAUSA:');
for (const [c, n] of [...grupos.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n} × ${c}`);
console.log('\nPOR ARCHIVO:');
const porArchivo = new Map();
for (const f of filas) porArchivo.set(f.archivo, (porArchivo.get(f.archivo) ?? 0) + 1);
for (const [a, n] of [...porArchivo.entries()].sort((x, y) => y[1] - x[1])) {
  const ejemplo = filas.find((f) => f.archivo === a);
  console.log(`  ${String(n).padStart(3)} ${a} :: ${ejemplo.msg}`);
}
