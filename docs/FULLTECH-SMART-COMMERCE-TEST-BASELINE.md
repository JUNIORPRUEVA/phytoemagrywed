# Auditoría de pruebas — continuidad Smart Commerce

## Método y límites

Se ejecutó la suite completa **antes** de modificar esta continuación: `.tmp/store-critical-baseline.json`, 2327 tests / 2226 aprobados / 98 fallidos / 3 omitidos, 166 archivos y 28 con fallos. “Preexistente” significa reproducido en ese baseline; no demuestra que el código sea correcto ni exonera cambios de tareas anteriores. El árbol inicial ya estaba modificado y sin un commit limpio de la primera entrega. No se reseteó ni se alteraron assertions para fabricar un baseline verde.

Se agregó `scripts/audit-store-critical-tests.mjs`: compara los nombres completos de assertions por archivo y conserva mensajes, duración, coincidencia previa y candidatos nuevos en `.tmp/store-critical-failures.json`. Las categorías de entorno/tiempo son hipótesis apoyadas por repetición aislada, no una explicación causal automática de cada timeout.

## Los 98 fallos reproducidos antes de los cambios

| Archivo | Fallos baseline | Clasificación / observación inicial |
| --- | ---: | --- |
| agent-privacy.test.js | 2 | Preexistentes de seguridad: lectura de conversación sin asignar devuelve200 donde se esperaba403; acciones en lote no respetan el contrato esperado |
| assistant-ia.test.js | 1 | Preexistente: endpoint/respuesta404 frente a200 esperado |
| chat-sharing-uat.test.js | 9 | Preexistentes de UI/fixtures: elemento esperado nulo |
| delivery-assignment-notifications.test.js | 2 | Preexistentes de operación: destinatario/aviso de supervisor esperado no aparece |
| notifications-user-persistence.test.js | 3 | Preexistentes de UI/persistencia; variación adicional de fetch/tiempo en suites completas |
| offline-24h.test.js | 2 | Preexistentes: estado auth nulo y aislamiento de rechazos históricos |
| ops-agents.test.js | 1 | Preexistente: cantidad de acciones distinta1/2 |
| ops-llm.test.js | 1 | Preexistente: cantidad de acciones distinta1/2 |
| ops-notifications.test.js | 8 | Preexistentes: avisos/listas no corresponden al contrato esperado |
| panel-blindaje-uat.test.js | 2 | Preexistentes de permisos: `chats.take_unassigned` y contrato de blindaje |
| panel-conv-list-uat.test.js | 3 | Preexistentes: resumen/elementos de conversación no disponibles al esperar |
| panel-hoy-uat.test.js | 2 | Preexistentes, sensibles a timing/fixtures; STACK_TRACE_ERROR no basta para determinar causa |
| panel-location-uat.test.js | 7 | Preexistentes: acciones de chat no se habilitan dentro de la espera |
| panel-media-uat.test.js | 1 | Preexistente: chat esperado no abre |
| panel-mensajes-uat.test.js | 1 | Preexistente, requiere diagnóstico de UI/timing |
| panel-offline-uat.test.js | 2 | Preexistentes: campo de modal POS esperado ausente |
| panel-ops-uat.test.js | 6 | Preexistentes: textos y contrato de pantalla de agentes IA distintos |
| panel-pedido-confirmar-uat.test.js | 3 | Preexistentes: ficha de pedido no disponible al esperar |
| panel-programados-uat.test.js | 10 | Preexistentes: menú de acciones no se habilita |
| panel-recordar-uat.test.js | 5 | Preexistentes: filtros/elementos de archivado ausentes |
| panel-sales-uat.test.js | 17 | Preexistentes de UI/fixtures/timing; sin resolución causal completa |
| panel-seguimiento-agente-uat.test.js | 4 | Preexistentes: selección/texto del agente de seguimiento vacío |
| pos.test.js | 1 | Preexistente sensible a ejecución; requiere aislar fixture y reloj |
| quick-replies.test.js | 1 | Preexistente: marcador de quick replies esperado ausente |
| sales-workspace.test.js | 1 | Preexistente: conjunto de etapas comerciales distinto |
| store-panel.test.js | 1 | Preexistente relacionado con administración de catálogo: lista exacta de campos del formulario distinta; no se eliminó el test ni un campo para ocultarlo |
| wa-assignment-ux.test.js | 1 | Preexistente: contenedor `wa-actions` ausente |
| wa-inbox-filtros.test.js | 1 | Preexistente: condición de filtro no satisfecha |

Total: **98**. Los casos de privacidad y avisos de reparto tienen impacto real potencial y mantienen el NO-GO aunque no sean regresiones nuevas.

## Repeticiones y regresiones

Se repitieron `agent-privacy`, `delivery-assignment-notifications`, `notifications-user-persistence` y `store-panel`: 57 tests, 49 aprobados y 8 fallidos. Los ocho fallos persistentes se reproducían ya en el baseline. La prueba adicional de descartes masivos de notificaciones que falló en una ejecución global pasó en esa repetición, sin modificar su assertion. Un fallo adicional de descarga local del APK apareció en otra ejecución global y pasó al ejecutar solo ese caso: `.tmp/store-critical-apk-recheck.json`. Se conserva como sensibilidad a ejecución/entorno pendiente de causa raíz, no como arreglo de producto.

El resultado global final y sus candidatos nuevos se documentan en el cierre de la sección24 del informe principal y en el JSON comparativo. No se reduce el conteo global restando los tests “no relacionados”. Tampoco se cambió la configuración de ejecución, se saltaron tests ni se aumentaron timeouts para buscar verde.

Último pase: **2344 totales / 2242 aprobados / 99 fallidos / 3 omitidos**. Coinciden98 assertions fallidas del baseline y aparece como candidato adicional el caso de descartes masivos de notificaciones. Su repetición aislada pasa; por eso la clasificación de trabajo es sensibilidad a ejecución/entorno pendiente de diagnóstico, no “regresión corregida”. No se sustituye este resultado por el de otra ejecución que haya dado98.

Correcciones propias verificadas: rol SUPPLIER preservado al alta y con denegación general; permiso de sucursal/revocación; rate limiter de cuenta por instancia aislada manteniendo20 intentos; Origin del proxy autorizado por configuración; protección de rutas genéricas de pedido; proyección sin costos; recuperación de checkout tras rechazo de reserva. Las pruebas nuevas y las50 preservadas pasan. No se identificó una regresión persistente nueva de Smart Commerce en las repeticiones ejecutadas, pero esto no certifica todos los contratos antiguos.

## Evidencia y siguiente diagnóstico

- `.tmp/store-critical-baseline.json`: ejecución previa a los cambios.
- `.tmp/store-critical-full.json`: última ejecución completa, incluyendo fallos.
- `.tmp/store-critical-failures.json`: comparación assertion por assertion.
- `.tmp/store-critical-failure-recheck.json`: cuatro archivos repetidos.
- `.tmp/store-critical-apk-recheck.json`: repetición específica APK.
- `.tmp/store-critical-targeted.json`: 103 tests seleccionados aprobados.

Prioridad: resolver primero el contrato de privacidad de agentes con responsables de negocio; después avisos de supervisor/reasignación; luego reconciliar el contrato de UI/fixtures de panel, conversaciones y POS con la interfaz actual. Investigar timeouts/fetch bajo carga y sesiones JSDOM sin asumir que el entorno es la única causa. Cualquier actualización futura de tests debe responder a un cambio de contrato aprobado y venir acompañada de evidencia, no reemplazar una corrección funcional.
