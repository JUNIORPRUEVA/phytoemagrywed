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

## 1-ter. Ambiente de pruebas (base de datos aparte, sin envíos reales)

`npm run dev` usa la MISMA base de datos y las MISMAS credenciales de WhatsApp que
producción (`data/phytoemagry.sqlite` y lo que haya en `.env`). Para trabajar sin
riesgo hay dos modos, con la misma garantía de aislamiento:

```bash
npm run dev:datos    # SEGUIR DESARROLLANDO: copia tus datos reales (recomendado)
npm run uat          # ambiente de PRUEBAS con datos de ejemplo inventados
npm run uat:reset    # borra lo que hay en data/uat/ y lo vuelve a sembrar de cero
```

### a) `npm run dev:datos` — tu base de verdad, copiada

Es el modo para **seguir desarrollando la app**: levanta el CRM y el panel en
**http://127.0.0.1:8790/admin/** con una **copia** de tus datos reales, así que ves
tus clientes, pedidos, conversaciones y plantillas de siempre. Entras con **tus
usuarios de siempre** (no hay cuentas nuevas).

Cómo se protege la original:

- La base real se abre **solo para leer** (`readOnly`) y se copia con
  `VACUUM INTO` (seguro aunque haya un `-wal` activo). Nunca se abre para escribir.
- **Todo lo que hagas cae en `data/uat/`**: base, archivos (`data/uat/media/`) y
  el registro de envíos (`data/uat/envios.log`). Borrar `data/uat/` no afecta nada.
- WhatsApp sigue simulado y Meta (CAPI) y el push siguen apagados: **no sale
  ningún mensaje real** ni desde el panel ni desde el motor de programados.

Detalles honestos:

- La copia es un **retrato del momento** en que arrancas. Volver a ejecutar
  `npm run dev:datos` **reemplaza** la copia por los datos de ahora: lo que hayas
  hecho en el entorno de trabajo se pierde. Para volver a la misma copia sin
  reemplazarla, usa `npm run uat` (reutiliza `data/uat/phyto-uat.sqlite` tal cual).
- Las **fotos y audios viejos no vienen** en la copia: en producción viven en R2,
  no en la base de datos. Los mensajes se ven, pero los adjuntos anteriores no
  cargan; lo que subas desde este entorno sí se guarda y se abre con normalidad.
- El arranque crea/actualiza la cuenta `admin@uat.local` (clave `UatLocal-123`)
  dentro de la copia, como puerta de emergencia si no recuerdas una contraseña.
  En tu base real no se crea nada.

### b) `npm run uat` — datos de ejemplo

Para probar flujos completos desde cero, con datos inventados que puedes romper
sin pensar. Abre **http://127.0.0.1:8790/admin/** y entra con cualquiera de los
cuatro usuarios (contraseña `UatLocal-123`):

| Usuario | Rol | Para qué sirve |
| --- | --- | --- |
| `admin@uat.local` | ADMIN | todo: asignar reparto, cambiar estado, ajustes |
| `agente@uat.local` | AGENT | atender clientes y entregar (el negocio no tiene reparto aparte) |
| `reparto@uat.local` | DELIVERY | ver SOLO lo suyo, iniciar y cerrar la entrega |
| `operador@uat.local` | OPERADOR | ventas sin reparto |

**Qué garantiza** (el arranque lo comprueba y lo imprime):

- **Base de datos propia**: `data/uat/phyto-uat.sqlite`. Postgres y la base de
  producción se ignoran por completo.
- **Nada sale a internet**: WhatsApp va en modo simulado (cada envío se anota en
  `data/uat/envios.log`), la API de conversiones de Meta queda apagada y las
  notificaciones push desactivadas.
- **Los archivos** (fotos, audios, facturas) se guardan en `data/uat/media/`: se
  abren desde el hilo como en producción y se borran con `--reset`.

**Qué trae sembrado** (solo en este modo): 10 clientes (uno con la ventana de 24 h
cerrada, otro que pidió no recibir mensajes), 9 pedidos (uno por estado y
situación), una entrega **en vivo** con GPS en el mapa, una asignada y lista para
«Iniciar entrega», un pedido sin ubicación, inventario cargado, y 2 mensajes
programados (uno sale solo en 3 minutos; el del cliente con opt-out se bloquea).
Las plantillas se marcan **aprobadas solo en esa base** para poder probar los
flujos que Meta exige (ubicación, confirmación, factura fuera de ventana).

Opciones útiles (`node scripts/uat-env.mjs --help`):

| Opción | Qué hace |
| --- | --- |
| `--copiar-datos` | trabaja con una **copia de la base real** en vez de los datos de ejemplo (es lo que usa `npm run dev:datos`) |
| `--port=8790` | cambia el puerto |
| `--sin-scheduler` | no procesa los mensajes programados |
| `--solo-sembrar` | prepara los datos y sale (no deja el servidor abierto) |
| `--sembrar` | vuelve a sembrar los datos de ejemplo encima de lo que haya |
| `--json` | salida resumida para scripts |

Para la **web pública** contra este CRM:

```bash
PHYTO_CRM_PORT=8790 PHYTO_CRM_NO_AUTO=1 npm run dev
```

`PHYTO_CRM_NO_AUTO=1` evita que la web arranque **su propio** CRM apuntando a la
base de producción: así las dos partes hablan con el mismo CRM aislado. El
ambiente ya permite el origen `http://localhost:5173`.

> El código del panel se sirve tal cual desde `public/admin/`: para desarrollar
> basta guardar y recargar (sin compilar nada, y sin tocar el `dist/` de la web).

---

## 1-quater. Trabajar sin conexión (24 h o más)

El CRM de verdad vive en la nube. El panel guarda en el teléfono **todo lo que
hace falta para seguir trabajando** cuando no hay red, y manda lo que se hizo en
cuanto vuelve.

**Sin conexión SÍ funciona**

- Abrir la app (incluso con el teléfono en modo avión y la app cerrada).
- Ver **Hoy**, la lista de **pedidos**, **clientes**, **seguimientos**, el
  **inventario**, las **entregas** y los **últimos informes vistos**.
- **Registrar pedidos** (sale de la lista del teléfono, con su marca «sin enviar»).
- **Finalizar o cambiar el estado** de un pedido (incluso en la calle, después de
  entregar).
- **Crear clientes** y **archivar chats**.
- Crear y cerrar **tareas de seguimiento**.
- Buscar y leer lo que ya está guardado.

**Sin conexión NO funciona** (necesita internet a propósito)

- **Enviar o recibir mensajes de WhatsApp** (los manda y los recibe Meta).
- **Programar un mensaje**: lo envía el servidor a su hora. El panel lo dice en
  vez de dejar prepararlo para nada.
- La API de conversiones de Meta y las notificaciones push.
- Las **fotos y audios viejos**: viven en el almacén (R2/S3), no en el teléfono.
  Los mensajes se leen; los adjuntos anteriores no se pueden abrir sin conexión.

**Cómo se comporta**

- **La sesión no se vence por estar sin conexión.** La sesión dura 90 días y el
  panel no la cierra cuando no puede preguntar: sin red se abre con la copia y el
  rol que ya tenía. Solo vuelve a la pantalla de entrada si el servidor responde
  que la sesión ya no vale.
- **La app no se recarga sola.** Al volver a la app se sincroniza **por detrás**
  (cada minuto y al recuperar el foco): misma pestaña, misma hoja abierta, mismo
  texto escrito. La única recarga es la que pulsa una persona en el aviso
  «Versión nueva».
- **Nada se pierde ni se duplica.** Lo que se hace sin red va a una **cola de
  envíos** y sale en orden al volver la conexión. Si el CRM lo **rechaza** (por
  ejemplo, el pedido ya se había entregado), se dice **por qué** en un aviso que
  hay que leer: no se descarta nada en silencio.
- **Se ve lo que falta por enviar**: cada pedido hecho sin conexión lleva su
  etiqueta **«Sin enviar»** y arriba aparece un aviso con el botón **Enviar
  ahora**.

**Cómo está hecho** (para quien mantenga esto)

- El **armazón** de la app (HTML, CSS, JS, iconos) lo guarda el *service worker*;
  por eso abre sin red. Se guarda archivo a archivo: que falte un icono no deja
  al panel sin copia.
- La **copia de datos** vive en el almacenamiento del navegador
  (`localStorage` → `pe_crm_snapshot`): clientes, pedidos, catálogo, ajustes,
  estados y formas de pago, entregas y los últimos informes y comprobantes
  abiertos. Si el navegador se queda sin sitio, se guarda una copia **ligera**
  (sin conversaciones ni avisos) antes que quedarse sin ninguna.
- La **cola de envíos** (`pe_crm_outbox`) lleva el cambio, su motivo legible y una
  clave por cosa: dos cambios del mismo pedido se funden en uno.
- **No hace falta instalar nada más en el servidor** (ni Redis ni ninguna cola
  externa): el CRM ya es un solo proceso y quien guarda el trabajo pendiente es el
  teléfono, que es donde se pierde la conexión. Redis serviría para compartir
  sesiones entre VARIOS servidores del CRM a la vez, y eso hoy no ocurre.

**Límites honestos**

- La copia es de **ese** teléfono y de **ese** navegador. Si se borran los datos
  del sitio (o se entra en modo privado), no hay copia: sin red no habría qué
  enseñar.
- La copia es **un retrato**: tiene los datos de la última vez que hubo conexión.
  Un pedido que otro compañero registre mientras tú estás sin red aparecerá al
  volver la conexión.
- Un mensaje de WhatsApp **escrito** sin conexión no se puede encolar: WhatsApp no
  admite envíos diferidos desde aquí (para eso está «Programar mensaje», que sí
  necesita red para dejarlo en el servidor).

---

## 2. Las cuatro pestañas

### Apariencia: claro, oscuro o como tu teléfono

El panel se ve de día y de noche, y lo elige cada persona:

- **Dónde**: *Mi perfil* (abajo del menú lateral, entra cualquier rol) y también en
  *Configuración → Apariencia*.
- **Tres opciones**: **Claro**, **Oscuro** y **Como el teléfono** (sigue el modo oscuro
  del móvil, y cambia solo si el teléfono cambia, sin recargar).
- **Se recuerda** en el propio teléfono: se abre ya con el tema elegido, sin fogonazo
  blanco (el tema se aplica antes de pintar).
- El oscuro no es «el claro en negro»: los grises son verdosos y las superficies se
  separan por tono, no por sombras (una sombra negra sobre negro no se ve).

### Lo que eliges se queda elegido

Cerrar el panel y volver a abrirlo no devuelve la app a «todo en general»:

- **La pestaña**: se abre donde lo dejaste (si estabas en WhatsApp, abre WhatsApp).
  Un enlace directo (`?v=...`, una notificación) manda sobre esto, como es lógico.
- **Los filtros**: el de la bandeja (por ejemplo **Archivados**), el de pedidos (estado
  y fecha), el de seguimientos y el de clientes se quedan puestos, también sus fechas.
- **Se ve lo que está filtrado**, sin abrir nada: el título de la bandeja dice
  «Conversaciones · Archivados», Clientes dice «Personas · Interesados», y Pedidos ya
  tenía sus dos chips (*Estado · …* y la fecha). Quitar el filtro también se recuerda.
- **Lo que se escribe en un buscador NO se guarda**, a propósito: un texto de hace tres
  días esconde datos sin que se vea de dónde salen. Los filtros se ven; un texto
  olvidado, no.
- Si en el teléfono quedara un valor raro (una versión vieja), se ignora y se usa el de
  siempre: una preferencia rota no puede dejar la lista vacía.

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

### El armazón: barra de arriba, navbar y menú

El sistema del armazón vive en **`public/admin/shell-v2-tema.css`**, que se carga
**después** de `admin.css` a propósito: es la última palabra sobre estas piezas, sin
tocar la lógica de ninguna pantalla.

- **Barra de arriba**: fondo sólido del tema, una línea fina abajo y los dos iconos
  (perfil y avisos) en un círculo con color de marca. Antes eran círculos translúcidos
  con icono blanco sobre barra clara: en el móvil no se veían.
- **Navbar inferior**: barra pegada abajo, a todo el ancho, con el icono y su nombre y
  una pastilla de color de marca detrás del icono activo (el gesto de WhatsApp). Las
  opciones no cambian: Hoy, WhatsApp, Pedidos y Clientes.
- **Menú lateral**: el icono de menú son tres barras que se convierten en ✕ al abrir
  (la animación se dispara con `body[data-drawer='open']`, así animan todos los botones
  de menú a la vez).
- **La marca** se escribe con una serif suave (variable `--pe-brand-font`) y el «CRM» es
  una etiqueta, no un eco del nombre.

#### El menú lateral en escritorio

La piel vive en **`public/admin/drawer-menu.css`** (se carga al final) y el orden lo
decide `plegarMenuEscritorio()` en `app.js`.

- En escritorio **no hay barra inferior** y, dentro de WhatsApp, tampoco barra superior:
  el menú lateral es la única navegación. Por eso lleva **«Principal»**, con los cuatro
  destinos de la barra (Hoy, Chats, Pedidos y Clientes) y **los mismos contadores**
  (`data-drawer-badge`). En el móvil esa sección se oculta, porque la barra ya está abajo.
- El resto se ordena en **desplegables**: Ventas, Seguimiento y Sistema. Al abrir el menú
  se despliega solo el grupo de la pantalla actual (Inventario incluido si estás en
  Productos, Cotizaciones, Stock o Recuento) y los demás quedan como cabeceras con su
  flecha. Así todo cabe sin tener que desplazar el menú.
- La marca, la apariencia y «Cerrar sesión» quedan fijos: solo se desplaza la lista de
  opciones (`.drawer__body`), con barra fina.
- En WhatsApp, el botón ☰ de la cabecera de la bandeja (`.wa__menu`) abre el menú; antes
  en esa pantalla no había ninguna forma de abrirlo con ratón.
- En el móvil no cambia nada visible: los grupos se abren enteros y las cabeceras se
  pintan como siempre.

#### El lienzo de las pantallas en escritorio

`public/admin/panel-desktop.css` (también la última) ordena el resto de pantallas. En
el móvil no se aplica: **todo** va dentro de `@media (min-width: 980px)`.

- **Lienzo centrado**: el contenido se limita a 1320 px y se centra con 24 px de aire.
  Antes se estiraba a los 1400 px del monitor y las filas se leían de borde a borde.
  WhatsApp (a pantalla completa) y Facturación (su propio tablero) quedan fuera.
- **Hoy**: las ocho tarjetas pasan a dos filas parejas de cuatro (antes cinco y tres).
- **Pedidos, Clientes, Usuarios, Seguimientos, Plantillas y Productos**: sus tarjetas se
  reparten en **dos columnas** desde 1200 px. Lo que no es tarjeta (un título, un aviso,
  el rango de fechas) ocupa la fila entera.
- **Reportes**: el cuadro de utilidad va a todo el ancho y «Por presentación» y «Ventas»
  comparten la fila de abajo. **Cierre diario**: cabecera y resumen a todo el ancho y los
  bloques en pareja. **Mis entregas**: cada grupo (pendientes, en camino…) reparte sus
  pedidos en dos columnas.
- **Clientes**: buscador y filtros en la misma fila; en Pedidos y Clientes se oculta la
  cabecera «Filtros · ×» (es del panel del móvil) y los chips se reparten en varias líneas
  en vez de cortarse.
- **Mapa**: mapa a la izquierda y lista a la derecha (410 px; 340 px en pantallas
  medianas), con el alto de la ventana. Antes la lista caía debajo del mapa.
- Detalles de acabado: barras de desplazamiento finas, botones flotantes alineados con el
  borde del contenido en monitores anchos y el perfil centrado.
- **Fantasma corregido**: `pos.css` fuerza `#view-catalogo { display: grid !important }` en
  escritorio para su rejilla de dos columnas, y eso le ganaba al `[hidden]` del panel: la
  vista de Facturación seguía ocupando ~94 px al final de TODAS las demás pantallas. Ahora
  se apaga cuando no es la pantalla activa (`panel-desktop.css`), y las páginas cortas
  vuelven a terminar en la ventana (scroll 900 px exactos a 1440 × 900).

Medido en el navegador a 1440 × 900: contenido 1320 px (antes 1416), Pedidos 655 px de
alto con dos columnas (antes 1018 en una), Clientes 588 (antes 998), Plantillas 1296
(antes 1982) y Mis entregas 1524 (antes 2051). A 1024 × 768 las listas vuelven a una
columna y el mapa mantiene la lista a 340 px. Sin desbordamiento horizontal en ninguna
pantalla.

Los colores salen de variables (`--pe-page-bg`, `--pe-appbar-bg`, `--pe-tabbar-bg`,
`--pe-card-bg`, `--pe-brand-text`…). Si algo se ve mal de noche, se arregla cambiando
una variable, no escribiendo un color nuevo. Las filas de conversación, los paneles de
filtros y las burbujas tienen su bloque de oscuro en ese mismo archivo.

#### Cotizaciones: lupa y filtro en la barra, lista en tarjetas

La pantalla de Cotizaciones tenía un buscador suelto dentro de la página. Ahora **la lupa
y el filtro viven en la barra de arriba**, a la derecha, igual que en Clientes y Pedidos
(`app.js` pinta la barra; `pos.js` decide qué se ve).

- La barra tiene **dos filas**: la normal (volver · «Cotizaciones» · 🔍 ⚙) y la de
  búsqueda, que se cambia en el sitio con una animación corta de 160 ms. Se alternan con
  `body[data-quote-search='open']`, así que no hay dos barras montadas: es la misma.
- **El texto deja de filtrar cuando cierras la búsqueda**. Con el botón ✕ o con `Escape`
  se limpia la consulta: si no, la lista quedaba vacía sin que se viera por qué (pasó al
  probarlo y está corregido).
- **Filtros** (panel pegado a la barra, no una hoja que sube desde abajo): Estado
  (Todas / Abiertas / Facturadas, con su cuenta) y Periodo (Todas / Hoy / 7 días / 30
  días). Se cierran al pulsar fuera o con `Escape`, y el botón ⚙ se queda con un punto
  azul mientras haya algo puesto.
- **La lista es de tarjetas**, no de filas: iniciales con color estable por cotización,
  nombre, estado (Abierta / Facturada), fecha, referencia corta (`#19F47967C4`), resumen
  de artículos, importe y descuento. Arriba, una línea de resumen: cuántas hay, cuántas
  abiertas y cuánto suman. Sin resultados, un estado vacío que explica y ofrece
  **Quitar filtros**.
- **En escritorio** la barra se enciende (el appbar general está oculto en el panel), se
  alinea con el contenido (máximo 1000 px, centrado), pierde la flecha de volver y el
  título crece: la navegación va por el menú. En el detalle de una cotización la barra se
  queda solo con el título, porque ya hay «‹ Todas las cotizaciones».
- En el móvil se sigue viendo igual: la tarjeta entera se pulsa, sin flecha lateral
  (le robaba el sitio al nombre) y con el estado debajo del nombre por debajo de 360 px.
- **Datos de prueba**: `scripts/uat-env.mjs` siembra seis cotizaciones por la misma API
  del panel (una pasada a factura, con descuentos y envíos distintos), con el total
  calculado por `calculateSale()`. Es idempotente: si ya hay cotizaciones, no toca nada.

Medido en el navegador: 390 × 844, 360, 320, 1024 × 768 y 1440 × 900, en claro y en
oscuro, sin desbordamiento horizontal y sin nombres recortados (solo se recorta el resumen
de artículos, que es una línea a propósito).

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

En el botón flotante de la factura, **Enviar factura por WhatsApp**: el PDF (nombre
`Factura-<pedido>.pdf`) sale del CRM con la API oficial de WhatsApp. Antes de enviar
se enseña a quién, qué documento y con qué texto; un toque lo envía y queda en el
hilo. No se abre WhatsApp Web, ni la app, ni el menú de compartir del teléfono.
Fuera de la ventana de 24 h solo sale con la plantilla `phyto_envio_factura_v1`
aprobada (con cabecera de documento); si no lo está, se explica y no se envía nada.
Ver `docs/WHATSAPP_INTEGRATION.md` y `docs/CRM-CONTRACT.md`.

### HOY = «¿qué tengo que hacer ahora para vender?»

Los contadores y las secciones son trabajo pendiente con su acción directa (responder,
abrir el chat, hecho, +3 días, cancelar, ver comprobante). El orden es el del día:
seguimientos vencidos, de hoy, «necesitan una persona», «esperando respuesta»,
recordatorios y el aviso de los **mensajes programados que no salieron**.

#### Las tarjetas de HOY (y por qué son estas)

Son **ocho**, no un cuadro de mando: lo que se hace hoy y a quién se le escribe.

| Tarjeta | Al tocarla se abre |
| --- | --- |
| Sin responder | WhatsApp con el filtro **Pendientes** (esperando respuesta) |
| Sin asignar | WhatsApp con el filtro **Sin asignar** |
| Pedidos pendientes | Pedidos con **Estado · Pendientes** y la fecha en **Hoy** |
| Seguimientos vencidos | Seguimientos con el bloque **Vencidos** |
| Seguimientos de hoy | Seguimientos con el bloque **Para hoy** |
| Clientes / Interesados / Con compra | Clientes con ese filtro puesto |

Dos reglas que no se rompen:

- **El número de la tarjeta es exactamente lo que ves al entrar.** Se cuenta con la
  misma regla que usa la lista de destino (el filtro de la bandeja, el estado
  operativo del pedido, el segmento del cliente). Si no cuadra, la tarjeta solo hace
  dudar.
- **Nada de contadores internos.** «Enviados», «por enviar», «por revisar»,
  «programados» y «entregas activas» eran el mismo trabajo contado por dentro: el
  sistema hablándole al sistema. Lo que no salió se avisa en **Notificaciones**, y los
  mensajes programados de un cliente están en su ficha.

En el móvil van **de dos en dos**, con el número grande y la etiqueta completa (nunca
cortada con puntos suspensivos); en el iPhone SE la tarjeta se estrecha en vez de
apretar el texto. En pantalla grande se reparten de cuatro en cuatro.

#### Notificaciones: lo que se borra, se borra

«Eliminar todas» (y el botón **Borrar** de cada una) quitan la notificación de esta
pantalla **y del servidor**: el aviso queda marcado como borrado para su destinatario,
así que no vuelve a aparecer **en ningún sitio** — ni al abrir el panel desde el icono
instalado, ni en otro móvil, ni con los datos del navegador limpios. Si el mismo suceso
se procesara otra vez (una fila nueva con otro id), el recuerdo por *suceso* lo
descarta igual. Y si en ese momento no había red, el borrado queda pendiente y se
reintenta solo: **no se da por hecho sin confirmación del servidor**.

El panel además apunta los ids borrados en el propio teléfono: mientras el servidor
contesta (o si no hay red), la campana ya no los cuenta.

Lo mismo con los avisos que calcula el panel (los mensajes que WhatsApp rechazó, los
programados que no salieron): «Entendido» recuerda **el valor** que se dio por
entendido, así que el mismo aviso no reaparece por el hecho de que el contador suba o
el mensaje cambie de estado.

#### Permisos: se piden una vez

El aviso de «Activar notificaciones» (y el de ubicación) sale **una vez**, con un botón
**Ahora no** al lado:

- Si el permiso ya está concedido, no se vuelve a pedir.
- Si el cliente dijo que no («Ahora no»), no se le insiste: queda en *Configuración →
  Notificaciones* para cuando quiera.
- Si el navegador no puede concederlo desde ahí (iPhone desde Safari: hay que añadir el
  panel a la pantalla de inicio), no se enseña un botón que no puede cumplir lo que
  promete: se explica qué hacer, **una vez**.
- Si el estado cambia más adelante (el navegador lo bloquea, o lo quitan), se cuenta
  una única vez más. Dentro de la misma visita el aviso se queda a la vista hasta que
  el usuario haga algo.
- El GPS se pide a quien entrega (rol Delivery) y en la pantalla de entregas, no en HOY
  por el simple hecho de que haya pedidos cargados.

### Ajustes

- **Plan de postventa**: interruptores por día (1, 3, 7, 14, 21, 30). Cambiarlo afecta a
  las tareas que se creen a partir de ese momento; las ya creadas no se borran.
- **Métricas** por período (Hoy / 7 días / 30 días): leads, conversaciones, pedidos
  creados / confirmados / entregados, ventas en RD$, recompras y pendientes de
  seguimiento. Sin atribución inventada.
- **Auditoría reciente**: quién creó, cambió, entregó o canceló qué.

### Mi perfil (abajo del menú lateral)

Vive en el menú lateral, al final de la parte de abajo (y también se entra tocando el
bloque con tu nombre, arriba del menú). Cada persona con su propia cuenta puede, sin
pedirle nada a un administrador:

- **Nombre visible**: es el nombre que viaja con cada mensaje que envía y el que se ve
  en el chat como autor. Cambiarlo no reescribe los mensajes ya enviados (cada mensaje
  guarda el nombre de quien lo escribió en ese momento).
- **Nombre y apellido**, y de paso ver con qué **usuario** entra y su **rol** (el usuario
  no se cambia desde aquí).
- **Contraseña**: hay que escribir la actual. Al cambiarla se cierran **todas** las
  sesiones —esta incluida— y el panel vuelve a la pantalla de entrada. Una contraseña
  actual equivocada es un dato inválido del formulario (avisa y **sigue dentro**), no una
  sesión caducada.

Quien entra con la **clave del panel** (la de antes, sin usuario) no tiene perfil: esa
clave no es una cuenta personal y la página lo dice, con un botón para entrar con
usuario. Un agente puede cambiar **sus** datos y su clave; los de otra persona solo los
toca un administrador desde **Usuarios**.

### Compartir app (abajo del menú lateral)

Para pasarle el panel a otra persona (un vendedor, un repartidor, el socio):

1. **Compartir app** en el menú: en el móvil abre la hoja de compartir del teléfono
   (WhatsApp, correo, lo que uses); en el ordenador copia el enlace y lo avisa.
   Si el navegador no deja copiar, sale una hoja con el enlace a la vista y un botón
   para mandarlo por WhatsApp.
2. Esa persona **abre el enlace** e instala el panel en su teléfono si quiere (se puede
   añadir a la pantalla de inicio, como una app).
3. Para **entrar** necesita su propio usuario: se crea en **Usuarios** y se le dice el
   usuario y la contraseña. El enlace que se comparte **no da acceso a nada** — va sin la
   clave del panel a propósito.

### Pedidos: cerrar el día sin abrir fichas

La lista de **Pedidos** está hecha para trabajarla de arriba abajo, sin entrar en cada
ficha:

- **Abre en HOY.** El chip de fecha dice el rango que está puesto y se cambia desde ahí:
  Hoy, Ayer, un día suelto de la semana, últimos 7 días, este mes, un intervalo o todos.
  La cuenta de arriba dice siempre de dónde salen los que se ven («3 de 13 pedidos · hoy»)
  y, si no hay pedidos de ese día, lo dice y ofrece **Ver todos los pedidos**.
- **El estado va en el COLOR de la fila**: pendiente en rojo (es lo que hay que resolver
  hoy), en camino en azul, entregado en verde y cancelado en gris apagado. El filo
  izquierdo y la etiqueta de estado llevan el mismo color.
- **La fila es FINA: 64 px, sin botones.** Un pedido ocupa lo que se lee de un vistazo
  —**quién**, la referencia con el **pago** (efectivo o transferencia), **cuánto** y en qué
  **estado**— y, debajo, una línea corta con el **teléfono**, **quién lo atiende** y si ya
  tiene **repartidor** o va **sin delivery**. Caben diez pedidos en una pantalla de móvil
  (antes, cuatro).
- **Todo lo demás vive en el «⋯» de la fila**, el mismo gesto que en la lista de chats:
  *Cambiar el estado* (dice cuál es el de ahora), *Escribir al cliente*, *Marcar para
  acciones en lote*, ver el pedido completo, factura, mapa, pasar a un delivery, cancelar,
  eliminar, ver al cliente, WhatsApp, seguimiento y mensaje. Arriba del menú se lee el dato
  que en la fila puede quedar recortado: **teléfono · quién lo atiende · reparto**.
- **Estado** ofrece los estados que ese pedido admite y que tu rol puede aplicar. Al
  **finalizar** hay una casilla ya puesta para **avisar al cliente**: se abre su
  conversación con el mensaje escrito y solo hay que enviarlo — el aviso **no sale solo**.
  Finalizar hace el trabajo completo: inventario, cierre del tracking, postventa y Meta.
- **Varios a la vez**: se marcan los pedidos y aparece una barra abajo con **Finalizar**,
  Estado, Seguimiento y Mensaje. Se aplican **de uno en uno** (cada pedido mueve
  inventario) y al terminar se dice cuántos entraron y por qué falló el resto.
- El botón flotante **✦**, encima del de agregar pedido, tiene lo que es de TODA la lista:
  seleccionar los que se ven, finalizar los seleccionados, marcar seguimiento, programar
  un mensaje y filtrar por fecha.

**Quién puede finalizar**: cualquiera que atienda pedidos (admin, agente u operador), por
la ruta `POST /api/admin/orders/:id/finish`, que **solo** sirve para pasar a entregado. Los
demás cambios de estado (cancelar, volver a pendiente) siguen siendo de ADMIN, porque
mueven inventario y ventas. El motivo queda auditado con el usuario en todos los casos.

### La barra de abajo (Hoy)

El icono mide **26 px** y el nombre va a **12 px**, con el nombre bajo el icono y el icono
activo dentro de su **pastilla** azul: es el gesto de WhatsApp, un punto más grande, para
que la barra se lea de un toque y sin acercar la vista. El aviso de sin leer (el número
rojo) va pegado a la esquina del icono. La barra se ve en **Hoy**; en las demás pantallas
manda la cabecera con el menú, que deja el alto entero para la lista.

Y la raya que separa la barra del contenido **no es un borde**: es una línea de un pixel
al **6 % de opacidad**, sin la segunda línea que llevaba antes (eran dos superpuestas y por
eso se veía un borde gris). El mismo criterio vale para la cabecera, el menú lateral y el
contorno de cada pedido: la separación la hacen el color y el espacio, no una raya dura.

### Un mensaje ya enviado: deshacer, quitar del CRM y corregir

**La verdad primero: en WhatsApp no se puede borrar ni editar un mensaje que ya salió.**
La API oficial no tiene forma de hacerlo (el «eliminar para todos» existe solo en la app
del teléfono, y solo durante 15 minutos), y el cliente lo tiene en su móvil igual. Por eso
el panel no finge un borrado que no existe: lo que ofrece es lo que de verdad se puede.

- **Deshacer, antes de que salga (8 segundos).** Un mensaje **escrito a mano** aparece en
  el hilo con «Enviando…» y un botón **Deshacer · 8s**. Si se pulsa, el mensaje **no sale**:
  nunca se llama a WhatsApp, así que el cliente no lo ve, y **el texto vuelve al
  compositor** para corregirlo. Es la única forma de eliminar un mensaje de verdad.
  La **plantilla** y el **archivo** no llevan ventana (ya pasan por su vista previa, ahí el
  «estoy seguro» se pidió antes), ni el aviso de entrega, que lo manda el servidor.
- **Quitar del CRM** (pulsación larga sobre el mensaje, o clic derecho en el ordenador): el
  mensaje se aparta de la vista —su texto y su archivo **dejan de mostrarse** y deja de ser
  el resumen de la fila en la bandeja— y en su hueco se lee *«Mensaje quitado del CRM por
  Fulano · el cliente lo conserva»*. **No se destruye nada**: queda el registro de quién lo
  hizo y administración puede **devolverlo al hilo**.
- **Editar y reenviar**: trae el texto de ese mensaje al compositor para corregirlo y
  mandarlo otra vez. Sale como un mensaje **nuevo**; el original no cambia (eso WhatsApp no
  lo permite).

**Quién puede**: administración, cualquier mensaje; cada persona, **los que escribió ella**.
Devolver al hilo un mensaje quitado, solo administración. Todas esas decisiones quedan
anotadas en la auditoría, con el usuario y la fecha.

### La lista de chats: archivados y buscador

Dos reglas que se cumplen siempre, también desde el móvil:

- **Un chat archivado que escribe VUELVE.** Si el cliente responde, la conversación sale
  de *Archivados*, entra en la lista principal y **aparece la primera** con su aviso de
  mensaje sin leer. Archivar es «apártamelo de la vista», no «no me avises de esto»: un
  cliente que escribe no puede quedarse escondido.
- **El buscador busca en TODAS.** Escribir un nombre o un teléfono busca en toda la
  bandeja, aunque la conversación esté **archivada**, sea de otra persona o sea de otro
  mes (los filtros de estado y de fecha **no** recortan la búsqueda mientras haya texto).
  Si sale una archivada, la fila lo dice con la etiqueta **Archivado** y su estado se
  puede cambiar con «⋯» → *Desarchivar*. Al borrar el texto, vuelven a mandar los filtros
  que estuvieran puestos: buscar no cambia lo que el usuario había elegido.
- **Finalizar archiva.** «Marcar como finalizado» deja la conversación en *Archivados* y
  la saca de la bandeja, sin borrar nada: el hilo, el historial y el compositor siguen
  disponibles. Reabrirla (o desarchivarla) la devuelve a la bandeja. Si el cliente vuelve
  a escribir, las dos reglas de arriba la traen de vuelta arriba del todo.

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
6. **Cada agente entra en lo suyo, y lo que no es suyo lo PIDE.** Nadie se asigna una
   conversación por su cuenta: se **pide** desde el propio chat bloqueado o desde el menú
   «⋯» de la fila, y administración recibe el aviso con el enlace a esa conversación.
7. **Los seguimientos de un cliente que no llevas no se ven** ni se pueden programar para
   él: eso también es trabajo de quien lo tiene asignado.

### Quién puede ver y contestar cada conversación

| Rol | La lista de chats | El hilo y el compositor | Asignar |
| --- | --- | --- | --- |
| **Administrador** | Toda | Toda | A cualquiera, y liberar |
| **Agente / Operador** | Toda (nombre y último mensaje, como en WhatsApp) | Solo las que lleva él (más las de los pedidos que está repartiendo) | **No**: las **pide** |
| **Repartidor** | Toda | Las de los pedidos que lleva (para avisar de la entrega) | **No**: las **pide** |

Lo que no es tuyo se ve **en la lista**, pero al abrirlo el panel no enseña ni un mensaje:
dice quién la tiene y ofrece **«Solicitar que me la asignen»** (avisa a administración y no
cambia nada por sí solo). La regla la impone el **servidor**, no la pantalla, así que no
se puede saltar desde el navegador. En cuanto administración la asigna, el chat funciona
con normalidad para esa persona.