import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:phyto_printer/printer/crm_receipt_mapper.dart';
import 'package:phyto_printer/printer/printer_models.dart';
import 'package:phyto_printer/printer/receipt_builder.dart';
import 'package:phyto_printer/printer/sample_orders.dart';

void main() {
  const device = PrinterDevice(
    id: '00:11:22:33:44:55',
    name: 'POS-80',
    address: '00:11:22:33:44:55',
  );

  test('genera prueba ESC/POS para 58 mm con corte', () {
    final bytes = ReceiptBuilder(
      paperWidth: PrinterPaperWidth.mm58,
    ).buildTestTicket(device);
    expect(bytes.take(2), [0x1b, 0x40]);
    expect(bytes.skip(bytes.length - 4), [0x1d, 0x56, 0x42, 0x00]);
    final text = latin1.decode(bytes, allowInvalid: true);
    expect(text, contains('PHYTOEMAGRY'));
    expect(text, contains('Prueba de impresion'));
    expect(text, contains('58 mm'));
  });

  test('respeta ancho 58 mm en divisores', () {
    final bytes = ReceiptBuilder(
      paperWidth: PrinterPaperWidth.mm58,
      autoCut: false,
    ).buildOrderTicket(sampleReceiptOrder());
    final text = latin1.decode(bytes, allowInvalid: true);
    expect(text, contains('-' * 32));
  });

  test('respeta ancho 80 mm en divisores y columnas mas amplias', () {
    final bytes = ReceiptBuilder(
      paperWidth: PrinterPaperWidth.mm80,
      autoCut: false,
    ).buildOrderTicket(sampleReceiptOrder());
    final text = latin1.decode(bytes, allowInvalid: true);
    expect(text, contains('-' * 48));
    expect(
      PrinterPaperWidth.mm80.columns,
      greaterThan(PrinterPaperWidth.mm58.columns),
    );
  });

  test('factura real usa datos estructurados, no PDF', () {
    final order = sampleReceiptOrder();
    final bytes = ReceiptBuilder(
      paperWidth: PrinterPaperWidth.mm58,
    ).buildOrderTicket(order);
    final text = latin1.decode(bytes, allowInvalid: true);
    expect(text, contains('Pedido:'));
    expect(text, contains('PE-00125'));
    expect(text, contains('Cliente'));
    expect(text, contains('Produccion'));
    expect(text, contains('TOTAL'));
    expect(text, contains('RD\$5,000'));
    expect(text, isNot(contains('%PDF')));
  });

  test('normaliza caracteres para impresoras ESC/POS genericas', () {
    final bytes =
        ReceiptBuilder(
          paperWidth: PrinterPaperWidth.mm58,
          autoCut: false,
        ).buildOrderTicket(
          ReceiptOrder(
            orderNumber: 'PE-NINO',
            createdAt: DateTime(2026, 10, 5),
            customerName: 'Niño Pérez',
            items: const [
              ReceiptLine(
                name: 'Cápsulas Ñ',
                quantity: 1,
                unitPrice: 100,
                total: 100,
              ),
            ],
            total: 100,
          ),
        );
    final text = latin1.decode(bytes, allowInvalid: true);
    expect(text, contains('Nino Perez'));
    expect(text, contains('Capsulas N'));
  });

  test('mapea el receipt real del CRM sin duplicar totales', () {
    final order = receiptOrderFromCrm({
      'order_number': 'PE-REAL01',
      'created_at': '2026-10-05T14:30:00.000Z',
      'customer_name': 'Ana CRM',
      'currency': 'DOP',
      'payment_method_label': 'Transferencia',
      'total': 1750,
      'items': [
        {
          'variant_name': 'Producto A',
          'quantity': 2,
          'unit_price': 500,
          'total': 1000,
        },
        {
          'variant_name': 'Producto B',
          'quantity': 1,
          'unit_price': 750,
          'total': 750,
        },
      ],
    });

    expect(order.orderNumber, 'PE-REAL01');
    expect(order.customerName, 'Ana CRM');
    expect(order.items, hasLength(2));
    expect(order.total, 1750);
    expect(order.paymentMethod, 'Transferencia');
  });
}
