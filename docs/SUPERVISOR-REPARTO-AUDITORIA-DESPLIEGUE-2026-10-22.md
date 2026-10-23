# Auditoría de preparación para desplegar — Supervisor IA de reparto

**Fecha:** 2026-10-22 · **Modo:** solo lectura · **Ejecutada por:** agente (sin credenciales expuestas)

**Qué NO se hizo:** no se hizo commit, push, merge ni deploy; no se reinició ningún servicio; no se
escribió en la base de datos (todas las consultas van en `BEGIN READ ONLY`); no se envió ningún
WhatsApp. La única llamada externa fue un `GET` de solo lectura a Meta para leer el estado de las
plantillas y dos `GET` a `/api/health` (local de demo y producción).

---

## 1. Git: HEAD, origin/main y trabajo concurrente

| Dato | Valor |
| --- | --- |
| HEAD | `8a6bcec` — «tienda», Junior Lopez, 2026-10-22 17:50 −04:00 |
| `origin/main` (refs locales y remoto real) | `8a6bcec` (mismo commit) |
| Ahead / behind | `0 / 0` |
| ¿Hay trabajo mezclado de otros autores? | **Sí** |

Archivos **sin commitear cuyo dueño NO es este trabajo** (no se han tocado):

```
M public/store/index.html
M public/store/product-gallery.js
M public/store/store.js
M public/store/sw.js
M server/store-public-routes.mjs
?? public/store/marketplace.css
?? docs/FULLTECH-COMMERCIAL-READINESS-UAT.md
?? docs/FULLTECH-PREMIUM-UAT.md
?? scripts/check-store-premium-*.mjs   (3 archivos)
```

---

## 2. Qué está commiteado y qué no (Supervisor / Centro IA)

**Commiteado en `8a6bcec`** (ya en `origin/main` y ya en producción):

`server/delivery-supervisor.mjs` (+180), `server/ops/delivery-tickets.mjs` (+108),
`server/ops/routes.mjs` (+71), `server/crm-server.mjs` (+108), `public/admin/ops.js` (+218),
`public/admin/ops.css` (+115), `public/admin/index.html`, `public/admin/sw.js`,
`tests/supervisor-calendario-aceptacion-uat.test.js`, `tests/panel-centro-ia-chats-uat.test.js`,
`docs/SUPERVISOR-REPARTO-WHATSAPP-CALENDARIO.md`.

**Sin commitear** (solo en el árbol de trabajo = solo en las 240 pruebas):

| Archivo | Qué aporta | ¿Está en producción? |
| --- | --- | --- |
| `server/whatsapp.mjs` | arreglo del falso `OPT_OUT` («para» ya no corta el contacto) | **NO** |
| `server/delivery-supervisor.mjs` (+61/−…) | `acceptFirstMinutes` (T+5 propio), motivo legible del escalado | **NO** |
| `public/admin/ops.js` (+65) | hora de RD garantizada, «Ir a Pedidos», nota interna explícita | **NO** |
| `public/admin/index.html`, `public/admin/sw.js` | versiones `ops-14` / `crm-v271` | **NO** |
| `tests/whatsapp-webhook.test.js`, `tests/panel-centro-ia-chats-uat.test.js` | pruebas de regresión | — |
| `tests/supervisor-aislamiento-uat.test.js` (nuevo) | aislamiento repartidor/cliente/sistema | — |
| `tests/supervisor-escalado-destinatario-uat.test.js` (nuevo) | destinatario del escalado y sin teléfono | — |
| `docs/SUPERVISOR-REPARTO-VERIFICACION-2026-10-22.md` (nuevo) | informe de la verificación | — |

**Conclusión del punto 2:** el código probado y el código desplegable **no son el mismo**.

---

## 3. Producción hoy (verificado en el servidor, solo lectura)

| Dato | Valor |
| --- | --- |
| Servicio | `ventas_phytoemagrywed` · **1/1** réplicas · `easypanel/ventas/phytoemagrywed:latest` |
| Commit desplegado (`GIT_SHA`) | `8a6bcec…` (= HEAD / `origin/main`) |
| `APP_ENV` | `production` |
| Actualización | `parallelism 1`, `order start-first`, `failure_action pause` |
| Imagen | `:latest` local de hace ~2 h (id `2c893c6c3b10`); además existe `:consolidado-45fbed5` (4 días) |
| `/api/health` | `{"ok":true,"storage":"postgres","uat":false,"items":11}` |
| Persistencia | Postgres 17 (`ventas_studio-db` 1/1) con **bind mount** `/etc/easypanel/projects/ventas/studio-db/data` |
| Scheduler | una sola réplica → **una sola instancia** del programador; latido `delivery_supervisor_heartbeat` actualizado hoy 23:18 UTC |
| Panel | `/app/admin/ops.js?v=ops-12` con la pantalla de Chats (15 coincidencias `centro-chat`) |

**Código dentro del contenedor:** `acceptFirstMinutes` → **0** coincidencias;
`escalationReasonLabel` → **0**; `ZONA_RD` → no existe (la ruta de assets es `/app/admin/`);
`primeraEspera = settings.firstReminderMinutes` → **presente (línea 1443)**.

---

## 4. INCONSISTENCIAS DETECTADAS (parar antes de desplegar)

**I1 — El árbol probado no es desplegable.** EasyPanel despliega por commit (`GIT_SHA`), y los
arreglos que hacen pasar las 240 pruebas están **sin commitear**. Desplegar ahora construiría
`8a6bcec`, exactamente lo que ya corre.

**I2 — Producción está en T+10, no en T+5.** Ajustes reales del supervisor:
`firstReminderMinutes: 10`, sin `acceptFirstMinutes`, `acceptSecondMinutes` ni
`acceptEscalateMinutes` en el documento. El código desplegado calcula el primer aviso de
aceptación con `firstReminderMinutes` → **primer WhatsApp a los 10 minutos**, no a los 5. El
arreglo (`acceptFirstMinutes = 5`, independiente de la política heredada) está sin desplegar.

**I3 — Commits mezclados.** El árbol contiene cambios en curso de la tienda (otra persona). Un
`git commit -a` publicaría trabajo ajeno sin revisar; hay que seleccionar archivos.

**I4 — Sin destino de escalado configurado.** No existe el documento `delivery_control` en
producción, así que `escalationRecipients` devuelve lista vacía: el escalado de T+30 **solo deja
campana**, sin WhatsApp. Evidencia: el último escalado real dice
`{"admins": 1, "reason": "courier_without_phone", "whatsapp": []}`.

**I5 — No hay cuentas de reparto con rol `DELIVERY`.** Roles reales: `ADMIN` 2, `AGENT` 3. Los
pedidos se asignaron a usuarios **AGENT** («Ruben», «Juanajuato») con teléfono terminado en 7826, y
**2 pedidos apuntan a un `delivery_user_id` que ya no existe** (por eso el motivo
`courier_without_phone`). El motor funciona igual (busca el teléfono del usuario asignado), pero el
dato está sucio.

Validación de teléfonos de las cuentas activas (enmascarados, solo los 4 últimos dígitos):

| Cuenta | Rol | Personal | Flota |
| --- | --- | --- | --- |
| `juniorlopezjlp200@gmail.com` | ADMIN | válido RD · **7826** | válido RD · 3936 |
| `juniorlopezjlp2000@gmail.com` | AGENT | válido RD · **7826** | — |
| `lasocurrenciasdelbs@gmail.com` | AGENT | válido RD · **7826** | válido RD · 3936 |
| `yr5985@gmail.com` | ADMIN | **SIN TELÉFONO** | — |
| `reparto.prueba@phytoemagryrd.lat` | AGENT | **SIN TELÉFONO** | — |

Consecuencia: la cuenta de reparto de pruebas **no puede recibir** el WhatsApp de T+5/T+20, y uno
de los dos administradores no recibiría el escalado por WhatsApp.

**I6 — El rollback no sería real.** La especificación usa `:latest` sin digest; `docker service
rollback` reinstalaría **la misma** imagen. El rollback de código debe hacerse reconstruyendo el SHA
anterior desde EasyPanel (o ejecutando explícitamente `:consolidado-45fbed5`).

**I7 — `docker logs` del contenedor no devuelve salida.** No hay registro recuperable por CLI; la
verificación post-despliegue debe hacerse desde el visor de logs de EasyPanel.

**I8 — El falso `OPT_OUT` sigue activo en producción.** Un «Voy para allá» de un repartidor marcaría
su contacto como «no contactar» y pausaría su automatización. Comprobado en el código desplegado:
`/app/server/whatsapp.mjs:61` contiene `\/\bparar?\b/`. El arreglo está sin desplegar.

---

## 5. Verificaciones que SÍ están en regla

| Comprobación | Resultado |
| --- | --- |
| Plantillas en Meta (GET) | `phyto_pedido_repartidor_v1`, `phyto_supervisor_recordatorio_v1`, `phyto_delivery_sin_atender_admin_v1` → **APPROVED**, `es`, UTILITY, `rejected_reason: NONE` |
| Mapeo de variables | 8 / 3 / 3 parámetros y en el orden del código (repartidor, pedido, cliente, productos, cobro, dirección, mapa, instrucciones) |
| Plantillas en el CRM | las tres en `APPROVED`, sincronizadas hoy 23:04 UTC |
| `META_APP_SECRET` | **presente** (32 caracteres) · `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_BUSINESS_ACCOUNT_ID` presentes |
| Firma del webhook | verificada en código desplegado (`x-hub-signature-256`, `timingSafeEqual`, 3 rutas `invalid_signature`); con firma falsa responde 401 (probado en local) |
| Zona horaria | `PHYTO_CRM_TZ` sin definir → **America/Santo_Domingo** por defecto; horario 8–20 en los ajustes |
| Persistencia | Postgres con bind mount en el host (sobrevive a reinicios y actualizaciones) |
| Programador | **una sola réplica** → sin ejecución duplicada entre instancias |
| Chats | pantalla desplegada (`ops-12`) y navegable |

---

## 6. Manifest de despliegue (a preparar, NO ejecutado)

**Commit que debe construirse** (selección por archivo, sin tocar la tienda):

```
server/delivery-supervisor.mjs
server/whatsapp.mjs
public/admin/ops.js
public/admin/index.html
public/admin/sw.js
tests/whatsapp-webhook.test.js
tests/panel-centro-ia-chats-uat.test.js
tests/supervisor-aislamiento-uat.test.js
tests/supervisor-escalado-destinatario-uat.test.js
docs/SUPERVISOR-REPARTO-WHATSAPP-CALENDARIO.md
docs/SUPERVISOR-REPARTO-VERIFICACION-2026-10-22.md
```

**No incluir:** `public/store/*`, `server/store-public-routes.mjs`, `public/store/marketplace.css`,
`docs/FULLTECH-PREMIUM-UAT.md`, `docs/FULLTECH-COMMERCIAL-READINESS-UAT.md`,
`scripts/check-store-premium-*.mjs` (trabajo ajeno en curso).

**Después de desplegar** (requiere autorización expresa):
1. Configurar `delivery_control.deliveryAdminEscalationContacts` con el contacto de administración.
2. Comprobar en el panel que el supervisor muestra `acceptFirstMinutes: 5` (o el T+5 aplicado).
3. Vigilar el primer pedido real: T+0 interno, T+5 WhatsApp con enlace, T+20 corto, T+30 escalado.
4. Confirmar en logs de EasyPanel que no aparecen `invalid_signature` legítimos ni
   `respuesta de repartidor: … error`.

---

## 7. Bloqueos restantes

| # | Bloqueo | Quién lo resuelve |
| --- | --- | --- |
| B1 | Commitear los arreglos (I1) sin arrastrar la tienda (I3) | desarrollo, con autorización |
| B2 | Configurar el contacto de escalado (I4) | negocio/administración |
| B3 | Limpiar datos de reparto (I5): cuentas, teléfonos y pedidos con usuario inexistente | administración |
| B4 | Definir el mecanismo de rollback real (I6) | operación |
| B5 | Verificación post-despliegue por el visor de logs (I7) | operación |

---

## 8. GO / NO-GO

**NO-GO para desplegar hoy.**

Motivo principal: lo que pasa las 240 pruebas **no está commiteado**, y lo que está commiteado
(producción) mantiene el primer aviso de aceptación en **10 minutos** en vez de 5, conserva el
falso `OPT_OUT` y no tiene destino de escalado por WhatsApp.

**GO cuando** se cumplan, en este orden: B1 (commit selectivo y verde), B2 (contacto de escalado),
B3 (teléfonos de reparto), B4 (rollback definido), y se despliegue **con autorización explícita**,
vigilando el primer pedido real y pudiendo volver al SHA anterior.

---

## 9. Sobre el número autorizado para prueba (809-398-7826)

**No se ha enviado ningún mensaje.** El número indicado coincide con el contacto que ya existe en
producción terminado en **7826** (cuenta `ADMIN`, y es también el teléfono con el que figuran los
repartidores asignados). Es el candidato natural para
`deliveryAdminEscalationContacts`, pero **cargarlo y enviar cualquier plantilla real exige
autorización de producción** y queda fuera de esta auditoría de solo lectura.
