import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/data/models/partial_data_notice.dart';

void main() {
  group('listados parciales', () {
    test('un paquete completo no muestra aviso', () {
      expect(
        PartialDataNotice.message(partial: false, customersComplete: true, conversationsComplete: true),
        isEmpty,
      );
    });

    test('paquete recortado con listas completas avisa solo de pedidos', () {
      final message = PartialDataNotice.message(
        partial: true,
        customersComplete: true,
        conversationsComplete: true,
      );
      expect(message, contains('150'));
      expect(message.toLowerCase(), contains('pedidos'));
    });

    test('nunca dice «completo» cuando faltan clientes o bandeja', () {
      final message = PartialDataNotice.message(
        partial: true,
        customersComplete: false,
        conversationsComplete: false,
      );
      expect(message, contains('clientes'));
      expect(message, contains('bandeja'));
      expect(message.toLowerCase(), contains('incompleta'));
    });

    test('el límite coincide con el del servidor', () {
      expect(PartialDataNotice.serverLimit, 150);
    });
  });
}
