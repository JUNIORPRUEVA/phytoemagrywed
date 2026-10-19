(() => {
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let button,dialog;
  async function render(){
    if(!button)return;
    const status=await window.FulltechOffline.status();
    let old=[],problems=[];try{old=JSON.parse(localStorage.getItem('pe_crm_outbox')||'[]');problems=JSON.parse(localStorage.getItem('pe_crm_outbox_problems')||'[]');}catch{}
    const review=[...status.queue.filter(q=>q.state!=='pending'),...problems],count=status.queue.length+old.length;
    // Compacto: solo asoma cuando HAY algo que revisar o sincronizar.
    const pendientes=count+review.length;
    button.hidden=pendientes===0;
    const numero=button.querySelector('.drawer__offline-count');
    if(numero)numero.textContent=pendientes>99?'99+':String(pendientes);
    const etiqueta=pendientes===1?'1 cambio pendiente de sincronizar':`${pendientes} cambios pendientes de sincronizar`;
    button.setAttribute('aria-label',etiqueta);button.title=etiqueta;
    button.dataset.review=String(!!review.length);
    document.querySelector('#state-pill')?.setAttribute('title',count?`${count} cambios guardados en el dispositivo`:status.valid?'Copia local disponible':'Conecta para descargar una copia local');
  }
  async function show(){
    window.dispatchEvent(new CustomEvent('fulltech:main-drawer',{detail:{open:false}}));
    const status=await window.FulltechOffline.status(),prep=status.preparation;
    /*
     * DIAGNÓSTICO VISIBLE (solo lo técnico, sin datos de clientes): qué ruta
     * falló, si fue red / tiempo / HTTP y si había copia. Sirve para saber si un
     * aparato está realmente descargado antes de salir sin conexión.
     */
    const diag=(window.FulltechOffline.diagnostics?.()||[]).slice(-6).reverse();
    const cuando=ms=>new Date(ms).toLocaleString('es-DO');
    let legacy=[],pending=[];try{legacy=JSON.parse(localStorage.getItem('pe_crm_outbox_problems')||'[]');pending=JSON.parse(localStorage.getItem('pe_crm_outbox')||'[]');}catch{}
    dialog.innerHTML=`<header><h2>Datos sin conexión</h2><button type="button" data-offline-close aria-label="Cerrar">×</button></header><div class="offline-dialog-body"><p>${status.valid?`Acceso local hasta ${esc(new Date(status.expiresAt).toLocaleString('es-DO'))} · quedan ${esc(Math.max(0,Math.round((status.expiresAt-Date.now())/3600000)))} h.`:'Conéctate e inicia sesión para descargar tus datos.'}</p><p>${prep?`${prep.completed} recursos descargados${prep.remaining?' · Descargando…':''}${prep.failed?' · '+prep.failed+' necesitan reintento':''}${prep.at?` · última descarga ${esc(cuando(prep.at))}`:''}`:'La copia todavía no está preparada.'}</p><p>Los mensajes y llamadas necesitan internet. Los cambios locales se validan en el servidor al sincronizar.</p><button class="btn btn--ghost" type="button" data-offline-prepare ${!navigator.onLine?'disabled':''}>Preparar dispositivo / actualizar copia</button><button class="btn btn--primary" type="button" data-offline-sync ${!navigator.onLine?'disabled':''}>Sincronizar ahora</button><h3>${status.queue.length+pending.length} cambios pendientes</h3><div>${status.queue.map(q=>`<article class="offline-queue-row"><strong>${esc(q.body.name||q.body.sku||({'checkout':'Venta','quotes':'Cotización','tickets':'Ticket','stock':'Movimiento de stock'})[q.path.split('/').pop()]||'Cambio guardado')}</strong><small>${esc(new Date(q.at).toLocaleString('es-DO'))} · ${q.state==='pending'?'Pendiente':'Revisar'}</small>${q.error?`<p role="alert">${esc(q.error)}</p>`:''}</article>`).join('')||(pending.length?'':'<p>No hay cambios pendientes en esta cuenta.</p>')}${pending.map(q=>`<article class="offline-queue-row"><strong>${esc(q.label||q.kind)}</strong><small>Pendiente</small></article>`).join('')}${legacy.map(q=>`<p role="alert">${esc(q.label)}: ${esc(q.motivo)}</p>`).join('')}</div>${diag.length?`<details class="offline-diagnostics"><summary>Diagnóstico (${diag.length})</summary><ul>${diag.map(d=>`<li>${esc(new Date(d.at).toLocaleTimeString('es-DO'))} · ${esc(d.path)} · ${esc(d.cause)}${d.status?' '+esc(d.status):''}${d.copy?' · con copia':' · sin copia'}</li>`).join('')}</ul></details>`:''}<button class="btn btn--ghost" type="button" data-offline-backup ${!status.queue.length&&!pending.length&&!legacy.length?'disabled':''}>Guardar copia de los cambios pendientes</button><p class="offline-dialog-error" role="alert"></p></div>`;
    if(!dialog.open)dialog.showModal();
  }
  window.addEventListener('DOMContentLoaded',()=>{
    const foot=document.querySelector('.drawer__foot');if(!foot)return;
    // Ya no ocupa una fila del menú: es un botoncito junto a la apariencia y la
    // salida, y solo se ve cuando quedan cambios guardados en el dispositivo.
    const acciones=document.querySelector('.drawer__foot-actions')||foot;
    button=document.createElement('button');button.type='button';button.className='drawer__offline';button.hidden=true;
    button.innerHTML='<span aria-hidden="true">↻</span><span class="drawer__offline-count"></span>';
    button.addEventListener('click',()=>show().catch(console.error));acciones.prepend(button);
    dialog=document.createElement('dialog');dialog.className='offline-dialog';document.body.append(dialog);
    window.addEventListener('fulltech:offline-open',()=>show().catch(console.error));
    dialog.addEventListener('click',async e=>{
      if(e.target.closest('[data-offline-close]')){dialog.close();return;}
      const action=e.target.closest('[data-offline-prepare],[data-offline-sync],[data-offline-backup]');if(!action)return;
      action.disabled=true;
      try{
        if(action.hasAttribute('data-offline-prepare'))await window.FulltechOffline.warm(true);
        if(action.hasAttribute('data-offline-sync'))await window.FulltechOffline.synchronize();
        if(action.hasAttribute('data-offline-backup')){
          const blob=new Blob([JSON.stringify({version:1,createdAt:new Date().toISOString(),operations:await window.FulltechOffline.listQueue(),legacyPending:JSON.parse(localStorage.getItem('pe_crm_outbox')||'[]'),legacyProblems:JSON.parse(localStorage.getItem('pe_crm_outbox_problems')||'[]')},null,2)],{type:'application/json'});
          const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='Fulltech-cambios-pendientes.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
        }
        await show();
      }catch(error){dialog.querySelector('.offline-dialog-error').textContent=error.message;}finally{action.disabled=false;}
    });
    render().catch(()=>{});
  });
  window.addEventListener('fulltech:offline-status',()=>render().catch(()=>{}));
})();
