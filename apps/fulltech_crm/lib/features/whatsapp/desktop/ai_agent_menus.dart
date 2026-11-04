import 'package:flutter/material.dart';

import '../../../data/models/crm_models.dart';
import 'ai_agent_button.dart';
import 'chat_desktop_theme.dart';

/// Los dos menús se anclan al mismo icono y flotan sobre el chat.
/// Ninguno cambia la disposición del hilo ni del editor.
class AiGlobalMenu extends StatefulWidget {
  const AiGlobalMenu({
    super.key,
    required this.enabled,
    required this.loaded,
    required this.busy,
    required this.unavailable,
    required this.tooltip,
    this.onToggle,
    this.onRetry,
  });

  final bool enabled;
  final bool loaded;
  final bool busy;
  final bool unavailable;
  final String tooltip;
  final VoidCallback? onToggle;
  final VoidCallback? onRetry;

  @override
  State<AiGlobalMenu> createState() => _AiGlobalMenuState();
}

class _AiGlobalMenuState extends State<AiGlobalMenu> {
  final MenuController _menuController = MenuController();

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return MenuAnchor(
      controller: _menuController,
      alignmentOffset: const Offset(-276, 6),
      style: _menuStyle(c),
      menuChildren: [
        SizedBox(
          width: 304,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                _MenuTitle(title: 'Asistente IA', onClose: _menuController.close),
                const SizedBox(height: 13),
                _StatusLine(
                  active: widget.enabled && widget.loaded,
                  label: widget.unavailable
                      ? 'No disponible en este servidor'
                      : !widget.loaded
                          ? 'Consultando estado'
                          : widget.enabled ? 'Preferencia activa' : 'Preferencia desactivada',
                ),
                const SizedBox(height: 13),
                Container(
                  padding: const EdgeInsets.fromLTRB(12, 9, 8, 9),
                  decoration: _softBox(c),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text('Asistencia general', style: _text(c, 13, FontWeight.w700)),
                      ),
                      Switch.adaptive(
                        value: widget.enabled && widget.loaded,
                        activeTrackColor: c.accent,
                        onChanged: widget.loaded && !widget.busy && widget.onToggle != null
                            ? (_) => widget.onToggle!() : null,
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 10),
                Text(
                  'Se aplica a los chats que usan el ajuste general',
                  style: _text(c, 12, FontWeight.w400, secondary: true),
                ),
                const SizedBox(height: 7),
                Text(
                  'Respuestas automáticas: disponible en una próxima etapa. Envío manual por ahora.',
                  style: _text(c, 11.5, FontWeight.w400, secondary: true),
                ),
                if (widget.unavailable && widget.onRetry != null) ...[
                  const SizedBox(height: 10),
                  TextButton.icon(
                    onPressed: widget.onRetry,
                    icon: const Icon(Icons.refresh_rounded, size: 16),
                    label: const Text('Reintentar'),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
      builder: (context, controller, child) => AiAgentButton(
        enabled: widget.enabled && widget.loaded,
        busy: widget.busy,
        unavailable: widget.unavailable,
        tooltip: widget.tooltip,
        onPressed: () => controller.isOpen ? controller.close() : controller.open(),
      ),
    );
  }
}

class AiConversationMenu extends StatefulWidget {
  const AiConversationMenu({
    super.key,
    required this.conversationName,
    required this.enabled,
    required this.loaded,
    required this.busy,
    required this.unavailable,
    required this.mode,
    required this.globalEnabled,
    required this.tooltip,
    this.conversation,
    this.onSelectMode,
    this.onRetry,
    this.onOpenAssistant,
    this.memoryFacts = const [],
  });

  final String conversationName;
  final Conversation? conversation;
  final bool enabled;
  final bool loaded;
  final bool busy;
  final bool unavailable;
  final String mode;
  final bool globalEnabled;
  final String tooltip;
  final ValueChanged<String>? onSelectMode;
  final VoidCallback? onRetry;
  final VoidCallback? onOpenAssistant;
  final List<AiMemoryFact> memoryFacts;

  @override
  State<AiConversationMenu> createState() => _AiConversationMenuState();
}

class _AiConversationMenuState extends State<AiConversationMenu> {
  final MenuController _menuController = MenuController();
  bool _contextOpen = false;
  bool _memoryOpen = false;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final maxHeight = MediaQuery.sizeOf(context).height * 0.72;
    return MenuAnchor(
      controller: _menuController,
      alignmentOffset: const Offset(-300, 6),
      style: _menuStyle(c),
      menuChildren: [
        SizedBox(
          width: 354,
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: maxHeight),
            child: SingleChildScrollView(
              primary: false,
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  _MenuTitle(title: 'Asistente IA', onClose: _menuController.close),
                  const SizedBox(height: 3),
                  Text(
                    widget.conversationName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: _text(c, 12.5, FontWeight.w600, secondary: true),
                  ),
                  const SizedBox(height: 13),
                  _StatusLine(
                    active: widget.enabled && widget.loaded,
                    label: widget.unavailable
                        ? 'Ajuste no disponible en este servidor'
                        : !widget.loaded
                            ? 'Consultando estado'
                            : widget.enabled
                                ? 'Asistencia activa en este chat · Envío manual'
                                : 'Asistencia desactivada · Envío manual',
                  ),
                  const SizedBox(height: 15),
                  Text('PREFERENCIA DE ESTE CHAT', style: _eyebrow(c)),
                  const SizedBox(height: 7),
                  _ModeRow(
                    label: 'Usar ajuste general',
                    detail: widget.globalEnabled ? 'General activo' : 'General desactivado',
                    selected: widget.mode == 'inherit',
                    enabled: widget.loaded && !widget.busy && widget.onSelectMode != null,
                    onTap: () => widget.onSelectMode?.call('inherit'),
                  ),
                  _ModeRow(
                    label: 'Activar en este chat',
                    detail: 'Solo esta conversación',
                    selected: widget.mode == 'on',
                    enabled: widget.loaded && !widget.busy && widget.onSelectMode != null,
                    onTap: () => widget.onSelectMode?.call('on'),
                  ),
                  _ModeRow(
                    label: 'Desactivar en este chat',
                    detail: 'Excluye esta conversación',
                    selected: widget.mode == 'off',
                    enabled: widget.loaded && !widget.busy && widget.onSelectMode != null,
                    onTap: () => widget.onSelectMode?.call('off'),
                  ),
                  if (widget.unavailable && widget.onRetry != null)
                    TextButton.icon(
                      onPressed: widget.onRetry,
                      icon: const Icon(Icons.refresh_rounded, size: 16),
                      label: const Text('Reintentar'),
                    ),
                  const SizedBox(height: 14),
                  Divider(height: 1, color: c.divider),
                  _Disclosure(
                    label: 'Contexto del cliente',
                    icon: Icons.person_search_outlined,
                    open: _contextOpen,
                    onTap: () => setState(() => _contextOpen = !_contextOpen),
                  ),
                  if (_contextOpen) _contextContent(c),
                  Divider(height: 1, color: c.divider),
                  _Disclosure(
                    label: 'Memoria del asistente',
                    icon: Icons.bookmark_border_rounded,
                    open: _memoryOpen,
                    onTap: () => setState(() => _memoryOpen = !_memoryOpen),
                  ),
                  if (_memoryOpen) _memoryContent(c),
                  if (widget.onOpenAssistant != null) ...[
                    Divider(height: 1, color: c.divider),
                    TextButton.icon(
                      onPressed: () {
                        _menuController.close();
                        widget.onOpenAssistant?.call();
                      },
                      icon: const Icon(Icons.auto_awesome_outlined, size: 17),
                      label: const Text('Abrir asistente contextual'),
                    ),
                  ],
                  const SizedBox(height: 4),
                  Text(
                    'Respuestas automáticas: disponible en una próxima etapa.',
                    style: _text(c, 11.5, FontWeight.w400, secondary: true),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
      builder: (context, controller, child) => AiAgentButton(
        enabled: widget.enabled && widget.loaded,
        busy: widget.busy,
        unavailable: widget.unavailable,
        tooltip: widget.tooltip,
        size: 40,
        onPressed: () => controller.isOpen ? controller.close() : controller.open(),
      ),
    );
  }

  Widget _contextContent(ChatPalette c) {
    final row = widget.conversation;
    if (row == null) {
      return _InfoBox(text: 'No hay datos del cliente en esta conversación.', palette: c);
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 11),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _FactRow(label: 'Nombre', value: row.name),
          if (row.phone.isNotEmpty) _FactRow(label: 'Teléfono', value: row.phone),
          if (row.stage.isNotEmpty) _FactRow(label: 'Etapa', value: row.stage.toLowerCase()),
          if (row.tags.isNotEmpty) _FactRow(label: 'Etiquetas', value: row.tags.join(', ')),
          if (row.hasPurchase) const _FactRow(label: 'Compras', value: 'Tiene compras registradas'),
          if (row.lastBody.isNotEmpty)
            _FactRow(
              label: row.lastDirection == 'outbound' ? 'Último mensaje del equipo' : 'Último mensaje del cliente',
              value: row.lastBody,
            ),
        ],
      ),
    );
  }

  Widget _memoryContent(ChatPalette c) {
    if (widget.memoryFacts.isEmpty) {
      return _InfoBox(
        text: 'Aquí aparecerán los datos que el asistente recuerde de este cliente',
        detail: 'Cada dato mostrará su origen y fecha.',
        palette: c,
      );
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        children: [for (final fact in widget.memoryFacts) _MemoryFactTile(fact: fact)],
      ),
    );
  }
}

/// Presentación prevista para una fuente futura. La interfaz no crea recuerdos.
class AiMemoryFact {
  const AiMemoryFact({required this.text, required this.source, required this.date});

  final String text;
  final String source;
  final String date;
}

class _MemoryFactTile extends StatelessWidget {
  const _MemoryFactTile({required this.fact});
  final AiMemoryFact fact;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 7),
      padding: const EdgeInsets.all(10),
      decoration: _softBox(c),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(fact.text, style: _text(c, 12.5, FontWeight.w600)),
          const SizedBox(height: 5),
          Text('${fact.source} · ${fact.date}', style: _text(c, 11.5, FontWeight.w400, secondary: true)),
        ],
      ),
    );
  }
}

class _MenuTitle extends StatelessWidget {
  const _MenuTitle({required this.title, required this.onClose});
  final String title;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Row(
      children: [
        Container(
          width: 30, height: 30,
          alignment: Alignment.center,
          decoration: BoxDecoration(color: c.accent.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(8)),
          child: Icon(Icons.auto_awesome_rounded, size: 16, color: c.accent),
        ),
        const SizedBox(width: 9),
        Expanded(child: Text(title, style: _text(c, 15, FontWeight.w700))),
        IconButton(
          tooltip: 'Cerrar', onPressed: onClose,
          constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
          visualDensity: VisualDensity.compact,
          icon: Icon(Icons.close_rounded, size: 18, color: c.textSecondary),
        ),
      ],
    );
  }
}

class _StatusLine extends StatelessWidget {
  const _StatusLine({required this.active, required this.label});
  final bool active;
  final String label;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 5),
          child: Container(
            width: 7, height: 7,
            decoration: BoxDecoration(
              color: active ? const Color(0xFF22A86D) : c.textSecondary.withValues(alpha: 0.55),
              shape: BoxShape.circle,
            ),
          ),
        ),
        const SizedBox(width: 7),
        Expanded(child: Text(label, style: _text(c, 12, FontWeight.w600))),
      ],
    );
  }
}

class _ModeRow extends StatelessWidget {
  const _ModeRow({required this.label, required this.detail, required this.selected, required this.enabled, required this.onTap});
  final String label;
  final String detail;
  final bool selected;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Material(
      color: selected ? c.accent.withValues(alpha: 0.10) : Colors.transparent,
      borderRadius: BorderRadius.circular(9),
      child: InkWell(
        onTap: enabled ? onTap : null,
        borderRadius: BorderRadius.circular(9),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(label, style: _text(c, 12.5, selected ? FontWeight.w700 : FontWeight.w500)),
                    Text(detail, style: _text(c, 11.5, FontWeight.w400, secondary: true)),
                  ],
                ),
              ),
              if (selected) Icon(Icons.check_rounded, size: 17, color: c.accent),
            ],
          ),
        ),
      ),
    );
  }
}

class _Disclosure extends StatelessWidget {
  const _Disclosure({required this.label, required this.icon, required this.open, required this.onTap});
  final String label;
  final IconData icon;
  final bool open;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          children: [
            Icon(icon, size: 17, color: c.accent),
            const SizedBox(width: 9),
            Expanded(child: Text(label, style: _text(c, 12.5, FontWeight.w600))),
            Icon(open ? Icons.expand_less_rounded : Icons.expand_more_rounded, size: 18, color: c.textSecondary),
          ],
        ),
      ),
    );
  }
}

class _InfoBox extends StatelessWidget {
  const _InfoBox({required this.text, required this.palette, this.detail});
  final String text;
  final String? detail;
  final ChatPalette palette;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 11),
    child: Container(
      width: double.infinity,
      padding: const EdgeInsets.all(11),
      decoration: _softBox(palette),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(text, style: _text(palette, 12, FontWeight.w500)),
          if (detail != null) ...[
            const SizedBox(height: 4),
            Text(detail!, style: _text(palette, 11.5, FontWeight.w400, secondary: true)),
          ],
        ],
      ),
    ),
  );
}

class _FactRow extends StatelessWidget {
  const _FactRow({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 7),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: _eyebrow(c)),
          const SizedBox(height: 2),
          Text(value, softWrap: true, style: _text(c, 12.5, FontWeight.w500)),
        ],
      ),
    );
  }
}

MenuStyle _menuStyle(ChatPalette c) => MenuStyle(
  backgroundColor: WidgetStatePropertyAll(c.panelBg),
  elevation: const WidgetStatePropertyAll(12),
  padding: const WidgetStatePropertyAll(EdgeInsets.zero),
  shape: WidgetStatePropertyAll(
    RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: c.divider)),
  ),
);

BoxDecoration _softBox(ChatPalette c) => BoxDecoration(
  color: c.fieldBg,
  borderRadius: BorderRadius.circular(9),
  border: Border.all(color: c.divider),
);

TextStyle _text(ChatPalette c, double size, FontWeight weight, {bool secondary = false}) => TextStyle(
  fontFamily: ChatDesktopMetrics.fontFamily,
  fontSize: size,
  fontWeight: weight,
  height: 1.3,
  color: secondary ? c.textSecondary : c.textPrimary,
);

TextStyle _eyebrow(ChatPalette c) => TextStyle(
  fontFamily: ChatDesktopMetrics.fontFamily,
  fontSize: 11,
  fontWeight: FontWeight.w700,
  letterSpacing: 0.35,
  color: c.textSecondary,
);
