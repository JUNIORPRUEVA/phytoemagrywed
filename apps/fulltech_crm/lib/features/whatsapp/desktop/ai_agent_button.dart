import 'package:flutter/material.dart';

import '../../../core/theme/crm_tokens.dart';
import '../../common/pwa_icon.dart';

/// El mismo distintivo para el control general y el de una conversación.
class AiAgentButton extends StatelessWidget {
  const AiAgentButton({
    super.key,
    required this.enabled,
    required this.tooltip,
    this.onPressed,
    this.onSelectMode,
    this.mode = 'inherit',
    this.globalEnabled = false,
    this.busy = false,
    this.unavailable = false,
    this.size = 34,
  });

  final bool enabled;
  final bool busy;
  final bool unavailable;
  final String tooltip;
  final VoidCallback? onPressed;
  final ValueChanged<String>? onSelectMode;
  final String mode;
  final bool globalEnabled;
  final double size;

  @override
  Widget build(BuildContext context) {
    final color = unavailable
        ? const Color(0xFFAB6435)
        : (enabled ? const Color(0xFF1255D8) : const Color(0xFF62738D));
    final visual = Material(
      color: unavailable
          ? const Color(0xFFFFF1E8)
          : (enabled ? const Color(0xFFE8F0FF) : const Color(0xFFF3F6FA)),
      borderRadius: BorderRadius.circular(9),
      child: SizedBox(
        width: size,
        height: size,
        child: Stack(
          alignment: Alignment.center,
          children: [
            busy
                ? SizedBox(width: 17, height: 17, child: CircularProgressIndicator(strokeWidth: 2, color: color))
                : PwaIcon(PwaIcons.robot, size: 22, color: color),
            if (!busy)
              Positioned(right: 3, top: 3, child: Icon(Icons.auto_awesome_rounded, size: 8, color: color)),
            Positioned(
              right: 4,
              bottom: 4,
              child: Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(
                  color: unavailable
                      ? const Color(0xFFE27D49)
                      : (enabled ? const Color(0xFF22A86D) : const Color(0xFFA7B2C1)),
                  shape: BoxShape.circle,
                ),
              ),
            ),
          ],
        ),
      ),
    );
    return Tooltip(
      message: tooltip,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2),
        child: onSelectMode != null
            ? PopupMenuButton<String>(
                enabled: !busy,
                tooltip: tooltip,
                padding: EdgeInsets.zero,
                onSelected: onSelectMode,
                itemBuilder: (_) => [
                  _modeItem('on', 'Activar solo este chat', Icons.auto_awesome_rounded),
                  _modeItem('off', 'Desactivar en este chat', Icons.pause_circle_outline_rounded),
                  _modeItem('inherit', 'Usar ajuste general', Icons.sync_rounded),
                ],
                child: visual,
              )
            : InkWell(
                onTap: busy ? null : onPressed,
                borderRadius: BorderRadius.circular(9),
                child: visual,
              ),
      ),
    );
  }

  PopupMenuItem<String> _modeItem(String value, String label, IconData icon) {
    return PopupMenuItem<String>(
      value: value,
      child: Row(
        children: [
          Icon(icon, size: 18, color: const Color(0xFF1255D8)),
          const SizedBox(width: 10),
          Expanded(child: Text(label, style: const TextStyle(fontSize: 13))),
          if (value == 'inherit')
            Text(globalEnabled ? 'Activo' : 'Apagado', style: const TextStyle(fontSize: 11, color: Color(0xFF62738D))),
          if (mode == value) const Icon(Icons.check_rounded, size: 17, color: Color(0xFF1255D8)),
        ],
      ),
    );
  }
}
