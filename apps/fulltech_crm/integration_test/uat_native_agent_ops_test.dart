// Aceptación NATIVA (Windows, UAT aislada) de las OPERACIONES DE AGENTE del chat.
//
// Qué demuestra esta prueba:
//   · las acciones se ejecutan desde la INTERFAZ REAL de escritorio (bandeja de
//     tres paneles, panel de opciones, menú de fila y barra de selección),
//   · cada acción produce una MUTACIÓN REAL en el servidor, comprobada después
//     por HTTP contra el mismo servidor UAT (no contra el estado de la pantalla),
//   · la asignación deja constancia de QUIÉN quedó al frente,
//   · archivar saca la conversación de la bandeja y el filtro «Archivados» la
//     devuelve para poder desarchivarla,
//   · la barra de selección ejecuta UNA acción en lote y el servidor confirma
//     cuántos registros cambiaron.
//
// No se reimplementa nada: se usan los botones que ya tiene el producto.
// El transporte de WhatsApp de la UAT es MOCK: aquí no sale ningún mensaje real.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/app/crm_scope.dart';
import 'package:fulltech_crm/data/models/crm_models.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_list_panel.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_options_panel.dart';
import 'package:integration_test/integration_test.dart';

import 'support/native_harness.dart';

/// Busca la fila de una conversación concreta dentro de la bandeja.
Finder _fila(String id) => find.byWidgetPredicate(
      (widget) => widget is ConversationListTile && widget.conversation.id == id,
    );

/// Estado autoritativo de UNA conversación, pedido al servidor.
///
/// Se consulta la bandeja normal y la de «Archivados» porque FINALIZAR también
/// archiva (así sale de la bandeja): si solo se mirara la primera, una
/// conversación finalizada parecería haber desaparecido.
Future<Conversation?> _estado(WidgetTester tester, String id) async {
  final estado = _crm(tester);
  for (final filter in const ['todos', 'archivados']) {
    final data = await estado.repository.conversations(filter: filter);
    for (final row in data['conversations'] as List? ?? const []) {
      final conversation = Conversation.fromJson((row as Map).cast<String, dynamic>());
      if (conversation.id == id) return conversation;
    }
  }
  return null;
}

dynamic _crm(WidgetTester tester) {
  final elemento = tester
      .element(find.byType(MaterialApp))
      .getElementForInheritedWidgetOfExactType<CrmScope>();
  return (elemento?.widget as CrmScope?)!.notifier!;
}

/// Abre el panel de opciones del hilo si no está ya abierto.
Future<void> _abrirPanel(WidgetTester tester) async {
  if (find.byType(ChatOptionsPanel).evaluate().isEmpty) {
    await tester.tap(find.byTooltip('Opciones del chat').first);
    await asentar(tester);
  }
  expect(await esperarAsentando(tester, find.byType(ChatOptionsPanel), segundos: 20), isTrue,
      reason: 'El panel de opciones no se abrió. En pantalla: ${textos(tester)}');
}

/// Pulsa una acción del panel de opciones (asegurando que está a la vista).
Future<void> _accionPanel(WidgetTester tester, String label) async {
  await _abrirPanel(tester);
  final item = find.descendant(of: find.byType(ChatOptionsPanel), matching: find.text(label));
  expect(await esperarAsentando(tester, item, segundos: 20), isTrue,
      reason: 'El panel no ofrece «$label». En pantalla: ${textos(tester)}');
  await tester.ensureVisible(item.first);
  await tester.pump(const Duration(milliseconds: 200));
  await tester.tap(item.first);
  await asentar(tester);
  debugPrint('PANEL «$label» → ${textos(tester)}');
}

/// Pulsa una acción del menú de una fila de la bandeja.
Future<void> _accionFila(WidgetTester tester, String conversationId, String label) async {
  final fila = _fila(conversationId);
  expect(await esperarAsentando(tester, fila, segundos: 20), isTrue,
      reason: 'La fila $conversationId no está en la bandeja. En pantalla: ${textos(tester)}');
  await tester.ensureVisible(fila.first);
  await tester.pump(const Duration(milliseconds: 200));
  final menu = find.descendant(of: fila, matching: find.byTooltip('Acciones del chat'));
  expect(await esperarAsentando(tester, menu, segundos: 20), isTrue);
  await tester.tap(menu.first);
  await asentar(tester);
  expect(await esperarAsentando(tester, find.text(label), segundos: 15), isTrue,
      reason: 'El menú de la fila no ofrece «$label». En pantalla: ${textos(tester)}');
  await tester.tap(find.text(label).first);
  await asentar(tester);
}

/// Aplica un filtro de estado desde el panel de filtros de la bandeja.
Future<void> _filtrar(WidgetTester tester, String etiqueta) async {
  // El panel de filtros se abre con su botón; si ya está abierto, se usa tal cual.
  final panel = find.text('Filtros');
  if (panel.evaluate().isEmpty) {
    await tester.tap(find.byTooltip('Filtros').first);
    await asentar(tester);
  }
  final opcion = find.text(etiqueta);
  expect(await esperarAsentando(tester, opcion, segundos: 20), isTrue,
      reason: 'El panel de filtros no ofrece «$etiqueta». En pantalla: ${textos(tester)}');
  await tester.ensureVisible(opcion.first);
  await tester.pump(const Duration(milliseconds: 200));
  await tester.tap(opcion.first);
  await asentar(tester);
  // El panel ocupa la columna central: se cierra para volver a ver la bandeja.
  if (find.byTooltip('Cerrar filtros').evaluate().isNotEmpty) {
    await tester.tap(find.byTooltip('Cerrar filtros').first);
    await asentar(tester);
  }
}

/// Espera a que el servidor refleje una condición (las acciones de la interfaz
/// se ejecutan en segundo plano: no se da nada por hecho en el primer instante).
Future<Conversation?> _estadoHasta(
  WidgetTester tester,
  String id,
  bool Function(Conversation c) condicion, {
  int segundos = 15,
}) async {
  final limite = DateTime.now().add(Duration(seconds: segundos));
  Conversation? ultima;
  while (DateTime.now().isBefore(limite)) {
    ultima = await _estado(tester, id);
    if (ultima != null && condicion(ultima)) return ultima;
    await tester.pump(const Duration(milliseconds: 250));
    await Future<void>.delayed(const Duration(milliseconds: 200));
  }
  return ultima;
}

/// Escribe en el buscador de la bandeja (limpiando antes, si hace falta).
Future<void> _buscar(WidgetTester tester, String texto) async {
  if (find.byTooltip('Limpiar').evaluate().isNotEmpty) {
    await tester.tap(find.byTooltip('Limpiar').first);
    await asentar(tester);
  }
  // El buscador es el primer campo de texto de la bandeja de escritorio.
  final campo = find.byType(TextField).first;
  await tester.tap(campo);
  await tester.enterText(campo, texto);
  await asentar(tester);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('operaciones de agente: asignar, liberar, finalizar, reabrir, archivar y lote', (tester) async {
    await arrancar(tester);
    await entrarComoAdmin(tester);

    expect(await esperarAsentando(tester, find.text('Buscar o iniciar un chat'), segundos: 40), isTrue,
        reason: 'La bandeja no abrió. En pantalla: ${textos(tester)}');

    // ---- A2/A3/A4: conversación sintética y búsqueda nativa -------------------
    final estado = _crm(tester);
    // Se crea una conversación DESECHABLE (no hay clientes reales en la UAT) para
    // que la prueba sea repetible aunque ejecuciones anteriores la archiven.
    final sello = DateTime.now().millisecondsSinceEpoch;
    final telefono = '1809${sello.toString().substring(sello.toString().length - 7)}';
    final nueva = await estado.repository.startConversation(
      phone: telefono,
      name: 'QA Agente $sello',
    );
    final idNueva = ((nueva['conversation'] as Map?)?['id'] ?? '') as String;
    expect(idNueva, isNotEmpty, reason: 'No se pudo crear la conversación sintética');
    await estado.refresh(quiet: true);
    await asentar(tester);
    debugPrint('OBJETIVO: $idNueva · $telefono');

    await _buscar(tester, telefono.substring(telefono.length - 7));
    expect(await esperarAsentando(tester, _fila(idNueva), segundos: 20), isTrue,
        reason: 'La búsqueda nativa no encontró la conversación. En pantalla: ${textos(tester)}');
    debugPrint('BÚSQUEDA NATIVA OK');

    final objetivo = Conversation.fromJson({
      'id': idNueva,
      'customer_id': '',
      'name': 'QA Agente $sello',
      'phone': telefono,
      'last_body': '',
      'last_direction': '',
      'last_type': '',
      'last_at': '',
      'unread': 0,
      'awaiting_reply': false,
      'resolved': false,
      'stage': '',
      'tags': const <String>[],
      'company_id': 'phytoemagry',
    });

    // ---- A6: abrir la conversación -------------------------------------------
    await tester.ensureVisible(_fila(objetivo.id).first);
    await tester.pump(const Duration(milliseconds: 200));
    await tester.tap(_fila(objetivo.id));
    await asentar(tester);
    expect(await esperarAsentando(tester, find.byTooltip('Opciones del chat'), segundos: 30), isTrue,
        reason: 'No se abrió el hilo. En pantalla: ${textos(tester)}');

    // ---- A7/A8: asignar desde la interfaz y comprobar en el servidor ---------
    await _accionPanel(tester, 'Asignación…');
    expect(await esperarAsentando(tester, find.text('Ponerme al frente'), segundos: 20), isTrue,
        reason: 'La hoja de asignación no ofrece «Ponerme al frente». En pantalla: ${textos(tester)}');
    await tester.tap(find.text('Ponerme al frente'));
    await asentar(tester);

    var servidor = await _estadoHasta(tester, objetivo.id, (c) => c.assignedUserId.isNotEmpty);
    expect(servidor?.assignedUserId, isNotEmpty,
        reason: 'El servidor no registró ninguna asignación tras «Ponerme al frente»');
    debugPrint('ASIGNAR OK: servidor asignado=${servidor?.assignedUserId} (${servidor?.assignedName})');

    // ---- A9/A10: liberar ------------------------------------------------------
    await _accionPanel(tester, 'Asignación…');
    expect(await esperarAsentando(tester, find.text('Liberar conversación'), segundos: 20), isTrue);
    await tester.tap(find.text('Liberar conversación'));
    await asentar(tester);
    servidor = await _estadoHasta(tester, objetivo.id, (c) => c.assignedUserId.isEmpty);
    expect(servidor?.assignedUserId ?? '', isEmpty, reason: 'El servidor sigue con la conversación asignada');
    debugPrint('LIBERAR OK');

    // ---- A11/A12: finalizar ---------------------------------------------------
    await _accionPanel(tester, 'Finalizar conversación');
    servidor = await _estadoHasta(tester, objetivo.id, (c) => c.isResolved);
    expect(servidor?.isResolved, isTrue, reason: 'El servidor no marcó la conversación como finalizada');
    debugPrint('FINALIZAR OK (finalizar también archiva: sale de la bandeja)');
    expect(servidor?.archived, isTrue,
        reason: 'Finalizar debe sacar la conversación de la bandeja y dejarla en «Archivados»');

    // ---- A13/A14: reabrir desde «Archivados» (la fila ya no está en la bandeja) --
    await _filtrar(tester, 'Archivados');
    await _accionFila(tester, objetivo.id, 'Reabrir conversación');
    servidor = await _estadoHasta(tester, objetivo.id, (c) => !c.isResolved && !c.archived);
    expect(servidor?.isResolved, isFalse, reason: 'El servidor no reabrió la conversación');
    expect(servidor?.archived, isFalse, reason: 'Reabrir debe devolver la conversación a la bandeja');
    debugPrint('REABRIR OK');

    // ---- A15: archivar desde el menú de la fila -------------------------------
    await _filtrar(tester, 'Todos');
    await _accionFila(tester, objetivo.id, 'Archivar');
    servidor = await _estadoHasta(tester, objetivo.id, (c) => c.archived);
    expect(servidor?.archived, isTrue, reason: 'El servidor no archivó la conversación');
    debugPrint('ARCHIVAR OK');

    // ---- A5/A15: filtro «Archivados» y desarchivar ---------------------------
    await _filtrar(tester, 'Archivados');
    expect(await esperarAsentando(tester, _fila(objetivo.id), segundos: 20), isTrue,
        reason: 'El filtro «Archivados» no devolvió la conversación archivada. En pantalla: ${textos(tester)}');
    debugPrint('FILTRO ARCHIVADOS OK');

    await _accionFila(tester, objetivo.id, 'Desarchivar');
    servidor = await _estadoHasta(tester, objetivo.id, (c) => !c.archived);
    expect(servidor?.archived, isFalse, reason: 'El servidor no desarchivó la conversación');
    debugPrint('DESARCHIVAR OK');

    // Limpiar el filtro para volver a la bandeja normal.
    if (find.text('Quitar').evaluate().isNotEmpty) {
      await tester.tap(find.text('Quitar').first);
      await asentar(tester);
    }

    // ---- A16: marcar como leído desde el menú de la fila ---------------------
    // Se usa una conversación con mensajes sin leer de la propia UAT.
    Conversation? pendiente;
    for (final c in (await estado.repository.conversations(filter: 'todos'))['conversations']
            ?.cast<Map<String, dynamic>>() ??
        const <Map<String, dynamic>>[]) {
      final fila = Conversation.fromJson(c);
      if (fila.unread > 0 && !fila.archived) {
        pendiente = fila;
        break;
      }
    }
    if (pendiente == null) {
      debugPrint('A16 OMITIDO: no hay conversaciones con mensajes sin leer en este momento');
    } else {
      // La lista solo construye las filas visibles: se busca para traerla arriba.
      final digitosPendiente = pendiente.phone.replaceAll(RegExp(r'\D'), '');
      if (digitosPendiente.length >= 7) {
        await _buscar(tester, digitosPendiente.substring(digitosPendiente.length - 7));
      }
      await _accionFila(tester, pendiente.id, 'Marcar como leído');
      final tras = await _estadoHasta(tester, pendiente.id, (c) => c.unread == 0);
      expect(tras?.unread, 0, reason: 'El servidor sigue contando mensajes sin leer');
      debugPrint('MARCAR LEÍDO OK: sin leer=0 (${pendiente.name})');
    }

    // ---- A17/A18/A19: acción en lote desde la barra de selección -------------
    final candidatas = (await estado.repository.conversations(filter: 'todos'))['conversations'] as List? ??
        const [];
    final ids = candidatas
        .cast<Map<String, dynamic>>()
        .map(Conversation.fromJson)
        .where((c) => !c.archived)
        .take(2)
        .map((c) => c.id)
        .toList();
    expect(ids.length, 2, reason: 'Hacen falta dos conversaciones para el lote');

    // Se quita la búsqueda para ver la bandeja completa y seleccionar dos filas.
    if (find.byTooltip('Limpiar').evaluate().isNotEmpty) {
      await tester.tap(find.byTooltip('Limpiar').first);
      await asentar(tester);
    }

    expect(await esperarAsentando(tester, find.byTooltip('Opciones de la bandeja'), segundos: 20), isTrue);
    await tester.tap(find.byTooltip('Opciones de la bandeja').first);
    await asentar(tester);
    expect(await esperarAsentando(tester, find.text('Seleccionar conversaciones'), segundos: 15), isTrue);
    await tester.tap(find.text('Seleccionar conversaciones').first);
    await asentar(tester);

    for (final id in ids) {
      expect(await esperarAsentando(tester, _fila(id), segundos: 20), isTrue);
      await tester.ensureVisible(_fila(id).first);
      await tester.pump(const Duration(milliseconds: 200));
      await tester.tap(_fila(id));
      await asentar(tester, segundos: 5);
    }
    expect(await esperarAsentando(tester, find.textContaining('2 seleccionad'), segundos: 20), isTrue,
        reason: 'La barra de selección no cuenta dos conversaciones. En pantalla: ${textos(tester)}');
    debugPrint('SELECCIÓN MÚLTIPLE OK');

    final antesLote = <String, int>{};
    for (final id in ids) {
      antesLote[id] = (await _estado(tester, id))?.unread ?? 0;
    }
    await tester.tap(find.text('Leído').first);
    await asentar(tester);
    var afectadas = 0;
    for (final id in ids) {
      final tras = await _estado(tester, id);
      if ((tras?.unread ?? 0) == 0) afectadas += 1;
    }
    expect(afectadas, ids.length,
        reason: 'El lote no dejó a cero los no leídos (antes: $antesLote). Afectadas=$afectadas');
    debugPrint('LOTE OK: $afectadas/${ids.length} conversaciones con sin leer=0');
  });

  testWidgets('un agente no ve la asignación a terceros (permisos reales)', (tester) async {
    await arrancar(tester);
    await entrarComoAdmin(tester);
    expect(await esperarAsentando(tester, find.byType(ConversationListTile), segundos: 40), isTrue);

    // Cambio de sesión: un AGENTE de la UAT.
    final estado = _crm(tester);
    await estado.logout();
    await asentar(tester);
    await entrar(tester, 'agente@uat.local', uatClave);
    expect(await esperarAsentando(tester, find.byType(ConversationListTile), segundos: 40), isTrue,
        reason: 'El agente no llegó a la bandeja. En pantalla: ${textos(tester)}');

    await tester.tap(find.byType(ConversationListTile).first);
    await asentar(tester);
    await tester.tap(find.byTooltip('Opciones del chat').first);
    await asentar(tester);
    expect(await esperarAsentando(tester, find.text('Asignación…'), segundos: 20), isTrue);
    await tester.tap(find.text('Asignación…').first);
    await asentar(tester);
    expect(await esperarAsentando(tester, find.text('Liberar conversación'), segundos: 20), isTrue);
    expect(find.text('Asignar a un compañero…'), findsNothing,
        reason: 'Un AGENTE no debe poder asignar a terceros desde la interfaz');
    debugPrint('PERMISOS OK: el agente no ve «Asignar a un compañero…»');

    await tester.tap(find.text('Liberar conversación'));
    await asentar(tester);
    expect(find.text('Liberar conversación'), findsNothing);
  });
}
