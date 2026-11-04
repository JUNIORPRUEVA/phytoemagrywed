import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/net/api_client.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';

/// Relaciona productos del catálogo existente con una tienda de recogida.
class ProductStoreDialog extends StatefulWidget {
  const ProductStoreDialog({super.key, required this.store});

  final Map<String, dynamic> store;

  @override
  State<ProductStoreDialog> createState() => _ProductStoreDialogState();
}

class _ProductStoreDialogState extends State<ProductStoreDialog> {
  List<Map<String, dynamic>> _products = const [];
  List<Map<String, dynamic>> _links = const [];
  final _search = TextEditingController();
  final _code = TextEditingController();
  final _cost = TextEditingController();
  final _price = TextEditingController();
  String? _selectedId;
  String _availability = 'unknown';
  bool _loading = true;
  bool _saving = false;
  bool _changed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    _code.dispose();
    _cost.dispose();
    _price.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final repo = CrmScope.of(context, listen: false).repository;
    try {
      final products = await repo.pickupStoreProducts();
      final links = await repo.productSuppliers();
      if (!mounted) return;
      setState(() {
        _products = products
            .where(
              (row) =>
                  str(row['store']) == str(widget.store['company_id']) &&
                  row['archived'] != true,
            )
            .toList();
        _links = links
            .where((row) => str(row['supplier_id']) == str(widget.store['id']))
            .toList();
        _loading = false;
      });
    } on ApiException catch (error) {
      if (mounted) {
        setState(() => _loading = false);
        crmToast(context, error.message);
      }
    }
  }

  Map<String, dynamic>? _link(String id) {
    for (final link in _links) {
      if (str(link['product_id']) == id) return link;
    }
    return null;
  }

  void _select(Map<String, dynamic> product) {
    final id = str(product['id']);
    final link = _link(id);
    setState(() {
      _selectedId = id;
      _code.text = str(link?['supplier_code']);
      _cost.text = _fromCents(link?['cost_cents']);
      _price.text = _fromCents(link?['authorized_price_cents']);
      _availability = str(link?['availability'], 'unknown');
    });
  }

  String _fromCents(Object? value) =>
      value is num ? (value / 100).toStringAsFixed(2) : '';

  int? _cents(String input) {
    final text = input.trim().replaceAll(',', '');
    if (text.isEmpty) return null;
    final value = double.tryParse(text);
    if (value == null || !value.isFinite || value < 0) return -1;
    return (value * 100).round();
  }

  Future<void> _save() async {
    final id = _selectedId;
    if (id == null) return;
    final cost = _cents(_cost.text);
    final price = _cents(_price.text);
    if (cost == -1 || price == -1) {
      crmToast(context, 'Revisa el costo y el precio.');
      return;
    }
    setState(() => _saving = true);
    try {
      await CrmScope.of(
        context,
        listen: false,
      ).repository.saveProductSupplier(id, {
        'supplier_id': widget.store['id'],
        'supplier_code': _code.text.trim(),
        'cost_cents': cost,
        'authorized_price_cents': price,
        'availability': _availability,
        'verified_at': _availability == 'available'
            ? DateTime.now().toUtc().toIso8601String()
            : null,
        'active': true,
      });
      _changed = true;
      await _load();
      if (mounted) crmToast(context, 'Producto vinculado a la tienda.');
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _remove() async {
    final id = _selectedId;
    if (id == null || _link(id) == null) return;
    setState(() => _saving = true);
    try {
      await CrmScope.of(
        context,
        listen: false,
      ).repository.removeProductSupplier(id, str(widget.store['id']));
      _changed = true;
      await _load();
      if (mounted) {
        _select(_products.firstWhere((row) => str(row['id']) == id));
      }
      if (mounted) crmToast(context, 'Relación retirada.');
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final query = _search.text.trim().toLowerCase();
    final visible = _products
        .where(
          (row) => '${row['name']} ${row['sku']}'.toLowerCase().contains(query),
        )
        .toList();
    final selected = _selectedId == null
        ? null
        : _products.where((row) => str(row['id']) == _selectedId).firstOrNull;
    return AlertDialog(
      title: Text('Productos · ${str(widget.store['name'])}'),
      content: SizedBox(
        width: 720,
        height: 480,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : Row(
                children: [
                  Expanded(
                    child: Column(
                      children: [
                        TextField(
                          controller: _search,
                          onChanged: (_) => setState(() {}),
                          decoration: const InputDecoration(
                            prefixIcon: Icon(Icons.search),
                            hintText: 'Buscar producto',
                            border: OutlineInputBorder(),
                            isDense: true,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Expanded(
                          child: ListView.builder(
                            itemCount: visible.length,
                            itemBuilder: (context, index) {
                              final product = visible[index];
                              final id = str(product['id']);
                              final linked = _link(id) != null;
                              return ListTile(
                                dense: true,
                                selected: id == _selectedId,
                                title: Text(
                                  str(product['name']),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                subtitle: Text(
                                  str(product['sku'], id),
                                  maxLines: 1,
                                ),
                                trailing: linked
                                    ? const Icon(
                                        Icons.check_circle,
                                        color: Colors.green,
                                        size: 18,
                                      )
                                    : null,
                                onTap: () => _select(product),
                              );
                            },
                          ),
                        ),
                      ],
                    ),
                  ),
                  const VerticalDivider(width: 22),
                  SizedBox(
                    width: 285,
                    child: selected == null
                        ? const Center(child: Text('Selecciona un producto.'))
                        : SingleChildScrollView(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  str(selected['name']),
                                  style: const TextStyle(
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                                const SizedBox(height: 12),
                                TextField(
                                  controller: _code,
                                  decoration: const InputDecoration(
                                    labelText: 'Referencia de la tienda',
                                    border: OutlineInputBorder(),
                                    isDense: true,
                                  ),
                                ),
                                const SizedBox(height: 10),
                                TextField(
                                  controller: _cost,
                                  keyboardType: TextInputType.number,
                                  decoration: const InputDecoration(
                                    labelText: 'Costo de compra · DOP',
                                    border: OutlineInputBorder(),
                                    isDense: true,
                                  ),
                                ),
                                const SizedBox(height: 10),
                                TextField(
                                  controller: _price,
                                  keyboardType: TextInputType.number,
                                  decoration: const InputDecoration(
                                    labelText: 'Precio autorizado · DOP',
                                    border: OutlineInputBorder(),
                                    isDense: true,
                                  ),
                                ),
                                const SizedBox(height: 10),
                                DropdownButtonFormField<String>(
                                  initialValue: _availability,
                                  decoration: const InputDecoration(
                                    labelText: 'Disponibilidad declarada',
                                    border: OutlineInputBorder(),
                                    isDense: true,
                                  ),
                                  items: const [
                                    DropdownMenuItem(
                                      value: 'unknown',
                                      child: Text('Pendiente de confirmar'),
                                    ),
                                    DropdownMenuItem(
                                      value: 'available',
                                      child: Text('Disponible'),
                                    ),
                                    DropdownMenuItem(
                                      value: 'unavailable',
                                      child: Text('No disponible'),
                                    ),
                                  ],
                                  onChanged: (value) =>
                                      setState(() => _availability = value!),
                                ),
                                const SizedBox(height: 12),
                                Row(
                                  children: [
                                    Expanded(
                                      child: FilledButton(
                                        onPressed: _saving ? null : _save,
                                        child: const Text('Guardar relación'),
                                      ),
                                    ),
                                    if (_link(_selectedId!) != null)
                                      IconButton(
                                        onPressed: _saving ? null : _remove,
                                        tooltip: 'Retirar relación',
                                        icon: const Icon(
                                          Icons.link_off_rounded,
                                        ),
                                      ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                  ),
                ],
              ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(_changed),
          child: const Text('Cerrar'),
        ),
      ],
    );
  }
}
