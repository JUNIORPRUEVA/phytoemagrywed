# Instrucciones del repositorio — PHYTOEMAGRY

## Política de trabajo (obligatoria)

**Esta política aplica a TODAS las conversaciones de este proyecto, desde el primer mensaje.**

Por defecto se trabaja en **MODO RÁPIDO**: responder y modificar **cuanto antes**, sin auditorías ni
verificaciones que no se hayan pedido. Los otros modos (VALIDACIÓN, PRODUCCIÓN) solo se activan si se
piden expresamente; en particular, **no se despliega nada salvo que se pida DEPLOY**.

### MODO RÁPIDO (predeterminado)

Para cualquier cambio de pantalla, botón, menú, CSS, texto o función: **hacer exactamente lo pedido y terminar**.

1. Inspeccionar solo los archivos y funciones directamente relacionados con la solicitud.
2. No hacer búsquedas extensas por todo el proyecto si ya se sabe dónde está el código.
3. No ejecutar automáticamente suites completas de Vitest, Playwright, `npm run check`, builds ni auditorías generales.
4. Cambios visuales de HTML/CSS: modificar directamente los archivos necesarios. No abrir navegadores automatizados ni generar capturas salvo petición expresa o razón técnica concreta.
5. Cambios de JavaScript/TypeScript/backend: solo la verificación mínima relacionada con el cambio; si existe una prueba específica, ejecutarla una vez.
6. Si una prueba falla por un problema previo no relacionado, reportarlo y no investigarlo salvo que afecte a la solicitud.
7. No crear varios scripts temporales para comprobar cambios visuales sencillos.
8. No ejecutar comandos repetitivos sin razón técnica justificada.
9. No modificar módulos ajenos a la solicitud ni hacer refactorizaciones no pedidas.
10. **No** hacer commit, push, merge, build de distribución ni deploy automáticamente.
11. Mantener la UAT aislada de producción. Si un cambio de frontend se ve recargando el navegador, no reiniciar el servidor.
12. Priorizar terminar el cambio sobre producir informes extensos.
13. Responder al final de forma breve: qué se modificó, qué archivos cambiaron y si hay alguna limitación.

### MODO VALIDACIÓN

Se activa cuando se pide expresamente **probar, verificar, auditar o hacer UAT**. Ejecutar las comprobaciones necesarias, limitadas al alcance solicitado.

### MODO PRODUCCIÓN

Se activa únicamente cuando se pide expresamente **DEPLOY o publicar en producción**. En este modo sí se hacen todas las comprobaciones:

- Revisar Git y diferencias pendientes.
- Verificar compatibilidad con producción.
- Ejecutar las pruebas relevantes.
- Detectar regresiones y bloqueos.
- Proteger datos y funcionalidades existentes.
- Preparar respaldo y rollback cuando corresponda.
- Desplegar solo si es seguro y está autorizado.
- Comprobar el funcionamiento después de publicar.
- Detener el despliegue si hay un bloqueo crítico.

**Rapidez no es programar sin seguridad**: las verificaciones críticas de integridad, permisos, datos y facturación se mantienen siempre que el cambio pueda afectarlas.

## Reglas permanentes de eficiencia

**Principio general:** trabajar rápido, con cambios mínimos y verificaciones proporcionales al riesgo. El objetivo es completar correctamente cada solicitud con la menor cantidad razonable de tiempo, comandos, archivos y herramientas. Calidad no es ejecutar procesos innecesarios.

### Clasificación automática de tareas

**TAREA PEQUEÑA** — cambios visuales, CSS, textos, tamaños, iconos y posiciones.

1. Localizar el archivo.
2. Aplicar el cambio.
3. Comprobar sintaxis si corresponde.
4. Informar brevemente.

**TAREA MEDIANA** — cambios funcionales en un módulo existente.

1. Inspeccionar el módulo y sus dependencias inmediatas.
2. Implementar el cambio.
3. Ejecutar pruebas específicas.
4. Corregir errores relacionados.
5. Informar resultados.

**TAREA CRÍTICA** — producción, base de datos, pagos, facturación, permisos, autenticación, seguridad, inventario financiero, migraciones o despliegues.

1. Realizar análisis de impacto.
2. Aplicar controles de seguridad.
3. Crear respaldos cuando corresponda.
4. Ejecutar pruebas relevantes y de regresión.
5. Solicitar autorización para acciones productivas no autorizadas expresamente.

Nunca sacrifiques la seguridad o integridad de datos por velocidad.

### Uso eficiente de terminal

- Evitar comandos repetitivos y agrupar verificaciones relacionadas.
- Búsquedas específicas por archivo o símbolo; limitar la salida; no mostrar logs gigantes.
- No repetir pruebas sin cambios que lo justifiquen; reutilizar resultados válidos de la tarea.
- No arrancar servicios ni contenedores si el cambio no lo requiere.
- No reconstruir aplicaciones completas por modificaciones menores.

### Pruebas proporcionales

- CSS: verificar estilos, selectores y efectos laterales.
- JavaScript: sintaxis y comportamiento afectado.
- Backend: pruebas específicas de rutas o servicios modificados.
- Base de datos: integridad, aislamiento y migraciones.

No ejecutar suites completas, E2E extensas ni builds globales salvo que el riesgo, la dependencia afectada o una solicitud explícita lo justifiquen. Si una prueba falla por causa aparentemente ajena al cambio, identificarla y reportarla; no afirmar que es preexistente sin evidencia.

### Autonomía sin interrupciones

- No pedir confirmación para cambios rutinarios ni por detalles que se pueden descubrir en el código.
- No presentar planes extensos para tareas sencillas.
- Si hay un bloqueo real, explicar qué se necesita.
- En tareas grandes, dividir en etapas funcionales sin perder el objetivo.

### Evitar cambios innecesarios

- No refactorizar módulos completos por un cambio pequeño.
- No tocar archivos ajenos a la solicitud ni reestructurar carpetas sin necesidad.
- No agregar dependencias innecesarias.
- No sobrescribir cambios de otros worktrees ni usar restauraciones destructivas.
- No alterar comportamientos que ya funcionan. Respetar arquitectura, estilo y convenciones del proyecto.

### Gestión del tiempo

Priorizar implementar el cambio sobre explorar, analizar o generar informes. Evitar ciclos de auditoría/prueba/corrección sin un problema concreto.

### Protección de producción

Nunca de forma automática: deploy, push, merge, migraciones productivas, borrados de datos, cambios destructivos, modificación de credenciales u operaciones irreversibles. **Requieren autorización explícita.** El permiso para editar código local no implica permiso para modificar producción.

### Formato de la respuesta final (breve)

- **Resultado:** qué se modificó.
- **Archivos:** cuáles cambiaron.
- **Validación:** qué se comprobó y su resultado.
- **Pendiente:** solo lo que realmente falte.

Sin explicaciones largas, tablas múltiples, logs completos ni recomendaciones no solicitadas.
