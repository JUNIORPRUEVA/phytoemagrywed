(() => {
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let button,dialog;
  async function render(){
    if(!button)return;
    const status=await window.FulltechOffline.status();
    let old=[],problems=[];try{old=JSON.parse(localStorage.getItem('pe_crm_outbox')||'[]');problems=JSON.parse(localStorage.getItem('pe_crm_outbox_problems')||'[]');}catch{}
    const review=[...status.queue.filter(q=>q.state!=='pending'),...problems],count=status.queue.length+old.length;
    button.textContent=review.length?`Revisar ${review.length} cambio(s)`:count?`${count} cambio(s) pendientes`:status.preparation?.remaining===0&&status.valid&&status.shell&&!status.shell.missing.length?'Datos sin conexión':'Preparar datos sin conexión';
    button.dataset.review=String(!!review.length);
    document.querySelector('#state-pill')?.setAttribute('title',count?`${count} cambios guardados en el dispositivo`:status.valid?'Copia local disponible':'Conecta para descargar una copia local');
  }
  async function show(){
    window.dispatchEvent(new CustomEvent('fulltech:main-drawer',{detail:{open:false}}));
    const status=await window.FulltechOffline.status(),prep=status.preparation;
    let legacy=[];try{legacy=JSON.parse(localStorage.getItem('pe_crm_outbox_problems')||'[]');}catch{}
    dialog.innerHTML=`<header><h2>Datos sin conexión</h2><button type="button" data-offline-close aria-label="Cerrar">×</button></header><div class="offline-dialog-body"><p>${status.valid?`Acceso local hasta ${esc(new Date(status.expiresAt).toLocaleString('es-DO'))}.`:'Conéctate e inicia sesión para descargar tus datos.'}</p><p>${prep?`${prep.completed} recursos descargados${prep.remaining?' · Descargando…':''}${prep.failed?' · '+prep.failed+' recursos necesitan reintento':''}`:'La copia todavía no está preparada.'}</p><p>Los mensajes y llamadas necesitan internet. Los cambios locales se validan en el servidor al sincronizar.</p><button class="btn btn--ghost" type="button" data-offline-prepare ${!navigator.onLine?'disabled':''}>Actualizar copia local</button><button class="btn btn--primary" type="button" data-offline-sync ${!navigator.onLine?'disabled':''}>Sincronizar cambios</button><h3>${status.queue.length} cambios pendientes</h3><div>${status.queue.map(q=>`<article class="offline-queue-row"><strong>${esc(q.body.name||q.body.sku||({'checkout':'Venta','quotes':'Cotización','tickets':'Ticket','stock':'Movimiento de stock'})[q.path.split('/').pop()]||'Cambio guardado')}</strong><small>${esc(new Date(q.at).toLocaleString('es-DO'))} · ${q.state==='pending'?'Pendiente':'Revisar'}</small>${q.error?`<p role="alert">${esc(q.error)}</p>`:''}</article>`).join('')||'<p>No hay cambios pendientes en esta cuenta.</p>'}${legacy.map(q=>`<p role="alert">${esc(q.label)}: ${esc(q.motivo)}</p>`).join('')}</div><button class="btn btn--ghost" type="button" data-offline-backup ${!status.queue.length?'disabled':''}>Guardar copia de los cambios pendientes</button><p class="offline-dialog-error" role="alert"></p></div>`;
    if(!dialog.open)dialog.showModal();
  }
  window.addEventListener('DOMContentLoaded',()=>{
    const foot=document.querySelector('.drawer__foot');if(!foot)return;
    button=document.createElement('button');button.type='button';button.className='drawer__item offline-status';button.addEventListener('click',()=>show().catch(console.error));foot.prepend(button);
    // Los avisos operativos viven en el menú; dejan de cubrir los controles de la pantalla.
    const update=document.querySelector('#update-bar');if(update)foot.append(update);
    dialog=document.createElement('dialog');dialog.className='offline-dialog';document.body.append(dialog);
    dialog.addEventListener('click',async e=>{
      if(e.target.closest('[data-offline-close]')){dialog.close();return;}
      const action=e.target.closest('[data-offline-prepare],[data-offline-sync],[data-offline-backup]');if(!action)return;
      action.disabled=true;
      try{
        if(action.hasAttribute('data-offline-prepare'))await window.FulltechOffline.warm(true);
        if(action.hasAttribute('data-offline-sync'))await window.FulltechOffline.synchronize();
        if(action.hasAttribute('data-offline-backup')){
          const blob=new Blob([JSON.stringify({version:1,createdAt:new Date().toISOString(),operations:await window.FulltechOffline.listQueue()},null,2)],{type:'application/json'});
          const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='Fulltech-cambios-pendientes.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
        }
        await show();
      }catch(error){dialog.querySelector('[role=alert]').textContent=error.message;}finally{action.disabled=false;}
    });
    render().catch(()=>{});
  });
  window.addEventListener('fulltech:offline-status',()=>render().catch(()=>{}));
})();
