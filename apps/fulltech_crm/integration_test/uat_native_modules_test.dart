import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'support/native_harness.dart';

/// Alcance NATIVO de modulos con icono directo en el rail de escritorio.
///
///   flutter test integration_test/uat_native_modules_test.dart -d windows
///     --dart-define=APP_ENV=uat --dart-define=API_BASE_URL=http://127.0.0.1:8791
///
/// Demuestra alcance y pintado con datos de la UAT, NO operaciones de negocio:
/// aqui no se crea, cobra ni mueve nada. Las operaciones siguen marcadas MANUAL.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('los modulos del rail abren y pintan datos de la UAT', (tester) async {
    await arrancar(tester);
    await entrarComoAdmin(tester);

    const modulos = <(String, String)>[
      ('Pedidos', 'pedidos'),
      ('Clientes', 'cliente'),
      ('Agentes IA', 'agente'),
      ('Reportes', 'reporte'),
      ('Configuración', 'configuraci'),
    ];

    final abiertos = <String>[];
    for (final (etiqueta, fragmento) in modulos) {
      await irA(tester, etiqueta);
      final listo = await esperar(
        tester,
        find.textContaining(RegExp(fragmento, caseSensitive: false), findRichText: true),
        segundos: 20,
      );
      final fallo = find.textContaining(RegExp('No se pudo|error al cargar', caseSensitive: false));
      expect(fallo, findsNothing,
          reason: 'El modulo "$etiqueta" mostro un error. En pantalla: ${textos(tester)}');
      if (listo) abiertos.add(etiqueta);
    }

    debugPrint('MODULOS ABIERTOS CON DATOS: ${abiertos.join(", ")}');
    expect(abiertos.length, greaterThanOrEqualTo(4),
        reason: 'Al menos 4 de 5 modulos deben pintar datos; abrieron: ${abiertos.join(", ")}');
  });
}
