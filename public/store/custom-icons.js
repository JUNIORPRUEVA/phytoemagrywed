/** Supplied PNG silhouettes, theme-colored with CSS masks; unrelated icons retain their existing source. */
import {materialIcon as fallbackIcon,paintMaterialIcon as fallbackPaint,hydrateIcons} from './icons.js';
export {hydrateIcons};
const names=new Set(['home','categories','filter','back','share','truck','cart','whatsapp','account','down','up','plus','close','menu','delete','search']);
const aliases={user:'account','arrow-right':'back','chevron-right':'back',minus:'down'};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function materialIcon(name,options={}){
 const key=aliases[name]||name;if(!names.has(key))return fallbackIcon(name,options);
 const size=Math.max(12,Math.min(48,Number(options.size)||24));
 return `<span class="ft-custom-icon${name==='arrow-right'||name==='chevron-right'?' ft-custom-icon--forward':''}" data-custom-icon="${key}" style="--icon-url:url('/store/assets/icons/custom/${key}.png');--icon-size:${size}px" ${options.label?`role="img" aria-label="${escape(options.label)}"`:'aria-hidden="true"'}></span>`;
}
export function paintMaterialIcon(node,name,options={}){
 if(!node)return;const key=aliases[name]||name;if(!names.has(key))return fallbackPaint(node,name,options);
 const size=options.size||Number(node.getAttribute('data-msr-size'))||24;
 const template=document.createElement('template');template.innerHTML=materialIcon(name,{...options,size});
 const icon=template.content.firstElementChild;icon.dataset.msr=name;icon.dataset.msrSize=String(size);node.replaceWith(icon);
}
export function hydrateMaterialIcons(root=document){root.querySelectorAll('[data-msr]').forEach(node=>paintMaterialIcon(node,node.dataset.msr));}
