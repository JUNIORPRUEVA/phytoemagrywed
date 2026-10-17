import nspell from 'nspell';
import { createProofreader } from './proofreading-core.mjs';

let checker;
async function loadDictionary() {
  if (!checker) checker = Promise.all(['es-DO.aff', 'es-DO.dic'].map(async (name) => {
    const response = await fetch(new URL(name, self.location.href));
    if (!response.ok) throw new Error('dictionary_unavailable');
    return response.text();
  })).then(([aff, dic]) => createProofreader(nspell(aff, dic)));
  return checker;
}
self.addEventListener('message', async ({ data }) => {
  if (!data || !['check', 'warmup'].includes(data.type)) return;
  try {
    const check = await loadDictionary();
    if (data.type === 'warmup') { self.postMessage({ type: 'ready' }); return; }
    const options = { names: data.names || [] };
    const review = check(data.text, options);
    self.postMessage({ id: data.id, review, suggestion: data.ignored?.length ? check(data.text, { ...options, ignored: data.ignored }) : review });
  } catch {
    self.postMessage({ id: data.id, unavailable: true });
  }
});
