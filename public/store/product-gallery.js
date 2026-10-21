const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function mountCardImageFallbacks(root){
  root.addEventListener('error',event=>{const image=event.target;if(image.tagName!=='IMG')return;const host=image.closest('.product-image,.ft-card__media');if(!host)return;image.hidden=true;if(!host.querySelector('.image-fallback')){const label=root.ownerDocument.createElement('span');label.className='image-fallback';label.textContent='Imagen no disponible';host.append(label);}},true);
}
export function galleryMarkup(product){
  const images=(product.images??(product.imageUrl?[{url:product.imageUrl}]:[])).slice(0,3);
  return `<section class="ft-gallery" aria-label="Imágenes de ${esc(product.name)}"><div class="detail-image ft-gallery-stage" tabindex="${images.length>1?'0':'-1'}" aria-label="${images.length>1?'Usa las flechas para cambiar de imagen':'Imagen del producto'}">${images.length?`<img class="ft-gallery-main" draggable="false" src="${esc(images[0].url)}" alt="${esc(product.name)} · Imagen 1" width="640" height="640" decoding="async" fetchpriority="high">`:''}<span class="ft-gallery-fallback" ${images.length?'hidden':''}>Imagen no disponible</span></div>${images.length>1?`<div class="ft-gallery-thumbs" role="group" aria-label="Seleccionar imagen">${images.map((entry,i)=>`<button type="button" data-gallery-index="${i}" data-gallery-url="${esc(entry.url)}" aria-label="Ver imagen ${i+1} de ${images.length}" aria-pressed="${i===0}"><img src="${esc(entry.url)}" alt="" width="56" height="56" loading="lazy" decoding="async"></button>`).join('')}</div><p class="ft-gallery-status" role="status" aria-live="polite">Imagen 1 de ${images.length}</p>`:''}</section>`;
}
export function mountGallery(root){
  const gallery=root.querySelector('.ft-gallery');if(!gallery)return;
  const stage=gallery.querySelector('.ft-gallery-stage'),main=gallery.querySelector('.ft-gallery-main'),fallback=gallery.querySelector('.ft-gallery-fallback'),buttons=[...gallery.querySelectorAll('[data-gallery-index]')];
  if(!main)return;
  let current=0,start=null;
  const error=()=>{main.hidden=true;fallback.hidden=false;stage.classList.remove('is-loading');};
  const loaded=()=>{main.hidden=false;fallback.hidden=true;stage.classList.remove('is-loading');};
  main.addEventListener('error',error);main.addEventListener('load',loaded);
  if(main.complete&&main.naturalWidth===0)error();
  const select=index=>{current=(index+buttons.length)%buttons.length;const button=buttons[current];if(!button)return;
    stage.classList.add('is-loading');main.hidden=false;fallback.hidden=true;main.src=button.dataset.galleryUrl;main.alt=main.alt.replace(/Imagen \d+$/,`Imagen ${current+1}`);
    buttons.forEach((b,i)=>b.setAttribute('aria-pressed',String(i===current)));gallery.querySelector('.ft-gallery-status').textContent=`Imagen ${current+1} de ${buttons.length}`;
  };
  buttons.forEach((b,i)=>b.addEventListener('click',()=>select(i)));
  if(buttons.length<2)return;
  stage.addEventListener('keydown',event=>{if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();select(current+(event.key==='ArrowRight'?1:-1));}});
  stage.addEventListener('pointerdown',event=>{if(event.isPrimary!==false){start={x:event.clientX,y:event.clientY};if(event.pointerId!==undefined)stage.setPointerCapture?.(event.pointerId);}});
  stage.addEventListener('pointerup',event=>{if(!start)return;const dx=event.clientX-start.x,dy=event.clientY-start.y;start=null;if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy)*1.3)select(current+(dx<0?1:-1));});
  stage.addEventListener('pointercancel',()=>{start=null;});
}
