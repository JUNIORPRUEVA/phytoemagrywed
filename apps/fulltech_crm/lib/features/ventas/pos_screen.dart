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
import '../common/pwa_icon.dart';
import '../pos_desktop/pos_cart_panel.dart';
import '../pos_desktop/pos_category_rail.dart';
import '../pos_desktop/pos_product_grid.dart';
import '../pos_desktop/pos_tokens.dart';

/// Punto de venta: cliente + artículos + cobro → pedido, factura o cotización.
///
/// Protecciones de dinero (Etapa 0):
/// · `expectedTotal` en CENTAVOS con las mismas reglas de redondeo del servidor.
/// · `requestId` estable: un reintento NO crea otro documento.
/// · `x-fulltech-operation` con la misma clave: el servidor deduplica.
/// · Sin respuesta → estado INCIERTO: nunca se reenvía solo; primero se consulta.
class PosScreen extends StatefulWidget {
  const PosScreen({super.key, this.embedded = false, this.desktop = false});

  /// Dentro del panel de escritorio (ya hay barra superior con el título).
  final bool embedded;

  /// Presentación de escritorio al estilo FullPOS: rejilla + panel de venta.
  /// La lógica (cobro, idempotencia, precios) es exactamente la misma.
  final bool desktop;

  @override
  State<PosScreen> createState() => _PosScreenState();
}

class _PosScreenState extends State<PosScreen> {
  final _search = TextEditingController();
  final _productSearch = TextEditingController();
  final _address = TextEditingController();
  final _notes = TextEditingController();
  final PosOperation _operation = PosOperation();

  Customer? _customer;
  final List<PosLine> _lines = [];
  String _mode = 'order';
  String _method = 'CASH';
  String _deliveryMethod = 'delivery';
  bool _paid = false;
  double _deliveryFee = 0;
  bool _saving = false;
  List<Map<String, dynamic>> _catalogRows = const [];
  PosRailFilter _railFilter = const PosRailFilter();

  @override
  void initState() {
    super.initState();
    _loadCatalog();
  }

  @override
  void dispose() {
    _search.dispose();
    _productSearch.dispose();
    _address.dispose();
    _notes.dispose();
    super.dispose();
  }

  PosSaleDraft get _draft => PosSaleDraft(
    mode: _mode,
    customerId: _customer?.id ?? '',
    lines: List.unmodifiable(_lines),
    deliveryFeeCents: (_deliveryFee * 100).round(),
    notes: _notes.text.trim(),
    address: _address.text.trim(),
    deliveryMethod: _deliveryMethod,
    paymentMethod: _method,
    paid: _paid,
  );

  // --------------------------------------------------------------- escritorio

  List<CatalogProduct> get _catalogProducts => [
        for (final row in _catalogRows) CatalogProduct.fromJson(row),
      ];

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
  void _addFromCatalog(CatalogProduct product, CatalogPresentation presentation) {
    final index = _lines.indexWhere((line) => line.variantId == presentation.id);
    setState(() {
      if (index >= 0) {
        final line = _lines[index];
        if (line.quantity < 9999) _lines[index] = line.copyWith(quantity: line.quantity + 1);
      } else {
        _lines.add(
          PosLine(
            variantId: presentation.id,
            productName: product.name,
            presentationName: presentation.name,
            unitPriceCents: posUnitPriceCents(presentation),
            quantity: 1,
          ),
        );
      }
    });
  }

  void _changeQuantity(PosLine line, int delta) {
    final index = _lines.indexOf(line);
    if (index < 0) return;
    final next = line.quantity + delta;
    setState(() {
      if (next <= 0) {
        _lines.removeAt(index);
      } else if (next <= 9999) {
        _lines[index] = line.copyWith(quantity: next);
      }
    });
  }

  void _removeLine(PosLine line) => setState(() => _lines.remove(line));

  /// Selector de cliente (usa la lista real de `CrmState`).
  Future<void> _pickCustomer() async {
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
                      decoration: const InputDecoration(hintText: 'Nombre o teléfono'),
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
                                  onTap: () => Navigator.of(dialogContext).pop(row),
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
    if (selected != null && mounted) setState(() => _customer = selected);
  }

  Widget _buildDesktop(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    return Material(
      color: PosColors.pageBg,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          PosCategoryRail(
            entries: PosCategoryRail.buildEntries(_catalogCategories),
            selected: _railFilter,
            onSelect: (filter) => setState(() => _railFilter = filter),
          ),
          Expanded(
            child: Column(
              children: [
                _desktopActionBar(),
                if (_operation.attempts > 1)
                  Container(
                    width: double.infinity,
                    color: PosColors.primarySoft,
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    child: Text(
                      'Reintento seguro: la operación conserva su identificador, no se duplicará.',
                      style: PosText.pill.copyWith(color: PosColors.primaryDark, fontSize: 11.5),
                    ),
                  ),
                Expanded(
                  child: PosProductGrid(
                    products: _catalogProducts,
                    query: _productSearch.text.trim(),
                    filter: _railFilter,
                    loading: _catalogRows.isEmpty,
                    onAdd: _addFromCatalog,
                  ),
                ),
              ],
            ),
          ),
          SizedBox(
            width: PosMetrics.cartWidth(width),
            child: PosCartPanel(
              lines: _lines,
              customer: _customer,
              mode: _mode,
              method: _method,
              paid: _paid,
              deliveryFee: _deliveryFee,
              saving: _saving,
              onQuantity: _changeQuantity,
              onRemove: _removeLine,
              onPickCustomer: _pickCustomer,
              onClear: () => setState(_lines.clear),
              onModeChanged: (value) => setState(() => _mode = value),
              onMethodChanged: (value) => setState(() => _method = value),
              onPaidChanged: (value) => setState(() => _paid = value),
              onDeliveryFeeChanged: (value) => setState(() => _deliveryFee = value),
              onCheckout: _submit,
            ),
          ),
        ],
      ),
    );
  }

  Widget _desktopActionBar() {
    return Container(
      height: 60,
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: const BoxDecoration(
        color: PosColors.surface,
        border: Border(bottom: BorderSide(color: PosColors.border)),
      ),
      child: Row(
        children: [
          Expanded(
            child: SizedBox(
              height: PosMetrics.searchHeight,
              child: TextField(
                controller: _productSearch,
                onChanged: (_) => setState(() {}),
                style: PosText.body,
                decoration: InputDecoration(
                  isDense: true,
                  filled: false,
                  hintText: 'Buscar producto por nombre o código...',
                  hintStyle: PosText.secondary,
                  prefixIcon: const Padding(
                    padding: EdgeInsets.only(left: 10, right: 6),
                    child: PwaIcon(PwaIcons.search, size: 15, color: PosColors.inkSecondary),
                  ),
                  prefixIconConstraints: const BoxConstraints(minWidth: 31, minHeight: 31),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(PosMetrics.radiusField),
                    borderSide: const BorderSide(color: PosColors.border),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(PosMetrics.radiusField),
                    borderSide: const BorderSide(color: PosColors.border),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          _actionButton(PwaIcons.plus, 'Agregar artículo', _pickProduct),
          const SizedBox(width: 6),
          _actionButton(PwaIcons.usersadd, 'Agregar cliente', _pickCustomer),
          const SizedBox(width: 6),
          _filterButton(),
          const SizedBox(width: 6),
          _actionButton(PwaIcons.refresh, 'Recargar catálogo', _loadCatalog),
        ],
      ),
    );
  }

  /// Filtro de existencia; el rail refleja la misma selección.
  Widget _filterButton() {
    final active = _railFilter.availability != PosAvailability.all;
    return PopupMenuButton<PosRailFilter>(
      tooltip: 'Filtrar artículos',
      initialValue: _railFilter,
      onSelected: (filter) => setState(() => _railFilter = filter),
      itemBuilder: (context) => const [
        PopupMenuItem(value: PosRailFilter(), child: Text('Todos los artículos')),
        PopupMenuItem(
          value: PosRailFilter(availability: PosAvailability.inStock),
          child: Text('Solo con stock'),
        ),
        PopupMenuItem(
          value: PosRailFilter(availability: PosAvailability.outOfStock),
          child: Text('Solo agotados'),
        ),
      ],
      child: Container(
        height: PosMetrics.actionButtonHeight,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: BoxDecoration(
          color: active ? PosColors.primarySoft : PosColors.surface,
          borderRadius: BorderRadius.circular(PosMetrics.radiusButton),
          border: Border.all(color: active ? PosColors.primaryBorder : PosColors.border),
        ),
        child: Row(
          children: [
            PwaIcon(PwaIcons.filter, size: 15, color: PosColors.primary),
            const SizedBox(width: 6),
            Text('Filtro', style: PosText.pill.copyWith(fontSize: 11.5)),
          ],
        ),
      ),
    );
  }

  Widget _actionButton(String icon, String label, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(PosMetrics.radiusButton),
      child: Container(
        height: PosMetrics.actionButtonHeight,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: BoxDecoration(
          color: PosColors.surface,
          borderRadius: BorderRadius.circular(PosMetrics.radiusButton),
          border: Border.all(color: PosColors.border),
        ),
        child: Row(
          children: [
            PwaIcon(icon, size: 15, color: PosColors.primary),
            const SizedBox(width: 6),
            Text(label, style: PosText.pill.copyWith(fontSize: 11.5)),
          ],
        ),
      ),
    );
  }

  Future<void> _loadCatalog() async {
    final repo = CrmScope.of(context, listen: false).repository;
    try {
      final data = await repo.catalog();
      if (!mounted) return;
      setState(() => _catalogRows = listv(data['catalog']));
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    }
  }

  Future<void> _pickProduct() async {
    if (_catalogRows.isEmpty) await _loadCatalog();
    if (!mounted) return;
    final options = <(CatalogProduct, CatalogPresentation)>[];
    for (final row in _catalogRows) {
      final product = CatalogProduct.fromJson(row);
      for (final presentation in product.presentations) {
        options.add((product, presentation));
      }
    }
    if (options.isEmpty) {
      crmToast(context, 'El catálogo no tiene presentaciones para vender.');
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
    setState(() {
      final index = _lines.indexWhere((line) => line.variantId == picked.$2.id);
      if (index >= 0) {
        _lines[index] = _lines[index].copyWith(
          quantity: _lines[index].quantity + 1,
        );
      } else {
        _lines.add(
          PosLine(
            variantId: picked.$2.id,
            productName: picked.$1.name,
            presentationName: picked.$2.name,
            unitPriceCents: posUnitPriceCents(picked.$2),
            quantity: 1,
          ),
        );
      }
    });
  }

  Future<void> _newCustomer() async {
    final repo = CrmScope.of(context, listen: false).repository;
    final phone = TextEditingController();
    final name = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Cliente nuevo'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: phone,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(labelText: 'Teléfono'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: name,
              decoration: const InputDecoration(labelText: 'Nombre (opcional)'),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Crear'),
          ),
        ],
      ),
    );
    final phoneText = phone.text.trim();
    final nameText = name.text.trim();
    phone.dispose();
    name.dispose();
    if (confirmed != true) return;
    if (phoneText.isEmpty) {
      if (mounted) crmToast(context, 'Escribe el teléfono del cliente.');
      return;
    }
    try {
      final result = await repo.api.post('/api/admin/pos/customers', {
        'phone': phoneText,
        'name': nameText,
      });
      if (!mounted) return;
      final customer = mapv(result['customer']);
      setState(() {
        _customer = Customer.fromJson(
          customer.isEmpty
              ? {'phone_e164': phoneText, 'name': nameText}
              : customer,
        );
      });
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    }
  }

  Future<void> _submit() async {
    if (_saving) return;
    final scope = CrmScope.of(context, listen: false);
    final repo = scope.repository;
    final draft = _draft;
    final problem = draft.validate();
    if (problem != null) {
      crmToast(context, problem);
      return;
    }

    // La MISMA clave mientras el borrador no cambie: reintentar es seguro.
    final requestId = _operation.requestIdFor(draft);
    setState(() => _saving = true);
    try {
      final result = draft.isQuote
          ? await repo.posQuote(
              draft.toQuoteBody(requestId: requestId),
              operationKey: requestId,
            )
          : await repo.posCheckout(
              draft.toCheckoutBody(requestId: requestId),
              operationKey: requestId,
            );
      if (!mounted) return;
      await _onSuccess(
        scope,
        PosOutcome.fromResponse(result),
        draft,
        requestId,
      );
    } on ApiException catch (error) {
      if (!mounted) return;
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
  ) async {
    final total = outcome.totalCents == null
        ? draft.expectedTotalCents
        : outcome.totalCents!;
    // Operación cerrada: la siguiente venta tendrá otra clave.
    _operation.reset();
    setState(() {
      _lines.clear();
      _notes.clear();
      _address.clear();
      _paid = false;
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
            if (outcome.documentNumber.isNotEmpty)
              'Documento ${outcome.documentNumber}',
            'Total ${CrmFormat.money(total / 100)}',
            if (outcome.kind == PosOutcomeKind.duplicate)
              'El servidor ya tenía esta operación: no se ha duplicado nada.',
            if (draft.isQuote)
              'Se puede enviar al cliente por WhatsApp desde Cotizaciones.',
          ].join('\n'),
        ),
        actions: [
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
                  if (mounted) crmToast(context, error.message);
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
          );
        } on ApiException catch (error) {
          if (mounted) crmToast(context, error.message);
        } finally {
          if (mounted) setState(() => _saving = false);
        }
      case PosOutcomeKind.uncertain:
        await _handleUncertain(scope, outcome, requestId);
      case PosOutcomeKind.rejected:
        crmToast(context, outcome.message);
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
          crmToast(
            context,
            state == 'en_proceso'
                ? 'Sigue en proceso en el servidor. Revisa en un momento.'
                : 'El servidor no la recibió: puedes reenviar.',
          );
        }
      } on ApiException catch (error) {
        if (mounted) crmToast(context, error.message);
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
    for (final row in _catalogRows) {
      for (final presentation in CatalogProduct.fromJson(row).presentations) {
        prices[presentation.id] = posUnitPriceCents(presentation);
      }
    }
    setState(() {
      for (var index = 0; index < _lines.length; index++) {
        final unit = prices[_lines[index].variantId];
        if (unit != null && unit != _lines[index].unitPriceCents) {
          _lines[index] = PosLine(
            variantId: _lines[index].variantId,
            productName: _lines[index].productName,
            presentationName: _lines[index].presentationName,
            unitPriceCents: unit,
            quantity: _lines[index].quantity,
          );
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
