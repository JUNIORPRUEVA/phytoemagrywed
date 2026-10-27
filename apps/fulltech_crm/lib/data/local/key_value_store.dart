import 'package:shared_preferences/shared_preferences.dart';

/// Almacén clave-valor mínimo.
///
/// Existe para poder probar la cola y la migración de sesión sin tocar disco:
/// en producción se usa `SharedPreferences`, en las pruebas `MemoryKeyValueStore`.
abstract class KeyValueStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> remove(String key);
}

class PrefsKeyValueStore implements KeyValueStore {
  const PrefsKeyValueStore();

  @override
  Future<String?> read(String key) async => (await SharedPreferences.getInstance()).getString(key);

  @override
  Future<void> write(String key, String value) async {
    await (await SharedPreferences.getInstance()).setString(key, value);
  }

  @override
  Future<void> remove(String key) async {
    await (await SharedPreferences.getInstance()).remove(key);
  }
}

/// Solo para pruebas.
class MemoryKeyValueStore implements KeyValueStore {
  MemoryKeyValueStore([Map<String, String>? initial]) : _data = {...?initial};

  final Map<String, String> _data;

  Map<String, String> get snapshot => Map.unmodifiable(_data);

  @override
  Future<String?> read(String key) async => _data[key];

  @override
  Future<void> write(String key, String value) async => _data[key] = value;

  @override
  Future<void> remove(String key) async => _data.remove(key);
}
