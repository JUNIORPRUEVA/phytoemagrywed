/// Lectura de la respuesta de `GET /api/admin/inventory`.
///
/// El servidor devuelve, por cada presentación, exactamente lo que arma
/// `inventory.catalog()` en `server/inventory.mjs`:
///
/// ```json
/// { "id": "...", "label": "Frasco de 60 cápsulas", "capsules": 60,
///   "capsule_quantity": 60, "sale_price_cents": 35000, "active": true,
///   "current_unit_cost_cents": 320, "presentation_cost_cents": 19200 }
/// ```
///
/// y arriba: `stock` (cápsulas totales), `initialized` e
/// `inventory_value_cents`. **No** existe `name`, `stock` ni `quantity` dentro
/// de una presentación: leerlos devolvía el valor de reserva (cadena vacía y
/// cero) en todas las filas, que es justo el defecto que estas funciones evitan.
///
/// Es solo lectura: no calcula inventario, solo elige qué campo mostrar.
library;

/// Nombre visible de una presentación.
String presentationLabel(Map<String, dynamic> row) {
  final label = row['label'];
  if (label is String && label.trim().isNotEmpty) return label.trim();
  final name = row['name'];
  if (name is String && name.trim().isNotEmpty) return name.trim();
  final capsules = _int(row['capsules'] ?? row['capsule_quantity']);
  if (capsules > 0) return 'Frasco de $capsules cápsulas';
  final id = row['id'];
  return id is String && id.isNotEmpty ? id : 'Presentación';
}

/// Cápsulas que consume UNA unidad de esta presentación (modelo LEGACY
/// Phytoemagry: una sola cifra de cápsulas compartida por todo el catálogo).
int presentationCapsules(Map<String, dynamic> row) =>
    _int(row['capsule_quantity'] ?? row['capsules']);

/// Existencias propias de la presentación (modelo NUEVO de catálogo: unidades
/// por variante). Es **otra** cifra, no la de cápsulas: se muestran separadas y
/// nunca se suman ni se comparan entre sí (`null` = esta presentación no lleva
/// stock propio).
int? presentationStock(Map<String, dynamic> row) {
  if (row['track_stock'] == false) return null;
  final stock = row['stock'];
  if (stock is num) return stock.toInt();
  if (stock is String) return int.tryParse(stock.trim());
  return null;
}

/// Cápsulas que consume [quantity] unidades de esta presentación.
int presentationCapsulesFor(Map<String, dynamic> row, int quantity) =>
    presentationCapsules(row) * quantity;

/// Total de cápsulas del inventario compartido (`stock` de la respuesta).
int sharedCapsuleStock(Map<String, dynamic> data) => _int(data['stock']);

/// Si el inventario ya tiene movimientos (`initialized`). Con `false`, el
/// servidor NO bloquea una venta por falta de stock: no hay cifra fiable.
bool inventoryInitialized(Map<String, dynamic> data) => data['initialized'] == true;

/// Valor del inventario en **céntimos** (`inventory_value_cents`).
int inventoryValueCents(Map<String, dynamic> data) => _int(data['inventory_value_cents']);

int _int(Object? value) {
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value.trim()) ?? 0;
  return 0;
}
