# Supervisor IA de reparto — calendario exacto de aceptación y chats centralizados

**Informe de cierre de la misión** (2026-10-22). Nada de este trabajo se ha
commiteado, empujado ni desplegado. No se ha enviado ningún WhatsApp real: todas
las pruebas usan un WhatsApp simulado y un reloj controlado.

---

## 1. Qué se pedía y qué se entrega

Se pedía un supervisor que, para cada pedido asignado a un repartidor interno:

1. le avisara **internamente** al asignar;
2. esperara **cinco minutos** la aceptación;
3. enviara un **WhatsApp aprobado** con los datos del pedido y un **enlace seguro** para aceptar;
4. mandara un **recordatorio más corto en el minuto veinte**;
5. **escalara a administración en el minuto treinta** si sigue sin aceptar;
6. y dejara **todas** esas comunicaciones registradas en **Centro IA → Chats**, bajo el pedido y la identidad correctos.

Todo eso está implementado y demostrado con pruebas automáticas de reloj falso,
WhatsApp simulado, reinicio, concurrencia y panel real en jsdom.

---

## 2. Antes y después

| Aspecto | Antes | Ahora |
|---|---|---|
| Calendario | política antigua (10 min / 120 min) y motor heredado enviando a la vez | **T+5 / T+20 / T+30** con un solo motor |
| Aceptación | se deducía del texto del WhatsApp | **acción autenticada** `POST /delivery/accept` (idempotente y auditada) |
| Primer aviso | recordatorio corto, sin datos del pedido | plantilla de reparto con **pedido, cobro, dirección, mapa e instrucciones + enlace** |
| Enlace para aceptar | no existía | `/admin/?v=delivery&order=<id>` (sin tokens ni datos) |
| Registro | eventos internos sueltos | **chat del pedido** con cada WhatsApp, su estado real y las respuestas |
| Respuesta del repartidor | se procesaba pero **no se guardaba** en el chat (`store is not defined`) | se guarda con su texto y su identidad |
| Pantalla | no existía | **Centro IA → Chats**: lista por pedido + conversación con estados de WhatsApp |
| Motor heredado | corría en paralelo (doble mensaje posible) | **se detiene** cuando el supervisor está activo |

---

## 3. Matriz de tiempos (una sola asignación vigente)

| Momento | Qué pasa | Quién lo ve | Idempotencia |
|---|---|---|---|
| **T+0** | se abre el ticket del pedido y se avisa **internamente** (campana/push). **Ningún WhatsApp.** | repartidor asignado | una vez por asignación |
| **T+5** | WhatsApp aprobado con los datos del pedido **y el enlace para aceptar** | repartidor | clave de reclamo por pedido+etapa+intento |
| **T+20** | recordatorio **corto**: no repite productos ni dirección | repartidor | clave de reclamo por intento |
| **T+30** | **escalado a administración** (aviso interno + WhatsApp al contacto autorizado) | administración | una vez (marca en el estado) |
| al aceptar | la etapa pasa a «iniciar entrega» y **se detienen** los avisos de aceptación | — | `delivery_accepted_at` |
| T+90 / T+120 | atrasado / escalado por falta de entrega (política general) | supervisor | igual |

Fuera de la ventana **08:00–20:00 (America/Santo_Domingo)** no se envía: se
pospone. Los mensajes ya reclamados no se repiten tras un reinicio.

---

## 4. Plantillas y estado de aprobación

| Plantilla | Uso | Parámetros |
|---|---|---|
| `phyto_pedido_repartidor_v1` | primer contacto completo (pedido + enlace en las instrucciones) | 8 |
| `phyto_supervisor_recordatorio_v1` | recordatorio corto (T+20) y respaldo del primer contacto | 3 |
| `phyto_delivery_sin_atender_admin_v1` | escalado a administración | — |

Si la plantilla **no** está aprobada, el motor **no inventa**: cae al
recordatorio corto y, si tampoco, a texto libre con el mismo enlace; y el intento
queda registrado con su motivo real (`template_not_approved`, `failed`, …).

---

## 5. Diseño del enlace de aceptación

- Formato: `https://<host>/admin/?v=delivery&order=<id>` (absoluto, para el teléfono).
- **No** lleva tokens, teléfonos ni datos del cliente.
- **Abrirlo no acepta nada**: la aceptación exige sesión autenticada del
  repartidor asignado (o permiso `delivery.tracking.manage_all`) y una acción
  explícita; queda auditada como `delivery.accepted`.
- Un «ok» escrito por WhatsApp **nunca** cuenta como aceptación.

---

## 6. Separación interno / externo

Cada comunicación se guarda con su canal y dirección:

- `channel: whatsapp|template|text`, `direction: outbound` + `status: sent|delivered|read|failed|pending` → **salió de verdad**.
- `direction: inbound` → **lo escribió el repartidor**.
- `direction: system` (escalados, posposiciones) → **hecho del sistema**.
- Notas del equipo/IA sin canal externo → **«Nota interna · no se envió»**.

La pantalla nunca presenta una nota interna como mensaje enviado.

---

## 7. Centro IA → Chats (pantalla nueva)

- Tercer segmento del armazón: **Agentes · Chats · Actividad y tickets**.
- **Lista** (`GET /api/admin/ops/chats`): número de pedido, cliente, repartidor,
  agente IA, estado del ticket, última actividad (hora de RD), vista previa,
  bloqueo, aceptado/sin aceptar y contador de no leídos.
- **Detalle** (`GET /api/admin/ops/tickets/:id`): cabecera con pedido, cliente,
  repartidor, agente y botón «Abrir pedido»; burbujas con chip de **WhatsApp +
  estado real**, «Recibido» para las respuestas, «Sistema» para los hechos y
  «Nota interna · no se envió» para lo que no salió; el error se muestra cuando
  un envío falla.
- Móvil primero: en pantalla pequeña la lista y la conversación se alternan; en
  escritorio van lado a lado. Claro y oscuro.
- Versiones subidas: `ops.css?v=ops-12`, `ops.js?v=ops-12`, `sw.js`
  `crm-v270-centro-chats-supervisor-20261022`.

---

## 8. Correlación de la respuesta del repartidor

El webhook entra firmado, el supervisor reconoce al remitente por su teléfono y
su pedido vigente, y **la respuesta se guarda en el chat del pedido** con su
texto real y `Repartidor (+teléfono)`. Si el mensaje es ambiguo, se guarda igual
pero **no cambia** el estado de la entrega. Fallo encontrado y corregido en esta
fase: el registro usaba una variable inexistente (`store`) y la respuesta se
perdía en silencio.

**Hallazgo corregido el 2026-10-22:** el clasificador de la conversación de cliente marcaba
«Voy para allá» de un repartidor como `OPT_OUT` (la regla `\bparar?\b` casaba con la preposición
«para») y lo dejaba como «no contactar». Ya está arreglado y con pruebas; ver
`docs/SUPERVISOR-REPARTO-VERIFICACION-2026-10-22.md` §1.

---

## 9. Qué pasa cuando falta información

- **Sin teléfono** del repartidor: no se inventa un número; el pedido aparece en
  «Sin teléfono», el chat lo indica y el intento queda como `pending`/
  `failed_phone` con su motivo.
- **Sin plantilla aprobada**: respaldo corto y después texto libre, siempre con
  el enlace; el motivo real se registra.
- **Pedido cerrado o con incidencia**: la aceptación responde `409` y **no**
  reabre nada.
- **Asignación fuera de horario**: se pospone, no se pierde.

---

## 10. Idempotencia y reinicio

- Cada envío se reclama antes de salir (clave por pedido + etapa + intento): un
  segundo tick, dos procesos o un reinicio **no duplican**.
- Evidencia: `tests/supervisor-calendario-aceptacion-uat.test.js` (tick repetido,
  T+30 una sola vez) y `tests/supervisor-autonomia.test.js` (reinicio).

## 11. Concurrencia

- Dos pasadas simultáneas no envían dos veces el mismo aviso (reclamo atómico).
- Aceptación idempotente: repetirla no cambia nada y no reabre avisos.

---

## 12. Zona horaria y horario

- Todo se calcula en `America/Santo_Domingo`; las horas del chat y de la lista se
  muestran en hora local de RD.
- Ventana de envío 08:00–20:00; fuera de ella, posposición (probado en
  `tests/supervisor-autonomia.test.js`).

---

## 13. Archivos modificados

| Archivo | Cambio |
|---|---|
| `server/delivery-supervisor.mjs` | política 5/20/30, etapa `not_accepted`, contacto completo con enlace, respaldo en texto libre, ancla por etapa |
| `server/ops/delivery-tickets.mjs` | títulos/prioridad de `not_accepted`, `recordExternalMessage` con canal y estado |
| `server/crm-server.mjs` | puente con `sendCourierFirstContact`; **respuesta entrante corregida** (`ctx.store`); motor heredado detenido si el supervisor está activo; `409 order_cancelled` |
| `server/ops/routes.mjs` | `GET /api/admin/ops/chats` (+`tz`) |
| `public/admin/ops.js` | segmento y pantalla **Chats** (lista + conversación con estados) |
| `public/admin/ops.css` | estilos de chats, chips de WhatsApp y adaptación móvil/oscuro |
| `public/admin/index.html`, `public/admin/sw.js` | versiones |
| `tests/…` | calendario (nuevo), chats de panel (nuevo), y ajustes de las suites que fijaban la política antigua |

---

## 14. Pruebas ejecutadas

```
npx vitest run --no-file-parallelism \
  tests/delivery-supervisor.test.js \
  tests/supervisor-autonomia.test.js \
  tests/delivery-supervisor-routes.test.js \
  tests/delivery-supervisor-validation.test.js \
  tests/supervisor-reparto-integral-uat.test.js \
  tests/supervisor-calendario-aceptacion-uat.test.js \
  tests/supervisor-deepseek.test.js \
  tests/ops-centro-ia.test.js \
  tests/panel-centro-ia-uat.test.js \
  tests/panel-centro-ia-chats-uat.test.js \
  tests/delivery-assignment-notifications.test.js
→ 158 pruebas en verde (11 archivos)
```

Cobertura de la misión: T+0 sin WhatsApp, T+5 con pedido y enlace, no duplicado,
T+20 corto, T+30 escalado una vez, aceptación detiene los avisos, respuesta del
repartidor en el chat, lista y detalle de Chats en el panel real (jsdom), reinicio
y concurrencia.

## 15. Capturas

No se han generado capturas de navegador en esta fase. La verificación en **Chromium real**, con
capturas de escritorio, móvil y tema oscuro, está en
`docs/SUPERVISOR-REPARTO-VERIFICACION-2026-10-22.md` (y en `docs/capturas/chats-0*.png`).

---

## 16. Requisitos para desplegar

1. Plantillas aprobadas en Meta: `phyto_pedido_repartidor_v1`,
   `phyto_supervisor_recordatorio_v1`, `phyto_delivery_sin_atender_admin_v1`.
2. `META_APP_SECRET` configurado (sin él el webhook entra **sin firma comprobada**,
   como avisa el log).
3. Contacto de administración con teléfono para el escalado.
4. Repartidores con teléfono personal guardado.
5. Reloj y zona del servidor correctos (`America/Santo_Domingo`).

## GO / NO-GO

- **UAT: GO.** El calendario 5/20/30, el enlace, la separación interno/externo,
  el escalado con destinatario configurado, el repartidor sin teléfono y los chats
  están demostrados con WhatsApp simulado, reloj falso y **Chromium real**.
- **Producción: GO condicionado** (actualizado el 2026-10-22). Las tres plantillas
  están **APPROVED** en Meta y `META_APP_SECRET` está presente y verificado. Falta:
  decidir el contacto de administración del escalado, cargar el teléfono de los
  repartidores activos, desplegar con autorización explícita y vigilar el primer
  pedido real de punta a punta. Detalle en
  `docs/SUPERVISOR-REPARTO-VERIFICACION-2026-10-22.md`.

**No se ha commiteado, empujado ni desplegado nada.**
