# FULLTECH: experiencia de cliente y bienvenida

Implementación local del 23 de octubre de 2026. Sin despliegue ni cambios en producción.

## Resultado

Drawer con logo reducido solamente dentro del menú, iconos coherentes, estados activos, controles compactos y desplazamiento en pantallas bajas. Se retiraron sus enlaces duplicados a Catálogo y Lo conseguimos por ti; ambas rutas siguen disponibles en la navegación inferior. El menú se superpone correctamente a la barra inferior y al aviso de registro.

Invitados ven «¿Aún no tienes cuenta?», Regístrate e Iniciar sesión. Clientes autenticados ven su nombre real, perfil, pedidos, favoritos y cierre de sesión. Un fallo de logout se comunica sin fingir que se cerró la sesión.

Registro por correo crea la cuenta antes de pedir contacto. Google nuevo utiliza el mismo estado de bienvenida. Se conserva la prueba de contraseña cuando Google intenta vincularse con una cuenta manual existente. Las cuentas anteriores sin marcador de bienvenida no son interrumpidas.

La bienvenida muestra el primer nombre y solo dos datos opcionales: WhatsApp y localidad. Continuar y Omitir persisten respectivamente `completed` y `skipped`. Los números dominicanos se normalizan a E.164 con el validador existente; números incompletos y errores de guardado no completan el proceso. Los campos se pueden editar después desde Mi perfil. No se pide GPS.

## Persistencia y seguridad

Se reutilizan el JSON `profile` de la cuenta y PATCH `/api/store/account/me`. No se añade ninguna tabla ni migración. Los campos nuevos son `city` y `onboarding`; el teléfono utiliza la columna existente. Los registros por correo pueden iniciar con `customer_id` y teléfono nulos, como ya soportan las sesiones existentes.

Un contacto nuevo se vincula a una ficha propia usando el mecanismo existente. Coincidir con el correo de un cliente del CRM no hereda sus pedidos. Un teléfono con historial sigue requiriendo prueba de pedido para vincularlo. Las cuentas sin ficha devuelven listas vacías, nunca pedidos con identificadores nulos. Favoritos permanecen asociados al identificador de cuenta.

Omitir permite explorar, guardar favoritos y conservar el carrito. La confirmación de pedidos o solicitudes conserva su requisito comercial existente de teléfono y vinculación segura.

Perfil, acceso, registro, favoritos y estados vacíos comparten espaciado, tarjetas y formularios. Solicitudes conserva su historial y formulario, con presentación refinada y retorno tras autenticarse. Pedidos distingue un fallo de carga de una lista vacía y ofrece reintento.

## Verificación ejecutada

- 52 pruebas aprobadas en `store-accounts`, `store-auth-uat`, `store-favorites`, `google-oauth-hardening` y `store-isolation`.
- Build correcto; siete avisos existentes de contenido/configuración.
- Chromium real: 320 × 568, 375 × 667, 390 × 844, 412 × 915 y 430 × 932.
- En cada tamaño: invitado abre menú, registro real en SQLite temporal, bienvenida personalizada, rechazo de teléfono incompleto, fallo 503 simulado que no completa bienvenida, guardado válido, edición de localidad, pedidos y favoritos vacíos, envío y persistencia de solicitud, logout/login y omisión persistente tras recarga y nuevo login.
- Segunda cuenta no ve las solicitudes de la primera. Las pruebas automatizadas también cubren aislamiento de favoritos, pedidos y vinculación de Google.
- Sin errores JavaScript en los cinco ciclos y sin desbordamiento horizontal al cerrar cada ciclo.
- Capturas anteriores obtenidas del frontend del commit HEAD; capturas posteriores del árbol de trabajo, con mismo viewport. Ubicación: `docs/capturas/customer-uat/`. `results.json` contiene el resultado por tamaño.

La UAT utiliza SQLite nuevo en un directorio temporal; fuerza `databaseUrl` vacío y deshabilita scheduler, WhatsApp, CAPI, OAuth externo, correo y SMS. Los servicios de prueba se cierran al terminar. Los nombres de prueba existen solo en esa base aislada.

## Archivos de esta tarea

- `public/store/index.html`: navegación y carga de estilos.
- `public/store/customer-ui.css`: diseño del drawer y superficies de cliente.
- `public/store/store.js`: bienvenida, perfil, estado del menú y navegación tras autenticación.
- `public/store/sw.js`: actualización de recursos en caché.
- `server/store-accounts.mjs`: persistencia compatible y cuentas sin contacto obligatorio.
- `tests/store-accounts.test.js`, `tests/google-oauth-hardening.test.js`: contrato opcional de bienvenida y seguridad de vinculación.
- `scripts/check-store-customer-uat.mjs`: UAT real aislada y modo de previsualización.

Se preservaron también las modificaciones anteriores de ofertas, iconos, categorías y Nosotros.

## Límites y estado

Google se verifica con proveedor simulado en pruebas de backend; no se utilizó una identidad Google real. Teclado nativo y áreas seguras requieren revisión en teléfono físico. No se afirma aprobación de toda la suite del repositorio: se ejecutó el conjunto relevante indicado arriba.

GO para revisión local. Sin commit, push ni despliegue de esta tarea.
