import '../../core/pos/pos_sale.dart';
import '../../data/models/crm_models.dart';

/// Reconstruye el ticket desde el snapshot del pedido, no desde precios actuales.
/// El servidor volverá a validar catálogo e importes al guardar la edición.
List<PosLine> linesFromOrder(Map<String, dynamic> order) {
  return [
    for (final raw in listv(order['items']))
      if (mapv(raw).isNotEmpty) _lineFromOrder(mapv(raw)),
  ];
}

PosLine _lineFromOrder(Map<String, dynamic> row) {
  final quantity = numv(row['quantity'], 1).toInt();
  final fallbackPrice = quantity > 0
      ? numv(row['total'], numv(row['subtotal'])).toDouble() / quantity
      : 0.0;
  final price = numv(
    row['unitPrice'],
    numv(row['unit_price'], fallbackPrice),
  ).toDouble();
  final grossCents = (price * 100).round() * quantity;
  final savedDiscount = row['line_discount_cents'] ?? row['lineDiscountCents'];
  final lineDiscountCents = savedDiscount is num
      ? savedDiscount.toInt()
      : (grossCents - (numv(row['subtotal'], price * quantity) * 100).round())
            .clamp(0, grossCents);
  final name = str(row['variantName'], str(row['label'], 'Producto'));
  final manual = row['manual'] == true;
  return PosLine(
    variantId: str(row['variantId'], str(row['variant_id'])),
    productName: name,
    presentationName: str(row['label'], name),
    unitPriceCents: (price * 100).round(),
    quantity: quantity,
    discountType: lineDiscountCents > 0 ? 'amount' : 'none',
    discountValue: lineDiscountCents / 100,
    manualName: manual ? str(row['label'], name) : null,
    manualKind: manual ? str(row['kind'], 'product') : null,
    manualPrice: manual ? price : null,
    manualCost: manual
        ? numv(row['unit_cost_snapshot_cents']).toDouble() / 100
        : null,
    supplierId: str(row['supplier_id'], str(row['supplierId'])),
  );
}

/// Contrato de PATCH /orders/:id: descuento de línea en centavos, precio
/// unitario en pesos y tienda por línea. No crea un segundo pedido.
List<Map<String, dynamic>> orderUpdateItems(List<PosLine> lines) => [
  for (final line in lines)
    {
      'variantId': line.variantId,
      'quantity': line.quantity,
      'unitPrice': line.unitPriceCents / 100,
      'lineDiscountCents': line.lineDiscountCents,
      if (line.supplierId.isNotEmpty) 'supplierId': line.supplierId,
    },
];

/// Monto a cobrar al cliente. Un pedido antiguo puede conservar un `total`
/// anterior al cargo de delivery; el desglose prevalece para la vista y la
/// edición lo vuelve a persistir a través del cálculo del backend.
double orderPayableTotal(Map<String, dynamic> order) {
  final items = linesFromOrder(order);
  if (items.isEmpty && order['subtotal'] == null) {
    return numv(order['total']).toDouble();
  }
  final subtotal = items.isEmpty
      ? numv(order['subtotal']).toDouble()
      : items.fold<int>(0, (sum, line) => sum + line.netCents) / 100;
  final discount = numv(order['discount']).toDouble();
  final delivery = numv(
    order['delivery_fee'],
    numv(mapv(order['delivery'])['fee']),
  ).toDouble();
  return ((subtotal - discount + delivery) * 100).round() / 100;
}
