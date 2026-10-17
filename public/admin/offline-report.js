// Filtra hechos de venta descargados; nunca consulta precios/costos actuales para ventas históricas.
export function offlineReport(sales,period='hoy',query={},now=new Date(),timeZone='America/Santo_Domingo'){
  const day=value=>new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
  const today=day(now),date=new Date(today+'T12:00:00Z');let from=today,to=today;
  if(period==='ayer'){date.setUTCDate(date.getUTCDate()-1);from=to=day(date);}
  if(period==='7d'||period==='30d'){date.setUTCDate(date.getUTCDate()-(period==='7d'?6:29));from=day(date);}
  if(period==='mes')from=today.slice(0,7)+'-01';
  if(period==='custom'){from=query.from||today;to=query.to||from;if(from>to)[from,to]=[to,from];}
  sales=sales.filter(s=>day(s.date)>=from&&day(s.date)<=to);
  const summary={product_revenue_cents:0,delivery_revenue_cents:0,total_collected_cents:0,product_cost_cents:0,gross_product_profit_cents:0,capsules_sold:0,orders:0},groups=new Map();
  for(const sale of sales){
    for(const field of ['product_revenue_cents','delivery_revenue_cents','total_collected_cents','product_cost_cents','gross_product_profit_cents'])summary[field]+=Number(sale[field]||0);
    summary.capsules_sold+=Number(sale.capsules||0);summary.orders++;
    for(const line of sale.lines||[]){
      const id=line.variantId||line.variantName||'legacy';
      const group=groups.get(id)||{variant_id:id,presentation:line.variantName||line.label||id,units:0,capsules:0,product_revenue_cents:0,product_cost_cents:0,gross_product_profit_cents:0};
      group.units+=Number(line.quantity||0);group.capsules+=Number(line.totalCapsules||0);
      group.product_revenue_cents+=Number(line.subtotal_snapshot_cents??Math.round(Number(line.subtotal||0)*100));
      group.product_cost_cents+=Number(line.product_cost_snapshot_cents||0);group.gross_product_profit_cents=group.product_revenue_cents-group.product_cost_cents;groups.set(id,group);
    }
  }
  return {period:{name:period,startDay:from,endDay:to},summary,byPresentation:[...groups.values()],sales,pending:sales.some(s=>s.pending)};
}
