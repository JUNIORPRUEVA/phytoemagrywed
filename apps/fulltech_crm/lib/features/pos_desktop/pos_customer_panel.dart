import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import 'pos_toast.dart';
import 'pos_tokens.dart';

class PosCustomerPanel extends StatefulWidget {
  const PosCustomerPanel({
    super.key,
    required this.customers,
    required this.selectedCustomer,
    required this.recentOrders,
    required this.onSelectCustomer,
    required this.onClearSelection,
    required this.onCustomerUpdated,
    required this.onCreateCustomer,
    required this.onSelectLocation,
    required this.deliveryMethod,
    required this.onDeliveryMethodChanged,
    required this.deliveryFee,
    required this.onDeliveryFeeChanged,
    required this.addressController,
    required this.referenceController,
    required this.notesController,
    required this.onAddressChanged,
    required this.scheduledAt,
    required this.onScheduleChanged,
  });

  final List<Customer> customers;
  final Customer? selectedCustomer;
  final List<OrderItem> recentOrders;
  final ValueChanged<Customer> onSelectCustomer;
  final VoidCallback onClearSelection;
  final ValueChanged<Customer> onCustomerUpdated;
  final Future<bool> Function(
    String phone,
    String name,
    String location,
    String notes,
    String reference,
  )
  onCreateCustomer;
  final ValueChanged<Map<String, dynamic>> onSelectLocation;
  final String deliveryMethod;
  final ValueChanged<String> onDeliveryMethodChanged;
  final double deliveryFee;
  final ValueChanged<double> onDeliveryFeeChanged;
  final TextEditingController addressController;
  final TextEditingController referenceController;
  final TextEditingController notesController;
  final VoidCallback onAddressChanged;
  final DateTime? scheduledAt;
  final ValueChanged<DateTime?> onScheduleChanged;

  @override
  State<PosCustomerPanel> createState() => _PosCustomerPanelState();
}

class _PosCustomerPanelState extends State<PosCustomerPanel> {
  final _search = TextEditingController();
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _customerLocation = TextEditingController();
  final _customerNotes = TextEditingController();
  final _customerReference = TextEditingController();
  final _fee = TextEditingController();
  final _feeFocus = FocusNode();
  List<Map<String, dynamic>> _locations = const [];
  bool _loadingLocations = false;
  bool _creating = false;
  bool _savingCustomer = false;
  String? _locationError;

  @override
  void initState() {
    super.initState();
    _syncFee();
    if (widget.selectedCustomer != null) _loadLocations();
  }

  @override
  void didUpdateWidget(covariant PosCustomerPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.selectedCustomer?.id != widget.selectedCustomer?.id) {
      _creating = false;
      if (widget.selectedCustomer != null) _loadLocations();
    }
    if (!_feeFocus.hasFocus && oldWidget.deliveryFee != widget.deliveryFee) {
      _syncFee();
    }
  }

  @override
  void dispose() {
    _search.dispose();
    _name.dispose();
    _phone.dispose();
    _customerLocation.dispose();
    _customerNotes.dispose();
    _customerReference.dispose();
    _fee.dispose();
    _feeFocus.dispose();
    super.dispose();
  }

  void _syncFee() {
    _fee.text = widget.deliveryFee == 0
        ? ''
        : widget.deliveryFee.toStringAsFixed(0);
  }

  Future<void> _loadLocations() async {
    final customer = widget.selectedCustomer;
    if (customer == null) return;
    setState(() {
      _loadingLocations = true;
      _locationError = null;
    });
    try {
      final rows = await CrmScope.of(
        context,
        listen: false,
      ).repository.locations();
      if (!mounted || widget.selectedCustomer?.id != customer.id) return;
      setState(() {
        _locations = rows.where((row) {
          final nestedCustomer = mapv(row['customer']);
          return str(row['customer_id'], str(nestedCustomer['id'])) ==
              customer.id;
        }).toList();
        _loadingLocations = false;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _locationError = error.message;
        _loadingLocations = false;
      });
    }
  }

  /// Edita nombre, ciudad y notas del cliente.
  ///
  /// La ruta real acepta esos tres campos (`PATCH /api/admin/customers/:id`);
  /// el teléfono identifica al cliente y no se cambia aquí.
  Future<void> _editCustomer(Customer customer) async {
    final changes =
        await showDialog<({String name, String city, String notes})>(
          context: context,
          builder: (_) => _CustomerEditDialog(customer: customer),
        );
    if (changes == null || !mounted) return;
    final repository = CrmScope.of(context, listen: false).repository;
    try {
      await repository.api.patch(
        '/api/admin/customers/${Uri.encodeComponent(customer.id)}',
        {
          'name': changes.name,
          'location': changes.city,
          'notes': changes.notes,
        },
      );
      if (!mounted) return;
      widget.onCustomerUpdated(
        Customer(
          id: customer.id,
          name: changes.name.isEmpty ? customer.name : changes.name,
          phone: customer.phone,
          email: customer.email,
          stage: customer.stage,
          tags: customer.tags,
          city: changes.city,
          createdAt: customer.createdAt,
          orders: customer.orders,
          totalSpent: customer.totalSpent,
          notes: changes.notes,
          delivered: customer.delivered,
        ),
      );
      posToast(context, 'Datos del cliente actualizados.');
    } on ApiException catch (error) {
      if (mounted) posToast(context, error.message, tone: CrmToastTone.error);
    }
  }

  Future<void> _saveCustomer() async {
    final phone = _phone.text.trim();
    if (phone.isEmpty) {
      posToast(context, 'Escribe el teléfono del cliente.');
      return;
    }
    if (_name.text.trim().isEmpty) {
      posToast(context, 'Escribe el nombre del cliente.');
      return;
    }
    setState(() => _savingCustomer = true);
    try {
      final saved = await widget.onCreateCustomer(
        phone,
        _name.text.trim(),
        _customerLocation.text.trim(),
        _customerNotes.text.trim(),
        _customerReference.text.trim(),
      );
      if (mounted && saved) {
        _phone.clear();
        _name.clear();
        _customerLocation.clear();
        _customerNotes.clear();
        _customerReference.clear();
      }
    } finally {
      if (mounted) setState(() => _savingCustomer = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final customer = widget.selectedCustomer;
    final p = PosPalette.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 8, 2),
          child: Row(
            children: [
              Icon(Icons.person_outline_rounded, size: 18, color: p.primary),
              const SizedBox(width: 6),
              Expanded(child: Text('Cliente y entrega', style: p.text.title)),
              if (customer != null)
                TextButton(
                  onPressed: widget.onClearSelection,
                  style: TextButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    minimumSize: const Size(0, 32),
                  ),
                  child: const Text(
                    'Cambiar',
                    style: TextStyle(fontSize: 12.5),
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
            children: [
              if (_creating)
                _newCustomerForm(p)
              else if (customer == null)
                _customerPicker(p)
              else ...[
                _customerSummary(customer, p),
                const SizedBox(height: 10),
                _recentOrders(customer, p),
                const SizedBox(height: 10),
                _deliveryDetails(p),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _customerPicker(PosPalette p) {
    final needle = _search.text.trim().toLowerCase();
    final matches = widget.customers
        .where((customer) {
          return needle.isEmpty ||
              customer.name.toLowerCase().contains(needle) ||
              customer.phone.toLowerCase().contains(needle) ||
              customer.email.toLowerCase().contains(needle);
        })
        .take(100)
        .toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: _search,
          autofocus: true,
          onChanged: (_) => setState(() {}),
          style: p.text.body.copyWith(fontSize: 13),
          decoration: InputDecoration(
            isDense: true,
            hintText: 'Buscar cliente por nombre o teléfono',
            prefixIcon: const Icon(Icons.search_rounded, size: 19),
            prefixIconConstraints: const BoxConstraints(
              minWidth: 34,
              minHeight: 34,
            ),
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 8,
              vertical: 10,
            ),
            suffixIcon: Tooltip(
              message: 'Crear cliente',
              child: IconButton(
                onPressed: () => setState(() => _creating = true),
                icon: const Icon(Icons.person_add_alt_1_rounded, size: 23),
                color: p.primary,
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
              ),
            ),
            suffixIconConstraints: const BoxConstraints(
              minWidth: 44,
              minHeight: 44,
            ),
          ),
        ),
        const SizedBox(height: 4),
        for (final customer in matches)
          _CustomerRow(
            customer: customer,
            palette: p,
            onSelect: () {
              widget.onSelectCustomer(customer);
              setState(() => _search.clear());
            },
            onView: () => _viewCustomer(customer),
          ),
        if (matches.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 14),
            child: Text(
              'No hay clientes que coincidan.',
              style: p.text.secondary,
            ),
          ),
      ],
    );
  }

  Future<void> _viewCustomer(Customer customer) => showDialog<void>(
    context: context,
    builder: (dialogContext) {
      final p = PosPalette.of(dialogContext);
      return AlertDialog(
        title: Text(customer.name),
        content: SizedBox(
          width: 340,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _infoRow(Icons.phone_outlined, customer.phone, p),
              if (customer.email.isNotEmpty)
                _infoRow(Icons.mail_outline_rounded, customer.email, p),
              if (customer.city.isNotEmpty)
                _infoRow(Icons.location_on_outlined, customer.city, p),
              if (customer.notes.isNotEmpty)
                _infoRow(Icons.notes_rounded, customer.notes, p),
              const SizedBox(height: 12),
              Text(
                'Pedidos: ${customer.orders}  ·  Entregados: ${customer.delivered}',
                style: p.text.secondary,
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Cerrar'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.of(dialogContext).pop();
              widget.onSelectCustomer(customer);
            },
            child: const Text('Seleccionar'),
          ),
        ],
      );
    },
  );

  Widget _newCustomerForm(PosPalette p) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Nuevo cliente', style: p.text.title),
        const SizedBox(height: 6),
        Text(
          'Completa la ficha y la referencia de esta entrega.',
          style: p.text.secondary.copyWith(fontSize: 11.5),
        ),
        const SizedBox(height: 10),
        TextField(
          controller: _phone,
          autofocus: true,
          keyboardType: TextInputType.phone,
          decoration: const InputDecoration(
            labelText: 'Teléfono con código de país',
          ),
        ),
        TextField(
          controller: _name,
          textCapitalization: TextCapitalization.words,
          decoration: const InputDecoration(labelText: 'Nombre'),
        ),
        TextField(
          controller: _customerLocation,
          textCapitalization: TextCapitalization.sentences,
          decoration: const InputDecoration(labelText: 'Dirección o sector'),
        ),
        TextField(
          controller: _customerReference,
          textCapitalization: TextCapitalization.sentences,
          decoration: const InputDecoration(labelText: 'Referencia de entrega'),
        ),
        TextField(
          controller: _customerNotes,
          minLines: 2,
          maxLines: 3,
          decoration: const InputDecoration(labelText: 'Notas del cliente'),
        ),
        const SizedBox(height: 12),
        SizedBox(
          height: 42,
          child: FilledButton.icon(
            onPressed: _savingCustomer ? null : _saveCustomer,
            icon: _savingCustomer
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.check_rounded, size: 19),
            label: const Text('Crear cliente'),
          ),
        ),
        TextButton(
          onPressed: () => setState(() => _creating = false),
          child: const Text('Volver a la lista'),
        ),
      ],
    );
  }

  Widget _customerSummary(Customer customer, PosPalette p) {
    final stats = [
      ('Pedidos', '${customer.orders}'),
      ('Entregados', '${customer.delivered}'),
      ('Compras', CrmFormat.money(customer.totalSpent)),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                customer.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: p.text.body.copyWith(
                  fontSize: 14.5,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
            if (customer.stage.isNotEmpty)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: p.primarySoft,
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  customer.stage,
                  style: p.text.pill.copyWith(fontSize: 10.5),
                ),
              ),
            const SizedBox(width: 4),
            TextButton.icon(
              onPressed: () => _editCustomer(customer),
              style: TextButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                minimumSize: const Size(0, 32),
                foregroundColor: p.primary,
              ),
              icon: const Icon(Icons.edit_outlined, size: 16),
              label: const Text('Editar', style: TextStyle(fontSize: 12.5)),
            ),
          ],
        ),
        Row(
          children: [
            Icon(Icons.phone_outlined, size: 14, color: p.inkSecondary),
            const SizedBox(width: 5),
            Expanded(
              child: Text(
                customer.phone,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: p.text.secondary,
              ),
            ),
          ],
        ),
        if (customer.tags.isNotEmpty) ...[
          const SizedBox(height: 6),
          Wrap(
            spacing: 5,
            runSpacing: 5,
            children: [for (final tag in customer.tags) _tag(tag, p)],
          ),
        ],
        const SizedBox(height: 8),
        Row(
          children: [
            for (var index = 0; index < stats.length; index++) ...[
              if (index > 0) const SizedBox(width: 6),
              Expanded(child: _stat(stats[index].$1, stats[index].$2, p)),
            ],
          ],
        ),
        if (customer.email.isNotEmpty)
          _infoRow(Icons.mail_outline_rounded, customer.email, p),
        if (customer.city.isNotEmpty)
          _infoRow(Icons.location_city_outlined, customer.city, p),
        if (customer.notes.isNotEmpty)
          _infoRow(Icons.notes_rounded, customer.notes, p),
      ],
    );
  }

  Widget _recentOrders(Customer customer, PosPalette p) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _sectionTitle('Compras recientes', p),
        if (widget.recentOrders.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text('Sin compras registradas.', style: p.text.secondary),
          )
        else
          for (final order in widget.recentOrders.take(4))
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 5),
              child: Row(
                children: [
                  Icon(
                    Icons.receipt_long_outlined,
                    size: 16,
                    color: p.inkSecondary,
                  ),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${order.label} · ${order.variantName}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: p.text.body.copyWith(
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        Text(
                          CrmFormat.ago(order.receivedAt),
                          style: p.text.secondary.copyWith(fontSize: 11),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    CrmFormat.money(order.total, short: true),
                    style: p.text.body.copyWith(fontWeight: FontWeight.w800),
                  ),
                ],
              ),
            ),
      ],
    );
  }

  Widget _deliveryDetails(PosPalette p) {
    final customer = widget.selectedCustomer!;
    final locations = _locations.where((row) {
      final nestedCustomer = mapv(row['customer']);
      return str(row['customer_id'], str(nestedCustomer['id'])) == customer.id;
    }).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _sectionTitle('Entrega', p),
        SegmentedButton<String>(
          segments: const [
            ButtonSegment(value: 'delivery', label: Text('Domicilio')),
            ButtonSegment(value: 'pickup', label: Text('Retiro')),
          ],
          selected: {widget.deliveryMethod},
          onSelectionChanged: (value) =>
              widget.onDeliveryMethodChanged(value.first),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: Text(
                'Costo de delivery',
                style: p.text.body.copyWith(fontWeight: FontWeight.w700),
              ),
            ),
            SizedBox(
              width: 112,
              child: TextField(
                controller: _fee,
                focusNode: _feeFocus,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: false,
                ),
                textAlign: TextAlign.right,
                onChanged: (value) => widget.onDeliveryFeeChanged(
                  double.tryParse(value.replaceAll(',', '.')) ?? 0,
                ),
                decoration: const InputDecoration(
                  isDense: true,
                  suffixText: 'DOP',
                ),
              ),
            ),
          ],
        ),
        if (widget.deliveryMethod == 'delivery') ...[
          const SizedBox(height: 8),
          TextField(
            controller: widget.addressController,
            onChanged: (_) => widget.onAddressChanged(),
            decoration: const InputDecoration(
              labelText: 'Dirección de entrega',
              prefixIcon: Icon(Icons.place_outlined),
            ),
          ),
          if (_loadingLocations)
            const Padding(
              padding: EdgeInsets.all(10),
              child: LinearProgressIndicator(minHeight: 2),
            )
          else if (_locationError != null)
            Text(
              _locationError!,
              style: TextStyle(color: p.danger, fontSize: 12),
            )
          else if (locations.isNotEmpty) ...[
            const SizedBox(height: 7),
            Text(
              'Ubicaciones guardadas',
              style: p.text.secondary.copyWith(fontWeight: FontWeight.w700),
            ),
            for (final location in locations.take(5))
              _locationTile(location, p),
          ] else
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Text(
                'No hay una ubicación GPS guardada para este cliente.',
                style: p.text.secondary,
              ),
            ),
          TextField(
            controller: widget.referenceController,
            decoration: const InputDecoration(
              labelText: 'Referencia de entrega',
            ),
          ),
          _schedulePicker(p),
        ],
        TextField(
          controller: widget.notesController,
          minLines: 1,
          maxLines: 2,
          decoration: const InputDecoration(labelText: 'Notas de la venta'),
        ),
      ],
    );
  }

  Widget _locationTile(Map<String, dynamic> location, PosPalette p) {
    final address = str(
      location['address'],
      str(
        location['label'],
        str(location['name'], str(location['location'], 'Ubicación guardada')),
      ),
    );
    final latitude = numv(
      location['latitude'] ?? location['lat'],
      double.nan,
    ).toDouble();
    final longitude = numv(
      location['longitude'] ?? location['lng'],
      double.nan,
    ).toDouble();
    final hasGps = latitude.isFinite && longitude.isFinite;
    final coordinates = hasGps
        ? '${latitude.toStringAsFixed(5)}, ${longitude.toStringAsFixed(5)}'
        : 'GPS no disponible';
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: Icon(Icons.my_location_rounded, size: 17, color: p.primary),
      title: Text(
        address,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: p.text.body.copyWith(fontWeight: FontWeight.w700),
      ),
      subtitle: Text(
        coordinates,
        style: p.text.secondary.copyWith(fontSize: 11),
      ),
      trailing: const Icon(Icons.north_west_rounded, size: 15),
      onTap: () => widget.onSelectLocation(location),
    );
  }

  Widget _schedulePicker(PosPalette p) {
    final at = widget.scheduledAt;
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        children: [
          Expanded(
            child: Text(
              at == null
                  ? 'Entrega sin programar'
                  : 'Entrega: ${CrmFormat.dayFull(at.toIso8601String())} · ${CrmFormat.time(at.toIso8601String())}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: p.text.secondary,
            ),
          ),
          TextButton(
            onPressed: () async {
              final now = DateTime.now();
              final date = await showDatePicker(
                context: context,
                initialDate: at ?? now,
                firstDate: DateTime(now.year, now.month, now.day),
                lastDate: now.add(const Duration(days: 365)),
              );
              if (date == null || !mounted) return;
              final time = await showTimePicker(
                context: context,
                initialTime: TimeOfDay.fromDateTime(
                  at ?? now.add(const Duration(hours: 2)),
                ),
              );
              if (time == null || !mounted) return;
              widget.onScheduleChanged(
                DateTime(
                  date.year,
                  date.month,
                  date.day,
                  time.hour,
                  time.minute,
                ),
              );
            },
            child: Text(at == null ? 'Programar' : 'Cambiar'),
          ),
          if (at != null)
            IconButton(
              tooltip: 'Quitar horario',
              onPressed: () => widget.onScheduleChanged(null),
              icon: const Icon(Icons.close_rounded, size: 17),
              visualDensity: VisualDensity.compact,
            ),
        ],
      ),
    );
  }

  Widget _sectionTitle(String label, PosPalette p) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Text(
      label,
      style: p.text.body.copyWith(fontWeight: FontWeight.w800, fontSize: 13),
    ),
  );

  Widget _stat(String label, String value, PosPalette p) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
    decoration: BoxDecoration(
      color: p.surfaceMuted,
      borderRadius: BorderRadius.circular(7),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: p.text.secondary.copyWith(fontSize: 10.5),
        ),
        const SizedBox(height: 2),
        Text(
          value,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: p.text.body.copyWith(fontWeight: FontWeight.w800),
        ),
      ],
    ),
  );

  Widget _infoRow(IconData icon, String value, PosPalette p) => Padding(
    padding: const EdgeInsets.only(top: 6),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 15, color: p.inkSecondary),
        const SizedBox(width: 7),
        Expanded(
          child: Text(
            value,
            style: p.text.secondary,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    ),
  );

  Widget _tag(String label, PosPalette p) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
    decoration: BoxDecoration(
      color: p.primarySoft,
      borderRadius: BorderRadius.circular(14),
    ),
    child: Text(label, style: p.text.pill.copyWith(fontSize: 10.5)),
  );
}

/// Fila compacta de la lista: nombre a la izquierda y teléfono a la derecha.
class _CustomerRow extends StatelessWidget {
  const _CustomerRow({
    required this.customer,
    required this.palette,
    required this.onSelect,
    required this.onView,
  });

  final Customer customer;
  final PosPalette palette;
  final VoidCallback onSelect;
  final VoidCallback onView;

  @override
  Widget build(BuildContext context) {
    final p = palette;
    return Container(
      height: 46,
      padding: const EdgeInsets.symmetric(horizontal: 4),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: p.borderSoft)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  customer.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: p.text.body.copyWith(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text(
                  customer.phone,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: p.text.secondary.copyWith(fontSize: 11),
                ),
              ],
            ),
          ),
          const SizedBox(width: 6),
          TextButton(
            onPressed: onSelect,
            style: TextButton.styleFrom(
              foregroundColor: p.primary,
              minimumSize: const Size(0, 34),
              padding: const EdgeInsets.symmetric(horizontal: 9),
            ),
            child: const Text('Seleccionar', style: TextStyle(fontSize: 12)),
          ),
          const SizedBox(width: 3),
          OutlinedButton(
            onPressed: onView,
            style: OutlinedButton.styleFrom(
              minimumSize: const Size(0, 32),
              padding: const EdgeInsets.symmetric(horizontal: 10),
              side: BorderSide(color: p.border),
            ),
            child: const Text('Ver', style: TextStyle(fontSize: 12)),
          ),
        ],
      ),
    );
  }
}

/// Diálogo de edición del cliente (nombre, ciudad y notas).
class _CustomerEditDialog extends StatefulWidget {
  const _CustomerEditDialog({required this.customer});

  final Customer customer;

  @override
  State<_CustomerEditDialog> createState() => _CustomerEditDialogState();
}

class _CustomerEditDialogState extends State<_CustomerEditDialog> {
  late final TextEditingController _name = TextEditingController(
    text: widget.customer.name,
  );
  late final TextEditingController _city = TextEditingController(
    text: widget.customer.city,
  );
  late final TextEditingController _notes = TextEditingController(
    text: widget.customer.notes,
  );

  @override
  void dispose() {
    _name.dispose();
    _city.dispose();
    _notes.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Editar cliente'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(widget.customer.phone, style: const TextStyle(fontSize: 12.5)),
            const SizedBox(height: 10),
            TextField(
              controller: _name,
              autofocus: true,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(labelText: 'Nombre'),
            ),
            TextField(
              controller: _city,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(labelText: 'Ciudad'),
            ),
            TextField(
              controller: _notes,
              minLines: 1,
              maxLines: 3,
              decoration: const InputDecoration(labelText: 'Notas'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancelar'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop((
            name: _name.text.trim(),
            city: _city.text.trim(),
            notes: _notes.text.trim(),
          )),
          child: const Text('Guardar'),
        ),
      ],
    );
  }
}
