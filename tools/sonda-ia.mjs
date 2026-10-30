// Sonda de las funciones de IA del CRM contra la UAT aislada.
const BASE = process.env.BASE ?? 'http://127.0.0.1:8791';

const login = await fetch(new URL('/api/admin/login', BASE), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin@uat.local', password: 'UatLocal-123' }),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

const lista = await fetch(new URL('/api/admin/conversations?filter=todos', BASE), { headers: { cookie } }).then((r) => r.json());
const conv = (lista.conversations ?? [])[0];
console.log('conversación:', conv?.id);

const probar = async (ruta, body) => {
  const res = await fetch(new URL(ruta, BASE), {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const texto = await res.text();
  console.log(`\n${ruta} -> HTTP ${res.status}\n${texto.slice(0, 400)}`);
};

await probar('/api/admin/proofreading', { conversationId: conv?.id, text: 'ola ke ase amigo' });
await probar('/api/admin/ai/reply-suggestion', { conversationId: conv?.id });
await probar('/api/admin/assistant/query', { conversationId: conv?.id, action: 'free', message: 'resumen del cliente' });
await probar('/api/admin/ai/order-message', { conversationId: conv?.id, missing: ['teléfono'], total: 100 });
