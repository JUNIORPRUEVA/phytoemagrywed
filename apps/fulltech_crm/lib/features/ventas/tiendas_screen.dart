import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/net/api_client.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import 'product_store_dialog.dart';

/// Directorio único de tiendas de recogida, separado del catálogo de venta.
class TiendasScreen extends StatefulWidget {
  const TiendasScreen({super.key});

  @override
  State<TiendasScreen> createState() => _TiendasScreenState();
}

class _TiendasScreenState extends State<TiendasScreen> {
  List<Map<String, dynamic>> _rows = const [];
  List<Map<String, dynamic>> _companies = const [];
  Map<String, int> _productCounts = const {};
  String _query = '';
  bool _loading = true;
  bool _started = false;
  String? _error;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_started) {
      _started = true;
      _load();
    }
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final state = CrmScope.of(context, listen: false);
      final rows = await state.repository.suppliers();
      final links = await state.repository.productSuppliers();
      final counts = <String, int>{};
      for (final link in links) {
        final id = str(link['supplier_id']);
        if (id.isNotEmpty) counts[id] = (counts[id] ?? 0) + 1;
      }
      final companies = state.session.isAdmin
          ? await state.repository.logisticsCompanies()
          : <Map<String, dynamic>>[];
      if (mounted)
        setState(() {
          _rows = rows;
          _companies = companies;
          _productCounts = counts;
          _loading = false;
        });
    } on ApiException catch (error) {
      if (mounted)
        setState(() {
          _error = error.message;
          _loading = false;
        });
    }
  }

  Future<void> _edit([Map<String, dynamic>? row]) async {
    final updated = await showDialog<bool>(
      context: context,
      builder: (context) => _StoreDialog(row: row, companies: _companies),
    );
    if (updated == true && mounted) await _load();
  }

  Future<void> _products(Map<String, dynamic> row) async {
    final changed = await showDialog<bool>(
      context: context,
      builder: (context) => ProductStoreDialog(store: row),
    );
    if (changed == true && mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final admin = CrmScope.of(context).session.isAdmin;
    final filtered = _rows
        .where(
          (row) => '${row['name']} ${row['address']} ${row['company_id']}'
              .toLowerCase()
              .contains(_query.toLowerCase()),
        )
        .toList();
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(
            color: p.surface,
            border: Border(bottom: BorderSide(color: p.border)),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  'Tiendas de recogida',
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w800,
                    color: p.ink,
                  ),
                ),
              ),
              if (admin)
                FilledButton.icon(
                  onPressed: () => _edit(),
                  icon: const Icon(Icons.add_rounded, size: 17),
                  label: const Text('Nueva tienda'),
                ),
              IconButton(
                onPressed: _load,
                tooltip: 'Actualizar',
                icon: const Icon(Icons.refresh_rounded, size: 19),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 6),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 850),
            child: TextField(
              onChanged: (value) => setState(() => _query = value),
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search, size: 19),
                hintText: 'Buscar por nombre, dirección o empresa',
                isDense: true,
                border: OutlineInputBorder(),
              ),
            ),
          ),
        ),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
              ? Center(child: Text(_error!))
              : filtered.isEmpty
              ? Center(
                  child: Text(
                    'No hay tiendas para mostrar.',
                    style: TextStyle(color: p.inkSecondary),
                  ),
                )
              : ListView.separated(
                  padding: const EdgeInsets.fromLTRB(14, 6, 14, 14),
                  itemCount: filtered.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 5),
                  itemBuilder: (context, index) {
                    final row = filtered[index];
                    final gps = row['lat'] != null && row['lng'] != null;
                    final active = row['active'] != false;
                    return Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 850),
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: 8,
                          ),
                          decoration: BoxDecoration(
                            color: p.surface,
                            border: Border.all(color: p.border),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Row(
                            children: [
                              Icon(
                                Icons.storefront_outlined,
                                color: active ? p.primary : p.inkSecondary,
                                size: 22,
                              ),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      str(row['name']),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontSize: 13,
                                        fontWeight: FontWeight.w700,
                                        color: p.ink,
                                      ),
                                    ),
                                    Text(
                                      str(
                                        row['address'],
                                        'Dirección pendiente',
                                      ),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontSize: 11,
                                        color: p.inkSecondary,
                                      ),
                                    ),
                                    Text(
                                      '${_productCounts[str(row['id'])] ?? 0} productos relacionados',
                                      style: TextStyle(
                                        fontSize: 10,
                                        color: p.inkSecondary,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              const SizedBox(width: 8),
                              _badge(
                                gps ? 'GPS' : 'Sin GPS',
                                gps ? p.success : p.warning,
                              ),
                              const SizedBox(width: 5),
                              _badge(
                                active ? 'Activa' : 'Inactiva',
                                active ? p.primary : p.inkSecondary,
                              ),
                              if (admin)
                                IconButton(
                                  onPressed: () => _products(row),
                                  tooltip: 'Relacionar productos',
                                  icon: const Icon(
                                    Icons.inventory_2_outlined,
                                    size: 18,
                                  ),
                                ),
                              if (admin)
                                IconButton(
                                  onPressed: () => _edit(row),
                                  tooltip: 'Editar tienda',
                                  icon: const Icon(
                                    Icons.edit_outlined,
                                    size: 18,
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ),
                    );
                  },
                ),
        ),
      ],
    );
  }

  Widget _badge(String label, Color color) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
    decoration: BoxDecoration(
      color: color.withValues(alpha: .1),
      borderRadius: BorderRadius.circular(5),
    ),
    child: Text(
      label,
      style: TextStyle(fontSize: 10, color: color, fontWeight: FontWeight.w700),
    ),
  );
}

class _StoreDialog extends StatefulWidget {
  const _StoreDialog({required this.row, required this.companies});
  final Map<String, dynamic>? row;
  final List<Map<String, dynamic>> companies;

  @override
  State<_StoreDialog> createState() => _StoreDialogState();
}

class _StoreDialogState extends State<_StoreDialog> {
  late final Map<String, TextEditingController> _fields;
  late String _type;
  String? _companyId;
  late bool _active;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    final row = widget.row ?? const <String, dynamic>{};
    _fields = {
      for (final key in [
        'name',
        'address',
        'lat',
        'lng',
        'maps_url',
        'phone',
        'whatsapp',
        'responsible',
        'hours',
        'pickup_instructions',
        'notes',
      ])
        key: TextEditingController(text: row[key]?.toString() ?? ''),
    };
    _type = str(row['type'], 'store');
    _active = row['active'] != false;
    _companyId = str(
      row['company_id'],
      widget.companies.isEmpty ? '' : str(widget.companies.first['id']),
    );
  }

  @override
  void dispose() {
    for (final controller in _fields.values) {
      controller.dispose();
    }
    super.dispose();
  }

  Widget _field(String key, String label, {int lines = 1}) => TextField(
    controller: _fields[key],
    maxLines: lines,
    decoration: InputDecoration(
      labelText: label,
      isDense: true,
      border: const OutlineInputBorder(),
    ),
  );

  Future<void> _save() async {
    if (_companyId == null ||
        _companyId!.isEmpty ||
        _fields['name']!.text.trim().length < 2) {
      crmToast(context, 'Elige empresa y escribe el nombre de la tienda.');
      return;
    }
    final latitude = _fields['lat']!.text.trim().replaceAll(',', '.');
    final longitude = _fields['lng']!.text.trim().replaceAll(',', '.');
    if ((latitude.isEmpty != longitude.isEmpty) ||
        (latitude.isNotEmpty &&
            (double.tryParse(latitude) == null ||
                double.tryParse(longitude) == null))) {
      crmToast(context, 'El GPS necesita latitud y longitud válidas.');
      return;
    }
    setState(() => _saving = true);
    try {
      final data = <String, dynamic>{
        for (final field in _fields.entries) field.key: field.value.text.trim(),
        'company_id': _companyId,
        'type': _type,
        'active': _active,
        'lat': latitude.isEmpty ? null : double.parse(latitude),
        'lng': longitude.isEmpty ? null : double.parse(longitude),
      };
      await CrmScope.of(context, listen: false).repository.saveSupplier(
        data,
        id: widget.row == null ? null : str(widget.row!['id']),
      );
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(
        widget.row == null ? 'Nueva tienda de recogida' : 'Editar tienda',
      ),
      content: SizedBox(
        width: 580,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButtonFormField<String>(
                initialValue: _companyId,
                decoration: const InputDecoration(
                  labelText: 'Empresa',
                  isDense: true,
                  border: OutlineInputBorder(),
                ),
                items: widget.companies
                    .map(
                      (row) => DropdownMenuItem(
                        value: str(row['id']),
                        child: Text(str(row['name'], str(row['id']))),
                      ),
                    )
                    .toList(),
                onChanged: widget.row == null
                    ? (value) => setState(() => _companyId = value)
                    : null,
              ),
              const SizedBox(height: 9),
              _field('name', 'Nombre comercial'),
              const SizedBox(height: 9),
              DropdownButtonFormField<String>(
                initialValue: _type,
                decoration: const InputDecoration(
                  labelText: 'Tipo',
                  isDense: true,
                  border: OutlineInputBorder(),
                ),
                items: const [
                  DropdownMenuItem(value: 'store', child: Text('Tienda')),
                  DropdownMenuItem(value: 'supplier', child: Text('Proveedor')),
                  DropdownMenuItem(value: 'warehouse', child: Text('Almacén')),
                  DropdownMenuItem(value: 'other', child: Text('Otro')),
                ],
                onChanged: (value) => setState(() => _type = value!),
              ),
              const SizedBox(height: 9),
              _field('address', 'Dirección de recogida'),
              const SizedBox(height: 9),
              Row(
                children: [
                  Expanded(child: _field('lat', 'Latitud')),
                  const SizedBox(width: 8),
                  Expanded(child: _field('lng', 'Longitud')),
                ],
              ),
              const SizedBox(height: 9),
              _field('maps_url', 'Enlace de mapa'),
              const SizedBox(height: 9),
              Row(
                children: [
                  Expanded(child: _field('phone', 'Teléfono privado')),
                  const SizedBox(width: 8),
                  Expanded(child: _field('whatsapp', 'WhatsApp privado')),
                ],
              ),
              const SizedBox(height: 9),
              _field('responsible', 'Persona responsable'),
              const SizedBox(height: 9),
              _field('hours', 'Horario'),
              const SizedBox(height: 9),
              _field(
                'pickup_instructions',
                'Instrucciones de recogida',
                lines: 2,
              ),
              const SizedBox(height: 9),
              _field('notes', 'Notas internas', lines: 2),
              SwitchListTile(
                dense: true,
                value: _active,
                title: const Text('Tienda activa'),
                onChanged: (value) => setState(() => _active = value),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Cancelar'),
        ),
        FilledButton(
          onPressed: _saving ? null : _save,
          child: const Text('Guardar'),
        ),
      ],
    );
  }
}
