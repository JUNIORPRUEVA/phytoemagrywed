(() => {
  'use strict';
  let ready=false;
  const clear=()=>{ready=true;clearTimeout(timer);document.getElementById('startup-recovery')?.remove();};
  function recover(){
    if(ready||document.getElementById('startup-recovery'))return;
    const splash=document.getElementById('splash');if(splash)splash.hidden=true;
    const panel=document.createElement('section');panel.id='startup-recovery';panel.setAttribute('role','alert');
    Object.assign(panel.style,{position:'fixed',inset:'0',zIndex:'20000',display:'grid',placeContent:'center',gap:'16px',padding:'max(24px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom))',background:'#0b1424',color:'#eef5ff',fontFamily:'system-ui,sans-serif',textAlign:'center'});
    panel.innerHTML='<strong style="font-size:24px">FullTECH, SRL</strong><h1 style="font-size:19px;margin:0">No pudimos completar la carga</h1><p style="max-width:340px;margin:0;line-height:1.6">Revisa tu conexión y vuelve a intentarlo. Tus datos guardados en este teléfono se conservan.</p><button type="button" style="min-height:48px;border:0;border-radius:14px;padding:12px 24px;background:#91bfff;color:#0b1424;font:inherit;font-weight:600">Volver a cargar</button>';
    panel.querySelector('button').addEventListener('click',async()=>{
      try{const registration=await navigator.serviceWorker?.getRegistration('/admin/');await Promise.race([registration?.update(),new Promise(resolve=>setTimeout(resolve,1500))]);}catch{}
      const url=new URL(location.href);url.searchParams.set('_reload',Date.now().toString());location.replace(url.href);
    });
    document.body.append(panel);
  }
  const timer=setTimeout(()=>{
    if(document.getElementById('app')?.hidden!==false&&document.getElementById('login')?.hidden!==false)recover();
  },12000);
  window.addEventListener('fulltech:startup-ready',clear);
  window.addEventListener('fulltech:startup-failed',recover);
  window.addEventListener('error',event=>{
    const file=event.filename||event.target?.src||'';
    if(/\/admin\/app\.js(?:\?|$)/.test(file))recover();
  },true);
})();
