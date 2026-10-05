import 'printer_models.dart';
import 'printer_transport.dart';
import 'receipt_builder.dart';

class PrinterService {
  PrinterService({
    required PrinterTransport transport,
    required PrinterSettingsStore store,
  }) : _transport = transport,
       _store = store;

  final PrinterTransport _transport;
  final PrinterSettingsStore _store;
  PrinterSettings _settings = const PrinterSettings();
  PrinterDevice? _connectedDevice;

  PrinterSettings get settings => _settings;

  Future<PrinterSettings> loadSettings() async {
    _settings = await _store.load();
    return _settings;
  }

  Future<void> saveSettings(PrinterSettings settings) async {
    _settings = settings;
    await _store.save(settings);
  }

  Future<BluetoothAvailability> bluetoothAvailability() =>
      _transport.availability();

  Future<bool> requestPermissions() => _transport.requestPermissions();

  Future<List<PrinterDevice>> devices() => _transport.getDevices();

  Future<void> selectDevice(PrinterDevice device) async {
    await saveSettings(_settings.copyWith(defaultDevice: device));
  }

  Future<void> setPaperWidth(PrinterPaperWidth width) async {
    await saveSettings(_settings.copyWith(paperWidth: width));
  }

  Future<void> setAutoPrint(bool enabled) async {
    await saveSettings(_settings.copyWith(autoPrint: enabled));
  }

  Future<void> setAutoCut(bool enabled) async {
    await saveSettings(_settings.copyWith(autoCut: enabled));
  }

  Future<void> printTest() async {
    final device = _requiredDevice();
    final bytes = ReceiptBuilder(
      paperWidth: _settings.paperWidth,
      autoCut: _settings.autoCut,
    ).buildTestTicket(device);
    await _print(device, bytes);
  }

  Future<void> printOrder(ReceiptOrder order) async {
    final device = _requiredDevice();
    final bytes = ReceiptBuilder(
      paperWidth: _settings.paperWidth,
      autoCut: _settings.autoCut,
    ).buildOrderTicket(order);
    await _print(device, bytes);
  }

  Future<void> disconnect() async {
    _connectedDevice = null;
    await _transport.disconnect();
  }

  Future<void> _print(PrinterDevice device, List<int> bytes) async {
    await _ensureReady();
    await _connect(device);
    await _transport.write(bytes);
    await saveSettings(_settings.copyWith(lastConnectedAt: DateTime.now()));
  }

  Future<void> _ensureReady() async {
    var status = await _transport.availability();
    if (status == BluetoothAvailability.permissionDenied) {
      final granted = await _transport.requestPermissions();
      if (!granted) {
        throw const PrinterException(
          'permission_denied',
          'Falta permiso de Bluetooth para usar la impresora.',
        );
      }
      status = await _transport.availability();
    }
    if (status == BluetoothAvailability.disabled) {
      throw const PrinterException(
        'bluetooth_disabled',
        'Bluetooth esta desactivado. Activalo y vuelve a intentarlo.',
      );
    }
    if (status == BluetoothAvailability.unsupported) {
      throw const PrinterException(
        'unsupported',
        'Este telefono no reporta Bluetooth compatible.',
      );
    }
  }

  Future<void> _connect(PrinterDevice device) async {
    if (_connectedDevice?.id == device.id) return;
    final connected = await _transport.connect(device);
    if (!connected) {
      throw PrinterException(
        'connection_failed',
        'No se pudo conectar con ${device.userLabel}. Verifica que este encendida, cerca y con Bluetooth activo.',
      );
    }
    _connectedDevice = device;
  }

  PrinterDevice _requiredDevice() {
    final device = _settings.defaultDevice;
    if (device == null || device.id.trim().isEmpty) {
      throw const PrinterException(
        'missing_printer',
        'No hay impresora configurada. Emparejala en Android y seleccionala en Configuracion.',
      );
    }
    return device;
  }
}
