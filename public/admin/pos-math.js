/* Dinero en centavos. Compartido entre la vista y el servidor. */
export function manualProducts(lines){
  return lines.filter(i=>i.manual).map(i=>{
    const m=i.manual;
    if(!/^manual_[a-zA-Z0-9_-]{16,80}$/.test(i.variantId)||!String(m.name||'').trim()||String(m.name).length>150)throw new Error('Indica el nombre de la venta fuera de inventario.');
    const price_cents=Math.round(Number(m.price)*100),cost_cents=m.cost===undefined?undefined:Math.round(Number(m.cost)*100);
    if(!Number.isSafeInteger(price_cents)||price_cents<0||price_cents>10000000000||cost_cents!==undefined&&(!Number.isSafeInteger(cost_cents)||cost_cents<0||cost_cents>10000000000))throw new Error('Precio o costo no válido.');
    return {id:i.variantId,name:String(m.name).trim(),price_cents,...(cost_cents!==undefined?{cost_cents}:{}),active:true,kind:m.kind==='service'?'service':'product',manual:true,track_stock:false};
  });
}
export function discountCents(base, discount = {}) {
  const value = Number(discount?.value || 0);
  if (!Number.isFinite(value) || value < 0) throw new Error('El descuento debe ser positivo.');
  if (discount?.type === 'percent' && value > 100) throw new Error('El porcentaje no puede superar 100.');
  const cents = discount?.type === 'percent' ? Math.round(base * value / 100) : Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || cents > base) throw new Error('El descuento supera el importe.');
  return cents;
}
export function calculateSale(lines, products, discount = {}, deliveryFee = 0) {
  const map = new Map([...products,...manualProducts(lines)].map(p => [p.id, p]));
  const items = lines.map(line => {
    const p = map.get(line.variantId), quantity = Number(line.quantity);
    if (!p || !p.active) throw new Error('Un artículo ya no está disponible.');
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 9999) throw new Error('La cantidad debe estar entre 1 y 9999.');
    const gross = p.price_cents * quantity;
    if (!Number.isSafeInteger(gross) || gross > 100000000000) throw new Error('El importe es demasiado alto.');
    const reduction = discountCents(gross, line.discount);
    return {variantId:p.id, name:p.name, quantity, unit_price_cents:p.price_cents, gross_cents:gross,
      discount:line.discount || {}, discount_cents:reduction, subtotal_cents:gross-reduction,
      ...(Number.isSafeInteger(p.cost_cents) ? {cost_cents:p.cost_cents * quantity} : {})};
  });
  const subtotal_cents = items.reduce((n,i)=>n+i.subtotal_cents,0);
  const discount_cents = discountCents(subtotal_cents, discount);
  const delivery_cents = Math.round(Number(deliveryFee || 0)*100);
  if (!Number.isSafeInteger(delivery_cents) || delivery_cents < 0 || delivery_cents > 100000000) throw new Error('El envío no es válido.');
  const total_cents = subtotal_cents-discount_cents+delivery_cents;
  return {items, subtotal_cents, discount_cents, delivery_cents,total_cents,
    ...(items.every(i=>i.cost_cents!==undefined) ? {profit_cents:subtotal_cents-discount_cents-items.reduce((n,i)=>n+i.cost_cents,0)} : {})};
}
