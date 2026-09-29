/**
 * SEGURIDAD DE CONTENIDO — detección de afirmaciones prohibidas.
 *
 * Fuente única de verdad: la usan
 *   - `tests/content-safety.test.js` (falla la suite si alguien introduce un claim)
 *   - `scripts/check-content.mjs` (`npm run check`)
 *   - `scripts/build.mjs` (avisa en el build)
 *
 * Cada patrón puede llevar `unless` para no marcar texto legítimo:
 *   - avisos legales ("no es un medicamento", "no sustituye..."),
 *   - protección de datos ("tratamiento de datos", "responsable del tratamiento"),
 *   - plazos de conservación ("conservamos los datos durante 365 días").
 */

/**
 * @typedef {object} ClaimPattern
 * @property {string} id
 * @property {string} label
 * @property {RegExp} pattern
 * @property {RegExp} [unless]  Si coincide, el texto se considera legítimo.
 */

/** @type {ClaimPattern[]} */
export const FORBIDDEN_PATTERNS = [
  {
    id: 'weight-loss',
    label: 'promesa de pérdida de peso',
    pattern: /adelgaz|rebajar|bajar de peso|bajar kilos|perder peso|pierde peso|elimina grasa|quema ?grasa|grasa abdominal|reducir grasa|reducir tallas/i,
  },
  {
    id: 'weight-numbers',
    label: 'cifras de peso (kg/libras)',
    pattern: /\b\d+([.,]\d+)?\s*(kg|kilos?|libras?|lbs?)\b|perder?\s+\d+([.,]\d+)?\s*(kg|kilos?|libras?)|libras\s+en\s+\d+/i,
  },
  {
    id: 'result-timeframe',
    label: 'plazo de resultados',
    // "resultados en 5 días", "verás resultados en 2 semanas", "en 5 días notarás..."
    pattern:
      /(resultad\w*|efecto\w*|funciona\w*|notar\w*|ver[aá]s|bajar\w*)\D{0,24}\b\d+\s*(d[ií]as?|semanas?|meses)\b|\ben\s+\d+\s*(d[ií]as?|semanas?|meses)\s*(notar\w*|ver[aá]s|tendr[aá]s|obtendr[aá]s)/i,
    unless: /conserv\w+|retenci[oó]n|almacen\w+|durante\s+\d+\s*d[ií]as\s*(desde|de|para)\s*(la|el)\s*(compra|pedido)/i,
  },
  {
    id: 'guarantee',
    label: 'garantía de resultados',
    pattern: /garantiz|garant[ií]a de (resultados?|efectividad|[eé]xito)|asegura resultados|resultados asegurados|funciona siempre/i,
  },
  {
    id: 'results-claim',
    label: 'promesa de resultados verificables',
    // "resultados comprobados", "comprueba los resultados", "resultados reales"…
    // Un comentario de un cliente no es una promesa del producto.
    pattern:
      /resultados?\s+(comprobad\w+|verificad\w+|demostrad\w+|reales|visibles|garantizad\w+)|comprueba\s+(los\s+|tus\s+)?resultados|ver\s+(los\s+|tus\s+)?resultados|comprobado\s+por\s+(clientes|usuarios)/i,
    unless: /no\s+(garantiza|promete|asegura|sustituye)|ni\s+garantiza|sin\s+(garantizar|prometer)/i,
  },
  {
    id: 'absolute-claims',
    label: 'afirmación absoluta',
    pattern:
      /100\s*%\s*(natural|seguro|efectivo|garantiz)|sin efectos secundarios|sin contraindicaciones|cl[ií]nicamente (probado|comprobado)|milagros?|totalmente seguro|no tiene efectos adversos/i,
  },
  {
    id: 'authority',
    label: 'aval de autoridad no verificado',
    pattern: /aprobado por (la )?(fda|oms|ema|isp|anmat|digemaps)|avalado por (la )?(fda|oms|m[eé]dic)|recomendado por m[eé]dicos/i,
  },
  {
    id: 'disease',
    label: 'enfermedad o tratamiento médico',
    pattern:
      /\bcur(a|ar|as|an|aci[oó]n|ativo)\b|\btratamiento\b|\benfermedad(es)?\b|\bdiabetes\b|\bhipertensi[oó]n\b|\bcolesterol\b|\btiroides\b|\bobesidad\b|\bsobrepeso\b|\bc[aá]ncer\b|\bartritis\b/i,
    // No marcar avisos legales ni referencias a protección de datos.
    unless:
      /no\s+(es|est[aá]|sustituye|reemplaza|constituye|se\s+ha\s+demostrado)|ni\s+(trata|es|sustituye)|sin\s+ser|no\s+es\s+un\s+medicamento|tratamiento\s+de\s+(datos|la\s+informaci[oó]n)|responsable\s+del\s+tratamiento|tratamiento\s+de\s+datos\s+personales|finalidad\s+del\s+tratamiento/i,
  },
  {
    id: 'detox',
    label: 'detox / sistema inmune',
    pattern: /desintoxic\w*|\bdetox\b|fortalece el sistema inmune|refuerza (el|tus) (sistema )?defensas|sube las defensas/i,
  },
  {
    id: 'social-proof-figures',
    label: 'cifras de clientes sin verificar',
    pattern:
      /m[aá]s de \d[\d.,]*\s*(clientes|personas|usuarios|pacientes)|\d[\d.,]*\s*%\s*de (clientes|personas|usuarios)|\bmiles de (clientes|personas)\b|\b(cientos|miles|millones) de (clientes|personas)/i,
  },
  {
    id: 'false-scarcity',
    label: 'escasez o urgencia falsa',
    pattern: /[uú]ltimas unidades|solo (por )?hoy|quedan \d+|oferta v[aá]lida (solo|por)|\d+\s*horas|se acaba (hoy|pronto)|[uú]ltimos d[ií]as/i,
  },
  {
    id: 'fake-reviews',
    label: 'reseñas o estrellas inventadas',
    pattern: /[0-9](\.[0-9])?\s*(de 5|estrellas)|\u2b50|\u2605{3,}|reviews?\s+verificadas/i,
  },
  {
    id: 'before-after',
    label: 'antes y después',
    pattern: /antes y despu[eé]s|before ?\/? ?after|fotos? de progreso/i,
  },
  {
    id: 'body-pressure',
    label: 'presión sobre el cuerpo',
    pattern: /(averg[üu]énzate|da\s+verg[üu]enza|te\s+da\s+miedo\s+mirarte|no\s+soportas\s+tu\s+cuerpo|barriga\s+hinchada|abdomen\s+abultado)/i,
  },
];

/** Palabras que indican un aviso legal legítimo (no un claim). */
const DISCLAIMER_CONTEXT =
  /no\s+(es|est[aá]|sustituye|reemplaza|constituye|se\s+ha\s+demostrado)|ni\s+(trata|es|sustituye)|sin\s+ser|no\s+es\s+un\s+medicamento/i;

/**
 * Negación inmediatamente antes de la coincidencia: "no garantiza resultados",
 * "ni garantiza resultados", "no sustituye… ni promete…".
 * Evita marcar avisos legales legítimos como si fueran afirmaciones.
 */
const NEGATION_BEFORE = /(?:^|[\s,;:(])(?:no|ni|nunca|jam[aá]s|sin)\s+(?:\w+\s+){0,3}$/i;

/**
 * Busca afirmaciones prohibidas en un texto.
 * @param {unknown} value
 * @param {{ path?: string }} [options]
 * @returns {{ id: string, label: string, excerpt: string, path: string }[]}
 */
export function findClaims(value, options = {}) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  const { path = '' } = options;
  const text = value;
  /** @type {{ id: string, label: string, excerpt: string, path: string }[]} */
  const violations = [];

  for (const { id, label, pattern, unless } of FORBIDDEN_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 60), index);

    // 1) Negación inmediata ("no garantiza…", "ni promete…"): es un aviso, no un claim.
    if (NEGATION_BEFORE.test(before)) continue;
    // 2) Excepción propia del patrón.
    if (unless && unless.test(text)) continue;
    // 3) Aviso legal explícito justo antes ("no es un medicamento", "no sustituye…").
    if (DISCLAIMER_CONTEXT.test(before)) continue;

    violations.push({
      id,
      label,
      path,
      excerpt: excerptAround(text, index, match[0].length),
    });
  }
  return violations;
}

/** @param {string} text @param {number} index @param {number} length */
function excerptAround(text, index, length) {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * Recorre recursivamente un objeto de configuración y devuelve todas las
 * cadenas con su ruta (para auditar configuraciones completas).
 * @param {unknown} value
 * @param {string} [path]
 * @returns {{ path: string, value: string }[]}
 */
export function collectConfigStrings(value, path = '') {
  /** @type {{ path: string, value: string }[]} */
  const out = [];
  if (typeof value === 'string') {
    out.push({ path, value });
    return out;
  }
  if (typeof value === 'function') return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => out.push(...collectConfigStrings(item, `${path}[${index}]`)));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(...collectConfigStrings(child, path ? `${path}.${key}` : key));
    }
  }
  return out;
}

/**
 * Rutas de las afirmaciones factuales revisadas y aprobadas por el negocio.
 *
 * Se aceptan ÚNICAMENTE los campos `…trust.claim` y solo si ese bloque lleva
 * `claimVerified === true`. Cualquier otra cifra de clientes/personas escrita en
 * otro campo (o la misma frase copiada a un párrafo) sigue bloqueando la
 * publicación: así la cifra es una decisión consciente del negocio y no un texto
 * colado sin revisar.
 *
 * @param {Record<string, unknown>} configs
 * @returns {Set<string>}
 */
function approvedClaimPaths(configs) {
  /** @type {Set<string>} */
  const approved = new Set();
  for (const [name, config] of Object.entries(configs)) {
    const trust = config?.trust;
    if (!trust || typeof trust !== 'object' || trust.claimVerified !== true) continue;
    for (const { path } of collectConfigStrings(trust, `${name}.trust`)) {
      if (/(^|\.)claim$/.test(path)) approved.add(path);
    }
  }
  return approved;
}

/**
 * Audita una o varias configuraciones completas.
 * @param {Record<string, unknown>} configs  ej: { product: productConfig, content: contentConfig }
 * @returns {{ id: string, label: string, excerpt: string, path: string }[]}
 */
export function auditConfigs(configs) {
  /** @type {{ id: string, label: string, excerpt: string, path: string }[]} */
  const violations = [];
  const approved = approvedClaimPaths(configs);
  for (const [name, config] of Object.entries(configs)) {
    for (const { path, value } of collectConfigStrings(config, name)) {
      if (approved.has(path)) continue;
      violations.push(...findClaims(value, { path }));
    }
  }
  return violations;
}
