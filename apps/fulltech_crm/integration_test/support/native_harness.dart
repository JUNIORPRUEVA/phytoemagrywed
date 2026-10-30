import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'package:fulltech_crm/app/crm_app.dart';
import 'package:fulltech_crm/app/crm_scope.dart';
import 'package:fulltech_crm/app/crm_state.dart';
import 'package:fulltech_crm/core/auth/session_store.dart';
import 'package:fulltech_crm/core/config/app_config.dart';
import 'package:fulltech_crm/core/config/app_environment.dart';
import 'package:fulltech_crm/core/net/api_client.dart';
import 'package:fulltech_crm/data/crm_repository.dart';
import 'package:fulltech_crm/features/shell/crm_shell.dart';
import 'package:fulltech_crm/features/shell/crm_menu_drawer.dart';
import 'package:fulltech_crm/features/shell/pwa_shell.dart';

/// Utilidades compartidas por las pruebas de aceptación NATIVA de Windows.
///
/// Todas ellas abren la aplicación real (motor, ventana y HTTP reales) contra la
/// UAT local. Si el entorno no es `uat`/`dev` con `API_BASE_URL` explícita, el
/// arranque lanza `ConfigException`: la aceptación nunca corre contra producción.

const String uatAdmin = 'admin@uat.local';
const String uatClave = 'UatLocal-123';

/// Bombea el reloj real hasta que el buscador encuentre algo.
Future<bool> esperar(WidgetTester tester, Finder finder, {int segundos = 25}) async {
  final limite = DateTime.now().add(Duration(seconds: segundos));
  while (DateTime.now().isBefore(limite)) {
    await tester.pump(const Duration(milliseconds: 120));
    if (finder.evaluate().isNotEmpty) return true;
  }
  return false;
}

/// Textos visibles: sirve para saber QUÉ se está viendo cuando algo falla.
String textos(WidgetTester tester) {
  final vistos = <String>[];
  for (final w in tester.widgetList<Text>(find.byType(Text))) {
    final t = (w.data ?? w.textSpan?.toPlainText() ?? '').trim();
    if (t.isNotEmpty) vistos.add(t);
  }
  return vistos.take(200).join(' | ');
}

/// Arranca la app real desde cero (sin sesión guardada) y devuelve el estado.
Future<CrmState> arrancar(WidgetTester tester) async {
  await initializeDateFormatting('es', null);
  final entorno = AppEnvironment.current;
  expect(entorno.isProduction, isFalse,
      reason: 'La aceptación nativa jamás corre contra producción (API_BASE_URL=${entorno.apiBaseUrl})');
  AppConfig.init(entorno);
  final estado = CrmState(CrmRepository(ApiClient(baseUrl: entorno.apiBaseUrl)));
  // Instalación limpia: sin sesión previa la prueba es repetible.
  await SecureSessionStore().clear();

  // Los errores asíncronos del arranque se capturan aquí para que un fallo de
  // red no se confunda con un fallo del escenario, sin ocultarlos.
  final errores = <String>[];
  await runZonedGuarded(() async {
    await tester.pumpWidget(CrmApp(state: estado, environment: entorno));
    await estado.boot();
  }, (Object error, StackTrace stack) {
    errores.add('$error\n$stack');
  });
  for (final error in errores) {
    debugPrint('ERROR DE ARRANQUE:\n$error');
  }
  await tester.pump(const Duration(milliseconds: 300));
  if (estado.authenticated) {
    await estado.logout();
    await tester.pump(const Duration(milliseconds: 300));
  }
  return estado;
}

/// Escribe usuario y clave en la tarjeta de acceso y pulsa «Entrar».
Future<void> entrar(WidgetTester tester, String usuario, String clave) async {
  // Puede quedar una sesión guardada de una ejecución anterior: se cierra para
  // que la prueba sea repetible, y se espera a que aparezca la tarjeta.
  if (find.text('Entrar').evaluate().isEmpty) {
    final elemento =
        tester.element(find.byType(MaterialApp)).getElementForInheritedWidgetOfExactType<CrmScope>();
    final crm = (elemento?.widget as CrmScope?)?.notifier;
    if (crm != null && crm.authenticated) {
      await crm.logout();
      await tester.pump(const Duration(milliseconds: 400));
    }
  }
  expect(await esperar(tester, find.text('Entrar'), segundos: 25), isTrue,
      reason: 'No apareció la tarjeta de acceso. En pantalla: ${textos(tester)}');
  final campos = find.byType(TextField);
  expect(campos, findsNWidgets(2), reason: 'La tarjeta de acceso debe tener usuario y clave');
  await tester.enterText(campos.at(0), usuario);
  await tester.enterText(campos.at(1), clave);
  await tester.pump(const Duration(milliseconds: 150));
  await tester.tap(find.text('Entrar'));
  await tester.pump(const Duration(milliseconds: 250));
}

/// Inicia sesión con el administrador de la UAT y espera al panel.
Future<void> entrarComoAdmin(WidgetTester tester) async {
  await entrar(tester, uatAdmin, uatClave);
  expect(await esperar(tester, find.byType(CrmShell), segundos: 30), isTrue,
      reason: 'El panel no se abrió. En pantalla: ${textos(tester)}');
}

/// Navega por el rail de escritorio o por el menú lateral.
Future<void> irA(WidgetTester tester, String etiqueta) async {
  // 1) Rail permanente de escritorio: cada icono lleva el nombre en un tooltip.
  final rail = find.byTooltip(etiqueta);
  if (rail.evaluate().isNotEmpty) {
    await tester.tap(rail.first);
    await tester.pump(const Duration(milliseconds: 700));
    return;
  }

  // 2) Menú lateral: botón del armazón de escritorio, botón antiguo o móvil.
  Future<void> abrirMenu() async {
    final escritorio = find.byType(CrmDrawerButton);
    if (escritorio.evaluate().isNotEmpty) {
      await tester.tap(escritorio.first);
    } else {
      final antiguo = find.byType(PwaMenuButton);
      if (antiguo.evaluate().isNotEmpty) {
        await tester.tap(antiguo.first);
      } else {
        final movil = find.byTooltip('Abrir menú');
        expect(movil, findsWidgets,
            reason: 'No hay botón de menú. En pantalla: ${textos(tester)}');
        await tester.tap(movil.first);
      }
    }
    await tester.pump(const Duration(milliseconds: 650));
  }

  await abrirMenu();
  if (find.byType(CrmMenuDrawer).evaluate().isEmpty) {
    await abrirMenu(); // el primer toque pudo cerrar un menú ya abierto
  }
  expect(find.byType(CrmMenuDrawer), findsWidgets,
      reason: 'El menú lateral no se abrió. En pantalla: ${textos(tester)}');

  // Los módulos agrupados están plegados: se despliegan DENTRO del menú (nunca
  // se pulsa el fondo, que cerraría el panel). Si el destino queda por debajo
  // del pliegue de la lista, se desplaza el menú y se reintenta.
  final enMenu = find.descendant(of: find.byType(CrmMenuDrawer), matching: find.text(etiqueta));
  bool visible() => enMenu.evaluate().isNotEmpty;
  Future<void> desplegarGrupos() async {
    for (final grupo in const ['Ventas', 'Entregas', 'Operación', 'Cierre diario', 'Sistema']) {
      final cabecera = find.descendant(of: find.byType(CrmMenuDrawer), matching: find.text(grupo));
      if (cabecera.evaluate().isNotEmpty) {
        await tester.tap(cabecera.first);
        await tester.pump(const Duration(milliseconds: 400));
      }
      if (visible()) return;
    }
  }

  if (!visible()) await desplegarGrupos();
  for (var intento = 0; intento < 6 && !visible(); intento++) {
    final lista = find.descendant(of: find.byType(CrmMenuDrawer), matching: find.byType(Scrollable));
    if (lista.evaluate().isEmpty) break;
    await tester.drag(lista.first, const Offset(0, -260));
    await tester.pump(const Duration(milliseconds: 400));
    await desplegarGrupos();
  }
  expect(await esperar(tester, enMenu, segundos: 10), isTrue,
      reason: 'No encuentro «$etiqueta» en el menú. En pantalla: ${textos(tester)}');
  await tester.ensureVisible(enMenu.first);
  await tester.pump(const Duration(milliseconds: 200));
  await tester.tap(enMenu.first);
  await tester.pump(const Duration(milliseconds: 800));
}

/// Asienta los frames pendientes (diálogos, rutas) sin quedarse colgado en
/// animaciones infinitas como un indicador de progreso.
Future<void> asentar(WidgetTester tester, {int segundos = 15}) async {
  try {
    await tester.pumpAndSettle(
      const Duration(milliseconds: 120),
      EnginePhase.sendSemanticsUpdate,
      Duration(seconds: segundos),
    );
  } catch (_) {
    await tester.pump(const Duration(milliseconds: 400));
  }
}

/// Espera a un buscador asentando frames en cada intento.
Future<bool> esperarAsentando(WidgetTester tester, Finder finder, {int segundos = 30}) async {
  final limite = DateTime.now().add(Duration(seconds: segundos));
  while (DateTime.now().isBefore(limite)) {
    if (finder.evaluate().isNotEmpty) return true;
    await asentar(tester, segundos: 3);
  }
  return finder.evaluate().isNotEmpty;
}

/// Realiza una venta manual completa desde el POS nativo:
/// cliente sintético, línea fuera de inventario (precio y descuento dados),
/// retiro en tienda y cobro. Devuelve el nombre del cliente usado.
Future<String> ventaManualEnPos(
  WidgetTester tester, {
  required String sello,
  required String descripcion,
  required int precio,
  double descuentoPct = 0,
}) async {
  final cliente = 'QA F15 $sello';
  final telefono = '809${sello.substring(sello.length - 7)}';

  await irA(tester, 'Facturación');
  await asentar(tester);
  expect(await esperarAsentando(tester, find.text('Agregar cliente')), isTrue,
      reason: 'El POS no abrió. En pantalla: ${textos(tester)}');

  await tester.tap(find.text('Agregar cliente').first);
  await asentar(tester);
  await tester.tap(find.text('Nuevo cliente'));
  await asentar(tester);
  final campos = find.descendant(of: find.byType(AlertDialog), matching: find.byType(TextField));
  await tester.enterText(campos.at(0), telefono);
  await tester.enterText(campos.at(1), cliente);
  await asentar(tester);
  await tester.tap(find.text('Crear'));
  await asentar(tester);
  expect(await esperarAsentando(tester, find.textContaining(cliente)), isTrue,
      reason: 'El cliente no quedó seleccionado. En pantalla: ${textos(tester)}');

  await tester.tap(find.text('Venta fuera de inventario').first);
  await asentar(tester);
  final manual = find.descendant(of: find.byType(AlertDialog), matching: find.byType(TextField));
  expect(manual.evaluate().length, greaterThanOrEqualTo(3));
  await tester.enterText(manual.at(0), descripcion);
  await tester.enterText(manual.at(1), '1');
  await tester.enterText(manual.at(2), '$precio');
  await asentar(tester);
  await tester.tap(find.text('Agregar al ticket'));
  await asentar(tester);

  if (descuentoPct > 0) {
    final boton = find.byTooltip('Descuento en esta línea');
    expect(await esperarAsentando(tester, boton), isTrue);
    await tester.tap(boton.first);
    await asentar(tester);
    final campo =
        find.ancestor(of: find.text('Porcentaje'), matching: find.byType(TextField));
    await tester.enterText(campo.first, descuentoPct.toStringAsFixed(0));
    await asentar(tester);
    await tester.tap(find.text('Aplicar'));
    await asentar(tester);
  }

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
  return cliente;
}

