import 'printer_models.dart';

ReceiptOrder sampleReceiptOrder() {
  return ReceiptOrder(
    orderNumber: 'PE-00125',
    createdAt: DateTime(2026, 10, 5, 14, 30),
    customerName: 'Cliente Produccion',
    paymentMethod: 'Efectivo',
    items: const [
      ReceiptLine(
        name: 'Phytoemagry 5 capsulas',
        quantity: 2,
        unitPrice: 1250,
        total: 2500,
      ),
      ReceiptLine(
        name: 'Phytoemagry 10 capsulas',
        quantity: 1,
        unitPrice: 2500,
        total: 2500,
      ),
    ],
    total: 5000,
    note: 'Pedido de prueba desde la app Android.',
  );
}
