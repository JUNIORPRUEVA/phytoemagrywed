/// Contexto de entrada al único editor de Ventas desde una conversación.
/// El servidor vuelve a validar que la conversación pertenezca al cliente.
class PosLaunchContext {
  const PosLaunchContext({
    required this.customerId,
    required this.conversationId,
    this.mode = 'order',
    this.orderId = '',
  });

  final String customerId;
  final String conversationId;
  final String mode;

  /// Pedido existente que se abre en el mismo editor de Ventas.
  final String orderId;
}
