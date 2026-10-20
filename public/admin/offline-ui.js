(() => {
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  /*
   * LO QUE VE LA PERSONA, NO EL CÓDIGO DEL SERVIDOR.
   * Cada cambio guardado se explica con su tipo, su fecha y su estado real, y
   * un rechazo se lee como una frase («el formato de los avisos descartados
   * venía de una versión anterior»), no como `invalid_dismissals`.
   */
  const TIPOS=[['/notification-dismissals','Aviso descartado'],['/orders','Pedido'],['/pos/','Venta o cotización'],['/inventory','Inventario'],['/store/','Catálogo'],['/customers','Cliente'],['/delivery','Entrega'],['/users','Usuario'],['/settings','Configuración'],['/followups','Seguimiento'],['/messages','Plantilla']];
  const tipoCola=q=>{const p=String(q.path||'');const encontrado=TIPOS.find(([trozo])=>p.includes(trozo));return encontrado?encontrado[1]:'Cambio guardado';};
  const estadoCola=q=>q.state==='pending'?(q.attempts?`Pendiente de enviar · ${q.attempts} intento${q.attempts>1?'s':''}`:'Pendiente de enviar'):q.state==='preparing'?'Preparando…':q.state==='confirmed'?'Confirmado en el servidor':q.state==='review'?'Requiere revisión':'Guardado en el dispositivo';
  const motivoCola=q=>{if(!q.error)return '';const codigo=q.lastError?.error?` (${q.lastError.error})`:'';return `${q.error}${codigo}`;};
  const textoServidor=q=>{
    const s=q.servidor;if(!s)return '';
    const mapa={completada:s.aplicada?'ya aplicada en el servidor':`el servidor respondió ${s.http??'sin código'}`.trim(),no_recibida:'el servidor no la recibió',en_proceso:'en proceso',clave_invalida:'identificador no válido'};
    return `<p class="offline-server">Servidor: ${esc(mapa[s.estado]||s.estado)}${s.at?` · ${esc(new Date(s.at).toLocaleString('es-DO'))}`:''}</p>`;
  };
  const accionesCola=(q,rol)=>{
    if(q.state==='resuelto')return `<p class="offline-server">Resuelta${q.resuelto?.auditado?' y registrada en auditoría':''}: ${esc(q.resuelto?.motivo||'')}</p>`;
    const botones=[`<button class="btn btn--ghost btn--sm" type="button" data-offline-verify="${esc(q.id)}">Verificar en servidor</button>`];
    // Solo se puede «reintentar reparada» cuando hay una traducción validada del contenido.
    if(q.state==='review'&&/\/notification-dismissals$/.test(String(q.path||'')))botones.push(`<button class="btn btn--ghost btn--sm" type="button" data-offline-repair="${esc(q.id)}">Reintentar operación reparada</button>`);
    if(q.state==='review'&&rol==='ADMIN')botones.push(`<button class="btn btn--ghost btn--sm" type="button" data-offline-resolve="${esc(q.id)}">Resolver manualmente</button>`);
    return `<div class="offline-queue-actions">${botones.join('')}</div>`;
  };
  const recursos=prep=>{
    if(!prep)return 'La copia todavía no está preparada.';
    const partes=[`${prep.completed} recursos descargados`];
    if(prep.remaining)partes.push('Descargando…');
    if(prep.failed)partes.push(`${prep.failed} pendientes de reintento`);
    if(prep.at)partes.push(`última descarga ${new Date(prep.at).toLocaleString('es-DO')}`);
    const criticos=prep.criticosFaltan||[];
    if(prep.listo===false||criticos.length)partes.push('Preparación parcial: faltan datos esenciales');
    else if(prep.listo===true&&prep.failed)partes.push('Lo esencial está completo; lo que falta es opcional');
    else if(prep.failed)partes.push('Revisa el detalle antes de salir sin conexión');
    return partes.join(' · ');
  };
  let button,dialog;
  /*
   * ESTADO DEL ENVÍO AUTOMÁTICO, A LA VISTA.
   *
   * «Pendiente» sin más no decía si el panel lo estaba intentando ni por qué no
   * salía. Aquí se ve el último intento, el siguiente reintento y el motivo.
   */
  const estadoMotor=()=>{
    const s=window.FulltechSync?.state?.();
    if(!s)return '';
    const hace=ms=>ms?`hace ${Math.max(0,Math.round((Date.now()-ms)/1000))} s`:'todavía no';
    if(!s.pending)return s.lastSuccess?`<p class="offline-sync-state">Todo enviado ${esc(hace(s.lastSuccess))}.</p>`:'';
    const falta=s.nextAt?Math.max(0,Math.ceil((s.nextAt-Date.now())/1000)):0;
    const motivo=s.lastError?` · ${esc(s.lastError)}`:' · enviando…';
    return `<p class="offline-sync-state" role="status">${s.pending} cambio(s) en cola · último intento ${esc(hace(s.lastAttempt))}${falta?` · próximo reintento en ${falta} s`:''}${motivo}</p>`;
  };
  async function render(){
    if(!button)return;
    const status=await window.FulltechOffline.status();
    let old=[],problems=[];try{old=JSON.parse(localStorage.getItem('pe_crm_outbox')||'[]');problems=JSON.parse(localStorage.getItem('pe_crm_outbox_problems')||'[]');}catch{}
    const pendientesCola=status.queue.filter(q=>q.state==='pending');
    // Rechazadas e históricas requieren revisión humana, no se pueden enviar.
    // No se cuentan como sincronización pendiente ni mantienen un aviso activo.
    const count=pendientesCola.length+old.length;
    const pendientes=count;
    button.hidden=pendientes===0;
    const numero=button.querySelector('.drawer__offline-count');
    if(numero)numero.textContent=pendientes>99?'99+':String(pendientes);
    const etiqueta=pendientes===1?'1 cambio pendiente de enviar':`${pendientes} cambios pendientes de enviar`;
    button.setAttribute('aria-label',etiqueta);button.title=etiqueta;
    button.dataset.review='false';
    document.querySelector('#state-pill')?.setAttribute('title',count?`${count} cambios guardados en el dispositivo`:status.valid?'Copia local disponible':'Conecta para descargar una copia local');
  }
  async function show(){
    window.dispatchEvent(new CustomEvent('fulltech:main-drawer',{detail:{open:false}}));
    const status=await window.FulltechOffline.status(),prep=status.preparation;
    const respaldo=await window.FulltechOffline.backup?.().catch(()=>null);
    /*
     * DIAGNÓSTICO VISIBLE (solo lo técnico, sin datos de clientes): qué ruta
     * falló, si fue red / tiempo / HTTP y si había copia. Sirve para saber si un
     * aparato está realmente descargado antes de salir sin conexión.
     */
    const diag=(window.FulltechOffline.diagnostics?.()||[]).slice(-6).reverse();
    const cuando=ms=>new Date(ms).toLocaleString('es-DO');
    let legacy=[],pending=[];try{legacy=JSON.parse(localStorage.getItem('pe_crm_outbox_problems')||'[]');pending=JSON.parse(localStorage.getItem('pe_crm_outbox')||'[]');}catch{}
    // Contadores propios del diálogo (no se comparten con el botón del menú).
    const pendientesCola=status.queue.filter(q=>q.state==='pending');
    const review=status.queue.filter(q=>q.state==='review');
    const count=pendientesCola.length+pending.length;
    dialog.innerHTML=`<header><h2>Datos sin conexión</h2><button type="button" data-offline-close aria-label="Cerrar">×</button></header><div class="offline-dialog-body"><p>${status.valid?`Acceso local hasta ${esc(new Date(status.expiresAt).toLocaleString('es-DO'))} · quedan ${esc(Math.max(0,Math.round((status.expiresAt-Date.now())/3600000)))} h.`:'Conéctate e inicia sesión para descargar tus datos.'}</p><p>${esc(recursos(prep))}</p><p>Los mensajes y llamadas necesitan internet. Los cambios locales se validan en el servidor al sincronizar.</p>${respaldo?`<p>Copia de recuperación del ${esc(new Date(respaldo.at).toLocaleString('es-DO'))} con ${(respaldo.operaciones||[]).length} operaciones. No se borra al sincronizar.</p><button class="btn btn--ghost" type="button" data-offline-backup-original>Descargar copia de recuperación</button>`:''}<button class="btn btn--ghost" type="button" data-offline-prepare ${!navigator.onLine?'disabled':''}>Preparar dispositivo / actualizar copia</button><button class="btn btn--primary" type="button" data-offline-sync>Reintentar ahora</button>${estadoMotor()}<h3>${count} cambios pendientes${review.length?` · ${review.length} requieren revisión`:''}</h3><div>${status.queue.map(q=>`<article class="offline-queue-row"><strong>${esc(q.body?.name||q.body?.sku||tipoCola(q))}</strong><small>${esc(new Date(q.at).toLocaleString('es-DO'))} · ${esc(estadoCola(q))}</small>${motivoCola(q)?`<p role="alert">${esc(motivoCola(q))}</p>`:''}${textoServidor(q)}${accionesCola(q,status.rol)}</article>`).join('')||(pending.length?'':'<p>No hay cambios pendientes en esta cuenta.</p>')}${pending.map(q=>`<article class="offline-queue-row"><strong>${esc(q.label||q.kind)}</strong><small>Pendiente</small></article>`).join('')}${legacy.map(q=>`<p role="alert">${esc(q.label)}: ${esc(q.motivo)}</p>`).join('')}</div>${(prep?.fallos?.length)?`<details class="offline-diagnostics"><summary>Recursos que fallaron (${prep.fallos.length})</summary><ul>${prep.fallos.slice(0,20).map(f=>`<li>${esc(String(f.path||'').replace('/api/admin/',''))} · ${esc(f.status?'HTTP '+f.status:(f.cause||'sin respuesta'))}</li>`).join('')}</ul></details>`:''}${diag.length?`<details class="offline-diagnostics"><summary>Diagnóstico (${diag.length})</summary><ul>${diag.map(d=>`<li>${esc(new Date(d.at).toLocaleTimeString('es-DO'))} · ${esc(d.path)} · ${esc(d.cause)}${d.status?' '+esc(d.status):''}${d.copy?' · con copia':' · sin copia'}</li>`).join('')}</ul></details>`:''}<button class="btn btn--ghost" type="button" data-offline-backup ${!status.queue.length&&!pending.length&&!legacy.length?'disabled':''}>Guardar copia de los cambios pendientes</button><p class="offline-dialog-error" role="alert"></p></div>`;
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
      const verificar=e.target.closest('[data-offline-verify]');
      if(verificar){verificar.disabled=true;try{await window.FulltechOffline.verificar([verificar.dataset.offlineVerify]);await show();}catch(error){dialog.querySelector('.offline-dialog-error').textContent=error.message;}return;}
      const reparar=e.target.closest('[data-offline-repair]');
      if(reparar){reparar.disabled=true;try{await window.FulltechOffline.reintentar(reparar.dataset.offlineRepair);await show();}catch(error){dialog.querySelector('.offline-dialog-error').textContent=error.message;}return;}
      const resolver=e.target.closest('[data-offline-resolve]');
      if(resolver){
        const motivo=prompt('Motivo de la resolución (queda en la auditoría del CRM):');
        if(!motivo||motivo.trim().length<4)return;
        resolver.disabled=true;
        try{await window.FulltechOffline.resolver(resolver.dataset.offlineResolve,motivo.trim());await show();}catch(error){dialog.querySelector('.offline-dialog-error').textContent=error.message;}
        return;
      }
      const action=e.target.closest('[data-offline-prepare],[data-offline-sync],[data-offline-backup],[data-offline-backup-original]');if(!action)return;
      action.disabled=true;
      try{
        if(action.hasAttribute('data-offline-backup-original')){
          const copia=await window.FulltechOffline.backup?.();
          if(copia){
            const blob=new Blob([JSON.stringify(copia,null,2)],{type:'application/json'});
            const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='Fulltech-copia-recuperacion.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
          }
        }
        if(action.hasAttribute('data-offline-prepare'))await window.FulltechOffline.warm(true);
        if(action.hasAttribute('data-offline-sync')){
          // Con el motor único el envío no espera a ningún aviso: se intenta ya.
          if(window.FulltechSync?.kick)await window.FulltechSync.kick('manual');
          else await window.FulltechOffline.synchronize();
        }
        if(action.hasAttribute('data-offline-backup')){
          const blob=new Blob([JSON.stringify({version:1,createdAt:new Date().toISOString(),operations:await window.FulltechOffline.listQueue(),legacyPending:JSON.parse(localStorage.getItem('pe_crm_outbox')||'[]'),legacyProblems:JSON.parse(localStorage.getItem('pe_crm_outbox_problems')||'[]')},null,2)],{type:'application/json'});
          const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='Fulltech-cambios-pendientes.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
        }
        await show();
      }catch(error){dialog.querySelector('.offline-dialog-error').textContent=error.message;}finally{action.disabled=false;}
    });
    render().catch(()=>{});
    document.querySelector('#drawer-offline')?.addEventListener('click',()=>show().catch(console.error));
  });
  window.addEventListener('fulltech:offline-status',()=>render().catch(()=>{}));
  /*
   * EL BOTÓN DEL MENÚ SE ACTUALIZA CON EL MOTOR.
   *
   * Antes solo cambiaba al abrir o cerrar el diálogo: después de enviarse solo,
   * el número seguía ahí hasta recargar. Con rebote para no repetir lecturas en
   * cada intento.
   */
  let refresco=null;
  window.addEventListener('fulltech:sync-status',()=>{
    clearTimeout(refresco);
    refresco=setTimeout(()=>render().catch(()=>{}),400);
  });
})();
