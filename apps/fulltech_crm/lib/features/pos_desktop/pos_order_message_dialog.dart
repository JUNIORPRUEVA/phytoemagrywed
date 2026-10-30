import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/crm_scope.dart';
import '../../data/crm_repository.dart';
import '../common/crm_ui.dart';

/// «Pedir datos al cliente» con IA — el equivalente nativo de la acción de la
/// PWA (`public/admin/pos.js` → `pedirDatosAlCliente`).
///
/// Reutiliza la ruta existente `POST /api/admin/ai/order-message`, que devuelve
/// **solo texto**: la IA pide lo que falta (teléfono, artículos, ubicación…)
/// sin inventar direcciones, precios ni estados.
///
/// Reglas que respeta este diálogo:
/// · el borrador **nunca** se envía solo: se muestra para copiar o para enviar
///   con una confirmación explícita;
/// · el envío reutiliza el transporte del chat (`sendMessage`) con **una sola
///   clave de operación**, así que dos toques no crean dos mensajes;
/// · si el envío falla, el texto se conserva;
/// · si la IA no está disponible, lo dice y no fabrica un mensaje.
class PosOrderMessageDialog extends StatefulWidget {
  const PosOrderMessageDialog({
    super.key,
    required this.customerName,
    required this.customerPhone,
    required this.missing,
    required this.totalCents,
    this.customerId = '',
    this.repository,
    this.onSent,
  });

  final String customerName;
  final String customerPhone;
  /// Id del cliente en el CRM: es la forma fiable de encontrar su chat.
  final String customerId;
  final List<String> missing;
  final int totalCents;

  /// Solo para pruebas: en la app se toma del `CrmScope`.
  final CrmRepository? repository;

  /// Se avisa cuando el mensaje ya quedó registrado en el servidor.
  final ValueChanged<String>? onSent;

  @override
  State<PosOrderMessageDialog> createState() => _PosOrderMessageDialogState();
}

class _PosOrderMessageDialogState extends State<PosOrderMessageDialog> {
  String _conversationId = '';
  String _texto = '';
  String _error = '';
  bool _cargando = true;
  bool _enviando = false;
  bool _enviado = false;
  /// Se fija una sola vez: el reintento reutiliza la misma clave.
  String _clave = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _generar());
  }

  CrmRepository get _repo => widget.repository ?? CrmScope.of(context, listen: false).repository;

  Future<void> _generar() async {
    setState(() {
      _cargando = true;
      _error = '';
      _texto = '';
    });
    try {
      final chat = await _conversacionDelCliente();
      if (chat.isEmpty) {
        if (!mounted) return;
        setState(() {
          _cargando = false;
          _error = 'Este cliente no tiene ningún chat abierto. Ábrelo desde WhatsApp y vuelve a intentarlo.';
        });
        return;
      }
      _conversationId = chat;
      final texto = await _repo.aiOrderMessage(
        conversationId: chat,
        missing: widget.missing,
        total: widget.totalCents / 100,
      );
      if (!mounted) return;
      setState(() {
        _cargando = false;
        _texto = texto.trim();
        if (_texto.isEmpty) _error = 'La IA no devolvió ningún texto. Escribe el mensaje a mano.';
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _cargando = false;
        _error = 'No se pudo preparar el mensaje. Revisa la conexión e inténtalo otra vez.';
      });
      debugPrint('mensaje de pedido: $error');
    }
  }

  /// Busca la conversación del cliente (misma ruta que la bandeja). Primero por
  /// `customer_id` —lo que no depende del formato del teléfono— y, si la fila no
  /// lo trae, por los dígitos del teléfono. No crea conversaciones: si no hay
  /// chat, se avisa.
  Future<String> _conversacionDelCliente() async {
    final digitos = widget.customerPhone.replaceAll(RegExp(r'[^0-9]'), '');
    if (widget.customerId.isEmpty && digitos.isEmpty) return '';
    final page = await _repo.conversations(
      query: digitos.isEmpty ? '' : widget.customerPhone,
    );
    final filas = page['conversations'];
    if (filas is! List) return '';
    // 1) Por id de cliente: exacto y sin ambigüedades.
    if (widget.customerId.isNotEmpty) {
      for (final fila in filas) {
        if (fila is! Map) continue;
        if ('${fila['customer_id'] ?? ''}' == widget.customerId) return '${fila['id'] ?? ''}';
      }
    }
    // 2) Por teléfono, comparando por sufijo (el mismo número llega con o sin
    //    prefijo).
    if (digitos.isEmpty) return '';
    for (final fila in filas) {
      if (fila is! Map) continue;
      final cliente = fila['customer'] is Map ? fila['customer'] as Map : const {};
      final telefono = '${cliente['phone'] ?? cliente['phone_e164'] ?? fila['phone'] ?? ''}'
          .replaceAll(RegExp(r'[^0-9]'), '');
      if (telefono.isEmpty) continue;
      final cola = digitos.length > 7 ? digitos.substring(digitos.length - 7) : digitos;
      if (telefono.endsWith(cola)) return '${fila['id'] ?? ''}';
    }
    return '';
  }

  Future<void> _copiar() async {
    await Clipboard.setData(ClipboardData(text: _texto));
    if (!mounted) return;
    crmToast(context, 'Mensaje copiado.');
  }

  Future<void> _enviar() async {
    if (_enviando || _conversationId.isEmpty || _texto.isEmpty) return;
    final confirmado = await crmConfirm(
      context,
      title: 'Enviar al cliente',
      message: 'Se enviará a ${widget.customerName} por WhatsApp. ¿Continuar?',
      confirmLabel: 'Enviar',
    );
    if (confirmado != true || !mounted) return;
    setState(() {
      _enviando = true;
      _error = '';
    });
    // La MISMA clave en un reintento: el servidor no duplica el mensaje.
    _clave = _clave.isEmpty ? 'wa_order_${DateTime.now().microsecondsSinceEpoch}' : _clave;
    try {
      await _repo.sendMessage(_conversationId, _texto, operationKey: _clave);
      if (!mounted) return;
      setState(() {
        _enviando = false;
        _enviado = true;
      });
      widget.onSent?.call(_texto);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _enviando = false;
        _error = 'No se pudo enviar. El texto se conserva: puedes reintentarlo.';
      });
      debugPrint('envío del mensaje de pedido: $error');
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Theme.of(context).colorScheme;
    return AlertDialog(
      title: Row(
        children: [
          const Icon(Icons.auto_awesome_outlined, size: 20),
          const SizedBox(width: 8),
          Expanded(child: Text('Pedir datos a ${widget.customerName}')),
        ],
      ),
      content: SizedBox(
        width: 480,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (widget.missing.isNotEmpty)
              Text('Falta: ${widget.missing.join(', ')}', style: const TextStyle(fontSize: 12)),
            const SizedBox(height: 10),
            if (_cargando)
              const Row(
                children: [
                  SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                  SizedBox(width: 10),
                  Text('Preparando el mensaje…', style: TextStyle(fontSize: 13)),
                ],
              )
            else if (_texto.isNotEmpty)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  border: Border.all(color: p.outlineVariant),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(_texto, style: const TextStyle(fontSize: 13)),
              ),
            if (_error.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(_error, style: TextStyle(fontSize: 12, color: p.error)),
            ],
            if (_enviado) ...[
              const SizedBox(height: 10),
              const Text('Mensaje registrado en el chat.', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
            ],
            const SizedBox(height: 8),
            const Text(
              'La IA solo redacta: no cambia el pedido y no envía nada por su cuenta.',
              style: TextStyle(fontSize: 11),
            ),
          ],
        ),
      ),
      actions: [
        if (!_cargando && _texto.isNotEmpty) ...[
          TextButton(onPressed: _copiar, child: const Text('Copiar')),
          TextButton(onPressed: _enviando ? null : _generar, child: const Text('Regenerar')),
          FilledButton.icon(
            onPressed: _enviando || _enviado ? null : _enviar,
            icon: const Icon(Icons.send_outlined, size: 16),
            label: Text(_enviando ? 'Enviando…' : 'Enviar al cliente'),
          ),
        ],
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cerrar')),
      ],
    );
  }
}
