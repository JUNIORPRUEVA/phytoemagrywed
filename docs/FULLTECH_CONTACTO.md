# Contacto personalizado FullTECH

Plantilla nueva `fulltech_contacto_personalizado_v2` (es / MARKETING):

> Hola, {{1}}. Te escribimos de FullTECH.
>
> {{2}}
>
> Quedo atento a tu respuesta.

Conserva las plantillas anteriores. El panel y la selección automática del servidor priorizan esta versión solamente cuando esté aprobada y se pueda enviar. La vista previa respeta el cuerpo recibido de Meta sin reemplazar frases por versiones locales.

Registro idempotente: `node scripts/configure-fulltech-contact-template.mjs --env-file=.env --apply`. Sin `--apply` consulta el estado y compara el texto, sin modificarlo. No imprime credenciales. Registrada en la cuenta configurada localmente; última consulta: PENDING, texto coincidente. No hubo envíos reales a clientes ni despliegue del código del panel.

Validación: 30 pruebas aprobadas de `plantilla-contacto.test.js` y `panel-plantilla-contacto-uat.test.js`; compilación `verify:deploy` correcta. La UAT usa la nueva plantilla aprobada simulada y verifica parámetros, vista previa y texto del hilo. La prueba del servidor comprueba que la versión nueva nace pendiente y no puede enviarse antes de aprobarla.
