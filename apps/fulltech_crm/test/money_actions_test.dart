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

    test('los pedidos que no caben en el paquete ligero se piden a /api/admin/data', () async {
      // `GET /api/admin/orders` NO existe: la UAT responde 404 (comprobado en
      // vivo). El panel PWA pide el paquete completo y filtra en memoria; esto
      // fija ese mismo contrato. OJO: los pedidos SON los `order_intent`
      // (`crm_state.dart:78-79`); filtrarlos al revés devolvía lista vacía.
      final harness = buildClient({
        'ok': true,
        'partial': false,
        'items': [
          {'id': 'o1', 'type': 'order_intent', 'status': 'nuevo'},
          {'id': 'i2', 'type': 'pos_sale', 'status': 'nuevo'},
          {'id': 'o3', 'type': 'order_intent', 'status': 'entregado'},
        ],
      });
      await harness.repo.api.restoreSession();
      final all = await harness.repo.allOrders();
      final request = harness.requests.single;
      expect(request.url.path, '/api/admin/data');
      expect(request.url.queryParameters.containsKey('cursor'), isFalse);
      expect(all.orders.map((row) => row['id']), ['o1', 'o3']);
      expect(all.total, 2);
    });

    test('el listado paginado viaja con límite, cursor y filtros, y trae el total real', () async {
      final harness = buildClient({
        'ok': true,
        'items': [
          {'id': 'o1', 'type': 'order_intent'},
        ],
        'total': 1040,
        'hasMore': true,
        'nextCursor': 'MjAyNi0xMC0yOFQxMDowMDowMC4wMDBafG8x',
      });
      await harness.repo.api.restoreSession();
      final page = await harness.repo.ordersPage(limit: 200, cursor: 'abc', status: 'entregado');
      final request = harness.requests.single;
      expect(request.url.path, '/api/admin/orders');
      expect(request.url.queryParameters['limit'], '200');
      expect(request.url.queryParameters['cursor'], 'abc');
      expect(request.url.queryParameters['status'], 'entregado');
      expect(page.total, 1040, reason: 'total del conjunto filtrado, no de la página');
      expect(page.hasMore, isTrue);
      expect(page.nextCursor, 'MjAyNi0xMC0yOFQxMDowMDowMC4wMDBafG8x');
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

  group('usuarios', () {
    test('editar un usuario manda solo los campos cambiados por PATCH', () async {
      final harness = buildClient({'ok': true, 'user': {'role': 'OPERADOR'}});
      await harness.repo.api.restoreSession();
      await harness.repo.updateUser('u1', displayName: 'Nombre Nuevo', role: 'OPERADOR', active: false);

      final request = harness.requests.single;
      expect(request.url.path, '/api/admin/users/u1');
      expect(request.method, 'PATCH');
      final body = bodyOf(request);
      expect(body['displayName'], 'Nombre Nuevo');
      expect(body['role'], 'OPERADOR');
      expect(body['active'], isFalse);
      // Lo que no se cambia no se envía: el servidor conserva su valor.
      expect(body.containsKey('password'), isFalse);
      expect(body.containsKey('personalPhone'), isFalse);
    });

    test('el último administrador lo bloquea el servidor, no el cliente', () async {
      final harness = buildClient(
        {'ok': false, 'error': 'last_admin', 'message': 'Quedaría el CRM sin administración.'},
        status: 409,
      );
      await harness.repo.api.restoreSession();
      await expectLater(
        harness.repo.updateUser('u1', role: 'AGENT'),
        throwsA(isA<ApiException>()
            .having((e) => e.statusCode, 'status', 409)
            .having((e) => e.code, 'code', 'last_admin')),
      );
    });

    test('crear usuario manda rol y datos, sin tocar la autorización', () async {
      final harness = buildClient({'ok': true, 'user': {'id': 'u9'}});
      await harness.repo.api.restoreSession();
      await harness.repo.createUser(
        username: 'nuevo@uat.local',
        password: 'Clave-2026',
        displayName: 'Nuevo',
        role: 'AGENT',
      );
      final body = bodyOf(harness.requests.single);
      expect(harness.requests.single.url.path, '/api/admin/users');
      expect(body['username'], 'nuevo@uat.local');
      expect(body['role'], 'AGENT');
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
  group('empresas y administración', () {
    test('conceder una empresa usa POST users/:id/companies con companyId y active', () async {
      final harness = buildClient({'ok': true});
      await harness.repo.api.restoreSession();
      await harness.repo.setUserCompany('u1', companyId: 'log_1', active: true);
      final request = harness.requests.single;
      expect(request.url.path, '/api/admin/users/u1/companies');
      expect(request.method, 'POST');
      final body = bodyOf(request);
      expect(body['companyId'], 'log_1');
      expect(body['active'], isTrue);
    });

    test('revocar manda active=false (no borra la concesión)', () async {
      final harness = buildClient({'ok': true});
      await harness.repo.api.restoreSession();
      await harness.repo.setUserCompany('u1', companyId: 'log_1', active: false);
      expect(bodyOf(harness.requests.single)['active'], isFalse);
    });

    test('una empresa inexistente se rechaza en el servidor', () async {
      final harness = buildClient({'ok': false, 'error': 'invalid_company_grant'}, status: 422);
      await harness.repo.api.restoreSession();
      await expectLater(
        harness.repo.setUserCompany('u1', companyId: 'no-existe', active: true),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'invalid_company_grant')),
      );
    });

    test('las resoluciones de caja se leen sin recalcular importes', () async {
      final harness = buildClient({
        'ok': true,
        'resolutions': [
          {'id': 'res:m1', 'movement_id': 'm1', 'justification': 'Cuadra con el recibo', 'status': 'pending_authorization'},
        ],
      });
      await harness.repo.api.restoreSession();
      final rows = await harness.repo.cashResolutions();
      expect(harness.requests.single.url.path, '/api/admin/delivery-cash/resolutions');
      expect(rows, hasLength(1));
      expect(rows.first['status'], 'pending_authorization');
    });

    test('el registro de una revisión lleva justificación y evidencia', () async {
      final harness = buildClient({'ok': true, 'applied': false});
      await harness.repo.api.restoreSession();
      await harness.repo.recordCashResolution(
        movementId: 'm1',
        justification: 'Cuadra con el recibo firmado',
        evidence: 'recibo-2026-10',
      );
      final body = bodyOf(harness.requests.single);
      expect(harness.requests.single.url.path, '/api/admin/delivery-cash/resolutions');
      expect(body['movementId'], 'm1');
      expect((body['justification'] as String).length, greaterThan(9));
      expect(body['evidence'], 'recibo-2026-10');
    });
  });
}
