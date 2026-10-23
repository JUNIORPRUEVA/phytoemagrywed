# Supervisor IA de reparto — verificación final y UAT en navegador real

**Fecha:** 2026-10-22 · **Alcance:** corrección del falso `OPT_OUT`, aislamiento de mensajes,
UAT en Chromium real de **Centro IA → Chats**, auditoría de plantillas, `META_APP_SECRET`,
destinatario del escalado y falta de teléfono.

**Seguridad:** todo se hizo en local. **No** se envió ningún WhatsApp real (el envío va
simulado), **no** se modificó producción, **no** se desplegó, **no** se hizo commit ni push.
La única llamada externa fue un **GET de solo lectura** a Meta para leer el estado de las
plantillas (no crea, no modifica y no envía nada).

---

## 1. Falso `OPT_OUT` en respuestas operativas del repartidor — corregido

**Qué pasaba.** `detectOptOut()` (en `server/whatsapp.mjs`) usaba `/\bparar?\b/`. Ese patrón
casaba con la **preposición** «para» de cualquier frase: «Voy para allá» marcaba al remitente
como **«no contactar»**, pausaba su conversación y cancelaba seguimientos. Medido en la UAT del
supervisor: el repartidor quedaba bloqueado tras contestar.

**Qué se hizo.** El imperativo se detecta ahora por su forma exacta, y `parar` se mantiene:

| Se detecta como baja | No se detecta |
| --- | --- |
| `STOP`, `para`, `parar`, `para ya`, `ya para` | `Voy para allá`, `Voy para el negocio` |
| `para de escribirme`, `dejen de escribirme` | `Salgo para la entrega ahora` |
| `no me escribas más`, `no quiero recibir más` | `Ya voy para tu casa` |
| `quiten mi número`, `unsubscribe`, `baja de mensajes` | `Estoy para llegar en 10 minutos` |

**Protección del cliente intacta (no debilitada).** Se añadieron pruebas con las fórmulas de baja
reales y una prueba final de extremo a extremo: un cliente que escribe «No me escribas más,
gracias» sigue quedando `do_not_contact = true` y con `whatsapp_opt_out_at` puesto.

Evidencia: `tests/whatsapp-webhook.test.js` (13 pruebas) y
`tests/supervisor-aislamiento-uat.test.js` (5 pruebas).

---

## 2. Aislamiento de mensajes — verificado

| Qué se comprobó | Resultado |
| --- | --- |
| Respuesta del repartidor → **chat del pedido** | entra como `inbound`, con su texto y `Repartidor (+teléfono)` |
| La misma respuesta **no** marca «no contactar» | `do_not_contact` falso, `whatsapp_opt_out_at` nulo, `automation_state` intacto |
| Mensaje de un **cliente** | va a su conversación de WhatsApp y **no** aparece en el chat operativo |
| Escalado del **sistema/IA** | vive solo en el chat operativo; **no** se copia a la conversación del cliente |
| Baja real de un cliente | sigue cortando el contacto |
| Duplicados | una respuesta = un registro (se comprobó y se corrigió una prueba que enviaba dos veces) |

**Hallazgo menor (no corregido, fuera de alcance):** como todo entrante de WhatsApp pasa por el
embudo de clientes, el **repartidor aparece también como «cliente»** en la bandeja de Chats de
WhatsApp. No mezcla mensajes (lo anterior está demostrado), pero convendría marcarlo como
contacto operativo y no comercial en una tarea aparte.

---

## 3. UAT en Chromium real — Centro IA → Chats

Servidor local aislado (`data/uat/chats-demo.mjs`): base propia, reloj controlado, WhatsApp
simulado y credenciales de Meta **vacías en el proceso** (se comprobó que el log dice «webhook
sin firma comprobada» y que los envíos salen por el mock).

| Comprobación manual | Resultado |
| --- | --- |
| Menú → Centro IA → **Chats** | lista con pedido, cliente · repartidor, vista previa, chips y no leídos |
| Abrir el chat | cabecera con pedido, cliente, repartidor y botón de acción |
| Estado del mensaje enviado | chip **WhatsApp · Enviado** (verde) |
| Respuesta del repartidor | chip **Recibido**, burbuja entrante con su teléfono |
| Nota del equipo | chip **Nota interna · no se envió** (nunca se presenta como enviada) |
| Datos del pedido | número, cliente y teléfono, productos, importe `DOP 2750.00`, dirección, mapa, instrucciones y enlace de aceptación |
| Hora de República Dominicana | mensaje guardado a las **23:12 UTC** se muestra **07:12 p. m.** ✓ |
| Escritorio 1440×900 | lista y conversación lado a lado |
| Móvil 390×844 | lista y conversación se alternan; se vuelve con la flecha |
| Tema oscuro | chips y burbujas legibles, sin perder el verde de WhatsApp |
| Enlace del pedido | `/admin/?v=delivery&order=…`, sin tokens ni datos; «Ir a Pedidos» lleva a la pantalla de administración |

**Corrección derivada de la UAT (hora):** el panel formateaba con la zona del *dispositivo*. Un
teléfono en Madrid habría visto las 01:12 de un aviso de las 19:12 en Santiago. Ahora todos los
formatos del Centro IA usan `America/Santo_Domingo`, igual que el «Hoy/Ayer».

**Corrección derivada de la UAT (enlace):** `?v=delivery&order=…` es el enlace **del
repartidor**; a administración le decía «No tienes entregas asignadas». En Chats, quien puede
administrar ve **«Ir a Pedidos»**, que abre la pantalla donde realmente trabaja. El enlace del
repartidor no se toca (es el que se envía por WhatsApp).

**Capturas** (en `docs/capturas/`): `chats-01-escritorio-lista.png`,
`chats-02-escritorio-detalle.png`, `chats-03-escritorio-oscuro.png`,
`chats-04-movil-lista.png`, `chats-05-movil-detalle.png`.

---

## 4. Plantillas — auditadas contra Meta (solo lectura)

| Momento | Plantilla | Estado en Meta | Idioma / categoría | Parámetros |
| --- | --- | --- | --- | --- |
| T+5 | `phyto_pedido_repartidor_v1` | **APPROVED** | `es` / UTILITY | **8** |
| T+20 | `phyto_supervisor_recordatorio_v1` | **APPROVED** | `es` / UTILITY | **3** |
| T+30 | `phyto_delivery_sin_atender_admin_v1` | **APPROVED** | `es` / UTILITY | **3** |

`rejected_reason: NONE` en las tres. Las tres existen en la WABA con esos nombres (no hay
duplicados) y el número está conectado.

**Mapeo exacto de variables (código ↔ plantilla):**

| # | `phyto_pedido_repartidor_v1` (T+5) | Origen en el código |
| --- | --- | --- |
| 1 | nombre del repartidor | `contact.name` |
| 2 | número de pedido | `order.order_number` |
| 3 | cliente y teléfono | `customer.name · customer.phone_e164` |
| 4 | productos | `productsSummary(order)` |
| 5 | importe a cobrar | `DOP <total>` (o «No aplica») |
| 6 | dirección | dirección de entrega (+ nombre del destino) |
| 7 | mapa | enlace de Google Maps con las coordenadas |
| 8 | instrucciones | notas del pedido o «Sin instrucciones adicionales», **con el enlace de aceptación añadido al final** |

| # | `phyto_supervisor_recordatorio_v1` (T+20 y respaldo) | Origen |
| --- | --- | --- |
| 1 | nombre del repartidor | `state.responsible.name` |
| 2 | número de pedido | `order.order_number` |
| 3 | siguiente paso | `state.nextAction` (+ enlace solo cuando es el respaldo del primer contacto) |

| # | `phyto_delivery_sin_atender_admin_v1` (T+30) | Origen |
| --- | --- | --- |
| 1 | pedido | `order.order_number` |
| 2 | delivery | `state.responsible.name` |
| 3 | panel del pedido | enlace absoluto `/admin/?v=delivery&order=…` |

Los botones de respuesta rápida de la plantilla del repartidor (`Iniciar entrega`, `Entregado`,
`Reportar problema`) no son componentes que el CRM tenga que enviar: por eso el envío solo lleva
el `BODY`. Es correcto.

**Limitación conocida:** el texto libre dentro del parámetro 8 (enlace añadido) depende de que Meta
respete el límite de 300 caracteres del parámetro; el CRM lo recorta, así que el enlace nunca se
parte por el medio del identificador.

---

## 5. `META_APP_SECRET` — verificado sin revelar credenciales

| Comprobación | Resultado |
| --- | --- |
| `META_APP_SECRET` en `.env` | **presente** (32 caracteres, longitud de un secreto de app de Meta) |
| `WHATSAPP_ACCESS_TOKEN` | presente |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_VERIFY_TOKEN` | presentes |
| ¿Se exige firma en el webhook? | **sí**: con el secreto cargado, un POST con firma falsa responde `401 invalid_signature` |
| ¿Se envía algún secreto al cliente? | no: el panel nunca recibe el secreto |

No se ha impreso ni copiado ningún valor.

---

## 6. Destinatario del escalado y falta de teléfono

**Destinatario.** El escalado se envía a los contactos configurados en
`delivery_control.deliveryAdminEscalationContacts` (máximo 4, sin duplicados, normalizados a
E.164) y, además, deja aviso interno a las cuentas ADMIN:

- WhatsApp a `+1809…9999` con `phyto_delivery_sin_atender_admin_v1` y **3 parámetros** en orden
  (pedido, delivery, enlace al panel del pedido) — comprobado con envío simulado;
- notificación `DELIVERY_SUPERVISOR_ESCALATION` a administración (campana);
- nota **de sistema** en el chat del pedido: «Escalado a administración (tiempo vencido sin
  resolver) · …», ahora con el **motivo en palabras**.

**Falta de teléfono.** Si el repartidor asignado no tiene teléfono guardado:

- **no se inventa ningún número** y no se envía nada al repartidor;
- se escala **una sola vez** con motivo `courier_without_phone` → «sin teléfono del repartidor»;
- el pedido aparece en `without_phone` del estado del supervisor y con `has_phone: false`;
- el motivo real queda en el evento y en el chat.

Evidencia: `tests/supervisor-escalado-destinatario-uat.test.js` (2 pruebas).

**Corrección encontrada al probar esto (importante):** al guardar la política antigua
(`delivery_control.delivery_reminder_minutes = 10`), el supervisor **adoptaba los 10 minutos** y el
T+5 se convertía en T+10, rompiendo el calendario acordado. Ahora el calendario de **aceptación**
tiene su propio plazo (`acceptFirstMinutes = 5`), independiente de la política heredada, y el
importador del motor retirado ya **no** copia ese plazo. El plazo general de las demás etapas sigue
configurable.

---

## 7. Pruebas ejecutadas

```
npx vitest run --no-file-parallelism \
  tests/delivery-supervisor.test.js \
  tests/supervisor-autonomia.test.js \
  tests/delivery-supervisor-routes.test.js \
  tests/delivery-supervisor-validation.test.js \
  tests/supervisor-reparto-integral-uat.test.js \
  tests/supervisor-calendario-aceptacion-uat.test.js \
  tests/supervisor-aislamiento-uat.test.js \
  tests/supervisor-escalado-destinatario-uat.test.js \
  tests/supervisor-deepseek.test.js \
  tests/ops-centro-ia.test.js \
  tests/panel-centro-ia-uat.test.js \
  tests/panel-centro-ia-chats-uat.test.js \
  tests/delivery-assignment-notifications.test.js \
  tests/whatsapp-webhook.test.js \
  tests/delivery-tracking.test.js \
  tests/delivery-unified-flow-uat.test.js \
  tests/delivery-courier.test.js
→ 240 pruebas en verde (17 archivos)
```

Nuevas en esta fase: `supervisor-aislamiento-uat.test.js` (5) y
`supervisor-escalado-destinatario-uat.test.js` (2). Ampliada: `whatsapp-webhook.test.js`.

---

## 8. Bloqueos de producción que quedan

| # | Bloqueo | Estado |
| --- | --- | --- |
| 1 | Plantillas aprobadas en Meta | **resuelto** (las tres `APPROVED`) |
| 2 | `META_APP_SECRET` | **resuelto** (presente y verificado) |
| 3 | Contacto de administración para el escalado | **pendiente de decidir** quién lo recibe y con qué número (el motor ya lo usa sin inventar nada) |
| 4 | Repartidores con teléfono guardado | **pendiente de dato**: sin teléfono no se les puede escribir (se escala con ese motivo) |
| 5 | Prueba con un pedido real de punta a punta | **pendiente** y requiere autorización explícita de producción |
| 6 | El repartidor aparece como «cliente» en la bandeja | **mejora futura**, no bloquea |

## 9. GO / NO-GO

- **UAT (local): GO.** Calendario T+0/5/20/30, enlace de aceptación, escalado con destinatario
  real configurado, falta de teléfono, aislamiento de mensajes, falso `OPT_OUT` corregido, hora de
  RD y pantalla de Chats verificados con WhatsApp simulado y Chromium real. 240 pruebas en verde.
- **Producción: GO condicionado.** El código y las plantillas ya cumplen; antes de publicar hay que
  (a) **decidir el contacto de administración** del escalado, (b) **cargar el teléfono** de los
  repartidores activos, (c) desplegar **con autorización explícita** y (d) observar el **primer
  pedido real** de punta a punta (aceptación, T+20 y escalado) antes de darlo por operativo.

**No se ha commiteado, empujado ni desplegado nada.**

---

### Anexo — cómo repetir la demo local

```
node data/uat/chats-demo.mjs
→ http://127.0.0.1:8899/admin/   ·   demo@uat.local / DemoChats-12345
```

Base propia en `data/uat/chats-demo.sqlite`, WhatsApp simulado y credenciales de Meta vaciadas
en el proceso: nada sale a internet.
