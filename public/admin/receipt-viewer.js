/* Visor local: dibuja el PDF real, también en Chrome móvil sin visor nativo. */
(async()=>{
  const root=document.querySelector('[data-receipt-pages]');if(!root)return;
  const status=document.querySelector('[data-receipt-status]');
  if(!root.dataset.pdf){
    const path=new URLSearchParams(location.search).get('pdf')||'';
    if(!/^\/api\/admin\/(?:pos\/(?:local|quotes)\/[a-zA-Z0-9_-]+\/pdf|orders\/[a-zA-Z0-9_-]+\/(?:receipt\.pdf|receipt-pdf|factura))$/.test(path)){status.textContent='El comprobante no es válido.';return;}
    root.dataset.pdf=path;root.dataset.filename='FullTECH-'+path.split('/').at(-2)+'.pdf';
  }
  let objectUrl,task;
  try{
    const response=await fetch(root.dataset.pdf,{credentials:'same-origin'});
    if(!response.ok)throw new Error('No se pudo abrir el PDF guardado.');
    const bytes=new Uint8Array(await response.arrayBuffer());
    objectUrl=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
    for(const link of document.querySelectorAll('[data-receipt-download]')){link.href=objectUrl;link.download=root.dataset.filename;link.hidden=false;}
    const pdfjs=await import('/admin/vendor/pdfjs/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc='/admin/vendor/pdfjs/pdf.worker.mjs';
    task=pdfjs.getDocument({data:bytes,useSystemFonts:false,standardFontDataUrl:'/admin/vendor/pdfjs/standard_fonts/',isEvalSupported:false,useWasm:false});
    const pdf=await task.promise;
    for(let number=1;number<=pdf.numPages;number++){
      const page=await pdf.getPage(number),base=page.getViewport({scale:1});
      const width=Math.max(240,Math.min(900,root.clientWidth||window.innerWidth-24)),scale=width/base.width;
      const ratio=Math.min(window.devicePixelRatio||1,2),viewport=page.getViewport({scale:scale*ratio});
      const canvas=document.createElement('canvas');canvas.setAttribute('aria-label',`Página ${number} de ${pdf.numPages}`);canvas.setAttribute('role','img');
      canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);canvas.style.width='100%';canvas.style.height='auto';root.append(canvas);
      await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;page.cleanup();
    }
    document.querySelector('[data-receipt-fallback]')?.setAttribute('hidden','');
    status.textContent=`${pdf.numPages} página${pdf.numPages===1?'':'s'} · PDF guardado en este dispositivo`;
  }catch(error){status.textContent='La vista PDF no pudo cargarse. Puedes descargar el archivo o consultar el comprobante debajo.';}
  document.querySelector('[data-receipt-print]')?.addEventListener('click',()=>window.print());
  document.querySelector('[data-receipt-share]')?.addEventListener('click',async()=>{
    if(!objectUrl)return;
    try{
      const file=new File([await(await fetch(objectUrl)).blob()],root.dataset.filename,{type:'application/pdf'});
      if(navigator.canShare?.({files:[file]}))await navigator.share({files:[file],title:file.name});
      else document.querySelector('[data-receipt-download]')?.click();
    }catch(error){if(error.name!=='AbortError')status.textContent='No se pudo compartir. Usa Descargar PDF.';}
  });
  window.addEventListener('pagehide',()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);task?.destroy();},{once:true});
})();
