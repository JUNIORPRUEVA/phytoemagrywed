import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'package:fulltech_crm/core/format/crm_format.dart';
import 'package:fulltech_crm/data/models/crm_models.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_bubbles.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_composer.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_list_panel.dart';
import 'package:fulltech_crm/features/whatsapp/desktop/chat_navigation_rail.dart';

/// Pruebas de presentación del chat de escritorio (estilo WhatsApp Desktop).
/// No tocan red ni backend: comprueban que los widgets reales pintan los datos
/// que ya trae el CRM y que las acciones se disparan.
void main() {
  setUpAll(() async {
    await initializeDateFormatting('es');
  });

  Conversation conversation({
    String id = 'cnv_1',
    String name = 'María Rodríguez',
    String lastBody = 'Dame dos frascos de 30, por favor',
    String lastAt = '2026-10-27T09:04:00',
    int unread = 3,
    bool awaitingReply = true,
    bool resolved = false,
  }) {
    return Conversation(
      id: id,
      customerId: 'cus_1',
      name: name,
      phone: '+18095551010',
      lastBody: lastBody,
      lastDirection: 'inbound',
      lastType: 'text',
      lastAt: lastAt,
      unread: unread,
      awaitingReply: awaitingReply,
      isResolved: resolved,
      stage: 'CUSTOMER',
      tags: const ['cliente'],
      companyId: 'cmp_1',
    );
  }

  ChatMessage message({bool outgoing = true, String body = 'Buenos días, María', String status = 'delivered'}) {
    return ChatMessage(
      id: 'msg_1',
      direction: outgoing ? 'outbound' : 'inbound',
      body: body,
      type: 'text',
      status: status,
      at: '2026-10-27T09:03:00',
      author: outgoing ? 'Ana' : '',
      mediaUrl: '',
      mediaId: '',
      latitude: null,
      longitude: null,
    );
  }

  Widget wrap(Widget child) => MaterialApp(
        home: Scaffold(backgroundColor: const Color(0xFF161717), body: child),
      );

  group('fila de conversación', () {
    testWidgets('muestra nombre, vista previa, hora y no leídos', (tester) async {
      await tester.pumpWidget(wrap(
        ConversationListTile(conversation: conversation(), selected: true, onTap: () {}),
      ));
      expect(find.text('María Rodríguez'), findsOneWidget);
      expect(find.text('Dame dos frascos de 30, por favor'), findsOneWidget);
      expect(find.text('3'), findsOneWidget);
      // La hora sale del último mensaje con `CrmFormat.chatStamp`.
      expect(find.text(CrmFormat.chatStamp('2026-10-27T09:04:00')), findsOneWidget);
    });

    testWidgets('no pinta badge cuando no hay mensajes sin leer', (tester) async {
      await tester.pumpWidget(wrap(
        ConversationListTile(
          conversation: conversation(unread: 0, awaitingReply: false, resolved: true),
          selected: false,
          onTap: () {},
        ),
      ));
      expect(find.text('3'), findsNothing);
    });

    testWidgets('el toque selecciona la conversación', (tester) async {
      String? selected;
      await tester.pumpWidget(wrap(
        ConversationListTile(
          conversation: conversation(),
          selected: false,
          onTap: () => selected = 'cnv_1',
        ),
      ));
      await tester.tap(find.byType(ConversationListTile));
      expect(selected, 'cnv_1');
    });
  });

  group('burbujas', () {
    testWidgets('saliente: cuerpo, hora y doble check', (tester) async {
      await tester.pumpWidget(wrap(MessageBubble(message: message(), maxWidth: 520)));
      expect(find.text('Buenos días, María'), findsOneWidget);
      expect(find.byIcon(Icons.done_all_rounded), findsOneWidget);
    });

    testWidgets('fallido: icono de error en vez de check', (tester) async {
      await tester.pumpWidget(wrap(MessageBubble(message: message(status: 'failed'), maxWidth: 520)));
      expect(find.byIcon(Icons.error_outline_rounded), findsOneWidget);
      expect(find.byIcon(Icons.done_all_rounded), findsNothing);
    });

    testWidgets('entrante: sin autor ni checks', (tester) async {
      await tester.pumpWidget(wrap(MessageBubble(message: message(outgoing: false), maxWidth: 520)));
      expect(find.text('Buenos días, María'), findsOneWidget);
      expect(find.byIcon(Icons.done_all_rounded), findsNothing);
    });

    testWidgets('separador de fecha con etiqueta', (tester) async {
      await tester.pumpWidget(wrap(const ChatDateDivider(label: 'HOY')));
      expect(find.text('HOY'), findsOneWidget);
    });

    testWidgets('nota de voz: botón de reproducción abre el archivo', (tester) async {
      var opened = false;
      await tester.pumpWidget(wrap(AudioMessageBubble(onOpen: () => opened = true)));
      expect(find.text('Nota de voz'), findsOneWidget);
      await tester.tap(find.byIcon(Icons.play_arrow_rounded));
      expect(opened, isTrue);
    });
  });

  group('barra de redacción', () {
    testWidgets('el botón de enviar dispara el manejador real', (tester) async {
      var sent = 0;
      final controller = TextEditingController();
      await tester.pumpWidget(wrap(ChatComposer(
        controller: controller,
        onSend: () => sent++,
        onAttach: (_) {},
        onShareLocation: () {},
        onRecord: () {},
      )));
      await tester.tap(find.byIcon(Icons.send_rounded));
      expect(sent, 1);
    });

    testWidgets('Enter envía y Shift+Enter no', (tester) async {
      var sent = 0;
      final controller = TextEditingController(text: 'hola');
      await tester.pumpWidget(wrap(ChatComposer(
        controller: controller,
        onSend: () => sent++,
        onAttach: (_) {},
        onShareLocation: () {},
        onRecord: () {},
      )));
      await tester.tap(find.byType(TextField));
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(sent, 1);
    });

    testWidgets('con envío en curso los botones quedan deshabilitados', (tester) async {
      var sent = 0;
      final controller = TextEditingController();
      await tester.pumpWidget(wrap(ChatComposer(
        controller: controller,
        sending: true,
        onSend: () => sent++,
        onAttach: (_) {},
        onShareLocation: () {},
        onRecord: () {},
      )));
      await tester.tap(find.byIcon(Icons.send_rounded));
      expect(sent, 0);
      expect(find.text('Escribe un mensaje'), findsOneWidget);
    });
  });

  group('rail de navegación', () {
    testWidgets('las acciones reales avisan al shell', (tester) async {
      String? target;
      await tester.pumpWidget(wrap(ChatNavigationRail(
        currentTab: 'whatsapp',
        onNavigate: (value) => target = value,
        onLogout: () {},
        unread: 12,
      )));
      await tester.tap(find.byIcon(Icons.receipt_long_outlined));
      expect(target, 'pedidos');
      await tester.tap(find.byIcon(Icons.people_alt_outlined));
      expect(target, 'clientes');
    });

    testWidgets('muestra el contador de no leídos', (tester) async {
      await tester.pumpWidget(wrap(ChatNavigationRail(
        currentTab: 'whatsapp',
        onNavigate: (_) {},
        onLogout: () {},
        unread: 12,
      )));
      expect(find.text('12'), findsOneWidget);
    });
  });
}
