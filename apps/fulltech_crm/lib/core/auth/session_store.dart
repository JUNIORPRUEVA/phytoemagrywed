import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../data/local/key_value_store.dart';

/// Caja segura del sistema (Keystore / Keychain / Credential Manager).
///
/// Se abstrae en una interfaz mínima para poder sustituirla en las pruebas sin
/// depender del plugin nativo.
abstract class SecureBox {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class FlutterSecureBox implements SecureBox {
  FlutterSecureBox([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

/// Dónde vive la cookie de sesión (`pe_crm`).
///
/// Antes se guardaba en `SharedPreferences` en claro. Ahora va al almacén
/// seguro del sistema. La migración es transparente: si hay un valor viejo en
/// preferences se mueve al llavero y se borra el original.
abstract class SessionStore {
  Future<String?> read();
  Future<void> write(String value);
  Future<void> clear();
}

class SecureSessionStore implements SessionStore {
  SecureSessionStore({SecureBox? box, KeyValueStore? legacy})
      : _box = box ?? FlutterSecureBox(),
        _legacy = legacy ?? const PrefsKeyValueStore();

  static const String key = 'ft_crm_session';
  static const String legacyKey = 'ft_crm_session';

  final SecureBox _box;
  final KeyValueStore _legacy;

  @override
  Future<String?> read() async {
    final current = await _box.read(key);
    if (current != null && current.isNotEmpty) return current;
    // Migración desde la versión anterior (preferences en claro).
    final old = await _legacy.read(legacyKey);
    if (old == null || old.isEmpty) return null;
    await _box.write(key, old);
    await _legacy.remove(legacyKey);
    return old;
  }

  @override
  Future<void> write(String value) => _box.write(key, value);

  @override
  Future<void> clear() async {
    await _box.delete(key);
    // Nunca puede quedar una copia en claro de una sesión cerrada.
    await _legacy.remove(legacyKey);
  }
}

/// Solo para pruebas.
class MemorySessionStore implements SessionStore {
  MemorySessionStore([this._value]);

  String? _value;

  String? get value => _value;

  @override
  Future<String?> read() async => _value;

  @override
  Future<void> write(String value) async => _value = value;

  @override
  Future<void> clear() async => _value = null;
}
