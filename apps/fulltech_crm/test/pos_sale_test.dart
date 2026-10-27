import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/core/pos/pos_sale.dart';

PosLine line(String id, int cents, int quantity) => PosLine(
      variantId: id,
      productName: 'Producto',
      presentationName: 'Presentación',
      unitPriceCents: cents,
      quantity: quantity,
    );

void main() {
  group('total esperado (mismas reglas que el servidor)', () {
    test('suma importes por línea en centavos', () {
      final draft = PosSaleDraft(
        mode: 'order',
        customerId: 'c1',
        lines: [line('a', 125050, 2), line('b', 999, 3)],
      );
      expect(draft.subtotalCents, 125050 * 2 + 999 * 3);
      expect(draft.expectedTotalCents, 250100 + 2997);
    });

    test('el envío se suma en centavos, sin decimales sueltos', () {
      final draft = PosSaleDraft(
        mode: 'invoice',
        customerId: 'c1',
        lines: [line('a', 10000, 1)],
        deliveryFeeCents: 15050,
      );
      expect(draft.expectedTotalCents, 25050);
    });

    test('expectedTotal viaja como entero en el cuerpo', () {
      final draft = PosSaleDraft(
        mode: 'order',
        customerId: 'c1',
        lines: [line('a', 10000, 2)],
        deliveryFeeCents: 5000,
        address: 'Calle 1',
      );
      final body = draft.toCheckoutBody(requestId: 'pos_1234567890123456');
      expect(body['expectedTotal'], 25000);
      expect(body['expectedTotal'], isA<int>());
      expect(body['deliveryFee'], 50.0);
      expect(body['items'], [
        {'variantId': 'a', 'quantity': 2},
      ]);
    });
  });

  group('idempotencia de la operación', () {
    test('el mismo borrador conserva el requestId al reintentar', () {
      final operation = PosOperation(keyFactory: () => 'pos_fixed_key_0001');
      final draft = PosSaleDraft(mode: 'order', customerId: 'c1', lines: [line('a', 10000, 1)]);

      final first = operation.requestIdFor(draft);
      final second = operation.requestIdFor(draft);

      expect(first, second);
      expect(operation.attempts, 2);
    });

    test('cambiar el contenido genera OTRA operación', () {
      var counter = 0;
      final operation = PosOperation(keyFactory: () => 'pos_generated_${++counter}_abcdef');
      final base = PosSaleDraft(mode: 'order', customerId: 'c1', lines: [line('a', 10000, 1)]);

      final first = operation.requestIdFor(base);
      final changed = PosSaleDraft(
        mode: 'order',
        customerId: 'c1',
        lines: [line('a', 10000, 2)],
      );
      final second = operation.requestIdFor(changed);

      expect(first, isNot(second));
    });

    test('cambiar solo el envío también cuenta como otra operación', () {
      var counter = 0;
      final operation = PosOperation(keyFactory: () => 'pos_generated_${++counter}_abcdef');
      final base = PosSaleDraft(mode: 'order', customerId: 'c1', lines: [line('a', 10000, 1)]);
      final first = operation.requestIdFor(base);
      final withFee = PosSaleDraft(
        mode: 'order',
        customerId: 'c1',
        lines: [line('a', 10000, 1)],
        deliveryFeeCents: 5000,
      );
      final after = operation.requestIdFor(withFee);
      expect(after, isNot(first));
    });

    test('después de cobrar, la siguiente venta usa otra clave', () {
      var counter = 0;
      final operation = PosOperation(keyFactory: () => 'pos_generated_${++counter}_abcdef');
      final draft = PosSaleDraft(mode: 'order', customerId: 'c1', lines: [line('a', 10000, 1)]);

      final first = operation.requestIdFor(draft);
      operation.reset();
      final second = operation.requestIdFor(draft);

      expect(first, isNot(second));
    });

    test('la clave cumple el contrato del servidor', () {
      final operation = PosOperation(keyFactory: () => 'clave con espacios y ñ');
      final key = operation.requestIdFor(PosSaleDraft(mode: 'order', customerId: 'c1', lines: [line('a', 1, 1)]));
      expect(ApiClient.operationKeyPattern.hasMatch(key), isTrue);
      expect(key.length, greaterThanOrEqualTo(16));
    });
  });

  group('clasificación de errores del servidor', () {
    test('sin respuesta es INCIERTO (nunca se repite a ciegas)', () {
      final outcome = PosOutcome.fromError(ApiException(0, 'sin red'));
      expect(outcome.kind, PosOutcomeKind.uncertain);
      expect(outcome.ok, isFalse);
    });

    test('price_changed no registra nada', () {
      final outcome = PosOutcome.fromError(ApiException(409, 'Los precios cambiaron.', code: 'price_changed'));
      expect(outcome.kind, PosOutcomeKind.priceChanged);
      expect(outcome.ok, isFalse);
    });

    test('open_orders pide confirmación explícita', () {
      final outcome = PosOutcome.fromError(ApiException(409, 'Pedido abierto', code: 'open_orders'));
      expect(outcome.kind, PosOutcomeKind.openOrdersRequiresAck);
    });

    test('un rechazo de datos es rechazo, no incierto', () {
      final outcome = PosOutcome.fromError(ApiException(422, 'Falta el cliente.', code: 'invalid_customer'));
      expect(outcome.kind, PosOutcomeKind.rejected);
    });

    test('el envoltorio de idempotencia del servidor se trata como INCIERTO', () {
      final uncertain = PosOutcome.fromError(
        ApiException(409, 'El resultado necesita revisión.', code: 'offline_operation_uncertain'),
      );
      expect(uncertain.kind, PosOutcomeKind.uncertain);

      final reused = PosOutcome.fromError(
        ApiException(409, 'Esta operación tiene otros datos.', code: 'operation_reused'),
      );
      expect(reused.kind, PosOutcomeKind.uncertain);
    });

    test('respuesta correcta puede venir marcada como duplicada', () {
      final created = PosOutcome.fromResponse({
        'ok': true,
        'document': {'id': 'pos_1', 'number': 'F-1', 'sale': {'total_cents': 25000}},
      });
      expect(created.kind, PosOutcomeKind.created);
      expect(created.documentNumber, 'F-1');
      expect(created.totalCents, 25000);

      final duplicate = PosOutcome.fromResponse({
        'ok': true,
        'duplicate': true,
        'document': {'id': 'pos_1', 'number': 'F-1'},
      });
      expect(duplicate.kind, PosOutcomeKind.duplicate);
      expect(duplicate.ok, isTrue);
    });
  });

  group('validación del borrador', () {
    test('sin cliente no se cobra', () {
      final draft = PosSaleDraft(mode: 'order', customerId: '', lines: [line('a', 1, 1)]);
      expect(draft.validate(), isNotNull);
    });

    test('sin artículos no se cobra', () {
      final draft = PosSaleDraft(mode: 'order', customerId: 'c1', lines: const []);
      expect(draft.validate(), isNotNull);
    });

    test('a domicilio exige dirección, pero una cotización no', () {
      final order = PosSaleDraft(mode: 'order', customerId: 'c1', lines: [line('a', 1, 1)]);
      expect(order.validate(), contains('dirección'));
      final quote = PosSaleDraft(mode: 'quote', customerId: 'c1', lines: [line('a', 1, 1)]);
      expect(quote.validate(), isNull);
    });
  });
}
