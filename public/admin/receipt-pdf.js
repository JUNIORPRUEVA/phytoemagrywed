// Generador compartido: PDF vectorial, sin red y sin datos internos de costos.
function money(value, currency = 'DOP') {
  const number = Number(value) || 0;
  const formatted = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(number);
  return `${currency === 'DOP' ? 'RD$' : currency} ${formatted}`;
}

/** Fecha legible en la zona del negocio. */
function prettyDate(value, timeZone = 'America/Santo_Domingo') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('es-DO', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date);
}

function pdfText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, (char) => {
      if (char === '×') return 'x';
      if (char === '−' || char === '–' || char === '—') return '-';
      if (char === '•') return '.';
      return '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function pdfEsc(value) {
  return pdfText(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function pdfLine(text, x, y, size = 11, font = 'F1') {
  return `BT /${font} ${size} Tf ${x} ${y} Td (${pdfEsc(text)}) Tj ET\n`;
}

function pdfRule(y) {
  return `0.78 0.84 0.8 RG 50 ${y} m 545 ${y} l S\n`;
}

/**
 * PDF sencillo de la factura para compartir desde el móvil.
 * Se mantiene sin dependencias: el PDF contiene texto vectorial y abre en
 * cualquier visor del navegador.
 *
 * @param {ReturnType<typeof buildReceipt>} receipt
 * @param {{ timeZone?: string }} [options]
 */
export function receiptPdfBytes(receipt, options = {}) {
  let lines = [];
  const pages=[];
  let y = 790;
  const nextPage=()=>{pages.push(lines.join(''));lines=[];y=790;lines.push(pdfLine(`${receipt.business} · ${receipt.order_number}`,50,y,12,'F2'));y-=30;};
  lines.push('0.043 0.42 0.31 rg\n');
  lines.push(pdfLine(receipt.business, 50, y, 22, 'F2'));
  y -= 24;
  lines.push('0.38 0.45 0.42 rg\n');
  lines.push(pdfLine(receipt.document, 50, y, 10, 'F2'));
  y -= 24;
  lines.push(pdfRule(y));
  y -= 22;

  const facts = [
    ['Pedido', receipt.order_number],
    ['Fecha', prettyDate(receipt.date, options.timeZone)],
    receipt.customer_name ? ['Cliente', receipt.customer_name] : null,
    receipt.phone_masked ? ['Telefono', receipt.phone_masked] : null,
    receipt.payment_method_label ? ['Pago', receipt.payment_method_label] : null,
    ['Estado', receipt.status_label],
  ].filter(Boolean);

  for (const [label, value] of facts) {
    lines.push('0.38 0.45 0.42 rg\n');
    lines.push(pdfLine(label, 50, y, 10, 'F1'));
    lines.push('0.09 0.13 0.11 rg\n');
    lines.push(pdfLine(value, 170, y, 10, 'F2'));
    y -= 16;
  }

  y -= 8;
  lines.push(pdfRule(y));
  y -= 20;
  lines.push('0.38 0.45 0.42 rg\n');
  lines.push(pdfLine('Detalle', 50, y, 9, 'F2'));
  lines.push(pdfLine('Cant.', 320, y, 9, 'F2'));
  lines.push(pdfLine('Precio', 380, y, 9, 'F2'));
  lines.push(pdfLine('Importe', 470, y, 9, 'F2'));
  y -= 14;
  lines.push(pdfRule(y));
  y -= 18;

  for (const item of receipt.items ?? []) {
    const words=String(item.label||'').split(/\s+/),wrapped=[''];
    for(const word of words){const last=wrapped.length-1;if(wrapped[last].length+word.length>46&&wrapped[last])wrapped.push(word);else wrapped[last]+=(wrapped[last]?' ':'')+word;}
    const height=Math.max(18,wrapped.length*12)+(item.line_discount?14:0);
    if(y-height<180)nextPage();
    lines.push('0.09 0.13 0.11 rg\n');
    wrapped.forEach((label,index)=>lines.push(pdfLine(label,50,y-index*12,10,'F1')));
    lines.push(pdfLine(item.quantity, 330, y, 10, 'F1'));
    lines.push(pdfLine(money(item.unitPrice, receipt.currency), 380, y, 10, 'F1'));
    lines.push(pdfLine(money(item.subtotal, receipt.currency), 470, y, 10, 'F2'));
    y -= Math.max(18,wrapped.length*12);
    if(item.line_discount){lines.push(pdfLine(`Descuento: -${money(item.line_discount, receipt.currency)}`,50,y,8,'F1'));y-=14;}
  }

  if(y<220)nextPage();
  y -= 8;
  lines.push(pdfRule(y));
  y -= 20;
  const totals = [
    ['Productos', money(receipt.subtotal, receipt.currency)],
    receipt.discount ? ['Descuento', `-${money(receipt.discount, receipt.currency)}`] : null,
    receipt.delivery_fee ? ['Delivery', money(receipt.delivery_fee, receipt.currency)] : null,
    receipt.shipping ? ['Envio', money(receipt.shipping, receipt.currency)] : null,
  ].filter(Boolean);
  for (const [label, value] of totals) {
    lines.push('0.38 0.45 0.42 rg\n');
    lines.push(pdfLine(label, 330, y, 10, 'F1'));
    lines.push('0.09 0.13 0.11 rg\n');
    lines.push(pdfLine(value, 455, y, 10, 'F2'));
    y -= 16;
  }
  y -= 4;
  lines.push('0.043 0.42 0.31 rg\n');
  lines.push(pdfLine('TOTAL', 330, y, 15, 'F2'));
  lines.push(pdfLine(money(receipt.total, receipt.currency), 455, y, 15, 'F2'));

  y -= 34;
  if (receipt.has_location) {
    lines.push('0.38 0.45 0.42 rg\n');
    lines.push(pdfLine(`Ubicacion de entrega registrada${receipt.location_label ? `: ${receipt.location_label}` : ''}.`, 50, y, 9, 'F1'));
    y -= 14;
  }
  lines.push(pdfLine(receipt.thanks, 50, y, 9, 'F1'));
  y -= 14;
  lines.push(pdfLine(receipt.note, 50, y, 9, 'F1'));

  pages.push(lines.join(''));
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_,i)=>`${5+i*2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  pages.forEach((stream,index)=>objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6+index*2} 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`));

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(pdf, char => char.charCodeAt(0));
}
