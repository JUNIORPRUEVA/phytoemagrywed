import 'package:flutter/material.dart';

import '../../../app/crm_scope.dart';
import '../../../data/crm_repository.dart';

/// Asistente IA CONTEXTUAL del chat (el «Centro IA» del panel web).
///
/// Reutiliza `POST /api/admin/assistant/query`: la misma ruta que usa la PWA,
/// con la misma autorización (`chats.reply` + regla de dueño de la
/// conversación). La ruta es de SOLO LECTURA:
///
/// · devuelve `answer`, `bullets`, `suggestions`, `draft` y `sources`;
/// · el borrador NO se envía ni se guarda: se copia al compositor y la persona
///   decide si lo manda;
/// · cuando la consulta prepara una operación (crear pedido, actualizar
///   cliente…), llega `proposal` y hay que **confirmarla** aquí: el servidor
///   vuelve a comprobar permiso y estado antes de ejecutar.
class ChatAssistantSheet extends StatefulWidget {
  const ChatAssistantSheet({
    super.key,
    required this.conversationId,
    this.customerName = '',
    this.onUseDraft,
    this.repository,
  });

  final String conversationId;
  final String customerName;

  /// Inserta el borrador en el compositor (nunca envía).
  final ValueChanged<String>? onUseDraft;

  /// Repositorio ya construido. Solo lo usan las pruebas: en la app se toma
  /// del `CrmScope`, para heredar sesión, permisos y cliente HTTP reales.
  final CrmRepository? repository;

  @override
  State<ChatAssistantSheet> createState() => _ChatAssistantSheetState();
}

/// Acciones que acepta el servidor (`ASSISTANT_ACTIONS`).
const List<(String, String)> _acciones = [
  ('draft_reply', 'Redactar respuesta'),
  ('analyze_customer', 'Analizar cliente'),
  ('orders', 'Pedidos'),
  ('templates', 'Plantillas'),
  ('next_action', 'Siguiente paso'),
  ('free', 'Preguntar'),
];

String _motivoSinIa(String reason) => switch (reason) {
      'ai_unavailable' => 'La IA no está configurada ahora mismo.',
      'invalid_response' => 'La IA respondió algo que no se pudo usar.',
      'provider_error' => 'El proveedor de IA falló. Puedes escribir el mensaje a mano.',
      _ => 'La IA no está disponible ahora mismo.',
    };

class _ChatAssistantSheetState extends State<ChatAssistantSheet> {
  String _accion = 'draft_reply';
  final _pregunta = TextEditingController();
  bool _cargando = false;
  String _error = '';
  Map<String, dynamic>? _resultado;
  String _decision = '';

  @override
  void dispose() {
    _pregunta.dispose();
    super.dispose();
  }

  Future<void> _consultar() async {
    if (_cargando) return;
    setState(() {
      _cargando = true;
      _error = '';
      _decision = '';
    });
    try {
      final repo = widget.repository ?? CrmScope.of(context, listen: false).repository;
      final data = await repo.assistantQuery(
        conversationId: widget.conversationId,
        action: _accion,
        message: _accion == 'free' ? _pregunta.text.trim() : '',
      );
      if (!mounted) return;
      setState(() => _resultado = data);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = 'No se pudo consultar al asistente. Revisa la conexión.';
        _resultado = null;
      });
      debugPrint('asistente: $error');
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _decidir(Map<String, dynamic> proposal, bool confirmar) async {
    if (_cargando) return;
    final id = '${proposal['id'] ?? ''}';
    if (id.isEmpty) {
      setState(() => _error = 'La propuesta no trae identificador: no se puede confirmar.');
      return;
    }
    setState(() {
      _cargando = true;
      _error = '';
    });
    try {
      final repo = widget.repository ?? CrmScope.of(context, listen: false).repository;
      final data = await repo.assistantDecision(
        proposalId: id,
        confirm: confirmar,
        fingerprint: '${proposal['fingerprint'] ?? ''}',
      );
      if (!mounted) return;
      setState(() {
        _decision = confirmar
            ? (data['ok'] == true ? 'Operación confirmada y aplicada.' : 'El servidor no aplicó la operación.')
            : 'Propuesta descartada.';
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = 'No se pudo completar la decisión. Puede que ya no esté vigente.');
      debugPrint('asistente decisión: $error');
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final datos = _resultado;
    final iaOk = datos != null && datos['ai'] == true;
    final draft = datos == null ? '' : '${datos['draft'] ?? ''}';
    final bullets = datos == null ? const <String>[] : [for (final row in (datos['bullets'] as List? ?? const [])) '$row'];
    final sugerencias =
        datos == null ? const <String>[] : [for (final row in (datos['suggestions'] as List? ?? const [])) '$row'];
    final fuentes = datos == null ? const <String>[] : [for (final row in (datos['sources'] as List? ?? const [])) '${(row as Map)['label'] ?? ''}'];
    final motivo = datos == null ? '' : '${datos['reason'] ?? ''}';
    final proposal = datos?['proposal'] is Map ? datos!['proposal'] as Map : null;

    return AlertDialog(
      title: Row(
        children: [
          const Icon(Icons.auto_awesome_outlined, size: 20),
          const SizedBox(width: 8),
          Expanded(child: Text('Asistente IA${widget.customerName.isEmpty ? '' : ' · ${widget.customerName}'}')),
        ],
      ),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('Solo lectura: mira este chat y el expediente. No envía nada.',
                  style: TextStyle(fontSize: 12)),
              const SizedBox(height: 10),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final (clave, etiqueta) in _acciones)
                    ChoiceChip(
                      label: Text(etiqueta, style: const TextStyle(fontSize: 12)),
                      selected: _accion == clave,
                      onSelected: (_) => setState(() {
                        _accion = clave;
                        _resultado = null;
                        _error = '';
                        _decision = '';
                      }),
                    ),
                ],
              ),
              if (_accion == 'free') ...[
                const SizedBox(height: 10),
                TextField(
                  controller: _pregunta,
                  maxLength: 600,
                  decoration: const InputDecoration(
                    labelText: '¿Qué quieres saber de este cliente?',
                    hintText: 'Ej.: ¿qué le falta para cerrar el pedido?',
                  ),
                ),
              ],
              const SizedBox(height: 6),
              Row(
                children: [
                  FilledButton.icon(
                    onPressed: _cargando ? null : _consultar,
                    icon: const Icon(Icons.send_outlined, size: 16),
                    label: Text(_cargando ? 'Consultando…' : 'Consultar'),
                  ),
                  const SizedBox(width: 8),
                  if (_cargando) const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                ],
              ),
              if (_error.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(_error, style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.error)),
              ],
              if (_decision.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(_decision, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
              ],
              if (datos != null) ...[
                const Divider(height: 20),
                if (!iaOk)
                  Text(_motivoSinIa(motivo), style: const TextStyle(fontSize: 13))
                else ...[
                  if ('${datos['answer'] ?? ''}'.isNotEmpty) Text('${datos['answer']}', style: const TextStyle(fontSize: 13)),
                  if (bullets.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    for (final row in bullets) Text('• $row', style: const TextStyle(fontSize: 12.5)),
                  ],
                  if (sugerencias.isNotEmpty) ...[
                    const SizedBox(height: 10),
                    const Text('Sugerencias', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
                    for (final row in sugerencias)
                      InkWell(
                        onTap: widget.onUseDraft == null
                            ? null
                            : () {
                                widget.onUseDraft!(row);
                                Navigator.of(context).pop();
                              },
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 4),
                          child: Text('· $row', style: const TextStyle(fontSize: 12.5)),
                        ),
                      ),
                  ],
                  if (draft.isNotEmpty) ...[
                    const SizedBox(height: 10),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Borrador (no enviado)', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700)),
                          const SizedBox(height: 4),
                          Text(draft, style: const TextStyle(fontSize: 13)),
                          const SizedBox(height: 6),
                          Align(
                            alignment: Alignment.centerRight,
                            child: TextButton(
                              onPressed: widget.onUseDraft == null
                                  ? null
                                  : () {
                                      widget.onUseDraft!(draft);
                                      Navigator.of(context).pop();
                                    },
                              child: const Text('Usar en el mensaje'),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                  if (fuentes.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        for (final row in fuentes)
                          Chip(
                            visualDensity: VisualDensity.compact,
                            label: Text(row, style: const TextStyle(fontSize: 10.5)),
                          ),
                      ],
                    ),
                  ],
                ],
                if (proposal != null) ...[
                  const SizedBox(height: 10),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      border: Border.all(color: Theme.of(context).colorScheme.primary),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'El asistente preparó una operación${'${proposal['label'] ?? proposal['action'] ?? ''}'.isEmpty ? '' : ': ${proposal['label'] ?? proposal['action']}'}',
                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700),
                        ),
                        const SizedBox(height: 4),
                        const Text('No se ha ejecutado. Confírmala tú.', style: TextStyle(fontSize: 11.5)),
                        const SizedBox(height: 6),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.end,
                          children: [
                            TextButton(
                              onPressed: _cargando ? null : () => _decidir(Map<String, dynamic>.from(proposal), false),
                              child: const Text('Descartar'),
                            ),
                            const SizedBox(width: 6),
                            FilledButton(
                              onPressed: _cargando ? null : () => _decidir(Map<String, dynamic>.from(proposal), true),
                              child: const Text('Confirmar'),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
                if (datos['proposalError'] is Map) ...[
                  const SizedBox(height: 8),
                  Text(
                    'No se pudo preparar la operación: ${(datos['proposalError'] as Map)['message'] ?? (datos['proposalError'] as Map)['error'] ?? ''}',
                    style: const TextStyle(fontSize: 12),
                  ),
                ],
              ],
            ],
          ),
        ),
      ),
      actions: [TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cerrar'))],
    );
  }
}
