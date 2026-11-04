import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/format/crm_format.dart';
import '../../../core/net/api_client.dart';
import '../../../data/crm_repository.dart';
import '../../../data/models/crm_models.dart';
import '../../common/crm_ui.dart';
import 'chat_desktop_theme.dart';

/// Columna de PEDIDOS del cliente (izquierda del hilo, ~30 % del ancho).
///
/// Abre en el **pedido en curso** (el abierto más reciente) con su estado y sus
/// líneas, y desde ahí se puede ver la lista completa. Mismos datos que el panel
/// web; nada inventado.
class ChatOrdersPanel extends StatefulWidget {
  const ChatOrdersPanel({
    super.key,
    required this.width,
    required this.onClose,
    required this.repository,
    required this.customerId,
    required this.customerName,
    this.onEditOrder,
  });

  final double width;
  final VoidCallback onClose;
  final CrmRepository repository;
  final String customerId;
  final String customerName;

  /// Abre el pedido en la pantalla de facturación/ventas para editarlo.
  final ValueChanged<String>? onEditOrder;

  @override
  State<ChatOrdersPanel> createState() => _ChatOrdersPanelState();
}

class _ChatOrdersPanelState extends State<ChatOrdersPanel> {
  bool _loading = true;
  bool _verTodos = false;
  String? _error;
  List<Map<String, dynamic>> _pedidos = const [];
  Map<String, dynamic> _detalle = const {};
  Map<String, dynamic> _cliente = const {};
  Map<String, dynamic> _ubicacion = const {};
  String _seleccionado = '';

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    if (widget.customerId.isEmpty) {
      setState(() {
        _loading = false;
        _error = 'Esta conversación no tiene cliente asociado.';
      });
      return;
    }
    try {
      final perfil = await widget.repository.customer(widget.customerId);
      final compras = listv(perfil['purchases']).map(mapv).toList()
        ..sort((a, b) => str(b['created_at']).compareTo(str(a['created_at'])));
      if (!mounted) return;
      final abiertos = compras.where(_abierto).toList();
      setState(() {
        _pedidos = compras;
        _cliente = mapv(perfil['customer']);
        _ubicacion = mapv(perfil['lastLocation']);
        /*
         * Si hay UN solo pedido sin finalizar se entra directo a su detalle; con
         * varios (o ninguno) manda la lista, que es donde se elige.
         */
        _verTodos = abiertos.length != 1;
        _loading = false;
      });
      if (abiertos.length == 1) await _abrirDetalle(str(abiertos.first['id']));
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = error.message;
      });
    }
  }

  Future<void> _abrirDetalle(String orderId) async {
    if (orderId.isEmpty) return;
    setState(() {
      _seleccionado = orderId;
      _detalle = const {};
    });
    try {
      final data = await widget.repository.order(orderId);
      if (!mounted) return;
      setState(() => _detalle = mapv(data['order']));
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    }
  }

  bool _abierto(Map<String, dynamic> pedido) {
    final estado = str(pedido['status']).toLowerCase();
    return estado != 'entregado' && estado != 'cancelado' && estado != 'perdido';
  }

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final fondo = c.dark ? const Color(0xFF171A1B) : Colors.white;
    return Material(
      color: fondo,
      child: Container(
        width: widget.width,
        decoration: BoxDecoration(
          color: fondo,
          border: Border(left: BorderSide(color: c.divider)),
          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.22), blurRadius: 28, offset: const Offset(-10, 0))],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _PanelHead(
              icon: Icons.shopping_cart_outlined,
              title: 'Pedidos',
              subtitle: widget.customerName,
              onClose: widget.onClose,
              action: _pedidos.isEmpty
                  ? null
                  : FilledButton.tonalIcon(
                      onPressed: () => setState(() => _verTodos = !_verTodos),
                      icon: Icon(_verTodos ? Icons.receipt_long_outlined : Icons.list_alt_rounded, size: 16),
                      label: Text(_verTodos ? 'Ver el actual' : 'Ver lista (${_pedidos.length})'),
                      style: FilledButton.styleFrom(
                        visualDensity: VisualDensity.compact,
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        backgroundColor: c.accent.withValues(alpha: 0.14),
                        foregroundColor: c.accent,
                        textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700),
                      ),
                    ),
            ),
            Divider(height: 1, color: c.divider),
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                  : _error != null
                      ? _ErrorText(message: _error!)
                      : _pedidos.isEmpty
                          ? Center(
                              child: Text(
                                'Este cliente todavía no tiene pedidos.',
                                style: TextStyle(fontSize: 13, color: c.textSecondary),
                              ),
                            )
                          : _verTodos
                              ? _lista(context)
                              : _detalleVista(context),
            ),
          ],
        ),
      ),
    );
  }

  Widget _lista(BuildContext context) {
    final c = ChatPalette.of(context);
    final abiertos = _pedidos.where(_abierto).toList();
    final cerrados = _pedidos.where((row) => !_abierto(row)).toList();
    return ListView(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 20),
      children: [
        if (abiertos.isNotEmpty) ...[
          _SectionLabel(label: 'Pendientes', count: abiertos.length, color: c.accent),
          for (final pedido in abiertos) _filaPedido(context, pedido),
        ],
        if (cerrados.isNotEmpty) ...[
          const SizedBox(height: 6),
          _SectionLabel(label: 'Historial', count: cerrados.length, color: c.textSecondary),
          for (final pedido in cerrados) _filaPedido(context, pedido),
        ],
      ],
    );
  }

  Widget _filaPedido(BuildContext context, Map<String, dynamic> pedido) {
    final c = ChatPalette.of(context);
    final elegido = str(pedido['id']) == _seleccionado;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: elegido ? c.accent.withValues(alpha: 0.08) : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () {
            setState(() => _verTodos = false);
            _abrirDetalle(str(pedido['id']));
          },
          child: Container(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(10),
              border: Border.all(
                color: elegido ? c.accent.withValues(alpha: 0.45) : c.divider,
              ),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        str(pedido['order_number'], str(pedido['id'])),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontFamily: ChatDesktopMetrics.fontFamily,
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          color: c.textPrimary,
                        ),
                      ),
                      Text(
                        '${CrmFormat.dayFull(pedido['created_at'])} · ${str(pedido['status'], '—')}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontFamily: ChatDesktopMetrics.fontFamily,
                          fontSize: 11.5,
                          color: c.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
                Text(
                  CrmFormat.money(num.tryParse('${pedido['total'] ?? 0}') ?? 0),
                  style: TextStyle(
                    fontFamily: ChatDesktopMetrics.fontFamily,
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: c.textPrimary,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _detalleVista(BuildContext context) {
    final c = ChatPalette.of(context);
    if (_detalle.isEmpty) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    }
    final lineas = listv(_detalle['items']).map(mapv).toList();
    num total = 0;
    for (final linea in lineas) {
      total += num.tryParse('${linea['total'] ?? linea['subtotal'] ?? 0}') ?? 0;
    }
    if (total == 0) total = num.tryParse('${_detalle['total'] ?? 0}') ?? 0;
    final abierto = _abierto(_detalle);
    final entrega = mapv(_detalle['delivery']);
    final subtotal = _subtotal > 0 ? _subtotal : total;
    final descuento = _descuento;
    final envio = _envio;
    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 24),
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                str(_detalle['order_number'], _seleccionado),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontFamily: ChatDesktopMetrics.fontFamily,
                  fontSize: 15,
                  fontWeight: FontWeight.w800,
                  color: c.textPrimary,
                ),
              ),
            ),
            _Estado(estado: str(_detalle['status'], '—'), abierto: abierto),
          ],
        ),
        const SizedBox(height: 2),
        Text(
          CrmFormat.dayFull(_detalle['created_at']),
          style: TextStyle(fontFamily: ChatDesktopMetrics.fontFamily, fontSize: 11.5, color: c.textSecondary),
        ),
        const SizedBox(height: 14),
        const _Label(texto: 'DETALLE'),
        const SizedBox(height: 6),
        for (final linea in lineas)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    '${str(linea['variantName'], str(linea['label'], 'Producto'))} × ${linea['quantity'] ?? 1}',
                    style: TextStyle(
                      fontFamily: ChatDesktopMetrics.fontFamily,
                      fontSize: 12.6,
                      height: 1.3,
                      color: c.textPrimary,
                    ),
                  ),
                ),
                Text(
                  CrmFormat.money(num.tryParse('${linea['total'] ?? linea['subtotal'] ?? 0}') ?? 0),
                  style: TextStyle(
                    fontFamily: ChatDesktopMetrics.fontFamily,
                    fontSize: 12.6,
                    fontWeight: FontWeight.w600,
                    color: c.textPrimary,
                  ),
                ),
              ],
            ),
          ),
        Divider(height: 20, color: c.divider),
        const _Label(texto: 'PAGO'),
        const SizedBox(height: 6),
        _DatoLinea(etiqueta: 'Productos', valor: CrmFormat.money(subtotal)),
        if (descuento > 0) _DatoLinea(etiqueta: 'Descuento', valor: '-${CrmFormat.money(descuento)}'),
        _DatoLinea(etiqueta: 'Delivery', valor: envio > 0 ? CrmFormat.money(envio) : 'Sin costo'),
        _DatoLinea(etiqueta: 'Total', valor: CrmFormat.money(total), fuerte: true),
        _DatoLinea(etiqueta: 'Forma de pago', valor: _metodoPago()),
        _DatoLinea(etiqueta: 'Estado del pago', valor: _estadoPago(), fuerte: _porCobrar(total) > 0),
        if (_porCobrar(total) > 0)
          _DatoLinea(etiqueta: 'Por cobrar', valor: CrmFormat.money(_porCobrar(total)), fuerte: true),

        /*
         * ENTREGA: método real del pedido (`delivery.method`: delivery, pickup,
         * etc.), dirección, referencia y cuándo está programado. Debajo va la
         * UBICACIÓN: mapa si hay coordenadas del pedido o del cliente, y si no
         * un aviso claro en vez de un hueco vacío.
         */
        const SizedBox(height: 14),
        const _Label(texto: 'ENTREGA'),
        const SizedBox(height: 6),
        _DatoLinea(etiqueta: 'Tipo', valor: _metodoEntrega()),
        if (str(entrega['address']).isNotEmpty) _DatoLinea(etiqueta: 'Dirección', valor: str(entrega['address'])),
        if (str(entrega['city']).isNotEmpty) _DatoLinea(etiqueta: 'Ciudad', valor: str(entrega['city'])),
        if (str(entrega['reference']).isNotEmpty) _DatoLinea(etiqueta: 'Referencia', valor: str(entrega['reference'])),
        if (str(entrega['driver_name'], str(entrega['driver'])).isNotEmpty)
          _DatoLinea(etiqueta: 'Repartidor', valor: str(entrega['driver_name'], str(entrega['driver']))),
        if (str(entrega['scheduled_at']).isNotEmpty)
          _DatoLinea(etiqueta: 'Programado', valor: CrmFormat.dayFull(entrega['scheduled_at'])),
        if (str(entrega['note'], str(entrega['notes'])).isNotEmpty)
          _DatoLinea(etiqueta: 'Indicaciones', valor: str(entrega['note'], str(entrega['notes']))),
        if (str(_detalle['notes']).isNotEmpty) _DatoLinea(etiqueta: 'Comentario', valor: str(_detalle['notes'])),
        if (str(_cliente['name']).isNotEmpty) _DatoLinea(etiqueta: 'Cliente', valor: str(_cliente['name'])),
        if (str(_cliente['phone_e164'], str(_cliente['phone'])).isNotEmpty)
          _DatoLinea(etiqueta: 'Teléfono', valor: str(_cliente['phone_e164'], str(_cliente['phone']))),

        const SizedBox(height: 14),
        const _Label(texto: 'UBICACIÓN'),
        const SizedBox(height: 6),
        if (_punto() != null) ...[
          ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: SizedBox(
              height: 170,
              child: FlutterMap(
                options: MapOptions(
                  initialCenter: _punto()!,
                  initialZoom: 15.5,
                  interactionOptions: const InteractionOptions(flags: InteractiveFlag.none),
                ),
                children: [
                  TileLayer(
                    urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                    userAgentPackageName: 'com.fulltech.crm',
                  ),
                  MarkerLayer(
                    markers: [
                      Marker(
                        point: _punto()!,
                        width: 34,
                        height: 34,
                        child: Icon(Icons.location_on, size: 34, color: c.accent),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Expanded(
                child: Text(
                  _etiquetaUbicacion(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: ChatDesktopMetrics.fontFamily,
                    fontSize: 11,
                    color: c.textSecondary,
                  ),
                ),
              ),
              TextButton.icon(
                onPressed: _abrirEnMapas,
                icon: const Icon(Icons.map_outlined, size: 16),
                label: const Text('Abrir mapa', style: TextStyle(fontSize: 12)),
                style: TextButton.styleFrom(
                  foregroundColor: c.accent,
                  visualDensity: VisualDensity.compact,
                ),
              ),
            ],
          ),
        ] else
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: c.fieldBg,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: c.divider),
            ),
            child: Row(
              children: [
                Icon(Icons.location_off_outlined, size: 18, color: c.textSecondary),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    _textoSinUbicacion(),
                    style: TextStyle(
                      fontFamily: ChatDesktopMetrics.fontFamily,
                      fontSize: 11.5,
                      height: 1.35,
                      color: c.textSecondary,
                    ),
                  ),
                ),
              ],
            ),
          ),

        /*
         * EDITAR: vuelve a la pantalla de facturación con el pedido cargado.
         * Mientras el POS no acepte un pedido existente, se abre el módulo de
         * ventas; el aviso lo dice para no prometer lo que no hace.
         */
        if (abierto) ...[
          const SizedBox(height: 16),
          SizedBox(
            height: 46,
            child: FilledButton.icon(
              onPressed: () {
                widget.onEditOrder?.call(_seleccionado);
                widget.onClose();
              },
              icon: const Icon(Icons.edit_outlined, size: 18),
              label: const Text('Editar pedido', style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700)),
              style: FilledButton.styleFrom(
                backgroundColor: c.accent,
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
            ),
          ),
        ],
      ],
    );
  }

  num _pagado(num total) {
    if (_estadoPagoClave() == 'paid') return total;
    final pago = mapv(_detalle['payment']);
    return num.tryParse('${pago['paid'] ?? pago['received'] ?? 0}') ?? 0;
  }

  num _porCobrar(num total) {
    final clave = _estadoPagoClave();
    if (clave == 'paid' || clave == 'void') return 0;
    final pago = mapv(_detalle['payment']);
    final explicito = num.tryParse('${pago['pending'] ?? pago['balance'] ?? _detalle['balance_due'] ?? ''}');
    if (explicito != null && explicito > 0) return explicito;
    final resta = total - _pagado(total);
    return resta > 0 ? resta : 0;
  }

  num get _subtotal => num.tryParse('${_detalle['subtotal'] ?? 0}') ?? 0;

  num get _descuento => num.tryParse('${_detalle['discount'] ?? 0}') ?? 0;

  num get _envio =>
      num.tryParse('${_detalle['delivery_fee'] ?? mapv(_detalle['delivery'])['fee'] ?? 0}') ?? 0;

  String _estadoPagoClave() {
    final estado = str(_detalle['payment_status']).toLowerCase();
    if (estado.isEmpty) {
      // Pedidos sin estado explícito: se deduce de si ya están entregados.
      return str(_detalle['status']).toLowerCase() == 'entregado' ? 'paid' : 'pending';
    }
    return estado;
  }

  /// Estado del pago tal y como lo entiende el equipo, no el código interno.
  String _estadoPago() {
    switch (_estadoPagoClave()) {
      case 'paid':
        return 'Pagado';
      case 'partial':
        return 'Pago parcial';
      case 'void':
      case 'cancelled':
        return 'Anulado';
      case 'refunded':
        return 'Reembolsado';
      default:
        return 'Pendiente de pago';
    }
  }

  /// `CASH` → «Efectivo»: el pedido trae la etiqueta del servidor, pero si no
  /// viene se traduce aquí para no enseñar códigos internos al equipo.
  String _metodoPago() {
    final etiqueta = str(_detalle['payment_method_label']);
    if (etiqueta.isNotEmpty) return etiqueta;
    switch (str(_detalle['payment_method']).toUpperCase()) {
      case 'CASH':
        return 'Efectivo';
      case 'TRANSFER':
      case 'BANK_TRANSFER':
        return 'Transferencia';
      case 'CARD':
        return 'Tarjeta';
      case 'BIZUM':
        return 'Bizum';
      case '':
        return '—';
      default:
        return str(_detalle['payment_method']);
    }
  }

  String _metodoEntrega() {
    final entrega = mapv(_detalle['delivery']);
    switch (str(entrega['method']).toLowerCase()) {
      case 'pickup':
      case 'recogida':
        return 'Recoger en tienda';
      case 'delivery':
      case 'envio':
      case 'domicilio':
        return 'Delivery a domicilio';
      case '':
        return 'Sin definir';
      default:
        return str(entrega['method']);
    }
  }

  String _etiquetaUbicacion() {
    final entrega = mapv(_detalle['delivery']);
    final loc = mapv(entrega['location']);
    final fecha = str(loc['captured_at'] ?? _ubicacion['created_at']);
    final nombre = str(loc['name'] ?? _ubicacion['name']);
    final base = nombre.isEmpty ? 'Ubicación compartida por el cliente' : nombre;
    return fecha.isEmpty ? base : '$base · ${CrmFormat.dayFull(fecha)}';
  }

  String _textoSinUbicacion() {
    final entrega = mapv(_detalle['delivery']);
    final direccion = str(entrega['address']);
    if (direccion.isNotEmpty) return 'Sin coordenadas en el mapa. Dirección: $direccion';
    if (str(_detalle['delivery']).isNotEmpty && _metodoEntrega() == 'Recoger en tienda') {
      return 'El cliente recoge en la tienda: este pedido no lleva dirección ni mapa.';
    }
    return 'El cliente todavía no ha compartido su ubicación por WhatsApp.';
  }

  /// Punto del mapa: ubicación del pedido y, si no la trae, la última que el
  /// cliente compartió por WhatsApp. Sin coordenadas válidas no se pinta nada.
  LatLng? _punto() {
    final entrega = mapv(_detalle['delivery']);
    final loc = mapv(entrega['location']);
    final lat = num.tryParse('${loc['lat'] ?? loc['latitude'] ?? _ubicacion['latitude'] ?? ''}');
    final lng = num.tryParse('${loc['lng'] ?? loc['longitude'] ?? _ubicacion['longitude'] ?? ''}');
    if (lat == null || lng == null) return null;
    if (lat.abs() < 0.001 && lng.abs() < 0.001) return null;
    return LatLng(lat.toDouble(), lng.toDouble());
  }

  Future<void> _abrirEnMapas() async {
    final punto = _punto();
    if (punto == null) return;
    final uri = Uri.parse(
      'https://www.google.com/maps/search/?api=1&query=${punto.latitude},${punto.longitude}',
    );
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }
}

/// Columna de FICHA DEL CLIENTE (izquierda del hilo, ~40 % del ancho).
class ChatCustomerPanel extends StatefulWidget {
  const ChatCustomerPanel({
    super.key,
    required this.width,
    required this.onClose,
    required this.repository,
    required this.customerId,
  });

  final double width;
  final VoidCallback onClose;
  final CrmRepository repository;
  final String customerId;

  @override
  State<ChatCustomerPanel> createState() => _ChatCustomerPanelState();
}

class _ChatCustomerPanelState extends State<ChatCustomerPanel> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic> _cliente = const {};
  Map<String, dynamic> _totales = const {};
  Map<String, dynamic> _seguimiento = const {};
  Map<String, dynamic> _ultimaUbicacion = const {};
  List<Map<String, dynamic>> _historial = const [];
  List<String> _etiquetas = const [];
  int _programados = 0;
  bool _ventanaAbierta = false;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  ///
  /// La ficha muestra TODO el expediente salvo dos cosas, porque ya están en otra
  /// parte del chat: las **conversaciones** (viven en el hilo) y los **pedidos**
  /// (viven en el carrito). Del historial se descartan mensajes, pedidos, entregas
  /// y recogidas; quedan seguimientos, cotizaciones, facturas y garantías.
  static const Set<String> _fueraDelHistorial = {
    'message_in',
    'message_out',
    'order',
    'delivery',
    'pickup',
  };

  Future<void> _cargar() async {
    if (widget.customerId.isEmpty) {
      setState(() {
        _loading = false;
        _error = 'Esta conversación no tiene cliente asociado.';
      });
      return;
    }
    try {
      final perfil = await widget.repository.customer(widget.customerId);
      if (!mounted) return;
      final cliente = mapv(perfil['customer']);
      final historia = listv(perfil['history']).map(mapv).where((evento) {
        return !_fueraDelHistorial.contains(str(evento['type']));
      }).toList();
      setState(() {
        _cliente = cliente;
        _totales = mapv(perfil['totals']);
        _seguimiento = mapv(perfil['nextFollowup']);
        _ultimaUbicacion = mapv(perfil['lastLocation']);
        _historial = historia;
        _etiquetas = listv(cliente['tags'])
            .map((row) => str(mapv(row)['label']))
            .where((label) => label.isNotEmpty)
            .toList();
        _programados = listv(perfil['scheduled']).length;
        _ventanaAbierta = perfil['canSendFreeText'] == true;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = error.message;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final fondo = c.dark ? const Color(0xFF171A1B) : Colors.white;
    final nombre = str(_cliente['name'], 'Cliente');
    final etapa = _etapa(_cliente);
    final compras = _entero(_totales['total_purchases']);
    final gastado = num.tryParse('${_totales['total_spent'] ?? 0}') ?? 0;
    final abiertos = _entero(_totales['open_purchases']);
    final ticket = compras > 0 ? gastado / compras : 0;
    final creado = CrmFormat.dayFull(_cliente['created_at']);
    final noContactar = _cliente['do_not_contact'] == true;
    final motivoEtapa = str(_cliente['customer_stage_reason']);
    final interes = str(_cliente['interest_reason']);
    final proximo = str(_seguimiento['scheduled_at']);
    return Material(
      color: fondo,
      child: Container(
        width: widget.width,
        decoration: BoxDecoration(
          color: fondo,
          border: Border(left: BorderSide(color: c.divider)),
          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.22), blurRadius: 28, offset: const Offset(-10, 0))],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _PanelHead(
              icon: Icons.person_outline_rounded,
              title: 'Ficha del cliente',
              subtitle: nombre,
              onClose: widget.onClose,
            ),
            Divider(height: 1, color: c.divider),
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                  : _error != null
                      ? _ErrorText(message: _error!)
                      : ListView(
                          padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
                          children: [
                            Row(
                              children: [
                                CrmAvatar(label: nombre.isEmpty ? 'FT' : nombre.substring(0, 1).toUpperCase()),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Text(
                                        nombre,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: TextStyle(
                                          fontFamily: ChatDesktopMetrics.fontFamily,
                                          fontSize: 15,
                                          fontWeight: FontWeight.w800,
                                          color: c.textPrimary,
                                        ),
                                      ),
                                      Text(
                                        str(_cliente['phone_e164'], 'Sin teléfono'),
                                        style: TextStyle(
                                          fontFamily: ChatDesktopMetrics.fontFamily,
                                          fontSize: 12,
                                          color: c.textSecondary,
                                        ),
                                      ),
                                      if (etapa.isNotEmpty)
                                        Padding(
                                          padding: const EdgeInsets.only(top: 4),
                                          child: _Estado(estado: etapa, abierto: !noContactar),
                                        ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 16),
                            /* LO COMERCIAL, EN NÚMEROS. */
                            Row(
                              children: [
                                Expanded(child: _Kpi(valor: CrmFormat.money(gastado), etiqueta: 'Comprado')),
                                Expanded(child: _Kpi(valor: '$compras', etiqueta: compras == 1 ? 'Pedido' : 'Pedidos')),
                                Expanded(child: _Kpi(valor: ticket > 0 ? CrmFormat.money(ticket) : '—', etiqueta: 'Ticket medio')),
                              ],
                            ),
                            const SizedBox(height: 14),
                            const _Label(texto: 'CONTACTO'),
                            const SizedBox(height: 4),
                            _DatoLinea(etiqueta: 'Teléfono', valor: str(_cliente['phone_e164'], '—')),
                            if (str(_cliente['email']).isNotEmpty)
                              _DatoLinea(etiqueta: 'Correo', valor: str(_cliente['email'])),
                            _DatoLinea(etiqueta: 'Ciudad', valor: str(_cliente['location'], '—')),
                            if (creado.isNotEmpty) _DatoLinea(etiqueta: 'Cliente desde', valor: creado),
                            _DatoLinea(etiqueta: 'No contactar', valor: noContactar ? 'Sí' : 'No'),
                            _DatoLinea(etiqueta: 'WhatsApp', valor: _ventanaAbierta ? 'Ventana abierta' : 'Solo plantillas'),
                            const SizedBox(height: 14),
                            const _Label(texto: 'ESTADO COMERCIAL'),
                            const SizedBox(height: 4),
                            _DatoLinea(etiqueta: 'Etapa', valor: etapa.isEmpty ? '—' : etapa, fuerte: true),
                            if (motivoEtapa.isNotEmpty) _DatoLinea(etiqueta: 'Motivo', valor: motivoEtapa),
                            if (interes.isNotEmpty) _DatoLinea(etiqueta: 'Interés', valor: interes),
                            _DatoLinea(etiqueta: 'Pedidos abiertos', valor: '$abiertos'),
                            if (str(_totales['last_purchase_at']).isNotEmpty)
                              _DatoLinea(etiqueta: 'Última compra', valor: CrmFormat.dayFull(_totales['last_purchase_at'])),
                            if (str(_totales['last_order_at']).isNotEmpty)
                              _DatoLinea(etiqueta: 'Último pedido', valor: CrmFormat.dayFull(_totales['last_order_at'])),
                            if (_etiquetas.isNotEmpty) ...[
                              const SizedBox(height: 12),
                              const _Label(texto: 'ETIQUETAS'),
                              const SizedBox(height: 6),
                              Wrap(
                                spacing: 6,
                                runSpacing: 6,
                                children: [
                                  for (final etiqueta in _etiquetas)
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                                      decoration: BoxDecoration(
                                        color: c.accent.withValues(alpha: 0.12),
                                        borderRadius: BorderRadius.circular(999),
                                      ),
                                      child: Text(
                                        etiqueta,
                                        style: TextStyle(
                                          fontFamily: ChatDesktopMetrics.fontFamily,
                                          fontSize: 11,
                                          fontWeight: FontWeight.w600,
                                          color: c.accent,
                                        ),
                                      ),
                                    ),
                                ],
                              ),
                            ],
                            const SizedBox(height: 14),
                            const _Label(texto: 'SEGUIMIENTO'),
                            const SizedBox(height: 4),
                            _DatoLinea(
                              etiqueta: 'Próximo',
                              valor: proximo.isNotEmpty ? CrmFormat.dayFull(proximo) : 'Sin seguimiento pendiente',
                            ),
                            _DatoLinea(etiqueta: 'Programados', valor: '$_programados'),
                            if (str(_cliente['notes']).isNotEmpty) ...[
                              const SizedBox(height: 14),
                              const _Label(texto: 'NOTAS'),
                              const SizedBox(height: 4),
                              Text(
                                str(_cliente['notes']),
                                style: TextStyle(
                                  fontFamily: ChatDesktopMetrics.fontFamily,
                                  fontSize: 12.6,
                                  height: 1.35,
                                  color: c.textPrimary,
                                ),
                              ),
                            ],
                            if (_historial.isNotEmpty) ...[
                              const SizedBox(height: 16),
                              const _Label(texto: 'MOVIMIENTOS (SIN CHATS NI PEDIDOS)'),
                              const SizedBox(height: 6),
                              for (final evento in _historial.take(10))
                                Padding(
                                  padding: const EdgeInsets.only(bottom: 8),
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        str(evento['title']),
                                        maxLines: 2,
                                        overflow: TextOverflow.ellipsis,
                                        style: TextStyle(
                                          fontFamily: ChatDesktopMetrics.fontFamily,
                                          fontSize: 12.4,
                                          height: 1.3,
                                          color: c.textPrimary,
                                        ),
                                      ),
                                      Text(
                                        CrmFormat.ago(evento['at']),
                                        style: TextStyle(
                                          fontFamily: ChatDesktopMetrics.fontFamily,
                                          fontSize: 11,
                                          color: c.textSecondary,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                            ],

                            /*
                             * UBICACIÓN: el mapa va al final, grande y con la
                             * dirección debajo. Si el cliente nunca compartió
                             * su ubicación se dice claramente, en vez de dejar
                             * el hueco vacío o inventar un punto.
                             */
                            const SizedBox(height: 18),
                            const _Label(texto: 'UBICACIÓN'),
                            const SizedBox(height: 8),
                            if (_puntoCliente() != null)
                              _MapaUbicacion(
                                punto: _puntoCliente()!,
                                titulo: str(_ultimaUbicacion['name'], 'Ubicación compartida'),
                                detalle: _direccionCliente(),
                                edad: CrmFormat.ago(_ultimaUbicacion['created_at']),
                                onAbrir: _abrirMapaCliente,
                              )
                            else
                              Container(
                                padding: const EdgeInsets.all(14),
                                decoration: BoxDecoration(
                                  color: c.fieldBg,
                                  borderRadius: BorderRadius.circular(14),
                                  border: Border.all(color: c.divider),
                                ),
                                child: Row(
                                  children: [
                                    Icon(Icons.location_off_outlined, size: 20, color: c.textSecondary),
                                    const SizedBox(width: 10),
                                    Expanded(
                                      child: Text(
                                        'Este cliente todavía no ha compartido su ubicación por WhatsApp.',
                                        style: TextStyle(
                                          fontFamily: ChatDesktopMetrics.fontFamily,
                                          fontSize: 12.5,
                                          height: 1.35,
                                          color: c.textSecondary,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                          ],
                        ),
            ),
          ],
        ),
      ),
    );
  }

  static int _entero(Object? value) {
    if (value is num) return value.toInt();
    return int.tryParse('${value ?? ''}') ?? 0;
  }

  /// Coordenadas de la última ubicación del cliente, si las hay y son válidas.
  LatLng? _puntoCliente() {
    final lat = num.tryParse('${_ultimaUbicacion['latitude'] ?? _ultimaUbicacion['lat'] ?? ''}');
    final lng = num.tryParse('${_ultimaUbicacion['longitude'] ?? _ultimaUbicacion['lng'] ?? ''}');
    if (lat == null || lng == null) return null;
    if (lat.abs() < 0.001 && lng.abs() < 0.001) return null;
    return LatLng(lat.toDouble(), lng.toDouble());
  }

  /// Dirección + coordenadas, sin repetir el nombre de la ubicación.
  String _direccionCliente() {
    final direccion = str(_ultimaUbicacion['address']);
    final punto = _puntoCliente();
    final coordenadas = punto == null
        ? ''
        : '${punto.latitude.toStringAsFixed(5)}, ${punto.longitude.toStringAsFixed(5)}';
    if (direccion.isNotEmpty && coordenadas.isNotEmpty) return '$direccion · $coordenadas';
    if (direccion.isNotEmpty) return direccion;
    return coordenadas;
  }

  Future<void> _abrirMapaCliente() async {
    final punto = _puntoCliente();
    if (punto == null) return;
    final uri = Uri.parse(
      'https://www.google.com/maps/search/?api=1&query=${punto.latitude},${punto.longitude}',
    );
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  /// Etapa en español, desde cualquiera de las tres claves que manda el servidor.
  static String _etapa(Map<String, dynamic> cliente) {
    final crudo = str(
      cliente['customer_stage'],
      str(cliente['customerStage'], str(cliente['stage'])),
    ).trim().toUpperCase();
    const etiquetas = {
      'NUEVO': 'Nuevo',
      'EN_CONVERSACION': 'En conversación',
      'PROSPECT': 'Prospecto',
      'PROSPECTOS': 'Prospecto',
      'INTERESTED': 'Interesado',
      'INTERESADO': 'Interesado',
      'PEDIDO_CREADO': 'Pedido creado',
      'CONFIRMADO': 'Confirmado',
      'ENTREGADO': 'Entregado',
      'SEGUIMIENTO': 'En seguimiento',
      'RECOMPRA': 'Recompra',
      'REPEAT_CUSTOMER': 'Recompra',
      'CUSTOMER': 'Cliente',
      'PERDIDO': 'Perdido',
      'INACTIVE': 'Inactivo',
    };
    if (crudo.isEmpty) return '';
    return etiquetas[crudo] ?? crudo.toLowerCase();
  }
}

class _Kpi extends StatelessWidget {
  const _Kpi({required this.valor, required this.etiqueta});

  final String valor;
  final String etiqueta;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          valor,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontFamily: ChatDesktopMetrics.fontFamily,
            fontSize: 15,
            fontWeight: FontWeight.w800,
            color: c.textPrimary,
          ),
        ),
        Text(
          etiqueta,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontFamily: ChatDesktopMetrics.fontFamily,
            fontSize: 10.5,
            color: c.textSecondary,
          ),
        ),
      ],
    );
  }
}

class _PanelHead extends StatelessWidget {
  const _PanelHead({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onClose,
    this.action,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onClose;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 12, 8, 10),
      child: Row(
        children: [
          Container(
            width: 30,
            height: 30,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: c.accent.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(9),
            ),
            child: Icon(icon, size: 17, color: c.accent),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: ChatDesktopMetrics.fontFamily,
                    fontSize: 14.5,
                    fontWeight: FontWeight.w800,
                    color: c.textPrimary,
                  ),
                ),
                if (subtitle.isNotEmpty)
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontFamily: ChatDesktopMetrics.fontFamily,
                      fontSize: 11.5,
                      color: c.textSecondary,
                    ),
                  ),
              ],
            ),
          ),
          if (action != null) ?action,
          IconButton(
            tooltip: 'Cerrar',
            visualDensity: VisualDensity.compact,
            iconSize: 18,
            color: c.textSecondary,
            onPressed: onClose,
            icon: const Icon(Icons.close_rounded),
          ),
        ],
      ),
    );
  }
}

class _Label extends StatelessWidget {
  const _Label({required this.texto});

  final String texto;
  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Text(
      texto,
      style: TextStyle(
        fontFamily: ChatDesktopMetrics.fontFamily,
        fontSize: 10.5,
        letterSpacing: 0.8,
        fontWeight: FontWeight.w800,
        color: c.textSecondary,
      ),
    );
  }
}

/// MAPA de la última ubicación del cliente.
///
/// Se pinta en grande al final de la ficha: mapa real (OpenStreetMap) con
/// marcador, el nombre del sitio y la edad de la ubicación encima, y la
/// dirección con las coordenadas debajo. Sin datos no se muestra: la ficha
/// enseña entonces un aviso, nunca un mapa vacío.
class _MapaUbicacion extends StatelessWidget {
  const _MapaUbicacion({
    required this.punto,
    required this.titulo,
    required this.detalle,
    required this.edad,
    required this.onAbrir,
  });

  final LatLng punto;
  final String titulo;
  final String detalle;
  final String edad;
  final Future<void> Function() onAbrir;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Container(
      decoration: BoxDecoration(
        color: c.fieldBg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: c.divider),
        boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 14, offset: const Offset(0, 4))],
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: 220,
            child: Stack(
              children: [
                Positioned.fill(
                  child: FlutterMap(
                    options: MapOptions(
                      initialCenter: punto,
                      initialZoom: 16,
                      interactionOptions: const InteractionOptions(flags: InteractiveFlag.none),
                    ),
                    children: [
                      TileLayer(
                        urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                        userAgentPackageName: 'com.fulltech.crm',
                      ),
                      MarkerLayer(
                        markers: [
                          Marker(
                            point: punto,
                            width: 40,
                            height: 40,
                            child: Icon(Icons.location_on, size: 40, color: c.accent),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                // Velo inferior para que la etiqueta se lea sobre el mapa.
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: Container(
                    padding: const EdgeInsets.fromLTRB(12, 18, 12, 10),
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [Colors.black.withValues(alpha: 0), Colors.black.withValues(alpha: 0.55)],
                      ),
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.place_outlined, size: 16, color: Colors.white.withValues(alpha: 0.9)),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            edad.isEmpty ? titulo : '$titulo · $edad',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontFamily: ChatDesktopMetrics.fontFamily,
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
                              color: Colors.white,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 8, 6),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    detalle.isEmpty ? 'Sin dirección registrada' : detalle,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontFamily: ChatDesktopMetrics.fontFamily,
                      fontSize: 12,
                      height: 1.35,
                      color: c.textSecondary,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                TextButton.icon(
                  onPressed: () => onAbrir(),
                  icon: const Icon(Icons.open_in_new_rounded, size: 15),
                  label: const Text('Abrir mapa', style: TextStyle(fontSize: 12)),
                  style: TextButton.styleFrom(
                    foregroundColor: c.accent,
                    visualDensity: VisualDensity.compact,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {  const _SectionLabel({required this.label, required this.count, required this.color});

  final String label;
  final int count;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8, left: 2),
      child: Row(
        children: [
          Text(
            label.toUpperCase(),
            style: TextStyle(
              fontFamily: ChatDesktopMetrics.fontFamily,
              fontSize: 10.5,
              letterSpacing: 0.8,
              fontWeight: FontWeight.w800,
              color: color,
            ),
          ),
          const SizedBox(width: 6),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(20),
            ),
            child: Text(
              '$count',
              style: TextStyle(
                fontFamily: ChatDesktopMetrics.fontFamily,
                fontSize: 10,
                fontWeight: FontWeight.w800,
                color: color,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _DatoLinea extends StatelessWidget {
  const _DatoLinea({required this.etiqueta, required this.valor, this.fuerte = false});

  final String etiqueta;
  final String valor;
  final bool fuerte;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 110,
            child: Text(
              etiqueta,
              style: TextStyle(
                fontFamily: ChatDesktopMetrics.fontFamily,
                fontSize: 12.4,
                color: c.textSecondary,
              ),
            ),
          ),
          Expanded(
            child: Text(
              valor,
              style: TextStyle(
                fontFamily: ChatDesktopMetrics.fontFamily,
                fontSize: fuerte ? 14 : 12.8,
                fontWeight: fuerte ? FontWeight.w800 : FontWeight.w600,
                color: c.textPrimary,
                height: 1.3,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Estado extends StatelessWidget {
  const _Estado({required this.estado, required this.abierto});

  final String estado;
  final bool abierto;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    final color = abierto ? c.accent : c.textSecondary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        estado,
        style: TextStyle(
          fontFamily: ChatDesktopMetrics.fontFamily,
          fontSize: 11,
          fontWeight: FontWeight.w700,
          color: color,
        ),
      ),
    );
  }
}

class _ErrorText extends StatelessWidget {
  const _ErrorText({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final c = ChatPalette.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Text(
          message,
          textAlign: TextAlign.center,
          style: TextStyle(fontFamily: ChatDesktopMetrics.fontFamily, fontSize: 12.5, color: c.danger),
        ),
      ),
    );
  }
}
