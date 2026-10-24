import {expect,it} from 'vitest';
import {navigationIcon} from '../public/store/navigation-icons.js';
it.each(['home','catalog','offers','cart'])('provides distinct outline and genuinely solid SVG for %s',route=>{
 document.body.innerHTML=navigationIcon(route,'<span class="outline-original"></span>');
 expect(document.querySelector('.ft-nav-icon--outline .outline-original')).not.toBeNull();
 const solid=document.querySelector('svg');expect(solid.getAttribute('fill')).toBe('currentColor');expect(solid.querySelector('path,rect')).not.toBeNull();expect(solid.getAttribute('aria-hidden')).toBe('true');
});
