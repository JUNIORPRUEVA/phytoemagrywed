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
