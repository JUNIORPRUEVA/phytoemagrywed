import '../core/net/api_client.dart';
import 'models/crm_models.dart';

/// Un único punto por el que sale todo lo que pide la app. Las rutas son las
/// MISMAS del panel web (`/api/admin/...`), así que la PWA no cambia.
class CrmRepository {
  CrmRepository(this._api);

  final ApiClient _api;

  ApiClient get api => _api;

  // ------------------------------------------------------------------ sesión
  Future<void> restore() => _api.restoreSession();

  Future<CrmSession> session() async {
    final data = await _api.get('/api/admin/session');
    if (data['ok'] == false) throw ApiException(401, 'Sesión no válida.');
    return CrmSession.fromJson(data);
  }

  Future<CrmSession> login({required String username, required String password}) async {
    final data = await _api.post('/api/admin/auth/login', {
      'username': username.trim(),
      'password': password,
    });
    final auth = data['auth'] is Map ? mapv(data['auth']) : data;
    final parsed = CrmSession.fromJson({
      ...auth,
      if (data['user'] != null) 'user': data['user'],
      'permissions': auth['permissions'] ?? data['permissions'],
    });
    // El servidor devuelve el usuario pero no siempre los permisos: se piden.
    if (!parsed.authenticated) throw ApiException(401, 'Usuario o contraseña incorrectos.');
    return parsed.user == null ? session() : parsed;
  }

  Future<void> logout() async {
    try {
      await _api.post('/api/admin/auth/logout', const {});
    } catch (_) {
      // Si el servidor no responde, la sesión local se borra igual.
    }
    await _api.clearSession();
  }

  // ---------------------------------------------------------------- snapshot
  /// Paquete ligero del panel: pedidos, clientes, bandeja, recuentos,
  /// seguimientos, entregas y avisos en UNA petición.
  Future<Map<String, dynamic>> snapshot({bool light = true}) async {
    final data = await _api.get('/api/admin/data', query: {if (light) 'light': '1'});
    if (data['ok'] == false) throw ApiException(401, 'Sesión no válida.');
    return data;
  }

  // ------------------------------------------------------------------- chats
  Future<Map<String, dynamic>> conversations({String filter = 'todos', String query = '', String sort = 'recent', String stage = ''}) =>
      _api.get('/api/admin/conversations', query: {
        'filter': filter,
        'q': query,
        'sort': sort,
        'stage': stage,
      });

  Future<List<ChatMessage>> messages(String conversationId) async {
    final data = await _api.get('/api/admin/conversations/${Uri.encodeComponent(conversationId)}/messages');
    return listv(data['messages'] ?? data['items']).map(ChatMessage.fromJson).toList();
  }

  /// Abre (o crea) la conversación de un teléfono y, si se indica, envía el
  /// primer mensaje. Es la misma ruta que usa el panel PWA.
  Future<Map<String, dynamic>> startConversation({
    required String phone,
    String name = '',
    String body = '',
  }) =>
      _api.post('/api/admin/conversations/start', {
        'phone': phone,
        'name': name,
        'body': body,
      });

  Future<void> sendMessage(String conversationId, String body, {String? operationKey}) =>
      _api.post(
        '/api/admin/conversations/${Uri.encodeComponent(conversationId)}/messages',
        {'body': body},
        operationKey: operationKey,
      );

  Future<void> markRead(String conversationId) =>
      _api.post('/api/admin/conversations/${Uri.encodeComponent(conversationId)}/read', const {});

  /// IA: corrige la ortografía del texto que se está escribiendo.
  /// Devuelve la propuesta; **nunca** envía nada (la decisión es del agente).
  Future<String> proofread({
    required String conversationId,
    required String text,
  }) async {
    final data = await _api.post('/api/admin/proofreading', {
      'conversationId': conversationId,
      'text': text,
    });
    return str(data['suggestion']);
  }

  /// IA: propone una respuesta para el hilo (tampoco la envía).
  Future<String> replySuggestion(String conversationId) async {
    final data = await _api.post('/api/admin/ai/reply-suggestion', {
      'conversationId': conversationId,
    });
    return str(data['suggestion']);
  }

  /// Archiva (sale de la bandeja) o desarchiva una conversación.
  Future<void> archiveConversation(String conversationId, bool archived) =>
      _api.post(
        '/api/admin/conversations/${Uri.encodeComponent(conversationId)}/${archived ? 'archive' : 'unarchive'}',
        const {},
      );

  /// Acción en lote sobre varias conversaciones.
  /// `mark_read` | `resolve` | `archive` | `unarchive`.
  Future<Map<String, dynamic>> bulkConversations(List<String> ids, String action) =>
      _api.post('/api/admin/conversations/bulk', {'ids': ids, 'action': action});

  Future<void> setResolved(String conversationId, bool resolved, {String? operationKey}) =>
      _api.post(
        '/api/admin/conversations/${Uri.encodeComponent(conversationId)}/${resolved ? 'resolve' : 'reopen'}',
        const {},
        operationKey: operationKey,
      );

  // ------------------------------------------------------- multimedia del hilo
  /// Sube una foto, un PDF o una nota de voz a la conversación.
  ///
  /// Contrato real: bytes crudos + `?kind=image|audio|document&caption=&key=`
  /// (`server/media-routes.mjs`). El servidor decide el tipo por el contenido.
  Future<Map<String, dynamic>> sendMedia(
    String conversationId, {
    required List<int> bytes,
    required String kind,
    String? filename,
    String? caption,
    String? operationKey,
  }) =>
      _api.postBytes(
        '/api/admin/conversations/${Uri.encodeComponent(conversationId)}/media',
        bytes,
        contentType: _contentTypeFor(filename, kind),
        filename: filename,
        query: {'kind': kind, 'caption': ?caption, 'key': ?operationKey},
        operationKey: operationKey,
      );

  static String _contentTypeFor(String? filename, String kind) {
    final name = (filename ?? '').toLowerCase();
    if (name.endsWith('.pdf')) return 'application/pdf';
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.webp')) return 'image/webp';
    if (name.endsWith('.m4a') || name.endsWith('.mp4')) return 'audio/mp4';
    if (name.endsWith('.ogg') || name.endsWith('.opus')) return 'audio/ogg';
    if (name.endsWith('.mp3')) return 'audio/mpeg';
    if (name.endsWith('.aac')) return 'audio/aac';
    if (name.endsWith('.wav')) return 'audio/wav';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
    return switch (kind) {
      'audio' => 'audio/mp4',
      'document' => 'application/pdf',
      _ => 'image/jpeg',
    };
  }

  /// Bytes de un adjunto del hilo (necesita sesión: nunca hay URL pública).
  Future<ApiFile> mediaBytes(String mediaId) =>
      _api.getFile('/api/admin/media/${Uri.encodeComponent(mediaId)}', fallbackName: 'adjunto');

  /// Envía una plantilla aprobada (necesario fuera de la ventana de 24 h).
  Future<Map<String, dynamic>> sendTemplate(
    String conversationId,
    String name, {
    String? operationKey,
    Map<String, dynamic>? values,
  }) =>
      _api.post(
        '/api/admin/conversations/${Uri.encodeComponent(conversationId)}/messages',
        {'template': name, 'templateValues': ?values},
        operationKey: operationKey,
      );

  /// Envía una ubicación guardada del negocio a la conversación.
  Future<Map<String, dynamic>> sendLocation(
    String conversationId, {
    required String locationId,
    required String operationKey,
  }) =>
      _api.post(
        '/api/admin/conversations/${Uri.encodeComponent(conversationId)}/location',
        {'locationId': locationId, 'confirmed': true, 'idempotencyKey': operationKey},
        operationKey: operationKey,
      );

  /// Ubicaciones, bancos y catálogos que el negocio comparte en el chat.
  Future<Map<String, dynamic>> chatSharing() => _api.get('/api/admin/chat-sharing');

  /// Plantillas de WhatsApp aprobadas (para escribir fuera de la ventana de 24 h).
  Future<List<Map<String, dynamic>>> waTemplates({bool onlyApproved = true}) async {
    final data = await _api.get('/api/admin/wa-templates', query: {'sync': 'stale'});
    final rows = listv(data['templates']);
    if (!onlyApproved) return rows;
    return rows.where((row) => str(row['status'], 'APPROVED').toUpperCase() == 'APPROVED').toList();
  }

  /// Asignación de la conversación: `take` (ponerse al frente), `release` (soltarla)
  /// o `assign` (solo administración).
  Future<Map<String, dynamic>> assignConversation(String conversationId, {String action = 'take', String? userId}) =>
      _api.post(
        '/api/admin/conversations/${Uri.encodeComponent(conversationId)}/$action',
        {'userId': ?userId},
      );

  /// Un agente pide que le asignen la conversación (no se la toma solo).
  Future<Map<String, dynamic>> requestConversationAssignment(String conversationId, {String? note}) =>
      _api.post(
        '/api/admin/conversations/${Uri.encodeComponent(conversationId)}/assignment-request',
        {'note': ?note},
      );

  /// Agentes y administradores activos, para asignar conversaciones.
  Future<List<Map<String, dynamic>>> assignableUsers() async {
    final rows = await users();
    return rows
        .where((row) => boolv(row['active'], true))
        .where((row) => const {'ADMIN', 'AGENT', 'OPERADOR', 'SUPERVISOR'}.contains(str(row['role']).toUpperCase()))
        .toList();
  }

  /// Estado en el servidor de una lista de claves de operación.
  ///
  /// `estado` es `completada`, `en_proceso` o `no_recibida`. No ejecuta nada.
  Future<Map<String, String>> operationStatuses(List<String> keys) async {
    if (keys.isEmpty) return const {};
    final data = await _api.post('/api/admin/offline-operations/status', {'ids': keys});
    final rows = listv(data['estados']);
    return {
      for (final row in rows)
        if (str(row['key']).isNotEmpty) str(row['key']): str(row['estado']),
    };
  }

  // ---------------------------------------------------------------- clientes
  Future<List<Customer>> customers({String query = ''}) async {
    final data = await _api.get('/api/admin/customers', query: {'q': query});
    return listv(data['customers']).map(Customer.fromJson).toList();
  }

  Future<Map<String, dynamic>> customer(String id) =>
      _api.get('/api/admin/customers/${Uri.encodeComponent(id)}');

  // ------------------------------------------------------------------ pedidos
  Future<Map<String, dynamic>> order(String id) =>
      _api.get('/api/admin/orders/${Uri.encodeComponent(id)}');

  /// Cambio de estado manual (solo ADMIN: `orders.change_status`).
  Future<Map<String, dynamic>> changeOrderStatus(String id, String status, {String? expectedStatus, String? reason}) =>
      _api.patch('/api/admin/orders/${Uri.encodeComponent(id)}/status', {
        'status': status,
        'expectedStatus': ?expectedStatus,
        'reason': ?reason,
      });

  /// Confirmar: el paso entre «creado» y «en reparto» (no cobra ni entrega).
  Future<Map<String, dynamic>> confirmOrder(String id, {String? deliveryNote, String? fulfillment}) =>
      _api.post('/api/admin/orders/${Uri.encodeComponent(id)}/confirm', {
        'deliveryNote': ?deliveryNote,
        'fulfillment': ?fulfillment,
      });

  /// Finalizar (pasar a entregado) sin necesitar ADMIN.
  Future<Map<String, dynamic>> finishOrder(String id, {String? reason}) =>
      _api.post('/api/admin/orders/${Uri.encodeComponent(id)}/finish', {
        'reason': ?reason,
      });

  /// Asignar repartidor del equipo (solo ADMIN).
  Future<Map<String, dynamic>> assignDelivery(String id, {String? deliveryUserId, String? deliveryNote}) =>
      _api.post('/api/admin/orders/${Uri.encodeComponent(id)}/delivery/assign', {
        'deliveryUserId': ?deliveryUserId,
        'deliveryNote': ?deliveryNote,
      });

  /// Crear un pedido (mismo contrato que usa el POS: líneas, cliente, cobro).
  Future<Map<String, dynamic>> createOrder(Map<String, dynamic> body, {String? operationKey}) =>
      _api.post('/api/admin/orders', body, operationKey: operationKey);

  /// Editar líneas, descuento, envío o notas. El servidor recalcula el total.
  ///
  /// Un pedido con reservas de Smart Commerce responde 409 `managed_order_locked`:
  /// se cancela y se recotiza, no se edita por partes.
  Future<Map<String, dynamic>> updateOrder(
    String id, {
    List<Map<String, dynamic>>? items,
    double? discount,
    double? deliveryFee,
    String? notes,
    String? deliveryLocationId,
    String? operationKey,
  }) =>
      _api.patch('/api/admin/orders/${Uri.encodeComponent(id)}', {
        'items': ?items,
        'discount': ?discount,
        'deliveryFee': ?deliveryFee,
        'notes': ?notes,
        if (deliveryLocationId != null) 'deliveryLocation': {'id': deliveryLocationId},
      }, operationKey: operationKey);

  /// Cancelar una VENTA ENTREGADA (`sales.cancel`): restaura inventario, anula el
  /// pago y deja el motivo en el historial. Para pedidos no entregados se cambia
  /// el estado a `cancelado` con [changeOrderStatus].
  Future<Map<String, dynamic>> cancelDeliveredSale(String id, {required String reason, String? operationKey}) =>
      _api.post(
        '/api/admin/orders/${Uri.encodeComponent(id)}/cancel',
        {'reason': reason},
        operationKey: operationKey,
      );

  /// Borrar un pedido cronológico: el servidor lo niega (409) si ya tiene
  /// historial comercial; en ese caso hay que cancelar.
  Future<Map<String, dynamic>> deleteOrder(String id) =>
      _api.delete('/api/admin/orders/${Uri.encodeComponent(id)}');

  /// Reparto EXTERNO (mensajería): el teléfono lo decide una persona.
  /// Con `autoSend` el servidor asigna y envía de una vez (idempotente).
  Future<Map<String, dynamic>> assignExternalCourier(
    String id, {
    required String contactPhone,
    bool autoSend = false,
  }) =>
      _api.post('/api/admin/orders/${Uri.encodeComponent(id)}/courier/assign', {
        'contactPhone': contactPhone,
        'autoSend': autoSend,
      });

  /// Reenviar el pedido al repartidor externo ya asignado.
  Future<Map<String, dynamic>> sendToExternalCourier(String id) =>
      _api.post('/api/admin/orders/${Uri.encodeComponent(id)}/courier/send', const {});

  /// Incidencia de entrega. El motivo sale del catálogo del servidor
  /// (`DELIVERY_ISSUE_REASONS`); solo una abierta a la vez.
  Future<Map<String, dynamic>> reportDeliveryIssue(String id, {required String reason, String? note}) =>
      _api.post('/api/admin/orders/${Uri.encodeComponent(id)}/delivery/issue', {
        'reason': reason,
        'note': ?note,
      });

  /// Resolver la incidencia (solo administración): `resume` o `cancel` + nota.
  Future<Map<String, dynamic>> resolveDeliveryIssue(String id, {required String action, required String note}) =>
      _api.post('/api/admin/orders/${Uri.encodeComponent(id)}/delivery/issue/resolve', {
        'action': action,
        'note': note,
      });

  /// Confirmación ADMINISTRATIVA de una entrega sin prueba en el teléfono.
  /// Solo `admin.full`: es la firma que sustituye a la evidencia del repartidor.
  Future<Map<String, dynamic>> confirmDeliveryByAdmin(String id) =>
      _api.post('/api/admin/orders/${Uri.encodeComponent(id)}/delivery/confirm', const {});

  /// Enviar la factura (PDF) por WhatsApp con la plantilla oficial.
  /// El idempotencyKey evita que dos toques manden dos facturas.
  Future<Map<String, dynamic>> sendInvoiceWhatsapp(String id, {String? operationKey}) =>
      _api.post(
        '/api/admin/orders/${Uri.encodeComponent(id)}/invoice-whatsapp',
        {'idempotencyKey': ?operationKey},
        operationKey: operationKey,
      );

  /// Vista previa de la factura por WhatsApp: NO envía nada.
  Future<Map<String, dynamic>> invoiceWhatsappPreview(String id) =>
      _api.get('/api/admin/orders/${Uri.encodeComponent(id)}/invoice-whatsapp');

  /// Anotar un cobro. Es un acto aparte de entregar: el pedido puede estar
  /// entregado y seguir «por cobrar», que es la verdad.
  ///
  /// `expectedDue` es el saldo que el usuario vio: si cambió, el servidor
  /// responde 409 `payment_conflict` en vez de cobrar sobre un saldo viejo.
  Future<Map<String, dynamic>> registerPayment(
    String id, {
    required double amount,
    required String method,
    required String operationKey,
    double? expectedDue,
    String? note,
    String? evidenceUrl,
  }) =>
      _api.post('/api/admin/orders/${Uri.encodeComponent(id)}/payments', {
        'amount': amount,
        'method': method,
        'expectedDue': ?expectedDue,
        'note': ?note,
        // Referencia del comprobante (nº de transferencia, captura en Drive…).
        // El servidor la guarda con el cobro; nunca se sube aquí un archivo.
        'evidenceUrl': ?evidenceUrl,
        'idempotencyKey': operationKey,
      }, operationKey: operationKey);

  /// Verificar o rechazar un cobro declarado (solo ADMIN). Rechazar no borra:
  /// marca, para no perder la trazabilidad.
  Future<Map<String, dynamic>> verifyPayment(
    String orderId,
    String paymentId, {
    required String decision,
    String? note,
  }) =>
      _api.post(
        '/api/admin/orders/${Uri.encodeComponent(orderId)}/payments/${Uri.encodeComponent(paymentId)}/verify',
        {'decision': decision, 'note': ?note},
      );

  /// Rendir el efectivo que lleva el repartidor en ESTE pedido (solo ADMIN).
  /// No es un cobro: el cliente ya pagó, esto dice dónde está el dinero.
  Future<Map<String, dynamic>> registerHandover(
    String orderId, {
    required double amount,
    required String operationKey,
    double? expectedPending,
    String? note,
  }) =>
      _api.post(
        '/api/admin/orders/${Uri.encodeComponent(orderId)}/payments/handover',
        {'amount': amount, 'expectedPending': ?expectedPending, 'note': ?note, 'idempotencyKey': operationKey},
      );

  /// Candidatos para reparto (los mismos que usa el POS del panel).
  Future<List<Map<String, dynamic>>> assignees() async {
    final data = await _api.get('/api/admin/pos/assignees');
    return listv(data['assignees'] ?? data['users'] ?? data['items']);
  }

  /// Factura en PDF del pedido, descargada con la sesión del panel.
  Future<ApiFile> orderReceiptFile(String id) =>
      _api.getFile('/api/admin/orders/${Uri.encodeComponent(id)}/factura', fallbackName: 'factura-$id.pdf');

  /// Pedidos paginados con el cursor del servidor (`GET /api/admin/orders`).
  /// Devuelve el paquete de la página y el cursor siguiente (null = no hay más).
  Future<({List<Map<String, dynamic>> orders, String? nextCursor, int total})> ordersPage({
    int limit = 100,
    String? cursor,
  }) async {
    final data = await _api.get('/api/admin/orders', query: {'limit': '$limit', 'cursor': ?cursor});
    return (
      orders: listv(data['orders'] ?? data['items']),
      nextCursor: str(data['nextCursor']).isEmpty ? null : str(data['nextCursor']),
      total: intv(data['total']),
    );
  }


  /// Anotar un cobro (versión antigua, mantenida por compatibilidad interna).
  Future<Map<String, dynamic>> registerPaymentLegacy(
    String id, {
    required double amount,
    required String method,
    String? note,
    String? idempotencyKey,
  }) =>
      registerPayment(
        id,
        amount: amount,
        method: method,
        note: note,
        operationKey: idempotencyKey ?? 'app-${DateTime.now().microsecondsSinceEpoch}',
      );

  // ---------------------------------------------------------------- POS / ventas
  Future<Map<String, dynamic>> posContext(String customerId) =>
      _api.get('/api/admin/pos/context/${Uri.encodeComponent(customerId)}');

  Future<List<Map<String, dynamic>>> posTickets() async {
    final data = await _api.get('/api/admin/pos/tickets');
    return listv(data['tickets'] ?? data['items']);
  }

  /// Cobrar/emitir. `body` se construye en `pos_screen.dart` con el contrato del
  /// servidor (`requestId`, `items`, `customerId`, `paymentMethod`, `mode`…).
  Future<Map<String, dynamic>> posCheckout(Map<String, dynamic> body, {String? operationKey}) =>
      _api.post('/api/admin/pos/checkout', body, operationKey: operationKey);

  Future<Map<String, dynamic>> posQuote(Map<String, dynamic> body, {String? operationKey}) =>
      _api.post('/api/admin/pos/quotes', body, operationKey: operationKey);

  Future<ApiFile> quoteFile(String quoteId) =>
      _api.getFile('/api/admin/pos/quotes/${Uri.encodeComponent(quoteId)}/pdf', fallbackName: 'cotizacion-$quoteId');

  /// Envía la cotización por WhatsApp con la plantilla oficial (no abre wa.me).
  Future<Map<String, dynamic>> sendQuoteWhatsapp(String quoteId) =>
      _api.post('/api/admin/pos/quotes/${Uri.encodeComponent(quoteId)}/send-whatsapp', const {});

  // ------------------------------------------------------ catálogo e inventario
  Future<Map<String, dynamic>> catalog() => _api.get('/api/admin/catalog');

  Future<Map<String, dynamic>> inventory() => _api.get('/api/admin/inventory');

  /// Expediente de una solicitud: documentos, requeridos y qué falta.
  Future<Map<String, dynamic>> courierDocuments(String applicationId) =>
      _api.get('/api/admin/courier-applications/${Uri.encodeComponent(applicationId)}/documents');

  Future<Map<String, dynamic>> reviewCourierApplication(
    String applicationId, {
    required String decision,
    required String companyId,
    String? note,
  }) =>
      _api.post('/api/admin/courier-applications/${Uri.encodeComponent(applicationId)}/review', {
        'decision': decision,
        'companyId': companyId,
        'note': ?note,
      });

  Future<Map<String, dynamic>> reviewCourierDocument(String documentId, {required String decision, String? note}) =>
      _api.post('/api/admin/courier-documents/${Uri.encodeComponent(documentId)}/review', {
        'decision': decision,
        'note': ?note,
      });

  Future<ApiFile> courierDocumentFile(String documentId) =>
      _api.getFile('/api/admin/courier-documents/${Uri.encodeComponent(documentId)}/file', fallbackName: 'documento-$documentId');

  Future<Map<String, dynamic>> reconciliation() => _api.get('/api/admin/inventory/reconcile');

  // ------------------------------------------------------------------ métricas
  Future<Map<String, dynamic>> metrics(String period) =>
      _api.get('/api/admin/metrics', query: {'period': period});

  Future<Map<String, dynamic>> salesReport({String? from, String? to}) =>
      _api.get('/api/admin/reports/sales', query: {'from': from, 'to': to});

  // ------------------------------------------------------------------ ventas
  Future<List<Map<String, dynamic>>> quotes() async {
    final data = await _api.get('/api/admin/pos/quotes');
    return listv(data['quotes'] ?? data['documents'] ?? data['items']);
  }

  Future<List<Map<String, dynamic>>> pickups() async {
    final data = await _api.get('/api/admin/pickups');
    return listv(data['pickups'] ?? data['items']);
  }

  Future<List<Map<String, dynamic>>> storeRequests() async {
    final data = await _api.get('/api/admin/store/requests');
    return listv(data['requests'] ?? data['items']);
  }

  Future<List<Map<String, dynamic>>> suppliers() async {
    final data = await _api.get('/api/admin/suppliers');
    return listv(data['suppliers'] ?? data['items']);
  }

  // ---------------------------------------------------------------- entregas
  Future<List<DeliverySession>> deliveryTracking() async {
    final data = await _api.get('/api/admin/delivery-tracking');
    return listv(data['sessions']).map(DeliverySession.fromJson).toList();
  }

  /// Última posición de cada mensajero de la app FULLTECH DELIVERY.
  /// Requiere `admin.full` o `delivery.manage`; el servidor calcula el estado de
  /// señal (`live`/`delayed`/`no_signal`) y devuelve `server_time`.
  Future<List<CourierPosition>> courierPositions({String companyId = 'phytoemagry'}) async {
    final data = await _api.get('/api/admin/delivery-courier-positions', query: {'companyId': companyId});
    return listv(data['positions']).map(CourierPosition.fromJson).toList();
  }

  Future<Map<String, dynamic>> deliveryCash() => _api.get('/api/admin/delivery-cash');

  /// Libro append-only de movimientos de custodia (solo lectura).
  Future<List<Map<String, dynamic>>> deliveryCashMovements({String? courierId, String? companyId}) async {
    final data = await _api.get('/api/admin/delivery-cash/movements', query: {
      'courierId': ?courierId,
      'companyId': ?companyId,
    });
    return listv(data['movements']);
  }

  /// Incidencias de conciliación de una empresa (solo lectura: no corrige nada).
  Future<Map<String, dynamic>> deliveryCashIncidents({String? companyId}) =>
      _api.get('/api/admin/delivery-cash/incidents', query: {'companyId': ?companyId});

  /// Conciliación completa por empresa + movimientos sin resolver.
  Future<Map<String, dynamic>> deliveryCashReconciliation() =>
      _api.get('/api/admin/delivery-cash/reconciliation');

  /// Resoluciones administrativas ya registradas (no mueven dinero).
  Future<List<Map<String, dynamic>>> cashResolutions() async {
    final data = await _api.get('/api/admin/delivery-cash/resolutions');
    return listv(data['resolutions']);
  }

  /// Registra la revisión humana de un movimiento. NO mueve dinero ni desbloquea
  /// la custodia: deja constancia con justificación y evidencia.
  Future<Map<String, dynamic>> recordCashResolution({
    required String movementId,
    required String justification,
    String? evidence,
    String? companyId,
  }) =>
      _api.post('/api/admin/delivery-cash/resolutions', {
        'movementId': movementId,
        'justification': justification,
        'evidence': ?evidence,
        'companyId': ?companyId,
      });

  /// Rendición de efectivo por CUENTA de repartidor (solo ADMIN).
  /// Importes en CENTAVOS, como el resto de la custodia del servidor.
  Future<Map<String, dynamic>> remitDeliveryCash({
    required String courierAccountId,
    required int amountCents,
    String? companyId,
    String? note,
    required String operationKey,
  }) =>
      _api.post('/api/admin/delivery-cash/remittance', {
        'courierAccountId': courierAccountId,
        'amountCents': amountCents,
        'companyId': ?companyId,
        'note': ?note,
        'idempotencyKey': operationKey,
      }, operationKey: operationKey);

  Future<List<Map<String, dynamic>>> courierApplications() async {
    final data = await _api.get('/api/admin/courier-applications');
    return listv(data['applications'] ?? data['items']);
  }

  // -------------------------------------------------------------- operaciones
  Future<Map<String, dynamic>> opsSummary() => _api.get('/api/admin/ops/summary');

  Future<List<Map<String, dynamic>>> opsInbox() async {
    final data = await _api.get('/api/admin/ops/inbox');
    return listv(data['tickets'] ?? data['inbox'] ?? data['items']);
  }

  Future<List<Map<String, dynamic>>> opsAgents() async {
    final data = await _api.get('/api/admin/ops/agents');
    return listv(data['agents'] ?? data['items']);
  }

  // ------------------------------------------------------- seguimiento y resto
  Future<Map<String, dynamic>> scheduled() => _api.get('/api/admin/scheduled');

  Future<List<Map<String, dynamic>>> users() async {
    final data = await _api.get('/api/admin/users');
    return listv(data['users'] ?? data['items']);
  }

  Future<Map<String, dynamic>> settings() => _api.get('/api/admin/settings');

  Future<List<Map<String, dynamic>>> audit() async {
    final data = await _api.get('/api/admin/audit', query: {'limit': '30'});
    return listv(data['events'] ?? data['entries'] ?? data['items']);
  }
}
