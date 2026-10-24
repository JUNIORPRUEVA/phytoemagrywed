/** Explicit store preference: reverse vertical touch/wheel, not DOM or keyboard order. */
export function mountReverseScroll({win=window,doc=document}={}){
  const controller=new AbortController(),signal=controller.signal;
  let gesture=null,frame=0,velocity=0,lastFrame=0;
  // Overlays own their scrolling, including their scrim: never move the shop
  // underneath an open drawer. Run in capture so card handlers cannot swallow
  // the vertical gesture before it reaches the reverse-scroll controller.
  const protectedTarget=target=>doc.querySelector('.drawer.open,dialog[open],[role="dialog"][aria-modal="true"]')||target?.closest?.('input,textarea,select,[contenteditable="true"],.drawer,dialog,[role="dialog"]');
  const stop=()=>{win.cancelAnimationFrame(frame);frame=0;velocity=0;};
  const scroll=delta=>{const before=win.scrollY;win.scrollBy({top:delta,left:0,behavior:'instant'});return win.scrollY!==before;};
  const coast=now=>{
    const dt=Math.min(32,Math.max(1,now-lastFrame));lastFrame=now;
    if(doc.hidden||!scroll(velocity*dt)){stop();return;}
    velocity*=Math.pow(.9,dt/16);
    if(Math.abs(velocity)<.03){stop();return;}
    frame=win.requestAnimationFrame(coast);
  };
  win.addEventListener('wheel',event=>{
    if(event.defaultPrevented||!event.cancelable||event.ctrlKey||event.shiftKey||protectedTarget(event.target)||Math.abs(event.deltaX)>=Math.abs(event.deltaY))return;
    stop();event.preventDefault();const unit=event.deltaMode===1?16:event.deltaMode===2?win.innerHeight:1;scroll(-event.deltaY*unit);
  },{passive:false,capture:true,signal});
  win.addEventListener('touchstart',event=>{
    stop();gesture=null;if(event.touches.length!==1||protectedTarget(event.target))return;
    const t=event.touches[0];gesture={x:t.clientX,y:t.clientY,lastY:t.clientY,time:performance.now(),axis:null};
  },{passive:true,capture:true,signal});
  win.addEventListener('touchmove',event=>{
    if(!gesture||event.touches.length!==1||protectedTarget(event.target)){gesture=null;stop();return;}
    const t=event.touches[0],dx=t.clientX-gesture.x,dy=t.clientY-gesture.y;
    if(!gesture.axis){if(Math.max(Math.abs(dx),Math.abs(dy))<8){if(event.cancelable&&Math.abs(dy)>Math.abs(dx))event.preventDefault();return;}gesture.axis=Math.abs(dx)>Math.abs(dy)?'x':'y';}
    if(gesture.axis!=='y'||!event.cancelable)return;
    event.preventDefault();const now=performance.now(),step=t.clientY-gesture.lastY;
    scroll(step);velocity=Math.max(-1.8,Math.min(1.8,step/Math.max(8,now-gesture.time)));gesture.lastY=t.clientY;gesture.time=now;
  },{passive:false,capture:true,signal});
  win.addEventListener('touchend',()=>{
    const vertical=gesture?.axis==='y',recent=gesture&&performance.now()-gesture.time<100;gesture=null;
    if(vertical&&recent&&!win.matchMedia('(prefers-reduced-motion: reduce)').matches&&Math.abs(velocity)>.08){lastFrame=performance.now();frame=win.requestAnimationFrame(coast);}else stop();
  },{passive:true,signal});
  win.addEventListener('touchcancel',()=>{gesture=null;stop();},{passive:true,signal});
  win.addEventListener('keydown',stop,{signal});
  doc.addEventListener('visibilitychange',stop,{signal});
  const dispose=()=>{stop();gesture=null;controller.abort();};
  win.addEventListener('pagehide',event=>{stop();if(!event.persisted)dispose();},{signal});
  return dispose;
}
