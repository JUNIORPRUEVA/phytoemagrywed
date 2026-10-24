# FULLTECH — Separación CRM ↔ Fulltech Delivery

Rama `integracion/smart-commerce-delivery` · worktree `C:\Users\pc\DEV\UAT\PHYTOEMAGRY-candidato`.
**Sin push, sin merge, sin despliegue.**

---

## 1. Arquitectura anterior

El CRM hacía las dos cosas: administraba **y** era la herramienta del repartidor. De ahí venían:

- Entrada de menú **«Mis entregas»** dentro de *Entregas → Mis entregas*, con una consola operativa completa.
- Rol **DELIVERY** seleccionable al crear usuarios del CRM.
- Flujo interno de aceptar/iniciar/finalizar entregas desde el panel (fuente paralela de verdad logística).
- Permisos de reparto (`delivery.location.*`, `delivery.tracking.*`, `chats.read`) en ese rol.

## 2. Arquitectura nueva

```
CRM (administra)            Backend central                 FULLTECH DELIVERY (ejecuta)
─────────────────           ─────────────────                ──────────────────────────
Pedidos, asignación  ─────► /api/admin/*  ──► items ──►      /api/courier/*  ◄──── app Android
Supervisor IA        ◄────  delivery-lifecycle (única      login propio, pedidos
Custodia/rendiciones ◄────  fuente de estados logísticos)  asignados, INICIAR/ENTREGADO,
Conciliación         ◄────  delivery-cash + delivery-proof   cobro y custodia
Verificación transf. ◄────  delivery-payment
```

Regla: **el repartidor no opera el CRM**; el CRM no ejecuta entregas. El backend valida toda transición.

## 3. Funciones retiradas (esta pasada)

| Elemento | Acción |
|---|---|
| Entrada de menú «Mis entregas» (`data-tab="delivery"`) | **Eliminada** de `public/admin/index.html` |
| Consola operativa del repartidor en `#view-delivery` | **Retirada**: la función `renderDelivery()` ahora devuelve un aviso con enlaces a Mapa y a Custodia |
| Opción «Repartidor (solo entregas)» en el formulario de usuarios | **Eliminada** del selector (`value="DELIVERY"`) |
| Texto de ayuda del selector | Reescrito: el repartidor se da de alta en la app |

Para no dejar una ruta muerta ni un acceso heredado, la sección `#view-delivery` **se conserva vacía** con aviso: un favorito o un hash antiguo ve «Mis entregas se trasladó a la app», nunca la consola.

## 4. Funciones conservadas

Pedidos, confirmación, preparación, cancelación, seguimiento, historial, incidencias, **asignación y reasignación**, verificador de transferencias, **Supervisor IA**, custodia, rendiciones, conciliación, tarifas, reportes, Mapa del reparto, y la puerta a **Custodia y rendiciones** (ahora en el menú *Entregas*).

## 5. Roles y permisos

- Selector del CRM: `AGENT`, `OPERADOR`, `ADMIN` (+ `SUPPLIER` por API para Smart Commerce).
- `DELIVERY` **sigue existiendo en el servidor** porque hay usuarios históricos y el flujo interno de reparto aún lo usa (supervisor y UAT de panel). No se borra ninguna cuenta ni permiso.
- **Bloqueo de inicio de sesión para DELIVERY: probado y revertido.** Al aplicarlo fallaron **27 pruebas** del flujo interno de reparto (`delivery-unified-flow-uat`, incidencias, privacidad del repartidor). Se revertido y **documentado en el código**: el retiro del rol exige migrar antes esas cuentas a cuentas de la app.

## 6. Usuarios históricos

Ninguno se elimina. Conservan identidad, pedidos asignados, cobros, movimientos y auditoría. No se les asigna AGENT ni ADMIN automáticamente.

## 7. APIs

- **Conservadas**: `/api/courier/*` (app), `/api/admin/*` (panel), `delivery-cash*`, `payment/transfer`, supervisor.
- **Retiradas**: ninguna ruta de servidor. La retirada es de **interfaz**; no se encontró un endpoint que solo sirviera a «Mis entregas» y que no usen también el supervisor o la app.

## 8. Sincronización

Sin cambios en esta pasada: sigue siendo el backend central con `version`/`expectedVersion`, idempotencia por clave y `delivery_events`. La app envía acciones; el CRM lee el estado confirmado.

## 9. Cobros y custodia

Sin cambios. Única fuente financiera: `delivery-cash` (append-only) + `delivery-payment` (método y estado financiero) + `delivery-reconciliation` (solo lectura).

## 10. Supervisor IA

Sin cambios. Cierra la supervisión con entregas terminadas y no depende de la pantalla retirada.

## 11. Pruebas

| Grupo | Resultado |
|---|---|
| `tests/crm-delivery-separation.test.js` (nuevo, 8 casos) | **8/8** |
| `delivery-unified-flow-uat`, `auth-users-assignment`, `delivery-tracking`, `courier-access` | **76/76** |
| Suites de reparto y custodia (pasada anterior) | 96/96 |

Prueba nueva: menú sin «Mis entregas», vista antigua con aviso y enlaces, selector sin DELIVERY, roles administrativos intactos, custodia accesible.

## 12. APK

Sin cambios en esta pasada (no se tocó Flutter). Último artefacto: `app-debug.apk`, SHA-256 `CB09B72540BD013DF33CE3518563807A37B6E13579117F9BB055A6BE3701BC45`, `DELIVERY_API_BASE_URL=http://10.0.2.2:4477` (**solo emulador**).

## 13. Riesgos

| Riesgo | Severidad | Nota |
|---|---|---|
| Un usuario DELIVERY aún puede abrir sesión de panel | **Alta** | Se retira en UI; el bloqueo de servidor rompe 27 pruebas del flujo interno → requiere migración de cuentas |
| Código muerto `renderDeliveryLegacyUnused` (~800 líneas) | Baja | Se conserva para no romper referencias; borrarlo exige un barrido dedicado |
| Rutas antiguas por hash | Baja | Responden con aviso, sin operación |
| APK solo para emulador | Media | Falta URL UAT accesible para teléfono físico |

## 14. GO/NO-GO

- **GO** de interfaz: el CRM ya no ofrece operación de repartidor ni crea el rol.
- **NO-GO** de cierre total: falta (a) migrar las cuentas DELIVERY y bloquear su sesión en el servidor, (b) borrar el código muerto con barrido de referencias, (c) UAT del flujo completo sin usar la pantalla antigua.
- **NO-GO de publicación** hasta completar (a)-(c) y con autorización de merge.

## 15. Checklist de publicación

1. Inventario de usuarios con rol DELIVERY y su relación con pedidos abiertos.
2. Crear cuentas equivalentes en FULLTECH DELIVERY y verificar login.
3. Activar el 403 `role_retired` en `/api/admin/login` y actualizar los 27 casos del flujo interno.
4. Barrido de `renderDeliveryLegacyUnused`, estilos `.delivery-*` sin uso y textos que digan «entrega desde el CRM».
5. UAT: tienda → CRM → asignación → app → cobro → custodia → rendición → conciliación.
6. APK con URL UAT accesible y hash registrado.
