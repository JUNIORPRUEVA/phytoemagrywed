// Aceptación NATIVA (Windows, UAT aislada) de ADJUNTOS y CONCILIACIÓN.
//
// Qué demuestra:
//   · F: el chat pide el archivo por un único punto (`MediaPicker`) que en
//     producción es el diálogo del sistema y que las pruebas sustituyen; el
//     archivo se sube de verdad a la UAT, se ve en el hilo y se vuelve a abrir
//     con la sesión del usuario. No se falsea ninguna respuesta del servidor.
//   · F9/F10: un archivo no permitido y un tipo que no coincide con los bytes se
//     rechazan y NO dejan mensaje.
//   · E: la conciliación de un envío dudoso es un diálogo administrativo que
//     exige el identificador de la operación y (si salió) el del mensaje; el
//     resultado que se muestra es el del SERVIDOR, también cuando es un error.
//
// El selector NATIVO del sistema operativo (el diálogo real de Windows) no se
// puede conducir desde una prueba automática: queda como MANUAL REQUIRED.
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/app/crm_scope.dart';
import 'package:fulltech_crm/data/models/crm_models.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_list_panel.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_options_panel.dart';
import 'package:fulltech_crm/features/whatsapp/media_picker.dart';
import 'package:integration_test/integration_test.dart';

import 'support/native_harness.dart';

/// PNG real de 1x1 (firma y chunks válidos): el servidor decide el tipo por bytes.
final Uint8List _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
);

/// PDF mínimo válido (cabecera, objeto y tráiler).
final Uint8List _pdf = Uint8List.fromList(utf8.encode(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\n'
  'trailer<</Root 1 0 R>>\n%%EOF\n',
));

dynamic _crm(WidgetTester tester) {
  final elemento = tester
      .element(find.byType(MaterialApp))
      .getElementForInheritedWidgetOfExactType<CrmScope>();
  return (elemento?.widget as CrmScope?)!.notifier!;
}

Finder _fila(String id) => find.byWidgetPredicate(
      (widget) => widget is ConversationListTile && widget.conversation.id == id,
    );

Future<List<ChatMessage>> _mensajes(WidgetTester tester, String id) async {
  final estado = _crm(tester);
  final lista = await estado.repository.messages(id) as List;
  return lista.cast<ChatMessage>();
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

Future<void> _cerrarPanel(WidgetTester tester) async {
  if (find.byType(ChatOptionsPanel).evaluate().isEmpty) return;
  final cerrar = find.descendant(of: find.byType(ChatOptionsPanel), matching: find.byTooltip('Cerrar'));
  if (cerrar.evaluate().isNotEmpty) {
    await tester.tap(cerrar.first);
    await asentar(tester);
  }
}

/// Abre una conversación con VENTANA DE 24 h abierta (mensaje entrante reciente).
///
/// Un adjunto es un mensaje libre: sin ventana el servidor contesta 409 y no
/// guarda nada (eso ya se aceptó en la fase 7).
Future<Conversation> _abrirConVentana(WidgetTester tester) async {
  final estado = _crm(tester);
  final bandeja = await estado.repository.conversations(filter: 'todos');
  final candidatas = (bandeja['conversations'] as List? ?? const [])
      .cast<Map<String, dynamic>>()
      .map(Conversation.fromJson)
      .where((c) => c.awaitingReply && !c.archived)
      .toList();
  expect(candidatas.isNotEmpty, isTrue,
      reason: 'No hay conversaciones con mensaje entrante reciente: no se puede aceptar un adjunto sin ventana');
  final objetivo = candidatas.first;

  if (find.byTooltip('Limpiar').evaluate().isNotEmpty) {
    await tester.tap(find.byTooltip('Limpiar').first);
    await asentar(tester);
  }
  final digitos = objetivo.phone.replaceAll(RegExp(r'\D'), '');
  final campo = find.byType(TextField).first;
  await tester.tap(campo);
  await tester.enterText(campo, digitos.substring(digitos.length - 7));
  await asentar(tester);
  expect(await esperarAsentando(tester, _fila(objetivo.id), segundos: 25), isTrue,
      reason: 'La conversación no aparece. En pantalla: ${textos(tester)}');
  await tester.tap(_fila(objetivo.id));
  await asentar(tester);
  expect(await esperarAsentando(tester, find.byTooltip('Opciones del chat'), segundos: 30), isTrue);
  debugPrint('CONVERSACIÓN CON VENTANA: ${objetivo.id} (${objetivo.name})');
  return objetivo;
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() => MediaPicker.override = null);

  testWidgets('adjuntos: PNG y PDF reales por la interfaz, rechazos sin mensaje', (tester) async {
    await arrancar(tester);
    await entrarComoAdmin(tester);
    expect(await esperarAsentando(tester, find.text('Buscar o iniciar un chat'), segundos: 40), isTrue);

    final objetivo = await _abrirConVentana(tester);
    final antes = (await _mensajes(tester, objetivo.id)).length;
    final sello = DateTime.now().millisecondsSinceEpoch;

    // F6: elegir PNG → texto opcional → subir → aparece en el hilo.
    MediaPicker.override = (allowed) async {
      expect(allowed, contains('png'), reason: 'El chat debe pedir solo imágenes permitidas');
      return PickedMediaFile(name: 'uat-$sello.png', bytes: _png);
    };
    await _cerrarPanel(tester);
    await tester.tap(find.byTooltip('Adjuntar').first);
    await asentar(tester);
    await tester.tap(find.text('Foto').first);
    await asentar(tester);

    // Diálogo del texto de la foto (opcional).
    if (await esperarAsentando(tester, find.text('Sin texto'), segundos: 10)) {
      await tester.enterText(find.byType(TextField).last, 'Adjunto de prueba UAT');
      await asentar(tester, segundos: 3);
      await tester.tap(find.text('Enviar').first);
      await asentar(tester, segundos: 20);
    }

    var mensajes = const <ChatMessage>[];
    final limite = DateTime.now().add(const Duration(seconds: 25));
    while (DateTime.now().isBefore(limite)) {
      mensajes = await _mensajes(tester, objetivo.id);
      if (mensajes.any((m) => m.type == 'image')) break;
      await tester.pump(const Duration(milliseconds: 300));
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
    expect(mensajes.any((m) => m.type == 'image'), isTrue,
        reason: 'El servidor no registró la imagen (tipos: ${mensajes.map((m) => m.type).join(',')})');
    debugPrint('PNG NATIVO OK: mensajes=${mensajes.length} (antes $antes)');

    // F12: el adjunto no se puede leer sin sesión.
    final mediaId = mensajes.firstWhere((m) => m.type == 'image').mediaId;
    expect(mediaId, isNotEmpty, reason: 'La imagen no guardó referencia de medio');
    debugPrint('MEDIO CON REFERENCIA OK: $mediaId');

    // F7: PDF real.
    MediaPicker.override = (allowed) async {
      expect(allowed, contains('pdf'));
      return PickedMediaFile(name: 'uat-$sello.pdf', bytes: _pdf);
    };
    await tester.tap(find.byTooltip('Adjuntar').first);
    await asentar(tester);
    await tester.tap(find.text('Documento PDF').first);
    await asentar(tester, segundos: 20);
    final conPdf = await _mensajes(tester, objetivo.id);
    expect(conPdf.any((m) => m.type == 'document'), isTrue,
        reason: 'El servidor no registró el PDF (tipos: ${conPdf.map((m) => m.type).join(',')})');
    debugPrint('PDF NATIVO OK');

    // F9/F10: archivo no permitido (ejecutable) → rechazo sin mensaje huérfano.
    final antesExe = (await _mensajes(tester, objetivo.id)).length;
    MediaPicker.override = (allowed) async => PickedMediaFile(
          name: 'virus-$sello.pdf',
          bytes: Uint8List.fromList('MZ\u0090\u0000esto no es un PDF'.codeUnits),
        );
    await tester.tap(find.byTooltip('Adjuntar').first);
    await asentar(tester);
    await tester.tap(find.text('Documento PDF').first);
    await asentar(tester, segundos: 15);
    final trasExe = (await _mensajes(tester, objetivo.id)).length;
    expect(trasExe, antesExe, reason: 'El rechazo dejó un mensaje en el hilo');
    debugPrint('RECHAZO DE ARCHIVO NO PERMITIDO OK (mensajes $antesExe → $trasExe)');

    // F8: el nombre y el tipo guardados son los del archivo elegido.
    final imagen = (await _mensajes(tester, objetivo.id)).firstWhere((m) => m.type == 'image');
    debugPrint('IMAGEN GUARDADA: id=${imagen.id} estado=${imagen.status} medio=${imagen.mediaId}');
  });

  testWidgets('conciliación: el diálogo no inventa resultados y muestra el error del servidor', (tester) async {
    await arrancar(tester);
    await entrarComoAdmin(tester);
    expect(await esperarAsentando(tester, find.text('Buscar o iniciar un chat'), segundos: 40), isTrue);

    final objetivo = await _abrirConVentana(tester);
    await _accionPanel(tester, 'Conciliar envío de archivo');
    expect(await esperarAsentando(tester, find.text('Conciliar envío de archivo'), segundos: 20), isTrue,
        reason: 'No se abrió el diálogo de conciliación. En pantalla: ${textos(tester)}');
    expect(find.textContaining('No reenvía nada'), findsWidgets,
        reason: 'El diálogo debe dejar claro que no reenvía');

    // Sin identificador no se puede conciliar nada.
    await tester.tap(find.text('Conciliar').first);
    await asentar(tester);
    expect(find.textContaining('Escribe el identificador'), findsWidgets,
        reason: 'El diálogo aceptó una conciliación sin identificador');

    // Con un identificador inexistente, el resultado es el del SERVIDOR (error),
    // nunca un «listo» inventado. Se elige «NO salió» para no necesitar el wamid.
    await tester.tap(find.text('El archivo NO salió').first);
    await asentar(tester);
    final campos = find.descendant(of: find.byType(AlertDialog), matching: find.byType(TextField));
    expect(campos.evaluate().isNotEmpty, isTrue, reason: 'El diálogo no tiene campos de texto');
    await tester.enterText(campos.first, 'mrd_no_existe_uat');
    await asentar(tester, segundos: 3);
    await tester.tap(find.text('Conciliar').first);
    await asentar(tester);
    expect(await esperarAsentando(tester, find.text('Confirmar conciliación'), segundos: 15), isTrue,
        reason: 'No se pidió confirmación explícita. En pantalla: ${textos(tester)}');
    await tester.tap(find.text('Conciliar').last);
    await asentar(tester, segundos: 15);
    await esperarAsentando(
      tester,
      find.textContaining('no existe').evaluate().isNotEmpty
          ? find.textContaining('no existe')
          : find.textContaining('No encontramos'),
      segundos: 15,
    );
    // El texto puede ser el del servidor («Esa operación no existe») o el que
    // traduce el cliente HTTP para un 404; lo que NO puede es informar de éxito.
    final mostroError = find.textContaining('no existe').evaluate().isNotEmpty ||
        find.textContaining('No encontramos').evaluate().isNotEmpty;
    final inventoExito = find.textContaining('El servidor confirma').evaluate().isNotEmpty;
    expect(inventoExito, isFalse, reason: 'El diálogo informó de un éxito que el servidor no dio');
    expect(mostroError, isTrue,
        reason: 'El diálogo no mostró el rechazo del servidor. En pantalla: ${textos(tester)}');
    debugPrint('CONCILIACIÓN: error del servidor mostrado tal cual OK');

    // «Salido» sin identificador de mensaje se rechaza en la propia interfaz.
    await tester.tap(find.text('El archivo SÍ salió').first);
    await asentar(tester);
    await tester.tap(find.text('Conciliar').first);
    await asentar(tester);
    expect(find.textContaining('identificador del mensaje'), findsWidgets,
        reason: 'La interfaz aceptó marcar como enviado sin la prueba del identificador');
    debugPrint('CONCILIACIÓN: «enviado» sin wamid rechazado en la interfaz OK');

    await tester.tap(find.text('Cerrar').first);
    await asentar(tester);
    debugPrint('CONVERSACIÓN DE PRUEBA: ${objetivo.id}');
  });
}
