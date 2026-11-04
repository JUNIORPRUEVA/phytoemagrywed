# Trabajo en paralelo — varios chats, una sola app

Este documento es el contexto que debe leer **cualquier** chat que trabaje en la app Flutter del
CRM. Sirve para que dos o tres sesiones avancen a la vez sin pisarse.

## Dónde se trabaja (IMPORTANTE)

| Qué | Ruta | Rama |
|---|---|---|
| **App Flutter del CRM** (la buena, con logo de Windows) | `C:\Users\pc\DEV\WORKTREES\PHYTOEMAGRY\crm-pos-fullpos\apps\fulltech_crm` | `feat/crm-pos-fullpos` |
| Backend del CRM (solo si hace falta tocar servidor) | `C:\Users\pc\AppData\Local\Temp\phyto-order-edit` | `feat/crm-order-edit-guard` |

- **NO** trabajar en `C:\Users\pc\DEV\PROYECTOS\INTERNO\PHYTOEMAGRY\apps\fulltech_crm`:
  es otra copia (sin `pos_desktop` y con el icono por defecto). Tampoco en
  `FULLTECH-DELIVERY`, ni en producción.
- El worktree de la app tiene **cambios sin commitear** del trabajo en curso. **No** hacer
  `git checkout`, `git stash`, `git reset` ni commit/push sin que lo pida el usuario.

## Cómo probar

1. CRM local (ya levantado, puerto **8815**, WhatsApp en modo MOCK, sin scheduler):
   `http://127.0.0.1:8815` · panel: `/admin/` · credenciales en el entorno UAT local.
2. Usuario de la app: usar la cuenta de prueba provisionada en el entorno UAT.
3. App Windows contra ese CRM:
   ```
   cd C:\Users\pc\DEV\WORKTREES\PHYTOEMAGRY\crm-pos-fullpos\apps\fulltech_crm
   flutter run -d windows --dart-define=APP_ENV=dev --dart-define=API_BASE_URL=http://127.0.0.1:8815
   ```
   Atajos en la consola de `flutter run`: `r` hot reload, `R` hot restart, `q` cerrar.
4. Antes de cerrar un cambio: `dart analyze lib` **sin problemas**.
5. Para ver un mensaje enviado hace falta la ventana de 24 h abierta: el cliente de prueba
   `+18095550003` ya tiene una conversación con la ventana abierta.

## Reglas de la casa

- **MODO RÁPIDO**: cambios mínimos, verificación proporcional al riesgo, respuesta final breve
  (Resultado / Archivos / Validación / Pendiente).
- **Nunca** commit, push, merge, build de distribución ni deploy sin autorización expresa.
- **Interfaz**: se ve completa en PC Windows. Paneles laterales = **30 % del ancho**
  (`clamp(280, 460)`), textos 12–15, nada de alturas fijas con contenido variable.
  Ver `.github/instructions/fulltech-crm-ui.instructions.md` y `docs/UI-ESCRITORIO.md`.
- Los avisos usan `crmToast` (arriba a la derecha), no `SnackBar`.

## Reparto de módulos (evitar choques)

| Zona | Dueño | Carpetas |
|---|---|---|
| **Chat / WhatsApp** | chat principal | `lib/features/whatsapp/**`, `lib/features/common/crm_ui.dart` |
| **Facturación / POS** | chat 2 | `lib/features/ventas/**`, `lib/features/pos_desktop/**` |
| **Clientes, Pedidos, Entregas** | chat 3 | `lib/features/clientes/**`, `lib/features/pedidos/**`, `lib/features/entregas/**` |

- **Zona caliente** (solo el chat principal): `lib/features/whatsapp/chat_screen.dart`,
  `lib/features/common/crm_ui.dart`, `lib/features/whatsapp/desktop/chat_desktop_theme.dart`,
  `lib/data/crm_repository.dart`. Si otro módulo necesita algo ahí, **pedirlo** en vez de editarlo.
- Si dos módulos necesitan un método nuevo del repositorio, se añade **al final** del archivo y se
  avisa, para que el merge sea trivial.

## Estado actual (2026-11-02)

- Chat: corrección **local + IA** en vivo mientras se escribe (franja con el texto propuesto),
  columna de **IA** a la derecha (corregir, sugerir respuesta, resumen del cliente, asistente),
  columna de **acciones** sin IA, columna de **acciones rápidas anclada a la derecha**
  (320–360 px, empuja el hilo; en móvil hoja del 80 %) desde el icono de la barra de escritura,
  avisos arriba a la derecha, lista de chats con letra mayor y buscador de borde a borde.
- La clave de IA se configura en **Configuración → Inteligencia artificial** (solo admin).
- Pendiente conocido: pedir **confirmación de ubicación** y **confirmación de pedido** desde la
  app; **cambiar etapa** y **etiqueta** del cliente (requieren backend).
