import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/data/crm_repository.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_assistant_sheet.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Asistente IA contextual: se comprueba que pinta lo que devuelve el servidor,
/// que NO envía nada y que el borrador solo se usa si la persona lo pide.
void main() {
  CrmRepository repoConRespuesta(Map<String, dynamic> body, {List<http.BaseRequest>? vistos}) {
    final client = MockClient((request) async {
      vistos?.add(request);
      return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
    });
    return CrmRepository(ApiClient(
      httpClient: client,
      baseUrl: 'http://localhost:4000',
      sessionStore: MemorySessionStore('sesion'),
    ));
  }

  Future<void> abrir(WidgetTester tester, {required CrmRepository repo, ValueChanged<String>? onUseDraft}) async {
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () => showDialog<void>(
                context: context,
                builder: (_) => ChatAssistantSheet(
                  conversationId: 'cnv_1',
                  customerName: 'María Rodríguez',
                  repository: repo,
                  onUseDraft: onUseDraft,
                ),
              ),
              child: const Text('abrir'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('abrir'));
    await tester.pumpAndSettle();
  }

  testWidgets('pinta respuesta, viñetas, fuentes y borrador sin enviarlo', (tester) async {
    final repo = repoConRespuesta({
      'ok': true,
      'ai': true,
      'answer': 'Le falta la dirección de entrega.',
      'bullets': ['Tiene un pedido abierto'],
      'suggestions': ['¿Me confirmas la dirección?'],
      'draft': 'Hola María, ¿me confirmas la dirección de entrega?',
      'sources': [
        {'type': 'customer', 'label': 'Expediente del cliente'},
      ],
    });
    await repo.api.restoreSession();

    String? usado;
    await abrir(tester, repo: repo, onUseDraft: (texto) => usado = texto);

    await tester.tap(find.text('Consultar'));
    await tester.pumpAndSettle();

    expect(find.text('Le falta la dirección de entrega.'), findsOneWidget);
    expect(find.text('• Tiene un pedido abierto'), findsOneWidget);
    expect(find.text('Borrador (no enviado)'), findsOneWidget);
    expect(find.text('Expediente del cliente'), findsOneWidget);

    await tester.ensureVisible(find.text('Usar en el mensaje'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Usar en el mensaje'));
    await tester.pumpAndSettle();

    expect(usado, 'Hola María, ¿me confirmas la dirección de entrega?');
    // El diálogo se cierra: nada se envía desde aquí.
    expect(find.text('Borrador (no enviado)'), findsNothing);
  });

  testWidgets('sin IA configurada lo dice y no inventa borrador', (tester) async {
    final repo = repoConRespuesta({'ok': true, 'ai': false, 'reason': 'ai_unavailable'});
    await repo.api.restoreSession();
    await abrir(tester, repo: repo);

    await tester.tap(find.text('Consultar'));
    await tester.pumpAndSettle();

    expect(find.textContaining('La IA no está configurada'), findsOneWidget);
    expect(find.text('Borrador (no enviado)'), findsNothing);
  });

  testWidgets('una propuesta preparada no se ejecuta sola: hay que confirmarla', (tester) async {
    final vistos = <http.BaseRequest>[];
    final repo = repoConRespuesta({
      'ok': true,
      'ai': true,
      'answer': 'Puedo crear el pedido con lo que ya dijo.',
      'proposal': {'id': 'prop_1', 'label': 'Crear pedido', 'fingerprint': 'huella-1'},
    }, vistos: vistos);
    await repo.api.restoreSession();
    await abrir(tester, repo: repo);

    await tester.tap(find.text('Consultar'));
    await tester.pumpAndSettle();
    expect(find.textContaining('No se ha ejecutado'), findsOneWidget);

    await tester.tap(find.text('Confirmar'));
    await tester.pumpAndSettle();

    final decision = vistos.last;
    expect(decision.url.path, '/api/admin/assistant/actions/prop_1/confirm');
    expect(jsonDecode((decision as http.Request).body)['fingerprint'], 'huella-1');
    expect(find.textContaining('Operación confirmada'), findsOneWidget);
  });
}
