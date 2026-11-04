import 'dart:async';

import 'package:flutter/material.dart';

import '../common/crm_ui.dart';

/// Aviso único del POS, sobre la ventana y sin alterar el foco ni el layout.
void posToast(
  BuildContext context,
  String message, {
  CrmToastTone tone = CrmToastTone.info,
}) {
  final overlay = Overlay.maybeOf(context, rootOverlay: true);
  if (overlay == null || message.trim().isEmpty) return;
  _PosToastHost.show(overlay, message.trim(), tone);
}

class _PosToastHost extends StatefulWidget {
  const _PosToastHost({super.key});

  static OverlayEntry? _entry;
  static final _key = GlobalKey<_PosToastHostState>();

  static void show(OverlayState overlay, String message, CrmToastTone tone) {
    _entry ??= OverlayEntry(builder: (_) => _PosToastHost(key: _key));
    if (_entry!.mounted == false) overlay.insert(_entry!);
    _key.currentState?.show(message, tone);
    if (_key.currentState == null) {
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _key.currentState?.show(message, tone),
      );
    }
  }

  @override
  State<_PosToastHost> createState() => _PosToastHostState();
}

class _PosToastHostState extends State<_PosToastHost> {
  String? _message;
  CrmToastTone _tone = CrmToastTone.info;
  Timer? _timer;

  void show(String message, CrmToastTone tone) {
    if (_message == message) return;
    _timer?.cancel();
    setState(() {
      _message = message;
      _tone = tone;
    });
    _timer = Timer(
      Duration(seconds: tone == CrmToastTone.error ? 9 : 7),
      close,
    );
  }

  void close() {
    if (mounted) setState(() => _message = null);
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final message = _message;
    return Positioned(
      top: 10,
      right: 10,
      child: message == null
          ? const SizedBox.shrink()
          : Material(
              color: Colors.transparent,
              child: Container(
                constraints: const BoxConstraints(maxWidth: 340),
                padding: const EdgeInsets.fromLTRB(12, 10, 6, 10),
                decoration: BoxDecoration(
                  color: const Color(0xFFFFFAF2),
                  border: Border.all(color: const Color(0xFFEADDC9)),
                  borderRadius: BorderRadius.circular(9),
                  boxShadow: const [
                    BoxShadow(
                      color: Color(0x22000000),
                      blurRadius: 12,
                      offset: Offset(0, 4),
                    ),
                  ],
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      _tone == CrmToastTone.error
                          ? Icons.error_outline
                          : _tone == CrmToastTone.success
                          ? Icons.check_circle_outline
                          : Icons.info_outline,
                      size: 17,
                      color: const Color(0xFFB85B12),
                    ),
                    const SizedBox(width: 8),
                    Flexible(
                      child: Text(
                        message,
                        softWrap: true,
                        style: const TextStyle(
                          fontSize: 13,
                          height: 1.38,
                          color: Color(0xFF8B430C),
                        ),
                      ),
                    ),
                    IconButton(
                      onPressed: close,
                      tooltip: 'Cerrar aviso',
                      padding: EdgeInsets.zero,
                      constraints: const BoxConstraints(
                        minWidth: 26,
                        minHeight: 26,
                      ),
                      icon: const Icon(
                        Icons.close,
                        size: 15,
                        color: Color(0xFF8B430C),
                      ),
                    ),
                  ],
                ),
              ),
            ),
    );
  }
}
