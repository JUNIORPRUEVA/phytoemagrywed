// Ortografía conservadora: no reescribe frases ni cambia datos comerciales.
const LOCAL_WORDS = new Set('fulltech phytoemagry whatsapp delivery deliveries motoconcho motoconchos guagua guaguas concho conchos jevi chercha chin klk pa pal pana panas colmado colmados tá ta srl dop rd'.split(' '));
const COMMON = { hoala: 'hola', hloa: 'hola', holaa: 'hola', aser: 'hacer', oy: 'hoy', delibery: 'delivery', grasias: 'gracias', nesecito: 'necesito', nesesito: 'necesito', nesecita: 'necesita', resivir: 'recibir', recivir: 'recibir', ubicasion: 'ubicación', direcion: 'dirección', disponivilidad: 'disponibilidad', porfabor: 'por favor', porfavor: 'por favor', alludar: 'ayudar', escrivir: 'escribir', exelente: 'excelente' };
// Preferencias del chat comercial, no el orden (a menudo alfabético) de Hunspell.
const CHAT_WORDS = new Set('hola amigo amiga buenas buenos días tardes noches saludos gracias favor disculpa disculpe precio precios pedido pedidos entrega entregas envío dirección ubicación disponible disponibilidad recibir hacer hoy mañana pago pagos transferencia efectivo cliente clientes producto productos confirmar información horario'.split(' '));
const lower = (text) => text.normalize('NFC').toLocaleLowerCase('es-DO');
const caseLike = (word, replacement) => /^\p{Lu}/u.test(word) ? replacement[0].toLocaleUpperCase('es-DO') + replacement.slice(1) : replacement;

// Distancia con transposiciones: «pediod» está a una pulsación de «pedido».
function distance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[a.length][b.length];
}

function chooseReplacement(key, suggestions) {
  const candidates = [...new Set(suggestions.map(lower))]
    .filter((value) => value !== key && /^\p{Ll}[\p{Ll}\p{M}]*$/u.test(value) && value.length <= 24)
    .map((value) => ({ value, edits: distance(key, value), familiar: CHAT_WORDS.has(value) ? 1 : 0 }))
    .filter(({ edits }) => edits <= (key.length >= 6 ? 2 : 1))
    .sort((a, b) => a.edits - b.edits || b.familiar - a.familiar);
  const [best, next] = candidates;
  // Una preferencia solo desempata errores igualmente cercanos. Si persiste
  // el empate, no adivinar ni convertir el borrador en otra palabra arbitraria.
  if (!best || (next && best.edits === next.edits && best.familiar === next.familiar)) return null;
  return best.value;
}

export function createProofreader(dictionary) {
  const cache = new Map();
  return function check(text, { ignored = [], names = [] } = {}) {
    if (typeof text !== 'string' || text.length > 4000) return null;
    const allowed = new Set([...LOCAL_WORDS, ...ignored.map(lower), ...names.flatMap((name) => String(name).match(/\p{L}[\p{L}\p{M}]*/gu) || []).map(lower)]);
    // Mantener posiciones UTF-16 para setRangeText (incluye emojis).
    const masked = text.replace(/https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w.-]+\.[\p{L}]{2,}|@[\p{L}\p{N}_]+/giu, (value) => ' '.repeat(value.length));
    const edits = [];
    const uncertain = [];
    for (const match of masked.matchAll(/\p{L}[\p{L}\p{M}]*/gu)) {
      const word = match[0];
      const key = lower(word);
      const start = match.index;
      const end = start + word.length;
      if ((word.length < 3 && !COMMON[key]) || word.length > 24 || allowed.has(key) || /^[\p{Lu}]+$/u.test(word)) continue;
      if (/[\p{N}_]/u.test(text[start - 1] || '') || /[\p{N}_]/u.test(text[end] || '')) continue;
      // Los nombres propios desconocidos no se tratan como errores.
      if (/^\p{Lu}/u.test(word) && !COMMON[key]) continue;
      let replacement = cache.get(key);
      if (replacement === undefined) {
        if (COMMON[key]) replacement = COMMON[key];
        else if (dictionary.correct(word) || dictionary.correct(key)) replacement = null;
        else {
          replacement = chooseReplacement(key, dictionary.suggest(key).slice(0, 64));
        }
        if (cache.size >= 1000) cache.clear();
        cache.set(key, replacement);
      }
      if (replacement) edits.push({ start, end, word, replacement: caseLike(word, replacement) });
      else if (!dictionary.correct(word) && !dictionary.correct(key)) uncertain.push({ start, end, word });
    }
    // Acentos en una pregunta de saludo reconocible; no alterar «como»/«esta»
    // en otros contextos válidos (por ejemplo «como esta fruta»).
    const greeting = /^(\s*(?:👋\s*)?)([\p{L}\p{M}]{3,6})([!,.:;]?\s+)([\p{L}\p{M}]{2,5})(\s+)([\p{L}\p{M}]{3,6})(?=\s*(?:(?:amigo|amiga|amido|usted|ustedes)\b)?\s*(?:[?!.,]|$))/iu.exec(text);
    if (greeting) {
      const normalize = (value) => lower(value).normalize('NFD').replace(/\p{M}/gu, '');
      const salutation = normalize(greeting[2]);
      const question = normalize(greeting[4]);
      const verbKey = normalize(greeting[6]);
      const verbs = ['esta', 'estas', 'estan'].map((value) => ({ value, edits: distance(verbKey, value) })).sort((a,b) => a.edits-b.edits);
      const knownOrTypo = (word, target, limit) => word === target || (!dictionary.correct(word) && distance(word, target) <= limit);
      const greetingFits = salutation === 'hola' || COMMON[salutation] === 'hola' || (salutation.startsWith('h') && knownOrTypo(salutation, 'hola', 2));
      const verbFits = verbs[0].edits <= 1 && verbs[0].edits < verbs[1].edits && (verbs[0].edits === 0 || !dictionary.correct(verbKey));
      if (greetingFits && knownOrTypo(question, 'como', 1) && verbFits) {
        const replacements = ['hola', 'cómo', { esta: 'está', estas: 'estás', estan: 'están' }[verbs[0].value]];
        let position = greeting[1].length;
        for (let i=0; i<3; i++) {
          const word = greeting[2 + i*2];
          if (lower(word) !== replacements[i]) edits.push({ start: position, end: position + word.length, word, replacement: caseLike(word, replacements[i]) });
          position += word.length + (greeting[3 + i*2]?.length || 0);
        }
      }
    }
    // La regla contextual sustituye una propuesta aislada para el mismo tramo.
    const accepted = [...new Map(edits.filter((edit) => !allowed.has(lower(edit.word))).map((edit) => [edit.start, edit])).values()].sort((a, b) => a.start - b.start);
    const unresolved = uncertain.filter((issue) => !accepted.some((edit) => edit.start === issue.start));
    if (!accepted.length && !unresolved.length) return null;
    let correctedText = text;
    for (const edit of [...accepted].reverse()) correctedText = correctedText.slice(0, edit.start) + edit.replacement + correctedText.slice(edit.end);
    return { ...accepted[0], edits: accepted, correctedText, uncertain: unresolved };
  };
}
