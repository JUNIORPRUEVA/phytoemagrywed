import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/data/crm_repository.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Cliente con sesión y respuesta fija que apunta lo que le llega.
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
  group('cobros', () {
    test('el cobro lleva saldo esperado, medio y clave de operación', () async {
      final harness = buildClient({'ok': true, 'payment': {'due': 0}});
      await harness.repo.api.restoreSession();

      await harness.repo.registerPayment(
        'o1',
        amount: 12.5,
        method: 'CASH',
        expectedDue: 25,
        note: 'mitad',
        operationKey: 'pay_1234567890abcdef',
      );

      final request = harness.requests.single;
      expect(request.url.path, '/api/admin/orders/o1/payments');
      expect(request.method, 'POST');
      expect(request.headers[ApiClient.operationHeader], 'pay_1234567890abcdef');
      final body = bodyOf(request);
      expect(body['amount'], 12.5);
      expect(body['method'], 'CASH');
      expect(body['expectedDue'], 25);
      expect(body['idempotencyKey'], 'pay_1234567890abcdef');
      expect(body['note'], 'mitad');
    });

    test('el comprobante de una transferencia viaja con el cobro', () async {
      final harness = buildClient({'ok': true, 'payment': {'due': 0}});
      await harness.repo.api.restoreSession();
      await harness.repo.registerPayment(
        'o1',
        amount: 50,
        method: 'TRANSFER',
        expectedDue: 50,
        evidenceUrl: 'TRF-998877',
        operationKey: 'pay_1234567890abcdef',
      );
      expect(bodyOf(harness.requests.single)['evidenceUrl'], 'TRF-998877');
      expect(bodyOf(harness.requests.single)['method'], 'TRANSFER');
    });

    test('verificar y rechazar usan la ruta del cobro', () async {
      for (final decision in ['verified', 'rejected']) {
        final harness = buildClient({'ok': true, 'duplicate': false});
        await harness.repo.api.restoreSession();
        await harness.repo.verifyPayment('o1', 'pay_1', decision: decision, note: 'revisado');
        final request = harness.requests.single;
        expect(request.url.path, '/api/admin/orders/o1/payments/pay_1/verify');
        expect(bodyOf(request)['decision'], decision);
      }
    });

    test('la rendición del pedido va con su importe y su clave', () async {
      final harness = buildClient({'ok': true, 'payment': {'courier': {'pending': 0}}});
      await harness.repo.api.restoreSession();
      await harness.repo.registerHandover('o1', amount: 30, expectedPending: 30, operationKey: 'hov_1234567890abcdef');
      final request = harness.requests.single;
      expect(request.url.path, '/api/admin/orders/o1/payments/handover');
      final body = bodyOf(request);
      expect(body['amount'], 30);
      expect(body['expectedPending'], 30);
      expect(body['idempotencyKey'], 'hov_1234567890abcdef');
    });
  });

  group('pedidos', () {
    test('cancelar una venta entregada pide el motivo', () async {
      final harness = buildClient({'ok': true});
      await harness.repo.api.restoreSession();
      await harness.repo.cancelDeliveredSale('o1', reason: 'Cliente devolvió', operationKey: 'cnl_1234567890abcdef');
      expect(harness.requests.single.url.path, '/api/admin/orders/o1/cancel');
      expect(bodyOf(harness.requests.single)['reason'], 'Cliente devolvió');
    });

    test('editar manda solo lo que cambia y su clave', () async {
      final harness = buildClient({'ok': true, 'order': {'total': 10}});
      await harness.repo.api.restoreSession();
      await harness.repo.updateOrder(
        'o1',
        items: [
          {'variantId': 'v1', 'quantity': 3, 'unitPrice': 5},
        ],
        discount: 1,
        deliveryFee: 0,
        notes: 'nota',
        operationKey: 'ord_1234567890abcdef',
      );
      final request = harness.requests.single;
      expect(request.method, 'PATCH');
      expect(request.url.path, '/api/admin/orders/o1');
      expect(request.headers[ApiClient.operationHeader], 'ord_1234567890abcdef');
      expect(bodyOf(request)['discount'], 1);
      expect(bodyOf(request).containsKey('deliveryLocation'), isFalse);
    });

    test('reparto externo: teléfono del mensajero y envío opcional', () async {
      final harness = buildClient({'ok': true, 'sent': true});
      await harness.repo.api.restoreSession();
      await harness.repo.assignExternalCourier('o1', contactPhone: '+18095551234', autoSend: true);
      expect(harness.requests.single.url.path, '/api/admin/orders/o1/courier/assign');
      final body = bodyOf(harness.requests.single);
      expect(body['contactPhone'], '+18095551234');
      expect(body['autoSend'], isTrue);
    });

    test('incidencia y su resolución usan las rutas del servidor', () async {
      final report = buildClient({'ok': true});
      await report.repo.api.restoreSession();
      await report.repo.reportDeliveryIssue('o1', reason: 'no_response', note: 'no contesta');
      expect(report.requests.single.url.path, '/api/admin/orders/o1/delivery/issue');
      expect(bodyOf(report.requests.single)['reason'], 'no_response');

      final resolve = buildClient({'ok': true});
      await resolve.repo.api.restoreSession();
      await resolve.repo.resolveDeliveryIssue('o1', action: 'resume', note: 'cliente confirmó');
      expect(resolve.requests.single.url.path, '/api/admin/orders/o1/delivery/issue/resolve');
      expect(bodyOf(resolve.requests.single)['action'], 'resume');
    });

    test('la factura por WhatsApp lleva su clave de idempotencia', () async {      final harness = buildClient({'ok': true});
      await harness.repo.api.restoreSession();
      await harness.repo.sendInvoiceWhatsapp('o1', operationKey: 'inv_1234567890abcdef');
      final request = harness.requests.single;
      expect(request.url.path, '/api/admin/orders/o1/invoice-whatsapp');
      expect(bodyOf(request)['idempotencyKey'], 'inv_1234567890abcdef');
    });

    test('la confirmación administrativa de entrega usa su ruta', () async {
      final harness = buildClient({'ok': true, 'order': {'status': 'entregado'}});
      await harness.repo.api.restoreSession();
      await harness.repo.confirmDeliveryByAdmin('o1');
      expect(harness.requests.single.url.path, '/api/admin/orders/o1/delivery/confirm');
      expect(harness.requests.single.method, 'POST');
    });

    test('la paginación viaja con límite y cursor', () async {
      final harness = buildClient({
        'ok': true,
        'orders': [
          {'id': 'o1', 'status': 'nuevo'},
        ],
        'nextCursor': '2026-10-26|o1',
        'total': 183,
      });
      await harness.repo.api.restoreSession();
      final page = await harness.repo.ordersPage(limit: 100, cursor: '2026-10-25|o0');
      final request = harness.requests.single;
      expect(request.url.path, '/api/admin/orders');
      expect(request.url.queryParameters['limit'], '100');
      expect(request.url.queryParameters['cursor'], '2026-10-25|o0');
      expect(page.orders, hasLength(1));
      expect(page.nextCursor, '2026-10-26|o1');
      expect(page.total, 183);
    });

    test('la factura se descarga en PDF, no en HTML', () async {
      final requests = <http.BaseRequest>[];
      final client = MockClient((request) async {
        requests.add(request);
        return http.Response.bytes([37, 80, 68, 70], 200, headers: {'content-type': 'application/pdf'});
      });
      final api = ApiClient(httpClient: client, baseUrl: 'http://localhost:4000', sessionStore: MemorySessionStore('s'));
      await api.restoreSession();
      final file = await CrmRepository(api).orderReceiptFile('o1');
      expect(requests.single.url.path, '/api/admin/orders/o1/factura');
      expect(file.isPdf, isTrue);
    });
  });

  group('custodia', () {
    test('la rendición por cuenta va en centavos', () async {
      final harness = buildClient({'ok': true, 'summary': {}});
      await harness.repo.api.restoreSession();
      await harness.repo.remitDeliveryCash(
        courierAccountId: 'c1',
        amountCents: 12345,
        companyId: 'phytoemagry',
        note: 'entrega',
        operationKey: 'rem_1234567890abcdef',
      );
      final request = harness.requests.single;
      expect(request.url.path, '/api/admin/delivery-cash/remittance');
      final body = bodyOf(request);
      expect(body['amountCents'], 12345);
      expect(body['courierAccountId'], 'c1');
      expect(body['idempotencyKey'], 'rem_1234567890abcdef');
    });

    test('movimientos, incidencias y conciliación son de solo lectura', () async {
      final harness = buildClient({'ok': true, 'movements': [], 'by_company': {}});
      await harness.repo.api.restoreSession();
      await harness.repo.deliveryCashMovements(courierId: 'c1');
      await harness.repo.deliveryCashIncidents(companyId: 'phytoemagry');
      await harness.repo.deliveryCashReconciliation();
      expect(harness.requests.map((row) => row.url.path).toList(), [
        '/api/admin/delivery-cash/movements',
        '/api/admin/delivery-cash/incidents',
        '/api/admin/delivery-cash/reconciliation',
      ]);
      expect(harness.requests.every((row) => row.method == 'GET'), isTrue);
    });

    test('la revisión de un movimiento pide justificación', () async {
      final harness = buildClient({'ok': true, 'applied': false});
      await harness.repo.api.restoreSession();
      await harness.repo.recordCashResolution(movementId: 'm1', justification: 'Cuadra con el banco', evidence: 'extracto');
      expect(harness.requests.single.url.path, '/api/admin/delivery-cash/resolutions');
      final body = bodyOf(harness.requests.single);
      expect(body['movementId'], 'm1');
      expect(body['justification'], 'Cuadra con el banco');
    });
  });

  group('nota de voz', () {
    test('el audio grabado se envía como audio con su tipo real', () async {
      final harness = buildClient({'ok': true});
      await harness.repo.api.restoreSession();
      await harness.repo.sendMedia(
        'c1',
        bytes: [1, 2, 3],
        kind: 'audio',
        filename: 'nota-123.m4a',
        operationKey: 'voc_1234567890abcdef',
      );
      final request = harness.requests.single as http.Request;
      expect(request.url.path, '/api/admin/conversations/c1/media');
      expect(request.url.queryParameters['kind'], 'audio');
      expect(request.headers['content-type'], 'audio/mp4');
      expect(request.bodyBytes, [1, 2, 3]);
    });

    test('en Windows la nota se graba en WAV y se anuncia como tal', () async {
      final harness = buildClient({'ok': true});
      await harness.repo.api.restoreSession();
      await harness.repo.sendMedia('c1', bytes: [0, 1], kind: 'audio', filename: 'nota-123.wav');
      expect(harness.requests.single.headers['content-type'], 'audio/wav');
    });
  });
}
