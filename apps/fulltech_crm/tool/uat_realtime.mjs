/**
 * Comprobación REAL del canal en vivo (`GET /api/admin/events`).
 *
 * Abre el flujo, provoca un cambio de verdad (confirmar un pedido) y comprueba
 * que llega el aviso con su `id` y que, al reconectar desde ese `id`, no se
 * repite lo ya visto.
 */
const BASE = process.env.UAT_URL ?? 'http://127.0.0.1:8791';

const login = await fetch(`${BASE}/api/admin/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin@uat.local', password: 'UatLocal-123' }),
});
const cookie = /pe_crm=([^;]*)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
const headers = { cookie: `pe_crm=${cookie}`, 'content-type': 'application/json' };
const data = await fetch(`${BASE}/api/admin/data?light=1`, { headers }).then((r) => r.json());
const clientes = data.customers ?? [];
const cliente = clientes[0];
console.log(`cliente para el cambio: ${cliente?.id} (${cliente?.name})`);

async function escuchar(ms, since = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  let texto = '';
  try {
    const response = await fetch(`${BASE}/api/admin/events?since=${since}`, {
      headers: { cookie: `pe_crm=${cookie}`, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) return { status: response.status, texto };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      texto += decoder.decode(value, { stream: true });
    }
    return { status: response.status, texto };
  } catch {
    return { status: controller.signal.aborted ? 200 : 0, texto };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const recoger = (texto) => ({
  eventos: [...texto.matchAll(/event:\s*(\S+)/g)].map((row) => row[1]),
  ids: [...texto.matchAll(/^id:\s*(\S+)/gm)].map((row) => row[1]),
  datos: [...texto.matchAll(/data:\s*(.+)/g)].map((row) => row[1]),
});

const lectura = escuchar(4000);
await new Promise((resolve) => setTimeout(resolve, 400));
const cambio = await fetch(`${BASE}/api/admin/customers/${cliente.id}`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({ name: `${cliente.name} UAT`.slice(0, 80) }),
});
console.log(`cambio que provoca el aviso: ${cambio.status} ${(await cambio.text()).slice(0, 140)}`);
const resultado = await lectura;
const primero = recoger(resultado.texto);

console.log(`HTTP del flujo: ${resultado.status}`);
console.log(`eventos: ${primero.eventos.join(', ') || 'ninguno'}`);
console.log(`ids: ${primero.ids.join(',') || 'ninguno'}`);
console.log(`datos: ${primero.datos.slice(0, 3).join(' | ').slice(0, 400) || 'ninguno'}`);

const deNegocio = primero.eventos.filter((row) => row !== 'ready' && row !== 'heartbeat');
const vale = resultado.status === 200 && deNegocio.length > 0 && primero.ids.length > 0;
console.log(`\nRESULTADO: ${vale ? 'OK' : 'FALLO'} — el canal en vivo ${vale ? 'entrega eventos con id' : 'no entregó eventos utilizables'}`);

if (primero.ids.length) {
  const ultimo = primero.ids[primero.ids.length - 1];
  const despues = await escuchar(2000, Number(ultimo));
  const segundo = recoger(despues.texto);
  const repetidos = segundo.ids.filter((id) => primero.ids.includes(id));
  console.log(`reconexión desde ${ultimo}: ${segundo.eventos.join(', ') || 'sin eventos'} · repetidos=${repetidos.length}`);
}
