import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/data/local/key_value_store.dart';

import 'support/fakes.dart';

void main() {
  group('sesión en almacén seguro', () {
    test('guarda, lee y borra', () async {
      final box = FakeSecureBox();
      final store = SecureSessionStore(box: box, legacy: MemoryKeyValueStore());

      await store.write('abc123');
      expect(await store.read(), 'abc123');
      expect(box.data[SecureSessionStore.key], 'abc123');

      await store.clear();
      expect(await store.read(), isNull);
      expect(box.data, isEmpty);
    });

    test('migra una sesión antigua en preferences y borra el original', () async {
      final box = FakeSecureBox();
      final legacy = MemoryKeyValueStore({SecureSessionStore.legacyKey: 'vieja-sesion'});
      final store = SecureSessionStore(box: box, legacy: legacy);

      expect(await store.read(), 'vieja-sesion');
      // Ya está en el llavero...
      expect(box.data[SecureSessionStore.key], 'vieja-sesion');
      // ...y NO queda copia en claro.
      expect(legacy.snapshot, isEmpty);
    });

    test('si no hay nada, no inventa sesión', () async {
      final store = SecureSessionStore(box: FakeSecureBox(), legacy: MemoryKeyValueStore());
      expect(await store.read(), isNull);
    });

    test('cerrar sesión limpia también la copia antigua', () async {
      final legacy = MemoryKeyValueStore({SecureSessionStore.legacyKey: 'vieja'});
      final store = SecureSessionStore(box: FakeSecureBox(), legacy: legacy);
      await store.clear();
      expect(legacy.snapshot, isEmpty);
    });

    test('una caja con valor vacío se trata como sin sesión', () async {
      final box = FakeSecureBox();
      await box.write(SecureSessionStore.key, '');
      final store = SecureSessionStore(box: box, legacy: MemoryKeyValueStore());
      expect(await store.read(), isNull);
    });
  });
}
