# Compositor del chat

Micrófono con el campo vacío y envío cuando contiene texto, compartiendo una única posición circular de 48 px fuera del campo redondeado. Se mantiene la identidad azul de FullTECH y el contraste de sus temas. Vaciar el campo restaura el micrófono sin cambiar el nodo de escritura ni mover el campo. Los espacios solos se consideran vacíos. La ventana cerrada conserva el envío por plantilla y no ofrece grabación que WhatsApp no admitiría.

Iconos aportados por el usuario adaptados a PNG transparente de 96 × 96 px: 1.591 bytes (micrófono) y 1.331 bytes (enviar), frente a 16.839 bytes originales. Reducción del 82,6 %. Máscaras CSS decorativas; las etiquetas accesibles permanecen en los botones. Recursos precargados por `crm-v110-chat-composer`.

El botón de envío mantiene su icono y marca aria-busy durante la petición, evitando que se borre al terminar. Las pruebas comprueban micrófono → enviar → micrófono y un segundo borrador después de enviar. Se mantiene grabar → detener → previsualizar → enviar, sin envíos automáticos.

Validación: pruebas de multimedia, plantillas, corrector, shell, arranque, privacidad/push y POS. Se actualizó una aserción antigua de multimedia que esperaba el formulario de pedido anterior: ahora verifica el traslado al POS con el cliente y conversación correctos; el flujo del POS se prueba por separado. Compilación correcta.
