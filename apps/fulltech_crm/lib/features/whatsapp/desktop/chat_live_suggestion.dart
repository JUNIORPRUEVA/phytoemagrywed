import 'package:flutter/material.dart';

import '../../../core/text/local_corrector.dart';

/// Aviso discreto MIENTRAS se escribe: «esto se puede corregir».
///
/// Es la pieza que faltaba para que la app se comporte como la PWA: la revisión
/// local corre sola (con un pequeño retardo) mientras la persona escribe y, si
/// hay algo que arreglar, aparece esta franja con los cambios y un botón para
/// aplicarlos.
///
/// NO reemplaza nada por su cuenta y NO envía nada: la decisión es de la persona.
class ChatLiveSuggestion extends StatelessWidget {
  const ChatLiveSuggestion({
    super.key,
    required this.review,
    required this.onApply,
    required this.onOpen,
    required this.onDismiss,
    this.accent = const Color(0xFF1F7A5C),
    this.background = const Color(0xFFE8F5EF),
    this.foreground = const Color(0xFF0E3A2B),
  });

  final LocalReview review;
  final VoidCallback onApply;
  final VoidCallback onOpen;
  final VoidCallback onDismiss;
  final Color accent;
  final Color background;
  final Color foreground;

  String get _resumen {
    final partes = <String>[];
    for (final edit in review.edits) {
      if (partes.length == 2) break;
      if (edit.kind == 'palabra') {
        partes.add('${edit.before} → ${edit.after}');
      } else {
        partes.add(edit.reason.toLowerCase());
      }
    }
    final resto = review.count - partes.length;
    final detalle = partes.join(' · ');
    return resto > 0 ? '$detalle (+$resto)' : detalle;
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 6, 6, 6),
      color: background,
      child: Row(
        children: [
          Icon(Icons.auto_fix_high_rounded, size: 15, color: accent),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              'Sugerencia: $_resumen',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, color: foreground, fontWeight: FontWeight.w600),
            ),
          ),
          TextButton(
            onPressed: onOpen,
            style: TextButton.styleFrom(
              foregroundColor: accent,
              visualDensity: VisualDensity.compact,
              minimumSize: const Size(0, 28),
              padding: const EdgeInsets.symmetric(horizontal: 8),
            ),
            child: const Text('Ver', style: TextStyle(fontSize: 12)),
          ),
          TextButton(
            onPressed: onApply,
            style: TextButton.styleFrom(
              foregroundColor: accent,
              visualDensity: VisualDensity.compact,
              minimumSize: const Size(0, 28),
              padding: const EdgeInsets.symmetric(horizontal: 8),
            ),
            child: const Text('Corregir', style: TextStyle(fontSize: 12)),
          ),
          IconButton(
            tooltip: 'Ignorar sugerencia',
            iconSize: 15,
            visualDensity: VisualDensity.compact,
            constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
            color: foreground,
            onPressed: onDismiss,
            icon: const Icon(Icons.close_rounded),
          ),
        ],
      ),
    );
  }
}
