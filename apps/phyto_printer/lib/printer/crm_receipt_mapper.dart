import 'printer_models.dart';

ReceiptOrder receiptOrderFromCrm(Map<String, Object?> receipt) {
  final items = (receipt['items'] as List? ?? const [])
      .whereType<Map>()
      .map((row) {
        final quantity = _int(row['quantity']) ?? 1;
        final unitPrice = _int(row['unit_price'] ?? row['unitPrice']) ?? 0;
        final total = _int(row['total']) ?? quantity * unitPrice;
        return ReceiptLine(
          name: _text(
            row['variant_name'] ?? row['variantName'] ?? row['name'],
            fallback: 'Producto',
          ),
          quantity: quantity,
          unitPrice: unitPrice,
          total: total,
        );
      })
      .toList(growable: false);

  return ReceiptOrder(
    orderNumber: _text(
      receipt['order_number'] ?? receipt['orderNumber'],
      fallback: 'Pedido',
    ),
    createdAt:
        DateTime.tryParse(
          _text(receipt['created_at'] ?? receipt['createdAt']),
        ) ??
        DateTime.now(),
    customerName: _text(
      receipt['customer_name'] ??
          receipt['customerName'] ??
          receipt['customer'],
      fallback: 'Cliente',
    ),
    items: items,
    total:
        _int(receipt['total']) ??
        items.fold(0, (sum, item) => sum + item.total),
    currency: _text(receipt['currency'], fallback: 'DOP'),
    paymentMethod: _optionalText(
      receipt['payment_method_label'] ??
          receipt['paymentMethodLabel'] ??
          receipt['payment_method'],
    ),
    note: _optionalText(receipt['note']),
  );
}

String _text(Object? value, {String fallback = ''}) {
  final clean = (value ?? '').toString().trim();
  return clean.isEmpty ? fallback : clean;
}

String? _optionalText(Object? value) {
  final clean = _text(value);
  return clean.isEmpty ? null : clean;
}

int? _int(Object? value) {
  if (value is int) return value;
  if (value is num) return value.round();
  return int.tryParse(
    (value ?? '').toString().replaceAll(RegExp(r'[^0-9-]'), ''),
  );
}
