import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/ai_agent_button.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_filters.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_header.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_list_panel.dart';

void main() {
  testWidgets('servidor sin ruta muestra el icono sin rueda de carga', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(body: AiAgentButton(
        enabled: false,
        unavailable: true,
        tooltip: 'IA no disponible: recarga el servidor y haz clic para reintentar',
      )),
    ));
    expect(find.byType(AiAgentButton), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.byTooltip('IA no disponible: recarga el servidor y haz clic para reintentar'), findsOneWidget);
  });

  for (final size in [const Size(1280, 720), const Size(1366, 768), const Size(1920, 1080)]) {
    testWidgets('ambos iconos son visibles y el chat permite heredar a ${size.width.toInt()}×${size.height.toInt()}', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      final search = TextEditingController();
      addTearDown(search.dispose);
      var globalTaps = 0;
      String? chosenMode;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: Row(
            children: [
              SizedBox(
                width: 272,
                child: ChatListPanel(
                  conversations: const [], selectedId: null, onSelect: (_) {},
                  search: search, onSearchChanged: (_) {},
                  filters: const ChatFilters(), onFiltersChanged: (_) {},
                  onOpenFilters: () {}, onRefresh: () {}, onNewConversation: () {},
                  aiEnabled: true, aiLoaded: true,
                  onToggleAi: () => globalTaps++, aiTooltip: 'IA general',
                ),
              ),
              Expanded(
                child: Align(
                  alignment: Alignment.topCenter,
                  child: ChatHeader(
                    name: 'Pedro Prueba', subtitle: 'Cliente', menu: const [],
                    onOrders: () {}, aiEnabled: false, aiLoaded: true,
                    aiGlobalEnabled: true,
                    aiMode: 'off', onSelectAiMode: (mode) => chosenMode = mode,
                    aiTooltip: 'IA de este chat',
                  ),
                ),
              ),
            ],
          ),
        ),
      ));
      expect(find.byType(AiAgentButton), findsNWidgets(2));
      for (final button in tester.widgetList<AiAgentButton>(find.byType(AiAgentButton))) {
        final rect = tester.getRect(find.byWidget(button));
        expect(rect.left, greaterThanOrEqualTo(0));
        expect(rect.right, lessThanOrEqualTo(size.width));
      }
      expect(tester.takeException(), isNull);
      await tester.tap(find.byType(AiAgentButton).first);
      await tester.pumpAndSettle();
      await tester.tap(find.byType(Switch));
      expect(globalTaps, 1);
      await tester.tap(find.byType(AiAgentButton).first);
      await tester.pumpAndSettle();
      await tester.tap(find.byType(AiAgentButton).last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Usar ajuste general'));
      await tester.pumpAndSettle();
      expect(chosenMode, 'inherit');
    });
  }
}
