import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../data/crm_repository.dart';
import '../../../data/models/crm_models.dart';
import 'chat_desktop_theme.dart';

/// Destino del pedido y última posición GPS de su entrega activa.
/// La posición se consulta mientras el panel está abierto; no se inventa una
/// ruta vial ni se presenta una señal antigua como si fuera en vivo.
class ChatOrderLiveMap extends StatefulWidget {
  const ChatOrderLiveMap({
    super.key,
    required this.repository,
    required this.orderId,
    required this.destination,
    required this.customerName,
    required this.locationLabel,
  });

  final CrmRepository repository;
  final String orderId;
  final LatLng destination;
  final String customerName;
  final String locationLabel;

  @override
  State<ChatOrderLiveMap> createState() => _ChatOrderLiveMapState();
}

class _ChatOrderLiveMapState extends State<ChatOrderLiveMap>
    with SingleTickerProviderStateMixin {
  final MapController _map = MapController();
  late final AnimationController _movement = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 850),
    value: 1,
  );
  Timer? _refreshTimer;
  DeliverySession? _session;
  LatLng? _previousPosition;
  bool _mapReady = false;
  bool _userMoved = false;
  bool _loading = true;
  bool _trackingUnavailable = false;

  @override
  void initState() {
    super.initState();
    _refresh();
    _refreshTimer = Timer.periodic(
      const Duration(seconds: 8),
      (_) => _refresh(),
    );
  }

  @override
  void didUpdateWidget(covariant ChatOrderLiveMap oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.orderId != widget.orderId ||
        oldWidget.destination != widget.destination) {
      _session = null;
      _previousPosition = null;
      _userMoved = false;
      _refresh();
      WidgetsBinding.instance.addPostFrameCallback((_) => _fit());
    }
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    _movement.dispose();
    _map.dispose();
    super.dispose();
  }

  LatLng? _position(DeliverySession? session) {
    final lat = session?.lat;
    final lng = session?.lng;
    if (lat == null || lng == null || lat.abs() > 90 || lng.abs() > 180) {
      return null;
    }
    if (lat.abs() < 0.001 && lng.abs() < 0.001) return null;
    return LatLng(lat, lng);
  }

  bool get _fresh {
    final at = DateTime.tryParse(_session?.updatedAt ?? '');
    if (at == null) return false;
    final age = DateTime.now().difference(at).inSeconds;
    return age >= 0 && age <= 120;
  }

  LatLng? get _animatedPosition {
    final target = _position(_session);
    final before = _previousPosition;
    if (target == null || before == null) return target;
    final progress = Curves.easeOutCubic.transform(_movement.value);
    return LatLng(
      before.latitude + (target.latitude - before.latitude) * progress,
      before.longitude + (target.longitude - before.longitude) * progress,
    );
  }

  Future<void> _refresh() async {
    if (!mounted || widget.orderId.isEmpty) return;
    final orderId = widget.orderId;
    try {
      final sessions = await widget.repository.deliveryTracking();
      if (!mounted || orderId != widget.orderId) return;
      DeliverySession? active;
      for (final session in sessions) {
        if (session.orderId == orderId &&
            session.status.toUpperCase() == 'ACTIVE') {
          active = session;
          break;
        }
      }
      final before = _position(_session);
      final next = _position(active);
      final changed = before != null && next != null && before != next;
      final firstPosition = before == null && next != null;
      setState(() {
        _previousPosition = changed ? before : null;
        _session = active;
        _loading = false;
        _trackingUnavailable = false;
      });
      if (changed) _movement.forward(from: 0);
      if (firstPosition && !_userMoved) _fit();
    } catch (_) {
      if (!mounted || orderId != widget.orderId) return;
      setState(() {
        _loading = false;
        _trackingUnavailable = true;
      });
    }
  }

  void _fit() {
    if (!mounted || !_mapReady) return;
    final courier = _position(_session);
    try {
      if (courier == null) {
        _map.move(widget.destination, 16);
      } else {
        _map.fitCamera(
          CameraFit.coordinates(
            coordinates: [widget.destination, courier],
            padding: const EdgeInsets.all(76),
            maxZoom: 16,
          ),
        );
      }
    } catch (_) {
      // El primer fotograma puede preceder al tamaño definitivo del mapa.
    }
  }

  void _zoom(double delta) {
    if (!_mapReady) return;
    _map.move(_map.camera.center, (_map.camera.zoom + delta).clamp(4.0, 19.0));
    _userMoved = true;
  }

  Future<void> _openExternal() async {
    final point = widget.destination;
    final uri = Uri.parse(
      'https://www.google.com/maps/search/?api=1&query=${point.latitude},${point.longitude}',
    );
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final current = _session;
    final courier = _position(current);
    final status = _trackingUnavailable
        ? 'GPS no disponible · se muestra el domicilio'
        : _loading
        ? 'Consultando entrega…'
        : current == null
        ? 'Sin entrega en curso'
        : courier == null
        ? 'Entrega activa · esperando GPS'
        : _fresh
        ? '${current.courierName} · en vivo'
        : '${current.courierName} · última posición, sin señal reciente';

    return ClipRRect(
      borderRadius: const BorderRadius.vertical(top: Radius.circular(12)),
      child: Stack(
        children: [
          Positioned.fill(
            child: FlutterMap(
              mapController: _map,
              options: MapOptions(
                initialCenter: widget.destination,
                initialZoom: 16,
                minZoom: 4,
                maxZoom: 19,
                onMapReady: () {
                  _mapReady = true;
                  _fit();
                },
                onPositionChanged: (_, hasGesture) {
                  if (hasGesture) _userMoved = true;
                },
              ),
              children: [
                TileLayer(
                  urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                  userAgentPackageName: 'com.fulltech.crm',
                ),
                MarkerLayer(
                  markers: [
                    Marker(
                      point: widget.destination,
                      width: 52,
                      height: 52,
                      child: _MapMarker(
                        icon: Icons.home_rounded,
                        color: c.accent,
                        tooltip: 'Domicilio de ${widget.customerName}',
                      ),
                    ),
                  ],
                ),
                if (courier != null)
                  AnimatedBuilder(
                    animation: _movement,
                    builder: (context, _) => MarkerLayer(
                      markers: [
                        Marker(
                          point: _animatedPosition ?? courier,
                          width: 50,
                          height: 50,
                          child: _MapMarker(
                            icon: Icons.delivery_dining_rounded,
                            color: _fresh
                                ? const Color(0xFF168953)
                                : const Color(0xFF687887),
                            tooltip: status,
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          Positioned(
            top: 10,
            left: 10,
            right: 54,
            child: _MapLabel(
              icon: Icons.home_rounded,
              text: widget.locationLabel.isEmpty
                  ? 'Domicilio de ${widget.customerName}'
                  : widget.locationLabel,
            ),
          ),
          Positioned(
            top: 10,
            right: 10,
            child: Column(
              children: [
                _MapAction(
                  icon: Icons.add_rounded,
                  tooltip: 'Acercar mapa',
                  onTap: () => _zoom(1),
                ),
                const SizedBox(height: 5),
                _MapAction(
                  icon: Icons.remove_rounded,
                  tooltip: 'Alejar mapa',
                  onTap: () => _zoom(-1),
                ),
                const SizedBox(height: 5),
                _MapAction(
                  icon: Icons.center_focus_strong_rounded,
                  tooltip: 'Centrar domicilio y repartidor',
                  onTap: _fit,
                ),
                const SizedBox(height: 5),
                _MapAction(
                  icon: Icons.open_in_new_rounded,
                  tooltip: 'Abrir en mapas',
                  onTap: _openExternal,
                ),
              ],
            ),
          ),
          Positioned(
            left: 10,
            right: 10,
            bottom: 10,
            child: _MapLabel(
              icon: courier == null
                  ? Icons.home_outlined
                  : Icons.delivery_dining_rounded,
              text: status,
            ),
          ),
          Positioned(
            right: 10,
            bottom: 50,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: const Color(0xDDFFFFFF),
                borderRadius: BorderRadius.circular(4),
              ),
              child: const Padding(
                padding: EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                child: Text(
                  '© OpenStreetMap contributors',
                  style: TextStyle(fontSize: 9, color: Color(0xFF34445A)),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _MapMarker extends StatelessWidget {
  const _MapMarker({
    required this.icon,
    required this.color,
    required this.tooltip,
  });

  final IconData icon;
  final Color color;
  final String tooltip;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: tooltip,
    child: Container(
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: color,
        border: Border.all(color: Colors.white, width: 3),
        boxShadow: const [
          BoxShadow(
            color: Color(0x55000000),
            blurRadius: 9,
            offset: Offset(0, 3),
          ),
        ],
      ),
      child: Icon(icon, color: Colors.white, size: 25),
    ),
  );
}

class _MapLabel extends StatelessWidget {
  const _MapLabel({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      color: const Color(0xF5FFFFFF),
      borderRadius: BorderRadius.circular(9),
      boxShadow: const [
        BoxShadow(
          color: Color(0x29000000),
          blurRadius: 8,
          offset: Offset(0, 2),
        ),
      ],
    ),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, color: const Color(0xFF1659C9), size: 16),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              text,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 11.5,
                fontWeight: FontWeight.w700,
                color: Color(0xFF1C3149),
              ),
            ),
          ),
        ],
      ),
    ),
  );
}

class _MapAction extends StatelessWidget {
  const _MapAction({
    required this.icon,
    required this.tooltip,
    required this.onTap,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
    color: Colors.white,
    borderRadius: BorderRadius.circular(8),
    elevation: 3,
    child: IconButton(
      onPressed: onTap,
      tooltip: tooltip,
      constraints: const BoxConstraints.tightFor(width: 36, height: 36),
      padding: EdgeInsets.zero,
      iconSize: 20,
      color: const Color(0xFF1659C9),
      icon: Icon(icon),
    ),
  );
}
