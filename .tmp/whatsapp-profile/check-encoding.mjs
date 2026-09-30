/*
 * Comprueba que los archivos modificados siguen siendo UTF-8 válido y que no
 * tienen secuencias típicas de mojibake (texto español re-codificado).
 *
 * Uso: node .tmp/whatsapp-profile/check-encoding.mjs <archivos...>
 */
import { readFileSync } from 'node:fs';

const SECUENCIAS = ['\u00C3', '\u00C2', '\u00E2\u0080', '\uFFFD'];
const archivos = process.argv.slice(2);

let problemas = 0;
for (const archivo of archivos) {
  const texto = readFileSync(archivo, 'utf8');
  const encontradas = SECUENCIAS.filter((s) => texto.includes(s));
  const valido = !texto.includes('\uFFFD');
  if (encontradas.length > 0 || !valido) {
    problemas += 1;
    console.log(`✗ ${archivo} → secuencias sospechosas: ${encontradas.length ? encontradas.map((s) => JSON.stringify(s)).join(' ') : '—'}`);
  } else {
    console.log(`✓ ${archivo} → UTF-8 correcto, sin mojibake`);
  }
}

console.log(problemas === 0 ? 'RESULTADO: sin mojibake' : `RESULTADO: ${problemas} archivo(s) con problemas`);
process.exit(problemas === 0 ? 0 : 1);
