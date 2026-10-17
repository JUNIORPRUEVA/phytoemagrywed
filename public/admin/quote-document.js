/* Acciones del documento comercial: compartir el archivo, sin enlaces privados al cliente. */
(() => {
  const button=document.querySelector('[data-share-quote]'),status=document.querySelector('#quote-share-status');
  button?.addEventListener('click',async()=>{
    button.disabled=true;
    try{
      const response=await fetch(button.dataset.pdf,{credentials:'same-origin',cache:'no-store'});
      if(!response.ok)throw new Error('No se pudo obtener el PDF. Vuelve a entrar al CRM.');
      const file=new File([await response.blob()],button.dataset.filename,{type:'application/pdf'});
      if(navigator.canShare?.({files:[file]}))await navigator.share({files:[file],title:button.dataset.filename});
      else{
        const url=URL.createObjectURL(file),link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
        status.textContent='PDF descargado. Puedes adjuntarlo al chat del cliente con el botón WhatsApp.';
      }
    }catch(e){if(e.name!=='AbortError')status.textContent=e.message;}finally{button.disabled=false;}
  });
})();
