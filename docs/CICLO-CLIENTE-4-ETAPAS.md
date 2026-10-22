# Ciclo de vida del cliente en 4 etapas (2026-10-22)

**Alcance:** implementación local + UAT aislada. **Sin deploy, sin push, sin commit.** No se ha tocado
producción, ni se ha reescrito ningún pedido, ni se ha borrado ninguna etiqueta histórica.

---

## 1. Lo que había (auditoría)

Convivían **cinco** clasificaciones distintas y la pantalla las mezclaba:

| Sistema | Valores | Cómo se calculaba |
| --- | --- | --- |
| `customer_stage` | PROSPECT · INTERESTED · CUSTOMER · INACTIVE | `resolveCustomerStage()`: CUSTOMER si había 1 pedido `entregado`; INTERESTED e INACTIVE **solo a mano** |
| `commercial_state` | NUEVO → … → RECOMPRA (+ INTERESADO/PERDIDO manuales) | `deriveCommercialState()` con pedidos, seguimientos y mensajes |
| `automation_state` | AUTOMATIC · HUMAN_REQUIRED · HUMAN_ACTIVE · PAUSED · CLOSED | webhooks (pide persona, salud, opt-out) |
| Conversación | AUTOMATIC/HUMAN_REQUIRED, pendiente, finalizada, archivada, asignada | mensajes y acciones humanas |
| Pedido | nuevo → confirmado → en preparación → enviado → entregado / cancelado / perdido | ventas y logística |

El problema real: **la pantalla de Clientes se inventaba su propio segmento** (`customerSegment()` en
`app.js`) mirando `commercial_state`, así que la bandeja decía «Prospecto» y Clientes decía
«Interesado» para la misma persona. Y un prospecto que preguntaba el precio se quedaba en Prospecto
para siempre salvo que alguien lo etiquetara a mano.

---

## 2. Contrato definitivo (4 etapas)

| Etapa | Etiqueta | Se cumple cuando… |
| --- | --- | --- |
| `PROSPECT` | Prospecto | contacto registrado, sin compra entregada y sin interés demostrado |
| `INTERESTED` | Interesado | tiene un **pedido abierto** (nuevo/confirmado/en preparación/enviado) **o** un mensaje con evidencia de interés (precio, producto, disponibilidad, intención de compra) |
| `CUSTOMER` | Cliente | **1** pedido `order_intent` en estado **`entregado`** |
| `REPEAT_CUSTOMER` | Recompra | **2 o más** pedidos `entregado` **distintos** |

Precedencia única y determinista (`resolveCustomerStage`):

1. 2+ entregas → **Recompra**
2. 1 entrega → **Cliente**
3. pedido abierto → **Interesado** (`source: order`, motivo `pedido_creado`)
4. evidencia de interés por mensaje → **Interesado** (`source: message`, `interes:<motivo>`)
5. etiqueta manual (Interesado / Inactivo histórico) → esa
6. nada → **Prospecto**

Nunca se baja a quien compró por inactividad, por archivar el chat ni por un mensaje de soporte: los
pedidos entregados mandan siempre. `INACTIVE` se conserva **solo** para decisiones humanas antiguas y
no aparece en los filtros principales.

---

## 3. Clasificación automática de interés (determinista, 0 coste)

`classifyInterest({ text, type })` en `server/customers.mjs`, en este orden:

| Comprobación | Resultado | Ejemplo |
| --- | --- | --- |
| soporte de pedido | **no** interés | «¿Dónde está mi pedido?», «no ha llegado» |
| negación | **no** interés | «no me interesa, gracias» |
| intención de compra | interés `intencion_compra` | «quiero pedir dos frascos» |
| precio + producto | interés `precio_producto` | «¿cuánto cuesta el frasco de 30 cápsulas?» |
| precio solo | interés `pregunta_precio` (confianza media) | «¿a cómo sale?» |
| disponibilidad + producto | interés `disponibilidad` | «¿tienen el de 60 disponible?» |
| producto + presentación | interés `producto_concreto` | «el frasco de 60» |
| saludo / cortesía | **no** interés | «Hola», «gracias» |
| ambiguo | **no** interés + `interest_review` | «tienen disponible?» |

Se evalúa **una sola vez por mensaje**, al entrar (`recordInbound`), y se guarda en la ficha:
`interest_at`, `interest_reason`, `interest_source`, `interest_message_id`, `interest_confidence`.
La primera evidencia no se sobrescribe y un mensaje genérico posterior no la borra. Las fotos y audios
no se clasifican por texto (`no_texto`).

**Sin IA.** No se llama a ningún proveedor: ni al crear contactos, ni al entregar pedidos, ni en
mensajes ya clasificados, ni en webhooks duplicados. Coste en UAT: **0 tokens / RD$0**. Lo que no se
puede interpretar con confianza no asciende: se queda como estaba y se marca `interest_review = true`
para que una persona lo mire. (La puerta para un fallback de IA existe en el diseño, pero no se activa
en esta entrega: el clasificador determinista cubre los casos del contrato.)

---

## 4. Separación de conceptos (no se tocó nada de esto)

- **Conversación**: abierta / finalizada / archivada / asignada — intacto, y archivar o finalizar **no**
  cambia la etapa (probado).
- **Seguimiento**: tarea pendiente. Programar uno **no** cambia la etapa (probado). Ya no es un filtro
  de etapa en Clientes: vive en su pantalla.
- **Pedido**: sus 7 estados siguen mandando en ventas, inventario y facturación.
- **Automatización y consentimiento**: `automation_state`, opt-out y `do_not_contact` intactos.

---

## 5. Migración y compatibilidad

- **Aditivo**: no se borra ni se renombra ningún campo. `commercial_state` sigue calculándose y se
  muestra como dato heredado («Estado comercial legacy») para no perder información.
- `customer_stage_manual` e `customer_stage_history` se conservan tal cual; una etiqueta manual antigua
  sigue mandando (después de las compras) y queda en el historial con autor y motivo.
- Cliente y Recompra **no se pueden poner a mano** (`not_manual`): son hechos. Tampoco se puede bajar a
  Prospecto/Interesado a quien ya tiene una compra entregada (`completed_purchase_stage_conflict`).
- Informe de migración sobre una **copia** de la base UAT (solo lectura):
  `11 clientes · 0 etiquetas manuales · 0 registros de historial · 0 incoherencias`.
  Al aplicar la regla nueva, esos 11 quedan: **3 Prospecto · 5 Interesado · 2 Cliente · 1 Recompra**.
  Los 5 «Interesado» no son una reescritura: **tienen un pedido abierto**, que es exactamente el
  criterio nuevo. Antes figuraban como Prospecto.
- **Nada se escribe** al calcular la etapa: es derivada en cada lectura, así que no hay migración
  destructiva ni riesgo de quedarse desincronizada.

---

## 6. Interfaz

- **Clientes**: filtros `Todos · Prospectos · Interesados · Clientes · Recompra` (el seguimiento sale de
  ahí). La lista usa la etapa del servidor, no un segmento paralelo.
- **Bandeja**: una sola etiqueta por fila (responsable · etapa), con «Recompra» incluida.
- **Ficha del cliente**: etapa actual, **por qué**, **evidencia** (pedido concreto o la señal del
  mensaje con su fecha), **compras entregadas**, **seguimiento**, **origen de la etapa** e historial de
  correcciones manuales. El selector solo ofrece Prospecto / Interesado / Inactivo y avisa de que
  Cliente y Recompra se calculan solos.

---

## 7. Evidencia

| Prueba | Resultado |
| --- | --- |
| `tests/customer-lifecycle.test.js` (nuevo, servidor real y base temporal) | **33/33** |
| `panel-conv-list-uat` + `panel-whatsapp` + `panel-shell` + `wa-inbox` + clientes/historial | **126/3 ajenos** |
| UAT navegador (390 px × claro/oscuro, datos ficticios) | **16/16** |

El archivo nuevo cubre: prospecto, saludo, precio, intención, ambiguo, pedido creado/confirmado/
enviado (sigue Interesado), primera entrega → Cliente, segunda → Recompra, entrega repetida sin
duplicar, cancelado que no cuenta, venta entregada **no reversible** con un cambio simple (409
`delivered_reversal_required`), archivar/finalizar/reabrir sin tocar la etapa, seguimiento sin tocar la
etapa, etiqueta manual compatible, no degradar a un cliente, reinicio del backend, dos entregas
simultáneas, clasificación sin proveedor de IA, y aislamiento de permisos (repartidor sin
`clients.read` → 403; sin sesión → 401).

Capturas: `docs/capturas/ciclo-clientes-{light,dark}.png`, `ciclo-ficha-{light,dark}.png`,
`ciclo-bandeja-{light,dark}.png`. Script: `.tmp/uat-ciclo-cliente.mjs`.

---

## 8. Riesgos y pendientes

1. **Cambio visible en datos existentes**: 5 clientes de la base UAT pasan de «Prospecto» a
   «Interesado» por tener un pedido abierto. Es el criterio nuevo, no una escritura; conviene revisarlo
   con el negocio antes de publicar.
2. **Interés histórico**: los mensajes anteriores a esta entrega no se han reclasificado (a propósito:
   nada de reprocesar historial en cada carga). Solo cuenta el interés desde ahora.
3. **Frases de compra coloquiales** («mándame uno», «apártame ese») están cubiertas; otras variantes
   regionales pueden quedar en `interest_review` hasta que se añadan al patrón.
4. **Reversión de una venta entregada**: exige el flujo protegido de facturación (el PATCH simple
   devuelve 409). Si esa reversión deja el pedido en otro estado, la etapa baja sola; hoy ese flujo no
   se ha ejercitado en UAT.
5. `commercial_state` sigue existiendo: la ficha lo muestra como dato heredado. Retirarlo del todo es
   otra tarea (con migración de informes).

**GO** para el ciclo de 4 etapas en UAT; **NO-GO para desplegar** sin la autorización expresa del
negocio (y sin revisar antes el punto 1).
