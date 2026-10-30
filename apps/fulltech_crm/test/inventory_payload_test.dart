import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/features/ventas/inventory_fields.dart';

/// Contrato de `GET /api/admin/inventory`.
///
/// La carga útil de abajo es la que arma `server/inventory.mjs` →
/// `inventory.catalog()` + `sanitizeInventoryForPermissions`. La pantalla
/// anterior leía `name` y `stock` DENTRO de cada presentación: campos que no
/// existen, así que mostraba «Presentación … 0» en todas las filas.
void main() {
  final payload = <String, dynamic>{
    'ok': true,
    'product': {
      'name': 'Phytoemagry',
      'current_unit_cost_cents': 320,
    },
    'stock': 1240,
    'initialized': true,
    'inventory_value_cents': 396800,
    'presentations': [
      {
        'id': 'phyto-60',
        'capsules': 60,
        'price': 350.0,
        'currency': 'DOP',
        'completeBottle': true,
        'available': true,
        'label': 'Frasco de 60 cápsulas',
        'product_id': 'phyto',
        'capsule_quantity': 60,
        'sale_price_cents': 35000,
        'active': true,
        'current_unit_cost_cents': 320,
        'presentation_cost_cents': 19200,
      },
      {
        'id': 'phyto-120',
        'capsules': 120,
        'price': 620.0,
        'label': 'Frasco de 120 cápsulas',
        'product_id': 'phyto',
        'capsule_quantity': 120,
        'sale_price_cents': 62000,
        'active': true,
      },
    ],
    'movements': [
      {'type': 'RESTOCK', 'quantity': 500, 'reason': 'Reposición', 'created_at': '2026-10-20T10:00:00.000Z'},
      {'type': 'SALE', 'quantity': -60, 'reason': 'Venta', 'created_at': '2026-10-21T10:00:00.000Z'},
    ],
  };

  test('las presentaciones se leen de label y capsule_quantity', () {
    final rows = (payload['presentations'] as List).cast<Map<String, dynamic>>();
    expect(presentationLabel(rows[0]), 'Frasco de 60 cápsulas');
    expect(presentationCapsules(rows[0]), 60);
    expect(presentationLabel(rows[1]), 'Frasco de 120 cápsulas');
    expect(presentationCapsules(rows[1]), 120);
  });

  test('las cápsulas del inventario compartido salen de stock', () {
    expect(sharedCapsuleStock(payload), 1240);
    expect(inventoryInitialized(payload), isTrue);
    expect(inventoryValueCents(payload), 396800);
  });

  test('sin label ni nombre se compone una etiqueta legible', () {
    expect(presentationLabel({'capsule_quantity': 30}), 'Frasco de 30 cápsulas');
    expect(presentationLabel({'id': 'phyto-15'}), 'phyto-15');
    expect(presentationLabel(const <String, dynamic>{}), 'Presentación');
  });

  test('una presentación sin cápsulas declaradas no inventa cifras', () {
    expect(presentationCapsules(const <String, dynamic>{}), 0);
    expect(presentationCapsulesFor({'capsule_quantity': 60}, 3), 180);
    expect(sharedCapsuleStock(const <String, dynamic>{}), 0);
    expect(inventoryInitialized(const <String, dynamic>{}), isFalse);
  });

  test('las unidades propias se leen aparte de las cápsulas', () {
    // Carga útil REAL de la UAT (2026-10-28), sin datos personales.
    final real = <String, dynamic>{
      'label': 'Phytoemagry · 5 cápsulas',
      'capsules': 5,
      'capsule_quantity': 5,
      'stock': 101,
      'track_stock': true,
      'available': true,
      'sale_price_cents': 75000,
    };
    expect(presentationCapsules(real), 5);
    expect(presentationStock(real), 101);
    // Son cifras distintas: nunca se suman ni se intercambian.
    expect(presentationCapsules(real), isNot(presentationStock(real)));
    expect(presentationStock({'track_stock': false, 'stock': 12}), isNull);
    expect(presentationStock(const <String, dynamic>{}), isNull);
  });
}
