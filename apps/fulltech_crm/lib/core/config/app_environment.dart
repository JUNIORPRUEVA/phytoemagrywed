/// Entornos del CRM nativo.
///
/// REGLA DE ORO (fail-closed): una compilación de pruebas NUNCA debe poder
/// apuntar al dominio productivo. Para eso el entorno se declara a mano:
///
///   flutter run  --dart-define=APP_ENV=dev --dart-define=API_BASE_URL=http://10.0.2.2:4000
///   flutter build apk --dart-define=APP_ENV=uat --dart-define=API_BASE_URL=https://uat.phytoemagryrd.lat
///   flutter build apk --release      (sin defines = prod, dominio canónico)
///
/// Si `APP_ENV` no es `prod`, la URL es OBLIGATORIA y NO puede ser de producción.
/// Si `APP_ENV` es `prod`, la URL no puede ser local. Cualquier combinación
/// incoherente se rechaza antes de arrancar la app (ver `main.dart`).
library;

enum CrmEnvironment { dev, uat, prod }

/// Error de configuración: se muestra en pantalla, no se silencia.
class ConfigException implements Exception {
  ConfigException(this.message, {this.hint = ''});

  final String message;
  final String hint;

  @override
  String toString() => hint.isEmpty ? message : '$message\n$hint';
}

class AppEnvironment {
  const AppEnvironment({required this.environment, required this.apiBaseUrl});

  final CrmEnvironment environment;
  final String apiBaseUrl;

  /// Dominio productivo de PHYTOEMAGRY. Es el único host que se acepta sin
  /// declarar URL cuando el entorno es `prod`.
  static const String canonicalProductionUrl = 'https://phytoemagryrd.lat';

  /// Hosts considerados producción (incluye el canónico, su `www` y la IP del
  /// servidor: si mañana cambia, se añade aquí y las pruebas lo cubren).
  static const Set<String> productionHosts = {
    'phytoemagryrd.lat',
    'www.phytoemagryrd.lat',
    '31.97.99.70',
  };

  bool get isProduction => environment == CrmEnvironment.prod;

  /// En dev/UAT el panel lleva un distintivo visible para no confundir entornos.
  bool get showEnvironmentBadge => !isProduction;

  String get environmentLabel => switch (environment) {
        CrmEnvironment.dev => 'DESARROLLO',
        CrmEnvironment.uat => 'UAT',
        CrmEnvironment.prod => 'PRODUCCIÓN',
      };

  /// Resolución pura (sin `String.fromEnvironment`) para poder probarla.
  ///
  /// - `prod`: sin URL → dominio canónico. Con URL → tiene que ser de producción.
  /// - `dev` / `uat`: URL obligatoria y NO puede apuntar a producción.
  static AppEnvironment resolve({required String rawEnv, required String rawUrl}) {
    final env = _parseEnv(rawEnv);
    final url = rawUrl.trim();

    if (env == CrmEnvironment.prod) {
      if (url.isEmpty) {
        return const AppEnvironment(environment: CrmEnvironment.prod, apiBaseUrl: canonicalProductionUrl);
      }
      final host = hostOf(url);
      if (host == null) {
        throw ConfigException('API_BASE_URL no es una dirección válida: «$url».');
      }
      if (!productionHosts.contains(host)) {
        throw ConfigException(
          'APP_ENV=prod pero API_BASE_URL apunta a «$host».',
          hint: 'Si es un entorno de pruebas, declara APP_ENV=dev o APP_ENV=uat. '
              'Así una compilación de pruebas no puede usar producción por descuido.',
        );
      }
      return AppEnvironment(environment: CrmEnvironment.prod, apiBaseUrl: _normalize(url));
    }

    if (url.isEmpty) {
      throw ConfigException(
        'APP_ENV=${env.name} exige API_BASE_URL.',
        hint: 'Ejemplo: --dart-define=APP_ENV=${env.name} --dart-define=API_BASE_URL=http://10.0.2.2:4000',
      );
    }
    final host = hostOf(url);
    if (host == null) {
      throw ConfigException('API_BASE_URL no es una dirección válida: «$url».');
    }
    if (productionHosts.contains(host)) {
      throw ConfigException(
        'Bloqueado: APP_ENV=${env.name} no puede apuntar al dominio productivo «$host».',
        hint: 'Usa el servidor de UAT/desarrollo (por ejemplo http://10.0.2.2:4000 en el emulador).',
      );
    }
    return AppEnvironment(environment: env, apiBaseUrl: _normalize(url));
  }

  /// Valores reales del binario (los inyectados con `--dart-define`).
  static AppEnvironment get current => resolve(
        rawEnv: const String.fromEnvironment('APP_ENV', defaultValue: 'prod'),
        rawUrl: const String.fromEnvironment('API_BASE_URL'),
      );

  static CrmEnvironment _parseEnv(String raw) {
    switch (raw.trim().toLowerCase()) {
      case '':
      case 'prod':
      case 'production':
      case 'produccion':
        return CrmEnvironment.prod;
      case 'uat':
      case 'staging':
      case 'test':
        return CrmEnvironment.uat;
      case 'dev':
      case 'development':
      case 'desarrollo':
      case 'local':
        return CrmEnvironment.dev;
      default:
        throw ConfigException(
          'APP_ENV desconocido: «$raw».',
          hint: 'Valores válidos: dev, uat, prod.',
        );
    }
  }

  /// Host en minúsculas, o `null` si no es una URL absoluta http(s).
  static String? hostOf(String url) {
    final uri = Uri.tryParse(url.trim());
    if (uri == null || !uri.hasScheme || (uri.scheme != 'http' && uri.scheme != 'https')) return null;
    if (uri.host.isEmpty) return null;
    return uri.host.toLowerCase();
  }

  static String _normalize(String url) => url.trim().replaceAll(RegExp(r'/+$'), '');

  @override
  String toString() => 'AppEnvironment(${environment.name}, $apiBaseUrl)';
}
