/** Native horizontal scrolling, optional autoplay and one disposable timer. */
export function mountInfoSlider(root,{win=window,doc=document}={}){
  if(!root)return ()=>{};
  const track=root.querySelector('.ft-info-slider__track'),slides=[...track.children],controller=new AbortController(),{signal}=controller;
  const reduced=win.matchMedia('(prefers-reduced-motion: reduce)'),pause=root.querySelector('[data-info-pause]');
  let index=0,timer,paused=reduced.matches,hover=false,focused=false;
  function sync(){index=Math.min(slides.length-1,Math.max(0,Math.round(track.scrollLeft/Math.max(1,track.clientWidth))));root.querySelector('[data-info-position]').textContent=`${index+1} / ${slides.length}`;}
  function move(step){index=(index+step+slides.length)%slides.length;track.scrollTo({left:index*track.clientWidth,behavior:reduced.matches?'instant':'smooth'});root.querySelector('[data-info-position]').textContent=`${index+1} / ${slides.length}`;}
  function schedule(){win.clearInterval(timer);timer=null;if(!paused&&!hover&&!focused&&!doc.hidden&&slides.length>1)timer=win.setInterval(()=>move(1),6000);}
  function state(){pause.innerHTML=`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="currentColor">${paused?'<path d="M5 3l7 5-7 5z"/>':'<rect x="4" y="3" width="3" height="10" rx=".5"/><rect x="9" y="3" width="3" height="10" rx=".5"/>'}</svg>`;pause.setAttribute('aria-label',paused?'Reanudar información automática':'Pausar información automática');pause.setAttribute('aria-pressed',String(paused));schedule();}
  root.querySelector('[data-info-prev]').addEventListener('click',()=>move(-1),{signal});root.querySelector('[data-info-next]').addEventListener('click',()=>move(1),{signal});
  pause.addEventListener('click',()=>{paused=!paused;state();},{signal});track.addEventListener('scroll',sync,{passive:true,signal});
  root.addEventListener('mouseenter',()=>{hover=true;schedule();},{signal});root.addEventListener('mouseleave',()=>{hover=false;schedule();},{signal});
  root.addEventListener('focusin',()=>{focused=true;schedule();},{signal});root.addEventListener('focusout',e=>{focused=root.contains(e.relatedTarget);schedule();},{signal});
  doc.addEventListener('visibilitychange',schedule,{signal});state();
  return ()=>{win.clearInterval(timer);controller.abort();};
}
