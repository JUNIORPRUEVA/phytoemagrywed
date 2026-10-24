/** Native horizontal scrolling, optional autoplay and one disposable timer. */
export function mountInfoSlider(root,{win=window,doc=document}={}){
  if(!root)return ()=>{};
  const track=root.querySelector('.ft-info-slider__track'),slides=[...track.children],controller=new AbortController(),{signal}=controller;
  const reduced=win.matchMedia('(prefers-reduced-motion: reduce)'),pause=root.querySelector('[data-info-pause]');
  let index=0,timer,paused=false,hover=false,focused=false,interacting=false;
  const position=root.querySelector('[data-info-position]');
  const announce=()=>{if(position)position.textContent=`${index+1} / ${slides.length}`;};
  function sync(){index=Math.min(slides.length-1,Math.max(0,Math.round(track.scrollLeft/Math.max(1,track.clientWidth))));announce();}
  function move(step){index=(index+step+slides.length)%slides.length;track.scrollTo({left:index*track.clientWidth,behavior:reduced.matches?'instant':'smooth'});announce();}
  function schedule(){win.clearInterval(timer);timer=null;if(!paused&&!reduced.matches&&!hover&&!focused&&!interacting&&!doc.hidden&&slides.length>1)timer=win.setInterval(()=>move(1),6000);}
  function state(){const stopped=paused||reduced.matches;if(pause){pause.innerHTML=`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="currentColor">${stopped?'<path d="M5 3l7 5-7 5z"/>':'<rect x="4" y="3" width="3" height="10" rx=".5"/><rect x="9" y="3" width="3" height="10" rx=".5"/>'}</svg>`;pause.setAttribute('aria-label',stopped?'Reanudar información automática':'Pausar información automática');pause.setAttribute('aria-pressed',String(stopped));}schedule();}
  root.querySelector('[data-info-prev]')?.addEventListener('click',()=>move(-1),{signal});root.querySelector('[data-info-next]')?.addEventListener('click',()=>move(1),{signal});
  pause?.addEventListener('click',()=>{paused=!paused;state();},{signal});track.addEventListener('scroll',sync,{passive:true,signal});
  track.setAttribute('aria-label','Información FULLTECH. Desliza o usa las flechas; espacio pausa o reanuda.');
  track.addEventListener('keydown',event=>{if(event.target!==track)return;if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();move(event.key==='ArrowRight'?1:-1);}else if(event.key===' '){event.preventDefault();paused=!paused;state();}},{signal});
  track.addEventListener('pointerdown',()=>{interacting=true;schedule();},{passive:true,signal});
  const endInteraction=()=>{interacting=false;schedule();};
  win.addEventListener('pointerup',endInteraction,{passive:true,signal});win.addEventListener('pointercancel',endInteraction,{passive:true,signal});
  reduced.addEventListener?.('change',()=>state(),{signal});
  root.addEventListener('mouseenter',()=>{hover=true;schedule();},{signal});root.addEventListener('mouseleave',()=>{hover=false;schedule();},{signal});
  root.addEventListener('focusin',()=>{focused=true;schedule();},{signal});root.addEventListener('focusout',e=>{focused=root.contains(e.relatedTarget);schedule();},{signal});
  doc.addEventListener('visibilitychange',schedule,{signal});state();
  return ()=>{win.clearInterval(timer);controller.abort();};
}
