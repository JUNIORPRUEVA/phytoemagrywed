# Candidato de despliegue — Supervisor IA de reparto + Centro IA

**Fecha:** 2026-10-22 · **Estado:** candidato aislado y probado · **Sin commit, sin push, sin deploy**

---

## 1. Método (seguro y reversible)

1. **Worktree Git aislado** en modo *detached* sobre el commit base `8a6bcec`:
   `data/uat/candidate` (ignorado por Git). No se ha tocado el árbol principal ni las ramas.
2. **Parche generado solo con los archivos del supervisor** y aplicado en el worktree:
   `data/uat/supervisor.patch` · SHA-256 `4b00882bbbb31c6382596208f6dca6a48ded0ed46832fb8fac88cebdbe6fac4b`.
3. **Cuatro archivos nuevos** copiados a mano (2 pruebas + 2 informes).
4. `node_modules` enlazado (junction) para ejecutar las pruebas sin duplicar dependencias.
5. **No se ha creado ningún commit ni rama.** Para borrar el candidato: `git worktree remove data/uat/candidate`.

> El worktree `C:/Users/pc/AppData/Local/Temp/release-store-notify` (otra persona) **no se ha tocado**.

---

## 2. Composición exacta del candidato

Base: **`8a6bcecf45a7421db97552052a0ad00577dccb87`** (HEAD = `origin/main`)

**Archivos modificados (8)** — huella de contenido normalizado a LF:

| Archivo | SHA-256 (16) |
| --- | --- |
| `server/delivery-supervisor.mjs` | `65599b38f63a6a8b` |
| `server/whatsapp.mjs` | `2693118c2d703a72` |
| `public/admin/ops.js` | `71e295b20de20dc7` |
| `public/admin/index.html` | `110cd04d07b12ba4` |
| `public/admin/sw.js` | `3668bdd0f3eae2b3` |
| `tests/whatsapp-webhook.test.js` | `6c21954dc95cc3cc` |
| `tests/panel-centro-ia-chats-uat.test.js` | `4cc596c932f20756` |
| `docs/SUPERVISOR-REPARTO-WHATSAPP-CALENDARIO.md` | `85164182360a7fcc` |

**Archivos nuevos (4)**

| Archivo | SHA-256 (16) |
| --- | --- |
| `tests/supervisor-aislamiento-uat.test.js` | `2e1977744f7e205f` |
| `tests/supervisor-escalado-destinatario-uat.test.js` | `2b06193f8dd9ce9e` |
| `docs/SUPERVISOR-REPARTO-VERIFICACION-2026-10-22.md` | `473a5657ac662a8e` |
| `docs/SUPERVISOR-REPARTO-AUDITORIA-DESPLIEGUE-2026-10-22.md` | `356468825e3cac28` |

**Verificación de identidad:** los 12 archivos del candidato son **byte a byte iguales** (salvo fin de
línea CRLF↔LF) a los del árbol de trabajo donde se ejecutaron las 240 pruebas. Los 3 archivos que
difieren en bytes difieren **solo** en EOL (comprobado normalizando).

**NO incluye** (trabajo ajeno en curso): `public/store/*`, `server/store-public-routes.mjs`,
`public/store/marketplace.css`, `docs/FULLTECH-*`, `scripts/check-store-premium-*.mjs`.

---

## 3. Los 6 requisitos exigidos, verificados en el candidato

| Requisito | Evidencia en el candidato |
| --- | --- |
| T+0/T+5/T+20/T+30 | `acceptFirstMinutes`, `acceptSecondMinutes: 20`, `acceptEscalateMinutes: 30`, etapa `not_accepted`, T+0 solo interno |
| `acceptFirstMinutes: 5` independiente | `1` ocurrencia de `acceptFirstMinutes: 5`; el importador del motor retirado ya **no** copia `deliveryReminderMinutes` |
| Falso `OPT_OUT` corregido | `whatsapp.mjs` con `/^para$/` (1) y sin `\bparar?\b`; bajas reales siguen detectándose |
| Hora de RD | `ZONA_RD` (5) + `dayKeyFmt`, `timeFmt`, `dayFmt`, `weekdayFmt` con `America/Santo_Domingo` |
| Chats afinados | `Ir a Pedidos` (1), `Nota interna · no se envió` (1), chips de estado WhatsApp |
| Motivos de escalado claros | `escalationReasonLabel` (3) → «sin teléfono del repartidor», «tiempo vencido sin resolver», … |
| Plantillas aprobadas | las 3 `APPROVED` en Meta y en el CRM; mapeo 8 / 3 / 3 sin cambios |

---

## 4. UAT ejecutada sobre el candidato exacto

**a) Suites del supervisor y Centro IA (dentro de `data/uat/candidate`):**

```
17 archivos · 240 pruebas · 240 en verde
```

**b) Suite completa (la que usa el repo) — comparación árbol vs candidato:**

| | Archivos | Pruebas | Fallos |
| --- | --- | --- | --- |
| Árbol principal (con trabajo ajeno) | 152 | 2223 | **99** |
| **Candidato aislado** | 152 | 2223 | **94** |

Los 94 fallos son **preexistentes** (jsdom de UI: `chat-sharing`, `notifications-user-persistence`,
`offline-24h`, `agent-privacy`, `ops-agents`…) y **ninguno pertenece al supervisor**. El candidato
**no añade ni un fallo** y además elimina los 5 que provienen del trabajo de tienda en curso.

**c) Puerta real del `Dockerfile` (`npm run verify:deploy` = `check` + `build`):**

`npm run check` → ✅ · `npm run build` → **exit 0** con `dist/index.html` y `dist/admin/ops.js`.
(La imagen **no** ejecuta las pruebas en el build, así que los fallos preexistentes no bloquean).

**d) Chromium real contra el candidato** (servidor levantado desde `data/uat/candidate`):

- lista de Chats con pedido, cliente · repartidor, vista previa, chips y no leídos;
- detalle con **WhatsApp · Enviado**, **Recibido** y **Nota interna · no se envió**;
- botón **Ir a Pedidos** presente;
- hora **07:49 p. m.** para un envío de las 23:49 UTC (RD correcta);
- capturas: `docs/capturas/candidato-01-escritorio-detalle.png`,
  `docs/capturas/candidato-02-movil-detalle.png`.

---

## 5. Receta de commit (NO ejecutada — requiere autorización)

```
git add server/delivery-supervisor.mjs server/whatsapp.mjs \
        public/admin/ops.js public/admin/index.html public/admin/sw.js \
        tests/whatsapp-webhook.test.js tests/panel-centro-ia-chats-uat.test.js \
        tests/supervisor-aislamiento-uat.test.js tests/supervisor-escalado-destinatario-uat.test.js \
        docs/SUPERVISOR-REPARTO-WHATSAPP-CALENDARIO.md \
        docs/SUPERVISOR-REPARTO-VERIFICACION-2026-10-22.md \
        docs/SUPERVISOR-REPARTO-AUDITORIA-DESPLIEGUE-2026-10-22.md
git commit -m "supervisor: T+5 propio, opt-out real y chats con hora de RD"
```

**SHA de origen definitivo:** no existe todavía y es imposible que exista antes de autorizar el
commit (EasyPanel construye **por commit**, `GIT_SHA` es el que se inyecta en la imagen). El
candidato queda identificado por: base `8a6bcec` + parche `4b00882b…` + las 12 huellas de §2.

---

## 6. Cambios de configuración y migraciones

| Elemento | ¿Obligatorio? | Detalle |
| --- | --- | --- |
| `delivery_supervisor.acceptFirstMinutes` | **No** | Toma `5` por defecto; fijarlo explícitamente es opcional |
| `delivery_supervisor.firstReminderMinutes` | **No** | Sigue en `10` y **ya no afecta** al calendario de aceptación |
| `delivery_control.deliveryAdminEscalationContacts` | **Sí (negocio)** | Sin esto el escalado solo deja campana |
| Teléfono de los repartidores | **Sí (dato)** | Sin teléfono no se puede avisar; se escala con ese motivo |
| Migraciones de esquema | **Ninguna** | `acceptFirstMinutes` es una clave opcional del JSON de ajustes; no hay cambios de tablas |

---

## 7. Smoke tests posteriores al despliegue (solo lectura, sin mensajes reales)

1. `GET /api/health` → `{"ok":true,"storage":"postgres"}` y `GIT_SHA` = commit nuevo.
2. En el contenedor: `grep -c acceptFirstMinutes /app/server/delivery-supervisor.mjs` ≥ 1 y
   `grep -c ZONA_RD /app/admin/ops.js` ≥ 1 (ojo: el panel vive en `/app/admin`, no en `/app/public/admin`).
3. Panel → Centro IA → **Chats**: segmento visible, lista con pedidos y chips correctos.
4. `GET /api/admin/delivery-supervisor` (con sesión): `settings.acceptFirstMinutes = 5` y
   `settings.acceptSecondMinutes = 20`, `acceptEscalateMinutes = 30`.
5. Tras 2 minutos: `delivery_supervisor_heartbeat` actualizado.
6. Primer pedido real: T+0 interno sin WhatsApp, T+5 WhatsApp con enlace, T+20 corto, T+30 escalado
   con `data.whatsapp` **no vacío** (solo si hay contacto configurado).

---

## 8. Rollback

- **Situación actual:** la especificación usa `easypanel/ventas/phytoemagrywed:latest` **sin digest**
  (`repoDigests=[]`), así que `docker service rollback` reinstalaría la misma imagen. **No es un rollback
  de código.**
- **Anclas registradas (2026-10-22, solo lectura):**
  - producción actual → `sha256:2c893c6c3b100892c70ebeeb04ee35528a851b39a51d6bc6d5f01343c4efb82c` (creada 21:51 UTC)
  - imagen anterior conocida → `phytoemagrywed:consolidado-45fbed5` =
    `sha256:fe872f7c7aa2d3739aa8a22f13a41381a645a4967729b3efdb8802be7a7fed80` (2026-10-18 23:32 UTC)
- **Preparado:** etiqueta inmutable por versión
  (`phytoemagrywed:candidato-8a6bcec-sup-20261022`), digest registrado tras el build (§9) y en el
  servidor existe además `:consolidado-45fbed5` como imagen anterior conocida.
- **Procedimiento verificado (a ejecutar solo con autorización):**
  1. anotar `docker service inspect … --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'` antes;
  2. desplegar **fijando digest** (`…@sha256:…`), no `:latest`;
  3. si falla: volver a fijar el digest anterior y `docker service update --force`;
  4. comprobar `GIT_SHA`, `/api/health` y el panel.

---

## 9. Imagen de verificación (construida en local, **sin publicar**)

```
cd data/uat/candidate
docker build --progress=plain -t phytoemagrywed:candidato-8a6bcec-sup-20261022 .
→ exit 0
```

| Dato | Valor |
| --- | --- |
| Etiqueta | `phytoemagrywed:candidato-8a6bcec-sup-20261022` |
| Id de imagen | `sha256:978999bec011fafcdcfdc3e6fd79baa8addf1332355af418912a623fced47b0d` |
| Arquitectura / tamaño | `amd64` · 532 MB |
| Creada | 2026-10-22T23:54:36Z |
| Puerta del `Dockerfile` | `npm run verify:deploy` (check + build) **superada dentro del build** |
| Publicada | **No** (`repoDigests` vacío) |

**Contenido comprobado dentro del artefacto** (`docker run --rm --entrypoint sh … grep`):

| Marcador | Resultado |
| --- | --- |
| `acceptFirstMinutes` en `delivery-supervisor.mjs` | 7 |
| `ZONA_RD` en `/app/admin/ops.js` | 5 |
| «Ir a Pedidos» en `/app/admin/ops.js` | 1 |
| Regla de opt-out | `/\bparar\b/` en la línea 71 (la vieja `/\bparar?\b/` solo aparece en el comentario explicativo) |
| `escalationReasonLabel` | 3 |
| Versión del panel | `ops.js?v=ops-14` |

**Importante:** esta imagen se construyó desde el **árbol candidato**, no desde un commit, así que su
digest **no** será el de producción. Sirve como prueba de que el contenido compila, pasa la puerta de
calidad y lleva los arreglos. El digest definitivo lo generará el registro al publicar el commit
autorizado y debe fijarse con `…@sha256:…` en el servicio.

### Estado final

| Condición | Resultado |
| --- | --- |
| Candidato aislado sin trabajo ajeno | ✅ |
| 240/240 pruebas del supervisor sobre el candidato | ✅ |
| Sin regresiones (94 fallos preexistentes, 99 en el árbol) | ✅ |
| Build de imagen y puerta del Dockerfile | ✅ |
| UAT en Chromium contra el candidato | ✅ |
| Commit autorizado | ❌ pendiente (bloquea el SHA de origen) |
| Contacto de escalado configurado | ❌ pendiente (negocio) |
| Teléfonos de reparto completos | ❌ pendiente (dato) |
| Digest fijado y rollback probado con digest | ❌ pendiente (operación) |
