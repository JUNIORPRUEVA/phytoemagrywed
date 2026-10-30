import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/core/theme/crm_theme.dart';
import 'package:fulltech_crm/data/crm_repository.dart';
import 'package:fulltech_crm/features/usuarios/user_forms.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Hoja «Empresas permitidas»: ciclo de vida y doble envío.
///
/// Antes la carga se disparaba desde el `build` (`if (loading && …) load();`) y
/// `load()` llamaba a `setState` en mitad de la construcción: error de Flutter y
/// una petición por cada reconstrucción. Estas pruebas fijan el comportamiento
/// correcto: **una** carga al abrir, ninguna al reconstruir, y un solo envío por
/// interruptor.
class _FakeApi {
  _FakeApi({this.failToggle = false});

  final bool failToggle;
  int catalogCalls = 0;
  int grantsCalls = 0;
  int toggleCalls = 0;
  bool granted = false;
  bool failCatalog = false;

  late final http.Client client = MockClient((request) async {
    final path = request.url.path;
    if (path == '/api/admin/logistics/companies') {
      catalogCalls += 1;
      if (failCatalog) {
        return http.Response(jsonEncode({'ok': false, 'error': 'boom', 'message': 'Servidor no disponible'}), 503,
            headers: {'content-type': 'application/json'});
      }
      return http.Response(
        jsonEncode({
          'ok': true,
          'companies': [
            {'id': 'log_1', 'name': 'Logística Uno', 'active': true},
            {'id': 'log_2', 'name': 'Logística Dos', 'active': false},
          ],
        }),
        200,
        headers: {'content-type': 'application/json'},
      );
    }
    if (path == '/api/admin/users/u1/companies' && request.method == 'GET') {
      grantsCalls += 1;
      return http.Response(
        jsonEncode({
          'ok': true,
          'companies': [
            {'company_id': 'log_1', 'active': granted},
          ],
        }),
        200,
        headers: {'content-type': 'application/json'},
      );
    }
    if (path == '/api/admin/users/u1/companies' && request.method == 'POST') {
      toggleCalls += 1;
      if (failToggle) {
        return http.Response(
          jsonEncode({'ok': false, 'error': 'invalid_company_grant', 'message': 'Esa empresa ya no existe.'}),
          422,
          headers: {'content-type': 'application/json'},
        );
      }
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      granted = body['active'] == true;
      return http.Response(jsonEncode({'ok': true}), 200, headers: {'content-type': 'application/json'});
    }
    return http.Response(jsonEncode({'ok': true}), 200, headers: {'content-type': 'application/json'});
  });

  CrmRepository repository() => CrmRepository(
        ApiClient(httpClient: client, baseUrl: 'http://localhost:4000', sessionStore: MemorySessionStore('s')),
      );
}

Future<void> _openSheet(WidgetTester tester, CrmRepository repository) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: CrmTheme.build(Brightness.light),
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () => showCompaniesSheet(context, repository: repository, userId: 'u1'),
              child: const Text('abrir'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('abrir'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('carga el catálogo y las concesiones UNA sola vez al abrir', (tester) async {
    final api = _FakeApi();
    await _openSheet(tester, api.repository());

    expect(find.text('Empresas permitidas'), findsOneWidget);
    expect(find.text('Logística Uno'), findsOneWidget);
    expect(api.catalogCalls, 1, reason: 'una sola lectura del catálogo');
    expect(api.grantsCalls, 1, reason: 'una sola lectura de concesiones');
  });

  testWidgets('reconstruir la hoja no repite las peticiones', (tester) async {
    final api = _FakeApi();
    await _openSheet(tester, api.repository());
    final catalogBefore = api.catalogCalls;
    final grantsBefore = api.grantsCalls;

    // Reconstrucción provocada por el propio árbol (cambio de tema/tamaño).
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(api.catalogCalls, catalogBefore);
    expect(api.grantsCalls, grantsBefore);
  });

  testWidgets('un fallo del servidor se muestra y permite reintentar', (tester) async {
    final api = _FakeApi()..failCatalog = true;
    await _openSheet(tester, api.repository());
    expect(find.text('Servidor no disponible'), findsOneWidget);
    expect(find.text('Reintentar'), findsOneWidget);

    api.failCatalog = false;
    await tester.tap(find.text('Reintentar'));
    await tester.pumpAndSettle();
    expect(find.text('Logística Uno'), findsOneWidget);
    expect(api.catalogCalls, 2);
  });

  testWidgets('conceder una empresa envía UNA petición y relee del servidor', (tester) async {
    final api = _FakeApi();
    await _openSheet(tester, api.repository());

    await tester.tap(find.byType(Switch).first);
    await tester.pumpAndSettle();

    expect(api.toggleCalls, 1);
    expect(api.granted, isTrue);
    expect(api.grantsCalls, 2, reason: 'se relee para pintar el estado real');
    final first = tester.widget<Switch>(find.byType(Switch).first);
    expect(first.value, isTrue);
  });

  testWidgets('si el servidor rechaza, el interruptor NO cambia y se avisa', (tester) async {
    final api = _FakeApi(failToggle: true);
    await _openSheet(tester, api.repository());

    await tester.tap(find.byType(Switch).first);
    await tester.pumpAndSettle();

    expect(api.toggleCalls, 1);
    final first = tester.widget<Switch>(find.byType(Switch).first);
    expect(first.value, isFalse, reason: 'no se pinta un permiso que el servidor no confirmó');
    expect(find.textContaining('Esa empresa ya no existe'), findsOneWidget);
  });

  testWidgets('una empresa inactiva no se puede conceder', (tester) async {
    final api = _FakeApi();
    await _openSheet(tester, api.repository());

    final switches = tester.widgetList<Switch>(find.byType(Switch)).toList();
    expect(switches, hasLength(2));
    expect(switches[1].onChanged, isNull, reason: 'empresa inactiva: interruptor deshabilitado');
  });
}
