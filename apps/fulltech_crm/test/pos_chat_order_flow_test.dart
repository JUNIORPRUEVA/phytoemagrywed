import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/app/crm_scope.dart';
import 'package:fulltech_crm/app/crm_state.dart';
import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/data/crm_repository.dart';
import 'package:fulltech_crm/features/ventas/pos_launch_context.dart';
import 'package:fulltech_crm/features/ventas/pos_screen.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:intl/date_symbol_data_local.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => initializeDateFormatting('es'));

  testWidgets('editar desde chat precarga y actualiza el mismo pedido', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1280, 720);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final patches = <Map<String, dynamic>>[];
    final requests = <String>[];
    String? destination;
    final api = ApiClient(
      httpClient: MockClient((request) async {
        requests.add('${request.method} ${request.url.path}');
        final response = switch (request.url.path) {
          '/api/admin/session' => {
            'user': {
              'id': 'admin',
              'role': 'ADMIN',
              'username': 'admin',
              'display_name': 'Admin',
            },
          },
          '/api/admin/catalog' => {'catalog': [], 'inventory': {}},
          '/api/admin/suppliers' => {'suppliers': []},
          '/api/admin/product-suppliers' => {'links': []},
          '/api/admin/customers/cus_1' => {
            'customer': {
              'id': 'cus_1',
              'name': 'Bernarda',
              'phone_e164': '+18296700804',
            },
          },
          '/api/admin/pos/context/cus_1' => {
            'openOrders': [
              {'id': 'ord_1', 'number': 'PE-123', 'status': 'nuevo'},
            ],
          },
          '/api/admin/orders/ord_1' =>
            request.method == 'PATCH'
                ? (() {
                    patches.add(
                      jsonDecode(request.body) as Map<String, dynamic>,
                    );
                    return {
                      'order': {'id': 'ord_1', 'total': 5350},
                    };
                  })()
                : {
                    'order': {
                      'id': 'ord_1',
                      'customer_id': 'cus_1',
                      'order_number': 'PE-123',
                      'status': 'nuevo',
                      'items': [
                        {
                          'variantId': 'v1',
                          'variantName': 'Cinco cápsulas',
                          'quantity': 2,
                          'unitPrice': 1250,
                          'subtotal': 2500,
                        },
                        {
                          'variantId': 'v2',
                          'variantName': 'Diez cápsulas',
                          'quantity': 1,
                          'unitPrice': 2500,
                          'subtotal': 2500,
                        },
                      ],
                      'subtotal': 5000,
                      'delivery_fee': 350,
                      'total': 5000,
                      'payment_method': 'CASH',
                      'delivery': {
                        'method': 'delivery',
                        'address': 'Villa Cerro',
                      },
                    },
                  },
          '/api/admin/data' => {'customers': [], 'conversations': []},
          _ => <String, dynamic>{},
        };
        return http.Response(
          jsonEncode({'ok': true, ...response}),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
      baseUrl: 'http://localhost:4000',
      sessionStore: MemorySessionStore('sesion'),
    );
    await api.restoreSession();
    final state = CrmState(CrmRepository(api));
    await state.reloadSession();
    await tester.pumpWidget(
      CrmScope(
        state: state,
        child: MaterialApp(
          home: Scaffold(
            body: PosScreen(
              embedded: true,
              desktop: true,
              initialSale: const PosLaunchContext(
                customerId: 'cus_1',
                conversationId: 'chat_1',
                mode: 'order',
                orderId: 'ord_1',
              ),
              onNavigate: (tab) => destination = tab,
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.textContaining('Cinco cápsulas'), findsWidgets);
    expect(find.text('Continuar'), findsOneWidget);
    expect(requests, contains('GET /api/admin/orders/ord_1'));
    expect(requests.where((r) => r == 'POST /api/admin/pos/tickets'), isEmpty);

    await tester.tap(find.text('Continuar'));
    await tester.pumpAndSettle();
    expect(find.text('Revisar pedido'), findsNothing);
    expect(find.textContaining('Total del cliente:'), findsOneWidget);
    await tester.tap(find.text('Guardar y volver al chat'));
    await tester.pumpAndSettle();
    expect(patches, hasLength(1));
    expect(patches.single['deliveryFee'], 350.0);
    expect(patches.single['discount'], 0.0);
    expect((patches.single['items'] as List).length, 2);
    expect(destination, 'whatsapp');
    expect(requests.where((r) => r == 'POST /api/admin/pos/checkout'), isEmpty);
  });

  testWidgets('pedido nuevo pregunta si continuar uno abierto', (tester) async {
    tester.view.physicalSize = const Size(1280, 720);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final requests = <String>[];
    final api = ApiClient(
      httpClient: MockClient((request) async {
        requests.add('${request.method} ${request.url.path}');
        final response = switch (request.url.path) {
          '/api/admin/session' => {
            'user': {'id': 'admin', 'role': 'ADMIN'},
          },
          '/api/admin/catalog' => {'catalog': [], 'inventory': {}},
          '/api/admin/suppliers' => {'suppliers': []},
          '/api/admin/product-suppliers' => {'links': []},
          '/api/admin/customers/cus_1' => {
            'customer': {'id': 'cus_1', 'name': 'Bernarda'},
          },
          '/api/admin/pos/context/cus_1' => {
            'openOrders': [
              {'id': 'ord_1', 'number': 'PE-123', 'status': 'nuevo'},
            ],
          },
          '/api/admin/orders/ord_1' => {
            'order': {
              'id': 'ord_1',
              'customer_id': 'cus_1',
              'order_number': 'PE-123',
              'status': 'nuevo',
              'items': [
                {
                  'variantId': 'v1',
                  'variantName': 'Cinco cápsulas',
                  'quantity': 2,
                  'unitPrice': 1250,
                  'subtotal': 2500,
                },
              ],
              'delivery': {'method': 'pickup'},
            },
          },
          _ => <String, dynamic>{},
        };
        return http.Response(
          jsonEncode({'ok': true, ...response}),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
      baseUrl: 'http://localhost:4000',
      sessionStore: MemorySessionStore('sesion'),
    );
    await api.restoreSession();
    final state = CrmState(CrmRepository(api));
    await state.reloadSession();
    await tester.pumpWidget(
      CrmScope(
        state: state,
        child: MaterialApp(
          home: Scaffold(
            body: PosScreen(
              embedded: true,
              desktop: true,
              initialSale: const PosLaunchContext(
                customerId: 'cus_1',
                conversationId: 'chat_1',
                mode: 'order',
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump(const Duration(milliseconds: 500));
    expect(
      find.text('Este cliente ya tiene un pedido abierto'),
      findsOneWidget,
    );
    expect(find.text('Crear uno nuevo'), findsOneWidget);
    await tester.tap(find.text('PE-123'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Cinco cápsulas'), findsWidgets);
    expect(requests.where((r) => r == 'POST /api/admin/pos/tickets'), isEmpty);
  });
}
