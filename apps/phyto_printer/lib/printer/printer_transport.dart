import 'printer_models.dart';

abstract class PrinterTransport {
  Future<BluetoothAvailability> availability();
  Future<bool> requestPermissions();
  Future<List<PrinterDevice>> getDevices();
  Future<bool> connect(PrinterDevice device);
  Future<void> write(List<int> bytes);
  Future<void> disconnect();
}

abstract class PrinterSettingsStore {
  Future<PrinterSettings> load();
  Future<void> save(PrinterSettings settings);
}
