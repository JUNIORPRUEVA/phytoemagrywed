import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:fulltech_crm/features/auth/login_screen.dart';
import 'package:fulltech_crm/features/shell/crm_shell.dart';

import 'support/native_harness.dart';

/// Aceptación NATIVA (ventana real de Windows) contra la UAT local.
///
///   flutter test integration_test/uat_native_smoke_test.dart -d windows
///     --dart-define=APP_ENV=uat --dart-define=API_BASE_URL=http://127.0.0.1:8791
///
/// Escenarios: acceso denegado, acceso correcto, pedidos con total real y
/// paginación más allá de 500, y entrada al módulo de clientes.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('acceso denegado, acceso correcto, pedidos >500 y clientes', (tester) async {
    await arrancar(tester);
    expect(find.byType(LoginScreen), findsOneWidget, reason: 'Sin sesión debe verse la tarjeta de acceso');

    // ── 1. Acceso DENEGADO ──────────────────────────────────────────────────
    await entrar(tester, uatAdmin, 'clave-que-no-es');
    final aviso = find.textContaining(
        RegExp('no pudimos|incorrect|inválid|credencial|clave', caseSensitive: false));
    expect(await esperar(tester, aviso, segundos: 20), isTrue,
        reason: 'Una clave incorrecta debe avisar. En pantalla: ${textos(tester)}');
    expect(find.byType(LoginScreen), findsOneWidget, reason: 'No debe haber sesión tras un acceso denegado');

    // ── 2. Acceso CORRECTO ──────────────────────────────────────────────────
    await entrar(tester, uatAdmin, uatClave);
    expect(await esperar(tester, find.byType(CrmShell), segundos: 30), isTrue,
        reason: 'El panel debe abrirse con las credenciales de la UAT. En pantalla: ${textos(tester)}');
    expect(find.byType(LoginScreen), findsNothing);

    // ── 3. PEDIDOS: total auténtico y paginación más allá de 500 ────────────
    await irA(tester, 'Pedidos');
    final pie = find.textContaining('pedidos de');
    expect(await esperar(tester, pie, segundos: 30), isTrue,
        reason: 'Pedidos debe cargar y mostrar el recuento. En pantalla: ${textos(tester)}');

    int mostrados() {
      final texto = tester.widget<Text>(pie.first).data ?? '';
      return int.tryParse(RegExp(r'(\d+)').firstMatch(texto)?.group(1) ?? '') ?? 0;
    }

    expect(mostrados(), greaterThan(0), reason: 'La primera página no puede venir vacía');
    expect(tester.widget<Text>(pie.first).data, isNot(contains('de 0')),
        reason: 'El total no puede ser «0» con pedidos cargados');

    final boton = find.text('Cargar más pedidos');
    var vueltas = 0;
    while (vueltas <= 12) {
      var encontrado = false;
      for (var intento = 0; intento < 40 && !encontrado; intento += 1) {
        if (boton.evaluate().isNotEmpty) {
          encontrado = true;
          break;
        }
        await tester.drag(
          find.descendant(of: find.byType(RefreshIndicator), matching: find.byType(Scrollable)).first,
          const Offset(0, -2500),
        );
        await tester.pump(const Duration(milliseconds: 250));
      }
      if (!encontrado) break;
      await tester.tap(boton.first);
      await tester.pump(const Duration(milliseconds: 1200));
      vueltas += 1;
      if (mostrados() > 520) break;
    }
    expect(mostrados(), greaterThan(500),
        reason: 'Debe superar el techo de 500 (vi ${mostrados()} tras $vueltas páginas)');

    // ── 4. CLIENTES ─────────────────────────────────────────────────────────
    await irA(tester, 'Clientes');
    expect(await esperar(tester, find.byType(ListView), segundos: 20), isTrue,
        reason: 'Clientes debe listar. En pantalla: ${textos(tester)}');
    expect(find.byType(CircularProgressIndicator), findsNothing,
        reason: 'Clientes no debe quedarse girando para siempre');
  });
}
