import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/app/crm_scope.dart';
import 'package:fulltech_crm/app/crm_state.dart';
import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/core/theme/crm_theme.dart';
import 'package:fulltech_crm/data/crm_repository.dart';
import 'package:fulltech_crm/features/ajustes/ajustes_screen.dart';
import 'package:fulltech_crm/features/compartir/compartir_screen.dart';
import 'package:fulltech_crm/features/perfil/perfil_screen.dart';
import 'package:fulltech_crm/features/usuarios/usuarios_screen.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<CrmState> stateWithMock(List<http.Request> requests) async {
    SharedPreferences.setMockInitialValues({});
    final api = ApiClient(
      baseUrl: 'http://localhost:4000',
      sessionStore: MemorySessionStore('test-session'),
      httpClient: MockClient((request) async {
        requests.add(request);
        final body = switch (request.url.path) {
          '/api/admin/auth/login' || '/api/admin/session' => {
            'ok': true,
            'user': {
              'id': 'u1',
              'username': 'ana@example.com',
              'display_name': 'Ana Admin',
              'role': 'ADMIN',
            },
            'permissions': ['settings.manage', 'chats.reply', 'admin.full'],
          },
          '/api/admin/auth/me' => {
            'ok': true,
            'user': {
              'id': 'u1',
              'username': 'ana@example.com',
              'display_name': 'Ana Admin',
              'first_name': 'Ana',
              'last_name': 'Admin',
              'role': 'ADMIN',
            },
          },
          '/api/admin/users/me' => {
            'ok': true,
            'user': {
              'id': 'u1',
              'username': 'ana@example.com',
              'display_name': jsonDecode(request.body)['displayName'],
              'role': 'ADMIN',
            },
          },
          '/api/admin/data' => {'ok': true, 'customers': [], 'orders': []},
          '/api/admin/users' => {
            'ok': true,
            'users': [
              {
                'id': 'u1',
                'display_name': 'Ana Admin',
                'username': 'ana@example.com',
                'role': 'ADMIN',
                'active': true,
              },
              {
                'id': 'u2',
                'display_name': 'Luis Reparto',
                'username': 'luis@example.com',
                'role': 'DELIVERY',
                'active': true,
              },
            ],
          },
          '/api/admin/chat-sharing' || '/api/admin/settings/chat-sharing' => {
            'ok': true,
            'sharing': {
              'locations': [],
              'banks': [],
              'catalogs': [
                {
                  'id': 'c1',
                  'name': 'PHYTOEMAGRY',
                  'url': 'https://phytoemagryrd.lat/',
                },
              ],
            },
          },
          '/api/admin/settings' => {
            'ok': true,
            'followup': {
              'enabled': {'day1': true},
            },
            'plan': [
              {'key': 'day1', 'day': 1, 'reason': 'Cuidar al cliente'},
            ],
          },
          _ => {'ok': true},
        };
        return http.Response(
          jsonEncode(body),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
    final state = CrmState(CrmRepository(api));
    await state.login('ana@example.com', 'clave');
    return state;
  }

  Widget wrap(CrmState state, Widget screen) => CrmScope(
    state: state,
    child: MaterialApp(
      theme: CrmTheme.build(Brightness.light),
      home: Scaffold(body: screen),
    ),
  );

  testWidgets(
    'Configuración, Usuarios, Perfil y Compartir caben en PC pequeño',
    (tester) async {
      final state = await stateWithMock([]);
      addTearDown(state.dispose);
      for (final size in const [
        Size(1280, 720),
        Size(1366, 768),
        Size(1920, 1080),
      ]) {
        await tester.binding.setSurfaceSize(size);
        for (final screen in const [
          AjustesScreen(),
          UsuariosScreen(),
          PerfilScreen(),
          CompartirScreen(),
        ]) {
          await tester.pumpWidget(wrap(state, screen));
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull, reason: '$screen en $size');
        }
      }
      await tester.binding.setSurfaceSize(null);
      state.stopRealtime();
    },
  );

  testWidgets(
    'Compartir muestra web y tienda y permite editar solo datos guardados',
    (tester) async {
      final requests = <http.Request>[];
      final state = await stateWithMock(requests);
      addTearDown(state.dispose);
      await tester.binding.setSurfaceSize(const Size(1280, 720));
      await tester.pumpWidget(wrap(state, const CompartirScreen()));
      await tester.pumpAndSettle();
      expect(find.text('Página PHYTOEMAGRY'), findsOneWidget);
      expect(find.text('Tienda online'), findsOneWidget);
      expect(find.text('PHYTOEMAGRY'), findsOneWidget);
      expect(find.text('Agregar'), findsNWidgets(3));
      expect(
        requests.where((row) => row.url.path == '/api/admin/chat-sharing'),
        isNotEmpty,
      );
      await tester.binding.setSurfaceSize(null);
      state.stopRealtime();
    },
  );

  testWidgets('Usuarios filtra la lista y abre edición de la cuenta', (
    tester,
  ) async {
    final state = await stateWithMock([]);
    addTearDown(state.dispose);
    await tester.binding.setSurfaceSize(const Size(1280, 720));
    await tester.pumpWidget(wrap(state, const UsuariosScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Luis Reparto'), findsOneWidget);
    await tester.enterText(find.byType(TextField).first, 'Ana');
    await tester.pump();
    expect(find.text('Luis Reparto'), findsNothing);
    await tester.binding.setSurfaceSize(null);
    state.stopRealtime();
  });

  testWidgets('administración guarda catálogo compartido en la ruta del PWA', (
    tester,
  ) async {
    final requests = <http.Request>[];
    final state = await stateWithMock(requests);
    addTearDown(state.dispose);
    await tester.binding.setSurfaceSize(const Size(1280, 720));
    await tester.pumpWidget(wrap(state, const CompartirScreen()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Agregar').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).at(0), 'Catálogo nuevo');
    await tester.enterText(
      find.byType(TextField).at(1),
      'https://phytoemagryrd.lat/',
    );
    await tester.tap(find.text('Guardar').last);
    await tester.pumpAndSettle();
    final saved = requests
        .where((row) => row.url.path == '/api/admin/settings/chat-sharing')
        .toList();
    expect(saved, hasLength(1));
    final payload = jsonDecode(saved.single.body) as Map<String, dynamic>;
    expect((payload['catalogs'] as List).length, 2);
    await tester.pump(const Duration(seconds: 6));
    state.stopRealtime();
    await tester.binding.setSurfaceSize(null);
  });

  testWidgets('perfil guarda el nombre por la ruta de usuario propio', (
    tester,
  ) async {
    final requests = <http.Request>[];
    final state = await stateWithMock(requests);
    addTearDown(state.dispose);
    await tester.binding.setSurfaceSize(const Size(1280, 720));
    await tester.pumpWidget(wrap(state, const PerfilScreen()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Editar'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'Ana Nueva');
    await tester.tap(find.text('Guardar'));
    await tester.pumpAndSettle();
    final saved = requests
        .where(
          (row) =>
              row.url.path == '/api/admin/users/me' && row.method == 'PATCH',
        )
        .toList();
    expect(saved, hasLength(1));
    expect(jsonDecode(saved.single.body)['displayName'], 'Ana Nueva');
    await tester.pump(const Duration(seconds: 6));
    state.stopRealtime();
    await tester.binding.setSurfaceSize(null);
  });

  testWidgets('seguimiento guarda el día elegido en la configuración real', (
    tester,
  ) async {
    final requests = <http.Request>[];
    final state = await stateWithMock(requests);
    addTearDown(state.dispose);
    await tester.binding.setSurfaceSize(const Size(1280, 720));
    await tester.pumpWidget(wrap(state, const AjustesScreen()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Seguimiento'));
    await tester.pumpAndSettle();
    expect(find.text('Día 1'), findsOneWidget);
    await tester.tap(find.byType(SwitchListTile));
    await tester.pumpAndSettle();
    final saved = requests
        .where(
          (row) =>
              row.url.path == '/api/admin/settings/followup' &&
              row.method == 'POST',
        )
        .toList();
    expect(saved, hasLength(1));
    expect(jsonDecode(saved.single.body)['enabled']['day1'], false);
    await tester.pump(const Duration(seconds: 6));
    state.stopRealtime();
    await tester.binding.setSurfaceSize(null);
  });

  testWidgets('administración edita los teléfonos de un usuario', (
    tester,
  ) async {
    final requests = <http.Request>[];
    final state = await stateWithMock(requests);
    addTearDown(state.dispose);
    await tester.binding.setSurfaceSize(const Size(1280, 720));
    await tester.pumpWidget(wrap(state, const UsuariosScreen()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Luis Reparto'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, 'Teléfono de flota'),
      '+18095550001',
    );
    await tester.tap(find.text('Guardar'));
    await tester.pumpAndSettle();
    final saved = requests
        .where(
          (row) =>
              row.url.path == '/api/admin/users/u2' && row.method == 'PATCH',
        )
        .toList();
    expect(saved, hasLength(1));
    expect(jsonDecode(saved.single.body)['fleetPhone'], '+18095550001');
    await tester.pump(const Duration(seconds: 6));
    state.stopRealtime();
    await tester.binding.setSurfaceSize(null);
  });
}
