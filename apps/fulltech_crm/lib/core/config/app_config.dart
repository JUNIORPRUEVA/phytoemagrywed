import 'app_environment.dart';

/// Configuración de compilación del CRM nativo.
///
/// La URL NO se escribe aquí: la resuelve `AppEnvironment` con las reglas de
/// entorno (una compilación de pruebas no puede apuntar a producción).
class AppConfig {
  const AppConfig._();

  static AppEnvironment? _environment;

  static AppEnvironment get environment {
    final value = _environment;
    if (value == null) {
      throw StateError('AppConfig.init() no se llamó: el entorno no está resuelto.');
    }
    return value;
  }

  static void init(AppEnvironment environment) => _environment = environment;

  static String get apiBaseUrl => environment.apiBaseUrl;

  static const String appName = 'FullTECH CRM';
  static const String brand = 'FullTECH';
  static const String brandSub = 'CRM';

  /// Ruta absoluta de un recurso servido por la API.
  static String? absoluteUrl(String? path) {
    if (path == null || path.isEmpty) return null;
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    final base = apiBaseUrl.replaceAll(RegExp(r'/+$'), '');
    return path.startsWith('/') ? '$base$path' : '$base/$path';
  }
}
