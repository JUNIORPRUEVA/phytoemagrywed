import '../printer/crm_receipt_mapper.dart';
import '../printer/printer_models.dart';
import '../printer/printer_service.dart';

typedef OriginGuard = Future<bool> Function();
typedef PrinterConfigurator = Future<PrinterSettings?> Function();

class PrinterBridgeException implements Exception {
  const PrinterBridgeException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => message;
}

class PrinterBridge {
  PrinterBridge({
    required PrinterService service,
    required OriginGuard isTrustedOrigin,
    PrinterConfigurator? configurePrinter,
  }) : _service = service,
       _isTrustedOrigin = isTrustedOrigin,
       _configurePrinter = configurePrinter;

  final PrinterService _service;
  final OriginGuard _isTrustedOrigin;
  final PrinterConfigurator? _configurePrinter;

  Future<Map<String, Object?>> handle(Map<String, Object?> message) async {
    if (message['scope'] != 'printer') {
      throw const PrinterBridgeException(
        'invalid_scope',
        'Comando nativo no permitido.',
      );
    }
    if (!await _isTrustedOrigin()) {
      throw const PrinterBridgeException(
        'origin_denied',
        'Esta pagina no puede usar la impresora.',
      );
    }

    final action = message['action'] as String?;
    final payload = message['payload'];
    return switch (action) {
      'printerStatus' => statusPayload(),
      'listPrinters' => _listPrinters(),
      'configurePrinter' => _configure(),
      'testPrint' => _testPrint(),
      'printReceipt' => _printReceipt(payload),
      _ => throw const PrinterBridgeException(
        'unknown_action',
        'Accion de impresora no permitida.',
      ),
    };
  }

  Future<Map<String, Object?>> statusPayload() async {
    final settings = await _service.loadSettings();
    final bluetooth = await _service.bluetoothAvailability();
    return {
      'native': true,
      'bluetooth': bluetooth.name,
      'bluetoothLabel': bluetooth.label,
      'defaultDevice': settings.defaultDevice?.toJson(),
      'paperWidth': settings.paperWidth.name,
      'paperWidthLabel': settings.paperWidth.label,
      'profile': settings.profile.name,
      'profileLabel': settings.profile.label,
      'autoPrint': settings.autoPrint,
      'autoCut': settings.autoCut,
      'lastConnectedAt': settings.lastConnectedAt?.toIso8601String(),
    };
  }

  Future<Map<String, Object?>> _listPrinters() async {
    var bluetooth = await _service.bluetoothAvailability();
    if (bluetooth == BluetoothAvailability.permissionDenied) {
      await _service.requestPermissions();
      bluetooth = await _service.bluetoothAvailability();
    }
    final devices = bluetooth == BluetoothAvailability.available
        ? await _service.devices()
        : <PrinterDevice>[];
    return {
      'bluetooth': bluetooth.name,
      'devices': devices.map((device) => device.toJson()).toList(),
    };
  }

  Future<Map<String, Object?>> _configure() async {
    final configured = await _configurePrinter?.call();
    if (configured != null) {
      return {
        'configured': true,
        'settings': configured.toJson(),
        'status': await statusPayload(),
      };
    }
    return {'configured': false, 'status': await statusPayload()};
  }

  Future<Map<String, Object?>> _testPrint() async {
    await _service.loadSettings();
    await _service.printTest();
    return {'printed': true};
  }

  Future<Map<String, Object?>> _printReceipt(Object? payload) async {
    if (payload is! Map) {
      throw const PrinterBridgeException(
        'invalid_payload',
        'La factura no tiene datos validos para imprimir.',
      );
    }
    final receipt = Map<String, Object?>.from(payload);
    final order = receiptOrderFromCrm(receipt);
    await _service.loadSettings();
    await _service.printOrder(order);
    return {'printed': true, 'orderNumber': order.orderNumber};
  }
}
