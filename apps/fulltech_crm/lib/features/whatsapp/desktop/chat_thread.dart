import 'package:flutter/material.dart';

import '../../../data/models/crm_models.dart';
import 'chat_bubbles.dart';
import 'chat_desktop_theme.dart';
import 'chat_doodle_background.dart';

/// Hilo de mensajes con el patrón de fondo, separadores de fecha y burbujas.
///
/// Solo presentación: los mensajes y los adjuntos vienen del `CrmState` y del
/// repositorio que ya usaba el CRM.
class ChatThread extends StatefulWidget {
  const ChatThread({
    super.key,
    required this.messages,
    required this.queued,
    this.search = '',
  });

  final List<ChatMessage> messages;
  final List<String> queued;

  /// Filtro local del encabezado (vacío = todo el historial).
  final String search;

  @override
  State<ChatThread> createState() => _ChatThreadState();
}

class _ChatThreadState extends State<ChatThread> {
  final _controller = ScrollController();

  @override
  void didUpdateWidget(covariant ChatThread oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.messages.length != widget.messages.length || oldWidget.queued.length != widget.queued.length) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToBottom());
    }
  }

  void _jumpToBottom() {
    if (!_controller.hasClients) return;
    _controller.jumpTo(_controller.position.maxScrollExtent);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  List<ChatMessage> get _visible {
    final query = widget.search.trim().toLowerCase();
    if (query.isEmpty) return widget.messages;
    return widget.messages.where((m) => m.body.toLowerCase().contains(query)).toList();
  }

  @override
  Widget build(BuildContext context) {
    final messages = _visible;
    return ChatDoodleBackground(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final maxBubbleWidth = constraints.maxWidth * ChatDesktopMetrics.maxBubbleWidthFactor;
          if (messages.isEmpty && widget.queued.isEmpty) {
            return const _EmptyThread();
          }
          final items = <Widget>[];
          String? currentDay;
          for (final message in messages) {
            final day = _dayLabel(message.at);
            if (day != currentDay) {
              currentDay = day;
              items.add(ChatDateDivider(label: day));
            }
            items.add(MessageBubble(message: message, maxWidth: maxBubbleWidth));
          }
          for (final body in widget.queued) {
            items.add(QueuedMessageBubble(body: body, maxWidth: maxBubbleWidth));
          }
          return ListView.builder(
            controller: _controller,
            padding: const EdgeInsets.fromLTRB(18, 12, 18, 16),
            itemCount: items.length,
            itemBuilder: (context, index) => items[index],
          );
        },
      ),
    );
  }

  /// Etiqueta de día como en la referencia: HOY / AYER / dd/MM/yyyy.
  static String _dayLabel(String iso) {
    final raw = DateTime.tryParse(iso)?.toLocal();
    if (raw == null) return '';
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(raw.year, raw.month, raw.day);
    final diff = today.difference(day).inDays;
    if (diff == 0) return 'HOY';
    if (diff == 1) return 'AYER';
    final dd = raw.day.toString().padLeft(2, '0');
    final mm = raw.month.toString().padLeft(2, '0');
    return '$dd/$mm/${raw.year}';
  }
}

class _EmptyThread extends StatelessWidget {
  const _EmptyThread();

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.chat_bubble_outline_rounded, size: 36, color: c.textSecondary),
          const SizedBox(height: 10),
          Text(
            'Esta conversación todavía no tiene mensajes',
            style: t.rowPreview.copyWith(color: c.textSecondary),
          ),
        ],
      ),
    );
  }
}