import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import '../../app/crm_scope.dart';
import '../../app/crm_state.dart';
import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../pedidos/pedido_detail_screen.dart';

/// GPS real de FULLTECH Delivery. El servidor entrega la última posición, no
/// un historial ni una ruta vial; la línea del mapa solo une GPS y destino.
class MapaScreen extends StatefulWidget {
  const MapaScreen({super.key});

  @override
  State<MapaScreen> createState() => _MapaScreenState();
}

class _MapaScreenState extends State<MapaScreen>
    with SingleTickerProviderStateMixin {
  static const _fallback = LatLng(18.4861, -69.9312);
  final MapController _map = MapController();
  late final AnimationController _movement = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 850),
    value: 1,
  );
  Timer? _refreshTimer;
  List<CourierPosition> _couriers = const [];
  List<DeliverySession> _sessions = const [];
  Map<String, LatLng> _previousGps = const {};
  Map<String, LatLng> _previousSessionGps = const {};
  bool _courierEndpointAvailable = true;
  bool _trackingLoaded = false;
  bool _loading = false;
  bool _initialFitDone = false;
  bool _showOrders = true;
  bool _listCouriers = true;
  bool _listChoiceMade = false;
  int _polls = 0;
  String? _error;
  String? _selectedCourierId;
  String? _selectedSessionId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh(full: true));
    _refreshTimer = Timer.periodic(const Duration(seconds: 8), (_) {
      _polls++;
      _refresh(full: _polls % 4 == 0);
    });
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    _movement.dispose();
    _map.dispose();
    super.dispose();
  }

  Future<void> _refresh({bool full = false, bool retryCourier = false}) async {
    if (!mounted || _loading) return;
    _loading = true;
    final state = CrmScope.of(context, listen: false);
    final repository = state.repository;
    if (retryCourier) _courierEndpointAvailable = true;
    if (_courierEndpointAvailable)
      try {
        final positions = await repository.courierPositions();
        if (!mounted) return;
        final previous = {
          for (final courier in _couriers)
            if (courier.hasPosition && !courier.suspicious)
              courier.courierId: LatLng(courier.latitude!, courier.longitude!),
        };
        final changed = positions.any((courier) {
          final before = previous[courier.courierId];
          return before != null &&
              courier.hasPosition &&
              (before.latitude != courier.latitude ||
                  before.longitude != courier.longitude);
        });
        setState(() {
          _previousGps = previous;
          _couriers = positions;
          _error = null;
        });
        if (changed) _movement.forward(from: 0);
      } on ApiException catch (error) {
        if (mounted)
          setState(() {
            _error = error.statusCode == 404
                ? 'Este servidor no ofrece el GPS de FULLTECH Delivery; se muestran las sesiones activas.'
                : error.message;
            if (error.statusCode == 404) _courierEndpointAvailable = false;
          });
      }
    try {
      final sessions = await repository.deliveryTracking();
      if (mounted) {
        final previous = {
          for (final session in _sessions)
            if (session.lat != null && session.lng != null)
              session.id: LatLng(session.lat!, session.lng!),
        };
        final changed = sessions.any((session) {
          final before = previous[session.id];
          return before != null &&
              session.lat != null &&
              session.lng != null &&
              (before.latitude != session.lat ||
                  before.longitude != session.lng);
        });
        setState(() {
          _previousSessionGps = previous;
          _sessions = sessions;
          _trackingLoaded = true;
        });
        if (changed) _movement.forward(from: 0);
      }
    } on ApiException catch (_) {
      // El mapa sigue mostrando el último estado conocido si esta lectura falla.
    }
    if (full && mounted) await state.refresh(quiet: true);
    _loading = false;
  }

  List<DeliverySession> _activeSessions(CrmState state) =>
      (_trackingLoaded ? _sessions : state.deliveryTracking)
          .where((session) => session.status.toUpperCase() == 'ACTIVE')
          .toList();

  List<Map<String, dynamic>> _activeOrders(CrmState state) =>
      state.deliveryOrders.where((order) {
        if (const {
          'entregado',
          'cancelado',
          'perdido',
        }.contains(str(order['status']).toLowerCase()))
          return false;
        final delivery = mapv(order['delivery']);
        final external = mapv(delivery['external']);
        return str(delivery['delivery_user_id']).isNotEmpty ||
            (external.isNotEmpty && str(external['superseded_at']).isEmpty);
      }).toList();

  LatLng? _destination(Map<String, dynamic> order) {
    final location = mapv(mapv(order['delivery'])['location']);
    final lat = location['latitude'];
    final lng = location['longitude'];
    if (lat is! num || lng is! num) return null;
    if (lat.abs() > 90 || lng.abs() > 180) return null;
    return LatLng(lat.toDouble(), lng.toDouble());
  }

  LatLng _movingPoint(CourierPosition courier) {
    final target = LatLng(courier.latitude!, courier.longitude!);
    final before = _previousGps[courier.courierId];
    if (before == null) return target;
    final t = Curves.easeOutCubic.transform(_movement.value);
    return LatLng(
      before.latitude + (target.latitude - before.latitude) * t,
      before.longitude + (target.longitude - before.longitude) * t,
    );
  }

  LatLng _movingSessionPoint(DeliverySession session) {
    final target = LatLng(session.lat!, session.lng!);
    final before = _previousSessionGps[session.id];
    if (before == null) return target;
    final t = Curves.easeOutCubic.transform(_movement.value);
    return LatLng(
      before.latitude + (target.latitude - before.latitude) * t,
      before.longitude + (target.longitude - before.longitude) * t,
    );
  }

  bool _recentSession(DeliverySession session) {
    final at = DateTime.tryParse(session.updatedAt);
    return at != null && DateTime.now().difference(at).inMinutes < 2;
  }

  List<LatLng> _visiblePoints(CrmState state) {
    final points = <LatLng>[
      for (final courier in _couriers)
        if (courier.isLive && courier.hasPosition && !courier.suspicious)
          LatLng(courier.latitude!, courier.longitude!),
      for (final session in _activeSessions(state))
        if (session.lat != null && session.lng != null)
          LatLng(session.lat!, session.lng!),
      if (_showOrders)
        for (final order in _activeOrders(state))
          if (_destination(order) case final LatLng point) point,
    ];
    return points;
  }

  void _fit(List<LatLng> points) {
    if (points.isEmpty) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      try {
        if (points.length == 1) {
          _map.move(points.first, 15);
        } else {
          _map.fitCamera(
            CameraFit.coordinates(
              coordinates: points,
              padding: const EdgeInsets.all(50),
              maxZoom: 16,
            ),
          );
        }
      } catch (_) {
        // El primer fotograma puede llegar antes de que el mapa tenga tamaño.
      }
    });
  }

  void _focusCourier(CourierPosition courier) {
    if (!courier.hasPosition) return;
    setState(() {
      _selectedCourierId = courier.courierId;
      _selectedSessionId = null;
    });
    _map.move(LatLng(courier.latitude!, courier.longitude!), 15);
  }

  void _focusSession(DeliverySession session) {
    setState(() {
      _selectedSessionId = session.id;
      _selectedCourierId = null;
    });
    if (session.lat != null && session.lng != null) {
      _map.move(LatLng(session.lat!, session.lng!), 15);
    }
  }

  void _openOrder(Map<String, dynamic> order) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => PedidoDetailScreen(orderId: str(order['id'])),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    final orders = _activeOrders(state);
    final sessions = _activeSessions(state);
    final live = _couriers
        .where((row) => row.isLive && row.hasPosition && !row.suspicious)
        .toList();
    final fallbackSessions = sessions
        .where(
          (session) => !live.any(
            (courier) => courier.orderIds.contains(session.orderId),
          ),
        )
        .toList();
    final points = _visiblePoints(state);
    final showCouriers = _listChoiceMade
        ? _listCouriers
        : live.isNotEmpty || fallbackSessions.isNotEmpty;
    if (!_initialFitDone && points.isNotEmpty) {
      _initialFitDone = true;
      _fit(points);
    }
    final selected = _selectedSessionId != null
        ? null
        : (live
                  .where((row) => row.courierId == _selectedCourierId)
                  .firstOrNull ??
              live.firstOrNull);
    final selectedSession = selected != null
        ? null
        : (fallbackSessions
                  .where((row) => row.id == _selectedSessionId)
                  .firstOrNull ??
              fallbackSessions.firstOrNull);
    final destinationOrder = selected != null
        ? orders
              .where((row) => selected.orderIds.contains(str(row['id'])))
              .firstOrNull
        : selectedSession == null
        ? null
        : orders
              .where((row) => str(row['id']) == selectedSession.orderId)
              .firstOrNull;
    final destination = destinationOrder == null
        ? null
        : _destination(destinationOrder);

    return LayoutBuilder(
      builder: (context, limits) {
        final listHeight =
            live.isEmpty && fallbackSessions.isEmpty && orders.isEmpty
            ? 38.0
            : (limits.maxHeight * 0.27).clamp(146.0, 240.0);
        return Column(
          children: [
            Container(
              height: 42,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              decoration: BoxDecoration(
                color: p.surface,
                border: Border(bottom: BorderSide(color: p.border)),
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.radio_button_checked_rounded,
                    size: 13,
                    color: live.isEmpty && !fallbackSessions.any(_recentSession)
                        ? p.inkSecondary
                        : p.success,
                  ),
                  const SizedBox(width: 6),
                  Text(
                    '${live.length + fallbackSessions.where(_recentSession).length} con señal',
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: p.ink,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Text(
                    '${orders.length} pedidos asignados',
                    style: TextStyle(fontSize: 12, color: p.inkSecondary),
                  ),
                  const Spacer(),
                  IconButton(
                    tooltip: 'Ver todos los puntos',
                    visualDensity: VisualDensity.compact,
                    onPressed: () => _fit(points),
                    icon: const Icon(
                      Icons.center_focus_strong_rounded,
                      size: 19,
                    ),
                  ),
                  IconButton(
                    tooltip: 'Actualizar GPS',
                    visualDensity: VisualDensity.compact,
                    onPressed: _loading
                        ? null
                        : () => _refresh(full: true, retryCourier: true),
                    icon: const Icon(Icons.refresh_rounded, size: 19),
                  ),
                ],
              ),
            ),
            Expanded(
              child: Stack(
                children: [
                  FlutterMap(
                    mapController: _map,
                    options: MapOptions(
                      initialCenter: points.isEmpty ? _fallback : points.first,
                      initialZoom: points.isEmpty ? 12 : 14,
                      minZoom: 4,
                      maxZoom: 18,
                      interactionOptions: const InteractionOptions(
                        flags: InteractiveFlag.all & ~InteractiveFlag.rotate,
                      ),
                    ),
                    children: [
                      TileLayer(
                        urlTemplate:
                            'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                        userAgentPackageName: 'lat.fulltech.fulltech_crm',
                        maxZoom: 19,
                      ),
                      AnimatedBuilder(
                        animation: _movement,
                        builder: (context, _) {
                          final routeStart = selected != null
                              ? _movingPoint(selected)
                              : selectedSession != null &&
                                    selectedSession.lat != null &&
                                    selectedSession.lng != null
                              ? _movingSessionPoint(selectedSession)
                              : null;
                          return PolylineLayer(
                            polylines: [
                              if (routeStart != null && destination != null)
                                Polyline(
                                  points: [routeStart, destination],
                                  strokeWidth: 2.5,
                                  color: p.primary.withValues(alpha: 0.75),
                                ),
                            ],
                          );
                        },
                      ),
                      if (_showOrders)
                        MarkerLayer(
                          markers: [
                            for (final order in orders)
                              if (_destination(order) case final LatLng point)
                                Marker(
                                  point: point,
                                  width: 34,
                                  height: 34,
                                  child: Tooltip(
                                    message:
                                        'Destino · ${str(order['order_number'], str(order['id']))}',
                                    child: GestureDetector(
                                      onTap: () => _openOrder(order),
                                      child: _MapPin(
                                        color: p.primary,
                                        icon: Icons.home_rounded,
                                      ),
                                    ),
                                  ),
                                ),
                          ],
                        ),
                      AnimatedBuilder(
                        animation: _movement,
                        builder: (context, _) => MarkerLayer(
                          markers: [
                            for (final courier in live)
                              Marker(
                                point: _movingPoint(courier),
                                width: 40,
                                height: 40,
                                child: Tooltip(
                                  message:
                                      '${courier.courierName} · ${courier.ageLabel}',
                                  child: GestureDetector(
                                    onTap: () => _focusCourier(courier),
                                    child: _MapPin(
                                      color: p.success,
                                      icon: Icons.delivery_dining_rounded,
                                      selected:
                                          courier.courierId ==
                                          selected?.courierId,
                                    ),
                                  ),
                                ),
                              ),
                            for (final session in fallbackSessions)
                              if (session.lat != null && session.lng != null)
                                Marker(
                                  point: _movingSessionPoint(session),
                                  width: 34,
                                  height: 34,
                                  child: Tooltip(
                                    message:
                                        '${session.courierName} · ${CrmFormat.ago(session.updatedAt)}',
                                    child: GestureDetector(
                                      onTap: () => _focusSession(session),
                                      child: _MapPin(
                                        color: _recentSession(session)
                                            ? p.success
                                            : p.warning,
                                        icon: Icons.delivery_dining_outlined,
                                        selected:
                                            session.id == selectedSession?.id,
                                      ),
                                    ),
                                  ),
                                ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  Positioned(
                    top: 8,
                    right: 10,
                    child: Material(
                      color: p.surface.withValues(alpha: 0.95),
                      borderRadius: BorderRadius.circular(8),
                      child: InkWell(
                        onTap: () => setState(() => _showOrders = !_showOrders),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 7,
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(
                                _showOrders
                                    ? Icons.visibility_rounded
                                    : Icons.visibility_off_rounded,
                                size: 15,
                                color: p.primary,
                              ),
                              const SizedBox(width: 5),
                              Text(
                                'Destinos',
                                style: TextStyle(fontSize: 11.5, color: p.ink),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                  if (selected != null || selectedSession != null)
                    Positioned(
                      left: 10,
                      bottom: 10,
                      child: Container(
                        constraints: const BoxConstraints(maxWidth: 330),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 7,
                        ),
                        decoration: BoxDecoration(
                          color: p.surface.withValues(alpha: 0.96),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: p.border),
                        ),
                        child: Text(
                          '${selected?.courierName ?? selectedSession?.courierName} · ${selected?.ageLabel ?? CrmFormat.ago(selectedSession?.updatedAt)}${destination == null ? '' : ' · línea directa al destino'}',
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 11.5, color: p.ink),
                        ),
                      ),
                    ),
                  if (points.isEmpty)
                    Center(
                      child: Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: p.surface.withValues(alpha: 0.94),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Text(
                          'Aún no hay GPS de entregas activas',
                          style: TextStyle(
                            fontSize: 12.5,
                            color: p.inkSecondary,
                          ),
                        ),
                      ),
                    ),
                  Positioned(
                    left: 6,
                    bottom: 4,
                    child: Text(
                      '© OpenStreetMap',
                      style: TextStyle(
                        fontSize: 9,
                        color: p.inkSecondary,
                        backgroundColor: p.surface.withValues(alpha: 0.8),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Container(
              height: listHeight,
              decoration: BoxDecoration(
                color: p.surface,
                border: Border(top: BorderSide(color: p.border)),
              ),
              child: Column(
                children: [
                  SizedBox(
                    height: 36,
                    child: Row(
                      children: [
                        _ListTab(
                          label: 'En reparto',
                          count: live.length + fallbackSessions.length,
                          selected: showCouriers,
                          onTap: () => setState(() {
                            _listCouriers = true;
                            _listChoiceMade = true;
                          }),
                        ),
                        _ListTab(
                          label: 'Pedidos',
                          count: orders.length,
                          selected: !showCouriers,
                          onTap: () => setState(() {
                            _listCouriers = false;
                            _listChoiceMade = true;
                          }),
                        ),
                        const Spacer(),
                        if (_error != null)
                          Tooltip(
                            message: _error!,
                            child: Icon(
                              Icons.warning_amber_rounded,
                              size: 17,
                              color: p.warning,
                            ),
                          ),
                        const SizedBox(width: 12),
                      ],
                    ),
                  ),
                  Expanded(
                    child: showCouriers
                        ? ListView.builder(
                            itemCount: live.length + fallbackSessions.length,
                            itemBuilder: (context, index) {
                              if (index >= live.length) {
                                final session =
                                    fallbackSessions[index - live.length];
                                final order = orders
                                    .where(
                                      (row) =>
                                          str(row['id']) == session.orderId,
                                    )
                                    .firstOrNull;
                                return _CompactRow(
                                  icon: Icons.delivery_dining_outlined,
                                  title: session.courierName,
                                  detail:
                                      '${order == null ? 'En reparto' : str(order['order_number'], 'Pedido')} · ${session.updatedAt.isEmpty ? 'Sin señal GPS' : CrmFormat.ago(session.updatedAt)}',
                                  selected: session.id == selectedSession?.id,
                                  onTap: () => _focusSession(session),
                                  onOpen: order == null
                                      ? null
                                      : () => _openOrder(order),
                                );
                              }
                              final courier = live[index];
                              final order = orders
                                  .where(
                                    (row) => courier.orderIds.contains(
                                      str(row['id']),
                                    ),
                                  )
                                  .firstOrNull;
                              return _CompactRow(
                                icon: Icons.delivery_dining_rounded,
                                title: courier.courierName,
                                detail:
                                    '${order == null ? 'En reparto' : str(order['order_number'], 'Pedido')} · ${courier.ageLabel}',
                                selected:
                                    courier.courierId == selected?.courierId,
                                onTap: () => _focusCourier(courier),
                                onOpen: order == null
                                    ? null
                                    : () => _openOrder(order),
                              );
                            },
                          )
                        : ListView.builder(
                            itemCount: orders.length,
                            itemBuilder: (context, index) {
                              final order = orders[index];
                              final delivery = mapv(order['delivery']);
                              final point = _destination(order);
                              return _CompactRow(
                                icon: Icons.place_outlined,
                                title:
                                    '${str(order['order_number'], str(order['id']))} · ${str(mapv(order['customer'])['name'], 'Cliente')}',
                                detail: str(
                                  delivery['address'],
                                  'Sin dirección',
                                ),
                                onTap: point == null
                                    ? () => _openOrder(order)
                                    : () => _map.move(point, 16),
                                onOpen: () => _openOrder(order),
                              );
                            },
                          ),
                  ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}

class _MapPin extends StatelessWidget {
  const _MapPin({
    required this.color,
    required this.icon,
    this.selected = false,
  });
  final Color color;
  final IconData icon;
  final bool selected;

  @override
  Widget build(BuildContext context) => Container(
    decoration: BoxDecoration(
      color: color,
      shape: BoxShape.circle,
      border: Border.all(color: Colors.white, width: selected ? 3 : 2),
      boxShadow: [
        BoxShadow(
          color: Colors.black.withValues(alpha: selected ? 0.34 : 0.2),
          blurRadius: selected ? 9 : 4,
        ),
      ],
    ),
    alignment: Alignment.center,
    child: Icon(icon, size: selected ? 21 : 18, color: Colors.white),
  );
}

class _ListTab extends StatelessWidget {
  const _ListTab({
    required this.label,
    required this.count,
    required this.selected,
    required this.onTap,
  });
  final String label;
  final int count;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          border: Border(
            bottom: BorderSide(
              color: selected ? p.primary : Colors.transparent,
              width: 2,
            ),
          ),
        ),
        child: Text(
          '$label  $count',
          style: TextStyle(
            fontSize: 11.5,
            fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
            color: selected ? p.primary : p.inkSecondary,
          ),
        ),
      ),
    );
  }
}

class _CompactRow extends StatelessWidget {
  const _CompactRow({
    required this.icon,
    required this.title,
    required this.detail,
    required this.onTap,
    this.onOpen,
    this.selected = false,
  });
  final IconData icon;
  final String title;
  final String detail;
  final VoidCallback onTap;
  final VoidCallback? onOpen;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return InkWell(
      onTap: onTap,
      child: Container(
        height: 47,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: selected ? p.primarySoft.withValues(alpha: 0.5) : null,
          border: Border(
            bottom: BorderSide(color: p.border.withValues(alpha: 0.65)),
          ),
        ),
        child: Row(
          children: [
            Icon(icon, size: 18, color: selected ? p.primary : p.inkSecondary),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12.2,
                      fontWeight: FontWeight.w700,
                      color: p.ink,
                    ),
                  ),
                  Text(
                    detail,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11, color: p.inkSecondary),
                  ),
                ],
              ),
            ),
            if (onOpen != null)
              IconButton(
                tooltip: 'Ver pedido',
                onPressed: onOpen,
                icon: Icon(
                  Icons.open_in_new_rounded,
                  size: 16,
                  color: p.primary,
                ),
                visualDensity: VisualDensity.compact,
              ),
          ],
        ),
      ),
    );
  }
}
