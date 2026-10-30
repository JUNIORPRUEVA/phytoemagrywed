import 'package:flutter/material.dart';

import '../../../core/net/api_client.dart';
import '../../../data/crm_repository.dart';
import '../../common/crm_ui.dart';

/// CONCILIACIÓN de un envío de archivo con resultado DESCONOCIDO.
///
/// Qué es y qué NO es:
///   · NO es «reenviar el archivo». Volver a enviar a ciegas puede duplicar un
///     mensaje que sí salió.
///   · ES la corrección, hecha por una persona que ya miró WhatsApp, de una
///     operación que quedó en `SENDING`/`SEND_UNKNOWN`.
///
/// Por eso exige datos concretos y una confirmación explícita:
///   · el identificador de la operación (el que muestra Ajustes → auditoría),
///   · si el archivo salió o no,
///   · si salió, el identificador del mensaje de WhatsApp (prueba, no suposición).
///
/// Nada se da por enviado porque una petición haya tardado: el servidor solo
/// cambia el estado con esos datos y devuelve el resultado que se muestra tal cual.
class ChatMediaReconcileDialog extends StatefulWidget {
  const ChatMediaReconcileDialog({super.key, required this.repository});

  final CrmRepository repository;

  @override
  State<ChatMediaReconcileDialog> createState() => _ChatMediaReconcileDialogState();
}

class _ChatMediaReconcileDialogState extends State<ChatMediaReconcileDialog> {
  final _operacion = TextEditingController();
  final _wamid = TextEditingController();
  String _resultado = 'sent';
  bool _enviando = false;
  String? _error;
  String? _exito;

  @override
  void dispose() {
    _operacion.dispose();
    _wamid.dispose();
    super.dispose();
  }

  Future<void> _confirmar() async {
    final id = _operacion.text.trim();
    if (id.isEmpty) {
      setState(() => _error = 'Escribe el identificador de la operación.');
      return;
    }
    final wamid = _wamid.text.trim();
    if (_resultado == 'sent' && wamid.isEmpty) {
      setState(() => _error = 'Para marcarlo como ENVIADO hace falta el identificador del mensaje de WhatsApp.');
      return;
    }
    final seguro = await crmConfirm(
      context,
      title: 'Confirmar conciliación',
      message: _resultado == 'sent'
          ? 'Se marcará la operación $id como ENVIADA con el mensaje $wamid.\n\nHazlo solo si lo has visto en WhatsApp.'
          : 'Se marcará la operación $id como NO ENVIADA. Después se podrá reintentar desde la conversación con la misma clave.',
      confirmLabel: 'Conciliar',
    );
    if (seguro != true || !mounted) return;
    setState(() {
      _enviando = true;
      _error = null;
      _exito = null;
    });
    try {
      final data = await widget.repository.reconcileMedia(
        id,
        outcome: _resultado,
        waMessageId: _resultado == 'sent' ? wamid : null,
      );
      if (!mounted) return;
      setState(() {
        _exito = _resultado == 'sent'
            ? 'El servidor confirma: ENVIADO (${data['reconciled'] ?? 'sent'}).'
            : 'El servidor confirma: NO ENVIADO. Se puede reintentar con la misma clave.';
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Conciliar envío de archivo'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Solo para envíos cuyo resultado quedó en duda. No reenvía nada: corrige el estado con lo que ya viste en WhatsApp.',
              style: TextStyle(fontSize: 12.5),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _operacion,
              decoration: const InputDecoration(
                labelText: 'Identificador de la operación',
                hintText: 'mrd_…',
              ),
            ),
            const SizedBox(height: 12),
            RadioListTile<String>(
              value: 'sent',
              // ignore: deprecated_member_use
              groupValue: _resultado,
              // ignore: deprecated_member_use
              onChanged: (v) => setState(() => _resultado = v ?? 'sent'),
              title: const Text('El archivo SÍ salió'),
              subtitle: const Text('Hace falta el identificador del mensaje de WhatsApp'),
            ),
            RadioListTile<String>(
              value: 'not_sent',
              // ignore: deprecated_member_use
              groupValue: _resultado,
              // ignore: deprecated_member_use
              onChanged: (v) => setState(() => _resultado = v ?? 'sent'),
              title: const Text('El archivo NO salió'),
              subtitle: const Text('Quedará reintentable con la misma clave'),
            ),
            if (_resultado == 'sent')
              TextField(
                controller: _wamid,
                decoration: const InputDecoration(
                  labelText: 'Identificador del mensaje (wamid)',
                  hintText: 'wamid.…',
                ),
              ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12.5)),
              ),
            if (_exito != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(_exito!, style: const TextStyle(fontSize: 12.5)),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cerrar')),
        FilledButton(
          onPressed: _enviando ? null : _confirmar,
          child: _enviando ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Conciliar'),
        ),
      ],
    );
  }
}
