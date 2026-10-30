import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'support/native_harness.dart';

/// POS NATIVO contra la UAT aislada: cliente sintético, venta fuera de
/// inventario, descuento de línea del 10 % y cobro real.
///
///   flutter test integration_test/uat_native_pos_test.dart -d windows
///     --dart-define=APP_ENV=uat --dart-define=API_BASE_URL=http://127.0.0.1:8791
///
/// Nota técnica: en el binding de integración conviene ASENTAR los frames
/// (`pumpAndSettle`) entre pasos. Bombear frames sueltos mientras un diálogo
/// está entrando provoca que el overlay se re-monte y Flutter detecte claves
/// globales duplicadas (fallo del arnés, no del producto).
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  Future<void> asentar(WidgetTester tester, {int segundos = 15}) async {
    try {
      await tester.pumpAndSettle(
        const Duration(milliseconds: 120),
        EnginePhase.sendSemanticsUpdate,
        Duration(seconds: segundos),
      );
    } catch (_) {
      // Animación infinita (spinner): se sigue con un pulso corto.
      await tester.pump(const Duration(milliseconds: 400));
    }
  }

  Future<bool> esperarAsentando(
    WidgetTester tester,
    Finder finder, {
    int segundos = 30,
  }) async {
    final limite = DateTime.now().add(Duration(seconds: segundos));
    while (DateTime.now().isBefore(limite)) {
      if (finder.evaluate().isNotEmpty) return true;
      await asentar(tester, segundos: 3);
    }
    return finder.evaluate().isNotEmpty;
  }

  testWidgets('POS: venta manual con descuento de linea y cobro', (tester) async {
    final estado = await arrancar(tester);
    await asentar(tester);
    await entrarComoAdmin(tester);
    await asentar(tester);

    // Estado del servidor ANTES (autoritativo).
    final antes = await estado.repository.ordersPage(limit: 5);
    final pedidosAntes = antes.total;
    final inventarioAntes = await estado.repository.inventory();

    // Datos 100 % sintéticos y únicos de esta ejecución.
    final sello = DateTime.now().millisecondsSinceEpoch.toString();
    final cliente = 'QA F13 $sello';
    final telefono = '809${sello.substring(sello.length - 7)}';

    await irA(tester, 'Facturación');
    await asentar(tester);
    expect(await esperarAsentando(tester, find.text('Agregar cliente')), isTrue,
        reason: 'El POS no abrió. En pantalla: ${textos(tester)}');

    // ── Cliente sintético ───────────────────────────────────────────────────
    await tester.tap(find.text('Agregar cliente').first);
    await asentar(tester);
    expect(await esperarAsentando(tester, find.text('Nuevo cliente')), isTrue,
        reason: 'El selector de cliente no abrió. En pantalla: ${textos(tester)}');
    await tester.tap(find.text('Nuevo cliente'));
    await asentar(tester);

    final camposCliente = find.descendant(
      of: find.byType(AlertDialog),
      matching: find.byType(TextField),
    );
    expect(camposCliente, findsNWidgets(2), reason: 'El diálogo debe pedir teléfono y nombre');
    await tester.enterText(camposCliente.at(0), telefono);
    await tester.enterText(camposCliente.at(1), cliente);
    await asentar(tester);
    await tester.tap(find.text('Crear'));
    await asentar(tester);
    expect(await esperarAsentando(tester, find.textContaining(cliente)), isTrue,
        reason: 'El cliente no quedó seleccionado. En pantalla: ${textos(tester)}');

    // ── Artículo fuera de inventario ────────────────────────────────────────
    await tester.tap(find.text('Venta fuera de inventario').first);
    await asentar(tester);
    expect(await esperarAsentando(tester, find.text('Agregar al ticket')), isTrue,
        reason: 'El diálogo de venta manual no abrió. En pantalla: ${textos(tester)}');

    final camposManual = find.descendant(
      of: find.byType(AlertDialog),
      matching: find.byType(TextField),
    );
    expect(camposManual.evaluate().length, greaterThanOrEqualTo(3),
        reason: 'Se esperan descripción, cantidad y precio');
    await tester.enterText(camposManual.at(0), 'Servicio QA F13');
    await tester.enterText(camposManual.at(1), '1');
    await tester.enterText(camposManual.at(2), '100');
    await asentar(tester);
    await tester.tap(find.text('Agregar al ticket'));
    await asentar(tester);
    expect(await esperarAsentando(tester, find.textContaining('Servicio QA F13')), isTrue,
        reason: 'La línea manual no entró al carrito. En pantalla: ${textos(tester)}');

    // ── Descuento del 10 % en ESA línea ─────────────────────────────────────
    final botonDescuento = find.byTooltip('Descuento en esta línea');
    expect(await esperarAsentando(tester, botonDescuento), isTrue,
        reason: 'No aparece el botón de descuento de línea. En pantalla: ${textos(tester)}');
    await tester.tap(botonDescuento.first);
    await asentar(tester);
    expect(await esperarAsentando(tester, find.text('Aplicar')), isTrue,
        reason: 'El diálogo de descuento no abrió. En pantalla: ${textos(tester)}');
    // El diálogo abre ya en modo porcentaje: se escribe directo en su campo
    // (localizado por la etiqueta «Porcentaje», no por índice).
    final campoDescuento =
        find.ancestor(of: find.text('Porcentaje'), matching: find.byType(TextField));
    expect(await esperarAsentando(tester, campoDescuento), isTrue,
        reason: 'No encuentro el campo de porcentaje. En pantalla: ${textos(tester)}');
    await tester.enterText(campoDescuento.first, '10');
    await asentar(tester);
    expect(find.textContaining('Queda en'), findsWidgets,
        reason: 'El diálogo debe previsualizar el importe resultante');
    await tester.tap(find.text('Aplicar'));
    await asentar(tester);

    // La previsualización debe reflejar 90,00 (100 − 10 %).
    expect(await esperarAsentando(tester, find.textContaining(RegExp(r'90[.,]00'))), isTrue,
        reason: 'La previsualización debe mostrar 90,00. En pantalla: ${textos(tester)}');

    // ── Cobro real contra la UAT ────────────────────────────────────────────
    // El documento nace como «Domicilio», que exige dirección; para una venta
    // sintética se elige «Retiro» en tienda.
    await tester.tap(find.text('Retiro'));
    await asentar(tester);

    final cobrar = find.text('Crear pedido');
    expect(await esperarAsentando(tester, cobrar), isTrue,
        reason: 'No encuentro el botón de cobro. En pantalla: ${textos(tester)}');
    await tester.tap(cobrar.first);
    expect(await esperarAsentando(tester, find.text('Listo'), segundos: 60), isTrue,
        reason: 'El cobro no confirmó. En pantalla: ${textos(tester)}');
    await tester.tap(find.text('Listo'));
    await asentar(tester);

    // ── Verificación en el SERVIDOR (no en la pantalla) ──────────────────────
    final despues = await estado.repository.ordersPage(limit: 5);
    expect(despues.total, pedidosAntes + 1,
        reason: 'Debe crearse EXACTAMENTE un pedido (antes=$pedidosAntes, después=${despues.total})');

    final nuevo = despues.orders.firstWhere(
      (row) => (row['name'] ?? '').toString().contains(sello),
      orElse: () => <String, dynamic>{},
    );
    expect(nuevo, isNotEmpty,
        reason: 'El pedido del cliente sintético no aparece en el servidor. '
            'Primeros nombres: ${despues.orders.map((r) => r['name']).take(3).toList()}');
    final total = double.tryParse(nuevo['total'].toString()) ?? -1;
    expect(total, closeTo(90, 0.01),
        reason: 'El servidor debe guardar 90.00 tras el 10 % (guardó $total)');
    debugPrint('POS OK: pedido=${nuevo['id']} total=$total');

    // ── Escenario 9: la venta manual NO puede mover el inventario ────────────
    // Se compara la huella del inventario autoritativo (stock de cápsulas
    // compartidas + stock por presentación) y el último movimiento del libro.
    String huella(Map<String, dynamic> inventario) {
      final copia = Map<String, dynamic>.from(inventario)
        ..remove('movements')
        ..remove('current_unit_cost');
      final movimientos = (inventario['movements'] as List?) ?? const [];
      final ultimo = movimientos.isNotEmpty && movimientos.first is Map
          ? '${(movimientos.first as Map)['id']}'
          : '';
      return '${jsonEncode(copia)}#mov:${movimientos.length}#ultimo:$ultimo';
    }

    final inventarioDespues = await estado.repository.inventory();
    expect(huella(inventarioDespues), huella(inventarioAntes),
        reason: 'Una venta fuera de inventario no puede alterar existencias ni '
            'crear movimientos de inventario');

    // La línea manual debe viajar en el pedido tal como la define el servidor.
    final payload = (nuevo['payload'] ?? '').toString();
    expect(payload.contains('Servicio QA F13'), isTrue,
        reason: 'El pedido guardado debe contener la línea manual. Payload: '
            '${payload.length > 220 ? payload.substring(0, 220) : payload}');
    debugPrint('INVENTARIO SIN CAMBIOS: movimientos=${(inventarioDespues['movements'] as List?)?.length}');
  });
}




