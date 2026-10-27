import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/net/operation_key.dart';

void main() {
  group('claves de operación', () {
    test('se generan con el formato que exige el servidor', () {
      for (var index = 0; index < 50; index++) {
        final key = newOperationKey('msg');
        expect(operationKeyPattern.hasMatch(key), isTrue, reason: 'clave inválida: $key');
      }
    });

    test('dos claves seguidas no chocan', () {
      final first = newOperationKey('msg');
      final second = newOperationKey('msg');
      expect(first, isNot(second));
    });

    test('un prefijo raro se sanea en vez de romper el envío', () {
      final key = newOperationKey('ñ á/');
      expect(operationKeyPattern.hasMatch(key), isTrue);
    });
  });
}
