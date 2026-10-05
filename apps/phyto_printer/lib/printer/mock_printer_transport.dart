import 'printer_models.dart';
import 'printer_transport.dart';

class InMemoryPrinterSettingsStore implements PrinterSettingsStore {
  InMemoryPrinterSettingsStore([this.value = const PrinterSettings()]);

  PrinterSettings value;

  @override
  Future<PrinterSettings> load() async => value;

  @override
  Future<void> save(PrinterSettings settings) async {
    value = settings;
  }
}

class MockPrinterTransport implements PrinterTransport {
  MockPrinterTransport({
    this.status = BluetoothAvailability.available,
    List<PrinterDevice>? devices,
    this.failConnect = false,
    this.failWrite = false,
  }) : devicesList =
           devices ??
           const [
             PrinterDevice(
               id: '00:11:22:33:44:55',
               name: 'POS-80',
               address: '00:11:22:33:44:55',
             ),
           ];

  BluetoothAvailability status;
  List<PrinterDevice> devicesList;
  bool failConnect;
  bool failWrite;
  int connectCalls = 0;
  int writeCalls = 0;
  final writes = <List<int>>[];
  PrinterDevice? connectedDevice;

  @override
  Future<BluetoothAvailability> availability() async => status;

  @override
  Future<bool> requestPermissions() async {
    if (status == BluetoothAvailability.permissionDenied) {
      status = BluetoothAvailability.available;
    }
    return status == BluetoothAvailability.available;
  }

  @override
  Future<List<PrinterDevice>> getDevices() async => devicesList;

  @override
  Future<bool> connect(PrinterDevice device) async {
    connectCalls += 1;
    if (failConnect) return false;
    connectedDevice = device;
    return true;
  }

  @override
  Future<void> write(List<int> bytes) async {
    writeCalls += 1;
    if (failWrite) {
      throw const PrinterException(
        'write_failed',
        'La conexion se perdio mientras se imprimia.',
      );
    }
    writes.add(List<int>.from(bytes));
  }

  @override
  Future<void> disconnect() async {
    connectedDevice = null;
  }
}
