import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/app/crm_scope.dart';
import 'package:fulltech_crm/app/crm_state.dart';
import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/core/theme/crm_theme.dart';
import 'package:fulltech_crm/data/crm_repository.dart';
import 'package:fulltech_crm/features/entregas/mapa_screen.dart';
import 'package:fulltech_crm/features/entregas/repartidores_screen.dart';
import 'package:fulltech_crm/features/entregas/custodia_screen.dart';
import 'package:fulltech_crm/features/entregas/supervisor_screen.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => initializeDateFormatting('es'));

  Future<CrmState> fakeState({bool legacyTracking = false}) async {
    SharedPreferences.setMockInitialValues({});
    final api = ApiClient(
      httpClient: MockClient((request) async {
        final path = request.url.path;
        if (legacyTracking && path == '/api/admin/delivery-courier-positions') {
          return http.Response('{"ok":false}', 404);
        }
        final body = switch (path) {
          '/api/admin/data' => {
            'ok': true,
            'deliveryOrders': [
              {
                'id': 'o1',
                'order_number': 'PE-123',
                'status': 'nuevo',
                'customer': {'name': 'Cliente de prueba'},
                'delivery': {
                  'delivery_user_id': 'r1',
                  'address': 'Santo Domingo',
                  'location': {'latitude': 18.49, 'longitude': -69.93},
                },
              },
            ],
            'deliveryTracking': legacyTracking
                ? [
                    {
                      'id': 's1',
                      'order_id': 'o1',
                      'delivery_user_name': 'Ana legado',
                      'status': 'ACTIVE',
                      'last_position': {
                        'latitude': 18.48,
                        'longitude': -69.94,
                        'at': DateTime.now().toIso8601String(),
                      },
                    },
                  ]
                : [],
          },
          '/api/admin/delivery-courier-positions' => {
            'ok': true,
            'positions': [
              {
                'courier_id': 'r1',
                'courier_name': 'Ana Reparto',
                'state': 'live',
                'age_seconds': 8,
                'latitude': 18.48,
                'longitude': -69.94,
                'order_ids': ['o1'],
              },
            ],
          },
          '/api/admin/delivery-tracking' => {
            'ok': true,
            'sessions': legacyTracking
                ? [
                    {
                      'id': 's1',
                      'order_id': 'o1',
                      'delivery_user_name': 'Ana legado',
                      'status': 'ACTIVE',
                      'last_position': {
                        'latitude': 18.48,
                        'longitude': -69.94,
                        'at': DateTime.now().toIso8601String(),
                      },
                    },
                  ]
                : [],
          },
          '/api/admin/courier-applications' => {'ok': true, 'applications': []},
          '/api/admin/couriers' => {
            'ok': true,
            'couriers': [
              {
                'id': 'r1',
                'display_name': 'Ana Reparto',
                'company_id': 'phytoemagry',
                'kind': 'EXTERNAL',
                'app_access': true,
                'active': true,
              },
            ],
          },
          '/api/admin/delivery-cash' => {
            'ok': true,
            'couriers': [
              {
                'courier_id': 'r1',
                'courier_name': 'Ana Reparto',
                'orders_count': 1,
                'charged_cents': 200000,
                'remitted_cents': 100000,
                'pending_cents': 100000,
              },
            ],
          },
          '/api/admin/delivery-cash/movements' => {'ok': true, 'movements': []},
          '/api/admin/delivery-cash/reconciliation' => {'ok': true},
          '/api/admin/delivery-supervisor' => {
            'ok': true,
            'enabled': true,
            'counts': {'en_camino': 1},
            'upcoming': [],
            'activity': [],
          },
          '/api/admin/ops/chats' => {
            'ok': true,
            'chats': [
              {
                'ticketId': 't1',
                'orderNumber': 'PE-123',
                'courierName': 'Ana Reparto',
                'customerName': 'Cliente de prueba',
              },
            ],
          },
          '/api/admin/ops/tickets/t1' => {
            'ok': true,
            'messages': [
              {
                'seq': 1,
                'body': 'Voy en camino',
                'authorName': 'Ana Reparto',
                'authorType': 'courier',
                'createdAt': '2026-11-03T10:00:00Z',
                'meta': {'channel': 'whatsapp', 'direction': 'inbound'},
              },
              {
                'seq': 2,
                'body': 'Seguimiento registrado',
                'authorName': 'Supervisor IA',
                'authorType': 'agent',
                'createdAt': '2026-11-03T10:01:00Z',
                'meta': {'channel': 'internal'},
              },
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
      baseUrl: 'http://localhost:4000',
      sessionStore: MemorySessionStore('sesion'),
    );
    await api.restoreSession();
    final state = CrmState(CrmRepository(api));
    await state.refresh(quiet: true);
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
    'el mapa conserva la mayor parte del alto en una pantalla de 11 pulgadas',
    (tester) async {
      final state = await fakeState();
      for (final size in [
        const Size(1280, 720),
        const Size(1366, 768),
        const Size(1920, 1080),
      ]) {
        tester.view.physicalSize = size;
        tester.view.devicePixelRatio = 1;
        await tester.pumpWidget(wrap(state, const MapaScreen()));
        await tester.pump(const Duration(milliseconds: 100));
        expect(
          tester.getSize(find.byType(FlutterMap)).height,
          greaterThan(size.height * 0.52),
        );
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
      }
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
        state.dispose();
      });
    },
  );

  testWidgets('el supervisor distingue conversación externa y nota interna', (
    tester,
  ) async {
    final state = await fakeState();
    tester.view.physicalSize = const Size(1366, 768);
    tester.view.devicePixelRatio = 1;
    await tester.pumpWidget(wrap(state, const SupervisorScreen()));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('PE-123'), findsOneWidget);
    await tester.tap(find.text('PE-123'));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Voy en camino'), findsOneWidget);
    expect(find.text('Seguimiento registrado'), findsOneWidget);
    expect(find.textContaining('Nota interna · no enviada'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
      state.dispose();
    });
  });

  testWidgets('mantiene el seguimiento activo si UAT no ofrece el GPS nuevo', (
    tester,
  ) async {
    final state = await fakeState(legacyTracking: true);
    tester.view.physicalSize = const Size(1366, 768);
    tester.view.devicePixelRatio = 1;
    await tester.pumpWidget(wrap(state, const MapaScreen()));
    await tester.pump(const Duration(milliseconds: 150));
    expect(find.text('Ana legado'), findsOneWidget);
    expect(find.textContaining('con señal'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
      state.dispose();
    });
  });

  testWidgets('repartidores y custodia mantienen sus acciones en 1280×720', (
    tester,
  ) async {
    final state = await fakeState();
    tester.view.physicalSize = const Size(1280, 720);
    tester.view.devicePixelRatio = 1;
    await tester.pumpWidget(wrap(state, const RepartidoresScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Ana Reparto'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(wrap(state, const CustodiaScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Ana Reparto'), findsOneWidget);
    expect(find.byTooltip('Ver movimientos'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
      state.dispose();
    });
  });
}
