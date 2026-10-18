# Consolidación de los worktrees (2026-10-18)

Tres carpetas compartían `main` en `b135fed` con cambios sin comitear en dos de ellas. Este documento
deja escrito qué se juntó y cómo se resolvió, para que nadie tenga que adivinarlo después.

## Qué había

| Worktree | Cambios |
| --- | --- |
| `PHYTOEMAGRY` (base) | Pedido guiado / POS (`pos.js`, `pos.css`, `pos-routes.mjs`, `orders.mjs`), reparto en POS (`listDeliveryContacts`), corrector (`proofreading*.mjs`), chat con borrador (`fulltech:wa-compose`), `sw` v131 |
| `PHYTOEMAGRY-chat-1` | Grupos de negocio (servidor + panel), política de inventario, bandeja sin conversaciones vacías, capa iOS (`ios.css`, `ios.js`, `receipt-viewer`), acción en hoja (`sheet-submit`), `sw` v129 |
| `PHYTOEMAGRY-chat-2` | Sin cambios |

## Cómo se juntó (sin perder nada)

1. Los archivos que solo tocaba `chat-1` se aplicaron al árbol base con `git apply --3way`.
2. Los archivos nuevos (`ios.css`, `ios.js`, `business-groups.mjs`, scripts de importación, docs) se
   copiaron tal cual.
3. Los cuatro archivos que tocaban **los dos** (`app.js`, `index.html`, `sw.js`, `crm-server.mjs`) se
   fusionaron a tres bandas contra `b135fed` con `git merge-file`, que conserva los dos lados.
4. Solo hubo **dos conflictos**, ambos de versión, resueltos a mano:
   - `index.html`: `app.js?v=pedido-127` (base) vs `consolidado-129` (chat-1) → **`consolidado-130`**.
   - `sw.js`: `crm-v131-pedido-ia` vs `crm-v129-ios` → **`crm-v132-consolidado`** (obliga a refrescar
     la caché de todos los paneles instalados).

## Comprobación

- Marcadores de ambos lados presentes: `fulltech:wa-compose` y `sheet-submit`, `listDeliveryContacts`
  y `businessGroups`, `pedido-15` y `ios.css`, `crm-v132-consolidado`.
- Sintaxis validada en los cuatro archivos fusionados.
- 106 pruebas enfocadas en verde (`pos`, `customers-followups`, `store-catalog`, `store-panel`,
  `pos-panel`, `panel-sales-uat`).
- UAT en `8792`: panel, chips de grupo, catálogo y lista de pedidos funcionando.

## Pendiente

- Desplegar exactamente este árbol (una sola imagen).
- El flujo de **envío del pedido al repartidor externo** (WhatsApp + plantilla UTILITY + respuestas
  Iniciar/Entregado/Problema) **no** está incluido: queda como el siguiente incremento y necesitará
  su propia plantilla aprobada por Meta y otro despliegue.
