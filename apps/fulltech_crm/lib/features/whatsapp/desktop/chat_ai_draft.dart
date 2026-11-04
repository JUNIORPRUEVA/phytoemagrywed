import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'chat_desktop_theme.dart';

/// Propuesta completa junto al editor. El texto escrito sigue intacto hasta
/// que el operador pulsa «Usar borrador»; esta tarjeta nunca envía mensajes.
class ChatAiDraft extends StatelessWidget {
  const ChatAiDraft({
    super.key,
    required this.text,
    required this.onUse,
    required this.onDiscard,
    this.title = 'Borrador sugerido',
  });

  final String text;
  final String title;
  final VoidCallback onUse;
  final VoidCallback onDiscard;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final maxTextHeight = math.min(140.0, MediaQuery.sizeOf(context).height * 0.17);
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 7, 10, 5),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 9),
      decoration: BoxDecoration(
        color: c.dark ? const Color(0xFF1B2A25) : const Color(0xFFEAF5F1),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: c.accent.withValues(alpha: 0.30)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(Icons.auto_awesome_rounded, size: 15, color: c.accent),
              const SizedBox(width: 7),
              Expanded(
                child: Text(
                  title,
                  style: TextStyle(
                    fontFamily: ChatDesktopMetrics.fontFamily,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: c.textPrimary,
                  ),
                ),
              ),
              Text('Sin enviar', style: TextStyle(fontSize: 11.5, color: c.textSecondary)),
            ],
          ),
          const SizedBox(height: 8),
          ConstrainedBox(
            constraints: BoxConstraints(maxHeight: maxTextHeight),
            child: SingleChildScrollView(
              child: SelectableText(
                text,
                style: TextStyle(
                  fontFamily: ChatDesktopMetrics.fontFamily,
                  fontSize: 12.5,
                  height: 1.4,
                  color: c.textPrimary,
                ),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton(onPressed: onDiscard, child: const Text('Descartar')),
              const SizedBox(width: 6),
              FilledButton(
                onPressed: onUse,
                style: FilledButton.styleFrom(
                  backgroundColor: c.accent,
                  foregroundColor: c.onAccent,
                  visualDensity: VisualDensity.compact,
                  padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 9),
                ),
                child: const Text('Usar borrador'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
