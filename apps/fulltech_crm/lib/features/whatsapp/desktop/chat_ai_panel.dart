import 'package:flutter/material.dart';

import 'chat_desktop_theme.dart';

/// Herramientas ampliadas del asistente, en un panel flotante sobre el hilo.
///
/// Va aparte del menú de acciones a propósito: aquí solo se pide ayuda al
/// modelo (corregir, sugerir, resumir, analizar) y las acciones comerciales
/// viven en su propio menú. Nada de lo que se pide aquí se envía al cliente.
class ChatAiPanel extends StatelessWidget {
  const ChatAiPanel({
    super.key,
    required this.width,
    required this.onClose,
    required this.onProofread,
    required this.onReplySuggestion,
    required this.onAssistant,
    required this.onSummary,
    required this.onUseSuggestion,
    required this.onDiscardSuggestion,
    this.busy = false,
    this.suggestion = '',
    this.error = '',
    this.summary = '',
  });

  final double width;
  final VoidCallback onClose;
  final VoidCallback onProofread;
  final VoidCallback onReplySuggestion;
  final VoidCallback onAssistant;
  final VoidCallback onSummary;
  final VoidCallback onUseSuggestion;
  final VoidCallback onDiscardSuggestion;
  final bool busy;
  final String suggestion;
  final String error;
  final String summary;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Material(
      color: c.panelBg,
      child: Container(
        width: width,
        decoration: BoxDecoration(
          border: Border(left: BorderSide(color: c.divider)),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: c.dark ? 0.45 : 0.10),
              blurRadius: 26,
              offset: const Offset(-8, 0),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 8, 10),
              child: Row(
                children: [
                  Container(
                    width: 30,
                    height: 30,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: c.accent.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(9),
                    ),
                    child: Icon(Icons.auto_awesome_rounded, size: 17, color: c.accent),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          'Asistente IA',
                          style: TextStyle(
                            fontFamily: ChatDesktopMetrics.fontFamily,
                            fontSize: 15,
                            fontWeight: FontWeight.w700,
                            color: c.textPrimary,
                          ),
                        ),
                        Text(
                          'Ayuda para responder; nunca envía solo',
                          style: TextStyle(
                            fontFamily: ChatDesktopMetrics.fontFamily,
                            fontSize: 11,
                            color: c.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: 'Cerrar',
                    visualDensity: VisualDensity.compact,
                    iconSize: 18,
                    color: c.textSecondary,
                    onPressed: onClose,
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: c.divider),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(14, 14, 14, 20),
                children: [
                  _AiCard(
                    icon: Icons.spellcheck_rounded,
                    title: 'Corregir el mensaje',
                    detail: 'Ortografía, tildes y puntuación de lo que estás escribiendo.',
                    onTap: busy ? null : onProofread,
                  ),
                  _AiCard(
                    icon: Icons.forum_outlined,
                    title: 'Sugerir respuesta',
                    detail: 'Propone qué contestar según la última conversación.',
                    onTap: busy ? null : onReplySuggestion,
                  ),
                  _AiCard(
                    icon: Icons.summarize_outlined,
                    title: 'Resumen del cliente',
                    detail: 'Quién es, qué compró y por dónde va el trato.',
                    onTap: busy ? null : onSummary,
                  ),
                  _AiCard(
                    icon: Icons.psychology_alt_outlined,
                    title: 'Asistente contextual',
                    detail: 'Analiza el chat y el expediente y propone el siguiente paso.',
                    onTap: busy ? null : onAssistant,
                  ),
                  if (busy)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      child: Row(
                        children: [
                          SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 2, color: c.accent),
                          ),
                          const SizedBox(width: 9),
                          Text(
                            'Pensando…',
                            style: TextStyle(
                              fontFamily: ChatDesktopMetrics.fontFamily,
                              fontSize: 12,
                              color: c.textSecondary,
                            ),
                          ),
                        ],
                      ),
                    ),
                  if (error.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        error,
                        style: TextStyle(
                          fontFamily: ChatDesktopMetrics.fontFamily,
                          fontSize: 12,
                          height: 1.35,
                          color: c.danger,
                        ),
                      ),
                    ),
                  if (summary.isNotEmpty) _Block(title: 'Resumen del cliente', body: summary),
                  if (suggestion.isNotEmpty)
                    _Block(
                      title: 'Respuesta propuesta',
                      body: suggestion,
                      actions: Row(
                        children: [
                          TextButton(
                            onPressed: onUseSuggestion,
                            style: TextButton.styleFrom(foregroundColor: c.accent),
                            child: const Text('Usar borrador'),
                          ),
                          TextButton(
                            onPressed: onDiscardSuggestion,
                            style: TextButton.styleFrom(foregroundColor: c.textSecondary),
                            child: const Text('Descartar'),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AiCard extends StatelessWidget {
  const _AiCard({required this.icon, required this.title, required this.detail, required this.onTap});

  final IconData icon;
  final String title;
  final String detail;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Material(
        color: c.fieldBg,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 11, 12, 11),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(icon, size: 18, color: onTap == null ? c.textSecondary : c.accent),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        style: TextStyle(
                          fontFamily: ChatDesktopMetrics.fontFamily,
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: c.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        detail,
                        style: TextStyle(
                          fontFamily: ChatDesktopMetrics.fontFamily,
                          fontSize: 11.5,
                          height: 1.3,
                          color: c.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Block extends StatelessWidget {
  const _Block({required this.title, required this.body, this.actions});

  final String title;
  final String body;
  final Widget? actions;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: c.dark ? const Color(0xFF1B2A25) : const Color(0xFFEAF7F1),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: c.accent.withValues(alpha: 0.28)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title.toUpperCase(),
            style: TextStyle(
              fontFamily: ChatDesktopMetrics.fontFamily,
              fontSize: 10,
              letterSpacing: 0.7,
              fontWeight: FontWeight.w800,
              color: c.accent,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            body,
            style: TextStyle(
              fontFamily: ChatDesktopMetrics.fontFamily,
              fontSize: 12.4,
              height: 1.4,
              color: c.textPrimary,
            ),
          ),
          if (actions != null) ?actions,
        ],
      ),
    );
  }
}
