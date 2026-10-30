import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:fulltech_crm/app/crm_app.dart';
import 'package:fulltech_crm/app/crm_state.dart';
import 'package:fulltech_crm/core/config/app_environment.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/data/crm_repository.dart';
import 'package:fulltech_crm/features/shell/crm_shell.dart';

import 'support/native_harness.dart';

/// Restauración de sesión guardada (el caso que antes producía un
/// `ArgumentError` asíncrono intermitente al arrancar).
///
///   flutter test integration_test/uat_native_session_test.dart -d windows
///     --dart-define=APP_ENV=uat --dart-define=API_BASE_URL=http://127.0.0.1:8791
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('una sesión guardada se restaura sin errores asincronos', (tester) async {
    // Primera instancia: arranque limpio + login real (deja la sesión guardada).
    await arrancar(tester);
    await entrarComoAdmin(tester);
    expect(find.byType(CrmShell), findsOneWidget);

    // Segunda instancia: simula reabrir la aplicación con la sesión guardada.
    final entorno = AppEnvironment.current;
    final estado = CrmState(CrmRepository(ApiClient(baseUrl: entorno.apiBaseUrl)));
    final errores = <String>[];
    await runZonedGuarded(() async {
      await tester.pumpWidget(CrmApp(state: estado, environment: entorno));
      await estado.boot();
    }, (Object error, StackTrace stack) {
      errores.add('$error');
    });
    await tester.pump(const Duration(milliseconds: 1200));

    expect(estado.authenticated, isTrue,
        reason: 'La sesión guardada debe restaurarse y quedar autenticada');
    expect(errores, isEmpty,
        reason: 'El arranque con sesión guardada no puede lanzar errores asíncronos: $errores');

    // El panel debe quedar operativo (no una pantalla de acceso ni un error).
    expect(await esperar(tester, find.byType(CrmShell), segundos: 20), isTrue,
        reason: 'Debe entrar directo al panel. En pantalla: ${textos(tester)}');
    expect(find.text('Escribe usuario y contraseña.'), findsNothing);
  });
}

