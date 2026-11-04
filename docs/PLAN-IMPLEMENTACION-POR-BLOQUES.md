# Plan de implementación por bloques y propietarios

## Estado de la rama aislada al 2026-11-03 (última actualización)

Esta sección prevalece sobre las tablas históricas de avance más abajo. Aquellas
registran decisiones y resultados de etapas anteriores, no el estado actual.

Se implementaron rutas separadas de tarifa al cliente y pago al repartidor. La
primera cotiza desde el GPS de una tienda registrada hasta el destino confirmado
con un proveedor de ruta vial configurado, guarda un presupuesto de cinco minutos
y fija el importe y el origen en el pedido. La segunda calcula pago base fijo o
por distancia y comisión opcional sobre productos netos; fija el desglose al
asignar. Al completar una entrega se registran un asiento de ganancia y, si hubo
efectivo, otro de custodia. Se añadieron liquidaciones iniciadas, confirmadas o
fallidas, independientes de la rendición del dinero del cliente. Las facturas de
productos externos se bloquean hasta que exista un pedido abierto con recogida.

El snapshot aislado del CRM Flutter ya contiene, en **Entregas**, pantallas
compactas de «Tiendas de recogida» (buscar, registrar, editar, inactivar) y
«Reglas de entrega» (tarifa al cliente y pago al repartidor por empresa) y
«Liquidaciones» (saldo confirmado, reserva, confirmación o fallo de pago,
solo administración). Custodia conserva una pantalla y libro separados. El
POS llama al servidor para obtener la tarifa vial y conserva centavos exactos.
La pantalla de tiendas permite vincular productos ya existentes, con referencia,
costo, precio autorizado y disponibilidad declarada. No crea un catálogo nuevo.
Tampoco se ha integrado este snapshot en el worktree Flutter compartido ni en 8815.

**Verificación dirigida de esta actualización:** 24/24 pruebas de acceso courier,
21/21 de ciclo Delivery, 1/1 de cotización vial y 20/20 POS. La prueba del
contacto operativo cubre persistencia, reasignación del repartidor y privacidad
del teléfono. Análisis Dart de los archivos tocados sin errores (avisos `info`
de estilo). Siguen sin ejecutarse UAT visual,
pruebas de las tres apps juntas y la matriz completa. El estado operativo sigue
**NO-GO**.

**Delivery móvil, snapshot aislado:** se creó
`C:\Users\pc\DEV\WORKTREES\PHYTOEMAGRY\fulltech-delivery-network`, rama
`feat/crm-delivery-network`, a partir de `FULLTECH-DELIVERY-multitenant` HEAD
`adc387c` y una copia de sus archivos locales. La fuente UAT original no se
editó. La app conserva GPS de recogida y destino en modelo y caché, abre la
navegación por coordenadas cuando existen y recurre a la dirección escrita en
pedidos históricos. Lee distancia/tiempo del snapshot vial del CRM sin
inventarlos. Pruebas dirigidas 20/20 y análisis de cuatro archivos sin errores.
El backend añade la ruta vial a su DTO de lista blanca; prueba de privacidad
confirma que teléfono de tienda, hash de prueba y campos internos no salen al
repartidor. Delivery tiene una conversación operativa con la tienda mediada por
CRM; el operador responde desde Pedidos. Solo escribe en el CRM y no envía
mensajes automáticamente al teléfono privado. La conversación queda vinculada
al repartidor vigente; al reasignar, el nuevo no lee el hilo anterior. Aún falta
integrar este snapshot con el worktree Delivery dueño y validar en dispositivo real.

Brechas que bloquean una entrega integral: integración por propietarios de
backend y Flutter; migración auditada de tiendas históricas por empresa;
resolución explícita de pedidos multitienda y comunicación bidireccional con una
tienda conectada o mediada por un operador;
reconciliación de Smart Commerce con esta tarifa única; ajustes por zona con
fuente confiable; flujo de cambios de ruta/tarifa durante una entrega activa;
solicitud de rendición desde Delivery y conciliación de sus fallos parciales;
pruebas de seguridad,
persistencia, dinero y dispositivo. No se ha modificado producción ni el
proceso compartido.

## Ampliación de red de tiendas: orden de dependencias

El requisito nuevo no crea otro centro de Ventas. Reutiliza `suppliers`, `product_suppliers` y `order_pickups` y los migra con aislamiento por empresa. La arquitectura detallada, contratos y privacidad están en [RED-TIENDAS-RECOGIDA-CONTRATOS.md](RED-TIENDAS-RECOGIDA-CONTRATOS.md). El orden queda: **A** conciliar backend UAT y permisos; **B** tiendas reutilizables; **C** vínculos de producto y disponibilidad; **D** filtro Tienda y origen en Ventas; **E** reglas de ruta y montos separados; **F** comisión opcional; **G** paradas y Delivery; **H** contacto controlado con tienda; **I** cobro/custodia/rendición; **J** UAT integral. B y C exigen migración por empresa antes de habilitar pantallas. G y H no se liberan mientras el DTO de repartidor pueda exponer teléfono privado.

Archivos backend a revisar por su propietario: `server/collections.mjs`, `suppliers.mjs`, `suppliers-routes.mjs`, `pos-routes.mjs`, `smart-commerce-routing.mjs`, `courier-app.mjs`, `crm-server.mjs`; en CRM Flutter, el mismo `pos_screen.dart` y `crm_repository.dart` coordinados con sus dueños; en Delivery, cliente API, modelo y pantalla de parada/contacto. No copiar una versión entera de `crm-server.mjs` sobre otra. El backend de esta rama sigue aislado y no está cargado en 8815.

**Avance de B–D en esta rama aislada:** las tiendas nuevas exigen `company_id`, conservan datos de contacto privados y se inactivan sin borrar su ID; los vínculos producto–tienda verifican empresa y precio autorizado. Una ruta administrativa permite atribuir explícitamente las tiendas históricas sin empresa tras comprobar productos y recogidas. El POS Flutter filtra por Tienda y guarda su ID en ticket; el checkout valida el vínculo y conserva una ubicación de recogida sin teléfono. Las rutas de asignación rechazan pedidos de varias tiendas como si fueran una sola parada. Pendiente antes de integrar: migración de datos reales en UAT, precio por tienda distinto al catálogo, resolver pedidos mixtos, tarifa vial, UI administrativa y pruebas visuales.

**Avance adicional, todavía aislado:** el formulario PWA de Tiendas de recogida exige elegir empresa y permite editar tipo, contacto interno, responsable e instrucciones. Las lecturas de vínculos a agentes omiten costo y notas internos. El POS exige tienda para un producto externo y la asignación/envío al repartidor exige un snapshot de recogida con GPS válido. En la cotización Smart Commerce nueva ya no se crea una tarifa comercial por defecto: sin política explícita se solicita revisión manual. Las configuraciones guardadas con anterioridad no se reescriben automáticamente. Esto aún no constituye el módulo único de Reglas de entrega ni cubre remuneración, comisión, ruta multiparada o contacto seguro con tienda.

**Validación dirigida 2026-11-03:** 68 pruebas de tiendas, Smart Commerce, ciclo Delivery y acceso courier aprobadas; caso POS de tienda y GPS aprobado con SQLite efímero; `node --check` del formulario PWA y `git diff --check` aprobados. La suite completa `tests/pos.test.js` conserva 1 fallo de 20: el recorrido JSDOM de chat→Facturación espera que `#wa-actions` se habilite y agota el tiempo. No se ha ejecutado UAT visual ni prueba de las tres aplicaciones juntas. Este worktree no se ha conectado al servidor compartido 8815.

Fecha: 2026-11-03. **Arquitectura y avances parciales aislados; NO-GO operativo.** Se trabajó solo en `feat/crm-delivery-architecture` desde `bb53861`, sin editar otros worktrees. Referencias exactas y estados de ruta en [MATRIZ-CONTRATOS-PWA-FLUTTER-DELIVERY.md](MATRIZ-CONTRATOS-PWA-FLUTTER-DELIVERY.md). La propiedad de backend debe confirmarse con la sesión indicada por `crm-pos-fullpos/apps/fulltech_crm/docs/TRABAJO-PARALELO.md`: `C:\Users\pc\AppData\Local\Temp\phyto-order-edit`, rama `feat/crm-order-edit-guard`. Los archivos de Delivery pertenecen a su repositorio independiente; el frente visual CRM conserva shell, tema y widgets.

| Bloque | Estado | Dueño y archivos probables | Dependencia y criterio GO |
|---|---|---|---|
| 0 Contratos | Documentado, NO-GO operativo | Arquitectura: estos cinco documentos; backend y frentes revisan/aceptan contratos | Identificar revisión real de 8815, propietarios de archivo, política de tarifa/recogida/fiscalidad; matriz firmable. |
| 1 Backend compartido | Parcial en esta rama aislada; NO-GO | Responsable backend: `server/crm-server.mjs`, `courier-app.mjs`, `collections.mjs`, `delivery-lifecycle.mjs`, `delivery-payment.mjs`, `delivery-cash.mjs`, módulos `courier-*`; pruebas `tests/*` | Disponibilidad `GET/POST` y serialización/CAS de transición implementadas aquí. Falta integrar con backend destino, ganancias/turnos, oferta multi-courier, origen/destino, cobro/ledger y solicitud de rendición. |
| 2 Ventas único | Parcial en snapshot aislado; NO-GO | Funcional CRM: `lib/features/ventas/**`, `lib/features/pos_desktop/**`, `lib/data/crm_repository.dart` coordinado; Chat: `lib/features/whatsapp/chat_screen.dart`; shell compartido con frente visual | Entrada chat con contexto y selección de tickets implementadas aquí. Faltan tarifa/ubicación, UAT 0/1/varios y doble clic entre instancias antes de integrar al CRM compartido. |
| 3 Delivery ejecuta | Pendiente | Delivery: `lib/data/repositories/crm_courier_client.dart`, `api_delivery_data_source.dart`, `crm_courier_adapter.dart`, `lib/features/**`; backend courier dueño separado | `expectedVersion`, clave por intención, DTO de paradas/proof, acciones e incidencias; UAT concurrencia/recuperación. |
| 4 Dinero y custodia | Pendiente P0 | Backend pagos/ledger + CRM `lib/features/entregas/custodia_screen.dart` + Delivery `Mi dinero` | Solicitud courier pendiente, verificación admin, asiento único, compensación de fallo parcial y conciliación por empresa. |
| 5 Documento/cierre | Pendiente | Backend POS/fiscal, CRM Ventas/Pedidos, PWA compatible | Regla fiscal aprobada; cotización→pedido, PDF comercial correcto, emisión legal solo mediante contrato verificado. |
| 6 Paridad UAT | Pendiente | QA de tres frentes; visual CRM solo maquetación | [UAT-INTEGRACION-ECONOMICA.md](UAT-INTEGRACION-ECONOMICA.md): 36 casos + 28 Delivery, regresión PWA, build/plataforma explícitos. |

## Secuencia de integración sin pisar sesiones

1. Propietario del proceso 8815 identifica directorio de trabajo, revisión y configuración mock. El PID Node observado fue 27836 con comando relativo `server/crm-server.mjs`; por eso no se infiere la rama. No reiniciar ni consultar datos reales en esta fase. Preparar una copia UAT efímera cuando se acuerde contrato.
2. Responsable backend compara `crm-pos-fullpos/server/crm-server.mjs` (`54e4fbf` + cambios locales), `PHYTOEMAGRY-candidato/server/crm-server.mjs` (`c7f3852` + cambios locales) y `phyto-order-edit/server/crm-server.mjs` (`6816dea` + cambios locales si los hay) contra ancestro `bb53861`. Registrar rutas/funciones seleccionadas; **no** cherry-pick completo ni editar sobre worktree ajeno.
3. Acordar dueño único por archivo compartido antes de tocarlo. `lib/data/crm_repository.dart` y `chat_screen.dart` pertenecen al chat principal según `TRABAJO-PARALELO.md`; POS y Entregas solicitan interfaz, no los editan en paralelo. `crm_shell.dart` se acuerda con visual.
4. Integrar backend y pruebas de contrato en una revisión UAT aislada. Publicar matriz de compatibilidad PWA, Flutter CRM y Delivery con hash/build exactos.
5. Solo después, conectar las apps por bloques de flujo completo. Frontend visual aplica componentes aprobados sin duplicar lógica. Los cambios operativos requieren pruebas y GO del bloque anterior.

**Snapshot Flutter aislado:** la base común `bb53861` es anterior a `apps/fulltech_crm`. Se incorporó a **este worktree, sin alterar el origen**, la app de `crm-pos-fullpos` HEAD `54e4fbf` más sus cambios locales de `apps/fulltech_crm` y 28 archivos sin seguimiento. Los cuatro archivos clave coincidieron exactamente con los SHA-256 anotados abajo antes de editar. El origen tiene trabajo de otras sesiones y puede seguir cambiando: los cambios nuevos de esta rama no se aplicaron allí. La app Delivery todavía no se importó; sus archivos modificados sin commit siguen en `FULLTECH-DELIVERY-multitenant`.

SHA-256 del snapshot leído, en orden `chat_screen.dart`, `crm_shell.dart`, `pos_screen.dart`, `crm_repository.dart`: `F8080A9C9099BBFAA15DD34BF636CE0F26C32FB2757CDAE674DAA8946D376EDE`, `545E1DCD65832F6016C01D5C08FC163A99228BB3A220A5A0168B6658B2B3F5A2`, `6339E6B13384B05EF1373A608784C6976AC719981A2860F3E2B93FA0B261E9A7`, `868FE4D0C3806B4D3110BC6E983C32408A5FDF52977954BE72930271CF26548F`. Delivery `crm_courier_client.dart`, `api_delivery_data_source.dart`, `crm_courier_adapter.dart`, `app_shell.dart`: `0DCDFA7F5B0628ABE30D348F0EF5B6CECEB9547C05D2D033F02EB93DFCEBC452`, `BC7D4E96D3ACE7823A51C066DE887731093C36179E06EFA3440F6F2723EB6C2C`, `F220B5F771ECDA6DD2ADD3DCA8B786F0181F3194D5FBC00CC7776DEC0FE246DE`, `5C917190A12C3B74EFE32033B77F60EAAB3ECE58B894749B176ADEEEA67DA48B`. Son hashes del estado leído, no archivos transferidos.

## P0 y decisiones de negocio

| Prioridad | Bloqueo | Decisión/evidencia necesaria | Riesgo si se omite |
|---|---|---|---|
| P0 | Backend de UAT y ruta disponibilidad | Propietario confirma origen del proceso y define `POST /api/courier/availability` o alternativa oficial; test de rol/empresa | App muestra disponibilidad falsa o falla. |
| P0 | Aceptación única | Transacción/actualización condicional y prueba de carrera con dos couriers | Dos repartidores creen tener el mismo paquete. |
| P0 | Origen/destino | Tienda autorizada reutilizable, empresa, GPS y snapshots separados; bloquear mezcla de tiendas sin ruta multiparada | Courier navega a lugar incorrecto. |
| P0 | Privacidad de tienda | Cerrar lectura `suppliers` para courier y crear DTO con lista blanca; probar rutas, errores y notificaciones | Se filtra teléfono privado al repartidor. |
| P0 | Pago/cargo/rendición | Atomicidad o reconciliación, solicitud courier pendiente y aprobación admin | Doble cobro, dinero sin rastro o saldo falso. |
| P0 | Cruce chat→Ventas | Contexto tipado y validación backend; selector de ticket | Venta al cliente equivocado o duplicada. |
| P1 | Tarifas y remuneración | Regla vigente por empresa/zona/km, snapshot, permiso de excepción | Cobros o ganancias cambian retrospectivamente. |
| P1 | PIN y factura | Regla de prueba y excepción; validación fiscal/e-CF | Entrega/pago o documento presentados con estado incorrecto. |
| P1 | Incidencia/retorno | Responsable físico, paquete, efectivo y cierre | Pedido fallido queda invisible o falsamente entregado. |

## Informe por bloque

| Estado | Qué se comprobó | Qué falta | Riesgo | Prueba | Próximo paso |
|---|---|---|---|---|---|
| B0 documentado | Cuatro auditorías leídas/hash, tres revisiones y ancestro común, rutas fuente comparadas | Firma de contrato y fuente 8815 | Usar backend equivocado | Inspección estática, sin HTTP | Confirmar propietario/revisión |
| B1 parcial, NO-GO | En esta rama: disponibilidad persistente autenticada, DTO con origen/GPS/prueba y transición courier con bloqueo local + CAS; candidato tiene ganancias/turnos | Integrar destino; oferta de dos couriers, cobro/ledger y rendición | Estados/dinero divergentes | 78 pruebas dirigidas aprobadas con DB efímera, incluida carrera entre dos instancias; ninguna prueba UAT de tres apps | Backend dueño acuerda contrato |
| B2 parcial, NO-GO | En esta rama, Chat pasa cliente/conversación/modo a Ventas; se recuperan tickets del cliente o se crea borrador y el backend comprueba conversación al finalizar | UAT 0/1/varios tickets, doble clic entre dispositivos y datos de entrega | Cliente/ticket incorrecto | `dart analyze lib` sin errores (41 avisos info previos); 40 tests Flutter dirigidos aprobados | UAT aislado con backend integrado |
| B3 NO-GO | Delivery llama rutas y tiene acciones; omite versión/GPS | DTO, versión, incidencia y navegación | Oferta duplicada/ruta falsa | Carrera y dispositivo pendientes | Conectar tras B1 |
| B4 NO-GO | Ledger y remittance admin existen | Solicitud courier y conciliación fallo parcial | Custodia errónea | Casos 19-28 pendientes | Construir contrato y probar |
| B5 NO-GO | Cotización/PDF comercial existen | Contrato fiscal y cierre formal | Factura prematura | Caso 32 pendiente | Validar con propietario fiscal |
| B6 NO-GO | Matriz UAT definida | Todas las ejecuciones | Integración no demostrada | 0/36 + 0/28 | UAT aislado por bloque |

No se ejecutó prueba funcional, despliegue, commit, push ni merge. **La definición de hecho del plan maestro aún no se cumple.**
