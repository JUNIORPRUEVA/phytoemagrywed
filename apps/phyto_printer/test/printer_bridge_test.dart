import 'package:flutter_test/flutter_test.dart';
import 'package:phyto_printer/native_bridge/printer_bridge.dart';
import 'package:phyto_printer/printer/mock_printer_transport.dart';
import 'package:phyto_printer/printer/printer_models.dart';
import 'package:phyto_printer/printer/printer_service.dart';

void main() {
  const device = PrinterDevice(
    id: '00:11:22:33:44:55',
    name: 'POS-80',
    address: '00:11:22:33:44:55',
  );

  PrinterBridge bridge({
    required MockPrinterTransport transport,
    required InMemoryPrinterSettingsStore store,
    bool trusted = true,
    Future<PrinterSettings?> Function()? configurePrinter,
  }) {
    return PrinterBridge(
      service: PrinterService(transport: transport, store: store),
      isTrustedOrigin: () async => trusted,
      configurePrinter: configurePrinter,
    );
  }

  test('denies printer actions from untrusted origin', () async {
    final subject = bridge(
      transport: MockPrinterTransport(devices: [device]),
      store: InMemoryPrinterSettingsStore(),
      trusted: false,
    );

    expect(
      () => subject.handle({'scope': 'printer', 'action': 'printerStatus'}),
      throwsA(
        isA<PrinterBridgeException>().having(
          (error) => error.code,
          'code',
          'origin_denied',
        ),
      ),
    );
  });

  test('reports native printer status', () async {
    final subject = bridge(
      transport: MockPrinterTransport(devices: [device]),
      store: InMemoryPrinterSettingsStore(
        const PrinterSettings(defaultDevice: device),
      ),
    );

    final result = await subject.handle({
      'scope': 'printer',
      'action': 'printerStatus',
    });

    expect(result['native'], isTrue);
    expect(result['bluetooth'], 'available');
    expect((result['defaultDevice'] as Map)['name'], 'POS-80');
    expect(result['autoPrint'], isFalse);
  });

  test('lists paired mock printers', () async {
    final subject = bridge(
      transport: MockPrinterTransport(devices: [device]),
      store: InMemoryPrinterSettingsStore(),
    );

    final result = await subject.handle({
      'scope': 'printer',
      'action': 'listPrinters',
    });

    final devices = result['devices'] as List;
    expect(devices, hasLength(1));
    expect((devices.first as Map)['id'], device.id);
  });

  test('persists configuration returned by native selector', () async {
    final store = InMemoryPrinterSettingsStore();
    final service = PrinterService(
      transport: MockPrinterTransport(devices: [device]),
      store: store,
    );
    final subject = PrinterBridge(
      service: service,
      isTrustedOrigin: () async => true,
      configurePrinter: () async {
        final next = const PrinterSettings(
          defaultDevice: device,
          paperWidth: PrinterPaperWidth.mm80,
        );
        await service.saveSettings(next);
        return next;
      },
    );

    await subject.handle({'scope': 'printer', 'action': 'configurePrinter'});

    expect(store.value.defaultDevice?.id, device.id);
    expect(store.value.paperWidth, PrinterPaperWidth.mm80);
  });

  test('prints a test ticket through printer service', () async {
    final transport = MockPrinterTransport(devices: [device]);
    final subject = bridge(
      transport: transport,
      store: InMemoryPrinterSettingsStore(
        const PrinterSettings(defaultDevice: device),
      ),
    );

    final result = await subject.handle({
      'scope': 'printer',
      'action': 'testPrint',
    });

    expect(result['printed'], isTrue);
    expect(transport.connectCalls, 1);
    expect(transport.writeCalls, 1);
    expect(transport.writes.single, isNotEmpty);
  });

  test('prints a real CRM receipt payload', () async {
    final transport = MockPrinterTransport(devices: [device]);
    final subject = bridge(
      transport: transport,
      store: InMemoryPrinterSettingsStore(
        const PrinterSettings(defaultDevice: device),
      ),
    );

    final result = await subject.handle({
      'scope': 'printer',
      'action': 'printReceipt',
      'payload': {
        'order_number': 'PV-1001',
        'created_at': '2026-10-04T10:00:00Z',
        'customer_name': 'Cliente Produccion',
        'items': [
          {
            'variant_name': 'Capsulas x1',
            'quantity': 2,
            'unit_price': 500,
            'total': 1000,
          },
        ],
        'total': 1000,
        'currency': 'DOP',
      },
    });

    expect(result['printed'], isTrue);
    expect(result['orderNumber'], 'PV-1001');
    expect(transport.writeCalls, 1);
  });
}
