// @vitest-environment node
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {it,expect} from 'vitest';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createCanvas} from '@napi-rs/canvas';
import {receiptPdfBytes} from '../public/admin/receipt-pdf.js';
import {receiptPdf} from '../server/orders.mjs';
const receipt={business:'FullTECH, SRL',document:'Factura de compra',order_number:'LOCAL-PRUEBA',date:'2026-10-17T12:00:00Z',customer_name:'Cliente de prueba',status_label:'Pendiente de sincronizar',currency:'DOP',items:Array.from({length:100},(_,i)=>({label:'Producto '+(i+1),quantity:1,unitPrice:100,subtotal:100,cost_cents:12345})),subtotal:10000,discount:100,delivery_fee:50,total:9950,thanks:'Gracias por su compra.',note:'Documento provisional. No es comprobante fiscal.'};
const fonts=process.cwd()+'/node_modules/pdfjs-dist/standard_fonts/';
it('reproduce los campos y la distribución A4 de la referencia sin cambiar importes',async()=>{
 const fixture={...receipt,document:'Cotización',order_number:'COT-EE1199A3',date:'2026-10-15T04:58:00Z',customer_name:'ANTONIO',customer_phone:'8096647787',items:[{label:'CÁMARA BULLET HILOOK DUAL LIGHT COLORVU',quantity:4,unitPrice:1600,subtotal:6400},{label:'CABLE UTP CAT5 EXTERIOR PIES',quantity:200,unitPrice:6,subtotal:1200},{label:'video balum',quantity:4,unitPrice:150,subtotal:600},{label:'CONECTOR MACHO CCTV',quantity:4,unitPrice:25,subtotal:100},{label:'Disco duro 500 gb',quantity:1,unitPrice:2000,subtotal:2000},{label:'servicio',quantity:1,unitPrice:4500,subtotal:4500},{label:'CAJA DE REGISTRO 80X50',quantity:4,unitPrice:110,subtotal:440},{label:'CAJA DE REGISTRO 225X200',quantity:1,unitPrice:500,subtotal:500}],subtotal:15740,discount:240,delivery_fee:0,total:15500,status_label:'Cotización',note:''};
 const task=getDocument({data:receiptPdfBytes(fixture),useSystemFonts:false,standardFontDataUrl:fonts}),pdf=await task.promise;
 expect(pdf.numPages).toBe(1);const page=await pdf.getPage(1),items=(await page.getTextContent()).items,plain=items.map(i=>i.str).join(' ');
 for(const label of ['FULLTECH, SRL','RNC: 133080206','Tel: 8295319442','COTIZACIÓN','30/10/2026','ANTONIO','ITBIS','RD$6,302.41','RD$1,181.70','RD$15,500.00','Gracias por preferirnos.','Página 1 de 1'])expect(plain).toContain(label);
 const heading=items.find(i=>i.str==='FULLTECH, SRL');expect(heading.transform[4]).toBe(98);expect(heading.height).toBe(17);
 expect(page.view[2]).toBeCloseTo(595.27559,3);expect(page.view[3]).toBeCloseTo(841.88976,3);await task.destroy();
});
it('el mismo PDF vectorial del servidor funciona en el navegador, con varias páginas y sin costos internos',async()=>{
  const bytes=receiptPdfBytes(receipt);expect(Buffer.from(bytes).equals(receiptPdf(receipt))).toBe(true);
  const task=getDocument({data:bytes,useSystemFonts:false,standardFontDataUrl:fonts});
  const pdf=await task.promise;expect(pdf.numPages).toBeGreaterThan(1);let text='';
  for(let i=1;i<=pdf.numPages;i++)text+=(await(await pdf.getPage(i)).getTextContent()).items.map(i=>i.str).join(' ');
  expect(text).toContain('Producto 100');expect(text).toContain('RD$9,950.00');expect(text).not.toContain('12345');await task.destroy();
});
it('el visor dibuja todas las páginas del PDF guardado y ofrece su descarga sin un visor externo',async()=>{
  const dom=new JSDOM(readFileSync('public/admin/receipt-viewer.html','utf8'),{url:'https://crm.test/admin/receipt-viewer.html?pdf=%2Fapi%2Fadmin%2Fpos%2Flocal%2Flocal_test%2Fpdf',runScripts:'outside-only'}),w=dom.window;
  const calls=[];w.fetch=async url=>{calls.push(url);return new Response(receiptPdfBytes(receipt),{headers:{'content-type':'application/pdf'}});};
  Object.assign(w,{Blob,File,Uint8Array});w.URL.createObjectURL=()=> 'blob:test-pdf';w.URL.revokeObjectURL=()=>{};
  w.HTMLCanvasElement.prototype.getContext=function(){const canvas=createCanvas(this.width,this.height);return canvas.getContext('2d');};
  w.pdfjsTest={GlobalWorkerOptions:{},getDocument:options=>getDocument({...options,standardFontDataUrl:fonts})};
  w.eval(readFileSync('public/admin/receipt-viewer.js','utf8').replace("await import('/admin/vendor/pdfjs/pdf.mjs')",'window.pdfjsTest'));
  for(let i=0;i<300&&!/^\d+ página/.test(w.document.querySelector('[data-receipt-status]').textContent);i++)await new Promise(r=>setTimeout(r,10));
  expect(w.document.querySelector('[data-receipt-status]').textContent).toMatch(/^\d+ página/);
  expect(w.document.querySelectorAll('canvas').length).toBeGreaterThan(1);expect(calls).toEqual(['/api/admin/pos/local/local_test/pdf']);
  expect(w.document.querySelector('[data-receipt-download]').href).toBe('blob:test-pdf');
  w.dispatchEvent(new w.Event('pagehide'));w.close();
});
it('los enlaces de comprobante permanecen dentro del alcance offline de la PWA',()=>{
  const dom=new JSDOM('<a target="_blank" href="/api/admin/orders/local_test/receipt">PDF</a>',{url:'https://crm.test/admin/',runScripts:'outside-only'}),w=dom.window;
  w.eval(readFileSync('public/admin/receipt-launcher.js','utf8'));
  w.document.addEventListener('click',e=>e.preventDefault());w.document.querySelector('a').click();
  expect(w.document.querySelector('a').pathname).toBe('/admin/receipt-viewer.html');
  expect(new URL(w.document.querySelector('a').href).searchParams.get('pdf')).toBe('/api/admin/orders/local_test/receipt.pdf');w.close();
});
it('la factura mantiene visibles los estados cancelado y pendiente dentro de la nueva plantilla',async()=>{
 for(const [status,notice] of [['cancelado','FACTURA CANCELADA'],['nuevo','Pedido pendiente. No acredita pago.']]){
  const task=getDocument({data:receiptPdfBytes({...receipt,status,items:receipt.items.slice(0,1)}),useSystemFonts:false,standardFontDataUrl:fonts}),pdf=await task.promise;
  const text=(await(await pdf.getPage(1)).getTextContent()).items.map(i=>i.str).join(' ');expect(text).toContain('FACTURA');expect(text).toContain(notice);await task.destroy();
 }
});
