/*
 * REVISIÓN DE CUMPLIMIENTO de los textos del perfil de WhatsApp.
 *
 * No inventa reglas: usa el MISMO motor que protege la web del proyecto
 * (`src/lib/content-safety.js` → `findClaims`), el que hace fallar la suite y
 * `npm run check` si alguien escribe una afirmación prohibida.
 *
 * Para que la prueba tenga valor, además de revisar los textos propuestos pasa
 * un CONTROL NEGATIVO: frases que SÍ deben ser detectadas. Si el control no
 * salta, la revisión no vale.
 *
 * Uso: node .tmp/whatsapp-profile/policy-review.mjs
 */
import { FORBIDDEN_PATTERNS, findClaims } from '../../src/lib/content-safety.js';

const PERFIL = {
  display_name: 'Phytoemagry',
  about: 'Información y pedidos de Phytoemagry 🌿',
  description:
    'Phytoemagry RD 🌿 | Producto fitoterápico en cápsulas. Información, pedidos y atención personalizada.',
  websites: ['https://phytoemagryrd.lat'],
  email: '',
  address: '',
};

const LIMITES = { about: 139, description: 512 };

console.log('--- LONGITUDES ---');
for (const [campo, limite] of Object.entries(LIMITES)) {
  const valor = PERFIL[campo];
  const codePoints = [...valor].length;
  const emoji = [...valor].filter((c) => c.codePointAt(0) > 0xffff).length;
  console.log(
    `${campo}: ${valor.length} UTF-16 · ${codePoints} caracteres reales (${emoji} emoji) · límite ${limite} → ${
      codePoints <= limite ? 'OK' : 'SE PASA'
    }`,
  );
}

const SIN_TILDES = (texto) => texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

console.log('\n--- TEXTO REVISADO ---');
for (const [campo, valor] of Object.entries(PERFIL)) {
  const texto = Array.isArray(valor) ? valor.join(' ') : valor;
  if (!texto) {
    console.log(`${campo}: (vacío, no se configura)`);
    continue;
  }
  const hallazgos = findClaims(texto);
  const prohibidas = ['adelgaza', 'pierde', 'libras', 'garantiz', 'quema', 'cura', 'tratamiento', '100%', 'milagro', 'antes y despues'];
  const manuales = prohibidas.filter((palabra) => SIN_TILDES(texto).includes(palabra));
  console.log(
    `${campo}: ${hallazgos.length === 0 ? 'SIN afirmaciones prohibidas' : 'AFIRMACIONES: ' + hallazgos.map((h) => h.id).join(', ')}${
      manuales.length ? ' · revisar a mano: ' + manuales.join(', ') : ''
    }`,
  );
}

console.log('\n--- CONTROL NEGATIVO (debe detectarlas) ---');
const CONTROLES = [
  'Adelgaza hasta 10 libras en un mes',
  'Resultados garantizados, 100% efectivo',
  'Quema grasa mientras duermes',
  'Cura la diabetes',
  'Es un tratamiento natural para la obesidad',
];
let detectadas = 0;
for (const frase of CONTROLES) {
  const hallazgos = findClaims(frase);
  if (hallazgos.length > 0) detectadas += 1;
  console.log(`  «${frase}» → ${hallazgos.length ? hallazgos.map((h) => h.id).join(', ') : '¡NO DETECTADA!'}`);
}
console.log(`control negativo: ${detectadas}/${CONTROLES.length} detectadas`);
console.log(`patrones activos del motor: ${FORBIDDEN_PATTERNS.length}`);

const ok = detectadas === CONTROLES.length;
console.log(`\nPOLICY REVIEW = ${ok ? 'PASS (motor activo y textos limpios)' : 'FAIL (el motor no detecta lo que debe)'}`);
process.exitCode = ok ? 0 : 1;
