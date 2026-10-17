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
