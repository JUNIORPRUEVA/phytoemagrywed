import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/core/format/crm_format.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/data/crm_repository.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_customer_panels.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_order_live_map.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:intl/date_symbol_data_local.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => initializeDateFormatting('es'));

  for (final size in [
    const Size(1280, 720),
    const Size(1366, 768),
    const Size(1920, 1080),
  ]) {
    testWidgets('Pedidos muestra domicilio y repartidor en $size', (
      tester,
    ) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final now = DateTime.now().toUtc().toIso8601String();
      final api = ApiClient(
        httpClient: MockClient((request) async {
          final body = switch (request.url.path) {
            '/api/admin/customers/cus_1' => {
              'customer': {'name': 'Bernarda'},
              'purchases': [
                {'id': 'ord_1', 'status': 'nuevo', 'created_at': now},
              ],
            },
            '/api/admin/orders/ord_1' => {
              'order': {
                'id': 'ord_1',
                'order_number': 'PE-123',
                'status': 'nuevo',
                'created_at': now,
                'total': 5000,
                'subtotal': 5000,
                'delivery_fee': 350,
                'items': [
                  {'label': 'Producto', 'quantity': 1, 'total': 5000},
                ],
                'delivery': {
                  'method': 'delivery',
                  'location': {
                    'latitude': 18.48,
                    'longitude': -69.9,
                    'name': 'Casa de Bernarda',
                  },
                },
              },
            },
            '/api/admin/delivery-tracking' => {
              'sessions': [
                {
                  'id': 'trk_1',
                  'order_id': 'ord_1',
                  'status': 'ACTIVE',
                  'delivery_user_name': 'Rubén',
                  'last_position': {
                    'latitude': 18.47,
                    'longitude': -69.91,
                    'recorded_at': now,
                  },
                },
              ],
            },
            _ => <String, dynamic>{},
          };
          return http.Response(
            jsonEncode({'ok': true, ...body}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
        baseUrl: 'http://localhost:4000',
        sessionStore: MemorySessionStore('sesion'),
      );
      final repository = CrmRepository(api);
      final panelWidth = (size.width * .30).clamp(280.0, 460.0);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.centerRight,
              child: ChatOrdersPanel(
                width: panelWidth,
                onClose: () {},
                repository: repository,
                customerId: 'cus_1',
                customerName: 'Bernarda',
              ),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.byType(ChatOrderLiveMap), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('Total general'),
        120,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text(CrmFormat.money(5350)), findsWidgets);
      await tester.scrollUntilVisible(
        find.textContaining('Edita y guarda el pedido'),
        80,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.textContaining('Edita y guarda el pedido'), findsOneWidget);
      expect(find.byType(FlutterMap), findsOneWidget);
      expect(find.byIcon(Icons.home_rounded), findsWidgets);
      expect(find.byIcon(Icons.delivery_dining_rounded), findsWidgets);
      expect(find.textContaining('Rubén · en vivo'), findsOneWidget);
      expect(find.byTooltip('Acercar mapa'), findsOneWidget);
      expect(find.byTooltip('Alejar mapa'), findsOneWidget);

      final panel = tester.getSize(find.byType(ChatOrdersPanel));
      final map = tester.getSize(find.byType(ChatOrderLiveMap));
      expect(panel.width, panelWidth);
      expect(map.height, greaterThan(size.height * .45));
      await tester.tap(find.byTooltip('Acercar mapa'));
      await tester.pump();
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  }

  for (final size in [
    const Size(1280, 720),
    const Size(1366, 768),
    const Size(1920, 1080),
  ]) {
    testWidgets('ficha compacta sin desplazamiento en $size', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      final api = ApiClient(
        httpClient: MockClient(
          (request) async => http.Response(
            jsonEncode({
              'ok': true,
              'customer': {
                'id': 'cus_1',
                'name': 'Bernarda',
                'phone_e164': '+18296700804',
                'location': 'Santo Domingo',
                'customer_stage': 'INTERESADO',
                'notes': 'Entregar por la tarde.',
              },
              'totals': {
                'total_purchases': 2,
                'total_spent': 5000,
                'open_purchases': 1,
              },
              'lastLocation': {
                'latitude': 18.48,
                'longitude': -69.9,
                'name': 'Casa',
                'created_at': '2026-11-02T12:00:00Z',
              },
              'history': [],
              'scheduled': [],
            }),
            200,
            headers: {'content-type': 'application/json'},
          ),
        ),
        baseUrl: 'http://localhost:4000',
        sessionStore: MemorySessionStore('sesion'),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.centerRight,
              child: ChatCustomerPanel(
                width: (size.width * .42).clamp(440.0, 680.0),
                onClose: () {},
                repository: CrmRepository(api),
                customerId: 'cus_1',
              ),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('CONTACTO'), findsOneWidget);
      expect(find.text('ACTIVIDAD'), findsOneWidget);
      expect(find.text('UBICACIÓN'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(ChatCustomerPanel),
          matching: find.byType(ListView),
        ),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  }
}
