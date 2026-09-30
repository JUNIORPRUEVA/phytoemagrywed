# Panel de Phytoemagry (mini-CRM)

Es la app privada del negocio: ahí llegan los contactos y los pedidos, y desde
ahí se les escribe, se apunta lo que dijeron y se programan los recordatorios.

Se instala en el móvil como una app (PWA): icono propio, pantalla completa y
funciona aunque el móvil se quede sin datos.

---

## 1. Instalarlo en el móvil (una vez)

1. Abre `https://TU-DOMINIO/admin/` en el móvil.
2. Escribe la clave del panel (es `PHYTO_CRM_TOKEN`, la misma que está en
   Easypanel → Environment). Se queda guardada en ese teléfono durante 90 días.

> También vale el enlace antiguo con la clave dentro (`/panel?token=TU-CLAVE`):
> redirige a `/admin/` y **entra solo**, sin escribirla, y borra la clave de la
> barra de direcciones. Cómodo para un enlace guardado; para el día a día es
> mejor instalar la app y dejar la sesión abierta.
3. Instálala:
   - **Android (Chrome)**: menú ⋮ → **Añadir a pantalla de inicio** → *Instalar*.
   - **iPhone (Safari)**: botón Compartir → **Añadir a pantalla de inicio**.
4. Ya tienes el icono **CRM Phyto** en la pantalla de inicio. Ábrelo desde ahí:
   se ve a pantalla completa, sin barra de navegador.

En **Ajustes** hay un botón *Instalar ahora* cuando el navegador lo permite, y si
no, las instrucciones según el teléfono.

> La app no se cachea nunca en el navegador: si publicas una versión nueva, el
> próximo arranque ya la trae. Lo que sí se guarda es la **última copia de los
> datos** (para poder abrirla sin conexión) y **los cambios pendientes** de enviar.

---

## 1-bis. Probarlo en tu ordenador (sin publicar)

Un solo comando levanta la web, el API y el panel:

```bash
npm run dev
```

Y abre **http://localhost:5173/admin/**. La consola te dice la clave local:

```
🧩 CRM encendido en http://127.0.0.1:8787 · almacén sqlite · 4 registro(s)
📱 panel del CRM (app instalable): http://localhost:5173/admin/
   clave local: phyto-local   (cámbiala con PHYTO_CRM_TOKEN en .env.local)
```

Cosas útiles de este modo:

- **La clave es `phyto-local`** (el CRM de verdad se niega a abrir el panel sin
  `PHYTO_CRM_TOKEN`; en local la pone el dev server por ti). Si prefieres la tuya,
  ponla en `.env.local` y se respeta.
- **Los pedidos de verdad llegan al panel**: si rellenas el formulario de compra
  en `http://localhost:5173/`, el pedido se guarda y aparece en el panel (queda en
  `data/phytoemagry.sqlite`; borra ese archivo para empezar limpio).
- También funciona el panel solo: `http://localhost:8787/admin/`.
- **Desde el móvil, en la misma wifi**: `http://IP-DE-TU-PC:5173/admin/`.

Si prefieres el CRM solo (sin la web de desarrollo): `npm run crm` y abre
`http://127.0.0.1:8787/admin/` con la clave de `PHYTO_CRM_TOKEN`.

### Si dice que no puede entrar

El panel ahora explica el motivo en pantalla. Los dos casos de siempre:

| Mensaje | Qué pasa y qué hacer |
| --- | --- |
| *La clave no es correcta.* | La clave escrita no es `PHYTO_CRM_TOKEN` (en local, `phyto-local`) |
| *El CRM no está respondiendo en el puerto 8787…* | El API está apagado: arranca `npm run dev` (lo levanta solo) o `npm run crm` |
| *El panel no está conectado con el CRM (respuesta 404)* | Estás abriendo el panel en un servidor que no reenvía `/api/`: usa `http://localhost:5173/admin/`, no la URL del servidor de ficheros |

Antes, cualquiera de estos tres casos decía solo «No se pudo entrar», que no
ayudaba a nadie: el motivo real es siempre uno de esos tres.

---

## 2. Las cuatro pestañas

| Pestaña | Para qué sirve |
| --- | --- |
| **Hoy** | Lo que toca ahora: los recordatorios de hoy y de días pasados, más los contactos nuevos sin atender. Con la insignia roja en la pestaña y en el icono de la app |
| **Clientes** | Todo, con buscador (nombre, teléfono, ciudad, notas) y filtros: *Sin contactar*, *Pedidos*, *Con recordatorio*, *Entregados* |
| **Mensajes** | Las plantillas de WhatsApp: se crean, se editan y se borran desde aquí |
| **Ajustes** | Datos de un vistazo, descarga en CSV, instalar la app y cerrar sesión |

### La ficha de un cliente

Al tocar cualquier tarjeta se abre su ficha, con todo en una pantalla:

- **Datos**: frasco, frascos, total, teléfono, ciudad, cuándo entró y de dónde
  vino (si fue de un anuncio, el `source`).
- **Estado**: nuevo → contactado → interesado → confirmado → entregado → perdido.
- **Recordatorio**: botones *Hoy*, *Mañana*, *3 días*, *1 semana*, *Quitar* o una
  fecha concreta. Los vencidos aparecen en **Hoy** (que es lo que evita que un
  cliente se enfríe).
- **Notas**: lo que dijo, cuándo paga, a qué hora llamar.
- **Mensaje de WhatsApp**: eliges la plantilla, ves **cómo queda el mensaje antes
  de enviarlo** y se abre WhatsApp con el texto ya escrito.

Escribir por WhatsApp **queda registrado**: el cliente pasa a *contactado* y se
guarda la fecha del último contacto (así se sabe quién lleva días sin respuesta).

---

## 3. Mensajes a clientes

Las plantillas aceptan variables y se rellenan solas con los datos del cliente:

| Variable | Qué pone |
| --- | --- |
| `{nombre}` | El nombre del cliente |
| `{frasco}` | El frasco que pidió (o "Phytoemagry" si todavía no eligió) |
| `{cantidad}` | Cuántos frascos |
| `{total}` | El importe, con moneda |
| `{negocio}` | Phytoemagry |

Vienen cinco plantillas listas (saludo, confirmar pedido, recordatorio, sin
respuesta y agradecimiento). Son solo un punto de partida: están pensadas para
editarse, y todo lo que se escriba con ellas **se revisa antes de enviar** (el
panel abre WhatsApp con el texto puesto; no envía nada por su cuenta).

---

## 4. Qué pasa si el móvil se queda sin datos

El panel está pensado para ir por la calle. Si no hay conexión:

1. **Abre igual**, con la última copia de los datos guardada en el teléfono y un
   aviso arriba (*Sin conexión*).
2. **Puedes trabajar**: cambiar estados, apuntar notas, poner recordatorios. Se
   aplican en pantalla y quedan en una lista de *cambios pendientes*.
3. **Al volver la conexión se envían solos** y el aviso desaparece. Lo que se
   envía es el cambio (por ejemplo "este cliente queda en interesado"), así que
   aunque el teléfono haya estado horas sin red no se pisa el trabajo de nadie.

---

## 5. Detalles técnicos (para quien mantenga esto)

- **Clave y sesión**: la clave del panel es `PHYTO_CRM_TOKEN`. Al entrar, el
  servidor devuelve una cookie **HttpOnly, SameSite=Strict** (y `Secure` si va por
  HTTPS) firmada con HMAC: no hay tabla de sesiones y, si cambias la clave, todas
  las sesiones dejan de valer. El enlace antiguo `/panel?token=…` sigue entrando y
  redirige a `/admin/` (así se cambia de costumbre sin perder el acceso).
- **Límite de intentos**: 10 por IP cada 15 minutos, para que nadie pruebe claves.
- **Endpoints** (necesitan sesión; ver `docs/CRM-CONTRACT.md`):
  `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/session`,
  `GET /api/admin/data`, `PATCH /api/admin/items/:id`,
  `POST /api/admin/messages`, `DELETE /api/admin/messages/:id`.
- **Archivos**: `public/admin/` (una sola página, sin frameworks). El
  `service worker` (`sw.js`) guarda el armazón en caché y **nunca** cachea
  `/api/`: el negocio tiene que ver el último pedido, no una copia vieja.
- **Dónde vive**: `server/crm-server.mjs` sirve la app y el API; en producción
  nginx sirve `/admin/` como archivos estáticos y le pasa `/api/` al API.
- **En local no hay nginx**: `npm run dev` levanta el CRM como proceso hijo y
  reenvía `/api/...` a `127.0.0.1:8787` (`scripts/crm-proxy.mjs`). Por eso el panel
  funciona en `localhost:5173/admin/` igual que en producción. Si el CRM no está
  encendido, el proxy contesta **502 en JSON con un mensaje legible** en vez de
  dejar que el panel reciba el 404 en HTML del servidor de ficheros (eso era el
  «No se pudo entrar» sin explicación).
- **Tests**: `tests/panel.test.js` arranca el servidor de verdad y entra como el
  negocio: clave, cookie, gestión de un cliente, plantillas y CSV.
- **Iconos**: se generan con `npm run images:admin` (Pillow), sin archivos
  externos.

---

## Centro de ventas (S4 · S5 · S6)

El CRM se usa desde el móvil, muchas veces con una conversación abierta. Por eso el
trabajo comercial vive **dentro del chat**: una sola tecla (⋯) en el encabezado de la
conversación abre las cuatro acciones, en vez de llenar la barra de botones.

| Acción | Qué hace |
| --- | --- |
| **Crear pedido** | Bottom sheet con los frascos del catálogo, cantidad, descuento, entrega y notas. El total se calcula en el momento y **el precio sale del servidor** |
| **Programar seguimiento** | Tarea para una persona (Hoy / Mañana / 3 días / 7 días / fecha). **No envía nada** |
| **Programar mensaje** | Mensaje concreto que el sistema intentará enviar. Es otra cosa distinta de un seguimiento y se dice en pantalla |
| **Ver cliente** | Ficha 360 |

### Comprobante de compra

Al guardar un pedido se abre su **comprobante**: número (`PE-XXXXXX`), fecha, cliente,
teléfono **enmascarado** (`+1809••• ••01`), líneas, subtotal, descuento, total y estado.
Dos vistas: la del panel y un documento HTML ligero (`/api/admin/orders/:id/receipt`)
que se abre, se imprime o se guarda como PDF desde el navegador. **Nunca se llama
«factura»**: no hay integración fiscal.

### HOY = «¿qué tengo que hacer ahora para vender?»

Los contadores y las secciones son trabajo pendiente con su acción directa (responder,
abrir el chat, hecho, +3 días, cancelar, ver comprobante). El orden es el del día:
seguimientos vencidos, de hoy, «necesitan una persona», «esperando respuesta»,
recordatorios y el aviso de los **mensajes programados que no salieron**.

### Ajustes

- **Plan de postventa**: interruptores por día (1, 3, 7, 14, 21, 30). Cambiarlo afecta a
  las tareas que se creen a partir de ese momento; las ya creadas no se borran.
- **Métricas** por período (Hoy / 7 días / 30 días): leads, conversaciones, pedidos
  creados / confirmados / entregados, ventas en RD$, recompras y pendientes de
  seguimiento. Sin atribución inventada.
- **Auditoría reciente**: quién creó, cambió, entregó o canceló qué.

### Reglas que no se rompen

1. **Nada se envía solo** salvo un mensaje que el negocio programó expresamente, y solo
   si al llegar la hora sigue siendo legal.
2. Si un mensaje programado queda fuera de la ventana de 24 h, con opt-out o con una
   plantilla sin aprobar: **no se fuerza**. Queda `BLOQUEADO` y aparece una tarea para
   una persona.
3. Un reinicio del servidor **no pierde ni duplica** un mensaje programado
   (`idempotency_key` única + recuperación de trabajos interrumpidos).
4. El precio sale de UNA fuente (`src/config/product.config.js` → `src/lib/catalog.js`).
5. Los pedidos antiguos (una sola línea, sin detalle) siguen leyéndose igual.