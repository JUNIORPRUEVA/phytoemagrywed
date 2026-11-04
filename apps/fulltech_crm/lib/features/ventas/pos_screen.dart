import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../app/crm_state.dart';
import '../../core/files/file_opener.dart';
import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../core/pos/pos_sale.dart';
import '../../core/theme/crm_theme.dart';
import '../../core/theme/crm_tokens.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../pos_desktop/pos_toast.dart';
import 'catalogo_screen.dart';
import 'cotizaciones_screen.dart';
import 'inventario_screen.dart';
import 'recogidas_screen.dart';
import 'recuento_screen.dart';
import '../pos_desktop/pos_cart_panel.dart';
import '../pos_desktop/pos_checkout_dialog.dart';
import '../pos_desktop/pos_customer_panel.dart';
import '../pos_desktop/pos_line_editors.dart';
import '../pos_desktop/pos_order_message_dialog.dart';
import '../pos_desktop/pos_tickets_panel.dart';
import 'pos_launch_context.dart';
import '../pos_desktop/pos_category_rail.dart';
import '../pos_desktop/pos_product_grid.dart';
import '../pos_desktop/pos_recent_sales_panel.dart';
import '../pos_desktop/pos_tokens.dart';
import '../pedidos/pedido_detail_screen.dart';

/// Punto de venta: cliente + artículos + cobro → pedido, factura o cotización.
///
/// Protecciones de dinero (Etapa 0):
/// · `expectedTotal` en CENTAVOS con las mismas reglas de redondeo del servidor.
/// · `requestId` estable: un reintento NO crea otro documento.
/// · `x-fulltech-operation` con la misma clave: el servidor deduplica.
/// · Sin respuesta → estado INCIERTO: nunca se reenvía solo; primero se consulta.
class PosScreen extends StatefulWidget {
  const PosScreen({
    super.key,
    this.embedded = false,
    this.desktop = false,
    this.initialQuote,
    this.initialSale,
    this.onNavigate,
  });

  /// Dentro del panel de escritorio (ya hay barra superior con el título).
  final bool embedded;

  /// Presentación de escritorio al estilo FullPOS: rejilla + panel de venta.
  /// La lógica (cobro, idempotencia, precios) es exactamente la misma.
  final bool desktop;

  /// Cotización que se va a cobrar (`GET /api/admin/pos/quotes` → fila).
  ///
  /// Al cobrar se manda `quoteId`: el servidor marca el documento como
  /// `converted` y rechaza el doble cobro aunque lleguen dos cajas a la vez.
  final Map<String, dynamic>? initialQuote;
  final PosLaunchContext? initialSale;

  /// Cambio de módulo desde el POS (los accesos viven ahora aquí, no en el
  /// menú lateral).
  final void Function(String tab)? onNavigate;

  @override
  State<PosScreen> createState() => _PosScreenState();
}

enum _PosDesktopPanel {
  createProduct,
  stock,
  quotes,
  count,
  pickups,
  onlineStore,
  customer,
  recentSales,
  tickets,
}

class _PosScreenState extends State<PosScreen>
    with SingleTickerProviderStateMixin {
  final GlobalKey _cartKey = GlobalKey();
  late final AnimationController _cartFlyController;
  OverlayEntry? _cartFlyEntry;
  Rect? _cartFlyFrom;
  Rect? _cartFlyTo;
  CatalogProduct? _flyingProduct;
  final _search = TextEditingController();
  final _productSearch = TextEditingController();
  final _address = TextEditingController();
  final _notes = TextEditingController();
  final _reference = TextEditingController();
  String _deliveryLocationId = '';
  Map<String, dynamic>? _deliveryLocation;
  String _deliveryQuoteId = '';
  int _deliveryQuotedFeeCents = 0;
  DateTime? _deliveryQuoteExpiresAt;
  String _quotedStoreId = '';
  String _quotedLocationId = '';
  DateTime? _scheduledAt;
  final PosOperation _operation = PosOperation();

  Customer? _customer;
  final List<PosLine> _lines = [];
  String _mode = 'order';
  String _method = 'CASH';
  String _deliveryMethod = 'delivery';
  bool _paid = false;
  double _deliveryFee = 0;

  /// Descuento general del ticket: `none` | `percent` | `amount`.
  String _discountType = 'none';
  double _discountValue = 0;

  /// Pedidos ABIERTOS del cliente elegido (`GET /api/admin/pos/context/:id`).
  /// Se muestran como aviso: el que impide el doble cobro sigue siendo el
  /// servidor, que responde `open_orders` y exige confirmación explícita.
  List<Map<String, dynamic>> _openOrders = const [];
  bool _loadingContext = false;
  String? _contextError;

  /// Ticket aparcado del que sale esta venta (vacío = venta nueva).
  String _ticketId = '';
  int _ticketVersion = 0;

  /// Cotización de origen (vacío = venta nueva).
  String _quoteId = '';
  bool _saving = false;
  bool _loadingQuotePdf = false;
  _PosDesktopPanel? _activePanel;
  bool _quickSaleOpen = false;
  final Set<String> _favoriteProductIds = {};
  List<Map<String, dynamic>> _catalogRows = const [];
  List<Map<String, dynamic>> _pickupStores = const [];
  List<Map<String, dynamic>> _productStoreLinks = const [];
  String _selectedPickupStoreId = '';
  List<PosTicketSummary> _tickets = const [];
  int? _sharedCapsules;
  bool _catalogLoading = true;
  PosRailFilter _railFilter = const PosRailFilter();

  @override
  void initState() {
    super.initState();
    if (widget.desktop) {
      _mode = 'invoice';
      _deliveryMethod = 'pickup';
      _paid = true;
    }
    if (widget.initialSale != null) {
      _mode = widget.initialSale!.mode;
      _deliveryMethod = 'delivery';
      _paid = false;
    }
    _cartFlyController =
        AnimationController(
          vsync: this,
          duration: const Duration(milliseconds: 420),
        )..addStatusListener((status) {
          if (status == AnimationStatus.completed) _removeCartFly();
        });
    _seedFromQuote();
    if (widget.initialSale == null) {
      _loadCatalog();
      _loadTickets();
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        await _loadCatalog();
        if (mounted) await _initializeFromChat();
      });
    }
  }

  Future<void> _initializeFromChat() async {
    final launch = widget.initialSale;
    if (launch == null) return;
    final repo = CrmScope.of(context, listen: false).repository;
    try {
      final detail = await repo.customer(launch.customerId);
      if (!mounted) return;
      final row = mapv(detail['customer']);
      if (str(row['id']) != launch.customerId) {
        posToast(context, 'No pudimos comprobar el cliente de este chat.');
        return;
      }
      setState(() => _customer = Customer.fromJson(row));
      await _loadOpenOrders(launch.customerId);
      final rows = await repo.posTickets();
      if (!mounted) return;
      final tickets = rows.map(PosTicketSummary.fromJson).where((ticket) {
        final draft = mapv(ticket.raw['draft']);
        return ticket.isOpen && str(draft['customerId']) == launch.customerId;
      }).toList();
      setState(
        () => _tickets = rows
            .map(PosTicketSummary.fromJson)
            .where((ticket) => ticket.isOpen)
            .toList(),
      );
      if (tickets.isEmpty) {
        await _createInitialTicket();
        return;
      }
      final choice = await showDialog<Object>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text(
            tickets.length == 1
                ? 'Ticket de ${_customer!.name}'
                : 'Tickets de ${_customer!.name}',
          ),
          content: SizedBox(
            width: 420,
            height: (tickets.length * 58.0).clamp(80, 340),
            child: ListView.builder(
              itemCount: tickets.length,
              itemBuilder: (_, index) {
                final ticket = tickets[index];
                return ListTile(
                  dense: true,
                  title: Text(
                    ticket.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: Text(
                    '${ticket.lines} productos · ${ticket.updatedAt}',
                  ),
                  onTap: () => Navigator.of(dialogContext).pop(ticket),
                );
              },
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop('new'),
              child: const Text('Crear otro'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Cancelar'),
            ),
          ],
        ),
      );
      if (!mounted) return;
      if (choice is PosTicketSummary) await _resumeSavedTicket(choice);
      if (choice == 'new') await _createInitialTicket();
    } on ApiException catch (error) {
      if (mounted) posToast(context, error.message, tone: CrmToastTone.error);
    }
  }

  Future<void> _createInitialTicket() async {
    final customer = _customer;
    if (customer == null) return;
    final repo = CrmScope.of(context, listen: false).repository;
    final requestId = _operation.requestIdFor(_draft);
    try {
      final result = await repo.parkTicket(
        draft: _draft.toCheckoutBody(requestId: requestId),
        requestId: requestId,
        name: 'Ticket de ${customer.name}',
        operationKey: requestId,
      );
      if (!mounted) return;
      final ticket = PosTicketSummary.fromJson(mapv(result['ticket']));
      setState(() {
        _ticketId = ticket.id;
        _ticketVersion = ticket.version;
        _tickets = [ticket, ..._tickets.where((row) => row.id != ticket.id)];
      });
    } on ApiException catch (error) {
      if (mounted) posToast(context, error.message, tone: CrmToastTone.error);
    }
  }

  /// Carga la cotización recibida: cliente, líneas, descuento y su id.
  /// Los precios se toman del documento (son los que el cliente aceptó) y el
  /// servidor volverá a calcularlos al cobrar; si cambiaron, responde 409.
  void _seedFromQuote() {
    final quote = widget.initialQuote;
    if (quote == null) return;
    _quoteId = str(quote['id']);
    final customerRow = mapv(quote['customer']);
    final customerId = str(
      customerRow['id'],
      str(mapv(quote['input'])['customerId']),
    );
    if (customerId.isNotEmpty) {
      _customer = Customer(
        id: customerId,
        name: str(customerRow['name'], 'Cliente'),
        phone: str(customerRow['phone_e164']),
        email: '',
        stage: '',
        tags: const [],
        city: '',
        createdAt: '',
        orders: 0,
        totalSpent: 0,
        notes: '',
        delivered: 0,
      );
    }
    for (final item in listv(mapv(quote['sale'])['items'])) {
      _lines.add(
        PosLine(
          variantId: str(item['variantId']),
          productName: str(item['name'], 'Producto'),
          presentationName: str(item['name'], ''),
          unitPriceCents: numv(item['unit_price_cents'], 0).toInt(),
          quantity: numv(item['quantity'], 1).toInt(),
        ),
      );
    }
    final discount = mapv(mapv(quote['input'])['discount']);
    if (discount['type'] == 'percent' || discount['type'] == 'amount') {
      _discountType = str(discount['type']);
      _discountValue = numv(discount['value'], 0).toDouble();
    }
    _address.text = str(mapv(quote['input'])['address']);
    _deliveryLocationId = str(mapv(quote['input'])['location']);
    _notes.text = str(mapv(quote['input'])['notes']);
    // Una cotización se cobra como factura por defecto (mismo criterio del PWA).
    _mode = 'invoice';
    _paid = false;
  }

  @override
  void dispose() {
    _removeCartFly();
    _cartFlyController.dispose();
    _search.dispose();
    _productSearch.dispose();
    _address.dispose();
    _notes.dispose();
    _reference.dispose();
    super.dispose();
  }

  PosSaleDraft get _draft => PosSaleDraft(
    mode: _mode,
    customerId: _customer?.id ?? '',
    conversationId: widget.initialSale?.conversationId ?? '',
    lines: List.unmodifiable(_lines),
    deliveryFeeCents: (_deliveryFee * 100).round(),
    deliveryQuoteId: _deliveryQuoteId,
    notes: _notes.text.trim(),
    address: _address.text.trim(),
    deliveryMethod: _deliveryMethod,
    paymentMethod: _method,
    paid: _paid,
    discountType: _discountType,
    discountValue: _discountValue,
    ticketId: _ticketId,
    ticketVersion: _ticketVersion,
    quoteId: _quoteId,
    scheduledAt: _scheduledAt?.toIso8601String() ?? '',
    deliveryReference: _reference.text.trim(),
  );

  // --------------------------------------------------------------- escritorio

  List<CatalogProduct> get _catalogProducts => [
    for (final row in _catalogRows)
      if (_selectedPickupStoreId.isEmpty ||
          _productStoreLinks.any(
            (link) =>
                str(link['supplier_id']) == _selectedPickupStoreId &&
                (str(link['product_id']) == str(row['id']) ||
                    listv(row['presentations']).any(
                      (presentation) =>
                          str(presentation['id']) == str(link['product_id']),
                    )),
          ))
        if (listv(row['presentations']).isNotEmpty)
          CatalogProduct.fromJson(row)
        else
          CatalogProduct(
            id: str(row['id']),
            name: str(row['name'], str(row['label'], 'Producto')),
            presentations: [CatalogPresentation.fromJson(row)],
            category: str(row['category'], str(row['kind'])),
            imageUrl: str(row['image_url']),
          ),
  ];

  Map<String, PosStockInfo> get _stockByVariant {
    final usedCapsules = _lines.fold<int>(0, (sum, line) {
      final row = _catalogRows.where(
        (item) => str(item['id']) == line.variantId,
      );
      if (row.isEmpty || row.first['general'] != false) return sum;
      return sum +
          numv(
                row.first['capsule_quantity'],
                numv(row.first['capsules']),
              ).toInt() *
              line.quantity;
    });
    final remaining = _sharedCapsules == null
        ? null
        : _sharedCapsules! - usedCapsules;
    return {
      for (final row in _catalogRows)
        str(row['id']): row['general'] == false
            ? PosStockInfo.units(
                (usedCapsules == 0 && row['stock'] is num)
                    ? (row['stock'] as num).toInt()
                    : remaining == null ||
                          numv(
                                row['capsule_quantity'],
                                numv(row['capsules']),
                              ).toInt() <=
                              0
                    ? null
                    : remaining ~/
                          numv(
                            row['capsule_quantity'],
                            numv(row['capsules']),
                          ).toInt(),
              )
            : row['track_stock'] == false || row['kind'] == 'service'
            ? const PosStockInfo.service()
            : PosStockInfo.units(
                row['stock'] is num
                    ? (row['stock'] as num).toInt() -
                          _lines
                              .where((line) => line.variantId == str(row['id']))
                              .fold<int>(0, (sum, line) => sum + line.quantity)
                    : null,
              ),
    };
  }

  bool _canAdd(CatalogPresentation presentation) =>
      presentation.available &&
      (_stockByVariant[presentation.id]?.canAdd ?? false);

  /// Categorías REALES presentes en el catálogo (vacío si el API no las envía).
  List<String> get _catalogCategories {
    final seen = <String>{};
    for (final product in _catalogProducts) {
      if (product.category.isNotEmpty) seen.add(product.category);
    }
    final list = seen.toList()..sort();
    return list;
  }

  /// Agrega una presentación al ticket (o suma 1 si ya estaba).
  void _addFromCatalog(
    CatalogProduct product,
    CatalogPresentation presentation,
  ) {
    if (!_canAdd(presentation)) {
      posToast(
        context,
        'Disponibilidad insuficiente o pendiente de verificar.',
      );
      return;
    }
    final index = _lines.indexWhere(
      (line) =>
          line.variantId == presentation.id &&
          line.supplierId == _selectedPickupStoreId,
    );
    final storeLink = _selectedPickupStoreId.isEmpty
        ? null
        : _productStoreLinks
              .where(
                (link) =>
                    str(link['supplier_id']) == _selectedPickupStoreId &&
                    (str(link['product_id']) == product.id ||
                        str(link['product_id']) == presentation.id),
              )
              .firstOrNull;
    setState(() {
      if (index >= 0) {
        final line = _lines[index];
        if (line.quantity < 9999) {
          _lines[index] = line.copyWith(quantity: line.quantity + 1);
        }
      } else {
        _lines.add(
          PosLine(
            variantId: presentation.id,
            productName: product.name,
            presentationName: presentation.name,
            unitPriceCents: posUnitPriceCents(presentation),
            quantity: 1,
            supplierId: storeLink == null ? '' : _selectedPickupStoreId,
          ),
        );
      }
    });
  }

  void _changeQuantity(PosLine line, int delta) {
    final index = _lines.indexOf(line);
    if (index < 0) return;
    final next = line.quantity + delta;
    if (delta > 0) {
      final presentation = _catalogProducts
          .expand((product) => product.presentations)
          .where((item) => item.id == line.variantId);
      if (presentation.isNotEmpty && !_canAdd(presentation.first)) {
        posToast(
          context,
          'Disponibilidad insuficiente para aumentar la cantidad.',
        );
        return;
      }
    }
    setState(() {
      if (next <= 0) {
        _lines.removeAt(index);
      } else if (next <= 9999) {
        _lines[index] = line.copyWith(quantity: next);
      }
    });
  }

  void _removeLine(PosLine line) => setState(() => _lines.remove(line));

  Future<void> _confirmClear() async {
    if (_lines.isEmpty && _ticketId.isEmpty) return;
    final confirmed = await crmConfirm(
      context,
      title: 'Cancelar venta',
      message:
          'Se descartará el borrador actual de esta caja. Los tickets guardados seguirán en Ventas.',
      confirmLabel: 'Cancelar venta',
    );
    if (!confirmed || !mounted) return;
    setState(() {
      _lines.clear();
      _customer = null;
      _openOrders = const [];
      _discountType = 'none';
      _discountValue = 0;
      _deliveryFee = 0;
      _ticketId = '';
      _ticketVersion = 0;
      _quoteId = '';
    });
    _operation.reset();
  }

  void _removeCartFly() {
    _cartFlyEntry?.remove();
    _cartFlyEntry = null;
  }

  void _animateProductToCart(CatalogProduct product, Rect sourceGlobalRect) {
    final cartObject = _cartKey.currentContext?.findRenderObject();
    final overlay = Overlay.maybeOf(context);
    final overlayObject = overlay?.context.findRenderObject();
    if (cartObject is! RenderBox ||
        overlay == null ||
        overlayObject is! RenderBox ||
        !cartObject.hasSize ||
        !overlayObject.hasSize) {
      return;
    }
    final overlayBox = overlayObject;
    _cartFlyFrom = Rect.fromPoints(
      overlayBox.globalToLocal(sourceGlobalRect.topLeft),
      overlayBox.globalToLocal(sourceGlobalRect.bottomRight),
    );
    final cartTopLeft = overlayBox.globalToLocal(
      cartObject.localToGlobal(Offset.zero),
    );
    _cartFlyTo = Rect.fromLTWH(cartTopLeft.dx + 12, cartTopLeft.dy + 8, 48, 48);
    _flyingProduct = product;
    _removeCartFly();
    _cartFlyEntry = OverlayEntry(
      builder: (context) {
        final from = _cartFlyFrom;
        final to = _cartFlyTo;
        final flying = _flyingProduct;
        if (from == null || to == null || flying == null) {
          return const SizedBox.shrink();
        }
        final progress = Curves.easeInOutCubic.transform(
          _cartFlyController.value,
        );
        return Positioned.fromRect(
          rect: Rect.lerp(from, to, progress)!,
          child: IgnorePointer(
            child: Opacity(
              opacity: 1 - progress * 0.25,
              child: Material(
                elevation: 8,
                borderRadius: BorderRadius.circular(9),
                clipBehavior: Clip.antiAlias,
                child: ColoredBox(
                  color: PosPalette.of(context).primarySoft,
                  child: Icon(
                    Icons.shopping_bag_outlined,
                    color: PosPalette.of(context).primary,
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
    overlay.insert(_cartFlyEntry!);
    _cartFlyController.forward(from: 0);
  }

  /// Selector de cliente (usa la lista real de `CrmState`).
  Future<void> _pickCustomer() async {
    if (widget.desktop) {
      setState(() => _activePanel = _PosDesktopPanel.customer);
      return;
    }
    final selected = await showDialog<Customer>(
      context: context,
      builder: (dialogContext) {
        final controller = TextEditingController();
        return StatefulBuilder(
          builder: (dialogContext, setDialogState) {
            final state = CrmScope.of(dialogContext);
            final query = controller.text.trim().toLowerCase();
            final matches = state.customers
                .where(
                  (row) =>
                      query.isEmpty ||
                      row.name.toLowerCase().contains(query) ||
                      row.phone.toLowerCase().contains(query),
                )
                .take(60)
                .toList();
            return AlertDialog(
              title: const Text('Elegir cliente'),
              content: SizedBox(
                width: 420,
                height: 420,
                child: Column(
                  children: [
                    TextField(
                      controller: controller,
                      autofocus: true,
                      decoration: const InputDecoration(
                        hintText: 'Nombre o teléfono',
                      ),
                      onChanged: (_) => setDialogState(() {}),
                    ),
                    const SizedBox(height: 8),
                    Expanded(
                      child: matches.isEmpty
                          ? const Center(child: Text('Sin coincidencias.'))
                          : ListView.builder(
                              itemCount: matches.length,
                              itemBuilder: (context, index) {
                                final row = matches[index];
                                return ListTile(
                                  dense: true,
                                  title: Text(row.name),
                                  subtitle: Text(row.phone),
                                  onTap: () =>
                                      Navigator.of(dialogContext).pop(row),
                                );
                              },
                            ),
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.of(dialogContext).pop(),
                  child: const Text('Cancelar'),
                ),
                TextButton(
                  onPressed: () {
                    Navigator.of(dialogContext).pop();
                    _newCustomer();
                  },
                  child: const Text('Nuevo cliente'),
                ),
              ],
            );
          },
        );
      },
    );
    if (selected != null && mounted) {
      setState(() => _customer = selected);
      await _loadOpenOrders(selected.id);
    }
  }

  /// Contexto del cliente: pedidos abiertos. Si falla, se dice y NO se bloquea
  /// la venta: el servidor sigue siendo quien autoriza.
  Future<void> _loadOpenOrders(String customerId) async {
    final repo = CrmScope.of(context, listen: false).repository;
    setState(() {
      _loadingContext = true;
      _contextError = null;
      _openOrders = const [];
    });
    try {
      final data = await repo.posContext(customerId);
      if (!mounted || _customer?.id != customerId) return;
      setState(() {
        _openOrders = listv(data['openOrders']);
        _loadingContext = false;
      });
    } on ApiException catch (error) {
      if (!mounted || _customer?.id != customerId) return;
      setState(() {
        _contextError = error.message;
        _loadingContext = false;
      });
    }
  }

  Future<void> _openLatestQuotePdf() async {
    final customer = _customer;
    if (customer == null) {
      posToast(context, 'Elige un cliente para ver sus cotizaciones.');
      return;
    }
    final repository = CrmScope.of(context, listen: false).repository;
    setState(() => _loadingQuotePdf = true);
    try {
      final quotes = await repository.quotes();
      if (!mounted) return;
      final customerQuotes =
          quotes.where((row) {
            final quoteCustomer = mapv(row['customer']);
            final input = mapv(row['input']);
            return str(
                  quoteCustomer['id'],
                  str(row['customer_id'], str(input['customerId'])),
                ) ==
                customer.id;
          }).toList()..sort(
            (a, b) => str(b['created_at']).compareTo(str(a['created_at'])),
          );
      if (customerQuotes.isEmpty) {
        posToast(context, 'Este cliente todavía no tiene cotizaciones.');
        return;
      }
      final quoteId = str(customerQuotes.first['id']);
      if (quoteId.isEmpty) {
        posToast(context, 'No se encontró el PDF de la última cotización.');
        return;
      }
      final file = await repository.quoteFile(quoteId);
      if (!mounted) return;
      await FileOpener.saveAndOpen(file);
    } on ApiException catch (error) {
      if (mounted) posToast(context, error.message, tone: CrmToastTone.error);
    } finally {
      if (mounted) setState(() => _loadingQuotePdf = false);
    }
  }

  Widget _desktopPanelContent() {
    return switch (_activePanel) {
      _PosDesktopPanel.createProduct => PosManualSalePanel(
        onAdd: (line) {
          setState(() {
            _lines.add(line);
            _activePanel = null;
          });
          _operation.reset();
        },
      ),
      _PosDesktopPanel.stock => InventarioScreen(onStockChanged: _loadCatalog),
      _PosDesktopPanel.quotes => const CotizacionesScreen(),
      _PosDesktopPanel.count => const RecuentoScreen(),
      _PosDesktopPanel.pickups => const RecogidasScreen(),
      _PosDesktopPanel.onlineStore => const CatalogoScreen(),
      _PosDesktopPanel.customer => _customerPanel(),
      _PosDesktopPanel.recentSales => PosRecentSalesPanel(
        onClose: () => setState(() => _activePanel = null),
        onOpenOrder: (id) {
          setState(() => _activePanel = null);
          Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => PedidoDetailScreen(orderId: id)),
          );
        },
        onOpenHistory: () {
          setState(() => _activePanel = null);
          widget.onNavigate?.call('pedidos');
        },
      ),
      _PosDesktopPanel.tickets => const SizedBox.shrink(),
      null => const SizedBox.shrink(),
    };
  }

  Widget _customerPanel() {
    final state = CrmScope.of(context);
    final selected = _customer;
    final orders = selected == null
        ? const <OrderItem>[]
        : (state.orders
              .where((order) => order.customerId == selected.id)
              .toList()
            ..sort((a, b) => b.receivedAt.compareTo(a.receivedAt)));
    return PosCustomerPanel(
      customers: state.customers,
      selectedCustomer: selected,
      recentOrders: orders,
      onSelectCustomer: (customer) {
        setState(() {
          _customer = customer;
          _activePanel = null;
        });
        _loadOpenOrders(customer.id);
      },
      onClearSelection: () => setState(() {
        _customer = null;
        _openOrders = const [];
        _deliveryLocationId = '';
        _address.clear();
        _reference.clear();
        _deliveryFee = 0;
      }),
      onCustomerUpdated: (customer) => setState(() => _customer = customer),
      onCreateCustomer: _createCustomerFromPanel,
      onSelectLocation: (location) {
        final locationId = str(location['id']);
        final address = str(
          location['address'],
          str(
            location['label'],
            str(location['name'], str(location['location'])),
          ),
        );
        setState(() {
          _deliveryLocationId = locationId;
          _deliveryLocation = location;
          _address.text = address;
        });
        _operation.reset();
      },
      deliveryMethod: _deliveryMethod,
      onDeliveryMethodChanged: (value) => setState(() {
        _deliveryMethod = value;
        if (value == 'pickup') {
          _deliveryLocationId = '';
          _deliveryLocation = null;
          _deliveryQuoteId = '';
          _deliveryFee = 0;
        }
      }),
      deliveryFee: _deliveryFee,
      onDeliveryFeeChanged: (value) => setState(() => _deliveryFee = value),
      addressController: _address,
      referenceController: _reference,
      notesController: _notes,
      onAddressChanged: () => setState(() {
        _deliveryLocationId = '';
        _deliveryLocation = null;
        _deliveryQuoteId = '';
      }),
      scheduledAt: _scheduledAt,
      onScheduleChanged: (value) => setState(() => _scheduledAt = value),
    );
  }

  Widget _buildDesktop(BuildContext context) {
    final p = PosPalette.of(context);
    final t = p.text;
    // Ancho REAL disponible (el shell ya descuenta el rail): usar MediaQuery
    // hacía que el panel de venta se saliera por la derecha.
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        final panelWidth = PosMetrics.cartWidth(width);
        final quickSaleWidth = width * 0.20;
        return Column(
          children: [
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  Material(
                    color: p.pageBg,
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Expanded(
                          child: Column(
                            children: [
                              _desktopSearchAndCategories(context),
                              if (_operation.attempts > 1)
                                Container(
                                  width: double.infinity,
                                  color: p.primarySoft,
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 12,
                                    vertical: 6,
                                  ),
                                  child: Text(
                                    'Reintento seguro: la operación conserva su identificador, no se duplicará.',
                                    style: t.pill.copyWith(fontSize: 11.5),
                                  ),
                                ),
                              Expanded(
                                child: PosProductGrid(
                                  products: _catalogProducts,
                                  stockByVariant: _stockByVariant,
                                  query: _productSearch.text.trim(),
                                  filter: _railFilter,
                                  loading: _catalogLoading,
                                  onAdd: _addFromCatalog,
                                  onAddFromCard:
                                      (product, presentation, sourceRect) {
                                        if (!_canAdd(presentation)) return;
                                        _addFromCatalog(product, presentation);
                                        _animateProductToCart(
                                          product,
                                          sourceRect,
                                        );
                                      },
                                  onQuickSale: () => setState(() {
                                    _activePanel = null;
                                    _quickSaleOpen = true;
                                  }),
                                  favoriteProductIds: _favoriteProductIds,
                                  onToggleFavorite: (product) => setState(() {
                                    if (!_favoriteProductIds.add(product.id)) {
                                      _favoriteProductIds.remove(product.id);
                                    }
                                  }),
                                ),
                              ),
                            ],
                          ),
                        ),
                        SizedBox(
                          key: _cartKey,
                          width: panelWidth,
                          child: PosCartPanel(
                            lines: _lines,
                            customer: _customer,
                            mode: _mode,
                            method: _method,
                            paid: _paid,
                            deliveryFee: _deliveryFee,
                            saving: _saving,
                            discountType: _discountType,
                            discountValue: _discountValue,
                            onDiscountChanged: (type, value) => setState(() {
                              _discountType = type;
                              _discountValue = value;
                            }),
                            onQuantity: _changeQuantity,
                            onRemove: _removeLine,
                            onLineDiscount: _editLineDiscount,
                            onPickCustomer: _pickCustomer,
                            openOrders: _openOrders,
                            loadingContext: _loadingContext,
                            contextError: _contextError,
                            onReloadContext: () {
                              final customer = _customer;
                              if (customer != null) {
                                _loadOpenOrders(customer.id);
                              }
                            },
                            onClear: _confirmClear,
                            onModeChanged: (value) => setState(() {
                              _mode = value;
                              _paid = value == 'invoice';
                            }),
                            onMethodChanged: (value) =>
                                setState(() => _method = value),
                            onPaidChanged: (value) =>
                                setState(() => _paid = value),
                            onCheckout: _submit,
                            onOpenTickets: () => setState(
                              () => _activePanel = _PosDesktopPanel.recentSales,
                            ),
                            onAskCustomerData: _askCustomerData,
                            onQuote: () => setState(() => _mode = 'quote'),
                            onLatestQuotePdf: _openLatestQuotePdf,
                            quotePdfLoading: _loadingQuotePdf,
                            canViewUtility: CrmScope.of(
                              context,
                            ).session.can('cost.view'),
                            catalogCostCents: {
                              for (final row in _catalogRows)
                                if (row['presentation_cost_cents'] is num ||
                                    row['cost_cents'] is num)
                                  str(row['id']): numv(
                                    row['presentation_cost_cents'],
                                    numv(row['cost_cents']),
                                  ).toInt(),
                            },
                            deliveryMethod: _deliveryMethod,
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (_activePanel != null || _quickSaleOpen)
                    Positioned.fill(
                      child: GestureDetector(
                        behavior: HitTestBehavior.opaque,
                        onTap: () {
                          if (_activePanel == _PosDesktopPanel.stock) {
                            _loadCatalog();
                          }
                          setState(() {
                            _activePanel = null;
                            _quickSaleOpen = false;
                          });
                        },
                        child: ColoredBox(
                          color: Colors.black.withValues(alpha: 0.28),
                        ),
                      ),
                    ),
                  AnimatedPositioned(
                    duration: const Duration(milliseconds: 220),
                    curve: Curves.easeOutCubic,
                    top: 0,
                    bottom: 0,
                    right: _activePanel == null ? -panelWidth : 0,
                    width: panelWidth,
                    child: Material(
                      color: p.surface,
                      elevation: _activePanel == null ? 0 : 18,
                      child: Column(
                        children: [
                          if (_activePanel != _PosDesktopPanel.recentSales)
                            SizedBox(
                              height: 42,
                              child: Row(
                                children: [
                                  if (_activePanel ==
                                      _PosDesktopPanel.createProduct)
                                    Expanded(
                                      child: Padding(
                                        padding: const EdgeInsets.only(
                                          left: 14,
                                        ),
                                        child: Text(
                                          'Nuevo producto para este ticket',
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: t.body.copyWith(
                                            fontWeight: FontWeight.w800,
                                          ),
                                        ),
                                      ),
                                    )
                                  else
                                    const Spacer(),
                                  IconButton(
                                    tooltip: 'Cerrar panel',
                                    onPressed: () {
                                      if (_activePanel ==
                                          _PosDesktopPanel.stock) {
                                        _loadCatalog();
                                      }
                                      setState(() => _activePanel = null);
                                    },
                                    icon: const Icon(
                                      Icons.close_rounded,
                                      size: 19,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          Expanded(child: _desktopPanelContent()),
                        ],
                      ),
                    ),
                  ),
                  AnimatedPositioned(
                    duration: const Duration(milliseconds: 220),
                    curve: Curves.easeOutCubic,
                    top: 0,
                    bottom: 0,
                    left: _quickSaleOpen ? 0 : -quickSaleWidth,
                    width: quickSaleWidth,
                    child: Material(
                      color: p.surface,
                      elevation: _quickSaleOpen ? 18 : 0,
                      child: Column(
                        children: [
                          SizedBox(
                            height: 48,
                            child: Row(
                              children: [
                                const SizedBox(width: 14),
                                Expanded(
                                  child: Text('Venta rápida', style: t.title),
                                ),
                                IconButton(
                                  tooltip: 'Cerrar panel',
                                  onPressed: () =>
                                      setState(() => _quickSaleOpen = false),
                                  icon: const Icon(
                                    Icons.close_rounded,
                                    size: 19,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          Expanded(
                            child: PosManualSalePanel(
                              onAdd: (line) {
                                setState(() {
                                  _lines.add(line);
                                  _quickSaleOpen = false;
                                });
                                _operation.reset();
                              },
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
            _ticketBar(context),
          ],
        );
      },
    );
  }

  /// Guarda el descuento de una línea. La fórmula no vive aquí: la aplica el
  /// servidor al cobrar; esto solo actualiza el borrador y la previsualización.
  Future<void> _editLineDiscount(PosLine line) async {
    final updated = await showPosLineQuickEditDialog(context, line: line);
    if (updated == null || !mounted) return;
    final index = _lines.indexOf(line);
    if (index < 0) return;
    if (updated.quantity > line.quantity && !line.isManual) {
      final stock = _stockByVariant[line.variantId];
      final extra = updated.quantity - line.quantity;
      if (stock == null ||
          (!stock.service && (stock.units == null || stock.units! < extra))) {
        posToast(context, 'Disponibilidad insuficiente para esa cantidad.');
        return;
      }
    }
    setState(() => _lines[index] = updated);
    // Cambiar una línea es otra operación: que el próximo cobro use clave nueva.
    _operation.reset();
  }

  /// Guarda el borrador como ticket aparcado. NO cobra: no toca stock ni caja.
  ///
  /// El servidor exige `requestId` estable y, al actualizar uno existente,
  /// `version` para detectar que otra caja lo cambió (`409 ticket_conflict`).
  /// Se conserva la clave de operación del borrador para no crear dos tickets
  /// si el operador pulsa dos veces.
  Future<bool> _parkTicket({bool notify = false}) async {
    if (_lines.isEmpty) {
      posToast(
        context,
        'Agrega al menos un artículo antes de aparcar el ticket.',
      );
      return false;
    }
    final repo = CrmScope.of(context, listen: false).repository;
    final draft = _draft;
    final requestId = _operation.requestIdFor(draft);
    final ticketDraft = draft.toCheckoutBody(requestId: requestId);
    if (_deliveryLocationId.isNotEmpty) {
      ticketDraft['location'] = _deliveryLocationId;
    }
    setState(() => _saving = true);
    try {
      final result = await repo.parkTicket(
        draft: ticketDraft,
        requestId: requestId,
        ticketId: _ticketId.isEmpty ? null : _ticketId,
        version: _ticketId.isEmpty ? null : _ticketVersion,
        name: _customer == null ? null : 'Ticket de ${_customer!.name}',
        operationKey: requestId,
      );
      final ticket = mapv(result['ticket']);
      if (!mounted) return false;
      final savedId = str(ticket['id']);
      final savedVersion = numv(ticket['version']).toInt();
      if (savedId.isEmpty || savedVersion < 1) {
        setState(() => _saving = false);
        posToast(
          context,
          'No se confirmó el guardado del ticket. Inténtalo de nuevo.',
          tone: CrmToastTone.error,
        );
        return false;
      }
      setState(() {
        _ticketId = savedId;
        _ticketVersion = savedVersion;
        _tickets = [
          PosTicketSummary.fromJson(ticket),
          ..._tickets.where((row) => row.id != savedId),
        ];
        _saving = false;
      });
      if (notify) posToast(context, 'Ticket guardado. No se ha cobrado nada.');
      _loadTickets();
      return true;
    } on ApiException catch (error) {
      if (!mounted) return false;
      setState(() => _saving = false);
      await crmConfirm(
        context,
        title: 'No se pudo aparcar',
        message: error.message,
        confirmLabel: 'Entendido',
      );
      return false;
    }
  }

  Future<void> _newTicket() async {
    if (_saving) return;
    if (_lines.isNotEmpty && !await _parkTicket()) return;
    if (!mounted) return;
    setState(() {
      _lines.clear();
      _customer = null;
      _openOrders = const [];
      _ticketId = '';
      _ticketVersion = 0;
      _quoteId = '';
      _mode = widget.desktop ? 'invoice' : 'order';
      _method = 'CASH';
      _paid = widget.desktop;
      _deliveryMethod = widget.desktop ? 'pickup' : 'delivery';
      _deliveryFee = 0;
      _deliveryLocationId = '';
      _scheduledAt = null;
      _discountType = 'none';
      _discountValue = 0;
      _address.clear();
      _reference.clear();
      _notes.clear();
    });
    _operation.reset();
  }

  Future<void> _openTickets() async {
    final repo = CrmScope.of(context, listen: false).repository;
    final ticket = await showTicketsDialog(context, repository: repo);
    _loadTickets();
    if (ticket == null || !mounted) return;
    await _resumeSavedTicket(ticket);
  }

  Future<void> _loadTickets() async {
    try {
      final rows = await CrmScope.of(
        context,
        listen: false,
      ).repository.posTickets();
      if (!mounted) return;
      setState(
        () => _tickets = rows
            .map(PosTicketSummary.fromJson)
            .where((ticket) => ticket.isOpen)
            .toList(),
      );
    } on ApiException {
      // El ticket actual sigue utilizable si falla el listado auxiliar.
    }
  }

  Future<void> _resumeSavedTicket(PosTicketSummary ticket) async {
    if (!mounted || _saving || ticket.id == _ticketId) return;
    if (_lines.isNotEmpty && !await _parkTicket()) return;
    if (!mounted) return;
    final resumed = resumeTicket(ticket, _catalogRows);
    final savedDraft = mapv(ticket.raw['draft']);
    final discount = mapv(savedDraft['discount']);
    setState(() {
      _customer = resumed.customer;
      _lines
        ..clear()
        ..addAll(resumed.lines);
      _ticketId = ticket.id;
      _ticketVersion = ticket.version;
      _mode = str(savedDraft['mode'], 'invoice');
      _method = str(savedDraft['paymentMethod'], 'CASH');
      _paid = savedDraft['paymentStatus'] == 'paid';
      _discountType = str(discount['type'], 'none');
      _discountValue = numv(discount['value']).toDouble();
      _deliveryFee = numv(savedDraft['deliveryFee']).toDouble();
      _deliveryMethod = str(savedDraft['deliveryMethod'], 'delivery');
      _deliveryLocationId = str(savedDraft['location']);
      _address.text = str(savedDraft['address']);
      _reference.text = str(savedDraft['deliveryReference']);
      _notes.text = str(savedDraft['notes']);
      _quoteId = str(savedDraft['quoteId']);
      _scheduledAt = DateTime.tryParse(str(savedDraft['scheduledAt']));
    });
    _operation.reset();
    if (resumed.customer != null) await _loadOpenOrders(resumed.customer!.id);
    if (resumed.problem != null && mounted) posToast(context, resumed.problem!);
  }

  Widget _ticketBar(BuildContext context) {
    final p = PosPalette.of(context);
    final visible = [
      ..._tickets.where((ticket) => ticket.id == _ticketId),
      ..._tickets.where((ticket) => ticket.id != _ticketId),
    ].take(4).toList();
    return Container(
      height: 42,
      decoration: BoxDecoration(
        color: p.surfaceMuted,
        border: Border(top: BorderSide(color: p.border)),
      ),
      child: Row(
        children: [
          Expanded(
            child: ListView(
              scrollDirection: Axis.horizontal,
              children: [
                if (_ticketId.isEmpty)
                  _ticketTab(p, _customer?.name ?? 'Ticket actual', true, null),
                for (var index = 0; index < visible.length; index++)
                  _ticketTab(
                    p,
                    visible[index].customerName.isNotEmpty
                        ? visible[index].customerName
                        : visible[index].name,
                    visible[index].id == _ticketId,
                    () => _resumeSavedTicket(visible[index]),
                  ),
                SizedBox(
                  width: 46,
                  height: 42,
                  child: Material(
                    color: p.surfaceMuted,
                    child: InkWell(
                      onTap: _newTicket,
                      child: Tooltip(
                        message: 'Nuevo ticket',
                        child: Icon(
                          Icons.add_rounded,
                          size: 23,
                          color: p.primary,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          Container(
            height: 42,
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            decoration: BoxDecoration(
              border: Border(left: BorderSide(color: p.border)),
            ),
            child: Text(
              '${_tickets.length} tickets',
              style: p.text.secondary.copyWith(fontSize: 11.5),
            ),
          ),
        ],
      ),
    );
  }

  Widget _ticketTab(
    PosPalette p,
    String label,
    bool active,
    VoidCallback? onTap,
  ) => ConstrainedBox(
    constraints: const BoxConstraints(maxWidth: 190),
    child: Material(
      color: active ? p.surface : p.surfaceMuted,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: 42,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(
            border: Border(
              top: BorderSide(
                color: active ? p.primary : Colors.transparent,
                width: 3,
              ),
              right: BorderSide(color: p.border),
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.receipt_long_rounded,
                size: 19,
                color: active ? p.primary : p.inkSecondary,
              ),
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: p.text.body.copyWith(
                    fontSize: 12.5,
                    fontWeight: active ? FontWeight.w800 : FontWeight.w600,
                    color: active ? p.primary : p.ink,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );

  Widget _desktopOverflowMenu(
    BuildContext context, {
    bool compact = false,
    bool canStock = false,
  }) {
    final p = PosPalette.of(context);
    return PopupMenuButton<_PosDesktopPanel>(
      tooltip: 'Más acciones de facturación',
      icon: Icon(Icons.more_vert_rounded, color: p.ink),
      onSelected: (panel) {
        if (panel == _PosDesktopPanel.recentSales) {
          setState(() => _activePanel = panel);
        } else if (panel == _PosDesktopPanel.tickets) {
          _openTickets();
        } else {
          setState(() => _activePanel = panel);
        }
      },
      itemBuilder: (_) => [
        if (compact && canStock)
          const PopupMenuItem(
            value: _PosDesktopPanel.stock,
            child: Text('Agregar stock'),
          ),
        if (compact)
          const PopupMenuItem(
            value: _PosDesktopPanel.createProduct,
            child: Text('Nuevo producto'),
          ),
        if (compact) const PopupMenuDivider(),
        const PopupMenuItem(
          value: _PosDesktopPanel.recentSales,
          child: Text('Ventas recientes'),
        ),
        const PopupMenuItem(
          value: _PosDesktopPanel.tickets,
          child: Text('Tickets guardados'),
        ),
        const PopupMenuDivider(),
        const PopupMenuItem(
          value: _PosDesktopPanel.quotes,
          child: Text('Cotizaciones'),
        ),
        const PopupMenuItem(
          value: _PosDesktopPanel.count,
          child: Text('Recuento'),
        ),
        const PopupMenuItem(
          value: _PosDesktopPanel.pickups,
          child: Text('Recogidas'),
        ),
        const PopupMenuItem(
          value: _PosDesktopPanel.onlineStore,
          child: Text('Tienda en línea'),
        ),
      ],
    );
  }

  Widget _desktopSearchAndCategories(BuildContext context) {
    final p = PosPalette.of(context);
    final t = p.text;
    final canStock = CrmScope.of(context).session.can('admin.full');
    final filters = PosCategoryStrip.buildEntries(
      _catalogProducts,
      _catalogCategories,
    );
    return Container(
      height: 56,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      decoration: BoxDecoration(
        color: p.surface,
        border: Border(bottom: BorderSide(color: p.border)),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final compact = constraints.maxWidth < 700;
          return Row(
            children: [
              Expanded(
                child: SizedBox(
                  height: 42,
                  child: TextField(
                    controller: _productSearch,
                    onChanged: (_) => setState(() {}),
                    style: t.body.copyWith(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                    ),
                    decoration: InputDecoration(
                      isDense: true,
                      filled: false,
                      hintText: 'Buscar producto por nombre o código...',
                      hintStyle: t.secondary,
                      prefixIcon: Padding(
                        padding: const EdgeInsets.only(left: 10, right: 6),
                        child: Icon(
                          Icons.search_rounded,
                          size: 21,
                          color: p.inkSecondary,
                        ),
                      ),
                      prefixIconConstraints: const BoxConstraints(
                        minWidth: 31,
                        minHeight: 31,
                      ),
                      suffixIcon: IconButton(
                        tooltip: 'Recargar catálogo',
                        onPressed: _loadCatalog,
                        icon: Icon(
                          Icons.sync_rounded,
                          size: 22,
                          color: p.inkSecondary,
                        ),
                        visualDensity: VisualDensity.compact,
                      ),
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 10,
                      ),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(
                          PosMetrics.radiusField,
                        ),
                        borderSide: BorderSide(color: p.border),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(
                          PosMetrics.radiusField,
                        ),
                        borderSide: BorderSide(color: p.border),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              if (_pickupStores.isNotEmpty) ...[
                PopupMenuButton<String>(
                  tooltip: 'Filtrar por tienda',
                  onSelected: (value) =>
                      setState(() => _selectedPickupStoreId = value),
                  itemBuilder: (_) => [
                    const PopupMenuItem(
                      value: '',
                      child: Text('Todas las tiendas'),
                    ),
                    for (final store in _pickupStores)
                      PopupMenuItem(
                        value: str(store['id']),
                        child: Text(
                          str(store['name']),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                  child: SizedBox(
                    width: compact ? 104 : 148,
                    height: 40,
                    child: Row(
                      children: [
                        Icon(
                          Icons.storefront_outlined,
                          size: 19,
                          color: p.primary,
                        ),
                        const SizedBox(width: 5),
                        Expanded(
                          child: Text(
                            _selectedPickupStoreId.isEmpty
                                ? 'Tienda'
                                : str(
                                    _pickupStores
                                        .where(
                                          (row) =>
                                              str(row['id']) ==
                                              _selectedPickupStoreId,
                                        )
                                        .firstOrNull?['name'],
                                    'Tienda',
                                  ),
                            overflow: TextOverflow.ellipsis,
                            style: t.body.copyWith(fontWeight: FontWeight.w700),
                          ),
                        ),
                        Icon(
                          Icons.arrow_drop_down_rounded,
                          color: p.inkSecondary,
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(width: 6),
              ],
              PopupMenuButton<PosRailFilter>(
                tooltip: 'Filtrar catálogo',
                icon: Icon(
                  _railFilter.isAll
                      ? Icons.tune_rounded
                      : Icons.filter_alt_rounded,
                  color: p.primary,
                ),
                onSelected: (filter) => setState(() => _railFilter = filter),
                itemBuilder: (_) => [
                  for (final entry in filters)
                    PopupMenuItem(
                      value: entry.filter,
                      child: Row(
                        children: [
                          if (entry.filter == _railFilter)
                            Icon(
                              Icons.check_rounded,
                              size: 16,
                              color: p.primary,
                            )
                          else
                            const SizedBox(width: 16),
                          const SizedBox(width: 8),
                          Text(entry.label),
                        ],
                      ),
                    ),
                ],
              ),
              _desktopOverflowMenu(
                context,
                compact: compact,
                canStock: canStock,
              ),
              if (!compact && canStock) ...[
                const SizedBox(width: 6),
                _actionButton(
                  context,
                  Icons.inventory_2_outlined,
                  'Agregar stock',
                  () => setState(() => _activePanel = _PosDesktopPanel.stock),
                ),
              ],
              if (!compact) ...[
                const SizedBox(width: 6),
                _actionButton(
                  context,
                  Icons.add_box_outlined,
                  'Nuevo producto',
                  () => setState(
                    () => _activePanel = _PosDesktopPanel.createProduct,
                  ),
                ),
              ],
            ],
          );
        },
      ),
    );
  }

  Widget _actionButton(
    BuildContext context,
    IconData icon,
    String label,
    VoidCallback onTap,
  ) {
    return _PosToolbarButton(
      icon: icon,
      label: label,
      onTap: onTap,
      palette: PosPalette.of(context),
    );
  }

  Future<void> _newCustomer() async {
    if (widget.desktop) {
      setState(() => _activePanel = _PosDesktopPanel.customer);
      return;
    }
    final datos = await showDialog<({String phone, String name})>(
      context: context,
      builder: (context) => const _NewCustomerDialog(),
    );
    if (datos == null) return;
    await _createCustomerFromPanel(datos.phone, datos.name, '', '', '');
  }

  Future<bool> _createCustomerFromPanel(
    String phone,
    String name,
    String location,
    String notes,
    String reference,
  ) async {
    final phoneText = phone.trim();
    if (phoneText.isEmpty) {
      if (mounted) posToast(context, 'Escribe el teléfono del cliente.');
      return false;
    }
    final repo = CrmScope.of(context, listen: false).repository;
    try {
      final result = await repo.api.post('/api/admin/pos/customers', {
        'phone': phoneText,
        'name': name.trim(),
      });
      if (!mounted) return false;
      final customerRow = mapv(result['customer']);
      final customerId = str(customerRow['id']);
      var profileSaved = true;
      if (customerId.isNotEmpty &&
          (location.trim().isNotEmpty || notes.trim().isNotEmpty)) {
        try {
          await repo.api.patch(
            '/api/admin/customers/${Uri.encodeComponent(customerId)}',
            {
              if (location.trim().isNotEmpty) 'location': location.trim(),
              if (notes.trim().isNotEmpty) 'notes': notes.trim(),
            },
          );
        } on ApiException {
          profileSaved = false;
        }
      }
      if (!mounted) return false;
      final customer = Customer.fromJson(
        customerRow.isEmpty
            ? {
                'phone_e164': phoneText,
                'name': name.trim(),
                'location': profileSaved ? location.trim() : '',
                'notes': profileSaved ? notes.trim() : '',
              }
            : {
                ...customerRow,
                'location': profileSaved ? location.trim() : '',
                'notes': profileSaved ? notes.trim() : '',
              },
      );
      setState(() {
        _customer = customer;
        _activePanel = null;
        if (location.trim().isNotEmpty) _address.text = location.trim();
        if (reference.trim().isNotEmpty) _reference.text = reference.trim();
      });
      if (customer.id.isNotEmpty) await _loadOpenOrders(customer.id);
      if (!profileSaved && mounted) {
        posToast(
          context,
          'Cliente creado. No se pudo guardar su ubicación o sus notas en la ficha.',
          tone: CrmToastTone.error,
        );
      }
      return true;
    } on ApiException catch (error) {
      if (mounted) posToast(context, error.message, tone: CrmToastTone.error);
      return false;
    }
  }

  Future<void> _loadCatalog() async {
    final repo = CrmScope.of(context, listen: false).repository;
    if (mounted) setState(() => _catalogLoading = true);
    try {
      final data = await repo.catalog();
      List<Map<String, dynamic>> stores = const [];
      List<Map<String, dynamic>> links = const [];
      try {
        stores = await repo.suppliers();
        links = await repo.productSuppliers();
      } on ApiException {
        // Un backend anterior puede no exponer aún la red de tiendas.
      }
      if (!mounted) return;
      final inventory = mapv(data['inventory']);
      setState(() {
        _catalogRows = listv(data['catalog']);
        _pickupStores = stores.where((row) => row['active'] != false).toList();
        _productStoreLinks = links;
        if (!_pickupStores.any(
          (row) => str(row['id']) == _selectedPickupStoreId,
        )) {
          _selectedPickupStoreId = '';
        }
        _sharedCapsules =
            inventory['initialized'] == true && inventory['stock'] is num
            ? (inventory['stock'] as num).toInt()
            : null;
      });
    } on ApiException catch (error) {
      if (mounted) posToast(context, error.message, tone: CrmToastTone.error);
    } finally {
      if (mounted) setState(() => _catalogLoading = false);
    }
  }

  Future<void> _pickProduct() async {
    if (_catalogRows.isEmpty) await _loadCatalog();
    if (!mounted) return;
    final options = <(CatalogProduct, CatalogPresentation)>[];
    for (final product in _catalogProducts) {
      for (final presentation in product.presentations) {
        options.add((product, presentation));
      }
    }
    if (options.isEmpty) {
      posToast(context, 'El catálogo no tiene presentaciones para vender.');
      return;
    }
    final picked =
        await showModalBottomSheet<(CatalogProduct, CatalogPresentation)>(
          context: context,
          showDragHandle: true,
          isScrollControlled: true,
          builder: (context) => DraggableScrollableSheet(
            expand: false,
            initialChildSize: 0.7,
            maxChildSize: 0.92,
            builder: (context, controller) => ListView.builder(
              controller: controller,
              itemCount: options.length,
              itemBuilder: (context, index) {
                final option = options[index];
                final unitCents = posUnitPriceCents(option.$2);
                return ListTile(
                  title: Text(option.$1.name),
                  subtitle: Text(
                    '${option.$2.name} · ${CrmFormat.money(unitCents / 100)}'
                    '${option.$2.available ? '' : ' · agotado'}',
                  ),
                  trailing: const Icon(Icons.add_circle_outline_rounded),
                  onTap: () => Navigator.pop(context, option),
                );
              },
            ),
          ),
        );
    if (picked == null) return;
    _addFromCatalog(picked.$1, picked.$2);
  }

  /* old block removed below */
  ///
  /// Solo redacta: NO toca el pedido y NO envía nada. El envío se confirma
  /// dentro del diálogo, con el mismo transporte del chat y una sola clave de
  /// operación (dos toques no crean dos mensajes).
  Future<void> _askCustomerData() async {
    final cliente = _customer;
    if (cliente == null) {
      posToast(context, 'Elige un cliente antes de pedirle datos.');
      return;
    }
    final faltan = <String>[];
    if (cliente.phone.trim().isEmpty) faltan.add('el teléfono');
    if (_lines.isEmpty) faltan.add('los artículos del pedido');
    if (_deliveryMethod == 'delivery' && _address.text.trim().isEmpty) {
      faltan.add('la ubicación de entrega');
    }
    await showDialog<void>(
      context: context,
      builder: (_) => PosOrderMessageDialog(
        customerName: cliente.name,
        customerPhone: cliente.phone,
        customerId: cliente.id,
        missing: faltan,
        totalCents: _draft.expectedTotalCents,
      ),
    );
  }

  Future<String?> _ensureDeliveryQuote() async {
    if (_mode == 'quote' || _deliveryMethod == 'pickup') return null;
    final stores = _lines
        .map((line) => line.supplierId)
        .where((id) => id.isNotEmpty)
        .toSet();
    if (stores.isEmpty) return null;
    if (stores.length != 1)
      return 'Los productos de varias tiendas necesitan repartos separados.';
    final storeId = stores.single;
    final location = _deliveryLocation;
    final latitude = numv(
      location?['latitude'] ?? location?['lat'],
      double.nan,
    ).toDouble();
    final longitude = numv(
      location?['longitude'] ?? location?['lng'],
      double.nan,
    ).toDouble();
    if (!latitude.isFinite ||
        !longitude.isFinite ||
        _deliveryLocationId.isEmpty) {
      return 'Selecciona una ubicación guardada del cliente con GPS para calcular el delivery.';
    }
    final reusable =
        _deliveryQuoteId.isNotEmpty &&
        _quotedStoreId == storeId &&
        _quotedLocationId == _deliveryLocationId &&
        (_deliveryQuoteExpiresAt?.isAfter(
              DateTime.now().add(const Duration(seconds: 10)),
            ) ??
            false);
    if (reusable) {
      if ((_deliveryFee * 100).round() != _deliveryQuotedFeeCents) {
        setState(() => _deliveryFee = _deliveryQuotedFeeCents / 100);
      }
      return null;
    }
    final store = _pickupStores
        .where((row) => str(row['id']) == storeId)
        .firstOrNull;
    final companyId = str(store?['company_id']);
    if (companyId.isEmpty)
      return 'La tienda de recogida necesita una empresa válida.';
    final response = await CrmScope.of(context, listen: false).repository
        .deliveryQuote({
          'company_id': companyId,
          'supplier_id': storeId,
          'destination': {'latitude': latitude, 'longitude': longitude},
          'destinationConfirmed': true,
        });
    final quote = mapv(response['quote']);
    final quoteId = str(quote['id']);
    final feeCents = numv(quote['fee_cents'], -1).toInt();
    final expiresAt = DateTime.tryParse(str(quote['expires_at']));
    if (quoteId.isEmpty || feeCents < 0 || expiresAt == null) {
      return 'La cotización del delivery llegó incompleta. Intenta nuevamente.';
    }
    if (!mounted) return 'La pantalla se cerró antes de cotizar.';
    setState(() {
      _deliveryQuoteId = quoteId;
      _deliveryQuotedFeeCents = feeCents;
      _deliveryQuoteExpiresAt = expiresAt;
      _quotedStoreId = storeId;
      _quotedLocationId = _deliveryLocationId;
      _deliveryFee = feeCents / 100;
    });
    return null;
  }

  Future<void> _submit() async {
    if (_saving) return;
    final scope = CrmScope.of(context, listen: false);
    final repo = scope.repository;
    final problem = _draft.validate();
    if (problem != null) {
      posToast(context, problem);
      return;
    }

    setState(() => _saving = true);
    try {
      final quoteProblem = await _ensureDeliveryQuote();
      if (quoteProblem != null && mounted)
        posToast(context, quoteProblem, tone: CrmToastTone.error);
      if (quoteProblem != null || !mounted) return;
    } on ApiException catch (error) {
      if (mounted) posToast(context, error.message, tone: CrmToastTone.error);
      return;
    } finally {
      if (mounted) setState(() => _saving = false);
    }

    if (_mode == 'invoice' && widget.desktop) {
      final method = await showPosCheckoutDialog(
        context,
        totalCents: _draft.expectedTotalCents,
        initialMethod: _method,
      );
      if (method == null || !mounted) return;
      setState(() {
        _method = method;
        _paid = true;
      });
    }
    final draft = _draft;

    // La MISMA clave mientras el borrador no cambie: reintentar es seguro.
    final requestId = _operation.requestIdFor(draft);
    setState(() => _saving = true);
    try {
      final body = draft.isQuote
          ? draft.toQuoteBody(requestId: requestId)
          : draft.toCheckoutBody(requestId: requestId);
      if (_deliveryQuoteId.isNotEmpty && _deliveryLocation != null) {
        body['location'] = {
          'latitude': numv(
            _deliveryLocation!['latitude'] ?? _deliveryLocation!['lat'],
          ),
          'longitude': numv(
            _deliveryLocation!['longitude'] ?? _deliveryLocation!['lng'],
          ),
        };
      } else if (_deliveryLocationId.isNotEmpty) {
        body['location'] = _deliveryLocationId;
      }
      final result = draft.isQuote
          ? await repo.posQuote(body, operationKey: requestId)
          : await repo.posCheckout(body, operationKey: requestId);
      if (!mounted) return;
      await _onSuccess(
        scope,
        PosOutcome.fromResponse(result),
        draft,
        requestId,
        result,
      );
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == 'delivery_quote_changed' ||
          error.code == 'delivery_destination_changed') {
        setState(() => _deliveryQuoteId = '');
      }
      await _onError(scope, PosOutcome.fromError(error), draft, requestId);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _onSuccess(
    CrmState scope,
    PosOutcome outcome,
    PosSaleDraft draft,
    String requestId,
    Map<String, dynamic> response,
  ) async {
    final total = numv(
      response['total_cents'],
      outcome.totalCents ?? draft.expectedTotalCents,
    ).toInt();
    final invoiceId = draft.mode == 'invoice' ? str(response['invoiceId']) : '';
    final documentNumber = draft.mode == 'invoice'
        ? str(
            response['invoiceNumber'],
            str(response['number'], outcome.documentNumber),
          )
        : str(response['number'], outcome.documentNumber);
    // Operación cerrada: la siguiente venta tendrá otra clave.
    _operation.reset();
    setState(() {
      _lines.clear();
      _customer = null;
      _notes.clear();
      _address.clear();
      _deliveryLocationId = '';
      _deliveryLocation = null;
      _deliveryQuoteId = '';
      _deliveryQuotedFeeCents = 0;
      _deliveryQuoteExpiresAt = null;
      _quotedStoreId = '';
      _quotedLocationId = '';
      _reference.clear();
      _scheduledAt = null;
      _paid = draft.mode == 'invoice';
      _deliveryMethod = widget.desktop ? 'pickup' : _deliveryMethod;
      _deliveryFee = 0;
      _discountType = 'none';
      _discountValue = 0;
      // El ticket quedó cerrado por el servidor (`completed`): si se sigue
      // usando el mismo id, el próximo cobro daría 409 ticket_conflict.
      _ticketId = '';
      _ticketVersion = 0;
      _quoteId = '';
      _openOrders = const [];
    });
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(
          outcome.kind == PosOutcomeKind.duplicate
              ? 'Venta ya registrada'
              : (draft.isQuote ? 'Cotización guardada' : 'Venta registrada'),
        ),
        content: Text(
          [
            if (documentNumber.isNotEmpty) 'Documento $documentNumber',
            'Total ${CrmFormat.money(total / 100)}',
            if (outcome.kind == PosOutcomeKind.duplicate)
              'El servidor ya tenía esta operación: no se ha duplicado nada.',
            if (draft.isQuote)
              'Se puede enviar al cliente por WhatsApp desde Cotizaciones.',
          ].join('\n'),
        ),
        actions: [
          if (invoiceId.isNotEmpty)
            TextButton(
              onPressed: () async {
                Navigator.pop(dialogContext);
                try {
                  final file = await scope.repository.api.getFile(
                    '/api/admin/pos/invoices/${Uri.encodeComponent(invoiceId)}/pdf',
                    fallbackName: 'factura-$invoiceId.pdf',
                  );
                  await FileOpener.saveAndOpen(file);
                } on ApiException catch (error) {
                  if (mounted) {
                    posToast(context, error.message, tone: CrmToastTone.error);
                  }
                }
              },
              child: const Text('Ver factura PDF'),
            ),
          if (outcome.quoteId.isNotEmpty && draft.isQuote)
            TextButton(
              onPressed: () async {
                Navigator.pop(dialogContext);
                try {
                  final file = await scope.repository.quoteFile(
                    outcome.quoteId,
                  );
                  await FileOpener.saveAndOpen(file);
                } on ApiException catch (error) {
                  if (mounted) {
                    posToast(context, error.message, tone: CrmToastTone.error);
                  }
                }
              },
              child: const Text('Ver PDF'),
            ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Listo'),
          ),
        ],
      ),
    );
    scope.refresh(quiet: true);
    if (mounted) _loadCatalog();
    if (mounted) _loadTickets();
    // Abierto para cobrar una cotización concreta: se devuelve a la lista para
    // que se refresque el estado del documento (`converted`).
    if (widget.initialQuote != null &&
        mounted &&
        Navigator.of(context).canPop()) {
      Navigator.of(context).pop(true);
    }
  }

  Future<void> _onError(
    CrmState scope,
    PosOutcome outcome,
    PosSaleDraft draft,
    String requestId,
  ) async {
    switch (outcome.kind) {
      case PosOutcomeKind.priceChanged:
        final refresh = await crmConfirm(
          context,
          title: 'Los precios cambiaron',
          message:
              '${outcome.message}\n\nNo se cobró nada. Puedes recargar el catálogo para cobrar con el precio nuevo.',
          confirmLabel: 'Recargar catálogo',
        );
        if (refresh) {
          _operation.reset();
          await _loadCatalog();
          _syncPricesWithCatalog();
        }
      case PosOutcomeKind.openOrdersRequiresAck:
        final create = await crmConfirm(
          context,
          title: 'Pedido abierto',
          message: '${outcome.message}\n\n¿Crear un pedido nuevo igualmente?',
          confirmLabel: 'Crear otro',
        );
        if (!create) return;
        // El intento anterior quedó registrado por el servidor con su clave:
        // confirmar «crear otro» es una operación NUEVA y necesita clave nueva.
        _operation.reset();
        final newRequestId = _operation.requestIdFor(draft);
        setState(() => _saving = true);
        try {
          final result = await scope.repository.posCheckout(
            draft.toCheckoutBody(
              requestId: newRequestId,
              acknowledgeOpen: true,
            ),
            operationKey: newRequestId,
          );
          if (!mounted) return;
          await _onSuccess(
            scope,
            PosOutcome.fromResponse(result),
            draft,
            newRequestId,
            result,
          );
        } on ApiException catch (error) {
          if (mounted) {
            posToast(context, error.message, tone: CrmToastTone.error);
          }
        } finally {
          if (mounted) setState(() => _saving = false);
        }
      case PosOutcomeKind.uncertain:
        await _handleUncertain(scope, outcome, requestId);
      case PosOutcomeKind.rejected:
        posToast(context, outcome.message);
      case PosOutcomeKind.created:
      case PosOutcomeKind.duplicate:
        break;
    }
  }

  /// Resultado DESCONOCIDO: no se reenvía a ciegas.
  Future<void> _handleUncertain(
    CrmState scope,
    PosOutcome outcome,
    String requestId,
  ) async {
    final action = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('No sabemos si la venta se registró'),
        content: Text(
          '${outcome.message}\n\n'
          'La operación conserva su identificador ($requestId). '
          'Puedes consultar el servidor o reenviar el MISMO intento: si ya estaba, no se duplicará.',
          style: const TextStyle(fontSize: 13, height: 1.4),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, 'cancel'),
            child: const Text('Cerrar'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, 'check'),
            child: const Text('Consultar estado'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, 'resend'),
            child: const Text('Reenviar'),
          ),
        ],
      ),
    );
    if (action == null || !mounted) return;
    if (action == 'check') {
      try {
        final states = await scope.repository.operationStatuses([requestId]);
        final state = states[requestId] ?? 'no_recibida';
        if (!mounted) return;
        if (state == 'completada') {
          _operation.reset();
          await crmConfirm(
            context,
            title: 'La venta sí se registró',
            message:
                'El servidor confirma que la operación se completó. No hace falta reenviar nada.',
            confirmLabel: 'Entendido',
          );
          scope.refresh(quiet: true);
        } else {
          posToast(
            context,
            state == 'en_proceso'
                ? 'Sigue en proceso en el servidor. Revisa en un momento.'
                : 'El servidor no la recibió: puedes reenviar.',
          );
        }
      } on ApiException catch (error) {
        if (mounted) posToast(context, error.message, tone: CrmToastTone.error);
      }
      return;
    }
    if (action == 'resend') {
      // Mismo requestId y misma clave: el servidor devolverá el documento
      // anterior si ya existía, en vez de crear otro.
      await _submit();
    }
  }

  /// Tras recargar el catálogo, ajusta los precios de las líneas del ticket.
  void _syncPricesWithCatalog() {
    final prices = <String, int>{};
    for (final product in _catalogProducts) {
      for (final presentation in product.presentations) {
        prices[presentation.id] = posUnitPriceCents(presentation);
      }
    }
    setState(() {
      for (var index = 0; index < _lines.length; index++) {
        final unit = prices[_lines[index].variantId];
        // Las líneas manuales no están en el catálogo: se dejan como están.
        if (unit != null && unit != _lines[index].unitPriceCents) {
          _lines[index] = _lines[index].copyWith(unitPriceCents: unit);
        }
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;

    if (widget.desktop) return _buildDesktop(context);

    final query = _search.text.trim().toLowerCase();
    final matches = query.isEmpty
        ? const <Customer>[]
        : state.customers
              .where(
                (row) =>
                    row.name.toLowerCase().contains(query) ||
                    row.phone.toLowerCase().contains(query),
              )
              .take(6)
              .toList();
    final draft = _draft;

    return Scaffold(
      backgroundColor: p.pageBg,
      // Dentro del panel de escritorio la barra superior ya pinta el título.
      appBar: widget.embedded
          ? null
          : AppBar(
              backgroundColor: p.surface,
              surfaceTintColor: Colors.transparent,
              title: Text(
                'Punto de venta',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w800,
                  color: p.ink,
                ),
              ),
            ),
      body: ListView(
        padding: EdgeInsets.only(top: widget.embedded ? 4 : 12, bottom: 110),
        children: [
          if (_operation.attempts > 1)
            CrmNotice(
              message:
                  'Reintento seguro: esta operación conserva su identificador, así que no se duplicará.',
              tone: p.primary,
              icon: Icons.verified_user_outlined,
            ),
          SectionCard(
            title: 'Cliente',
            trailing: TextButton(
              onPressed: _newCustomer,
              child: const Text('Nuevo'),
            ),
            child: Column(
              children: [
                if (_customer == null) ...[
                  CrmSearchField(
                    controller: _search,
                    hint: 'Buscar por nombre o teléfono',
                    onChanged: (_) => setState(() {}),
                  ),
                  for (final customer in matches)
                    CrmListTile(
                      title: customer.name,
                      subtitle: customer.phone,
                      leading: CrmAvatar(label: customer.name),
                      onTap: () => setState(() {
                        _customer = customer;
                        _search.clear();
                      }),
                    ),
                ] else
                  Row(
                    children: [
                      CrmAvatar(label: _customer!.name),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              _customer!.name,
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            Text(
                              _customer!.phone,
                              style: TextStyle(
                                fontSize: 12.5,
                                color: p.inkSecondary,
                              ),
                            ),
                          ],
                        ),
                      ),
                      TextButton(
                        onPressed: () => setState(() => _customer = null),
                        child: const Text('Cambiar'),
                      ),
                    ],
                  ),
              ],
            ),
          ),
          SectionCard(
            title: 'Artículos',
            trailing: TextButton(
              onPressed: _pickProduct,
              child: const Text('Agregar'),
            ),
            child: _lines.isEmpty
                ? Padding(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    child: Text(
                      'Todavía no hay artículos.',
                      style: TextStyle(fontSize: 12.5, color: p.inkSecondary),
                    ),
                  )
                : Column(
                    children: [
                      for (final line in _lines)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 6),
                          child: Row(
                            children: [
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      '${line.productName} · ${line.presentationName}',
                                      style: TextStyle(
                                        fontSize: 13,
                                        fontWeight: FontWeight.w700,
                                        color: p.ink,
                                      ),
                                    ),
                                    Text(
                                      CrmFormat.money(
                                        line.unitPriceCents / 100,
                                      ),
                                      style: TextStyle(
                                        fontSize: 11.5,
                                        color: p.inkSecondary,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              IconButton(
                                onPressed: () => setState(() {
                                  final index = _lines.indexOf(line);
                                  final next = line.quantity - 1;
                                  if (next <= 0) {
                                    _lines.removeAt(index);
                                  } else {
                                    _lines[index] = line.copyWith(
                                      quantity: next,
                                    );
                                  }
                                }),
                                icon: const Icon(
                                  Icons.remove_circle_outline_rounded,
                                  size: 20,
                                ),
                              ),
                              Text(
                                '${line.quantity}',
                                style: TextStyle(
                                  fontSize: 13.5,
                                  fontWeight: FontWeight.w800,
                                  color: p.ink,
                                ),
                              ),
                              IconButton(
                                onPressed: () => setState(() {
                                  final index = _lines.indexOf(line);
                                  _lines[index] = line.copyWith(
                                    quantity: line.quantity + 1,
                                  );
                                }),
                                icon: const Icon(
                                  Icons.add_circle_outline_rounded,
                                  size: 20,
                                ),
                              ),
                              SizedBox(
                                width: 76,
                                child: Text(
                                  CrmFormat.money(line.grossCents / 100),
                                  textAlign: TextAlign.right,
                                  style: TextStyle(
                                    fontSize: 12.5,
                                    fontWeight: FontWeight.w800,
                                    color: p.ink,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
          ),
          SectionCard(
            title: 'Tipo de documento',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Wrap(
                  spacing: 8,
                  children: [
                    for (final entry in const [
                      ('order', 'Pedido'),
                      ('invoice', 'Factura'),
                      ('quote', 'Cotización'),
                    ])
                      ChoiceChip(
                        label: Text(entry.$2),
                        selected: _mode == entry.$1,
                        onSelected: (_) => setState(() => _mode = entry.$1),
                      ),
                  ],
                ),
                if (_mode != 'quote') ...[
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 8,
                    children: [
                      for (final entry in const [
                        ('delivery', 'A domicilio'),
                        ('pickup', 'Retiro'),
                      ])
                        ChoiceChip(
                          label: Text(entry.$2),
                          selected: _deliveryMethod == entry.$1,
                          onSelected: (_) =>
                              setState(() => _deliveryMethod = entry.$1),
                        ),
                    ],
                  ),
                  if (_deliveryMethod == 'delivery') ...[
                    const SizedBox(height: 12),
                    TextField(
                      controller: _address,
                      decoration: const InputDecoration(
                        labelText: 'Dirección de entrega',
                      ),
                      textCapitalization: TextCapitalization.sentences,
                    ),
                  ],
                ],
                const SizedBox(height: 12),
                TextField(
                  controller: _notes,
                  minLines: 1,
                  maxLines: 3,
                  decoration: const InputDecoration(
                    labelText: 'Notas (opcional)',
                  ),
                  textCapitalization: TextCapitalization.sentences,
                ),
              ],
            ),
          ),
          SectionCard(
            title: 'Cobro',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SegmentedButton<String>(
                  segments: const [
                    ButtonSegment(value: 'CASH', label: Text('Efectivo')),
                    ButtonSegment(
                      value: 'TRANSFER',
                      label: Text('Transferencia'),
                    ),
                  ],
                  selected: {_method},
                  onSelectionChanged: (value) =>
                      setState(() => _method = value.first),
                ),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 8,
                  children: [
                    for (final entry in const [
                      (false, 'Por cobrar'),
                      (true, 'Pagado'),
                    ])
                      ChoiceChip(
                        label: Text(entry.$2),
                        selected: _paid == entry.$1,
                        onSelected: (_) => setState(() => _paid = entry.$1),
                      ),
                  ],
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        'Envío',
                        style: TextStyle(fontSize: 12.5, color: p.inkSecondary),
                      ),
                    ),
                    SizedBox(
                      width: 110,
                      child: TextFormField(
                        initialValue: _deliveryFee == 0
                            ? ''
                            : _deliveryFee.toStringAsFixed(2),
                        keyboardType: const TextInputType.numberWithOptions(
                          decimal: true,
                        ),
                        textAlign: TextAlign.right,
                        decoration: const InputDecoration(
                          hintText: '0.00',
                          isDense: true,
                        ),
                        onChanged: (value) => setState(
                          () => _deliveryFee =
                              double.tryParse(value.replaceAll(',', '.')) ?? 0,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Text(
              'El total se envía al servidor en centavos (expectedTotal). Si los precios del catálogo cambiaron, '
              'el servidor lo rechaza con «price_changed» y aquí no se registra nada.',
              style: TextStyle(
                fontSize: 11,
                color: p.inkSecondary,
                height: 1.35,
              ),
            ),
          ),
        ],
      ),
      // `bottomNavigationBar` ocupa todo el ancho; `bottomSheet` se encogía al
      // contenido y dejaba la barra de cobro flotando en el centro.
      bottomNavigationBar: Container(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
        decoration: BoxDecoration(
          color: p.surface,
          border: Border(top: BorderSide(color: p.line)),
        ),
        child: SafeArea(
          top: false,
          child: Row(
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    'Total a cobrar',
                    style: TextStyle(fontSize: 11.5, color: p.inkSecondary),
                  ),
                  Text(
                    CrmFormat.money(draft.expectedTotalCents / 100),
                    style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w800,
                      color: p.ink,
                    ),
                  ),
                ],
              ),
              const Spacer(),
              SizedBox(
                height: CrmSpace.touch,
                child: CrmButton(
                  label: _mode == 'quote' ? 'Guardar cotización' : 'Cobrar',
                  icon: _mode == 'quote'
                      ? Icons.description_outlined
                      : Icons.point_of_sale_rounded,
                  onPressed: _saving ? null : _submit,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Precio unitario en CENTAVOS de una presentación.
///
/// Usa `sale_price_cents` (el entero que ya calcula el servidor) y, si no
/// viniera, redondea igual que `pos-math.js`: `round(precio * 100)`.
int posUnitPriceCents(CatalogPresentation presentation) {
  final cents = presentation.salePriceCents;
  if (cents > 0) return cents;
  return (presentation.price * 100).round();
}

/// Acceso al POS desde el catálogo (botón de la cabecera).
class PosLaunchButton extends StatelessWidget {
  const PosLaunchButton({super.key});

  @override
  Widget build(BuildContext context) {
    return IconButton(
      tooltip: 'Nueva venta',
      onPressed: () => Navigator.of(
        context,
      ).push(MaterialPageRoute(builder: (_) => const PosScreen())),
      icon: const Icon(Icons.point_of_sale_rounded),
    );
  }
}

/// Diálogo de cliente nuevo. Es un widget con estado porque los controladores
/// de texto deben liberarse cuando la RUTA desaparece (después de su animación
/// de salida), no en cuanto `showDialog` devuelve el resultado.
class _NewCustomerDialog extends StatefulWidget {
  const _NewCustomerDialog();

  @override
  State<_NewCustomerDialog> createState() => _NewCustomerDialogState();
}

class _NewCustomerDialogState extends State<_NewCustomerDialog> {
  final _phone = TextEditingController();
  final _name = TextEditingController();

  @override
  void dispose() {
    _phone.dispose();
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Cliente nuevo'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _phone,
            autofocus: true,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(labelText: 'Teléfono'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _name,
            decoration: const InputDecoration(labelText: 'Nombre (opcional)'),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancelar'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, (
            phone: _phone.text.trim(),
            name: _name.text.trim(),
          )),
          child: const Text('Crear'),
        ),
      ],
    );
  }
}

class _PosToolbarButton extends StatefulWidget {
  const _PosToolbarButton({
    required this.icon,
    required this.label,
    required this.onTap,
    required this.palette,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final PosPalette palette;

  @override
  State<_PosToolbarButton> createState() => _PosToolbarButtonState();
}

class _PosToolbarButtonState extends State<_PosToolbarButton> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final p = widget.palette;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(PosMetrics.radiusButton),
        child: InkWell(
          onTap: widget.onTap,
          borderRadius: BorderRadius.circular(PosMetrics.radiusButton),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 150),
            curve: Curves.easeOut,
            height: 42,
            padding: const EdgeInsets.symmetric(horizontal: 11),
            decoration: BoxDecoration(
              color: _hovered ? p.primarySoft : p.surface,
              borderRadius: BorderRadius.circular(PosMetrics.radiusButton),
              border: Border.all(color: _hovered ? p.primaryBorder : p.border),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(widget.icon, size: 22, color: p.primary),
                const SizedBox(width: 7),
                Text(
                  widget.label,
                  style: p.text.body.copyWith(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w800,
                    height: 1.15,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
