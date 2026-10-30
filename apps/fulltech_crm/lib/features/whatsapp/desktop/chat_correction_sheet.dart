import 'package:flutter/material.dart';

import '../../../core/net/api_client.dart';
import '../../../core/text/local_corrector.dart';
import '../../../data/crm_repository.dart';

/// Corrección del mensaje que se está escribiendo.
///
/// Dos pasos, en este orden:
///   1. **Revisión local** (instantánea, sin red, sin IA): espacios, mayúsculas,
///      signos de apertura y errores de escritura frecuentes. Siempre hay algo
///      que enseñar, incluso sin clave de IA.
///   2. **Mejorar con IA** (opcional): pide al servidor su corrección y la
///      sustituye. Si la IA no está configurada se explica tal cual; nunca se
///      finge una propuesta.
///
/// NADA se envía desde aquí: devuelve el texto elegido y la persona decide.
class ChatCorrectionSheet extends StatefulWidget {
  const ChatCorrectionSheet({
    super.key,
    required this.original,
    required this.repository,
    required this.conversationId,
  });

  final String original;
  final CrmRepository repository;
  final String conversationId;

  @override
  State<ChatCorrectionSheet> createState() => _ChatCorrectionSheetState();
}

class _ChatCorrectionSheetState extends State<ChatCorrectionSheet> {
  late final LocalReview _local = revisarTexto(widget.original);
  late String _propuesta = _local.corrected;
  List<LocalEdit> _cambios = [];
  String _iaEstado = '';
  bool _iaCargando = false;

  @override
  void initState() {
    super.initState();
    _cambios = _local.edits;
  }

  Future<void> _mejorarConIa() async {
    setState(() {
      _iaCargando = true;
      _iaEstado = '';
    });
    try {
      final resultado = await widget.repository.proofread(
        conversationId: widget.conversationId,
        text: _propuesta,
      );
      if (!mounted) return;
      setState(() {
        _iaCargando = false;
        if (!resultado.available) {
          _iaEstado = 'La IA no está configurada (Ajustes → IA). Se mantiene la revisión local.';
          return;
        }
        if (!resultado.hasChanges) {
          _iaEstado = 'La IA no encontró nada más que corregir.';
          return;
        }
        _propuesta = resultado.correctedText;
        _cambios = [
          for (final edit in resultado.edits)
            LocalEdit(kind: 'ia', before: edit.word, after: edit.replacement, reason: 'Corrección de la IA'),
        ];
        _iaEstado = 'Corregido con IA.';
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _iaCargando = false;
        _iaEstado = error.message;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sinCambios = _propuesta == widget.original;
    return AlertDialog(
      title: const Text('Corregir el mensaje'),
      content: SizedBox(
        width: 560,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Antes', style: theme.textTheme.labelMedium),
              const SizedBox(height: 4),
              _Caja(texto: widget.original, apagado: true),
              const SizedBox(height: 12),
              Text('Después', style: theme.textTheme.labelMedium),
              const SizedBox(height: 4),
              _Caja(texto: _propuesta),
              const SizedBox(height: 12),
              if (_cambios.isEmpty && sinCambios)
                Text(
                  'No encontramos errores evidentes.',
                  style: theme.textTheme.bodySmall,
                )
              else
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final cambio in _cambios.take(12))
                      Chip(
                        visualDensity: VisualDensity.compact,
                        label: Text(
                          cambio.kind == 'signos' || cambio.kind == 'espacios'
                              ? cambio.reason
                              : '${cambio.before} → ${cambio.after}',
                          style: const TextStyle(fontSize: 11.5),
                        ),
                      ),
                  ],
                ),
              if (_iaEstado.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(_iaEstado, style: theme.textTheme.bodySmall),
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancelar')),
        TextButton(
          onPressed: _iaCargando ? null : _mejorarConIa,
          child: _iaCargando
              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Mejorar con IA'),
        ),
        FilledButton(
          onPressed: sinCambios ? null : () => Navigator.pop(context, _propuesta),
          child: const Text('Usar este texto'),
        ),
      ],
    );
  }
}

class _Caja extends StatelessWidget {
  const _Caja({required this.texto, this.apagado = false});

  final String texto;
  final bool apagado;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: apagado ? 0.35 : 0.6),
        borderRadius: BorderRadius.circular(8),
      ),
      child: SelectableText(texto, style: theme.textTheme.bodyMedium),
    );
  }
}
