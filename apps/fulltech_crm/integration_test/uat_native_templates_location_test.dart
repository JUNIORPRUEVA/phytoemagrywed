// Aceptación NATIVA (Windows, UAT aislada) de PLANTILLAS y UBICACIÓN.
//
// Qué demuestra:
//   · B: fuera de la ventana de 24 h (la conversación es nueva y el cliente no
//     ha escrito) la app ofrece plantillas APROBADAS, exige el valor de cada
//     hueco `{{n}}`, la envía por el mismo transporte MOCK y el servidor
//     registra UN mensaje con el nombre de la plantilla y su idioma.
//     Además se comprueba la idempotencia por clave de operación por HTTP.
//   · C: el menú «Datos de pago / ubicación» muestra las ubicaciones del negocio
//     y elige una; el servidor guarda un mensaje de tipo `location` con sus
//     coordenadas. No se abre ningún mapa externo ni se pide GPS.
//
// Nada sale a Meta: el transporte de la UAT es MOCK (se anota en envios.log).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/app/crm_scope.dart';
import 'package:fulltech_crm/data/models/crm_models.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_list_panel.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_options_panel.dart';
import 'package:integration_test/integration_test.dart';

import 'support/native_harness.dart';

dynamic _crm(WidgetTester tester) {
  final elemento = tester
      .element(find.byType(MaterialApp))
      .getElementForInheritedWidgetOfExactType<CrmScope>();
  return (elemento?.widget as CrmScope?)!.notifier!;
}

Finder _fila(String id) => find.byWidgetPredicate(
      (widget) => widget is ConversationListTile && widget.conversation.id == id,
    );

/// Crea una conversación DESECHABLE y abre su hilo desde la interfaz.
Future<String> _abrirConversacionNueva(WidgetTester tester, String etiqueta) async {
  final estado = _crm(tester);
  final sello = DateTime.now().millisecondsSinceEpoch;
  final telefono = '1809${sello.toString().substring(sello.toString().length - 7)}';
  final nueva = await estado.repository.startConversation(phone: telefono, name: '$etiqueta $sello');
  final id = ((nueva['conversation'] as Map?)?['id'] ?? '') as String;
  expect(id, isNotEmpty, reason: 'No se pudo crear la conversación sintética');
  await estado.refresh(quiet: true);
  await asentar(tester);

  final campo = find.byType(TextField).first;
  await tester.tap(campo);
  await tester.enterText(campo, telefono.substring(telefono.length - 7));
  await asentar(tester);
  expect(await esperarAsentando(tester, _fila(id), segundos: 25), isTrue,
      reason: 'La conversación nueva no aparece en la bandeja. En pantalla: ${textos(tester)}');
  await tester.ensureVisible(_fila(id).first);
  await tester.pump(const Duration(milliseconds: 200));
  await tester.tap(_fila(id));
  await asentar(tester);
  expect(await esperarAsentando(tester, find.byTooltip('Opciones del chat'), segundos: 30), isTrue,
      reason: 'No se abrió el hilo. En pantalla: ${textos(tester)}');
  return id;
}

Future<void> _abrirPanel(WidgetTester tester) async {
  if (find.byType(ChatOptionsPanel).evaluate().isEmpty) {
    await tester.tap(find.byTooltip('Opciones del chat').first);
    await asentar(tester);
  }
  expect(await esperarAsentando(tester, find.byType(ChatOptionsPanel), segundos: 20), isTrue);
}

Future<void> _accionPanel(WidgetTester tester, String label) async {
  await _abrirPanel(tester);
  final item = find.descendant(of: find.byType(ChatOptionsPanel), matching: find.text(label));
  expect(await esperarAsentando(tester, item, segundos: 20), isTrue,
      reason: 'El panel no ofrece «$label». En pantalla: ${textos(tester)}');
  await tester.ensureVisible(item.first);
  await tester.pump(const Duration(milliseconds: 200));
  await tester.tap(item.first);
  await asentar(tester);
}

Future<List<ChatMessage>> _mensajes(WidgetTester tester, String id) async {
  final estado = _crm(tester);
  final lista = await estado.repository.messages(id) as List;
  return lista.cast<ChatMessage>();
}

/// Abre en la interfaz la conversación indicada, buscándola por teléfono.
Future<void> _abrirConversacion(WidgetTester tester, String id, String telefono) async {
  if (find.byTooltip('Limpiar').evaluate().isNotEmpty) {
    await tester.tap(find.byTooltip('Limpiar').first);
    await asentar(tester);
  }
  final digitos = telefono.replaceAll(RegExp(r'\D'), '');
  final campo = find.byType(TextField).first;
  await tester.tap(campo);
  await tester.enterText(campo, digitos.substring(digitos.length - 7));
  await asentar(tester);
  expect(await esperarAsentando(tester, _fila(id), segundos: 25), isTrue,
      reason: 'La conversación no aparece en la bandeja. En pantalla: ${textos(tester)}');
  await tester.ensureVisible(_fila(id).first);
  await tester.pump(const Duration(milliseconds: 200));
  await tester.tap(_fila(id));
  await asentar(tester);
  expect(await esperarAsentando(tester, find.byTooltip('Opciones del chat'), segundos: 30), isTrue,
      reason: 'No se abrió el hilo. En pantalla: ${textos(tester)}');
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('plantillas: ventana cerrada, huecos exigidos y servidor MOCK', (tester) async {
    await arrancar(tester);
    await entrarComoAdmin(tester);
    expect(await esperarAsentando(tester, find.text('Buscar o iniciar un chat'), segundos: 40), isTrue);

    final id = await _abrirConversacionNueva(tester, 'QA Plantilla');
    expect(await _mensajes(tester, id), isEmpty, reason: 'La conversación nueva no debería tener mensajes');

    // B6/B7: el selector nativo de plantillas.
    await _accionPanel(tester, 'Enviar plantilla');
    expect(await esperarAsentando(tester, find.text('phyto_contacto_personalizado_v1'), segundos: 25), isTrue,
        reason: 'El selector no mostró plantillas aprobadas. En pantalla: ${textos(tester)}');
    debugPrint('SELECTOR DE PLANTILLAS OK (solo aprobadas)');

    await tester.tap(find.text('phyto_contacto_personalizado_v1').first);
    await asentar(tester);

    // B5/B7: los huecos {{1}} y {{2}} se piden antes de enviar.
    expect(await esperarAsentando(tester, find.textContaining('Datos de «'), segundos: 20), isTrue,
        reason: 'No se pidieron los datos de la plantilla. En pantalla: ${textos(tester)}');
    final campos = find.byType(TextField);
    expect(campos.evaluate().length, greaterThanOrEqualTo(2),
        reason: 'La plantilla tiene dos huecos y deben pedirse los dos');
    await tester.enterText(campos.at(campos.evaluate().length - 2), 'Cliente UAT');
    await tester.enterText(campos.at(campos.evaluate().length - 1), 'Mensaje de prueba de plantilla');
    await asentar(tester, segundos: 5);
    debugPrint('HUECOS DE PLANTILLA PEDIDOS OK');

    await tester.tap(find.text('Enviar').first);
    await asentar(tester, segundos: 20);

    // B13: el servidor registra UN mensaje de plantilla con su nombre.
    final mensajes = await _mensajes(tester, id);
    final plantilla = mensajes.where((m) => m.type == 'template').toList();
    expect(plantilla.length, 1,
        reason: 'El servidor no registró exactamente un mensaje de plantilla (tipos: ${mensajes.map((m) => m.type).join(',')})');
    debugPrint('PLANTILLA ENVIADA OK: id=${plantilla.first.id} estado=${plantilla.first.status}');

    // B14/B15: misma clave de operación = un único mensaje lógico.
    final antes = (await _mensajes(tester, id)).length;
    final clave = 'tpl_uat_${DateTime.now().millisecondsSinceEpoch}';
    await _crm(tester).repository.sendTemplate(
      id,
      'phyto_contacto_personalizado_v1',
      operationKey: clave,
      values: const {'1': 'Cliente UAT', '2': 'Repetición idempotente'},
    );
    final tras1 = (await _mensajes(tester, id)).length;
    await _crm(tester).repository.sendTemplate(
      id,
      'phyto_contacto_personalizado_v1',
      operationKey: clave,
      values: const {'1': 'Cliente UAT', '2': 'Repetición idempotente'},
    );
    final tras2 = (await _mensajes(tester, id)).length;
    expect(tras1, antes + 1, reason: 'La plantilla nueva debía crear un mensaje');
    expect(tras2, tras1, reason: 'La misma clave de operación duplicó el mensaje');
    debugPrint('IDEMPOTENCIA DE PLANTILLA OK: $antes → $tras1 → $tras2');

    // B8: una plantilla NO aprobada no está disponible en el selector.
    final aprobadas = await _crm(tester).repository.waTemplates();
    expect(aprobadas.any((t) => t['name'] == 'fulltech_contacto_personalizado_v2'), isFalse,
        reason: 'El selector no debe ofrecer plantillas pendientes de aprobación');
    debugPrint('PLANTILLAS NO APROBADAS EXCLUIDAS OK');
  });

  testWidgets('ubicación: el negocio comparte una ubicación y el servidor la guarda', (tester) async {
    await arrancar(tester);
    await entrarComoAdmin(tester);
    expect(await esperarAsentando(tester, find.text('Buscar o iniciar un chat'), segundos: 40), isTrue);

    final estado = _crm(tester);
    // Fixture SINTÉTICA en la base UAT (nunca en producción): una ubicación del
    // negocio, que es lo que consume el envío nativo (no hay GPS ni latitud libre).
    final sello = DateTime.now().millisecondsSinceEpoch;
    final nombreUbicacion = 'UAT Almacén $sello';
    await estado.repository.saveChatSharing({
      'locations': [
        {
          'name': nombreUbicacion,
          'address': 'Av. Prueba 123, UAT',
          'latitude': 18.4861,
          'longitude': -69.9312,
        },
      ],
      'banks': const [],
      'catalogs': const [],
    });

    /*
     * La ubicación es un mensaje LIBRE: WhatsApp solo la acepta dentro de la
     * ventana de 24 h. Por eso se usa una conversación que tenga un mensaje
     * ENTRANTE reciente (`awaiting_reply`), no una recién creada —en la recién
     * creada el servidor contesta 409 `outside_window`, que es lo correcto.
     */
    final bandeja = await estado.repository.conversations(filter: 'todos');
    final conVentana = (bandeja['conversations'] as List? ?? const [])
        .cast<Map<String, dynamic>>()
        .map(Conversation.fromJson)
        .where((c) => c.awaitingReply && !c.archived)
        .toList();
    expect(conVentana.isNotEmpty, isTrue,
        reason: 'No hay ninguna conversación con mensaje entrante reciente en la UAT: el envío de ubicación no se puede aceptar sin ventana de 24 h');
    final objetivo = conVentana.first;
    debugPrint('UBICACIÓN: conversación con ventana = ${objetivo.id} (${objetivo.name})');
    await _abrirConversacion(tester, objetivo.id, objetivo.phone);
    final id = objetivo.id;

    // C1/C5: el menú abre la hoja con las ubicaciones del negocio.
    // (`_SheetTitle` pinta el rótulo en mayúsculas.)
    await _accionPanel(tester, 'Datos de pago / ubicación');
    expect(await esperarAsentando(tester, find.text('UBICACIONES'), segundos: 25), isTrue,
        reason: 'La hoja no muestra el bloque de ubicaciones. En pantalla: ${textos(tester)}');
    expect(find.text(nombreUbicacion), findsWidgets,
        reason: 'La ubicación configurada no aparece en la hoja');
    debugPrint('HOJA DE UBICACIONES OK');

    await tester.tap(find.text(nombreUbicacion).first);
    await asentar(tester, segundos: 20);

    // C7/C8/C9/C10: mensaje autoritativo del servidor con coordenadas.
    List<ChatMessage> mensajes = const [];
    final limite = DateTime.now().add(const Duration(seconds: 20));
    while (DateTime.now().isBefore(limite)) {
      mensajes = await _mensajes(tester, id);
      if (mensajes.any((m) => m.type == 'location')) break;
      await tester.pump(const Duration(milliseconds: 300));
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
    final ubicacion = mensajes.where((m) => m.type == 'location').toList();
    expect(ubicacion.length, 1,
        reason: 'El servidor no guardó el mensaje de ubicación (tipos: ${mensajes.map((m) => m.type).join(',')})');
    expect(ubicacion.first.latitude, isNotNull, reason: 'La ubicación guardada no trae latitud');
    expect(ubicacion.first.longitude, isNotNull, reason: 'La ubicación guardada no trae longitud');
    debugPrint('UBICACIÓN OK: lat=${ubicacion.first.latitude} lng=${ubicacion.first.longitude} estado=${ubicacion.first.status}');
    // C14: al recargar el hilo sigue estando una sola vez (nada duplicado).
    await _accionPanel(tester, 'Recargar mensajes');
    await asentar(tester);
    final trasRecargar = await _mensajes(tester, id);
    expect(trasRecargar.where((m) => m.type == 'location').length, 1,
        reason: 'Tras recargar hay más de una ubicación: se duplicó');
    debugPrint('RECARGA SIN DUPLICADOS OK');

    // C12/C13: una coordenada inválida se rechaza y no deja mensaje huérfano.
    final antes = (await _mensajes(tester, id)).length;
    await expectLater(
      estado.repository.sendLocation(id, locationId: 'loc_no_existe_uat', operationKey: 'loc_uat_$sello'),
      throwsA(anything),
      reason: 'El servidor debería rechazar una ubicación inexistente',
    );
    final despues = (await _mensajes(tester, id)).length;
    expect(despues, antes, reason: 'El rechazo dejó un mensaje huérfano');
    debugPrint('RECHAZO SIN MENSAJE HUÉRFANO OK');
  });
}
