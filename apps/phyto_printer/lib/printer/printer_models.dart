enum PrinterPaperWidth {
  mm58,
  mm80;

  int get columns => switch (this) {
    PrinterPaperWidth.mm58 => 32,
    PrinterPaperWidth.mm80 => 48,
  };

  String get label => switch (this) {
    PrinterPaperWidth.mm58 => '58 mm',
    PrinterPaperWidth.mm80 => '80 mm',
  };

  static PrinterPaperWidth fromName(String? value) {
    return PrinterPaperWidth.values.firstWhere(
      (item) => item.name == value,
      orElse: () => PrinterPaperWidth.mm58,
    );
  }
}

enum PrinterProfile {
  genericEscPos;

  String get label => 'Generic ESC/POS';
}

enum BluetoothAvailability {
  unsupported,
  disabled,
  permissionDenied,
  available;

  String get label => switch (this) {
    BluetoothAvailability.unsupported => 'No disponible',
    BluetoothAvailability.disabled => 'Desactivado',
    BluetoothAvailability.permissionDenied => 'Permiso pendiente',
    BluetoothAvailability.available => 'Disponible',
  };
}

class PrinterException implements Exception {
  const PrinterException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => message;
}

class PrinterDevice {
  const PrinterDevice({
    required this.id,
    required this.name,
    this.address,
    this.bonded = true,
  });

  final String id;
  final String name;
  final String? address;
  final bool bonded;

  String get userLabel => name.trim().isEmpty ? 'Impresora Bluetooth' : name;

  String get maskedAddress {
    final value = (address ?? id).trim();
    if (value.length <= 5) return value;
    return '•••• ${value.substring(value.length - 5)}';
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'name': name,
    'address': address,
    'bonded': bonded,
  };

  static PrinterDevice fromJson(Map<String, Object?> json) {
    return PrinterDevice(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? 'Impresora Bluetooth',
      address: json['address'] as String?,
      bonded: json['bonded'] as bool? ?? true,
    );
  }
}

class PrinterSettings {
  const PrinterSettings({
    this.defaultDevice,
    this.paperWidth = PrinterPaperWidth.mm58,
    this.profile = PrinterProfile.genericEscPos,
    this.autoPrint = false,
    this.autoCut = true,
    this.lastConnectedAt,
  });

  final PrinterDevice? defaultDevice;
  final PrinterPaperWidth paperWidth;
  final PrinterProfile profile;
  final bool autoPrint;
  final bool autoCut;
  final DateTime? lastConnectedAt;

  PrinterSettings copyWith({
    PrinterDevice? defaultDevice,
    bool clearDefaultDevice = false,
    PrinterPaperWidth? paperWidth,
    PrinterProfile? profile,
    bool? autoPrint,
    bool? autoCut,
    DateTime? lastConnectedAt,
  }) {
    return PrinterSettings(
      defaultDevice: clearDefaultDevice
          ? null
          : defaultDevice ?? this.defaultDevice,
      paperWidth: paperWidth ?? this.paperWidth,
      profile: profile ?? this.profile,
      autoPrint: autoPrint ?? this.autoPrint,
      autoCut: autoCut ?? this.autoCut,
      lastConnectedAt: lastConnectedAt ?? this.lastConnectedAt,
    );
  }

  Map<String, Object?> toJson() => {
    'defaultDevice': defaultDevice?.toJson(),
    'paperWidth': paperWidth.name,
    'profile': profile.name,
    'autoPrint': autoPrint,
    'autoCut': autoCut,
    'lastConnectedAt': lastConnectedAt?.toIso8601String(),
  };

  static PrinterSettings fromJson(Map<String, Object?> json) {
    final device = json['defaultDevice'];
    return PrinterSettings(
      defaultDevice: device is Map
          ? PrinterDevice.fromJson(Map<String, Object?>.from(device))
          : null,
      paperWidth: PrinterPaperWidth.fromName(json['paperWidth'] as String?),
      profile: PrinterProfile.genericEscPos,
      autoPrint: json['autoPrint'] as bool? ?? false,
      autoCut: json['autoCut'] as bool? ?? true,
      lastConnectedAt: DateTime.tryParse(
        json['lastConnectedAt'] as String? ?? '',
      ),
    );
  }
}

class ReceiptLine {
  const ReceiptLine({
    required this.name,
    required this.quantity,
    required this.unitPrice,
    required this.total,
  });

  final String name;
  final int quantity;
  final int unitPrice;
  final int total;
}

class ReceiptOrder {
  const ReceiptOrder({
    required this.orderNumber,
    required this.createdAt,
    required this.customerName,
    required this.items,
    required this.total,
    this.currency = 'DOP',
    this.paymentMethod,
    this.note,
  });

  final String orderNumber;
  final DateTime createdAt;
  final String customerName;
  final List<ReceiptLine> items;
  final int total;
  final String currency;
  final String? paymentMethod;
  final String? note;
}
