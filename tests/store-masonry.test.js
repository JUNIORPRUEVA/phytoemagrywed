import {expect,it,vi} from 'vitest';
import {mountMasonry} from '../public/store/masonry.js';
it('uses natural heights, fills the shortest column and keeps DOM/visual reading order',()=>{
 document.body.innerHTML='<main><div class="product-grid"><article>A</article><article>B</article><article>C</article><article>D</article></div></main>';
 const grid=document.querySelector('.product-grid');grid.style.cssText='grid-template-columns:100px 100px;grid-auto-rows:4px;row-gap:8px';
 const cards=[...grid.children];[200,100,140,80].forEach((height,i)=>{cards[i].getBoundingClientRect=()=>({height});});
 const instance=mountMasonry(document.querySelector('main'));
 expect(cards.map(c=>c.style.gridColumn)).toEqual(['1','2','2','1']);
 expect(cards.map(c=>parseInt(c.style.gridRow))).toEqual([1,1,10,19]);
 expect([...grid.children].map(c=>c.textContent)).toEqual(['A','B','C','D']);
 expect(cards.every(c=>!c.style.height)).toBe(true);instance.dispose();vi.restoreAllMocks();
});
