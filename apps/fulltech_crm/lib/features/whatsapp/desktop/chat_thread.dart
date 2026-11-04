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
    this.customerPhone = '',
    this.followRevision = 0,
  });

  final List<ChatMessage> messages;
  final List<String> queued;

  /// Teléfono del cliente del hilo (para compartir su ubicación por la API).
  final String customerPhone;

  /// Cambia cuando el operador envía: vuelve al mensaje más reciente.
  final int followRevision;

  /// Filtro local del encabezado (vacío = todo el historial).
  final String search;

  @override
  State<ChatThread> createState() => _ChatThreadState();
}

class _ChatThreadState extends State<ChatThread> {
  final _controller = ScrollController();
  bool _followLatest = true;
  final Set<String> _seenMessages = {};
  final Set<String> _newMessages = {};

  @override
  void initState() {
    super.initState();
    _controller.addListener(_trackScroll);
    _seenMessages.addAll(widget.messages.map((message) => message.id));
  }

  void _trackScroll() {
    if (!_controller.hasClients) return;
    _followLatest = _controller.offset <= 100;
  }

  @override
  void didUpdateWidget(covariant ChatThread oldWidget) {
    super.didUpdateWidget(oldWidget);
    _newMessages
      ..clear()
      ..addAll(
        widget.messages
            .where((message) => !_seenMessages.contains(message.id))
            .map((message) => message.id),
      );
    _seenMessages.addAll(_newMessages);
    if (oldWidget.followRevision != widget.followRevision) {
      _followLatest = true;
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _showLatest(animated: true),
      );
    } else if ((oldWidget.messages.length != widget.messages.length ||
            oldWidget.queued.length != widget.queued.length) &&
        _followLatest) {
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _showLatest(animated: true),
      );
    }
  }

  void _showLatest({bool animated = false}) {
    if (!mounted || !_controller.hasClients) return;
    if (animated) {
      _controller.animateTo(
        0,
        duration: const Duration(milliseconds: 240),
        curve: Curves.easeOutCubic,
      );
    } else {
      _controller.jumpTo(0);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  List<ChatMessage> get _visible {
    final query = widget.search.trim().toLowerCase();
    if (query.isEmpty) return widget.messages;
    return widget.messages
        .where((m) => m.body.toLowerCase().contains(query))
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    final messages = _visible;
    return ChatDoodleBackground(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final maxBubbleWidth =
              constraints.maxWidth * ChatDesktopMetrics.maxBubbleWidthFactor;
          if (messages.isEmpty && widget.queued.isEmpty) {
            return const _EmptyThread();
          }
          final items = <Widget>[];
          final indices = <Key, int>{};
          void add(Key key, Widget child) {
            indices[key] = items.length;
            items.add(KeyedSubtree(key: key, child: child));
          }

          String? currentDay;
          for (final message in messages) {
            final day = _dayLabel(message.at);
            if (day != currentDay) {
              currentDay = day;
              add(ValueKey('date:$day'), ChatDateDivider(label: day));
            }
            add(
              ValueKey('message:${message.id}'),
              _AnimatedMessage(
                animate: _newMessages.contains(message.id),
                child: MessageBubble(
                  message: message,
                  maxWidth: maxBubbleWidth,
                  phone: widget.customerPhone,
                ),
              ),
            );
          }
          for (var index = 0; index < widget.queued.length; index++) {
            add(
              ValueKey('queued:$index'),
              QueuedMessageBubble(
                body: widget.queued[index],
                maxWidth: maxBubbleWidth,
              ),
            );
          }
          return ListView.builder(
            controller: _controller,
            reverse: true,
            padding: const EdgeInsets.fromLTRB(18, 12, 18, 16),
            itemCount: items.length,
            findChildIndexCallback: (key) {
              final index = indices[key];
              return index == null ? null : items.length - 1 - index;
            },
            itemBuilder: (context, index) => items[items.length - 1 - index],
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

class _AnimatedMessage extends StatelessWidget {
  const _AnimatedMessage({required this.animate, required this.child});

  final bool animate;
  final Widget child;

  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(
    tween: Tween(begin: animate ? 0 : 1, end: 1),
    duration: const Duration(milliseconds: 230),
    curve: Curves.easeOutCubic,
    builder: (context, value, child) => Opacity(
      opacity: value,
      child: Transform.translate(
        offset: Offset(0, (1 - value) * 10),
        child: child,
      ),
    ),
    child: child,
  );
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
          Icon(
            Icons.chat_bubble_outline_rounded,
            size: 36,
            color: c.textSecondary,
          ),
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
