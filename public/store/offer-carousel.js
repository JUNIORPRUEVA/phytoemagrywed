/* Native scrolling with one disposable, pausable autoplay timer. */
const mounted=new WeakMap();
export function mountOfferCarousel(root){
  if(!root)return ()=>{};
  mounted.get(root)?.();
  const track=root.querySelector('.ft-offer-track'),play=root.querySelector('[data-carousel-play]');
  if(!track)return ()=>{};
  const controller=new AbortController(),signal=controller.signal;
  const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
  let paused=false,hovered=false,focused=false,visible=true,pointer=null,dragged=false,disposed=false;
  const update=()=>{if(!play)return;play.hidden=motion.matches;play.textContent=paused?'Reproducir':'Pausar';play.setAttribute('aria-pressed',String(paused));play.setAttribute('aria-label',paused?'Reproducir rotación de ofertas':'Pausar rotación de ofertas');};
  const stop=()=>{paused=true;update();};
  const step=()=>track.children[1]?.offsetLeft-track.children[0]?.offsetLeft||track.clientWidth*.8;
  const slide=(direction,automatic=false)=>{
    if(!automatic)stop();
    const max=track.scrollWidth-track.clientWidth;
    const left=automatic&&track.scrollLeft>=max-2?0:Math.max(0,Math.min(max,track.scrollLeft+direction*step()));
    track.scrollTo({left,behavior:motion.matches?'instant':'smooth'});
  };
  root.querySelectorAll('[data-slide]').forEach(button=>button.addEventListener('click',()=>slide(Number(button.dataset.slide)),{signal}));
  play?.addEventListener('click',()=>{paused=!paused;update();},{signal});
  root.addEventListener('mouseenter',()=>{hovered=true;},{signal});root.addEventListener('mouseleave',()=>{hovered=false;},{signal});
  root.addEventListener('focusin',()=>{focused=true;},{signal});root.addEventListener('focusout',e=>{focused=root.contains(e.relatedTarget);},{signal});
  track.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();slide(e.key==='ArrowRight'?1:-1);}},{signal});
  track.addEventListener('wheel',stop,{passive:true,signal});
  track.addEventListener('pointerdown',e=>{stop();dragged=false;if(e.pointerType==='mouse'&&e.button===0&&!e.target.closest('button'))pointer={id:e.pointerId,x:e.clientX,left:track.scrollLeft};},{signal});
  track.addEventListener('pointermove',e=>{if(!pointer||pointer.id!==e.pointerId)return;if(Math.abs(e.clientX-pointer.x)>6){dragged=true;track.setPointerCapture?.(e.pointerId);track.scrollLeft=pointer.left-(e.clientX-pointer.x);e.preventDefault();}},{signal});
  const end=()=>{if(pointer&&track.hasPointerCapture?.(pointer.id))track.releasePointerCapture(pointer.id);pointer=null;};
  track.addEventListener('pointerup',end,{signal});track.addEventListener('pointercancel',end,{signal});
  track.addEventListener('dragstart',e=>e.preventDefault(),{signal});
  track.addEventListener('click',e=>{if(dragged){e.preventDefault();e.stopPropagation();dragged=false;}},{capture:true,signal});
  motion.addEventListener('change',update,{signal});
  const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{visible=entries.some(e=>e.isIntersecting);},{threshold:.1}):null;
  observer?.observe(root);
  const timer=track.children.length>=3?setInterval(()=>{if(!root.isConnected){dispose();return;}if(!paused&&!hovered&&!focused&&!pointer&&visible&&!document.hidden&&!motion.matches)slide(1,true);},3000):null;
  function dispose(){if(disposed)return;disposed=true;clearInterval(timer);controller.abort();observer?.disconnect();mounted.delete(root);}
  mounted.set(root,dispose);update();return dispose;
}
