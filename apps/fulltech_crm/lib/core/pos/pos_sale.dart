import '../net/api_client.dart';

/// Lógica del POS separada de la interfaz, para poder probarla sin servidor.
///
/// Espeja EXACTAMENTE `public/admin/pos-math.js` (el mismo código que ejecuta
/// el servidor):
///   unit_cents = round(precio * 100)
///   gross      = unit_cents * cantidad
///   subtotal   = Σ gross - descuentos de línea
///   total      = subtotal - descuento global + round(envío * 100)
/// El servidor exige `expectedTotal` (entero seguro en CENTAVOS) igual a su
/// propio `sale.total_cents`; si no coincide responde 409 `price_changed`.

class PosLine {
  const PosLine({
    required this.variantId,
    required this.productName,
    required this.presentationName,
    required this.unitPriceCents,
    required this.quantity,
  });

  final String variantId;
  final String productName;
  final String presentationName;
  final int unitPriceCents;
  final int quantity;

  int get grossCents => unitPriceCents * quantity;

  Map<String, dynamic> toJson() => {'variantId': variantId, 'quantity': quantity};

  PosLine copyWith({int? quantity}) => PosLine(
        variantId: variantId,
        productName: productName,
        presentationName: presentationName,
        unitPriceCents: unitPriceCents,
        quantity: quantity ?? this.quantity,
      );
}

/// Borrador de venta: lo que el operador ve antes de cobrar.
class PosSaleDraft {
  const PosSaleDraft({
    required this.mode,
    required this.customerId,
    required this.lines,
    this.deliveryFeeCents = 0,
    this.notes = '',
    this.address = '',
    this.deliveryMethod = 'delivery',
    this.paymentMethod = 'CASH',
    this.paid = false,
  });

  /// `order` | `invoice` | `quote`
  final String mode;
  final String customerId;
  final List<PosLine> lines;
  final int deliveryFeeCents;
  final String notes;
  final String address;
  final String deliveryMethod;
  final String paymentMethod;
  final bool paid;

  bool get isQuote => mode == 'quote';

  int get subtotalCents => lines.fold<int>(0, (sum, line) => sum + line.grossCents);

  /// El servidor exige el envío en **pesos enteros**
  /// (`Number.isInteger(input.deliveryFee)`). Se redondea aquí para que el
  /// `expectedTotal` coincida con el suyo; si no, un envío con céntimos se
  /// rechazaba con 409 `price_changed` y la venta no se podía cerrar.
  int get deliveryFeePesos => (deliveryFeeCents / 100).round();

  int get expectedTotalCents => subtotalCents + deliveryFeePesos * 100;

  /// Reglas mínimas antes de molestar al servidor.
  String? validate() {
    if (customerId.isEmpty) return 'Elige un cliente antes de guardar.';
    if (lines.isEmpty) return 'Agrega al menos un artículo.';
    if (lines.any((line) => line.quantity < 1 || line.quantity > 9999)) return 'La cantidad debe estar entre 1 y 9999.';
    if (deliveryFeeCents < 0) return 'El envío no puede ser negativo.';
    if (!isQuote && deliveryMethod == 'delivery' && address.trim().isEmpty) return 'Escribe la dirección de entrega.';
    return null;
  }

  /// Cuerpo de `/api/admin/pos/checkout` (pedido o factura).
  Map<String, dynamic> toCheckoutBody({required String requestId, bool acknowledgeOpen = false}) => {
        'mode': mode,
        'requestId': requestId,
        'customerId': customerId,
        'items': [for (final line in lines) line.toJson()],
        'deliveryFee': deliveryFeePesos,
        'paymentMethod': paymentMethod,
        'paymentStatus': paid ? 'paid' : 'pending',
        'deliveryMethod': deliveryMethod,
        'notes': notes,
        'address': address,
        // Contrato exacto: centavos, entero. Si el servidor calcula otra cosa,
        // contesta `price_changed` y aquí no se registra NADA.
        'expectedTotal': expectedTotalCents,
        if (acknowledgeOpen) 'acknowledgeOpen': true,
      };

  /// Cuerpo de `/api/admin/pos/quotes`.
  Map<String, dynamic> toQuoteBody({required String requestId}) => {
        'requestId': requestId,
        'customerId': customerId,
        'items': [for (final line in lines) line.toJson()],
        'deliveryFee': deliveryFeePesos,
        'paymentMethod': paymentMethod,
        'notes': notes,
        'address': address,
        'expectedTotal': expectedTotalCents,
      };

  /// Huella estable del contenido (sin `requestId` ni `acknowledgeOpen`).
  ///
  /// Si el operador cambia cualquier dato, es OTRA operación y merece otra clave.
  String fingerprint() {
    final canonical = [
      mode,
      customerId,
      deliveryFeeCents.toString(),
      notes.trim(),
      address.trim(),
      deliveryMethod,
      paymentMethod,
      paid ? '1' : '0',
      for (final line in lines) '${line.variantId}:${line.unitPriceCents}:${line.quantity}',
    ].join('|');
    return _fnv1a(canonical);
  }

  static String _fnv1a(String input) {
    var hash = 0x811c9dc5;
    for (final unit in input.codeUnits) {
      hash ^= unit;
      hash = (hash * 0x01000193) & 0xFFFFFFFF;
    }
    return hash.toRadixString(16).padLeft(8, '0');
  }
}

/// Mantiene la clave de operación del POS.
///
/// La clave se conserva mientras el borrador no cambie: así un reintento tras
/// un timeout NO duplica la venta (el servidor devuelve el documento anterior).
/// Al cobrar con éxito, o al cambiar los datos, se genera una clave nueva.
class PosOperation {
  PosOperation({String Function()? keyFactory}) : _keyFactory = keyFactory ?? _defaultKey;

  static const int _minLength = 16;
  static const int _maxLength = 100;

  final String Function() _keyFactory;
  String? _key;
  String? _fingerprint;
  int _attempts = 0;

  String? get key => _key;
  int get attempts => _attempts;

  static String _defaultKey() {
    final stamp = DateTime.now().microsecondsSinceEpoch.toString();
    final noise = (DateTime.now().hashCode & 0xffff).toRadixString(36);
    return 'pos_${stamp}_$noise';
  }

  /// Clave para este borrador: la misma si no cambió, nueva si cambió.
  String requestIdFor(PosSaleDraft draft) {
    final fingerprint = draft.fingerprint();
    final current = _key;
    if (current != null && _fingerprint == fingerprint) {
      _attempts += 1;
      return current;
    }
    final generated = _sanitize(_keyFactory());
    _key = generated;
    _fingerprint = fingerprint;
    _attempts = 1;
    return generated;
  }

  /// Tras un cobro correcto: la siguiente venta es una operación distinta.
  void reset() {
    _key = null;
    _fingerprint = null;
    _attempts = 0;
  }

  /// La clave debe cumplir el contrato del servidor; si no, se corrige.
  static String _sanitize(String raw) {
    var value = raw.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '');
    if (value.length < _minLength) {
      value = value.padRight(_minLength, '0');
    }
    if (value.length > _maxLength) {
      value = value.substring(0, _maxLength);
    }
    return value;
  }
}

enum PosOutcomeKind {
  /// Documento creado (o devuelto ya existente con los mismos datos).
  created,

  /// El servidor respondió que el documento ya estaba (reintento idempotente).
  duplicate,

  /// Los precios cambiaron: NO se registró nada.
  priceChanged,

  /// El cliente tiene pedidos abiertos: hace falta confirmar.
  openOrdersRequiresAck,

  /// Sin respuesta: el resultado es DESCONOCIDO. No repetir a ciegas.
  uncertain,

  /// Rechazo con mensaje del servidor.
  rejected,
}

class PosOutcome {
  const PosOutcome({
    required this.kind,
    this.message = '',
    this.code = '',
    this.documentNumber = '',
    this.quoteId = '',
    this.orderId = '',
    this.totalCents,
  });

  final PosOutcomeKind kind;
  final String message;
  final String code;
  final String documentNumber;
  final String quoteId;
  final String orderId;
  final int? totalCents;

  bool get ok => kind == PosOutcomeKind.created || kind == PosOutcomeKind.duplicate;

  /// Interpreta una respuesta correcta de `/pos/checkout` o `/pos/quotes`.
  factory PosOutcome.fromResponse(Map<String, dynamic> data) {
    final document = data['document'] is Map ? Map<String, dynamic>.from(data['document'] as Map) : <String, dynamic>{};
    final order = data['order'] is Map ? Map<String, dynamic>.from(data['order'] as Map) : <String, dynamic>{};
    final sale = document['sale'] is Map ? Map<String, dynamic>.from(document['sale'] as Map) : <String, dynamic>{};
    final total = sale['total_cents'];
    return PosOutcome(
      kind: data['duplicate'] == true ? PosOutcomeKind.duplicate : PosOutcomeKind.created,
      documentNumber: '${document['number'] ?? order['order_number'] ?? ''}',
      quoteId: '${data['quoteId'] ?? document['id'] ?? ''}',
      orderId: '${order['id'] ?? ''}',
      totalCents: total is num ? total.toInt() : null,
    );
  }

  /// Interpreta el error del servidor. Distingue lo que se puede reintentar de
  /// lo que no, y sobre todo el caso «no sabemos qué pasó» (sin respuesta).
  factory PosOutcome.fromError(ApiException error) {
    if (error.isUncertain) {
      return PosOutcome(
        kind: PosOutcomeKind.uncertain,
        message: 'No sabemos si la venta llegó al servidor. No se ha vuelto a enviar.',
        code: 'no_response',
      );
    }
    switch (error.code) {
      case 'price_changed':
        return PosOutcome(
          kind: PosOutcomeKind.priceChanged,
          message: error.message.isEmpty ? 'Los precios cambiaron. Revisa el ticket y vuelve a cobrar.' : error.message,
          code: error.code,
        );
      case 'open_orders':
        return PosOutcome(
          kind: PosOutcomeKind.openOrdersRequiresAck,
          message: error.message.isEmpty ? 'Este cliente ya tiene un pedido abierto. ¿Crear otro?' : error.message,
          code: error.code,
        );
      // Respuestas del envoltorio de idempotencia del servidor
      // (`server/offline-operations.mjs`): la operación quedó a medias o se
      // reutilizó la clave con otros datos. No se puede afirmar que NO se cobró:
      // se trata como resultado desconocido y decide la persona.
      case 'offline_operation_uncertain':
      case 'operation_reused':
        return PosOutcome(
          kind: PosOutcomeKind.uncertain,
          message: error.message.isEmpty
              ? 'El servidor no pudo confirmar el resultado de la venta. Consúltalo antes de repetir.'
              : error.message,
          code: error.code,
        );
      default:
        return PosOutcome(
          kind: error.isUnauthorized || error.statusCode == 0 ? PosOutcomeKind.uncertain : PosOutcomeKind.rejected,
          message: error.message,
          code: error.code,
        );
    }
  }
}
