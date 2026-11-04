import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'chat_desktop_theme.dart';

const chatEmojis = ['😀', '😊', '😂', '🥰', '😍', '👍', '🙏', '👏', '🎉', '❤️', '✅', '📍', '👋', '🤔', '😢', '🔥'];

void insertChatEmoji(TextEditingController controller, String emoji) {
  final value = controller.value;
  final start = value.selection.isValid ? value.selection.start : value.text.length;
  final end = value.selection.isValid ? value.selection.end : value.text.length;
  final updated = value.text.replaceRange(start, end, emoji);
  controller.value = TextEditingValue(
    text: updated,
    selection: TextSelection.collapsed(offset: start + emoji.length),
  );
}

/// Barra de redacción fija: adjuntar, texto, dictado y enviar.
///
/// Todas las acciones llaman a los manejadores reales del `ChatScreen`; no hay
/// botones decorativos. `Enter` envía y `Shift+Enter` hace salto de línea.
class ChatComposer extends StatelessWidget {
  const ChatComposer({
    super.key,
    required this.controller,
    required this.onSend,
    required this.onAttach,
    required this.onShareLocation,
    required this.onRecord,
    this.onSendKey,
    this.onQuickActions,
    this.onProofread,
    this.onReplySuggestion,
    this.onMoreAiTools,
    this.aiBusy = false,
    this.sending = false,
    this.uploadLabel,
  });

  final TextEditingController controller;
  final VoidCallback onSend;

  /// Lo que hace la tecla Enter. Si no se indica, envía como el botón.
  ///
  /// Se separa a propósito: el botón envía ya; Enter puede pedir una segunda
  /// pulsación cuando hay una corrección ortográfica pendiente.
  final VoidCallback? onSendKey;
  final ValueChanged<String> onAttach;
  final VoidCallback onShareLocation;
  final VoidCallback onRecord;

  /// Abre la columna de acciones rápidas (respuestas y datos para compartir).
  final VoidCallback? onQuickActions;
  final VoidCallback? onProofread;
  final VoidCallback? onReplySuggestion;
  final VoidCallback? onMoreAiTools;
  final bool aiBusy;
  final bool sending;
  final String? uploadLabel;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 6, 10, 8),
      decoration: BoxDecoration(
        color: c.panelBg,
        border: Border(top: BorderSide(color: c.divider)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (uploadLabel != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Row(
                children: [
                  SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(strokeWidth: 2, color: c.accent),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    uploadLabel!,
                    style: t.bubbleMeta.copyWith(color: c.textPrimary),
                  ),
                ],
              ),
            ),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              _ComposerIcon(
                icon: Icons.add_rounded,
                tooltip: 'Adjuntar',
                onTap: sending ? null : () => _openAttachMenu(context),
              ),
              const SizedBox(width: 6),
              /*
               * ACCIONES RÁPIDAS: respuestas de siempre y datos para compartir,
               * a un toque desde donde se escribe (no hay que salir del chat).
               */
              if (onQuickActions != null) ...[
                _ComposerIcon(
                  icon: Icons.touch_app_rounded,
                  tooltip: 'Acciones rápidas',
                  onTap: sending ? null : onQuickActions,
                ),
                const SizedBox(width: 6),
              ],
              if (onProofread != null || onReplySuggestion != null || onMoreAiTools != null) ...[
                PopupMenuButton<String>(
                  tooltip: 'Herramientas de redacción',
                  enabled: !sending && !aiBusy,
                  padding: EdgeInsets.zero,
                  color: c.fieldBg,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                  onSelected: (action) {
                    if (action == 'correct') onProofread?.call();
                    if (action == 'suggest') onReplySuggestion?.call();
                    if (action == 'more') onMoreAiTools?.call();
                  },
                  itemBuilder: (_) => [
                    if (onProofread != null)
                      const PopupMenuItem(
                        value: 'correct',
                        child: _AttachLabel(icon: Icons.spellcheck_rounded, label: 'Corregir texto'),
                      ),
                    if (onReplySuggestion != null)
                      const PopupMenuItem(
                        value: 'suggest',
                        child: _AttachLabel(icon: Icons.auto_awesome_rounded, label: 'Sugerir respuesta'),
                      ),
                    if (onMoreAiTools != null)
                      const PopupMenuItem(
                        value: 'more',
                        child: _AttachLabel(icon: Icons.tune_rounded, label: 'Más herramientas IA'),
                      ),
                  ],
                  child: SizedBox(
                    width: 36,
                    height: 36,
                    child: Center(child: Icon(Icons.auto_awesome_rounded, size: 19, color: c.accent)),
                  ),
                ),
                const SizedBox(width: 4),
              ],
              PopupMenuButton<String>(
                tooltip: 'Insertar emoji',
                enabled: !sending,
                padding: EdgeInsets.zero,
                color: c.fieldBg,
                onSelected: (emoji) => insertChatEmoji(controller, emoji),
                itemBuilder: (_) => chatEmojis.map((emoji) => PopupMenuItem(
                  value: emoji,
                  height: 36,
                  child: Text(emoji, style: const TextStyle(fontSize: 20)),
                )).toList(),
                child: SizedBox(width: 34, height: 36, child: Icon(Icons.emoji_emotions_outlined, size: 19, color: c.textSecondary)),
              ),
              Expanded(
                child: Container(
                  constraints: const BoxConstraints(minHeight: 36),
                  decoration: BoxDecoration(
                    color: c.composerBg,
                    borderRadius: BorderRadius.circular(22),
                  ),
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  alignment: Alignment.center,
                  child: CallbackShortcuts(
                    bindings: {
                      const SingleActivator(LogicalKeyboardKey.enter): () {
                        if (!sending) (onSendKey ?? onSend)();
                      },
                    },
                    child: TextField(
                      controller: controller,
                      minLines: 1,
                      maxLines: 5,
                      // El operador puede preparar el siguiente mensaje mientras
                      // se confirma el envío; deshabilitarlo perdía el foco.
                      enabled: true,
                      textCapitalization: TextCapitalization.sentences,
                      cursorColor: c.accent,
                      style: TextStyle(
                        fontFamily: ChatDesktopMetrics.fontFamily,
                        fontSize: 12.8,
                        color: c.textPrimary,
                        height: 1.28,
                      ),
                      decoration: InputDecoration(
                        isDense: true,
                        border: InputBorder.none,
                        hintText: 'Escribe un mensaje',
                        hintStyle: TextStyle(
                          fontFamily: ChatDesktopMetrics.fontFamily,
                          fontSize: 12.8,
                          color: c.textSecondary,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              _ComposerIcon(
                icon: Icons.mic_rounded,
                tooltip: 'Grabar nota de voz',
                onTap: sending ? null : onRecord,
              ),
              _ComposerIcon(
                icon: Icons.send_rounded,
                tooltip: 'Enviar',
                highlighted: true,
                onTap: sending ? null : onSend,
              ),
            ],
          ),
        ],
      ),
    );
  }

  void _openAttachMenu(BuildContext context) {
    final c = ChatPalette.of(context);
    final box = context.findRenderObject() as RenderBox?;
    final origin = box == null ? Offset.zero : box.localToGlobal(Offset(16, box.size.height - 180));
    showMenu<String>(
      context: context,
      color: c.fieldBg,
      position: RelativeRect.fromLTRB(origin.dx, origin.dy, origin.dx, origin.dy),
      items: const [
        PopupMenuItem(value: 'image', child: _AttachLabel(icon: Icons.image_outlined, label: 'Foto')),
        PopupMenuItem(value: 'document', child: _AttachLabel(icon: Icons.picture_as_pdf_outlined, label: 'Documento PDF')),
        PopupMenuItem(value: 'audio', child: _AttachLabel(icon: Icons.mic_none_rounded, label: 'Nota de voz (archivo)')),
        PopupMenuItem(value: 'video', child: _AttachLabel(icon: Icons.videocam_outlined, label: 'Video MP4')),
        PopupMenuItem(value: 'location', child: _AttachLabel(icon: Icons.place_outlined, label: 'Ubicación o datos de pago')),
      ],
    ).then((value) {
      if (value == null) return;
      if (value == 'location') {
        onShareLocation();
      } else {
        onAttach(value);
      }
    });
  }
}

class _AttachLabel extends StatelessWidget {
  const _AttachLabel({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Row(
      children: [
        Icon(icon, size: 18, color: c.textSecondary),
        const SizedBox(width: 10),
        Text(label, style: TextStyle(color: c.textPrimary, fontSize: 13)),
      ],
    );
  }
}

class _ComposerIcon extends StatefulWidget {
  const _ComposerIcon({
    required this.icon,
    required this.tooltip,
    required this.onTap,
    this.highlighted = false,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;
  final bool highlighted;

  @override
  State<_ComposerIcon> createState() => _ComposerIconState();
}

class _ComposerIconState extends State<_ComposerIcon> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final enabled = widget.onTap != null;
    final base = widget.highlighted ? c.accent : c.textSecondary;
    final color = enabled ? base : base.withValues(alpha: 0.4);
    return Tooltip(
      message: widget.tooltip,
      waitDuration: const Duration(milliseconds: 400),
      child: MouseRegion(
        cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: InkWell(
          onTap: widget.onTap,
          customBorder: const CircleBorder(),
          child: Container(
            width: 36,
            height: 36,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: _hovered && enabled ? c.rowHover : Colors.transparent,
            ),
            child: Icon(widget.icon, size: 20, color: color),
          ),
        ),
      ),
    );
  }
}
