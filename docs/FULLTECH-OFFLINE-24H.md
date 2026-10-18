# FullTECH: jornada sin conexión

## Uso

Abrir e iniciar sesión con internet en cada dispositivo. El menú «Datos sin
conexión» permite actualizar la copia, consultar su preparación, sincronizar y
exportar operaciones pendientes. Hay que terminar la descarga antes de salir
sin red. La app instalada puede volver a abrirse con su armazón y datos locales.

El acceso dura 24 horas desde la última comprobación real de la sesión. Una
respuesta de caché no renueva ese plazo. Los cambios pendientes no se borran
al expirar; se retoman después de verificar de nuevo la cuenta con internet.

## Cobertura comprobada

| Área | Sin conexión |
| --- | --- |
| Inicio, pedidos, clientes y conversaciones | Consultar copia descargada; clientes nuevos, pedidos, finalización y archivo de chats con sincronización posterior |
| Catálogo y categorías | Consulta, imágenes, creación y edición local; referencias temporales se sustituyen al sincronizar |
| Inventario y recuento | Consultar y guardar ajustes locales; servidor valida conflictos de stock |
| Facturación | Carrito persistente, ventas, pedidos, descuentos, artículos fuera de inventario y varios tickets |
| Cotizaciones y comprobantes | Consultar documentos descargados; nuevas cotizaciones y comprobantes provisionales imprimibles/guardables como PDF |
| Reportes y cierres | Consultar datos descargados; reportes locales incluyen ventas pendientes |
| Seguimientos, mensajes guardados, configuración, usuarios y perfil | Pantallas descargadas disponibles; cambios de negocio se encolan, las credenciales requieren servidor |
| Reparto | Inicio, puntos GPS y cierre guardados localmente; conserva la hora real de los puntos al sincronizar |
| Mapa | Ubicaciones descargadas y mapas previamente visitados disponibles en caché |

La prueba de navegación abre 18 pantallas. No equivale a probar todas las
combinaciones de formularios ni a una jornada física de 24 horas en Android.

## Límites reales

- WhatsApp, llamadas, compartir ubicaciones por WhatsApp, campañas, IA remota,
  claves y contraseñas requieren conexión. No se confirma un envío inexistente.
- No se descargan calles de todo el país: las teselas no visitadas necesitan
  internet. GPS depende del dispositivo y sus permisos; el seguimiento en vivo
  hacia otros equipos requiere red.
- La copia solo incluye los datos accesibles a la cuenta. Pedidos y reporte
  histórico de preparación tienen límite de 5.000 registros por consulta; los
  historiales y adjuntos tienen los límites existentes de sus respectivos API.
- El navegador puede revocar almacenamiento. Se solicita persistencia; no borrar
  datos del sitio ni usar modo incógnito mientras existan operaciones pendientes.
- Una venta local usa número provisional. Disponibilidad, permisos y número
  definitivo se confirman en el servidor. Si otra caja consumió el stock, la
  operación queda en revisión y no se pierde ni se reintenta indefinidamente.

## Garantías técnicas y validación

IndexedDB separa los datos y diarios por cuenta. El diario se escribe antes de
confirmar el guardado. Web Locks serializa escritura/sincronización entre
pestañas compatibles. El servidor registra claves de operación por actor y
huella del contenido: una respuesta perdida puede recuperarse sin repetir la
operación. Los resultados inciertos quedan para revisión.

Los avisos generales de conexión, cola y actualización dejan de cubrir los
controles. Los errores esenciales permanecen dentro del formulario o en el menú.

Validación inicial: 152 pruebas aprobadas en 13 archivos, incluyendo API real
con PostgreSQL local aislado, UI con JSDOM y service worker en VM. Compilación y
revisión de contenido aprobadas. La prueba móvil física en modo avión sigue
siendo necesaria para comprobar almacenamiento, GPS e impresión del teléfono.

Comprobación final: se conservaron los cambios recientes de `main` en arranque,
chat y diseño de Pedidos. Pasaron 51 pruebas adicionales con PostgreSQL y 30
pruebas de arranque, diario y flujo offline después de los últimos ajustes.
Se probó una respuesta perdida después de escribir en el servidor: al volver a
enviarse no se creó un segundo artículo. La imagen Docker arrancó con PostgreSQL
aislado y devolvió la misma creación al repetir su clave de operación.

La suite completa registró 1.356 aprobadas, 29 fallidas y tres omitidas. De los
fallos, 28 se reprodujeron en `main` sin esta integración (seis archivos de
interfaz/chat/reparto); el restante fue un timeout de Configuración y pasó al
repetirse de forma aislada. No se declara la suite completa aprobada.

## Despliegue verificado — 17/10/2026

- Integración publicada en `main`, código de producción hasta `0525c21`.
- Imagen activa: `easypanel/ventas/phytoemagrywed:offline-0525c21`.
- Service worker `crm-v115-offline-24h`. Se conservan las mejoras de arranque,
  chat y la disposición de Pedidos incorporadas recientemente en `main`.
- Contenedor saludable; `/api/health` responde HTTP 200 con almacenamiento
  PostgreSQL y seis pedidos. Los archivos públicos coinciden con el código
  publicado, normalizando únicamente los saltos de línea de Windows.
- Copia de seguridad PostgreSQL y manifiesto restaurable verificados en
  `/root/backups/fulltech-offline-20261017-122356`. Configuración del servicio e
  imagen anterior conservadas para reversión; no están en Git.
- No se crearon ventas, productos ni mensajes de prueba en producción. La
  repetición de escrituras se probó en bases locales aisladas.
- Pendiente: validación física del teléfono en modo avión después de descargar
  la copia. Las pruebas automatizadas no sustituyen esta comprobación.

---

## Corrección 2026-10-18 — «no se pudo cargar» y pérdida del acceso local

### Causas reales encontradas (medidas, no supuestas)

1. **La copia se guardaba por URL completa.** La descarga anticipada guarda
   `?limit=5000`, un período, sin filtros. Al **buscar, filtrar o cambiar de día**
   la consulta cambia y la copia no aparecía: el panel decía «esta pantalla no
   está guardada» justo al filtrar, aunque el módulo estuviera descargado. De ahí
   el «No se pudo cargar el reporte / el inventario» **intermitente**.
2. **Cualquier 401 cerraba la sesión local.** Un 401 de un módulo (sondeo de
   llamadas, una ruta de administración para un vendedor) ejecutaba `forget()` y
   borraba la identidad de 24 h, la copia y el acceso a la cola.
3. **`showLogin()` borraba la copia.** Ese aviso de acceso también se pinta cuando
   el panel no puede validar la sesión sin red; disparaba `phyto:calling-logout`,
   que `offline.js` escuchaba para borrar todo. Quedarse sin señal un momento
   dejaba al usuario sin datos al volver a entrar.
4. **Descarga inicial demasiado frágil.** 6 s de tope para `/api/admin/data`
   (cientos de KB) y una caminata sin límite por cada cliente, conversación y
   pedido: 2.305 descargas pendientes en la UAT, la copia quedaba a medias.

### Corregido

- `offline.js` y `sw.js`: si falta la respuesta exacta, se sirve **la copia más
  reciente de esa misma ruta** y se marca con `x-fulltech-offline-at` (fecha).
- Solo un 401 de `/api/admin/{session,auth/me,data,login,logout}` cierra la sesión
  local; el resto se devuelve tal cual y queda en el diagnóstico.
- La copia se borra **solo** al pulsar «Cerrar sesión» (`fulltech:offline-logout`).
- Vencimiento con mensaje propio («El acceso sin conexión de 24 horas venció…»),
  sin confundirlo con «no hay copia».
- Descarga: 15 s (con un reintento) para los endpoints grandes; detalle de solo
  los **200 más recientes** por lista (120 conversaciones). Las listas completas
  sí se guardan.
- Diagnóstico de las últimas 40 peticiones (ruta, causa, si había copia) visible
  en «Datos sin conexión», y la hora de la copia en el indicador de presencia.

### UAT real sin internet (Chromium, red cortada)

| Comprobación | Resultado |
| --- | --- |
| Recarga de la PWA sin red | Abre con la copia; 0 mensajes de «no se pudo cargar» |
| Inicio / Clientes / Pedidos / Reportes / Inventario / Mapa | Los seis pintan datos, 0 errores JS |
| Consulta con **filtro/período distinto** (reporte custom, `?q=`, `?refresco=1`) | 200 desde la copia, con fecha |
| Ruta inexistente | 503 con motivo (no se finge) |
| Escritura sin red | Encolada (1), respuesta local, pedido visible como cambiado |
| Vuelve la red | Cola 0 y servidor con el cambio aplicado |
| Repetir la operación (misma clave) | 2 envíos → **1** cambio auditado |
| Autorización vencida (25 h) | Lecturas 503 «venció», escrituras 401, identidad y cola conservadas |

Límites que siguen: WhatsApp y llamadas necesitan red; los NCF/e-CF no se emiten
sin conexión; teselas no visitadas y ruta/ETA necesitan cartografía; la prueba en
teléfono físico en modo avión sigue pendiente.
