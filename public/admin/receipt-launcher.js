// Las nuevas ventanas deben permanecer dentro del alcance /admin/ de la PWA.
document.addEventListener('click',event=>{
  const link=event.target.closest?.('a[href]');if(!link||link.hasAttribute('download'))return;
  const url=new URL(link.href,location.href);if(url.origin!==location.origin)return;
  let path=url.pathname;
  if(/^\/api\/admin\/orders\/[^/]+\/(receipt|receipt\.pdf|receipt-pdf|factura)$/.test(path))path=path.replace(/\/[^/]+$/,'/receipt.pdf');
  else if(/^\/api\/admin\/pos\/(local|quotes)\/[^/]+\/(receipt|pdf)$/.test(path))path=path.replace(/\/receipt$/,'/pdf');
  else return;
  link.href='/admin/receipt-viewer.html?pdf='+encodeURIComponent(path);
},true);
