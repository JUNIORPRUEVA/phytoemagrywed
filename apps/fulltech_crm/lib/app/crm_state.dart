import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/files/file_opener.dart';
import '../core/net/api_client.dart';
import '../core/net/event_stream.dart';
import '../data/crm_repository.dart';
import '../data/local/key_value_store.dart';
import '../data/local/outbox.dart';
import '../data/local/outbox_service.dart';
import '../data/models/crm_models.dart';

/// Estado del panel: sesión, paquete de datos, cola offline y apariencia.
///
/// Es el equivalente de `state` en `public/admin/app.js`: una sola carga
/// (`/api/admin/data`) alimenta Hoy, la bandeja, Pedidos y Clientes; cada
/// pantalla añade su detalle con su propia llamada. Cuando el paquete viene
/// RECORTADO (`partial`), las pantallas lo dicen en vez de mentir con una
/// lista incompleta.
class CrmState extends ChangeNotifier {
  CrmState(this.repository, {OutboxService? outbox}) : outbox = outbox ?? OutboxService(
          store: OutboxStore(const PrefsKeyValueStore()),
          transport: RepoOutboxTransport(repository),
        );

  final CrmRepository repository;
  final OutboxService outbox;

  CrmSession _session = const CrmSession();
  Map<String, dynamic> _snapshot = const {};
  bool _loading = false;
  String? _error;
  bool _ready = false;
  ThemeMode _themeMode = ThemeMode.system;
  DateTime? _lastSync;
  bool _offline = false;

  /// Listados completos pedidos aparte cuando el paquete vino recortado.
  List<Customer>? _fullCustomers;
  List<Conversation>? _fullConversations;

  static const String _snapshotKey = 'ft_crm_snapshot';
  static const String _snapshotAtKey = 'ft_crm_snapshot_at';
  static const String _themeKey = 'ft_crm_theme';

  CrmSession get session => _session;
  Map<String, dynamic> get snapshot => _snapshot;
  bool get loading => _loading;
  String? get error => _error;
  bool get ready => _ready;
  bool get authenticated => _session.authenticated;
  ThemeMode get themeMode => _themeMode;
  DateTime? get lastSync => _lastSync;

  /// Sin red: lo que se ve es la copia guardada en este aparato.
  bool get offline => _offline;

  /// El servidor devolvió un paquete RECORTADO (150 pedidos / 150 conversaciones).
  bool get partial => boolv(_snapshot['partial']);

  /// Pedidos: el paquete ligero corta en 150 y no hay endpoint paginado todavía.
  bool get ordersTruncated => partial;

  /// Clientes y bandeja sí se pueden pedir completos: se avisa si aún no están.
  bool get customersComplete => !partial || _fullCustomers != null;
  bool get conversationsComplete => !partial || _fullConversations != null;

  List<OutboxOp> get pendingOps => outbox.ops;
  int get pendingCount => outbox.count;
  List<OutboxOp> get outboxNeedsHuman => outbox.needsHuman;
  bool _flushing = false;
  bool get flushing => _flushing;

  List<Map<String, dynamic>> get rawItems => listv(_snapshot['items']);
  List<OrderItem> get orders =>
      rawItems.where((row) => str(row['type']) == 'order_intent').map(OrderItem.fromJson).toList();

  List<Customer> get customers =>
      _fullCustomers ?? listv(_snapshot['customers']).map(Customer.fromJson).toList();

  List<Conversation> get conversations =>
      _fullConversations ?? listv(_snapshot['conversations']).map(Conversation.fromJson).toList();

  Map<String, dynamic> get counts => mapv(_snapshot['conversationCounts']);
  Map<String, dynamic> get stats => mapv(_snapshot['stats']);
  Map<String, dynamic> get followups => mapv(_snapshot['followups']);
  List<Map<String, dynamic>> get notifications => listv(_snapshot['notifications']);
  List<Map<String, dynamic>> get suppliers => listv(_snapshot['suppliers']);
  List<Map<String, dynamic>> get statuses => listv(_snapshot['statuses']);
  List<Map<String, dynamic>> get customerStages => listv(_snapshot['customerStages']);
  List<Map<String, dynamic>> get customerTags => listv(_snapshot['customerTags']);
  List<DeliverySession> get deliveryTracking => listv(_snapshot['deliveryTracking']).map(DeliverySession.fromJson).toList();
  List<Map<String, dynamic>> get deliveryOrders => listv(_snapshot['deliveryOrders']);
  List<Map<String, dynamic>> get templates => listv(_snapshot['messages']);
  List<Map<String, dynamic>> get scheduled => listv(mapv(_snapshot['scheduled'])['items'] ?? _snapshot['scheduled']);
  String get timeZone => str(_snapshot['timeZone'], 'America/Santo_Domingo');

  Conversation? conversationById(String id) {
    for (final row in conversations) {
      if (row.id == id) return row;
    }
    return null;
  }

  Customer? customerById(String id) {
    for (final row in customers) {
      if (row.id == id) return row;
    }
    return null;
  }

  OrderItem? orderById(String id) {
    for (final row in orders) {
      if (row.id == id) return row;
    }
    return null;
  }

  int get unreadTotal => counts['unread_total'] == null
      ? conversations.fold<int>(0, (sum, row) => sum + row.unread)
      : intv(counts['unread_total']);

  int get pendingConversations =>
      counts['pendientes'] == null ? conversations.where((row) => row.pending).length : intv(counts['pendientes']);

  // ------------------------------------------------------------- arranque
  Future<void> boot() async {
    await _loadTheme();
    await outbox.load();
    await repository.restore();
    if (!repository.api.hasSession) {
      _ready = true;
      notifyListeners();
      return;
    }
    try {
      _session = await repository.session();
    } on ApiException {
      await repository.api.clearSession();
      _session = const CrmSession();
      _ready = true;
      notifyListeners();
      return;
    }
    _ready = true;
    notifyListeners();
    if (_session.authenticated) {
      await refresh(quiet: true);
      startRealtime();
    }
  }

  Future<bool> login(String username, String password) async {
    _error = null;
    _loading = true;
    notifyListeners();
    try {
      _session = await repository.login(username: username, password: password);
      _loading = false;
      notifyListeners();
      await refresh(quiet: true);
      startRealtime();
      return true;
    } on ApiException catch (error) {
      _error = error.message;
      _loading = false;
      notifyListeners();
      return false;
    }
  }

  Future<void> logout() async {
    stopRealtime();
    await repository.logout();
    _session = const CrmSession();
    _snapshot = const {};
    _fullCustomers = null;
    _fullConversations = null;
    await outbox.clear();
    // No pueden quedar recibos ni documentos de clientes en el aparato.
    await FileOpener.purgeAll();
    notifyListeners();
  }

  Future<void> refresh({bool quiet = false}) async {
    if (!quiet) {
      _loading = true;
      _error = null;
      notifyListeners();
    }
    try {
      _snapshot = await repository.snapshot();
      _lastSync = DateTime.now();
      _error = null;
      _offline = false;
      _fullCustomers = null;
      _fullConversations = null;
      await _saveSnapshot(_snapshot);
      // Con red otra vez: se vacía la cola (cada operación lleva su clave, el
      // servidor no la ejecuta dos veces).
      if (outbox.count > 0) {
        _flushInBackground();
      }
    } on ApiException catch (error) {
      if (error.isUnauthorized) {
        _session = const CrmSession();
        await repository.api.clearSession();
        _error = error.message;
      } else if (error.statusCode == 0 && _snapshot.isEmpty) {
        final cached = await _readSnapshot();
        if (cached != null) {
          _snapshot = cached;
          _offline = true;
          _error = null;
        } else {
          _error = error.message;
        }
      } else {
        _error = error.message;
      }
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  void _flushInBackground() {
    flushOutbox().then((_) {}).catchError((Object _) {});
  }

  /// Trae los listados completos cuando el paquete vino recortado.
  ///
  /// Pedidos no tiene endpoint paginado todavía: la pantalla lo avisa y el
  /// contrato necesario queda documentado en el README.
  Future<void> ensureFullLists({bool includeCustomers = true, bool includeConversations = true}) async {
    if (!partial) return;
    final tasks = <Future<void>>[];
    if (includeCustomers && _fullCustomers == null) {
      tasks.add(() async {
        try {
          _fullCustomers = await repository.customers();
        } on ApiException catch (_) {
          // Se queda con lo que había; la pantalla sigue avisando del recorte.
        }
      }());
    }
    if (includeConversations && _fullConversations == null) {
      tasks.add(() async {
        try {
          final data = await repository.conversations();
          _fullConversations = listv(data['conversations']).map(Conversation.fromJson).toList();
        } on ApiException catch (_) {
          // Igual que arriba.
        }
      }());
    }
    if (tasks.isEmpty) return;
    await Future.wait(tasks);
    notifyListeners();
  }

  Future<void> _saveSnapshot(Map<String, dynamic> snapshot) async {
    if (snapshot.isEmpty) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_snapshotKey, jsonEncode(snapshot));
      await prefs.setString(_snapshotAtKey, DateTime.now().toIso8601String());
    } catch (_) {
      // Si no cabe en disco, se sigue trabajando con la red: no es un error.
    }
  }

  Future<Map<String, dynamic>?> _readSnapshot() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_snapshotKey);
      if (raw == null || raw.isEmpty) return null;
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      final at = prefs.getString(_snapshotAtKey);
      _lastSync = at == null ? null : DateTime.tryParse(at);
      return mapv(decoded);
    } catch (_) {
      return null;
    }
  }

  void clearError() {
    if (_error == null) return;
    _error = null;
    notifyListeners();
  }

  // ------------------------------------------------------- cola sin conexión
  Future<void> enqueueMessage(String conversationId, String body, {String? operationKey}) async {    await outbox.enqueue(
      kind: OutboxKind.message,
      conversationId: conversationId,
      body: body,
      operationKey: operationKey,
    );
    notifyListeners();
  }

  Future<void> enqueueResolved(String conversationId, {required bool resolved}) async {
    await outbox.enqueue(
      kind: resolved ? OutboxKind.resolve : OutboxKind.reopen,
      conversationId: conversationId,
    );
    notifyListeners();
  }

  /// Envía lo pendiente. Devuelve cuántas salieron.
  Future<int> flushOutbox({bool manual = false}) async {
    if (_flushing || outbox.count == 0) return 0;
    _flushing = true;
    notifyListeners();
    try {
      await outbox.verifyWithServer();
      final result = await outbox.flush(manual: manual);
      if (result.sent > 0) await refresh(quiet: true);
      return result.sent;
    } on ApiException {
      return 0;
    } finally {
      _flushing = false;
      notifyListeners();
    }
  }

  Future<void> retryOperation(String id) async {
    await outbox.retry(id);
    notifyListeners();
  }

  Future<void> discardOperation(String id) async {
    await outbox.discard(id);
    notifyListeners();
  }

  // ------------------------------------------------------------ canal en vivo
  StreamSubscription<ServerSentEvent>? _events;
  Timer? _refreshDebounce;
  Timer? _reconnectTimer;
  int _lastSeq = 0;
  int _attempt = 0;
  bool _live = false;

  /// El canal de eventos está abierto (aviso para la interfaz).
  bool get live => _live;

  /// Abre `/api/admin/events`. Idempotente: dos llamadas no abren dos canales.
  void startRealtime() {
    if (_events != null || !authenticated) return;
    _connectEvents();
  }

  /// Cierra el canal (app en segundo plano, cierre de sesión).
  void stopRealtime() {
    _events?.cancel();
    _events = null;
    _refreshDebounce?.cancel();
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    if (_live) {
      _live = false;
      notifyListeners();
    }
  }

  void _connectEvents() {
    _reconnectTimer?.cancel();
    final stream = repository.api.openEventStream(
      '/api/admin/events',
      query: {if (_lastSeq > 0) 'since': '$_lastSeq'},
    );
    _live = true;
    notifyListeners();
    _events = stream.listen(
      _onEvent,
      onError: (Object error) {
        _live = false;
        notifyListeners();
        _scheduleReconnect();
      },
      onDone: () {
        _live = false;
        notifyListeners();
        _scheduleReconnect();
      },
      cancelOnError: true,
    );
  }

  void _onEvent(ServerSentEvent event) {
    _attempt = 0; // el canal funciona: se reinicia el backoff
    final sequence = int.tryParse(event.id);
    if (sequence != null) _lastSeq = sequence;
    // `ping`/comentarios: no cambian datos.
    if (event.event == 'ping' || event.data == '{}') return;
    if (event.isResync) {
      // Nos hemos perdido eventos: se recarga entero en vez de suponer.
      refresh(quiet: true);
      return;
    }
    // Varios eventos seguidos = UNA recarga (no una por evento).
    _refreshDebounce?.cancel();
    _refreshDebounce = Timer(RealtimePolicy.refreshDebounce, () {
      if (authenticated) refresh(quiet: true);
    });
  }

  void _scheduleReconnect() {
    _events = null;
    if (!authenticated) return;
    final delay = RealtimePolicy.delayForAttempt(_attempt);
    _attempt = (_attempt + 1).clamp(0, 6);
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(delay, () {
      if (!authenticated) return;
      _connectEvents();
    });
  }

  // ------------------------------------------------------------- apariencia
  Future<void> _loadTheme() async {    final prefs = await SharedPreferences.getInstance();
    _themeMode = switch (prefs.getString(_themeKey)) {
      'light' => ThemeMode.light,
      'dark' => ThemeMode.dark,
      _ => ThemeMode.system,
    };
  }

  Future<void> setThemeMode(ThemeMode mode) async {
    _themeMode = mode;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _themeKey,
      switch (mode) {
        ThemeMode.light => 'light',
        ThemeMode.dark => 'dark',
        ThemeMode.system => 'auto',
      },
    );
  }
}
