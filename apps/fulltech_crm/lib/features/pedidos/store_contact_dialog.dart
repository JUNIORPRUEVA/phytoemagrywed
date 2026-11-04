import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/net/api_client.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';

/// Hilo operativo del pedido; se mantiene fuera del chat comercial del cliente.
class StoreContactDialog extends StatefulWidget {
  const StoreContactDialog({super.key, required this.orderId});
  final String orderId;

  @override
  State<StoreContactDialog> createState() => _StoreContactDialogState();
}

class _StoreContactDialogState extends State<StoreContactDialog> {
  final _editor = TextEditingController();
  final _scroll = ScrollController();
  Timer? _timer;
  Map<String, dynamic>? _thread;
  String? _error;
  bool _sending = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_timer != null) return;
    _load();
    _timer = Timer.periodic(const Duration(seconds: 12), (_) => _load());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _editor.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final data = await CrmScope.of(
        context,
        listen: false,
      ).repository.storeContact(widget.orderId);
      if (!mounted) return;
      final previous = listv(_thread?['messages']).length;
      final current = listv(data['messages']).length;
      setState(() {
        _thread = data;
        _error = null;
      });
      if (previous != current) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && _scroll.hasClients)
            _scroll.animateTo(
              _scroll.position.maxScrollExtent,
              duration: const Duration(milliseconds: 200),
              curve: Curves.easeOut,
            );
        });
      }
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    }
  }

  Future<void> _send() async {
    final message = _editor.text.trim();
    if (message.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      final key =
          'operator-${DateTime.now().microsecondsSinceEpoch}-${Random.secure().nextInt(1 << 30)}';
      await CrmScope.of(context, listen: false).repository.sendStoreContact(
        widget.orderId,
        message: message,
        idempotencyKey: key,
      );
      if (!mounted) return;
      _editor.clear();
      await _load();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final store = mapv(_thread?['store']);
    final messages = listv(_thread?['messages']);
    final writable = _thread?['writable'] == true;
    return Dialog(
      child: SizedBox(
        width: 550,
        height: MediaQuery.sizeOf(context).height * .78,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 8, 8),
              child: Row(
                children: [
                  Icon(Icons.storefront_outlined, color: p.primary, size: 21),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          str(store['name'], 'Contacto de tienda'),
                          style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w800,
                            color: p.ink,
                          ),
                        ),
                        Text(
                          'Pedido ${widget.orderId}',
                          style: TextStyle(fontSize: 11, color: p.inkSecondary),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    onPressed: _load,
                    tooltip: 'Actualizar',
                    icon: const Icon(Icons.refresh_rounded, size: 19),
                  ),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    tooltip: 'Cerrar',
                    icon: const Icon(Icons.close, size: 19),
                  ),
                ],
              ),
            ),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(9),
              color: p.primaryTint,
              child: Text(
                'Canal operativo mediado por el CRM. La tienda externa aún '
                'no recibe estos mensajes automáticamente.',
                style: TextStyle(fontSize: 11, color: p.inkSecondary),
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.all(8),
                child: Text(_error!, style: TextStyle(color: p.danger)),
              ),
            Expanded(
              child: _thread == null && _error == null
                  ? const Center(child: CircularProgressIndicator())
                  : messages.isEmpty
                  ? const Center(child: Text('Todavía no hay mensajes.'))
                  : ListView.builder(
                      controller: _scroll,
                      padding: const EdgeInsets.all(11),
                      itemCount: messages.length,
                      itemBuilder: (context, index) {
                        final message = messages[index];
                        final operator = message['role'] == 'operator';
                        final assignment = str(message['courier_account_id']);
                        final previousAssignment = index == 0
                            ? ''
                            : str(messages[index - 1]['courier_account_id']);
                        return Column(
                          children: [
                            if (index > 0 && assignment != previousAssignment)
                              Padding(
                                padding: const EdgeInsets.symmetric(
                                  vertical: 8,
                                ),
                                child: Text(
                                  'Nueva asignación de repartidor',
                                  style: TextStyle(
                                    fontSize: 10,
                                    color: p.inkSecondary,
                                  ),
                                ),
                              ),
                            Align(
                              alignment: operator
                                  ? Alignment.centerRight
                                  : Alignment.centerLeft,
                              child: Container(
                                margin: const EdgeInsets.only(bottom: 6),
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 10,
                                  vertical: 8,
                                ),
                                constraints: const BoxConstraints(
                                  maxWidth: 440,
                                ),
                                decoration: BoxDecoration(
                                  color: operator
                                      ? p.primaryTint
                                      : p.surfaceMuted,
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      operator
                                          ? 'Equipo CRM'
                                          : str(
                                              message['author_name'],
                                              'Repartidor',
                                            ),
                                      style: TextStyle(
                                        fontSize: 10,
                                        fontWeight: FontWeight.w700,
                                        color: p.inkSecondary,
                                      ),
                                    ),
                                    const SizedBox(height: 2),
                                    Text(
                                      str(message['text']),
                                      style: TextStyle(
                                        fontSize: 12,
                                        color: p.ink,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        );
                      },
                    ),
            ),
            if (writable)
              Container(
                padding: const EdgeInsets.all(9),
                decoration: BoxDecoration(
                  border: Border(top: BorderSide(color: p.border)),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _editor,
                        minLines: 1,
                        maxLines: 3,
                        maxLength: 1000,
                        decoration: const InputDecoration(
                          hintText: 'Responder al repartidor',
                          isDense: true,
                          border: OutlineInputBorder(),
                          counterText: '',
                        ),
                      ),
                    ),
                    IconButton(
                      onPressed: _sending ? null : _send,
                      tooltip: 'Enviar respuesta',
                      icon: Icon(Icons.send_rounded, color: p.primary),
                    ),
                  ],
                ),
              )
            else if (_thread != null)
              Padding(
                padding: const EdgeInsets.all(12),
                child: Text(
                  'Entrega cerrada · solo lectura',
                  style: TextStyle(color: p.inkSecondary),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
