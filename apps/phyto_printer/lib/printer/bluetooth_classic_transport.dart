import 'package:flutter/services.dart';

import 'printer_models.dart';
import 'printer_transport.dart';

class BluetoothClassicTransport implements PrinterTransport {
  BluetoothClassicTransport({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel('phytoemagry/printer');

  final MethodChannel _channel;

  @override
  Future<BluetoothAvailability> availability() async {
    final value = await _channel.invokeMethod<String>('bluetoothStatus');
    return BluetoothAvailability.values.firstWhere(
      (item) => item.name == value,
      orElse: () => BluetoothAvailability.unsupported,
    );
  }

  @override
  Future<bool> requestPermissions() async {
    return await _channel.invokeMethod<bool>('requestPermissions') ?? false;
  }

  @override
  Future<List<PrinterDevice>> getDevices() async {
    try {
      final raw =
          await _channel.invokeListMethod<Map<Object?, Object?>>(
            'getBondedDevices',
          ) ??
          [];
      return raw
          .map((row) => PrinterDevice.fromJson(Map<String, Object?>.from(row)))
          .where((device) => device.id.isNotEmpty)
          .toList(growable: false);
    } on PlatformException catch (error) {
      throw _friendly(error);
    }
  }

  @override
  Future<bool> connect(PrinterDevice device) async {
    try {
      return await _channel.invokeMethod<bool>('connect', device.toJson()) ??
          false;
    } on PlatformException catch (error) {
      throw _friendly(error, deviceName: device.userLabel);
    }
  }

  @override
  Future<void> write(List<int> bytes) async {
    try {
      await _channel.invokeMethod<void>('write', Uint8List.fromList(bytes));
    } on PlatformException catch (error) {
      throw _friendly(error);
    }
  }

  @override
  Future<void> disconnect() async {
    await _channel.invokeMethod<void>('disconnect');
  }

  PrinterException _friendly(PlatformException error, {String? deviceName}) {
    final name = deviceName ?? 'la impresora';
    final code = error.code;
    final message = switch (code) {
      'bluetooth_disabled' =>
        'Bluetooth esta desactivado. Activalo en Android y vuelve a intentarlo.',
      'permission_denied' =>
        'Falta permiso de Bluetooth para buscar y conectar impresoras.',
      'device_not_found' =>
        'No se encontro $name. Verifica que siga emparejada con Android.',
      'connection_failed' =>
        'No se pudo conectar con $name. Verifica que este encendida, cerca y con Bluetooth activo.',
      'write_failed' =>
        'La conexion se perdio mientras se imprimia. Revisa la impresora e intenta de nuevo.',
      'unsupported' => 'Este telefono no reporta Bluetooth compatible.',
      _ => 'No se pudo completar la accion con la impresora.',
    };
    return PrinterException(code, message);
  }
}

class NativePrinterSettingsStore implements PrinterSettingsStore {
  NativePrinterSettingsStore({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel('phytoemagry/printer');

  final MethodChannel _channel;

  @override
  Future<PrinterSettings> load() async {
    final raw = await _channel.invokeMethod<Map<Object?, Object?>>(
      'loadSettings',
    );
    if (raw == null) return const PrinterSettings();
    return PrinterSettings.fromJson(Map<String, Object?>.from(raw));
  }

  @override
  Future<void> save(PrinterSettings settings) async {
    await _channel.invokeMethod<void>('saveSettings', settings.toJson());
  }
}
