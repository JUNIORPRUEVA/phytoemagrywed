import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/data/crm_repository.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Contrato de las cuatro escrituras de inventario.
///
/// Rutas, métodos y campos comprobados **en vivo** contra la UAT local
/// (2026-10-28): `restock` 201, `adjust` 200, `count` 200, `cost` 200,
/// salida excesiva 409 `insufficient_stock`, cantidad 0 → 422, reintento con la
/// misma clave → sin duplicar, y rol AGENT → 403 `forbidden`.
({CrmRepository repo, List<http.BaseRequest> requests}) buildClient(Map<String, dynamic> body, {int status = 200}) {
  final requests = <http.BaseRequest>[];
  final client = MockClient((request) async {
    requests.add(request);
    return http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});
  });
  final api = ApiClient(
    httpClient: client,
    baseUrl: 'http://localhost:4000',
    sessionStore: MemorySessionStore('sesion'),
  );
  return (repo: CrmRepository(api), requests: requests);
}

Map<String, dynamic> bodyOf(http.BaseRequest request) =>
    (request is http.Request && request.body.isNotEmpty) ? jsonDecode(request.body) as Map<String, dynamic> : const {};

void main() {
  group('inventario: reposición y ajustes', () {
    test('la reposición manda cantidad, costo, motivo y clave de idempotencia', () async {
      final harness = buildClient({'ok': true, 'inventory': {'stock': 605}});
      await harness.repo.api.restoreSession();

      final result = await harness.repo.restockInventory(
        quantity: 100,
        unitCost: 130.5,
        reason: 'Reposición de octubre',
        operationKey: 'rst_1234567890abcdef',
      );

      final request = harness.requests.single;
      expect(request.url.path, '/api/admin/inventory/restock');
      expect(request.method, 'POST');
      expect(request.headers[ApiClient.operationHeader], 'rst_1234567890abcdef');
      final body = bodyOf(request);
      expect(body['quantity'], 100);
      expect(body['unitCost'], 130.5);
      expect(body['reason'], 'Reposición de octubre');
      expect(body['idempotencyKey'], 'rst_1234567890abcdef');
      expect(result['inventory']['stock'], 605);
    });

    test('el ajuste distingue entrada y salida con `direction`', () async {
      final outgoing = buildClient({'ok': true, 'inventory': {'stock': 95}});
      await outgoing.repo.api.restoreSession();
      await outgoing.repo.adjustInventory(
        incoming: false,
        quantity: 5,
        reason: 'Merma',
        operationKey: 'adj_1234567890abcdef',
      );
      expect(outgoing.requests.single.url.path, '/api/admin/inventory/adjust');
      expect(bodyOf(outgoing.requests.single)['direction'], 'out');

      final incoming = buildClient({'ok': true, 'inventory': {'stock': 105}});
      await incoming.repo.api.restoreSession();
      await incoming.repo.adjustInventory(
        incoming: true,
        quantity: 5,
        operationKey: 'adj_1234567890abcdeg',
      );
      expect(bodyOf(incoming.requests.single)['direction'], 'in');
    });

    test('el ajuste no envía costo si no se indicó (no inventa un valor)', () async {
      final harness = buildClient({'ok': true, 'inventory': {'stock': 95}});
      await harness.repo.api.restoreSession();
      await harness.repo.adjustInventory(incoming: false, quantity: 5, operationKey: 'adj_1234567890abcdef');
      expect(bodyOf(harness.requests.single).containsKey('unitCost'), isFalse);
    });
  });

  group('inventario: recuento y costo', () {
    test('el recuento manda la cantidad contada, no la diferencia', () async {
      // La diferencia y el saldo final los calcula el servidor. Aquí se comprueba
      // que el cliente NO calcula: solo manda lo contado.
      final harness = buildClient({'ok': true, 'inventory': {'stock': 400}});
      await harness.repo.api.restoreSession();
      await harness.repo.countInventory(
        countedQuantity: 400,
        reason: 'Recuento físico',
        operationKey: 'cnt_1234567890abcdef',
      );
      final body = bodyOf(harness.requests.single);
      expect(harness.requests.single.url.path, '/api/admin/inventory/count');
      expect(body['countedQuantity'], 400);
      expect(body.containsKey('delta'), isFalse);
      expect(body.containsKey('stock'), isFalse);
    });

    test('el costo unitario va como importe decimal', () async {
      final harness = buildClient({'ok': true, 'inventory': {'inventory_value_cents': 5066400}});
      await harness.repo.api.restoreSession();
      await harness.repo.updateInventoryCost(unitCost: 126.66, operationKey: 'cst_1234567890abcdef');
      expect(harness.requests.single.url.path, '/api/admin/inventory/cost');
      expect(bodyOf(harness.requests.single)['unitCost'], 126.66);
    });
  });

  group('inventario: errores del servidor', () {
    test('un 403 de rol no se confunde con un fallo de red', () async {
      final harness = buildClient({'ok': false, 'error': 'forbidden', 'message': 'No tienes permiso para esta acción.'}, status: 403);
      await harness.repo.api.restoreSession();
      await expectLater(
        harness.repo.restockInventory(quantity: 5, operationKey: 'rst_1234567890abcdef'),
        throwsA(isA<ApiException>()
            .having((e) => e.statusCode, 'status', 403)
            .having((e) => e.code, 'code', 'forbidden')
            .having((e) => e.isUncertain, 'incierto', isFalse)),
      );
    });

    test('stock insuficiente llega con su código y su mensaje', () async {
      final harness = buildClient(
        {'ok': false, 'error': 'insufficient_stock', 'message': 'Stock insuficiente.'},
        status: 409,
      );
      await harness.repo.api.restoreSession();
      await expectLater(
        harness.repo.adjustInventory(incoming: false, quantity: 999999, operationKey: 'adj_1234567890abcdef'),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'insufficient_stock')),
      );
    });
  });
}
