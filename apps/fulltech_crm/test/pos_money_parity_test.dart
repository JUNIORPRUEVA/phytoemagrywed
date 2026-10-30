import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/pos/pos_sale.dart';

/// PARIDAD DE DINERO JS ↔ DART.
///
/// Los mismos casos (`test/fixtures/pos_money_cases.json`) los ejecuta:
///   - este archivo (Dart, `PosSaleDraft.expectedTotalCents`), y
///   - `tool/verify-pos-money.mjs` (Node, `public/admin/pos-math.js`, el módulo
///     que usa el servidor de verdad).
///
/// Si los dos lados no coinciden, el servidor responde 409 `price_changed` y la
/// venta no se cierra. Por eso el cálculo NO se reimplementa aquí: se comprueba
/// contra los importes esperados del fixture.
void main() {
  final file = File('test/fixtures/pos_money_cases.json');
  final fixture = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
  final cases = (fixture['cases'] as List).cast<Map<String, dynamic>>();

  PosSaleDraft draftFor(Map<String, dynamic> testCase) {
    final lines = (testCase['lines'] as List).cast<Map<String, dynamic>>().map((line) {
      final manual = line['manual'] as Map<String, dynamic>?;
      final unit = manual != null
          ? ((manual['price'] as num).toDouble() * 100).round()
          : line['unitPriceCents'] as int;
      final quantity = line['quantity'] as int;
      final discount = line['discount'] as Map?;
      return PosLine(
        variantId: line['variantId'] as String,
        productName: manual?['name'] as String? ?? 'Producto ${line['variantId']}',
        presentationName: unit.toString(),
        unitPriceCents: unit,
        quantity: quantity,
        discountType: discount?['type'] as String? ?? 'none',
        discountValue: (discount?['value'] as num?)?.toDouble() ?? 0,
        manualName: manual?['name'] as String?,
        manualKind: manual?['kind'] as String?,
        manualPrice: (manual?['price'] as num?)?.toDouble(),
        manualCost: (manual?['cost'] as num?)?.toDouble(),
      );
    }).toList();
    return PosSaleDraft(
      mode: 'invoice',
      customerId: 'cliente_prueba',
      lines: lines,
      deliveryFeeCents: testCase['deliveryFeeCents'] as int,
      paymentMethod: 'CASH',
      paid: true,
      address: 'Dirección de prueba 123',
      discountType: (testCase['discount'] as Map?)?['type'] as String? ?? 'none',
      discountValue: ((testCase['discount'] as Map?)?['value'] as num?)?.toDouble() ?? 0,
    );
  }

  group('dinero del POS: casos compartidos con pos-math.js', () {
    for (final testCase in cases) {
      final name = testCase['name'] as String;
      final expected = testCase['expected'] as Map<String, dynamic>;

      test(name, () {
        final draft = draftFor(testCase);
        expect(draft.subtotalCents, expected['subtotalCents'], reason: 'subtotal de «$name»');
        expect(draft.deliveryFeePesos, expected['deliveryFeePesos'], reason: 'envío en pesos de «$name»');
        if (expected['discountCents'] != null) {
          expect(draft.discountCents, expected['discountCents'], reason: 'descuento de «$name»');
        }
        if (expected['lineDiscountCents'] != null) {
          final lineDiscount = draft.lines.fold<int>(0, (sum, line) => sum + line.lineDiscountCents);
          expect(lineDiscount, expected['lineDiscountCents'], reason: 'descuento de línea de «$name»');
        }
        expect(draft.expectedTotalCents, expected['totalCents'], reason: 'total de «$name»');
      });
    }
  });

  group('contrato del cuerpo enviado al servidor', () {    test('expectedTotal y deliveryFee viajan como enteros', () {
      for (final testCase in cases) {
        final body = draftFor(testCase).toCheckoutBody(requestId: 'pos_prueba_0000000001');
        expect(body['expectedTotal'], isA<int>(), reason: 'expectedTotal debe ser entero (${testCase['name']})');
        expect(body['deliveryFee'], isA<int>(), reason: 'deliveryFee debe ser entero (${testCase['name']})');
        expect(body['items'], hasLength((testCase['lines'] as List).length));
      }
    });

    test('la cotización manda el mismo expectedTotal que el cobro', () {
      for (final testCase in cases) {
        final draft = draftFor(testCase);
        final checkout = draft.toCheckoutBody(requestId: 'pos_prueba_0000000002');
        final quote = draft.toQuoteBody(requestId: 'pos_prueba_0000000003');
        expect(quote['expectedTotal'], checkout['expectedTotal'], reason: testCase['name'] as String);
        expect(quote['deliveryFee'], checkout['deliveryFee'], reason: testCase['name'] as String);
      }
    });

    test('el ticket y la cotización viajan solo cuando existen', () {
      final plain = draftFor(cases.first);
      expect(plain.toCheckoutBody(requestId: 'pos_prueba_0000000004').containsKey('ticketId'), isFalse);
      expect(plain.toCheckoutBody(requestId: 'pos_prueba_0000000004').containsKey('quoteId'), isFalse);

      // Un cobro que nace de un ticket lleva su versión: así el servidor rechaza
      // el segundo cobro (`ticket_conflict`/duplicado) en vez de duplicar.
      final fromTicket = PosSaleDraft(
        mode: 'invoice',
        customerId: 'cliente_prueba',
        lines: plain.lines,
        paymentMethod: 'CASH',
        ticketId: 'ticket_123',
        ticketVersion: 4,
      );
      final ticketBody = fromTicket.toCheckoutBody(requestId: 'pos_prueba_0000000005');
      expect(ticketBody['ticketId'], 'ticket_123');
      expect(ticketBody['ticketVersion'], 4);

      // Cobrar una cotización manda `quoteId`: el servidor la marca `converted`.
      final fromQuote = PosSaleDraft(
        mode: 'invoice',
        customerId: 'cliente_prueba',
        lines: plain.lines,
        paymentMethod: 'CASH',
        quoteId: 'pos_quote_1',
      );
      expect(fromQuote.toCheckoutBody(requestId: 'pos_prueba_0000000006')['quoteId'], 'pos_quote_1');
      // …y la huella cambia: es otra operación, con otra clave.
      expect(fromQuote.fingerprint(), isNot(plain.fingerprint()));
    });
  });
}
