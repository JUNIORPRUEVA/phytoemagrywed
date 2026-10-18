/* Visor local: dibuja el PDF real, también en Chrome móvil sin visor nativo. */
(async()=>{
  const root=document.querySelector('[data-receipt-pages]');if(!root)return;
  const status=document.querySelector('[data-receipt-status]');
  const params=new URLSearchParams(location.search);
  /* Encabezado: la flecha vuelve al CRM y el título dice qué se está viendo. */
  document.querySelector('[data-receipt-back]')?.addEventListener('click',()=>{
    if(history.length>1)history.back();else location.href='/admin/';
  });
  const esCotizacion=Boolean(params.get('quote')),esFactura=Boolean(params.get('order'));
  const titulo=document.querySelector('[data-receipt-title]');
  if(titulo){titulo.textContent=esCotizacion?'Cotización':esFactura?'Factura':'Comprobante';document.title=`${titulo.textContent} · FullTECH`;}
  if(!root.dataset.pdf){
    const path=params.get('pdf')||'';
    if(!/^\/api\/admin\/(?:pos\/(?:local|quotes)\/[a-zA-Z0-9_-]+\/pdf|orders\/[a-zA-Z0-9_-]+\/(?:receipt\.pdf|receipt-pdf|factura))$/.test(path)){status.textContent='El comprobante no es válido.';return;}
    root.dataset.pdf=path;root.dataset.filename='FullTECH-'+path.split('/').at(-2)+'.pdf';
  }
  /*
   * NOMBRE DEL ARCHIVO = DOCUMENTO + NÚMERO + CLIENTE (el que se hizo).
   * Los datos salen del CRM, no del panel: el nombre no se inventa. El enlace
   * lleva `download`, así que el archivo se guarda al toque, sin preguntar.
   */
  const limpiar=(valor)=>String(valor??'').normalize('NFC').replace(/[\\/:*?"<>|\n\r\t]+/g,' ').replace(/\s+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,60);
  async function nombreDelDocumento(){
    const partes=[];
    try{
      if(params.get('order')){
        const data=await fetch(`/api/admin/orders/${encodeURIComponent(params.get('order'))}`,{credentials:'same-origin'}).then((r)=>(r.ok?r.json():null));
        partes.push('Factura',data?.receipt?.order_number,data?.receipt?.customer_name);
      }else if(params.get('quote')){
        const data=await fetch('/api/admin/pos/quotes',{credentials:'same-origin'}).then((r)=>(r.ok?r.json():null));
        const doc=(data?.quotes??[]).find((row)=>row.id===params.get('quote'));
        partes.push('Cotización',doc?.number,doc?.customer?.name??doc?.draft?.customer?.name);
      }
    }catch(error){/* sin red se usa el nombre guardado */}
    return partes.filter(Boolean).map(limpiar).filter(Boolean).join('-')||'';
  }
  let objectUrl,task,pdfDoc;
  /* El PDF se dibuja al ancho REAL disponible: al girar el teléfono o cambiar
   * el tamaño de la ventana se vuelve a pintar (zoom adaptable, sin perder nitidez). */
  const pintar=async()=>{
    if(!pdfDoc)return;
    const width=Math.max(240,root.clientWidth||window.innerWidth-24);
    const ratio=Math.min(window.devicePixelRatio||1,2);
    for(let number=1;number<=pdfDoc.numPages;number++){
      const page=await pdfDoc.getPage(number),base=page.getViewport({scale:1});
      const viewport=page.getViewport({scale:(width/base.width)*ratio});
      const previo=root.children[number-1];
      const canvas=previo instanceof HTMLCanvasElement?previo:document.createElement('canvas');
      canvas.setAttribute('aria-label',`Página ${number} de ${pdfDoc.numPages}`);canvas.setAttribute('role','img');
      canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
      canvas.style.width='100%';canvas.style.height='auto';
      if(!previo)root.append(canvas);
      await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;page.cleanup();
    }
    status.textContent=`${pdfDoc.numPages} página${pdfDoc.numPages===1?'':'s'}`;
  };
  try{
    const response=await fetch(root.dataset.pdf,{credentials:'same-origin'});
    if(!response.ok)throw new Error('No se pudo abrir el PDF guardado.');
    const bytes=new Uint8Array(await response.arrayBuffer());
    objectUrl=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
    // A nombre del cliente, y guardado directo: `download` no abre diálogo.
    const nombre=await nombreDelDocumento();
    if(nombre)root.dataset.filename=nombre+'.pdf';
    for(const link of document.querySelectorAll('[data-receipt-download]')){link.href=objectUrl;link.download=root.dataset.filename;link.hidden=false;}
    const pdfjs=await import('/admin/vendor/pdfjs/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc='/admin/vendor/pdfjs/pdf.worker.mjs';
    task=pdfjs.getDocument({data:bytes,useSystemFonts:false,standardFontDataUrl:'/admin/vendor/pdfjs/standard_fonts/',isEvalSupported:false,useWasm:false});
    pdfDoc=await task.promise;
    await pintar();
    document.querySelector('[data-receipt-fallback]')?.setAttribute('hidden','');
    let pending;
    window.addEventListener('resize',()=>{clearTimeout(pending);pending=setTimeout(()=>pintar().catch(()=>{}),180);});
  }catch(error){status.textContent='No se pudo mostrar el PDF. Usa Descargar PDF.';}
  document.querySelector('[data-receipt-print]')?.addEventListener('click',()=>window.print());
  window.addEventListener('pagehide',()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);task?.destroy();},{once:true});

  /* ------------------------------------------------------------------------
   * ENVIAR AL CLIENTE (cotizaciones y facturas): API oficial con plantilla.
   * El botón solo aparece cuando el visor viene de un documento del CRM
   * (`?quote=` o `?order=`): a quién y qué PDF se envía lo decide el servidor.
   * Nunca se abre el WhatsApp personal ni la hoja de compartir del sistema.
   * --------------------------------------------------------------------- */
  const sendButton=document.querySelector('[data-receipt-send]');
  const sendStatus=document.querySelector('[data-receipt-message]');
  const quoteId=params.get('quote'),orderId=params.get('order');
  const target=quoteId
    ?{doc:'cotización',endpoint:`/api/admin/pos/quotes/${encodeURIComponent(quoteId)}/send-whatsapp`}
    :orderId
      ?{doc:'factura',endpoint:`/api/admin/orders/${encodeURIComponent(orderId)}/invoice-whatsapp`}
      :null;
  if(sendButton&&target){
    // UNA apertura del visor = UNA operación: si se reintenta desde aquí, va la
    // MISMA clave y el servidor no manda el documento dos veces al cliente.
    const idempotencyKey=crypto.randomUUID();
    // El texto vive en su <span>: así el icono no se pierde al cambiar la etiqueta.
    const etiqueta=sendButton.querySelector('span')??sendButton;
    sendButton.hidden=false;
    sendButton.addEventListener('click',async()=>{
      if(sendButton.disabled)return;
      if(!window.confirm(`¿Enviar esta ${target.doc} al cliente por WhatsApp? Sale por el número del negocio y queda escrita en el CRM.`))return;
      const label=etiqueta.textContent;
      sendButton.disabled=true;etiqueta.textContent='Enviando…';
      if(sendStatus){sendStatus.textContent=`Enviando la ${target.doc} por WhatsApp…`;sendStatus.classList.remove('is-error');}
      try{
        const response=await fetch(target.endpoint,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify({idempotencyKey})});
        const data=await response.json().catch(()=>({}));
        if(!response.ok||!data.ok)throw new Error(data.message||`No se pudo enviar la ${target.doc}.`);
        const quien=data.customer?.name||'el cliente';
        if(sendStatus)sendStatus.textContent=data.duplicate?`Ya se había enviado a ${quien}: no se duplicó.`:`Enviado a ${quien} por WhatsApp.`;
        etiqueta.textContent='Enviado';
      }catch(error){
        if(sendStatus){sendStatus.textContent=error.message;sendStatus.classList.add('is-error');}
        sendButton.disabled=false;etiqueta.textContent=label;
      }
    });
  }
})();
