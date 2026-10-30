// Aceptación nativa (Windows, UAT aislada) de dos flujos que faltaban:
//
//   1. MENSAJE DE PEDIDO CON IA desde Facturación: resuelve el chat del cliente,
//      pide el borrador al servidor y lo muestra — sin enviarlo y sin tocar el
//      pedido ni el stock.
//   2. ENVÍO DE TEXTO desde el compositor del chat por el transporte MOCK, con
//      una sola clave de operación (doble toque no duplica).
//
// La UAT tiene WhatsApp en MOCK: aquí no sale ningún mensaje real.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/app/crm_scope.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_bubbles.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_list_panel.dart';
import 'package:integration_test/integration_test.dart';

import 'support/native_harness.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('mensaje de pedido con IA: borrador sin enviar y sin tocar el pedido', (tester) async {
    await arrancar(tester);
    await entrarComoAdmin(tester);

    await irA(tester, 'Facturación');
    await asentar(tester);
    expect(await esperarAsentando(tester, find.text('Agregar cliente')), isTrue,
        reason: 'El POS no abrió. En pantalla: ${textos(tester)}');

    // Cliente sintético que YA tiene conversación en la UAT (creada por el
    // webhook sintético). Se busca por nombre para no depender del orden.
    await tester.tap(find.text('Agregar cliente').first);
    await asentar(tester);
    final buscador =
        find.descendant(of: find.byType(AlertDialog), matching: find.byType(TextField)).first;
    await tester.enterText(buscador, 'Cliente Sint');
    await asentar(tester);
    final fila = find.descendant(
      of: find.byType(ListTile),
      matching: find.textContaining('Cliente Sint'),
    );
    expect(await esperarAsentando(tester, fila, segundos: 25), isTrue,
        reason: 'No hay cliente sintético con chat en la UAT. En pantalla: ${textos(tester)}');
    await tester.tap(fila.first);
    await asentar(tester);
    debugPrint('CLIENTE ELEGIDO OK');

    // Acción de IA del carrito.
    final boton = find.byTooltip('Pedir datos al cliente con IA');
    expect(await esperarAsentando(tester, boton, segundos: 20), isTrue,
        reason: 'El carrito no ofrece «pedir datos con IA». En pantalla: ${textos(tester)}');
    await tester.tap(boton.first);
    await asentar(tester, segundos: 20);

    expect(await esperarAsentando(tester, find.textContaining('Pedir datos a'), segundos: 30), isTrue,
        reason: 'No se abrió el diálogo del mensaje. En pantalla: ${textos(tester)}');

    // El servidor devuelve un texto base incluso sin IA configurada; si no hay
    // texto, tiene que haber un aviso explícito. Nunca un diálogo mudo.
    final conTexto = find.text('Enviar al cliente');
    final aviso = find.textContaining('La IA no devolvió ningún texto');
    final sinChat = find.textContaining('no tiene ningún chat abierto');
    var listo = false;
    for (var intento = 0; intento < 40 && !listo; intento++) {
      listo = conTexto.evaluate().isNotEmpty ||
          aviso.evaluate().isNotEmpty ||
          sinChat.evaluate().isNotEmpty;
      if (!listo) await asentar(tester, segundos: 2);
    }
    expect(listo, isTrue,
        reason: 'El diálogo no dio ni borrador ni aviso. En pantalla: ${textos(tester)}');
    debugPrint(
      'MENSAJE PEDIDO OK: ${conTexto.evaluate().isNotEmpty ? 'borrador listo' : aviso.evaluate().isNotEmpty ? 'sin texto de IA' : 'cliente sin chat'}',
    );

    // Nada se ha enviado solo: el acuse solo aparece tras confirmar.
    expect(find.text('Mensaje registrado en el chat.'), findsNothing);
    // La IA solo redacta: se dice en el propio diálogo.
    expect(find.textContaining('La IA solo redacta'), findsWidgets);
    // El carrito sigue vacío: redactar no crea líneas ni cambia el total.
    expect(find.text('Crear pedido'), findsWidgets);

    await tester.tap(find.text('Cerrar'));
    await asentar(tester);
    expect(find.textContaining('Pedir datos a'), findsNothing);
    debugPrint('CIERRE OK: sin envío');
  });

  testWidgets('envío de texto desde el compositor del chat (transporte MOCK)', (tester) async {
    await arrancar(tester);
    await entrarComoAdmin(tester);

    // La app abre en WhatsApp: primera conversación sintética.
    final filas = find.byType(ConversationListTile);
    expect(await esperarAsentando(tester, filas, segundos: 40), isTrue,
        reason: 'La bandeja no trajo conversaciones. En pantalla: ${textos(tester)}');
    // El id real de la conversación sale del propio widget: así el estado se
    // consulta en el SERVIDOR, no solo en pantalla.
    final conversacionId = tester.widget<ConversationListTile>(filas.first).conversation.id;
    final repo = CrmScope.of(tester.element(find.byType(MaterialApp)), listen: false).repository;
    final antes = (await repo.messages(conversacionId)).length;
    debugPrint('SERVIDOR ANTES: $antes mensajes en $conversacionId');
    await tester.tap(filas.first);
    await asentar(tester);

    // El compositor se localiza por su marcador, no por orden de widgets.
    final campo = find.ancestor(
      of: find.text('Escribe un mensaje'),
      matching: find.byType(TextField),
    );
    expect(await esperarAsentando(tester, campo, segundos: 30), isTrue,
        reason: 'No hay compositor. En pantalla: ${textos(tester)}');

    final sello = DateTime.now().millisecondsSinceEpoch;
    final texto = 'Prueba nativa $sello';
    await tester.enterText(campo.first, texto);
    await asentar(tester);

    // Doble toque rápido: la clave de operación es la misma, así que el
    // servidor no puede crear dos mensajes.
    expect(await esperarAsentando(tester, find.byTooltip('Enviar'), segundos: 20), isTrue);
    await tester.tap(find.byTooltip('Enviar').first);
    await tester.pump(const Duration(milliseconds: 120));
    if (find.byTooltip('Enviar').evaluate().isNotEmpty) {
      await tester.tap(find.byTooltip('Enviar').first);
    }
    await asentar(tester, segundos: 30);

    expect(await esperarAsentando(tester, find.textContaining(texto), segundos: 30), isTrue,
        reason: 'El mensaje no aparece en el hilo. En pantalla: ${textos(tester)}');
    // Se cuentan burbujas del hilo como señal visual (el compositor puede
    // conservar el texto, así que la prueba de verdad es el servidor).
    final burbujas = find.ancestor(
      of: find.textContaining(texto),
      matching: find.byType(MessageBubble),
    );
    final enviados = burbujas.evaluate().length;
    debugPrint('BURBUJAS EN PANTALLA: $enviados');

    // Verificación AUTORITATIVA: el servidor tiene que haber guardado UNO solo.
    final despues = await repo.messages(conversacionId);
    final guardados = despues.where((m) => m.body == texto).toList();
    expect(despues.length - antes, 1,
        reason: 'El servidor guardó ${despues.length - antes} mensajes nuevos, debe ser 1');
    expect(guardados.length, 1, reason: 'El servidor tiene ${guardados.length} copias del texto');
    expect(guardados.single.direction, 'outbound');
    expect(guardados.single.outgoing, isTrue);
    debugPrint('SERVIDOR DESPUÉS: ${despues.length} mensajes (+${despues.length - antes}), id=${guardados.single.id}');

    // La MISMA clave de operación repetida no crea otro mensaje: se cuentan las
    // copias antes y después, así la aserción es exacta y no ambigua.
    final clave = 'uat_native_retry_$sello';
    final copiasAntes = (await repo.messages(conversacionId)).where((m) => m.body == texto).length;
    await repo.sendMessage(conversacionId, texto, operationKey: clave);
    await repo.sendMessage(conversacionId, texto, operationKey: clave);
    final copiasDespues = (await repo.messages(conversacionId)).where((m) => m.body == texto).length;
    expect(copiasDespues - copiasAntes, 1,
        reason: 'Dos envíos con la MISMA clave deben añadir UNA copia; añadieron ${copiasDespues - copiasAntes}');
    debugPrint('REINTENTO IDEMPOTENTE OK: $copiasAntes → $copiasDespues copias con dos envíos de la misma clave');
    debugPrint('ENVIO TEXTO OK: "$texto" en $enviados burbuja(s)');
  });
}
