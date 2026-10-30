import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/data/crm_repository.dart';
import 'package:fulltech_crm/features/pos_desktop/pos_order_message_dialog.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// «Pedir datos al cliente» con IA: comprueba que el mensaje se prepara, que no
/// se envía solo, que el envío lleva clave de operación y que sin IA no inventa.
void main() {
  late List<http.BaseRequest> vistos;

  CrmRepository repo({
    String texto = 'Hola María, ¿me confirmas la dirección de entrega?',
    bool hayConversacion = true,
    int estadoEnvio = 200,
  }) {
    vistos = <http.BaseRequest>[];
    final client = MockClient((request) async {
      vistos.add(request);
      final ruta = request.url.path;
      if (ruta == '/api/admin/conversations') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'conversations': hayConversacion
                ? [
                    {'id': 'cnv_1', 'phone': '+18095551010', 'name': 'María Rodríguez'},
                  ]
                : <Map<String, dynamic>>[],
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }
      if (ruta == '/api/admin/ai/order-message') {
        return http.Response(
          jsonEncode({'ok': true, 'text': texto, 'ai': texto.isNotEmpty}),
          200,
          headers: {'content-type': 'application/json'},
        );
      }
      if (ruta == '/api/admin/conversations/cnv_1/messages') {
        return http.Response(jsonEncode({'ok': true}), estadoEnvio,
            headers: {'content-type': 'application/json'});
      }
      return http.Response(jsonEncode({'ok': true}), 200, headers: {'content-type': 'application/json'});
    });
    return CrmRepository(ApiClient(
      httpClient: client,
      baseUrl: 'http://localhost:4000',
      sessionStore: MemorySessionStore('sesion'),
    ));
  }

  Future<void> abrir(WidgetTester tester, CrmRepository r, {ValueChanged<String>? onSent}) async {
    await r.api.restoreSession();
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () => showDialog<void>(
                context: context,
                builder: (_) => PosOrderMessageDialog(
                  customerName: 'María Rodríguez',
                  customerPhone: '+1 809-555-1010',
                  missing: const ['la ubicación de entrega'],
                  totalCents: 125000,
                  repository: r,
                  onSent: onSent,
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

  testWidgets('prepara el mensaje y NO lo envía solo', (tester) async {
    final r = repo();
    await abrir(tester, r);

    expect(find.text('Hola María, ¿me confirmas la dirección de entrega?'), findsOneWidget);
    expect(find.textContaining('Falta: la ubicación de entrega'), findsOneWidget);
    // Solo dos llamadas: buscar el chat y pedir el texto. Nada de envío.
    expect(vistos.length, 2);
    expect(vistos[1].url.path, '/api/admin/ai/order-message');
    final cuerpo = jsonDecode((vistos[1] as http.Request).body) as Map<String, dynamic>;
    expect(cuerpo['conversationId'], 'cnv_1');
    expect(cuerpo['missing'], ['la ubicación de entrega']);
    expect(cuerpo['total'], 1250.0);
  });

  testWidgets('el envío exige confirmación y usa una clave de operación', (tester) async {
    String? enviado;
    final r = repo();
    await abrir(tester, r, onSent: (texto) => enviado = texto);

    await tester.tap(find.text('Enviar al cliente'));
    await tester.pumpAndSettle();
    // Aún no se ha enviado: primero hay que confirmar.
    expect(vistos.length, 2);
    await tester.tap(find.widgetWithText(FilledButton, 'Enviar'));
    await tester.pumpAndSettle();

    final envio = vistos.last;
    expect(envio.url.path, '/api/admin/conversations/cnv_1/messages');
    expect(envio.headers[ApiClient.operationHeader], isNotNull);
    expect(jsonDecode((envio as http.Request).body)['body'],
        'Hola María, ¿me confirmas la dirección de entrega?');
    expect(enviado, 'Hola María, ¿me confirmas la dirección de entrega?');
    expect(find.text('Mensaje registrado en el chat.'), findsOneWidget);
  });

  testWidgets('un fallo de envío conserva el texto para reintentar', (tester) async {
    final r = repo(estadoEnvio: 500);
    await abrir(tester, r);

    await tester.tap(find.text('Enviar al cliente'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Enviar'));
    await tester.pumpAndSettle();

    expect(find.textContaining('El texto se conserva'), findsOneWidget);
    expect(find.text('Hola María, ¿me confirmas la dirección de entrega?'), findsOneWidget);
  });

  testWidgets('sin IA no se inventa texto', (tester) async {
    final r = repo(texto: '');
    await abrir(tester, r);

    expect(find.textContaining('La IA no devolvió ningún texto'), findsOneWidget);
    expect(find.text('Enviar al cliente'), findsNothing);
  });

  testWidgets('sin chat abierto lo dice y no pide nada a la IA', (tester) async {
    final r = repo(hayConversacion: false);
    await abrir(tester, r);

    expect(find.textContaining('no tiene ningún chat abierto'), findsOneWidget);
    expect(vistos.any((req) => req.url.path == '/api/admin/ai/order-message'), isFalse);
  });
}
