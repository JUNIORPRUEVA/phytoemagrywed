# Plantillas del Supervisor IA — creadas en Meta y pendientes de aprobación

Fecha: 2026-10-18 · Estado: **creadas en Meta como PENDING**. Enviadas a revisión; **no aprobadas** todavía.
Cuando Meta las apruebe hay que pulsar «Sincronizar con Meta» en el panel para que el CRM las dé por enviables.

Fuente del contenido: el propio código (`server/delivery-courier.mjs`,
`server/delivery-supervisor.mjs`, catálogo `WA_TEMPLATE_SEED` en `server/crm-server.mjs`).

## 0. Resultado de la creación (real, consultado con GET)

| Plantilla | id en Meta | estado | categoría | idioma | componentes |
| --- | --- | --- | --- | --- | --- |
| `phyto_pedido_repartidor_v1` | `1464941025731592` | **PENDING** | UTILITY | `es` | BODY + BUTTONS |
| `phyto_supervisor_recordatorio_v1` | `1752076649236522` | **PENDING** | UTILITY | `es` | BODY |
| `phyto_delivery_sin_atender_admin_v1` | `1877697466943966` | **PENDING** | UTILITY | `es` | BODY |

Meta **aceptó** la categoría UTILITY y el idioma `es` de las tres (`rejected_reason: NONE`). El estado
`PENDING` significa «recibida para revisión»: **ninguna se puede usar como aprobada** hasta que cambie a
`APPROVED`, y el CRM lo refleja (`sendable: false`).

## 1. Credenciales y permisos (comprobado, sin mostrar secretos)

| Comprobación | Resultado |
| --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | presente, **token de usuario de sistema, válido, sin caducidad** |
| Permisos del token | incluye `whatsapp_business_management` (crear plantillas) y `whatsapp_business_messaging` (enviar) |
| `debug_token` app | coincide con `META_APP_ID` |
| WABA `2559517617897858` | `account_review_status: APPROVED` |
| Número `+1 849-424-0621` | `CONNECTED`, calidad `GREEN`, `CLOUD_API` |
| Plantillas en la cuenta | 13, todas `APPROVED` |

Observación menor: `code_verification_status: EXPIRED` en el número (no impide enviar: el número está
conectado y con calidad verde).

## 2. Nombres libres (sin duplicados)

Consultado el catálogo real de la WABA: **ninguno de los tres nombres existe** ni en `es` ni en otro idioma.

| Nombre | Estado en Meta |
| --- | --- |
| `phyto_pedido_repartidor_v1` | no existe |
| `phyto_supervisor_recordatorio_v1` | no existe |
| `phyto_delivery_sin_atender_admin_v1` | no existe |

## 3. ¿Se puede reutilizar alguna aprobada? — No

| Candidata | Por qué no sirve |
| --- | --- |
| `phyto_delivery_asignado_v1` (UTILITY, 3 vars) | va al **cliente** para avisar quién reparte; no lleva productos, importe, dirección ni mapa |
| `phyto_pedido_listo_v1` (UTILITY, 2 vars) | aviso al cliente; sin datos de entrega |
| `phyto_ubicacion_entrega_v1` (UTILITY, 2 vars) | pide confirmar ubicación al cliente |
| `phyto_confirmacion_pedido_v1` (UTILITY, 4 vars) | confirmación de compra al cliente |

El repartidor necesita 8 datos que ninguna plantilla aprobada transporta → hay que crearlas.

## 4. Vista previa de las tres plantillas

Variables en el **mismo orden** que las envía el CRM. Los cuerpos no empiezan ni acaban en variable
(regla de formato de Meta); se añade una frase fija al final cuando hacía falta. **El número y orden de
parámetros no cambia**, así que el envío actual sigue siendo válido.

### 4.1 `phyto_pedido_repartidor_v1`

- Categoría: **UTILITY** · idioma: **es** · 8 variables · 3 botones de respuesta rápida
- La usa: `delivery-courier.mjs#sendOrderToCourier` (`to` = teléfono del repartidor externo)
- Botones: `Iniciar entrega` (INICIAR_ENTREGA), `Entregado` (ENTREGADO), `Reportar problema` (PROBLEMA);
  el parser ya reconoce esos textos y esos payloads.

```
Hola {{1}}, pedido {{2}} para entregar.

Cliente: {{3}}
Productos: {{4}}
Cobrar: {{5}}
Dirección: {{6}}
Mapa: {{7}}
Instrucciones: {{8}}

Cuando salgas, pulsa «Iniciar entrega» y avísame cuando esté entregado.
```

| # | Variable | Ejemplo |
| --- | --- | --- |
| 1 | courier_name | Pedro |
| 2 | order_number | PE-100001 |
| 3 | customer_contact | Ana Pérez · +18095551234 |
| 4 | products | 2 × Frasco 30 caps; 1 × Frasco 60 caps |
| 5 | amount | DOP 3250.00 |
| 6 | address | Calle Principal 12 · Casa |
| 7 | maps_link | https://maps.google.com/?q=18.615700,-68.707100 |
| 8 | instructions | Llamar al llegar |

### 4.2 `phyto_supervisor_recordatorio_v1`

- Categoría: **UTILITY** · idioma: **es** · 3 variables · sin botones
- La usa: `delivery-supervisor.mjs#sendReminder` (solo repartidor **externo**)
- Sin cambios respecto a lo ya documentado en `docs/SUPERVISOR-DELIVERY.md`.

```
Hola {{1}}, seguimos pendientes del pedido {{2}}.

Siguiente paso: {{3}}

Responde a este mensaje cuando lo tengas listo.
```

| # | Variable | Ejemplo |
| --- | --- | --- |
| 1 | courier_name | Pedro |
| 2 | order_number | PE-100001 |
| 3 | next_action | Iniciar la entrega |

`next_action` sale de una lista cerrada («Iniciar la entrega», «Entregar y confirmar», «Confirmar la
entrega», «Resolver la incidencia»…), nunca de texto libre: encaja en UTILITY.

### 4.3 `phyto_delivery_sin_atender_admin_v1`

- Categoría: **UTILITY** · idioma: **es** · 3 variables · sin botones
- La usa: **el control de delivery heredado** (`maybeSendDeliveryAdminEscalation`, escalado a los 30 min).
  **Ojo:** el motor del Supervisor IA escala hoy solo por campana/push interno; esta plantilla **no** la
  envía todavía el supervisor (ver §6).

```
Urgente: el pedido {{1}} fue asignado al delivery {{2}} hace aproximadamente 30 minutos y todavía no ha contactado al cliente.

Panel del pedido: {{3}}

Se requiere intervención administrativa.
```

| # | Variable | Ejemplo |
| --- | --- | --- |
| 1 | order_number | PE-100001 |
| 2 | delivery_display_name | Pedro Martínez |
| 3 | delivery_deep_link | /admin/?v=delivery&order=o_123456 |

## 5. Payload exacto que se enviaría a Meta (POST, uno por plantilla)

```json
{
  "name": "phyto_pedido_repartidor_v1",
  "language": "es",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Hola {{1}}, pedido {{2}} para entregar.\n\nCliente: {{3}}\nProductos: {{4}}\nCobrar: {{5}}\nDirección: {{6}}\nMapa: {{7}}\nInstrucciones: {{8}}\n\nCuando salgas, pulsa «Iniciar entrega» y avísame cuando esté entregado.",
      "example": {
        "body_text": [
          ["Pedro", "PE-100001", "Ana Pérez · +18095551234", "2 × Frasco 30 caps; 1 × Frasco 60 caps", "DOP 3250.00", "Calle Principal 12 · Casa", "https://maps.google.com/?q=18.615700,-68.707100", "Llamar al llegar"]
        ]
      }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        { "type": "QUICK_REPLY", "text": "Iniciar entrega" },
        { "type": "QUICK_REPLY", "text": "Entregado" },
        { "type": "QUICK_REPLY", "text": "Reportar problema" }
      ]
    }
  ]
}
```

```json
{
  "name": "phyto_supervisor_recordatorio_v1",
  "language": "es",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Hola {{1}}, seguimos pendientes del pedido {{2}}.\n\nSiguiente paso: {{3}}\n\nResponde a este mensaje cuando lo tengas listo.",
      "example": { "body_text": [["Pedro", "PE-100001", "Iniciar la entrega"]] }
    }
  ]
}
```

```json
{
  "name": "phyto_delivery_sin_atender_admin_v1",
  "language": "es",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Urgente: el pedido {{1}} fue asignado al delivery {{2}} hace aproximadamente 30 minutos y todavía no ha contactado al cliente.\n\nPanel del pedido: {{3}}\n\nSe requiere intervención administrativa.",
      "example": { "body_text": [["PE-100001", "Pedro Martínez", "/admin/?v=delivery&order=o_123456"]] }
    }
  ]
}
```

Endpoint: `POST https://graph.facebook.com/v21.0/{WABA}/message_templates`.

## 6. Ajustes aplicados antes de crear (hechos)

1. **Enlace administrativo ABSOLUTO**: `absoluteDeliveryDeepLink()` antepone la URL pública HTTPS real
   (`https://phytoemagryrd.lat`, comprobada con `/api/health` → 200) a la ruta del panel. Se usa solo en
   los parámetros de plantilla (`delivery_deep_link`); la navegación interna del panel sigue con la ruta
   relativa. Se puede cambiar sin tocar código con `PHYTO_PUBLIC_URL` (o `SEO_SITE_URL`).
2. **El Supervisor IA ya escala por WhatsApp**: `escalate()` mantiene la campana/push interno y además
   envía `phyto_delivery_sin_atender_admin_v1` a los contactos de
   `delivery_control.deliveryAdminEscalationContacts` con la plantilla aprobada. Detalles:
   - una sola vez por pedido + etapa + motivo (la clave del evento es la que corta la repetición);
   - tope de **4 administradores** por incidencia;
   - si la plantilla no está aprobada o WhatsApp no está configurado, queda `pending` con el motivo real
     (nunca se marca como enviado) y se registra `delivery.supervisor_escalation_unavailable`;
   - cada envío deja `delivery.supervisor_escalation_sent`/`_failed` con `message_id` y error reales.
3. **Textos semilla alineados** en `WA_TEMPLATE_SEED` con el contenido exacto enviado a Meta (mismo orden
   y misma cantidad de variables: 8 / 3 / 3).
4. **Botones interpretables por texto además de por payload**: una respuesta rápida puede llegar sin
   `payload`; ahora `parseSupervisorIntent` y `parseCourierIntent` reconocen «Iniciar entrega»,
   «Entregado» y «Reportar problema» por su texto. Sin esto, pulsar el botón no habría hecho nada.

## 6-bis. Hallazgos que quedan abiertos

1. Sin aprobación de Meta, un repartidor externo **no recibe** recordatorios ni el pedido: queda
   `pending: template_not_approved` y la incidencia se ve en la campana de administración.
2. `phyto_contacto_personalizado_v1` sigue declarada en el catálogo local y no existe en Meta (la familia
   libre aprobada es `fulltech_contacto_personalizado_v1/v2`).

## 7. Estado de la ejecución

Hecho (2026-10-18):
1. `POST` de las tres plantillas → `PENDING` con id real (§0).
2. `GET /{id}` para el estado real: las tres `PENDING`, categoría UTILITY, idioma `es`, componentes
   esperados.
3. Sincronización del catálogo verificada en una base **local**: las tres quedan con su `meta_template_id`,
   `status: PENDING`, `sendable: false`, sus variables (`courier_name/order_number/…`) y los 3 botones.
4. Pruebas focalizadas del escalado por WhatsApp (envío único, datos mínimos, enlace absoluto, plantilla
   no aprobada, tope de 4 destinatarios) y de los botones por texto: verdes.

Pendiente para poder usarlas:
1. Esperar la revisión de Meta (`GET /{id}?fields=status,rejected_reason`). **Crear no es aprobar.**
2. Al pasar a `APPROVED`: pulsar «Sincronizar con Meta» en el panel de producción (o
   `syncWhatsAppTemplatesFromMeta`) para que el CRM las marque `sendable`.
3. Activar el supervisor con la vista previa de destinatarios delante.
4. Sin envíos reales durante la validación: los parámetros se comprobaron con WhatsApp simulado.
