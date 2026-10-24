import {parseCoordinates} from './locations.mjs';

export const smartError=(code,message,status=422)=>Object.assign(new Error(message),{code,status});
export const DEFAULT_DELIVERY_POLICY=Object.freeze({minimumFeeDop:100,firstMeters:1000,firstFeeDop:100,incrementMeters:500,incrementFeeDop:50,maxMeters:15000,active:true});
export function deliveryPriceMeters(meters,policy=DEFAULT_DELIVERY_POLICY){
  if(!Number.isSafeInteger(meters)||meters<=0)throw smartError('invalid_route_distance','La distancia vial debe ser un entero positivo en metros.');
  const p={...DEFAULT_DELIVERY_POLICY,...policy};
  for(const key of ['minimumFeeDop','firstMeters','firstFeeDop','incrementMeters','incrementFeeDop','maxMeters'])if(!Number.isSafeInteger(p[key])||p[key]<=0)throw smartError('invalid_delivery_policy','La tarifa debe usar valores enteros positivos.');
  const maximum=Math.max(p.minimumFeeDop,p.firstFeeDop+Math.ceil(Math.max(0,p.maxMeters-p.firstMeters)/p.incrementMeters)*p.incrementFeeDop);
  if(!Number.isSafeInteger(maximum*100))throw smartError('invalid_delivery_policy','La tarifa excede el rango monetario permitido.');
  if(!p.active||meters>p.maxMeters)return {eligible:false,reason:!p.active?'policy_inactive':'route_too_long',feeDop:null};
  return {eligible:true,feeDop:Math.max(p.minimumFeeDop,p.firstFeeDop+Math.ceil(Math.max(0,meters-p.firstMeters)/p.incrementMeters)*p.incrementFeeDop),routeMeters:meters};
}
export function coordinates(input){
  const parsed=parseCoordinates(input);if(!parsed.ok)throw smartError('invalid_coordinates',parsed.message);
  if(input.accuracy!==undefined&&(typeof input.accuracy!=='number'||!Number.isFinite(input.accuracy)||input.accuracy<0))throw smartError('invalid_accuracy','La precisión GPS no es válida.');
  return {latitude:parsed.latitude,longitude:parsed.longitude,...(input.accuracy!==undefined?{accuracy:input.accuracy}:{})};
}
export function insidePolygon(point,ring){
  const x=point.longitude,y=point.latitude;let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const [ax,ay]=ring[j],[bx,by]=ring[i],cross=(x-ax)*(by-ay)-(y-ay)*(bx-ax);
    if(Math.abs(cross)<1e-10&&x>=Math.min(ax,bx)&&x<=Math.max(ax,bx)&&y>=Math.min(ay,by)&&y<=Math.max(ay,by))return true;
    if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)inside=!inside;
  }return inside;
}
export function normalizedItems(input){
  if(!Array.isArray(input)||!input.length||input.length>30)throw smartError('invalid_cart','El carrito debe tener entre 1 y 30 líneas.');
  const map=new Map();for(const line of input){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(line?.id||'')||!Number.isSafeInteger(line.quantity)||line.quantity<1||line.quantity>99)throw smartError('invalid_cart','Hay una cantidad o un producto no válido.');map.set(line.id,(map.get(line.id)||0)+line.quantity);if(map.get(line.id)>99)throw smartError('invalid_quantity','Máximo 99 unidades por producto.');}
  return [...map].map(([id,quantity])=>({id,quantity})).sort((a,b)=>a.id.localeCompare(b.id));
}
export function regionalPrice(baseCents,rule,now){
  if(!rule)return baseCents;
  if(!Number.isSafeInteger(rule.priceCents)||rule.priceCents<=0)throw smartError('invalid_regional_price','El precio regional debe estar en centavos enteros.');
  const from=rule.from?Date.parse(rule.from):-Infinity,to=rule.until?Date.parse(rule.until):Infinity;
  if(Number.isNaN(from)||Number.isNaN(to)||from>=to)throw smartError('invalid_price_dates','La vigencia regional no es válida.');
  if(now<from||now>=to)return baseCents;
  return rule.priceCents;
}
export function inOperatingHours(zone,now){
  if(!Array.isArray(zone.hours)||!zone.hours.length)return false;
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Santo_Domingo',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)),get=k=>parts.find(x=>x.type===k)?.value;
  const day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(get('weekday')),time=Number(get('hour'))*60+Number(get('minute'));
  return zone.hours.some(h=>h.day===day&&time>=h.startMinute&&time<h.endMinute);
}
