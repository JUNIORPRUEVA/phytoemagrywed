# Apoyo opcional para corregir mensajes

## Configuración

Entrar como administración en Configuración → API key DeepSeek. Pegar la clave, elegir Flash, definir un límite diario (100 por defecto, entre 1 y 1000), activar las correcciones de apoyo y guardar. Comprobar conexión usa `/models`, sin generar una respuesta de chat. Dejar la clave vacía conserva la guardada; Eliminar clave la elimina y desactiva el apoyo. La configuración es del negocio, no del dispositivo. Usuarios sin `settings.manage` no pueden consultarla ni modificarla.

Después de guardar, la pantalla hace una lectura nueva al servidor y confirma los valores antes de anunciar éxito. El campo real se limpia y su placeholder muestra «•••••••••••••••• · Clave guardada»; el estado aclara que permanece guardada, explica por qué el campo está vacío y muestra si el apoyo está activado. No se devuelve la clave al navegador. Si falla el guardado o la lectura de confirmación, el texto introducido permanece en el campo de contraseña para reintentar, sin persistirlo en el navegador. Guardar preferencias sin ninguna clave no anuncia que se haya guardado una clave.

La pantalla informa de que se envía el borrador a DeepSeek cuando quedan dudas. El chat conserva su presentación habitual, sin mencionar el proveedor, mostrar explicaciones técnicas ni mostrar errores de este apoyo.

## Modelo y consumo

Se permite únicamente `deepseek-flash`, alias oficial de DeepSeek V4.1 Flash y la opción más económica entre los modelos publicados al verificar el 16 de octubre de 2026. No hay escalada a Pro. Se usa `thinking: { type: 'disabled' }`, temperatura 0, respuesta JSON y un máximo de 2048 tokens de salida. Referencias oficiales: [modelos y precios](https://api-docs.deepseek.com/quick_start/pricing/), [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/). Los precios y modelos pueden cambiar; la selección económica es una política explícita del servidor, no una comparación automática en tiempo real.

El motor local se ejecuta primero. Solo las dudas activan una consulta después de otros 900 ms de quietud. El servidor también comprueba con su diccionario real que existan dudas antes de gastar. Solo recibe el borrador completo y el identificador de conversación; el servidor añade el nombre del cliente para conservarlo. No se adjuntan historial del chat, adjuntos, ficha comercial ni la clave en el navegador del agente.

Se deduplican peticiones simultáneas del mismo borrador y se conservan resultados en memoria diez minutos (fallos, 30 segundos); no se persisten borradores. Hay un límite adicional de diez consultas por minuto y usuario. Cada intento al proveedor consume una unidad del límite diario, incluso si falla. El contador diario persiste en settings y se reinicia por fecha de República Dominicana; la caché y el límite por minuto se reinician con el proceso. La reserva del contador se serializa dentro del proceso del CRM; esta implementación presupone una sola instancia de API por base de datos para garantizar el tope diario. No representa un límite monetario de la cuenta de DeepSeek.

## Secretos y validación

La clave se guarda mediante AES-256-GCM, con IV aleatorio y clave derivada por SHA-256 del secreto estable `PHYTO_CRM_TOKEN` con un prefijo exclusivo. Ningún GET devuelve la clave ni sus últimos caracteres. No se guarda en localStorage, sessionStorage, HTML, logs, respuestas de error o snapshots del panel. Al guardar se limpia el campo de contraseña. Los backups de la base contienen solo el secreto cifrado; proteger también el token del servidor. Si se rota ese token, debe volver a introducirse la clave de DeepSeek. No se incorporó ninguna clave real al repositorio.

Las rutas están detrás de sesión y protección de origen/CSRF. Corregir requiere `chats.reply` y acceso efectivo a la conversación. Configurar/probar requiere `settings.manage`. El destino del proveedor está fijado a `https://api.deepseek.com`, sin URL configurable ni riesgo de dirigir la clave a otro host.

El sistema pide cambios mínimos en español dominicano y trata el borrador como datos. Solo acepta una respuesta JSON completa, descarta truncamientos, ampliaciones excesivas, cambios en números/enlaces/correos/menciones, pérdida de nombres conocidos y respuestas claramente ajenas al borrador. Estas validaciones reducen errores; no garantizan preservar todo el significado. El usuario debe revisar y aceptar las propuestas. Nunca se envía una corrección al cliente por el mero hecho de recibirla.

El proveedor tiene un timeout de cuatro segundos y el navegador cancela a los 4,5 segundos o al cambiar el texto/contexto. Se descartan respuestas tardías. La cancelación del navegador no garantiza anular un consumo ya iniciado por el proveedor. Ante fallos, falta de clave, límite alcanzado o resultado inseguro, no se muestra un error en el chat: permanecen únicamente las propuestas locales que existan. La confirmación al enviar sigue funcionando de forma independiente.

## Validación y estado

La revisión inicial pasó 150 pruebas en siete archivos. La mejora de confirmación del guardado pasa 22 pruebas específicas (15 de servicio/API y 7 de formulario), incluida persistencia real al detener y volver a iniciar el servidor con el mismo almacén. La compilación de producción es correcta. El transporte de correcciones DeepSeek se simuló para comprobar necesidad real con diccionario, modelo, caché, deduplicación, cifrado, cuotas, permisos, CSRF, salida inválida y fallos silenciosos.

Se comprobó el estado del servidor local del usuario sin exponer su clave: configured=true, enabled=true y /models respondió connected=true. El formulario actualizado refleja esa clave guardada y el apoyo activado.

También se probó la corrección con la cuenta real desde el chat Prueba Seis. La primera respuesta válida se descartaba por la comparación literal de palabras con tildes. Se corrigió el validador para comparar palabras sin diferencias de acentos y contrastar cercanía ortográfica de la frase cuando haya muchos errores, manteniendo las restricciones de nombres, importes, monedas, enlaces y respuestas ajenas. La regresión incluye la respuesta exacta del proveedor y una frase con varios errores.

Resultados observados en el navegador con el Worker y proveedor reales:

- «buenas, hoas coo esta mi amido?» → «Buenas, ¿cómo está mi amigo?». Usar todo dejó la propuesta en el compositor y mantuvo el foco, sin añadir mensajes al hilo.
- «hoas, el delivery cuesta RD$ 150. grasias por su pediod» → «Hola, el delivery cuesta RD$ 150. Gracias por su pedido.». Se conservó el importe y se dejó la sugerencia visible.

El contador registró cuatro consultas en total durante el diagnóstico y las pruebas reales, incluidas respuestas descartadas; se consume la cuenta de DeepSeek conforme a sus tarifas. No se publicaron claves ni se enviaron mensajes a clientes. Tras el ajuste pasan 102 pruebas específicas en tres archivos y la compilación. Los cambios siguen locales y no se han desplegado.

Vista local directa: http://127.0.0.1:8792/admin/?v=ajustes#config/deepseek.
