import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/features/ventas/pos_order_edit.dart';

void main() {
  test('reabre líneas y conserva el total general del cliente', () {
    final order = <String, dynamic>{
      'subtotal': 5000,
      'discount': 200,
      'delivery_fee': 350,
      'total': 4800, // pedido antiguo: el delivery no se había sumado
      'items': [
        {
          'variantId': 'v1',
          'variantName': 'Cinco cápsulas',
          'quantity': 2,
          'unitPrice': 1250,
          'subtotal': 2500,
          'supplier_id': 'store_1',
        },
        {
          'variantId': 'v2',
          'variantName': 'Diez cápsulas',
          'quantity': 1,
          'unitPrice': 2500,
          'subtotal': 2500,
        },
      ],
    };
    final lines = linesFromOrder(order);
    expect(lines.length, 2);
    expect(lines.first.quantity, 2);
    expect(lines.first.supplierId, 'store_1');
    expect(orderPayableTotal(order), 5150);
    expect(orderUpdateItems(lines).first, {
      'variantId': 'v1',
      'quantity': 2,
      'unitPrice': 1250.0,
      'lineDiscountCents': 0,
      'supplierId': 'store_1',
    });
  });

  test('conserva un descuento por línea al editar el pedido', () {
    final order = <String, dynamic>{
      'items': [
        {
          'variantId': 'v1',
          'quantity': 2,
          'unitPrice': 100,
          'line_discount_cents': 2500,
          'subtotal': 175,
        },
      ],
      'discount': 10,
      'delivery_fee': 25,
    };
    final lines = linesFromOrder(order);
    expect(lines.single.lineDiscountCents, 2500);
    expect(orderUpdateItems(lines).single['lineDiscountCents'], 2500);
    expect(orderPayableTotal(order), 190);
  });
}
