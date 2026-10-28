import 'package:flutter/material.dart';

import '../../../app/crm_scope.dart';
import '../../../app/crm_state.dart';
import '../../../core/net/api_client.dart';
import '../../../data/models/crm_models.dart';
import '../../common/crm_ui.dart';

/// Acciones de una conversación en la bandeja de **escritorio**.
///
/// Son las MISMAS que ofrece la app móvil desde el menú del hilo
/// (`chat_screen.dart`): finalizar/reabrir, asignación y marcar como leído.
/// Se centralizan aquí para que la lista pueda ofrecerlas por fila sin duplicar
/// la lógica ni depender del estado interno del hilo.
abstract final class ConversationActions {
  /// Opciones que se muestran en el menú de cada fila.
  static List<String> options(Conversation conversation) => [
    'open',
    if (conversation.unread > 0) 'read',
    conversation.isResolved ? 'reopen' : 'resolve',
    'assign',
  ];

  static String label(String action) => switch (action) {
    'open' => 'Abrir conversación',
    'read' => 'Marcar como leído',
    'resolve' => 'Finalizar conversación',
    'reopen' => 'Reabrir conversación',
    'assign' => 'Asignación…',
    _ => action,
  };

  static IconData icon(String action) => switch (action) {
    'open' => Icons.forum_outlined,
    'read' => Icons.mark_chat_read_outlined,
    'resolve' => Icons.task_alt_rounded,
    'reopen' => Icons.restart_alt_rounded,
    'assign' => Icons.assignment_ind_outlined,
    _ => Icons.chevron_right_rounded,
  };

  /// Ejecuta la acción. Devuelve `true` si el panel debe refrescarse.
  static Future<bool> run(
    BuildContext context,
    String action,
    Conversation conversation,
  ) async {
    final state = CrmScope.of(context, listen: false);
    final repository = state.repository;
    switch (action) {
      case 'read':
        try {
          await repository.markRead(conversation.id);
          if (context.mounted) crmToast(context, 'Conversación marcada como leída.');
          return true;
        } on ApiException catch (error) {
          if (context.mounted) crmToast(context, error.message);
          return false;
        }
      case 'resolve':
      case 'reopen':
        final resolved = action == 'resolve';
        try {
          await repository.setResolved(conversation.id, resolved);
          if (context.mounted) {
            crmToast(context, resolved ? 'Conversación finalizada.' : 'Conversación reabierta.');
          }
          return true;
        } on ApiException catch (error) {
          if (!context.mounted) return false;
          if (error.statusCode == 0) {
            await state.enqueueResolved(conversation.id, resolved: resolved);
            if (context.mounted) crmToast(context, 'Sin conexión: se aplicará cuando vuelva la red.');
            return true;
          }
          crmToast(context, error.message);
          return false;
        }
      case 'assign':
        final changed = await _assignment(context, state, conversation.id);
        return changed;
      default:
        return false;
    }
  }

  /// Hoja de asignación: las mismas opciones del hilo móvil.
  static Future<bool> _assignment(
    BuildContext context,
    CrmState state,
    String conversationId,
  ) async {
    final session = state.session;
    final action = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.front_hand_outlined),
              title: const Text('Pedir que me la asignen'),
              subtitle: const Text('El pedido llega a administración'),
              onTap: () => Navigator.pop(sheetContext, 'request'),
            ),
            if (session.can('chats.take_unassigned'))
              ListTile(
                leading: const Icon(Icons.person_add_alt_rounded),
                title: const Text('Ponerme al frente'),
                onTap: () => Navigator.pop(sheetContext, 'take'),
              ),
            ListTile(
              leading: const Icon(Icons.lock_open_rounded),
              title: const Text('Liberar conversación'),
              onTap: () => Navigator.pop(sheetContext, 'release'),
            ),
            if (session.can('admin.full'))
              ListTile(
                leading: const Icon(Icons.assignment_ind_outlined),
                title: const Text('Asignar a un compañero…'),
                onTap: () => Navigator.pop(sheetContext, 'assign'),
              ),
          ],
        ),
      ),
    );
    if (action == null || !context.mounted) return false;
    try {
      switch (action) {
        case 'request':
          await state.repository.requestConversationAssignment(conversationId);
          if (context.mounted) crmToast(context, 'Pedido enviado a administración.');
          return false;
        case 'take':
        case 'release':
          await state.repository.assignConversation(conversationId, action: action);
          if (context.mounted) {
            crmToast(context, action == 'take' ? 'Conversación tomada.' : 'Conversación liberada.');
          }
          return true;
        case 'assign':
          final users = await state.repository.assignableUsers();
          if (!context.mounted) return false;
          final picked = await showModalBottomSheet<Map<String, dynamic>>(
            context: context,
            showDragHandle: true,
            isScrollControlled: true,
            builder: (sheetContext) => SafeArea(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final user in users)
                    ListTile(
                      leading: CrmAvatar(
                        label: str(user['display_name'], str(user['username'])),
                      ),
                      title: Text(str(user['display_name'], str(user['username'], 'Usuario'))),
                      subtitle: Text(str(user['role'])),
                      onTap: () => Navigator.pop(sheetContext, user),
                    ),
                ],
              ),
            ),
          );
          if (picked == null || !context.mounted) return false;
          await state.repository.assignConversation(
            conversationId,
            action: 'assign',
            userId: str(picked['id']),
          );
          if (context.mounted) crmToast(context, 'Conversación asignada.');
          return true;
      }
    } on ApiException catch (error) {
      if (context.mounted) crmToast(context, error.message);
    }
    return false;
  }
}

/// Diálogo «Nuevo mensaje»: crea (o recupera) el cliente por teléfono y abre su
/// conversación, igual que hace el panel PWA con `POST /conversations/start`.
///
/// Devuelve el `id` de la conversación abierta, o `null` si se canceló.
Future<String?> showNewConversationDialog(BuildContext context) async {
  final state = CrmScope.of(context, listen: false);
  final phoneController = TextEditingController();
  final nameController = TextEditingController();
  final bodyController = TextEditingController();
  final formKey = GlobalKey<FormState>();
  var saving = false;
  String? error;

  final result = await showDialog<String>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (dialogContext, setDialogState) {
        Future<void> submit() async {
          if (saving) return;
          if (!(formKey.currentState?.validate() ?? false)) return;
          setDialogState(() {
            saving = true;
            error = null;
          });
          try {
            final data = await state.repository.startConversation(
              phone: phoneController.text.trim(),
              name: nameController.text.trim(),
              body: bodyController.text.trim(),
            );
            final conversation = mapv(data['conversation']);
            final id = str(conversation['id']);
            if (id.isEmpty) {
              throw ApiException(500, 'El servidor no devolvió la conversación.');
            }
            if (dialogContext.mounted) Navigator.pop(dialogContext, id);
          } on ApiException catch (e) {
            if (!dialogContext.mounted) return;
            setDialogState(() {
              saving = false;
              error = e.message;
            });
          }
        }

        return AlertDialog(
          title: const Text('Nuevo mensaje'),
          content: SizedBox(
            width: 380,
            child: Form(
              key: formKey,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  TextFormField(
                    controller: phoneController,
                    autofocus: true,
                    keyboardType: TextInputType.phone,
                    decoration: const InputDecoration(
                      labelText: 'Teléfono',
                      hintText: '+18095551010',
                    ),
                    validator: (value) =>
                        (value ?? '').replaceAll(RegExp(r'[^0-9]'), '').length < 7
                        ? 'Escribe el teléfono del cliente.'
                        : null,
                  ),
                  const SizedBox(height: 10),
                  TextFormField(
                    controller: nameController,
                    textCapitalization: TextCapitalization.words,
                    decoration: const InputDecoration(
                      labelText: 'Nombre (opcional)',
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextFormField(
                    controller: bodyController,
                    minLines: 2,
                    maxLines: 4,
                    maxLength: 1200,
                    decoration: const InputDecoration(
                      labelText: 'Primer mensaje (opcional)',
                      hintText: 'Hola, te escribimos de FullTECH…',
                    ),
                  ),
                  if (error != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        error!,
                        style: TextStyle(
                          fontSize: 12,
                          color: Theme.of(dialogContext).colorScheme.error,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: saving ? null : () => Navigator.pop(dialogContext),
              child: const Text('Cancelar'),
            ),
            FilledButton(
              onPressed: saving ? null : submit,
              child: saving
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Abrir chat'),
            ),
          ],
        );
      },
    ),
  );
  phoneController.dispose();
  nameController.dispose();
  bodyController.dispose();
  return result;
}
