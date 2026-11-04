import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/app/crm_scope.dart';
import 'package:fulltech_crm/app/crm_state.dart';
import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/core/theme/crm_theme.dart';
import 'package:fulltech_crm/data/crm_repository.dart';
import 'package:fulltech_crm/features/entregas/reglas_entrega_screen.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  testWidgets('guarda tarifa y comisión en centavos sin activarlas a 1280×720',
      (tester) async {
    tester.view.physicalSize = const Size(1280, 720);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    Map<String, dynamic>? customerRule;
    Map<String, dynamic>? courierRule;
    final api = ApiClient(
      httpClient: MockClient((request) async {
        final path = request.url.path;
        final body = request.body.isEmpty
            ? <String, dynamic>{}
            : jsonDecode(request.body) as Map<String, dynamic>;
        final response = switch (path) {
          '/api/admin/session' => {
              'ok': true,
              'user': {
                'id': 'admin-uat',
                'username': 'admin-uat',
                'display_name': 'Admin UAT',
                'role': 'ADMIN',
              },
            },
          '/api/admin/logistics/companies' => {
              'ok': true,
              'companies': [
                {'id': 'fulltech', 'name': 'Fulltech', 'active': true},
              ],
            },
          '/api/admin/delivery-rules/customer' => request.method == 'POST'
              ? (() {
                  customerRule = (body['policy'] as Map).cast<String, dynamic>();
                  return {'ok': true, 'policy': customerRule};
                })()
              : {'ok': true, 'policy': customerRule},
          '/api/admin/courier-compensation' => request.method == 'POST'
              ? (() {
                  courierRule = {
                    ...(body['policy'] as Map).cast<String, dynamic>(),
                    'company_id': body['company_id'],
                  };
                  return {'ok': true, 'policy': courierRule};
                })()
              : {
                  'ok': true,
                  'policies': courierRule == null ? [] : [courierRule],
                },
          _ => {'ok': true},
        };
        return http.Response(jsonEncode(response), 200,
            headers: {'content-type': 'application/json'});
      }),
      baseUrl: 'http://localhost:4000',
      sessionStore: MemorySessionStore('sesion'),
    );
    await api.restoreSession();
    final state = CrmState(CrmRepository(api));
    await state.reloadSession();
    await tester.pumpWidget(CrmScope(
      state: state,
      child: MaterialApp(
        theme: CrmTheme.build(Brightness.light),
        home: const Scaffold(body: ReglasEntregaScreen()),
      ),
    ));
    await tester.pumpAndSettle();

    Finder field(String label, {int index = 0}) => find.byWidgetPredicate(
      (widget) => widget is TextField && widget.decoration?.labelText == label,
    ).at(index);
    Future<void> enter(String label, String value, {int index = 0}) async {
      final target = field(label, index: index);
      await tester.ensureVisible(target);
      await tester.enterText(target, value);
    }

    expect(find.text('Tarifa al cliente'), findsOneWidget);
    expect(find.text('Pago al repartidor'), findsOneWidget);
    await enter('Cobertura · km', '15');
    await enter('Mínimo · RD\$', '30');
    await enter('Base · RD\$', '50', index: 0);
    await enter('Cobrar por km · RD\$', '20');
    await tester.ensureVisible(find.text('Guardar tarifa'));
    await tester.tap(find.text('Guardar tarifa'));
    await tester.pumpAndSettle();
    expect(customerRule, {
      'active': false,
      'mode': 'per_km',
      'max_meters': 15000,
      'minimum_cents': 3000,
      'base_cents': 5000,
      'per_km_cents': 2000,
    });

    await enter('Base · RD\$', '40', index: 1);
    await enter('Pagar por km · RD\$', '12');
    await enter('Mínimo · RD\$', '60', index: 1);
    await enter('Comisión por productos · %', '3');
    await tester.ensureVisible(find.text('Guardar pago'));
    await tester.tap(find.text('Guardar pago'));
    await tester.pumpAndSettle();
    expect(courierRule, containsPair('company_id', 'fulltech'));
    expect(courierRule, containsPair('active', false));
    expect(courierRule, containsPair('base_model', 'DISTANCE'));
    expect(courierRule, containsPair('distance_base_cents', 4000));
    expect(courierRule, containsPair('distance_per_km_cents', 1200));
    expect(courierRule, containsPair('distance_min_cents', 6000));
    expect(courierRule, containsPair('product_sale_percent', 3.0));
    expect(tester.takeException(), isNull);
    await tester.pump(const Duration(seconds: 10));
    await tester.pumpAndSettle();
  });
}
