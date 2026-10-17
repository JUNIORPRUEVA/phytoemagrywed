import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function buildProofreading() {
const out = new URL('../public/admin/vendor/proofreading/', import.meta.url);
await mkdir(out, { recursive: true });
await build({ entryPoints: [fileURLToPath(new URL('../src/admin/proofreading-worker.js', import.meta.url))], outfile: fileURLToPath(new URL('worker.js', out)), bundle: true, minify: true, platform: 'browser', target: ['safari16.4','chrome100'], legalComments: 'eof' });
for (const [source, name] of [['index.aff','es-DO.aff'],['index.dic','es-DO.dic'],['license','DICTIONARY-LICENSE.txt']]) {
  await copyFile(new URL(`../node_modules/dictionary-es-do/${source}`, import.meta.url), new URL(name, out));
}
await copyFile(new URL('../node_modules/nspell/license', import.meta.url), new URL('NSPELL-LICENSE.txt', out));
await copyFile(new URL('../node_modules/is-buffer/LICENSE', import.meta.url), new URL('IS-BUFFER-LICENSE.txt', out));
await copyFile(new URL('../assets/licenses/MPL-1.1.txt', import.meta.url), new URL('MPL-1.1.txt', out));
await writeFile(new URL('NOTICE.txt', out), 'Motor: nspell 2.1.5 (MIT), https://github.com/wooorm/nspell\nDiccionario: dictionary-es-do 2.0.0, español de República Dominicana, Santiago Bosio y colaboradores. Distribuido bajo MPL-1.1 (opción de licencia). Fuente sin modificar: https://www.npmjs.com/package/dictionary-es-do/v/2.0.0\nVer DICTIONARY-LICENSE.txt y NSPELL-LICENSE.txt.\n');
// La distribución del diccionario incluye la elección múltiple de licencia.
console.log('Corrector es-DO preparado: worker y diccionario local.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildProofreading();
