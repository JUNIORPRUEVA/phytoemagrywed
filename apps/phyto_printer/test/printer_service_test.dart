import 'package:flutter_test/flutter_test.dart';
import 'package:phyto_printer/printer/mock_printer_transport.dart';
import 'package:phyto_printer/printer/printer_models.dart';
import 'package:phyto_printer/printer/printer_service.dart';
import 'package:phyto_printer/printer/sample_orders.dart';

void main() {
  const device = PrinterDevice(
    id: '00:11:22:33:44:55',
    name: 'POS-80',
    address: '00:11:22:33:44:55',
  );

  test('selecciona dispositivo y guarda configuracion local', () async {
    final store = InMemoryPrinterSettingsStore();
    final service = PrinterService(
      transport: MockPrinterTransport(devices: [device]),
      store: store,
    );
    await service.loadSettings();
    await service.selectDevice(device);
    await service.setPaperWidth(PrinterPaperWidth.mm80);
    await service.setAutoPrint(true);

    expect(store.value.defaultDevice?.id, device.id);
    expect(store.value.paperWidth, PrinterPaperWidth.mm80);
    expect(store.value.autoPrint, true);
  });

  test('imprime prueba conectando y escribiendo bytes', () async {
    final transport = MockPrinterTransport(devices: [device]);
    final store = InMemoryPrinterSettingsStore(
      const PrinterSettings(defaultDevice: device),
    );
    final service = PrinterService(transport: transport, store: store);
    await service.loadSettings();

    await service.printTest();

    expect(transport.connectCalls, 1);
    expect(transport.writeCalls, 1);
    expect(transport.writes.single, isNotEmpty);
    expect(store.value.lastConnectedAt, isNotNull);
  });

  test('reutiliza conexion para impresiones repetidas', () async {
    final transport = MockPrinterTransport(devices: [device]);
    final store = InMemoryPrinterSettingsStore(
      const PrinterSettings(defaultDevice: device),
    );
    final service = PrinterService(transport: transport, store: store);
    await service.loadSettings();

    await service.printTest();
    await service.printOrder(sampleReceiptOrder());

    expect(transport.connectCalls, 1);
    expect(transport.writeCalls, 2);
  });

  test('si no hay impresora configurada muestra error de usuario', () async {
    final service = PrinterService(
      transport: MockPrinterTransport(),
      store: InMemoryPrinterSettingsStore(),
    );
    await service.loadSettings();

    expect(
      service.printTest,
      throwsA(
        isA<PrinterException>().having(
          (error) => error.code,
          'code',
          'missing_printer',
        ),
      ),
    );
  });

  test('maneja bluetooth apagado sin escribir', () async {
    final transport = MockPrinterTransport(
      status: BluetoothAvailability.disabled,
    );
    final service = PrinterService(
      transport: transport,
      store: InMemoryPrinterSettingsStore(
        const PrinterSettings(defaultDevice: device),
      ),
    );
    await service.loadSettings();

    expect(
      service.printTest,
      throwsA(
        isA<PrinterException>().having(
          (error) => error.code,
          'code',
          'bluetooth_disabled',
        ),
      ),
    );
    expect(transport.writeCalls, 0);
  });

  test('permiso denegado se puede solicitar antes de imprimir', () async {
    final transport = MockPrinterTransport(
      status: BluetoothAvailability.permissionDenied,
    );
    final service = PrinterService(
      transport: transport,
      store: InMemoryPrinterSettingsStore(
        const PrinterSettings(defaultDevice: device),
      ),
    );
    await service.loadSettings();

    await service.printTest();

    expect(transport.status, BluetoothAvailability.available);
    expect(transport.writeCalls, 1);
  });

  test('conexion rechazada entrega mensaje controlado', () async {
    final transport = MockPrinterTransport(failConnect: true);
    final service = PrinterService(
      transport: transport,
      store: InMemoryPrinterSettingsStore(
        const PrinterSettings(defaultDevice: device),
      ),
    );
    await service.loadSettings();

    expect(
      service.printTest,
      throwsA(
        isA<PrinterException>().having(
          (error) => error.code,
          'code',
          'connection_failed',
        ),
      ),
    );
  });

  test('escritura fallida no expone stack trace', () async {
    final transport = MockPrinterTransport(failWrite: true);
    final service = PrinterService(
      transport: transport,
      store: InMemoryPrinterSettingsStore(
        const PrinterSettings(defaultDevice: device),
      ),
    );
    await service.loadSettings();

    expect(
      service.printOrder(sampleReceiptOrder()),
      throwsA(
        isA<PrinterException>()
            .having((error) => error.code, 'code', 'write_failed')
            .having(
              (error) => error.message,
              'message',
              isNot(contains('Exception')),
            ),
      ),
    );
  });
}
