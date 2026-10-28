/// Lectura tolerante de JSON.
///
/// El panel y la app comparten servidor, pero conviene no romperse si un campo
/// falta o cambia de tipo: `null` no debe tumbar una pantalla entera.
library;

String str(Object? value, [String fallback = '']) {
  if (value == null) return fallback;
  if (value is String) return value;
  if (value is num || value is bool) return value.toString();
  return fallback;
}

num numv(Object? value, [num fallback = 0]) {
  if (value is num) return value;
  if (value is String) return num.tryParse(value.replaceAll(',', '')) ?? fallback;
  return fallback;
}

double dub(Object? value, [double fallback = 0]) => numv(value, fallback).toDouble();

int intv(Object? value, [int fallback = 0]) => numv(value, fallback).toInt();

bool boolv(Object? value, [bool fallback = false]) {
  if (value is bool) return value;
  if (value is num) return value != 0;
  if (value is String) return value == 'true' || value == '1';
  return fallback;
}

Map<String, dynamic> mapv(Object? value) =>
    value is Map ? value.map((key, v) => MapEntry(key.toString(), v)) : <String, dynamic>{};

List<Map<String, dynamic>> listv(Object? value) =>
    value is List ? value.map(mapv).where((row) => row.isNotEmpty).toList() : const [];

class CrmUser {
  const CrmUser({
    required this.id,
    required this.username,
    required this.displayName,
    required this.role,
  });

  final String id;
  final String username;
  final String displayName;
  final String role;

  bool get isAdmin => role.toUpperCase() == 'ADMIN';

  String get initials {
    final source = (displayName.isNotEmpty ? displayName : username).trim();
    if (source.isEmpty) return 'FT';
    final parts = source.split(RegExp(r'\s+')).where((part) => part.isNotEmpty).toList();
    if (parts.length == 1) return parts.first.characters2;
    return '${parts.first.characters2}${parts.last.characters2}';
  }

  factory CrmUser.fromJson(Map<String, dynamic> json) => CrmUser(
        id: str(json['id']),
        username: str(json['username']),
        displayName: str(json['display_name'], str(json['displayName'], str(json['username']))),
        role: str(json['role'], 'AGENT').toUpperCase(),
      );
}

extension _TwoChars on String {
  String get characters2 => length >= 2 ? substring(0, 2).toUpperCase() : toUpperCase();
}

class CrmSession {
  const CrmSession({this.user, this.permissions = const {}, this.legacy = false});

  final CrmUser? user;
  final Set<String> permissions;
  final bool legacy;

  bool get authenticated => user != null || legacy;
  bool get isAdmin => user?.isAdmin ?? legacy;

  bool can(String permission) {
    if (isAdmin) return true;
    if (permissions.contains(permission)) return true;
    final head = permission.split('.').first;
    return permissions.contains('$head.*');
  }

  factory CrmSession.fromJson(Map<String, dynamic> json) {
    final user = json['user'];
    return CrmSession(
      user: user is Map ? CrmUser.fromJson(mapv(user)) : null,
      permissions: (json['permissions'] is List ? json['permissions'] as List : const [])
          .map((value) => str(value))
          .where((value) => value.isNotEmpty)
          .toSet(),
      legacy: boolv(json['legacy']),
    );
  }
}

class Conversation {
  Conversation({
    required this.id,
    required this.customerId,
    required this.name,
    required this.phone,
    required this.lastBody,
    required this.lastDirection,
    required this.lastType,
    required this.lastAt,
    required this.unread,
    required this.awaitingReply,
    required this.isResolved,
    required this.stage,
    required this.tags,
    required this.companyId,
    this.assignedUserId = '',
    this.assignedName = '',
    this.archived = false,
    this.hasPurchase = false,
    this.nextFollowupAt = '',
  });

  final String id;
  final String customerId;
  final String name;
  final String phone;
  final String lastBody;
  final String lastDirection;
  final String lastType;
  final String lastAt;
  final int unread;
  final bool awaitingReply;
  final bool isResolved;
  final String stage;
  final List<String> tags;
  final String companyId;

  /// Agente asignado (vacío = sin asignar).
  final String assignedUserId;

  /// Nombre del agente en el momento de asignar (para pintarlo sin otra llamada).
  final String assignedName;

  /// Archivada: sale de la bandeja pero se conserva el hilo.
  final bool archived;

  /// Tiene al menos una compra entregada.
  final bool hasPurchase;

  /// Fecha del seguimiento pendiente (ISO), vacía si no hay.
  final String nextFollowupAt;

  bool get assigned => assignedUserId.isNotEmpty;

  bool get pending => awaitingReply && !isResolved;

  factory Conversation.fromJson(Map<String, dynamic> json) {
    final customer = mapv(json['customer']);
    final last = mapv(json['last_message']);
    return Conversation(
      id: str(json['id']),
      customerId: str(json['customer_id'], str(customer['id'])),
      name: str(customer['name'], str(customer['phone_e164'], 'Sin nombre')),
      phone: str(customer['phone_e164'], str(customer['phone'])),
      lastBody: str(last['body']),
      lastDirection: str(last['direction'], 'inbound'),
      lastType: str(last['type'], 'text'),
      lastAt: str(last['at'], str(json['last_message_at'])),
      unread: intv(json['unread_count']),
      awaitingReply: boolv(json['awaiting_reply']),
      isResolved: boolv(json['is_resolved'], boolv(json['resolved'])),
      stage: str(json['customer_stage'], str(json['customerStage'], 'NUEVO')).toUpperCase(),
      tags: (json['tags'] is List ? json['tags'] as List : const [])
          .map((tag) => tag is Map ? str(mapv(tag)['name']) : str(tag))
          .where((tag) => tag.isNotEmpty)
          .toList(),
      companyId: str(json['company_id']),
      assignedUserId: str(json['assigned_user_id'], str(json['assigned_to'])),
      assignedName: str(json['assigned_display_name_snapshot']),
      archived: str(json['archived_at']).isNotEmpty,
      hasPurchase: boolv(json['has_purchase']),
      nextFollowupAt: str(mapv(json['next_followup'])['scheduled_at']),
    );
  }

  String get preview => switch (lastType) {
        'image' => 'Foto',
        'audio' => 'Nota de voz',
        'video' => 'Vídeo',
        'document' => 'Documento',
        'location' => 'Ubicación',
        'sticker' => 'Sticker',
        _ => lastBody,
      };
}

class ChatMessage {
  ChatMessage({
    required this.id,
    required this.direction,
    required this.body,
    required this.type,
    required this.status,
    required this.at,
    required this.author,
    required this.mediaUrl,
    required this.mediaId,
    required this.latitude,
    required this.longitude,
  });

  final String id;
  final String direction;
  final String body;
  final String type;
  final String status;
  final String at;
  final String author;
  final String mediaUrl;

  /// Identificador del adjunto dentro del CRM (`/api/admin/media/:id`).
  final String mediaId;
  final double? latitude;
  final double? longitude;

  bool get outgoing => direction == 'outbound' || direction == 'out';
  bool get hasMedia => mediaId.isNotEmpty || mediaUrl.isNotEmpty;
  bool get hasCoordinates => latitude != null && longitude != null;

  factory ChatMessage.fromJson(Map<String, dynamic> json) {
    final media = mapv(json['media']);
    final location = mapv(json['location']);
    return ChatMessage(
      id: str(json['id'], str(json['message_id'])),
      direction: str(json['direction'], 'inbound'),
      body: str(json['body'], str(json['text'])),
      type: str(json['type'], 'text'),
      status: str(json['status']),
      at: str(json['created_at'], str(json['at'], str(json['timestamp']))),
      author: str(json['author'], str(json['sent_by'])),
      mediaUrl: str(json['media_url'], str(media['url'], str(json['url']))),
      mediaId: str(media['id'], str(json['media_id'], str(json['mediaId']))),
      latitude: location['latitude'] == null ? null : dub(location['latitude']),
      longitude: location['longitude'] == null ? null : dub(location['longitude']),
    );
  }
}

class Customer {
  Customer({
    required this.id,
    required this.name,
    required this.phone,
    required this.email,
    required this.stage,
    required this.tags,
    required this.city,
    required this.createdAt,
    required this.orders,
    required this.totalSpent,
    required this.notes,
    required this.delivered,
  });

  final String id;
  final String name;
  final String phone;
  final String email;
  final String stage;
  final List<String> tags;
  final String city;
  final String createdAt;
  final int orders;
  final double totalSpent;
  final String notes;
  final int delivered;

  factory Customer.fromJson(Map<String, dynamic> json) {
    final stats = mapv(json['stats']);
    return Customer(
      id: str(json['id']),
      name: str(json['name'], str(json['phone_e164'], 'Sin nombre')),
      phone: str(json['phone_e164'], str(json['phone'])),
      email: str(json['email']),
      stage: str(json['customer_stage'], str(json['customerStage'], str(json['stage'], 'NUEVO'))).toUpperCase(),
      tags: (json['tags'] is List ? json['tags'] as List : const [])
          .map((tag) => tag is Map ? str(mapv(tag)['name']) : str(tag))
          .where((tag) => tag.isNotEmpty)
          .toList(),
      city: str(json['city'], str(json['location'])),
      createdAt: str(json['created_at']),
      orders: intv(stats['orders'], intv(json['orders_count'])),
      totalSpent: dub(stats['total'], dub(json['total_spent'])),
      notes: str(json['notes']),
      delivered: intv(stats['delivered'], intv(json['delivered_count'])),
    );
  }
}

class OrderItem {
  OrderItem({
    required this.id,
    required this.name,
    required this.phone,
    required this.location,
    required this.variantName,
    required this.quantity,
    required this.unitPrice,
    required this.total,
    required this.currency,
    required this.status,
    required this.receivedAt,
    required this.orderNumber,
    required this.notes,
    required this.deliveryAddress,
    required this.paymentMethod,
    required this.customerId,
    required this.conversationId,
    required this.source,
  });

  final String id;
  final String name;
  final String phone;
  final String location;
  final String variantName;
  final int quantity;
  final double unitPrice;
  final double total;
  final String currency;
  final String status;
  final String receivedAt;
  final String orderNumber;
  final String notes;
  final String deliveryAddress;
  final String paymentMethod;
  final String customerId;
  final String conversationId;
  final String source;

  bool get isOpen => !const {'entregado', 'cancelado', 'devuelto'}.contains(status.toLowerCase());

  factory OrderItem.fromJson(Map<String, dynamic> json) {
    final delivery = mapv(json['delivery']);
    return OrderItem(
      id: str(json['id']),
      name: str(json['name'], str(json['customer_name'], 'Sin nombre')),
      phone: str(json['phone']),
      location: str(json['location']),
      variantName: str(json['variantName'], str(json['variant_name'], str(json['product']))),
      quantity: intv(json['quantity'], 1),
      unitPrice: dub(json['unitPrice'], dub(json['unit_price'])),
      total: dub(json['total']),
      currency: str(json['currency'], 'DOP'),
      status: str(json['status'], 'nuevo').toLowerCase(),
      receivedAt: str(json['receivedAt'], str(json['received_at'], str(json['created_at']))),
      orderNumber: str(json['orderNumber'], str(json['order_number'])),
      notes: str(json['notes']),
      deliveryAddress: str(delivery['address'], str(json['address'])),
      paymentMethod: str(json['paymentMethod'], str(json['payment_method'])),
      customerId: str(json['customerId'], str(json['customer_id'])),
      conversationId: str(json['conversationId'], str(json['conversation_id'])),
      source: str(json['source'], str(json['channel'])),
    );
  }

  String get label => orderNumber.isNotEmpty ? '#$orderNumber' : '#${id.split('-').last}';
}

class CatalogProduct {
  CatalogProduct({
    required this.id,
    required this.name,
    required this.presentations,
    this.category = '',
    this.imageUrl = '',
  });

  final String id;
  final String name;
  final List<CatalogPresentation> presentations;

  /// Categoría del producto si el catálogo la expone (`category`, `kind`).
  /// Vacía cuando el API no la envía: no se inventa ninguna.
  final String category;

  /// Foto del producto si el catálogo la expone (`image_url`, `image`…).
  /// Vacía cuando el API no la envía: la tarjeta pinta un marcador neutro.
  final String imageUrl;

  factory CatalogProduct.fromJson(Map<String, dynamic> json) => CatalogProduct(
        id: str(json['id'], str(json['productId'])),
        name: str(json['name'], str(json['product_name'], 'Producto')),
        presentations: listv(json['presentations']).map(CatalogPresentation.fromJson).toList(),
        category: str(json['category'], str(json['category_name'], str(json['kind']))).trim(),
        imageUrl: str(
          json['image_url'],
          str(json['imageUrl'], str(json['image'], str(json['photo_url'], str(json['thumbnail'])))),
        ).trim(),
      );
}

class CatalogPresentation {
  CatalogPresentation({
    required this.id,
    required this.name,
    required this.price,
    required this.salePriceCents,
    required this.capsules,
    required this.available,
    required this.stock,
    required this.currency,
  });

  final String id;
  final String name;

  /// Precio en pesos (para mostrar).
  final double price;

  /// Precio en CENTAVOS, tal y como lo calcula el servidor (`sale_price_cents`).
  final int salePriceCents;
  final String capsules;

  /// `active` del catálogo: es lo que decide si se puede vender.
  final bool available;

  /// Existencias, cuando el endpoint las trae.
  final int stock;
  final String currency;

  factory CatalogPresentation.fromJson(Map<String, dynamic> json) {
    final price = dub(json['price'], dub(json['unitPrice']));
    final cents = intv(json['sale_price_cents'], intv(json['salePriceCents']));
    return CatalogPresentation(
      id: str(json['id'], str(json['variantId'])),
      name: str(json['name'], str(json['variantName'], 'Presentación')),
      price: price,
      salePriceCents: cents > 0 ? cents : (price * 100).round(),
      capsules: str(json['capsules']),
      available: boolv(json['active'], boolv(json['available'], true)),
      stock: intv(json['stock'], intv(json['available_units'])),
      currency: str(json['currency'], 'DOP'),
    );
  }
}

class FollowupRow {
  FollowupRow({
    required this.id,
    required this.customerId,
    required this.customerName,
    required this.scheduledAt,
    required this.status,
    required this.note,
  });

  final String id;
  final String customerId;
  final String customerName;
  final String scheduledAt;
  final String status;
  final String note;

  factory FollowupRow.fromJson(Map<String, dynamic> json) => FollowupRow(
        id: str(json['id']),
        customerId: str(json['customer_id']),
        customerName: str(json['customer_name'], str(json['name'], 'Cliente')),
        scheduledAt: str(json['scheduled_at']),
        status: str(json['status'], 'pending'),
        note: str(json['note'], str(json['body'], str(json['message']))),
      );
}

class DeliverySession {
  DeliverySession({
    required this.id,
    required this.orderId,
    required this.courierName,
    required this.status,
    required this.startedAt,
    required this.lat,
    required this.lng,
    required this.updatedAt,
  });

  final String id;
  final String orderId;
  final String courierName;
  final String status;
  final String startedAt;
  final double? lat;
  final double? lng;
  final String updatedAt;

  factory DeliverySession.fromJson(Map<String, dynamic> json) {
    final position = mapv(json['last_position']);
    return DeliverySession(
      id: str(json['id'], str(json['session_id'])),
      orderId: str(json['order_id']),
      courierName: str(json['delivery_user_name'], str(json['courier_name'], 'Repartidor')),
      status: str(json['status'], 'activa'),
      startedAt: str(json['started_at'], str(json['created_at'])),
      lat: position['latitude'] == null ? null : dub(position['latitude']),
      lng: position['longitude'] == null ? null : dub(position['longitude']),
      updatedAt: str(position['at'], str(position['updated_at'], str(json['updated_at']))),
    );
  }
}

/// Última posición conocida de un mensajero de la app FULLTECH DELIVERY
/// (`GET /api/admin/delivery-courier-positions`).
///
/// El servidor solo guarda la ÚLTIMA posición por repartidor (no hay historial
/// de rutas) y calcula el estado de señal: `live` ≤ 2 min, `delayed` ≤ 10 min,
/// `no_signal` después. `suspicious` marca saltos físicamente imposibles.
class CourierPosition {
  const CourierPosition({
    required this.courierId,
    required this.courierName,
    required this.state,
    required this.ageSeconds,
    this.latitude,
    this.longitude,
    this.accuracyMeters,
    this.at = '',
    this.suspicious = false,
    this.orderIds = const [],
  });

  final String courierId;
  final String courierName;
  final String state;
  final int? ageSeconds;
  final double? latitude;
  final double? longitude;
  final double? accuracyMeters;
  final String at;
  final bool suspicious;
  final List<String> orderIds;

  bool get hasPosition => latitude != null && longitude != null && state != 'no_location';

  bool get isLive => state == 'live';

  String get stateLabel => switch (state) {
        'live' => 'En vivo',
        'delayed' => 'Con retraso',
        'no_signal' => 'Sin señal',
        'no_location' => 'Sin ubicación',
        _ => state,
      };

  String get ageLabel {
    final seconds = ageSeconds;
    if (seconds == null) return 'Sin datos';
    if (seconds < 60) return 'hace $seconds s';
    final minutes = (seconds / 60).floor();
    if (minutes < 60) return 'hace $minutes min';
    return 'hace ${(minutes / 60).floor()} h';
  }

  factory CourierPosition.fromJson(Map<String, dynamic> json) => CourierPosition(
        courierId: str(json['courier_id'], str(json['id'])),
        courierName: str(json['courier_name'], 'Mensajero'),
        state: str(json['state'], 'no_location'),
        ageSeconds: json['age_seconds'] == null ? null : intv(json['age_seconds']),
        latitude: json['latitude'] == null ? null : dub(json['latitude']),
        longitude: json['longitude'] == null ? null : dub(json['longitude']),
        accuracyMeters: json['accuracy_m'] == null ? null : dub(json['accuracy_m']),
        at: str(json['at']),
        suspicious: json['suspicious'] == true,
        orderIds: listv(json['order_ids']).map((row) => '$row').toList(),
      );
}
