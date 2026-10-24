import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {menuMarkup,recommendedMarkup,solutionsMarkup} from '../public/store/account-hub.js';
const source=readFileSync('public/store/store.js','utf8');
it('replaces the drawer with a real link and route, including an active Menu icon',()=>{
 const html=readFileSync('public/store/index.html','utf8');
 expect(html).toContain('href="/store/#/menu"');expect(html).not.toContain('id="drawer"');expect(html).not.toContain('drawer-scrim');
 expect(source).toContain("if(path==='menu')return renderMenu()");expect(source).not.toContain('openDrawer(');
});
it('keeps guests browsing without exposing private shortcuts or customer data',()=>{
 document.body.innerHTML=menuMarkup({account:null,addressesEnabled:true});
 expect(document.querySelector('a[href$="/account/login"]')).not.toBeNull();expect(document.querySelector('a[href$="/account/register"]')).not.toBeNull();
 expect(document.querySelector('a[href$="/account/addresses"]')).toBeNull();expect(document.querySelector('a[href$="/orders"]')).toBeNull();
});
it('renders authenticated actions, escaped identity and capability-gated addresses',()=>{
 document.body.innerHTML=menuMarkup({account:{name:'<script>private</script>'},addressesEnabled:true});
 expect(document.querySelector('script')).toBeNull();expect(document.querySelector('#hub-account-title').textContent).toBe('<script>private</script>');
 for(const path of ['account','orders','favorites','account/settings','account/addresses'])expect(document.querySelector(`a[href$="/${path}"]`)).not.toBeNull();
 document.body.innerHTML=menuMarkup({account:{name:'Cliente'}});expect(document.querySelector('a[href$="/account/addresses"]')).toBeNull();
});
it('shows only the POS and capsule sites as separate ecosystem destinations',()=>{
 document.body.innerHTML=menuMarkup({});const links=[...document.querySelectorAll('.ft-hub-solutions a')];
 expect(links).toHaveLength(2);expect(links.map(a=>a.href)).toEqual(['https://fullpos.fulltechrd.com/','https://phytoemagryrd.lat/']);
 expect(document.querySelector('.ft-hub-header-actions a[href$="/account"]')).not.toBeNull();expect(document.querySelector('.ft-hub-header-actions a[href$="/account/settings"]')).not.toBeNull();
 expect(document.querySelector('.ft-hub-header button[data-back][aria-label="Volver"]')).not.toBeNull();
 expect(document.body.textContent).not.toContain('A un toque');
});
it('reuses published regional catalog/feed/cards for all recommendations',()=>{
 expect(source).toContain('batchSize:12,renderItem:productCard');expect(source).toContain('fetch(zonePath(`/api/store/catalog?kind=product');
 document.body.innerHTML=recommendedMarkup('Recomendados para ti');expect(document.querySelector('[data-hub-products]')).not.toBeNull();expect(document.body.textContent).toContain('no personalizada');
});
it('places the company photo before visible details and limits other projects to two',()=>{
 expect(source).toContain('ft-hub-about-visual');expect(source).toContain('id="fulltech-company-details"');expect(source).toContain('Entrega y cobertura');
 expect(source.indexOf('ft-hub-about-visual')).toBeLessThan(source.indexOf('${presentation}<section class="ft-hub-about-details"'));
 document.body.innerHTML=solutionsMarkup();expect(document.querySelectorAll('.ft-hub-business .ft-hub-solutions a')).toHaveLength(2);
});
it('does not introduce page-level scroll interception or viewport-height hub wrappers',()=>{
 const css=readFileSync('public/store/account-hub.css','utf8');
 expect(css).not.toMatch(/overflow(?:-y)?\s*:\s*(hidden|auto|scroll)|height\s*:\s*100[dsv]?vh|position\s*:\s*fixed/);
 expect(source).not.toContain('mountReverseScroll');
});
