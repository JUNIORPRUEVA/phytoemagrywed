import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/crm_scope.dart';
import '../../app/crm_state.dart';
import '../../core/format/crm_format.dart';
import '../../core/theme/crm_theme.dart';
import '../../core/theme/crm_tokens.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';

/// Mapa con calles (OpenStreetMap) y los repartos en vivo.
///
/// Los puntos salen de `/api/admin/data` (`deliveryTracking` y los pedidos de
/// reparto con coordenadas). Tocar un punto abre su ficha; el botón de cada fila
/// abre la posición en la app de mapas del sistema.
class MapaScreen extends StatefulWidget {
  const MapaScreen({super.key});

  @override
  State<MapaScreen> createState() => _MapaScreenState();
}

class _MapaScreenState extends State<MapaScreen> {
  final MapController _map = MapController();
  bool _showOrders = true;

  static const LatLng _fallback = LatLng(18.4861, -69.9312); // Santo Domingo

  @override
  void dispose() {
    _map.dispose();
    super.dispose();
  }

  List<(LatLng, String, String, bool)> _points(CrmState state) {
    final points = <(LatLng, String, String, bool)>[];
    for (final session in state.deliveryTracking) {
      if (session.lat == null || session.lng == null) continue;
      points.add((
        LatLng(session.lat!, session.lng!),
        session.courierName,
        'En reparto${session.orderId.isEmpty ? '' : ' · pedido ${session.orderId}'}',
        true,
      ));
    }
    if (_showOrders) {
      for (final order in state.deliveryOrders) {
        final delivery = mapv(order['delivery']);
        final location = mapv(delivery['location']);
        final lat = location['latitude'];
        final lng = location['longitude'];
        if (lat is! num || lng is! num) continue;
        points.add((
          LatLng(lat.toDouble(), lng.toDouble()),
          str(order['name'], str(order['customer_name'], 'Pedido')),
          str(order['address'], str(location['address'], str(order['location'], 'Para repartir'))),
          false,
        ));
      }
    }
    return points;
  }

  void _fit(List<(LatLng, String, String, bool)> points) {
    if (points.isEmpty) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (points.length == 1) {
        _map.move(points.first.$1, 15);
        return;
      }
      try {
        _map.fitCamera(
          CameraFit.coordinates(
            coordinates: points.map((point) => point.$1).toList(),
            padding: const EdgeInsets.all(48),
          ),
        );
      } catch (_) {
        // Si el mapa aún no tiene tamaño, se queda en el centro por defecto.
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;
    final points = _points(state);
    final sessions = state.deliveryTracking;
    final orders = state.deliveryOrders;
    _fit(points);

    return Column(
      children: [
        CrmPageHeader(
          title: 'Mapa',
          subtitle: sessions.isEmpty ? 'Sin repartos en vivo' : '${sessions.length} repartos en vivo · ${points.length} puntos',
          actions: [
            IconButton(
              tooltip: 'Ver todos los puntos',
              onPressed: () => _fit(points),
              icon: const Icon(Icons.center_focus_strong_rounded),
            ),
            IconButton(
              tooltip: 'Actualizar',
              onPressed: state.loading ? null : () => state.refresh(),
              icon: const Icon(Icons.refresh_rounded),
            ),
          ],
        ),
        SizedBox(
          height: context.isDesktop ? 360 : 260,
          child: Stack(
            children: [
              FlutterMap(
                mapController: _map,
                options: MapOptions(
                  initialCenter: points.isEmpty ? _fallback : points.first.$1,
                  initialZoom: points.isEmpty ? 12 : 14,
                  minZoom: 4,
                  maxZoom: 18,
                  interactionOptions: const InteractionOptions(flags: InteractiveFlag.all & ~InteractiveFlag.rotate),
                ),
                children: [
                  TileLayer(
                    urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                    userAgentPackageName: 'lat.fulltech.fulltech_crm',
                    maxZoom: 19,
                  ),
                  MarkerLayer(
                    markers: [
                      for (final point in points)
                        Marker(
                          point: point.$1,
                          width: 38,
                          height: 38,
                          child: Tooltip(
                            message: '${point.$2} · ${point.$3}',
                            child: GestureDetector(
                              onTap: () => _showPoint(point.$2, point.$3, point.$1),
                              child: _Marker(color: point.$4 ? p.whatsapp : p.primary, live: point.$4),
                            ),
                          ),
                        ),
                    ],
                  ),
                ],
              ),
              Positioned(
                left: 8,
                bottom: 6,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  color: Colors.white.withValues(alpha: 0.82),
                  child: const Text('© OpenStreetMap', style: TextStyle(fontSize: 9.5, color: CrmColors.ink)),                ),
              ),
              Positioned(
                right: 10,
                top: 10,
                child: FilterChip(
                  label: Text(_showOrders ? 'Pedidos: sí' : 'Pedidos: no', style: const TextStyle(fontSize: 11.5)),
                  selected: _showOrders,
                  onSelected: (value) => setState(() => _showOrders = value),
                  backgroundColor: p.surface,
                  selectedColor: p.primarySoft,
                  side: BorderSide(color: p.border),
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: state.refresh,
            child: ListView(
              padding: const EdgeInsets.only(top: 8, bottom: 24),
              children: [
                SectionCard(
                  title: 'Repartos en vivo',
                  trailing: Text('${sessions.length}', style: TextStyle(fontSize: 11.5, color: p.inkSecondary)),
                  child: sessions.isEmpty
                      ? Text(
                          'Ningún repartidor está compartiendo posición ahora mismo.',
                          style: TextStyle(fontSize: 12.5, color: p.inkSecondary),
                        )
                      : Column(
                          children: [
                            for (final session in sessions)
                              _SessionRow(session: session, onOpen: (point) => _map.move(point, 16)),
                          ],
                        ),
                ),
                SectionCard(
                  title: 'Pedidos para reparto',
                  trailing: Text('${orders.length}', style: TextStyle(fontSize: 11.5, color: p.inkSecondary)),
                  child: orders.isEmpty
                      ? Text('No hay pedidos en la cola de reparto.', style: TextStyle(fontSize: 12.5, color: p.inkSecondary))
                      : Column(
                          children: [
                            for (final order in orders.take(30))
                              CrmListTile(
                                title: str(order['name'], str(order['customer_name'], 'Pedido')),
                                subtitle: [
                                  if (str(order['location'], str(order['address'])).isNotEmpty)
                                    str(order['location'], str(order['address'])),
                                  if (str(order['status']).isNotEmpty) str(order['status']),
                                ].join(' · '),
                                leading: CrmAvatar(label: str(order['name'], 'P'), icon: Icons.place_outlined),
                                trailing: StatusPill(label: str(order['status'], 'pendiente'), dense: true),
                              ),
                          ],
                        ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  void _showPoint(String title, String subtitle, LatLng point) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.place_outlined),
              title: Text(title),
              subtitle: Text(subtitle),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: CrmButton(
                label: 'Abrir en el mapa del sistema',
                icon: Icons.map_outlined,
                expand: true,
                onPressed: () => launchUrl(
                  Uri.parse('https://maps.google.com/?q=${point.latitude},${point.longitude}'),
                  mode: LaunchMode.externalApplication,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Marker extends StatelessWidget {
  const _Marker({required this.color, required this.live});

  final Color color;
  final bool live;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
        border: Border.all(color: Colors.white, width: 2.5),
        boxShadow: const [BoxShadow(color: Color(0x40000000), blurRadius: 6, offset: Offset(0, 2))],
      ),
      alignment: Alignment.center,
      child: Icon(live ? Icons.delivery_dining_rounded : Icons.home_work_outlined, size: 18, color: Colors.white),
    );
  }
}

class _SessionRow extends StatelessWidget {
  const _SessionRow({required this.session, required this.onOpen});

  final DeliverySession session;
  final ValueChanged<LatLng> onOpen;

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final hasPosition = session.lat != null && session.lng != null;
    final point = hasPosition ? LatLng(session.lat!, session.lng!) : null;
    return Column(
      children: [
        CrmListTile(
          title: session.courierName,
          subtitle: [
            session.orderId.isEmpty ? 'Sin pedido' : 'Pedido ${session.orderId}',
            hasPosition ? '${session.lat!.toStringAsFixed(4)}, ${session.lng!.toStringAsFixed(4)}' : 'Sin posición',
            CrmFormat.ago(session.updatedAt),
          ].join(' · '),
          leading: CrmAvatar(
            label: session.courierName,
            icon: Icons.my_location_rounded,
            tone: hasPosition ? p.success : p.inkSecondary,
          ),
          trailing: StatusPill(label: session.status, dense: true),
          onTap: point == null ? null : () => onOpen(point),
        ),
        if (point != null)
          Padding(
            padding: const EdgeInsets.only(left: 54, bottom: 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Wrap(
                spacing: 8,
                children: [
                  CrmButton(label: 'Centrar', icon: Icons.my_location_rounded, filled: false, onPressed: () => onOpen(point)),
                  CrmButton(
                    label: 'Abrir',
                    icon: Icons.open_in_new_rounded,
                    filled: false,
                    tone: p.inkSecondary,
                    onPressed: () => launchUrl(
                      Uri.parse('https://maps.google.com/?q=${point.latitude},${point.longitude}'),
                      mode: LaunchMode.externalApplication,
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
