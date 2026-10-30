// Aceptación nativa (Windows, UAT aislada) del módulo de WhatsApp del CRM.
//
// Cubre lo que se puede ejercitar sin enviar nada real:
//   · la bandeja pinta conversaciones de la UAT,
//   · se abre una conversación y queda su hilo,
//   · el panel de opciones ofrece el asistente IA contextual,
//   · la consulta al asistente responde o dice que la IA no está configurada
//     (nunca se queda colgada y nunca envía nada),
//   · el diálogo se cierra sin tocar la conversación.
//
// La UAT tiene el transporte de WhatsApp en MOCK: aquí no sale ningún mensaje.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_list_panel.dart';
import 'package:integration_test/integration_test.dart';

import 'support/native_harness.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('bandeja, hilo y asistente IA contextual del chat', (tester) async {
    await arrancar(tester);
    await entrarComoAdmin(tester);

    // La app abre en WhatsApp: la bandeja debe traer conversaciones.
    expect(await esperarAsentando(tester, find.text('Buscar o iniciar un chat'), segundos: 40), isTrue,
        reason: 'La bandeja de WhatsApp no abrió. En pantalla: ${textos(tester)}');

    final filas = find.byType(ConversationListTile);
    expect(await esperarAsentando(tester, filas, segundos: 30), isTrue,
        reason: 'La bandeja no trajo conversaciones. En pantalla: ${textos(tester)}');
    debugPrint('BANDEJA OK: ${filas.evaluate().length} conversaciones');

    // Abrir la primera conversación.
    await tester.tap(filas.first);
    await asentar(tester);
    expect(await esperarAsentando(tester, find.byTooltip('Opciones del chat'), segundos: 30), isTrue,
        reason: 'No se abrió el hilo del chat. En pantalla: ${textos(tester)}');
    debugPrint('HILO ABIERTO OK');

    // Panel de opciones → asistente contextual.
    await tester.tap(find.byTooltip('Opciones del chat').first);
    await asentar(tester);
    final entrada = find.text('Asistente contextual');
    expect(await esperarAsentando(tester, entrada, segundos: 20), isTrue,
        reason: 'El panel de opciones no ofrece el asistente contextual. En pantalla: ${textos(tester)}');
    await tester.tap(entrada.first);
    await asentar(tester);

    expect(await esperarAsentando(tester, find.text('Consultar'), segundos: 20), isTrue,
        reason: 'No se abrió el asistente. En pantalla: ${textos(tester)}');
    // El diálogo deja claro que no envía nada.
    expect(find.textContaining('Solo lectura'), findsWidgets);

    // Consultar: o responde, o dice que la IA no está configurada. Ambas cosas
    // son un resultado válido y comprobable; lo que NO vale es quedarse colgado.
    await tester.tap(find.text('Consultar'));
    await asentar(tester, segundos: 30);
    final respondio = find.textContaining('La IA no está configurada').evaluate().isNotEmpty ||
        find.textContaining('Borrador (no enviado)').evaluate().isNotEmpty ||
        find.textContaining('No se pudo consultar').evaluate().isNotEmpty;
    expect(respondio, isTrue,
        reason: 'La consulta al asistente no dio resultado visible. En pantalla: ${textos(tester)}');
    debugPrint('ASISTENTE OK: ${find.textContaining('Borrador (no enviado)').evaluate().isNotEmpty ? 'devolvió borrador' : 'sin IA configurada o error explícito'}');

    // Cerrar sin tocar la conversación.
    await tester.tap(find.text('Cerrar').first);
    await asentar(tester);
    expect(find.textContaining('Solo lectura'), findsNothing);
    expect(find.byTooltip('Opciones del chat'), findsWidgets);
    debugPrint('CIERRE OK');
  });
}
