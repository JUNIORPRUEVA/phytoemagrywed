import 'package:flutter/material.dart';

import '../../../core/theme/crm_tokens.dart';
import '../../../data/models/crm_models.dart';
import '../../common/pwa_icon.dart';
import 'chat_desktop_theme.dart';
import 'chat_filters.dart';

/// Columna lateral de filtros (estilo panel de WhatsApp Desktop).
///
/// Ocupa todo el alto del módulo y ~20 % del ancho, como el resto de paneles
/// laterales: nada de diálogos en el centro de la pantalla. Muestra los mismos
/// filtros del panel PWA —estado, etapa del cliente y fecha— y, junto a cada
/// uno, cuántas conversaciones quedarían.
class ChatFilterPanel extends StatelessWidget {
  const ChatFilterPanel({
    super.key,
    required this.width,
    required this.filters,
    required this.conversations,
    required this.onChanged,
    required this.onClose,
  });

  final double width;

  /// Todas las conversaciones (sin filtrar): con ellas se calculan los contadores.
  final List<Conversation> conversations;
  final ChatFilters filters;
  final ValueChanged<ChatFilters> onChanged;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;

    int countFor(ChatFilters probe) =>
        conversations.where((row) => probe.matches(row)).length;

    return Container(
      width: width,
      decoration: BoxDecoration(
        color: c.panelBg,
        border: Border(left: BorderSide(color: c.divider)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: 52,
            padding: const EdgeInsets.fromLTRB(10, 0, 8, 0),
            decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.divider))),
            child: Row(
              children: [
                Tooltip(
                  message: 'Cerrar filtros',
                  waitDuration: const Duration(milliseconds: 400),
                  child: InkWell(
                    onTap: onClose,
                    borderRadius: BorderRadius.circular(7),
                    child: Container(
                      width: 28,
                      height: 28,
                      alignment: Alignment.center,
                      child: PwaIcon(PwaIcons.back, size: 14, color: c.textSecondary),
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(child: Text('Filtros', style: t.rowName.copyWith(fontSize: 15))),
                if (!filters.isDefault)
                  TextButton(
                    onPressed: () => onChanged(const ChatFilters()),
                    style: TextButton.styleFrom(
                      foregroundColor: c.accent,
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      minimumSize: const Size(0, 28),
                    ),
                    child: const Text('Limpiar', style: TextStyle(fontSize: 12)),
                  ),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(10, 12, 10, 16),
              children: [
                _section(
                  context,
                  'Estado',
                  [
                    for (final value in ChatStatusFilter.values)
                      _option(
                        context,
                        label: chatStatusLabels[value]!,
                        selected: filters.status == value,
                        count: countFor(filters.copyWith(status: value)),
                        onTap: () => onChanged(filters.copyWith(status: value)),
                      ),
                  ],
                ),
                _section(
                  context,
                  'Etapa del cliente',
                  [
                    for (final value in ChatStageFilter.values)
                      _option(
                        context,
                        label: chatStageLabels[value]!,
                        selected: filters.stage == value,
                        count: countFor(filters.copyWith(stage: value)),
                        onTap: () => onChanged(filters.copyWith(stage: value)),
                      ),
                  ],
                ),
                _section(
                  context,
                  'Fecha del último mensaje',
                  [
                    for (final value in ChatDateFilter.values)
                      _option(
                        context,
                        label: chatDateLabels[value]!,
                        selected: filters.date == value,
                        count: countFor(filters.copyWith(date: value)),
                        onTap: () => onChanged(filters.copyWith(date: value)),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _section(BuildContext context, String title, List<Widget> children) {
    final c = ChatPalette.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.only(left: 6, bottom: 4),
            child: Text(
              title.toUpperCase(),
              style: TextStyle(
                fontFamily: ChatDesktopMetrics.fontFamily,
                fontSize: 10,
                fontWeight: FontWeight.w800,
                letterSpacing: 0.7,
                color: c.textSecondary,
              ),
            ),
          ),
          ...children,
        ],
      ),
    );
  }

  Widget _option(
    BuildContext context, {
    required String label,
    required bool selected,
    required int count,
    required VoidCallback onTap,
  }) {
    return _FilterRow(
      label: label,
      count: count,
      selected: selected,
      onTap: onTap,
    );
  }
}

class _FilterRow extends StatefulWidget {
  const _FilterRow({
    required this.label,
    required this.count,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final int count;
  final bool selected;
  final VoidCallback onTap;

  @override
  State<_FilterRow> createState() => _FilterRowState();
}

class _FilterRowState extends State<_FilterRow> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        onTap: widget.onTap,
        behavior: HitTestBehavior.opaque,
        child: Container(
          height: 32,
          margin: const EdgeInsets.only(bottom: 1),
          padding: const EdgeInsets.symmetric(horizontal: 8),
          decoration: BoxDecoration(
            color: widget.selected
                ? c.accent.withValues(alpha: 0.12)
                : (_hovered ? c.rowHover : Colors.transparent),
            borderRadius: BorderRadius.circular(7),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  widget.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: ChatDesktopMetrics.fontFamily,
                    fontSize: 12.5,
                    fontWeight: widget.selected ? FontWeight.w700 : FontWeight.w500,
                    color: widget.selected ? c.accent : c.textPrimary,
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                decoration: BoxDecoration(
                  color: c.fieldBg,
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  '${widget.count}',
                  style: TextStyle(
                    fontFamily: ChatDesktopMetrics.fontFamily,
                    fontSize: 10.5,
                    fontWeight: FontWeight.w700,
                    color: widget.selected ? c.accent : c.textSecondary,
                  ),
                ),
              ),
              if (widget.selected) ...[
                const SizedBox(width: 4),
                Icon(Icons.check_rounded, size: 14, color: c.accent),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
