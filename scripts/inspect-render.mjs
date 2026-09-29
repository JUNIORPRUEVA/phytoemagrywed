/**
 * Comprobación rápida del render (desarrollo). No forma parte del build.
 *   node scripts/inspect-render.mjs
 */
import { renderLegalPage, renderIndexPage } from '../src/render/pages.js';
import { buildView } from '../src/render/view.js';

const view = buildView();
const html = renderIndexPage(view);
const ids = [...html.matchAll(/<section[^>]*id="([^"]+)"/g)].map((match) => match[1]);

console.log('secciones       :', ids.join(', '));
console.log('tarjetas frasco  :', (html.match(/data-variant-card=/g) ?? []).length);
console.log('precio "desde"   :', /pe-price__from/.test(html));
console.log('comunidad        :', /id="comunidad"/.test(html));
console.log('afirmación miembros:', /pe-community__claim/.test(html));
console.log('enlace com. en compra:', /data-action="scroll-to-community"/.test(html));
console.log('grupo elegido    :', view.community.active?.id ?? 'ninguno');
console.log('faq (total)      :', view.lists.faqItems.length);
console.log('wa.me en HTML    :', /wa.me/.test(html));
console.log('precio tachado   :', /pe-price__compare/.test(html));
console.log('tamaño index     :', html.length, 'bytes');
console.log('tamaño legales   :', renderLegalPage(view).length, 'bytes');

const precio = view.pricing.forVariant('capsules_30', 2);
console.log('30 cápsulas × 2  :', precio.totalLabel, `(${precio.totalCapsules} cápsulas)`);
