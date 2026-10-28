import 'package:flutter/material.dart';

import '../../../app/crm_scope.dart';
import '../../../core/net/api_client.dart';
import '../../../core/theme/crm_tokens.dart';
import '../../../data/models/crm_models.dart';
import '../../common/pwa_icon.dart';
import 'chat_desktop_theme.dart';

/// «Nuevo mensaje» como **columna lateral** (no un diálogo en el centro).
///
/// Misma lógica que el panel PWA: `POST /api/admin/conversations/start` crea o
/// recupera el cliente por teléfono y abre su conversación; el primer mensaje es
/// opcional.
class ChatNewMessagePanel extends StatefulWidget {
  const ChatNewMessagePanel({
    super.key,
    required this.width,
    required this.onClose,
    required this.onCreated,
  });

  final double width;
  final VoidCallback onClose;

  /// Recibe el `id` de la conversación abierta.
  final ValueChanged<String> onCreated;

  @override
  State<ChatNewMessagePanel> createState() => _ChatNewMessagePanelState();
}

class _ChatNewMessagePanelState extends State<ChatNewMessagePanel> {
  final _formKey = GlobalKey<FormState>();
  final _phone = TextEditingController();
  final _name = TextEditingController();
  final _body = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _phone.dispose();
    _name.dispose();
    _body.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_saving) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final state = CrmScope.of(context, listen: false);
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final data = await state.repository.startConversation(
        phone: _phone.text.trim(),
        name: _name.text.trim(),
        body: _body.text.trim(),
      );
      final id = str(mapv(data['conversation'])['id']);
      if (id.isEmpty) {
        throw ApiException(500, 'El servidor no devolvió la conversación.');
      }
      await state.refresh(quiet: true);
      if (!mounted) return;
      widget.onCreated(id);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = error.message;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final t = c.text;
    return Container(
      width: widget.width,
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
                    onTap: _saving ? null : widget.onClose,
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
                Expanded(child: Text('Nuevo mensaje', style: t.rowName.copyWith(fontSize: 15))),
              ],
            ),
          ),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'Abre un chat con un cliente nuevo o existente.',
                      style: t.rowPreview.copyWith(fontSize: 12),
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _phone,
                      autofocus: true,
                      keyboardType: TextInputType.phone,
                      style: t.bubbleBody.copyWith(fontSize: 13),
                      cursorColor: c.accent,
                      decoration: _field(context, 'Teléfono', '+18095551010'),
                      validator: (value) =>
                          (value ?? '').replaceAll(RegExp(r'[^0-9]'), '').length < 7
                          ? 'Escribe el teléfono del cliente.'
                          : null,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _name,
                      textCapitalization: TextCapitalization.words,
                      style: t.bubbleBody.copyWith(fontSize: 13),
                      cursorColor: c.accent,
                      decoration: _field(context, 'Nombre', 'Opcional'),
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _body,
                      minLines: 3,
                      maxLines: 6,
                      maxLength: 1200,
                      style: t.bubbleBody.copyWith(fontSize: 13),
                      cursorColor: c.accent,
                      decoration: _field(context, 'Primer mensaje', 'Hola, te escribimos de FullTECH…'),
                    ),
                    if (_error != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: Text(
                          _error!,
                          style: TextStyle(
                            fontFamily: ChatDesktopMetrics.fontFamily,
                            fontSize: 12,
                            color: c.danger,
                          ),
                        ),
                      ),
                    const SizedBox(height: 4),
                    SizedBox(
                      height: 40,
                      child: FilledButton(
                        onPressed: _saving ? null : _submit,
                        style: FilledButton.styleFrom(
                          backgroundColor: c.accent,
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
                        ),
                        child: _saving
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                              )
                            : const Text('Abrir chat', style: TextStyle(fontWeight: FontWeight.w700)),
                      ),
                    ),
                    const SizedBox(height: 8),
                    TextButton(
                      onPressed: _saving ? null : widget.onClose,
                      style: TextButton.styleFrom(foregroundColor: c.textSecondary),
                      child: const Text('Cancelar', style: TextStyle(fontSize: 12.5)),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  InputDecoration _field(BuildContext context, String label, String hint) {
    final c = ChatPalette.of(context);
    final border = OutlineInputBorder(
      borderRadius: BorderRadius.circular(9),
      borderSide: BorderSide(color: c.divider),
    );
    return InputDecoration(
      labelText: label,
      hintText: hint,
      isDense: true,
      filled: true,
      fillColor: c.fieldBg,
      labelStyle: TextStyle(
        fontFamily: ChatDesktopMetrics.fontFamily,
        fontSize: 12,
        color: c.textSecondary,
      ),
      hintStyle: TextStyle(
        fontFamily: ChatDesktopMetrics.fontFamily,
        fontSize: 12.5,
        color: c.textSecondary.withValues(alpha: 0.8),
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      border: border,
      enabledBorder: border,
      focusedBorder: border.copyWith(borderSide: BorderSide(color: c.accent, width: 1.4)),
    );
  }
}
