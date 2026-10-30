// Aceptación NATIVA (Windows, UAT aislada) de la IA del chat:
// corrección del borrador, sugerencia de respuesta y asistente contextual.
//
// Qué demuestra:
//   · el botón flotante de IA abre un menú con las tres acciones,
//   · «Corregir el mensaje» funciona SIEMPRE: la pasada local arregla el texto sin
//     IA y sin red; «Mejorar con IA» añade la del servidor o explica por qué no,
//   · «Usar este texto» deja el borrador corregido en el compositor y NO envía,
//   · «Sugerir respuesta» muestra la propuesta o el motivo real (nunca silencio),
//   · el asistente contextual responde sin colgarse.
//
// Transporte MOCK: aquí no sale ningún mensaje a Meta.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/app/crm_scope.dart';
import 'package:fulltech_crm/data/models/crm_models.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_list_panel.dart';
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

/// El panel de opciones se pinta ENCIMA y tapa el botón flotante: se cierra.
Future<void> _cerrarPanel(WidgetTester tester) async {
  if (find.byTooltip('Cerrar').evaluate().isEmpty) return;
  final cerrar = find.byTooltip('Cerrar').first;
  await tester.tap(cerrar, warnIfMissed: false);
  await asentar(tester);
}

/// Pulsa el botón flotante de IA (cerrando antes lo que lo tape).
Future<void> _abrirMenuIa(WidgetTester tester) async {
  await _cerrarPanel(tester);
  await tester.tap(find.byTooltip('Asistente de IA').first);
  await asentar(tester);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('IA del chat: corregir el borrador, sugerir respuesta y asistente', (tester) async {
    await arrancar(tester);
    await entrarComoAdmin(tester);
    expect(await esperarAsentando(tester, find.text('Buscar o iniciar un chat'), segundos: 40), isTrue);

    // Conversación desechable para la prueba.
    final estado = _crm(tester);
    final sello = DateTime.now().millisecondsSinceEpoch;
    final telefono = '1809${sello.toString().substring(sello.toString().length - 7)}';
    final nueva = await estado.repository.startConversation(phone: telefono, name: 'QA IA $sello');
    final id = ((nueva['conversation'] as Map?)?['id'] ?? '') as String;
    expect(id, isNotEmpty);
    await estado.refresh(quiet: true);
    await asentar(tester);

    final campoBusqueda = find.byType(TextField).first;
    await tester.tap(campoBusqueda);
    await tester.enterText(campoBusqueda, telefono.substring(telefono.length - 7));
    await asentar(tester);
    expect(await esperarAsentando(tester, _fila(id), segundos: 25), isTrue);
    await tester.tap(_fila(id).first);
    await asentar(tester);
    expect(await esperarAsentando(tester, find.byTooltip('Asistente de IA'), segundos: 30), isTrue,
        reason: 'El chat no muestra el botón flotante de IA. En pantalla: ${textos(tester)}');
    debugPrint('BOTÓN FLOTANTE DE IA OK');

    // El mensaje que se va a corregir.
    final compositor = find.widgetWithText(TextField, 'Escribe un mensaje');
    expect(compositor, findsWidgets, reason: 'No encuentro el compositor del chat');
    await tester.enterText(compositor.first, 'ola ke ase, tienes el pedido?');
    await asentar(tester, segundos: 4);

    // Menú de IA.
    await _abrirMenuIa(tester);
    expect(await esperarAsentando(tester, find.text('Corregir el mensaje'), segundos: 20), isTrue,
        reason: 'El botón de IA no abre el menú. En pantalla: ${textos(tester)}');
    expect(find.text('Sugerir respuesta'), findsWidgets);
    expect(find.text('Asistente contextual'), findsWidgets);
    debugPrint('MENÚ DE IA OK: tres acciones');

    // Corrección local + IA opcional.
    await tester.tap(find.text('Corregir el mensaje').first);
    await asentar(tester);
    expect(await esperarAsentando(tester, find.text('Después'), segundos: 20), isTrue,
        reason: 'No se abrió el diálogo de corrección. En pantalla: ${textos(tester)}');
    // El texto es una sola frase: el «¿» de apertura va al principio y la palabra
    // mal escrita queda corregida.
    expect(find.textContaining('¿'), findsWidgets,
        reason: 'La revisión local no puso el signo de apertura. En pantalla: ${textos(tester)}');
    expect(find.textContaining('que hace'), findsWidgets,
        reason: 'La revisión local no arregló «ke ase». En pantalla: ${textos(tester)}');
    debugPrint('CORRECCIÓN LOCAL OK: ${textos(tester)}');

    // «Mejorar con IA»: o mejora, o explica que no está configurada.
    await tester.tap(find.text('Mejorar con IA').first);
    await asentar(tester, segundos: 25);
    final explico = find.textContaining('La IA no está configurada').evaluate().isNotEmpty ||
        find.textContaining('Corregido con IA').evaluate().isNotEmpty ||
        find.textContaining('no encontró nada más').evaluate().isNotEmpty;
    expect(explico, isTrue,
        reason: 'Tras «Mejorar con IA» no se informó de nada. En pantalla: ${textos(tester)}');
    debugPrint('IA DE CORRECCIÓN OK: resultado o motivo explícito');

    await tester.tap(find.text('Usar este texto'));
    await asentar(tester);
    final corregido = (tester.widget<TextField>(compositor.first)).controller?.text ?? '';
    expect(corregido.contains('¿'), isTrue,
        reason: 'El compositor no recibió el texto corregido: "$corregido"');
    debugPrint('TEXTO APLICADO AL COMPOSITOR OK: "$corregido"');

    // Nada se ha enviado solo.
    final mensajes = await estado.repository.messages(id) as List;
    expect(mensajes.where((m) => (m as ChatMessage).outgoing).length, 0,
        reason: 'La IA o la corrección enviaron un mensaje sin permiso');

    // Sugerir respuesta: propuesta o motivo, nunca silencio.
    await _abrirMenuIa(tester);
    expect(await esperarAsentando(tester, find.text('Sugerir respuesta'), segundos: 20), isTrue);
    await tester.tap(find.text('Sugerir respuesta').first);
    await asentar(tester, segundos: 25);
    final tieneAlgo = find.textContaining('Propuesta').evaluate().isNotEmpty ||
        find.textContaining('El último mensaje es tuyo').evaluate().isNotEmpty ||
        find.textContaining('La IA no está configurada').evaluate().isNotEmpty ||
        find.textContaining('no devolvió').evaluate().isNotEmpty ||
        find.textContaining('DeepSeek').evaluate().isNotEmpty;
    expect(tieneAlgo, isTrue,
        reason: 'La sugerencia de respuesta no dijo nada. En pantalla: ${textos(tester)}');
    debugPrint('SUGERENCIA DE RESPUESTA OK: propuesta o motivo visible');

    // Asistente contextual: responde sin colgarse.
    await _abrirMenuIa(tester);
    expect(await esperarAsentando(tester, find.text('Asistente contextual'), segundos: 20), isTrue);
    await tester.tap(find.text('Asistente contextual').first);
    await asentar(tester);
    expect(await esperarAsentando(tester, find.text('Consultar'), segundos: 25), isTrue,
        reason: 'No se abrió el asistente contextual. En pantalla: ${textos(tester)}');
    await tester.tap(find.text('Consultar'));
    await asentar(tester, segundos: 30);
    final respondio = find.textContaining('La IA no está configurada').evaluate().isNotEmpty ||
        find.textContaining('Borrador (no enviado)').evaluate().isNotEmpty ||
        find.textContaining('No se pudo consultar').evaluate().isNotEmpty ||
        find.textContaining('Fuentes').evaluate().isNotEmpty;
    expect(respondio, isTrue,
        reason: 'El asistente no devolvió nada visible. En pantalla: ${textos(tester)}');
    debugPrint('ASISTENTE CONTEXTUAL OK');

    await tester.tap(find.text('Cerrar').first);
    await asentar(tester);
  });
}
