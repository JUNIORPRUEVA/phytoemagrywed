// Resume el informe JSON de Vitest: recuentos exactos y fallos agrupados.
import { readFile } from 'node:fs/promises';

const ruta = process.argv[2];
const raw = JSON.parse(await readFile(ruta, 'utf8'));

console.log('numTotalTestSuites', raw.numTotalTestSuites);
console.log('numPassedTestSuites', raw.numPassedTestSuites);
console.log('numFailedTestSuites', raw.numFailedTestSuites);
console.log('numTotalTests', raw.numTotalTests);
console.log('numPassedTests', raw.numPassedTests);
console.log('numFailedTests', raw.numFailedTests);
console.log('numPendingTests', raw.numPendingTests);
console.log('numTodoTests', raw.numTodoTests);
console.log('success', raw.success);

const fallos = [];
for (const suite of raw.testResults ?? []) {
  const archivo = suite.name.split(/[\\/]/).slice(-2).join('/');
  const malos = (suite.assertionResults ?? []).filter((t) => t.status === 'failed');
  if (malos.length) {
    fallos.push({ archivo, total: (suite.assertionResults ?? []).length, malos: malos.length, mensajes: malos.slice(0, 2).map((t) => `${t.fullName} :: ${(t.failureMessages?.[0] ?? '').split('\n')[0].slice(0, 120)}`) });
  } else if (suite.status === 'failed' && (suite.assertionResults ?? []).length === 0) {
    fallos.push({ archivo, total: 0, malos: 0, mensajes: [(suite.message ?? '').split('\n')[0].slice(0, 200)] });
  }
}
console.log('\nARCHIVOS CON FALLOS:', fallos.length);
const porCausa = new Map();
for (const f of fallos) {
  console.log(`- ${f.archivo} (${f.malos}/${f.total}) ${f.mensajes[0] ?? ''}`);
  const causa = (f.mensajes[0] ?? '').replace(/[0-9a-f]{8,}/gi, '#').slice(0, 90);
  porCausa.set(causa, (porCausa.get(causa) ?? 0) + 1);
}
console.log('\nCAUSAS FRECUENTES:');
for (const [causa, n] of [...porCausa.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`${n} × ${causa}`);
}
