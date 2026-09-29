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
- **Tests**: `tests/panel.test.js` arranca el servidor de verdad y entra como el
  negocio: clave, cookie, gestión de un cliente, plantillas y CSV.
- **Iconos**: se generan con `npm run images:admin` (Pillow), sin archivos
  externos.
