import {receiptLogo} from './receipt-brand.js';
// Plantilla Fulltech A4 compartida por el servidor y el modo sin conexión.
const W=595.27559,H=841.88976,M=26,R=W-M;
const C={ink:[.059,.09,.157],muted:[.365,.443,.557],blue:[.063,.333,1],border:[.816,.859,.922],panel:[.969,.976,.984],white:[1,1,1],red:[.85,.04,.02]};
const n=v=>Number(v).toFixed(4).replace(/\.?0+$/,'')||'0';
const rgb=c=>c.map(n).join(' ');
const text=v=>String(v??'').normalize('NFC').replace(/×/g,'x').replace(/[−–—]/g,'-').replace(/•/g,'\x95').replace(/[^\x20-\xff]/g,' ').replace(/\s+/g,' ').trim();
const esc=v=>text(v).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
const widths={i:222,l:222,I:278,j:222,f:278,t:278,r:333,m:833,w:722,M:833,W:944,' ':278,'.':278,',':278,':':278,';':278,'!':278,'(':333,')':333,'/':278,'-':333,'%':889,'$':556};
function width(value,size,bold=false){let sum=0;for(const ch of text(value)){const base=ch.normalize('NFD')[0];sum+=widths[ch]??(/[0-9]/.test(ch)?556:/[A-Z]/.test(base)?({A:667,B:667,C:722,D:722,E:667,F:611,G:778,H:722,J:500,K:667,L:556,N:722,O:778,P:667,Q:778,R:722,S:667,T:611,U:722,V:667,X:667,Y:667,Z:611}[base]||667):556);}return sum*size/1000;}
function wrap(value,max,size,bold=false){const lines=[''];for(const word of text(value).split(' ')){let rest=word;while(width(rest,size,bold)>max){let cut=1;while(cut<rest.length&&width(rest.slice(0,cut+1),size,bold)<=max)cut++;if(lines.at(-1))lines.push('');lines[lines.length-1]=rest.slice(0,cut);lines.push('');rest=rest.slice(cut);}if(width((lines.at(-1)?lines.at(-1)+' ':'')+rest,size,bold)>max)lines.push(rest);else lines[lines.length-1]+=(lines.at(-1)?' ':'')+rest;}return lines.filter(Boolean);}
function money(value,currency='DOP'){return (currency==='DOP'?'RD$':currency)+new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value)||0);}
function date(value,tz){if(!value)return '';const d=new Date(value);return Number.isNaN(d.getTime())?String(value):new Intl.DateTimeFormat('es-DO',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true,timeZone:tz}).format(d).replace(',','');}
function discountedLines(items,discount){const base=items.map(i=>Math.round(Number(i.subtotal||0)*100)),sum=base.reduce((a,b)=>a+b,0),reduction=Math.min(sum,Math.max(0,Math.round(Number(discount||0)*100)));if(!sum)return base;const cuts=base.map(v=>Math.floor(v*reduction/sum));let left=reduction-cuts.reduce((a,b)=>a+b,0);for(const {i} of base.map((v,i)=>({i,f:v*reduction/sum-cuts[i]})).sort((a,b)=>b.f-a.f||a.i-b.i)){if(!left)break;cuts[i]++;left--;}return base.map((v,i)=>(v-cuts[i])/100);}
export function receiptPdfBytes(receipt,options={}){
 const pages=[];let lines=[],y=0,rowsOnPage=0;
 const tz=options.timeZone||'America/Santo_Domingo',quote=/cotiz/i.test(receipt.document||''),currency=receipt.currency||'DOP';
 const write=(value,x,baseline,size=8,font='F1',color=C.ink,align='left')=>{const shift=align==='right'?width(value,size,font==='F2'):align==='center'?width(value,size,font==='F2')/2:0;lines.push(`${rgb(color)} rg BT /${font} ${n(size)} Tf ${n(x-shift)} ${n(baseline)} Td (${esc(value)}) Tj ET\n`);};
 const rule=(x1,y1,x2,y2,color=C.border)=>lines.push(`${rgb(color)} RG 0.6 w ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S\n`);
 const box=(x,bottom,w,h,fill=C.panel,radius=5,stroke=C.border)=>{const k=.55228475,r=Math.min(radius,w/2,h/2),top=bottom+h,right=x+w;lines.push(`${rgb(fill)} rg ${rgb(stroke)} RG .6 w ${n(x+r)} ${n(bottom)} m ${n(right-r)} ${n(bottom)} l ${n(right-r+k*r)} ${n(bottom)} ${n(right)} ${n(bottom+r-k*r)} ${n(right)} ${n(bottom+r)} c ${n(right)} ${n(top-r)} l ${n(right)} ${n(top-r+k*r)} ${n(right-r+k*r)} ${n(top)} ${n(right-r)} ${n(top)} c ${n(x+r)} ${n(top)} l ${n(x+r-k*r)} ${n(top)} ${n(x)} ${n(top-r+k*r)} ${n(x)} ${n(top-r)} c ${n(x)} ${n(bottom+r)} l ${n(x)} ${n(bottom+r-k*r)} ${n(x+r-k*r)} ${n(bottom)} ${n(x+r)} ${n(bottom)} c h B\n`);};
 const rect=(x,bottom,w,h,fill)=>lines.push(`${rgb(fill)} rg ${n(x)} ${n(bottom)} ${n(w)} ${n(h)} re f\n`);
 const header=()=>{
  box(26,H-86,60,60);lines.push(`q 52 0 0 52 30 ${n(H-82)} cm /Logo Do Q\n`);
  write('FULLTECH, SRL',98,H-42.354,17,'F2');write('RNC: 133080206',98,H-58.0504,8.4,'F1',C.muted);write('Tel: 8295319442',98,H-69.7608,8.4,'F1',C.muted);write('Centro calle beller 9 local n2 higuey la altagracia R.D.',98,H-81.4712,8.4,'F1',C.muted);
  const mx=W-248;box(mx,H-121,222,95);
  write(quote?'COTIZACIÓN':'FACTURA',mx+12,H-43.8884,8.2,'F2',C.blue);
  const number=receipt.order_number||'';let numberSize=12.4;while(width(number,numberSize,true)>198&&numberSize>8)numberSize-=.2;write(number,mx+12,H-61.6868,numberSize,'F2');
  const issued=receipt.date,expiry=receipt.expires_at||(issued&&!Number.isNaN(new Date(issued).getTime())?new Date(new Date(issued).getTime()+15*86400000).toISOString():null);
  const facts=[['Expedición',date(issued,tz)],[quote?'Vencimiento':'Pago',quote?date(expiry,tz):(receipt.payment_method_label||receipt.status_label||'')],['Condición',Number(receipt.itbis||0)?'Con impuesto':'Sin impuesto']];
  facts.forEach(([label,value],i)=>{write(label,mx+12,H-81.4965-i*13.3636,7.5,'F1',C.muted);write(value,mx+74,H-82.0551-i*13.3636,8.1);});
  const client=wrap(receipt.customer_name||'Consumidor final',202,8.2,true),extra=Math.max(0,client.length-1)*11;
  rule(M,H-133,R,H-133);box(M,H-187-extra,W-2*M,45+extra);
  write('DATOS DEL CLIENTE',40,H-160.016,7.6,'F2',C.blue);write('Nombre:',40,H-175.6372,8.2);
  client.forEach((value,i)=>write(value,73.7184,H-175.6372-i*11,8.2,'F2'));
  write('Teléfono: '+(receipt.customer_phone||receipt.phone_masked||''),293,H-175.383,8.2,'F1',C.muted);
  write('Detalle de productos',26,H-220.8964-extra,10.8,'F2');
  y=H-231-extra;rect(M,y-20,W-2*M,20,C.ink);
  write('Descripción',32,y-13.2852,7.2,'F2',C.white);write('Cant.',312.46567,y-13.2852,7.2,'F2',C.white);write('Precio unidad',371.33313,y-13.2852,7.2,'F2',C.white);write('ITBIS',463.17682,y-13.2852,7.2,'F2',C.white);write('Total',546.07479,y-13.2852,7.2,'F2',C.white);y-=20;rowsOnPage=0;
 };
 const next=()=>{if(lines.length)pages.push(lines.join(''));lines=[];header();};
 next();
 const noteText=receipt.notes?.trim()||'Gracias por preferirnos.',noteLines=wrap(noteText,263.27559,9),provisional=/provisional|pendiente de sincronizar/i.test(receipt.note||'')||/pendiente de sincronizar/i.test(receipt.status_label||'');
 const statusNotice=receipt.status==='cancelado'?'FACTURA CANCELADA':!quote&&((receipt.status&&receipt.status!=='entregado')||/pedido pendiente/i.test(receipt.status_label||''))?'Pedido pendiente. No acredita pago.':'';
 const noteHeight=Math.max(56,42+noteLines.length*12+(provisional?22:0)+(statusNotice?14:0));
 const summaryRows=[['Subtotal',Number(receipt.subtotal)||0],['Descuento general',-Number(receipt.discount||0)],['Monto exento',Math.max(0,Number(receipt.subtotal||0)-Number(receipt.discount||0))],...(receipt.delivery_fee?[['Delivery',Number(receipt.delivery_fee)]]:[]),...(receipt.shipping?[['Envío',Number(receipt.shipping)]]:[]),...(receipt.itbis?[['ITBIS',Number(receipt.itbis)]]:[])];
 const summaryHeight=148+(summaryRows.length-3)*16.3224,net=discountedLines(receipt.items||[],receipt.discount);
 for(const [index,item] of (receipt.items||[]).entries()){
  const wrapped=wrap(item.label||'',266,8,true),height=Math.max(23.52,wrapped.length*11+12)+(item.line_discount?11:0);
  const final=index===(receipt.items||[]).length-1,reserve=final?Math.max(summaryHeight,noteHeight)+55:72;
  if(y-height<reserve&&rowsOnPage)next();
  rect(M,y-height,W-2*M,height,index%2?[.984,.988,1]:C.white);
  wrapped.forEach((value,line)=>write(value,34,y-15.6228-line*11,8,'F2'));
  if(item.line_discount)write('Descuento: -'+money(item.line_discount,currency),34,y-15.6228-wrapped.length*11,7,'F1',C.muted);
  write(item.quantity,321.46567,y-15.0024,7.6,'F1',C.ink,'center');write(money(item.unitPrice,currency),418.94673,y-15.0024,7.6,'F1',C.ink,'right');write(money(item.itbis||0,currency),481.58002,y-15.0024,7.6,'F1',C.ink,'right');write(money(net[index],currency),R-6,y-15.238,7.6,'F2',C.ink,'right');
  rule(M,y,M,y-height);rule(R,y,R,y-height);y-=height;rule(M,y,R,y);rowsOnPage++;
 }
 let top=y-15;
 if(top-Math.max(noteHeight,summaryHeight)<45){next();top=y-15;}
 box(M,top-noteHeight,291.27559,noteHeight);write('Notas',40,top-23.0278,10.5,'F2');
 noteLines.forEach((value,i)=>write(value,40,top-40.8008-i*12,9,'F3',C.muted));
 if(provisional)write('Documento provisional. Pendiente de sincronizar.',40,top-noteHeight+12,7,'F1',C.muted);
 if(statusNotice)write(statusNotice,40,top-noteHeight+(provisional?26:12),7.5,'F2',receipt.status==='cancelado'?C.red:C.muted);
 const sx=W-264;box(sx,top-summaryHeight,238,summaryHeight);write('Resumen',sx+14,top-23.3164,10.8,'F2');
 summaryRows.forEach(([label,value],i)=>{write(label,sx+14,top-45.9716-i*16.3224,8.8);write((value<0?'-':'')+money(Math.abs(value),currency),R-14,top-45.9716-i*16.3224,8.8,value<0?'F2':'F1',value<0?C.red:C.ink,'right');});
 const separator=top-92.32-(summaryRows.length-3)*16.3224;rule(sx+14,separator,R-14,separator);
 box(sx+14,separator-42.5,210,34.5,C.white,4,C.white);write('TOTAL',sx+24,separator-29.2,10.4,'F2');write(money(receipt.total,currency),R-24,separator-29.8,12,'F2',C.blue,'right');
 pages.push(lines.join(''));
 const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${pages.map((_,i)=>`${7+i*2} 0 R`).join(' ')}] /Count ${pages.length} >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>',`<< /Type /XObject /Subtype /Image /Width ${receiptLogo.width} /Height ${receiptLogo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /DCTDecode] /Length ${receiptLogo.hex.length+1} >>\nstream\n${receiptLogo.hex}>\nendstream`];
 pages.forEach((stream,index)=>{
  lines=[];write('FullPOS Cloud',26,23.8,8,'F1',C.muted);write(`Página ${index+1} de ${pages.length}`,R,23.8,8,'F1',C.muted,'right');stream+=lines.join('');
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> /XObject << /Logo 6 0 R >> >> /Contents ${8+index*2} 0 R >>`,`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
 });
 let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((object,index)=>{offsets.push(pdf.length);pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;});const xref=pdf.length;pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;for(let i=1;i<offsets.length;i++)pdf+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Uint8Array.from(pdf,c=>c.charCodeAt(0));
}
