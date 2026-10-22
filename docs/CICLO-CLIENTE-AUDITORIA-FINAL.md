# Auditoría final del ciclo del cliente (2026-10-22)

**Alcance:** solo local + UAT aislada. **Sin deploy, sin push, sin commit.** No se tocó producción, ni
pedidos históricos, ni se borró historial de etapas.

---

## 1. Implementación actual (auditada, no reescrita)

| Pieza | Dónde | Cómo funciona |
| --- | --- | --- |
| Cálculo de la etapa | `resolveCustomerStage()` — `server/customers.mjs` | Derivado en cada lectura; **no se persiste** (salvo la decisión manual) |
| Clasificador de interés | `classifyInterest()` | Reglas deterministas al entrar el mensaje; **sin IA** |
| Etapa del cliente | `customerStage(id)` | Envuelve al resolutor con los pedidos del cliente |
| Corrección manual | `setCustomerStage` / `clearCustomerStage` | Con permiso `customer.stage.update`, historial y auditoría |
| Evidencia | `interest_at`, `interest_reason`, `interest_source`, `interest_message_id` | Persistida, nunca se borra |
| Supersesión | `interest_ignored_until` | **Nuevo**: anula la evidencia anterior a una corrección |
| Historial | `customer_stage_history` | `from`, `to`, `reason`, `source`, autor, fecha |
| Informe | `GET /api/admin/customers/stage-dry-run` | Solo lectura, con `conflicts` |

## 2. Transiciones automáticas verificadas (con eventos reales, no solo funciones puras)

| Evento | Resultado | Evidencia |
| --- | --- | --- |
| Contacto creado | PROSPECTO | `customer-lifecycle` ✔ |
| «Hola» / «gracias» | sigue PROSPECTO, sin `interest_at` | ✔ |
| «¿Cuánto cuesta el frasco de 30 cápsulas?» | INTERESADO (`precio_producto`) | ✔ |
| «Quiero pedir dos frascos» | INTERESADO (`intencion_compra`) | ✔ |
| «¿Dónde está mi pedido?» | no asciende (soporte) | ✔ |
| Pedido creado / confirmado / enviado | INTERESADO, **nunca** CLIENTE | ✔ |
| Primera entrega | CLIENTE | ✔ |
| Segunda entrega distinta | RECOMPRA | ✔ |
| Entrega repetida del mismo pedido | no asciende ni duplica | ✔ (`total_purchases ≤ 1`) |
| Pedido cancelado | no cuenta | ✔ |
| Archivar / finalizar / reabrir / programar seguimiento | etapa intacta | ✔ |
| Reinicio del backend | misma etapa | ✔ |
| Dos entregas simultáneas | RECOMPRA exacta | ✔ |

## 3. Política de corrección manual (y el defecto corregido)

**Defecto real encontrado y arreglado:** corregir «Interesado → Prospecto» a mano **no servía**: la
evidencia del mensaje seguía viva y el cliente volvía a Interesado en el acto (bucle de override).

Reglas nuevas:

1. Al corregir se guarda `customer_stage_manual`, `customer_stage_manual_at` y
   `interest_ignored_until = ahora`.
2. `interestEvidence()` **ignora** la evidencia anterior a esa marca → la corrección se respeta.
3. La evidencia **no se borra** (sigue en la ficha y en el informe de reconciliación).
4. Un mensaje **nuevo** con interés real (posterior a la corrección) escribe evidencia nueva,
   `interest_reopened_at`, y el cliente vuelve a INTERESADO. Ni bucle ni bloqueo permanente.
5. «Volver a automático» limpia la decisión **y** la supersesión: la evidencia guardada recupera su voz.
6. Repetir la misma corrección es **idempotente**: no duplica historial (y la ruta ya no rompe con 500).

## 4. Precedencia (única y determinista)

```
2+ entregas → RECOMPRA
1 entrega   → CLIENTE
pedido abierto → INTERESADO (source: order)
decisión manual vigente (posterior o sin evidencia) → esa etapa
evidencia de interés vigente → INTERESADO
decisión manual antigua (si quedó evidencia posterior) → se reevalúa arriba
nada → PROSPECTO
```

CLIENTE y RECOMPRA **no son manuales** (`not_manual`): son hechos. A quien ya compró **no se le puede
bajar** (`completed_purchase_stage_conflict`). No se fabrican pedidos en ningún caso.

## 5. Conteo de compras

Fuente única: pedidos `order_intent` con estado **`entregado`** (`isCompletedPurchaseStatus`), contados
por **fila distinta** (un pedido entregado dos veces no suma dos). Cancelado/perdido no cuentan. Una
venta entregada **no se revierte** con un cambio simple (409 `delivered_reversal_required`): hace falta
la reversión protegida de facturación; si el estado cambiara, la etapa se recalcula sola y el pedido no
se reescribe.

## 6. Precisión del clasificador

Casos del enunciado cubiertos y probados: «Hola»/«Buenas»/«Gracias» → no; precio con producto → sí;
«Tienen Phytoemagry de 60 cápsulas?» → sí (disponibilidad + producto); «Quiero comprar dos frascos» →
sí; «Mándame el precio» → sí (`pregunta_precio`, confianza media); «¿Dónde está mi pedido?» → no;
«No me interesa» → no. Lo ambiguo (p. ej. «tienen disponible?» sin producto) **no asciende** y queda
`interest_review = true` para una persona. Sin errores de ortografía/dialecto: el texto se pliega (sin
acentos ni signos) antes de comparar.

## 7. Sincronización y coherencia

Lista, bandeja y ficha leen el **mismo** `resolveCustomerStage` y coinciden (probado comparando las tres
respuestas). Tras una corrección manual desde la ficha, la bandeja y la lista muestran la etapa nueva
**sin recargar** (refresco del panel + SSE de chat). Archivar/finalizar no tocan la etapa.

## 8. Permisos y auditoría

- `POST /api/admin/customers/:id/stage` exige `customer.stage.update`; INACTIVE solo ADMIN.
- Repartidor (`DELIVERY`) → 403; sin sesión → 401; cliente inexistente → 404.
- Cada cambio deja `customer.stage_changed` en la auditoría (con motivo, autor y `duplicate` si aplica)
  y una fila en `customer_stage_history`. Sin escrituras desde el informe de reconciliación.

## 9. Reconciliación (solo lectura) sobre la base UAT

`GET /api/admin/customers/stage-dry-run`:

```
11 clientes · 3 PROSPECTO · 5 INTERESADO · 2 CLIENTE · 1 RECOMPRA
0 decisiones manuales · 0 conflictos · 0 incoherencias · wouldWrite=false en todas
```

Los 5 «Interesado» lo son por **pedido abierto** (`source: order`), no por una etiqueta puesta a mano.
No se propone ninguna corrección.

## 10. Evidencia

| Prueba | Resultado |
| --- | --- |
| `tests/customer-lifecycle.test.js` | **33/33** |
| `tests/customer-lifecycle-overrides.test.js` (nuevo) | **13/13** |
| `tests/wa-inbox-filtros.test.js` | **13/13** |
| UAT navegador de corrección manual (390 px) | **8/8** |

Capturas: `docs/capturas/override-{ficha,bandeja,bandeja-nuevo-interes}-390.png`.
Scripts: `.tmp/uat-ciclo-overrides.mjs`, `.tmp/reconciliacion-etapas.mjs`.

## 11. Riesgos que quedan

1. La supersesión compara fechas ISO como cadenas: correcto con UTC de un solo servidor; con varias
   réplicas y relojes muy desviados podría fallar (±). El CRM es de un proceso.
2. `PROSPECT` manual sobre un cliente con pedido **abierto** no se respeta: el pedido es un hecho
   (documentado en el punto 4). Para «apagarlo» habría que cerrar/cancelar el pedido.
3. `commercial_state` (legacy) sigue calculándose; ya no manda en ninguna pantalla, pero no se ha
   eliminado (migración de informes aparte).
4. El historial no se poda: crece con cada corrección (una fila por cambio real).

**GO** para el ciclo, sus correcciones manuales y la coherencia entre pantallas en UAT; **NO-GO para
desplegar** sin autorización expresa.
