/// Contexto de entrada al único editor de Ventas desde una conversación.
/// El servidor vuelve a validar que la conversación pertenezca al cliente.
class PosLaunchContext {
  const PosLaunchContext({
    required this.customerId,
    required this.conversationId,
    this.mode = 'order',
  });

  final String customerId;
  final String conversationId;
  final String mode;
}
