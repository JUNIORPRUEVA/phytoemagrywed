import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:fulltech_crm/features/clientes/clientes_screen.dart';
import 'package:fulltech_crm/features/common/crm_ui.dart';
import 'package:fulltech_crm/features/pedidos/pedidos_screen.dart';

import 'support/native_harness.dart';

/// Aceptación NATIVA de flujos concretos (ventana real, HTTP real, UAT local).
///
///   flutter test integration_test/uat_native_flows_test.dart -d windows
///     --dart-define=APP_ENV=uat --dart-define=API_BASE_URL=http://127.0.0.1:8791
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('pedidos: filtro por estado y búsqueda con datos del servidor', (tester) async {
    final estado = await arrancar(tester);
    await entrarComoAdmin(tester);

    // Datos reales del servidor (la misma ruta que usa la pantalla).
    final pagina = await estado.repository.ordersPage(limit: 25);
    expect(pagina.orders, isNotEmpty, reason: 'La UAT debe tener pedidos sembrados');
    // Se prefiere un pedido SEMBRADO (clientes «Prueba …»), que sí trae
    // teléfono: las ventas sintéticas del POS pueden no guardarlo.
    final conTelefono = pagina.orders
        .where((row) => (row['phone'] ?? '').toString().trim().length >= 8)
        .toList();
    final sembrados = conTelefono
        .where((row) => (row['name'] ?? '').toString().startsWith('Prueba'))
        .toList();
    final primero = sembrados.isNotEmpty
        ? sembrados.first
        : (conTelefono.isNotEmpty ? conTelefono.first : pagina.orders.first);
    final nombre = (primero['name'] ?? '').toString();
    final telefono = (primero['phone'] ?? '').toString();
    expect(nombre.isNotEmpty, isTrue, reason: 'El pedido debe traer nombre');

    await irA(tester, 'Pedidos');
    expect(await esperar(tester, find.byType(PedidosScreen), segundos: 30), isTrue,
        reason: 'Pedidos no abrió. En pantalla: ${textos(tester)}');
    expect(await esperar(tester, find.textContaining('pedidos de'), segundos: 30), isTrue);

    // ── Filtro por estado. La UAT acumula pedidos entregados y cancelados
    // reales de otras pruebas, así que NO se exige que «Entregados» esté vacío
    // (eso dependía de una fixture que ya no es cierta): se exige que el filtro
    // responda y que «Abiertos» vuelva a mostrar pedidos.
    await tester.tap(find.text('Entregados'));
    await tester.pump(const Duration(milliseconds: 900));

    await tester.tap(find.text('Abiertos'));
    await tester.pump(const Duration(milliseconds: 900));
    expect(find.text('Sin pedidos con este filtro'), findsNothing,
        reason: 'Con «Abiertos» deben volver a aparecer pedidos');

    // ── Búsqueda por teléfono: el teléfono viene del SERVIDOR y el filtro debe
    // dejar ese pedido en pantalla.
    // El filtro de la pantalla compara texto CRUDO: se usa un fragmento del
    // teléfono tal cual (con guiones o prefijos) y no solo los dígitos.
    final aguja = telefono.trim().length >= 8
        ? telefono.trim().substring(telefono.trim().length - 8)
        : telefono.trim();
    expect(aguja.length, greaterThanOrEqualTo(6), reason: 'La UAT debe traer teléfonos reales');

    final campo =
        find.descendant(of: find.byType(PedidosScreen), matching: find.byType(TextField)).first;
    await tester.enterText(campo, aguja);
    await tester.pump(const Duration(milliseconds: 1000));
    expect(find.textContaining(nombre.split(' ').first), findsWidgets,
        reason: 'La búsqueda por teléfono debe dejar el pedido de «$nombre». '
            'En pantalla: ${textos(tester)}');

    await tester.enterText(campo, '');
    await tester.pump(const Duration(milliseconds: 500));
  });

  testWidgets('clientes: la ficha se abre con el cliente elegido', (tester) async {
    await arrancar(tester);
    await entrarComoAdmin(tester);

    await irA(tester, 'Clientes');
    expect(await esperar(tester, find.byType(ClientesScreen), segundos: 20), isTrue,
        reason: 'Clientes no abrió. En pantalla: ${textos(tester)}');
    expect(await esperar(tester, find.byType(CrmListTile), segundos: 20), isTrue,
        reason: 'La lista de clientes no pintó filas. En pantalla: ${textos(tester)}');

    final fila = find.byType(CrmListTile).first;
    final nombreFila = tester.widget<CrmListTile>(fila).title;
    await tester.tap(fila);
    await tester.pump(const Duration(milliseconds: 1000));

    expect(await esperar(tester, find.text('Ficha del cliente'), segundos: 20), isTrue,
        reason: 'La ficha del cliente no se abrió. En pantalla: ${textos(tester)}');
    expect(find.textContaining(nombreFila.split('·').first.trim()), findsWidgets,
        reason: 'La ficha debe mostrar el mismo cliente que se pulsó («$nombreFila»)');
    // La ficha carga su detalle: se espera a que termine (sin girar para siempre).
    var girando = find.byType(CircularProgressIndicator).evaluate().isNotEmpty;
    for (var intento = 0; intento < 20 && girando; intento += 1) {
      await tester.pump(const Duration(milliseconds: 400));
      girando = find.byType(CircularProgressIndicator).evaluate().isNotEmpty;
    }
    expect(girando, isFalse, reason: 'La ficha no debe quedarse girando');
  });
}

