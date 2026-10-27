import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/core/config/app_environment.dart';

void main() {
  group('entorno fail-closed', () {
    test('sin APP_ENV ni URL usa producción canónica', () {
      final env = AppEnvironment.resolve(rawEnv: '', rawUrl: '');
      expect(env.isProduction, isTrue);
      expect(env.apiBaseUrl, AppEnvironment.canonicalProductionUrl);
      expect(env.showEnvironmentBadge, isFalse);
    });

    test('UAT con dominio productivo se RECHAZA', () {
      expect(
        () => AppEnvironment.resolve(rawEnv: 'uat', rawUrl: 'https://phytoemagryrd.lat'),
        throwsA(isA<ConfigException>()),
      );
    });

    test('dev con dominio productivo se RECHAZA', () {
      expect(
        () => AppEnvironment.resolve(rawEnv: 'dev', rawUrl: 'https://www.phytoemagryrd.lat'),
        throwsA(isA<ConfigException>()),
      );
    });

    test('dev con la IP del servidor productivo se RECHAZA', () {
      expect(
        () => AppEnvironment.resolve(rawEnv: 'dev', rawUrl: 'http://31.97.99.70:4000'),
        throwsA(isA<ConfigException>()),
      );
    });

    test('uat/dev exigen API_BASE_URL', () {
      expect(() => AppEnvironment.resolve(rawEnv: 'uat', rawUrl: ''), throwsA(isA<ConfigException>()));
      expect(() => AppEnvironment.resolve(rawEnv: 'dev', rawUrl: ''), throwsA(isA<ConfigException>()));
    });

    test('dev con emulador es válido y lleva distintivo', () {
      final env = AppEnvironment.resolve(rawEnv: 'dev', rawUrl: 'http://10.0.2.2:4000');
      expect(env.isProduction, isFalse);
      expect(env.showEnvironmentBadge, isTrue);
      expect(env.environmentLabel, 'DESARROLLO');
      expect(env.apiBaseUrl, 'http://10.0.2.2:4000');
    });

    test('uat con host propio es válido', () {
      final env = AppEnvironment.resolve(rawEnv: 'uat', rawUrl: 'https://uat.phytoemagryrd.lat/');
      expect(env.environmentLabel, 'UAT');
      // La barra final se normaliza para no construir URLs dobles.
      expect(env.apiBaseUrl, 'https://uat.phytoemagryrd.lat');
    });

    test('prod con URL de producción explícita es válido', () {
      final env = AppEnvironment.resolve(rawEnv: 'prod', rawUrl: 'https://phytoemagryrd.lat');
      expect(env.isProduction, isTrue);
    });

    test('prod con URL local se RECHAZA (build mal etiquetado)', () {
      expect(
        () => AppEnvironment.resolve(rawEnv: 'prod', rawUrl: 'http://10.0.2.2:4000'),
        throwsA(isA<ConfigException>()),
      );
    });

    test('un APP_ENV desconocido no arranca', () {
      expect(
        () => AppEnvironment.resolve(rawEnv: 'preprod', rawUrl: 'https://x.example'),
        throwsA(isA<ConfigException>()),
      );
    });

    test('una URL sin esquema se rechaza', () {
      expect(
        () => AppEnvironment.resolve(rawEnv: 'dev', rawUrl: '10.0.2.2:4000'),
        throwsA(isA<ConfigException>()),
      );
    });
  });
}
