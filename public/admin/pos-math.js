/* Dinero en centavos. Compartido entre la vista y el servidor. */
export function discountCents(base, discount = {}) {
  const value = Number(discount?.value || 0);
  if (!Number.isFinite(value) || value < 0) throw new Error('El descuento debe ser positivo.');
  if (discount?.type === 'percent' && value > 100) throw new Error('El porcentaje no puede superar 100.');
  const cents = discount?.type === 'percent' ? Math.round(base * value / 100) : Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || cents > base) throw new Error('El descuento supera el importe.');
  return cents;
}
export function calculateSale(lines, products, discount = {}, deliveryFee = 0) {
  const map = new Map(products.map(p => [p.id, p]));
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
