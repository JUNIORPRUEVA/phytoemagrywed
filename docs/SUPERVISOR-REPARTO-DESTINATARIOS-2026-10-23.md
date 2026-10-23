# Supervisor IA — destinatarios dinámicos de WhatsApp y cierre de la misión

**Fecha:** 2026-10-23 · **Alcance:** resolución automática de destinatarios (repartidor y
administradores) + UAT completo + candidato de despliegue · **Sin commit, sin push, sin deploy**

---

## 1. Lógica de selección del destinatario (repartidor)

Se relee el pedido en **cada pasada**; el responsable sale del `delivery_user_id` **vigente**.

1. `phoneFieldsOf(usuario)` lee la ficha real del usuario y decide:
   - **`fleet_phone` primero** si es normalizable a E.164;
   - **`personal_phone`** como respaldo;
   - si ninguno sirve → `phone: null` (**contacto bloqueado**).
2. El número se normaliza con el mismo `toE164` del CRM (Cloud API exige E.164 sin `+` en el
   payload y con `+` en la ficha: se guarda normalizado y se enmascara en todo lo visible).
3. Tras una **reasignación** se usa el teléfono del nuevo responsable; el anterior no recibe nada
   (probado).
4. Nunca se toma un número de un cliente ni se duplica el envío a flota y personal: **un** destino.
5. Se guarda en el chat y en el evento: `phone_field` (`fleet_phone` / `personal_phone` /
   `external_contact`), `recipient_user_id`, `courier_name` y el destino enmascarado `***1234`.

**Sin teléfono:** el pedido queda en «sin teléfono», se crea/reutiliza la incidencia
(`courier_without_phone`), se mantiene el aviso interno y **no se intenta ningún envío externo**.
La supervisión sigue acotada (máx. 3 avisos, 10 escalados por pasada).

## 2. Lógica de destinatarios de administración (dinámica)

Ya **no** depende de `deliveryAdminEscalationContacts`. En el momento del escalado:

1. Se consulta el directorio **actual** de usuarios.
2. Se seleccionan **todas** las cuentas con rol `ADMIN` y `active !== false`.
3. Teléfono por ficha: **flota primero**, personal como respaldo.
4. Se excluyen inválidos/ausentes y se **deduplica por destino normalizado**.
5. Se envía la plantilla `phyto_delivery_sin_atender_admin_v1` a **cada destino único** (máx. 20
   como freno anti-ráfaga).
6. **Todos** los ADMIN activos reciben aviso interno, tengan o no teléfono.
7. Cada destino queda con su resultado real y con **la lista de administradores que cubre**.
8. Los contactos de `delivery_control` solo actúan como **respaldo heredado** si ningún
   administrador tiene número.

Si **ningún** administrador tiene número: el escalado queda `blocked_no_destination`, se explica en
el chat, se registra el motivo y se **reevalúa cada 15 minutos** (sin bucle). Si hay fallos
**transitorios** del proveedor, el escalado queda `retry_pending` y se reintenta (máx. 3 intentos por
destino) sin repetir los que ya salieron.

## 3. Destinatarios, deduplicación y autorización

- **Repartidor:** 1 destino (flota → personal). Sin número = bloqueado.
- **Administración:** N destinos únicos; N ≤ nº de ADMIN activos con teléfono; tope de seguridad 20.
- **Deduplicación:** dos administradores con el mismo número → **un** WhatsApp, **dos** avisos
  internos y constancia de que el destino es compartido.
- **Autorización:** solo `ADMIN` activos entran en el escalado; un `AGENT` o un `ADMIN` inactivo con
  teléfono **no** recibe nada (probado). El repartidor debe ser el usuario asignado en el pedido.

## 4. Calendario exacto implementado

| Momento | Acción | Clave de idempotencia |
| --- | --- | --- |
| T+0 | aviso interno al repartidor, **sin WhatsApp** | `supervisor-reminder:{pedido}:{etapa}:{intento}` |
| T+5 | primer WhatsApp (pedido + enlace de aceptación) — `acceptFirstMinutes: 5` | igual, intento 1 |
| T+20 | recordatorio corto | igual, intento 2 |
| T+30 | escalado a administración (`acceptEscalateMinutes: 30`) | `supervisor-escalation:{pedido}:{etapa}:{motivo}` |
| — | por destino | `…escalation_wa:{pedido}:{etapa}:{motivo}:{destino}[:rN]` |

Antes de cada acción: se relee el pedido, se comprueba versión de asignación, aceptación
autoritativa, estados terminales y elegibilidad del destinatario. Aceptar (acción autenticada) corta
los avisos de aceptación; la supervisión de avance continúa. Un «ok» por WhatsApp **no** es
aceptación.

## 5. Plantillas validadas (Meta, solo lectura)

| Plantilla | Estado | Idioma/categoría | Params | Uso |
| --- | --- | --- | --- | --- |
| `phyto_pedido_repartidor_v1` | APPROVED | es / UTILITY | 8 | T+5 (flota → personal) |
| `phyto_supervisor_recordatorio_v1` | APPROVED | es / UTILITY | 3 | T+20 y respaldo |
| `phyto_delivery_sin_atender_admin_v1` | APPROVED | es / UTILITY | 3 | T+30, por destino único |

Estados persistidos sin confundirse: `sent` (aceptado por Meta), `delivered`/`read` (acuse del
webhook, ahora también en el chat), `failed`, `retryable`, `pending` (plantilla/configuración),
`duplicate`, `blocked`.

## 6. Centro IA → Chats

Cada pedido supervisado muestra: cliente, número, repartidor actual, agente, estado, historial de
WhatsApp con **estado real por mensaje**, avisos internos, escalados **por destinatario**
(`***8801 (flota) [Ana] → sent | ***8802 (flota) [Luis] → sent`), administradores sin teléfono,
respuestas humanas y la siguiente acción. El acuse del proveedor (`delivered`/`read`) actualiza el
mensaje del chat (`reconcileDeliveryReceipt`).

## 7. Falta de teléfono

Incidencia + aviso interno + `blocked_no_destination` cuando corresponda + reevaluación controlada.
**Nunca** se inventan números ni se crea un usuario ficticio.

## 8. Evidencia en navegador real

`docs/capturas/destinatarios-01-escritorio-escalado.png` (1440×900) y
`docs/capturas/destinatarios-02-movil-escalado.png` (390×844): escalado con dos destinos enviados y
un administrador sin teléfono, con hora de RD (`09:37 a. m.` para 13:37 UTC).

## 9. Pruebas automatizadas

```
14 archivos · 172 pruebas · 172 en verde
```

Nuevas: `tests/supervisor-recipients-uat.test.js` (9) — flota/personal/inválido/sin número,
reasignación, aceptación previa, multi-admin con deduplicación, ADMIN sin teléfono, inactivo y
AGENT excluidos, bloqueo sin destino, fallo transitorio con reintento selectivo, acuse del
proveedor, cancelación y concurrencia. Actualizadas: `delivery-supervisor.test.js` (tope de 4 →
todos los destinos) y `supervisor-reparto-integral-uat.test.js` (reevaluación sin duplicar avisos).

**Suite general:** sigue con los fallos preexistentes ajenos (jsdom de tienda/avisos); el candidato
no añade ninguno y elimina los del trabajo de tienda en curso (99 → 94 en la comparación anterior).

## 10. Manifiesto del candidato

Base `8a6bcec` + parche. Archivos modificados:

```
server/delivery-supervisor.mjs      resolución dinámica, flota primero, escalado multi-admin, reevaluación
server/crm-server.mjs               acuse del proveedor al chat del pedido
server/ops/delivery-tickets.mjs     meta de auditoría (campo de teléfono, destinatario) + reconciliación
server/whatsapp.mjs                 falso OPT_OUT corregido
public/admin/ops.js                 hora de RD, «Ir a Pedidos», nota interna explícita
public/admin/index.html, sw.js      versiones (ops-14)
tests/*                             9 nuevas + 4 actualizadas
docs/*                              informes de verificación, auditoría y este
```

## 11. Despliegue y rollback

- Imagen verificada: `phytoemagrywed:candidato-8a6bcec-recipients-20261022` =
  `sha256:a08768781e64d4921cb2f2a507c11eb423d27edd9203e22d2692381cfeafcc57`
  (amd64, 532 MB, build **exit 0**, puerta `verify:deploy` superada).
- Dentro del artefacto: `phoneFieldsOf` ×5, `escalationTargets` ×4, deduplicación ×1,
  `reconcileDeliveryReceipt` ×2, `acceptFirstMinutes` ×7, flota primero en línea 430.
- Rollback: desplegar **por digest**; la imagen anterior conocida es `:consolidado-45fbed5`
  (`sha256:fe872f7c…`). `:latest` sin digest **no** permite rollback real.

## 12. Bloqueos operativos que quedan (datos, no código)

1. **Autorización para commitear** (sin commit no hay SHA de origen ni imagen de producción).
2. **Teléfonos de administración**: en producción solo 3 cuentas tienen número (todas terminan en
   7826) y una ADMIN y la cuenta de reparto de prueba **no tienen**. Acción: que un administrador
   autorizado complete las fichas.
3. **Pedidos con `delivery_user_id` inexistente** (2): el motor los trata como «sin teléfono» y
   escala; **no se reparan** datos históricos.
4. **Rol `DELIVERY` inexistente**: los repartidores reales son `AGENT` con teléfono; el motor
   funciona igual (usa el usuario asignado), pero conviene ordenarlo.
5. Observabilidad: `docker logs` del contenedor no devuelve salida → usar el visor de EasyPanel.

## 13. GO / NO-GO

- **UAT: GO.** 172/172 en verde sobre el candidato aislado, imagen construida y navegador real con
  deduplicación, flota primero, falta de teléfono y hora de RD.
- **Producción: NO-GO** hasta que se autorice el commit y se completen los teléfonos de
  administración/reparto. Con eso hecho, el despliegue es **GO** por digest, con smoke tests y
  vigilancia del primer pedido real.

**No se ha commiteado, empujado, desplegado, reiniciado producción ni enviado ningún WhatsApp real.**
