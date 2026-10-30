// Inserta `metadata.phone_number_id` en el payload del webhook sintético de una
// prueba, respetando la indentación. Uso: node tools/inyectar-destino.mjs <archivo> <id>
import { readFile, writeFile } from 'node:fs/promises';

const [archivo, destino] = process.argv.slice(2);
const texto = await readFile(archivo, 'utf8');
if (texto.includes(`phone_number_id: '${destino}'`)) {
  console.log('ya tiene el destino', archivo);
  process.exit(0);
}
const lineas = texto.split('\n');
const i = lineas.findIndex((l) => /field:\s*'messages'/.test(l));
if (i === -1) {
  console.log('sin bloque de mensajes', archivo);
  process.exit(2);
}
for (let j = i; j < Math.min(i + 6, lineas.length); j += 1) {
  const match = lineas[j].match(/^(\s*)value:\s*\{\s*$/);
  if (!match) continue;
  const sangria = `${match[1]}  `;
  lineas.splice(j + 1, 0,
    `${sangria}// Meta SIEMPRE manda el número de destino; el servidor lo exige (fail-closed).`,
    `${sangria}metadata: { phone_number_id: '${destino}', display_phone_number: '18095550000' },`);
  await writeFile(archivo, lineas.join('\n'), 'utf8');
  console.log(`inyectado ${destino} en ${archivo}:${j + 2}`);
  process.exit(0);
}
console.log('no encontré `value: {` tras field messages', archivo);
process.exit(3);
