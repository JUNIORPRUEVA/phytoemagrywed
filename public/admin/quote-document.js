/* Documento comercial: enviar la cotización al cliente por WhatsApp (API oficial).
 * NUNCA se abre un WhatsApp personal ni se comparte por la hoja del sistema. */
(() => {
  const button=document.querySelector('[data-send-quote]'),status=document.querySelector('#quote-share-status');
  button?.addEventListener('click',async()=>{
    const id=button.dataset.quote;
    if(!id||button.disabled)return;
    if(!window.confirm('¿Enviar esta cotización al cliente por WhatsApp? Recibirá el PDF como documento.'))return;
    const original=button.textContent;button.disabled=true;button.textContent='Enviando…';
    if(status){status.textContent='Enviando la cotización por WhatsApp…';status.classList.remove('is-error');}
    try{
      const response=await fetch(`/api/admin/pos/quotes/${encodeURIComponent(id)}/send-whatsapp`,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify({idempotencyKey:crypto.randomUUID()})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok||!data.ok)throw new Error(data.message||'No se pudo enviar la cotización.');
      const nombre=data.customer?.name||'el cliente';
      if(status)status.textContent=`Enviado a ${nombre} por WhatsApp.`;
      button.textContent='Enviado';
    }catch(error){
      if(status){status.textContent=error.message;status.classList.add('is-error');}
      button.disabled=false;button.textContent=original;
    }
  });
})();
