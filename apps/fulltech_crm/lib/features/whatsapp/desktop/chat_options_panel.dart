import 'package:flutter/material.dart';

import '../../../core/theme/crm_tokens.dart';
import '../../common/pwa_icon.dart';
import 'chat_desktop_theme.dart';

/// Columna lateral de acciones del chat (todo el alto, ~20 % del ancho).
///
/// Reúne lo que antes estaba repartido en menús: el **asistente de IA**
/// (corregir la ortografía del mensaje que se está escribiendo y sugerir una
/// respuesta) y las **acciones comerciales** (crear pedido, cotización,
/// plantilla, datos de pago, asignación, finalizar, recargar).
class ChatOptionsPanel extends StatelessWidget {
  const ChatOptionsPanel({
    super.key,
    required this.width,
    required this.onClose,
    required this.onProofread,
    required this.onReplySuggestion,
    required this.onAssistant,
    required this.onNewOrder,
    required this.onTemplate,
    required this.onShareData,
    required this.onAssign,
    required this.onResolveToggle,
    required this.onRefresh,
    this.onReconcile,
    required this.isResolved,
    required this.onUseSuggestion,
    required this.onDiscardSuggestion,
    this.aiBusy = false,
    this.aiOriginal = '',
    this.aiSuggestion = '',
    this.aiError = '',
  });

  final double width;
  final VoidCallback onClose;

  /// Pide a la IA que corrija el texto del compositor.
  final VoidCallback onProofread;

  /// Pide a la IA una respuesta sugerida para el hilo.
  final VoidCallback onReplySuggestion;

  /// Abre el asistente contextual (misma ruta que el Centro IA del panel web).
  final VoidCallback onAssistant;

  /// Abre Facturación para crear el pedido de este cliente.
  final VoidCallback onNewOrder;
  final VoidCallback onTemplate;
  final VoidCallback onShareData;
  final VoidCallback onAssign;
  final VoidCallback onResolveToggle;
  final VoidCallback onRefresh;

  /// Conciliación de un envío de archivo cuyo resultado quedó en duda.
  final VoidCallback? onReconcile;
  final bool isResolved;

  final VoidCallback onUseSuggestion;
  final VoidCallback onDiscardSuggestion;

  final bool aiBusy;
  final String aiOriginal;
  final String aiSuggestion;
  final String aiError;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    return Container(
      width: width,
      decoration: BoxDecoration(
        color: c.panelBg,
        border: Border(left: BorderSide(color: c.divider)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: c.dark ? 0.45 : 0.10),
            blurRadius: 24,
            offset: const Offset(-6, 0),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: 52,
            padding: const EdgeInsets.fromLTRB(10, 0, 12, 0),
            decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.divider))),
            child: Row(
              children: [
                Tooltip(
                  message: 'Cerrar',
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
                Expanded(child: Text('Opciones', style: t.rowName.copyWith(fontSize: 15))),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(10, 12, 10, 16),
              children: [
                _title(context, 'Asistente IA'),
                _action(
                  context,
                  icon: Icons.auto_awesome_outlined,
                  label: 'Corregir ortografía',
                  hint: 'Revisa el mensaje que estás escribiendo',
                  accent: true,
                  onTap: onProofread,
                ),
                _action(
                  context,
                  icon: Icons.forum_outlined,
                  label: 'Sugerir respuesta',
                  hint: 'Propone una respuesta para este chat',
                  accent: true,
                  onTap: onReplySuggestion,
                ),
                _action(
                  context,
                  icon: Icons.psychology_alt_outlined,
                  label: 'Asistente contextual',
                  hint: 'Analiza el chat, el expediente y prepara la siguiente acción',
                  accent: true,
                  onTap: onAssistant,
                ),
                if (aiBusy)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 6),
                    child: Row(
                      children: [
                        SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(strokeWidth: 2, color: c.accent),
                        ),
                        const SizedBox(width: 8),
                        Text('Pensando…', style: t.rowPreview.copyWith(fontSize: 12)),
                      ],
                    ),
                  ),
                if (aiError.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 6),
                    child: Text(
                      aiError,
                      style: t.rowPreview.copyWith(fontSize: 11.5, color: c.danger),
                    ),
                  ),
                if (aiSuggestion.isNotEmpty) _suggestionCard(context),
                const SizedBox(height: 6),
                _title(context, 'Ventas'),
                _action(
                  context,
                  icon: Icons.point_of_sale_outlined,
                  label: 'Crear pedido',
                  hint: 'Abre Facturación con este cliente',
                  onTap: onNewOrder,
                ),
                _action(
                  context,
                  icon: Icons.description_outlined,
                  label: 'Enviar plantilla',
                  onTap: onTemplate,
                ),
                _action(
                  context,
                  icon: Icons.place_outlined,
                  label: 'Datos de pago / ubicación',
                  onTap: onShareData,
                ),
                const SizedBox(height: 6),
                _title(context, 'Conversación'),
                _action(
                  context,
                  icon: Icons.assignment_ind_outlined,
                  label: 'Asignación…',
                  onTap: onAssign,
                ),
                _action(
                  context,
                  icon: isResolved ? Icons.restart_alt_rounded : Icons.task_alt_rounded,
                  label: isResolved ? 'Reabrir conversación' : 'Finalizar conversación',
                  danger: !isResolved,
                  onTap: onResolveToggle,
                ),
                _action(
                  context,
                  icon: Icons.refresh_rounded,
                  label: 'Recargar mensajes',
                  onTap: onRefresh,
                ),
                if (onReconcile != null)
                  _action(
                    context,
                    icon: Icons.fact_check_outlined,
                    label: 'Conciliar envío de archivo',
                    hint: 'Solo si el resultado quedó en duda',
                    onTap: onReconcile!,
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _title(BuildContext context, String text) {
    final c = ChatPalette.of(context);
    return Padding(
      padding: const EdgeInsets.only(left: 6, bottom: 4),
      child: Text(
        text.toUpperCase(),
        style: TextStyle(
          fontFamily: ChatDesktopMetrics.fontFamily,
          fontSize: 10,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.7,
          color: c.textSecondary,
        ),
      ),
    );
  }

  Widget _action(
    BuildContext context, {
    required IconData icon,
    required String label,
    required VoidCallback onTap,
    String? hint,
    bool accent = false,
    bool danger = false,
  }) {
    final c = ChatPalette.of(context);
    final tint = danger ? c.danger : (accent ? c.accent : c.textSecondary);
    return _PanelRow(
      onTap: onTap,
      child: Row(
        children: [
          Icon(icon, size: 16, color: tint),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: ChatDesktopMetrics.fontFamily,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: danger ? c.danger : c.textPrimary,
                  ),
                ),
                if ((hint ?? '').isNotEmpty)
                  Text(
                    hint!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontFamily: ChatDesktopMetrics.fontFamily,
                      fontSize: 10.5,
                      color: c.textSecondary,
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Tarjeta con la propuesta de la IA: nunca envía sola.
  Widget _suggestionCard(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    return Container(
      margin: const EdgeInsets.only(top: 4, bottom: 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: c.fieldBg,
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: c.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (aiOriginal.isNotEmpty) ...[
            Text(
              aiOriginal,
              style: t.rowPreview.copyWith(
                fontSize: 11.5,
                decoration: TextDecoration.lineThrough,
                color: c.textSecondary,
              ),
            ),
            const SizedBox(height: 6),
          ],
          Text(
            aiSuggestion,
            style: t.bubbleBody.copyWith(fontSize: 12.5, color: c.textPrimary),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: SizedBox(
                  height: 30,
                  child: FilledButton(
                    onPressed: onUseSuggestion,
                    style: FilledButton.styleFrom(
                      backgroundColor: c.accent,
                      foregroundColor: Colors.white,
                      padding: EdgeInsets.zero,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(7)),
                    ),
                    child: const Text('Usar', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: SizedBox(
                  height: 30,
                  child: TextButton(
                    onPressed: onDiscardSuggestion,
                    style: TextButton.styleFrom(
                      foregroundColor: c.textSecondary,
                      padding: EdgeInsets.zero,
                    ),
                    child: const Text('Descartar', style: TextStyle(fontSize: 12)),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _PanelRow extends StatefulWidget {
  const _PanelRow({required this.onTap, required this.child});

  final VoidCallback onTap;
  final Widget child;

  @override
  State<_PanelRow> createState() => _PanelRowState();
}

class _PanelRowState extends State<_PanelRow> {
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
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
          margin: const EdgeInsets.only(bottom: 1),
          decoration: BoxDecoration(
            color: _hovered ? c.rowHover : Colors.transparent,
            borderRadius: BorderRadius.circular(7),
          ),
          child: widget.child,
        ),
      ),
    );
  }
}
