import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/net/api_client.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';

/// Dos reglas independientes: cobro al cliente y remuneración del repartidor.
/// Los importes son pesos en pantalla y centavos enteros en el contrato API.
class ReglasEntregaScreen extends StatefulWidget {
  const ReglasEntregaScreen({super.key});

  @override
  State<ReglasEntregaScreen> createState() => _ReglasEntregaScreenState();
}

class _ReglasEntregaScreenState extends State<ReglasEntregaScreen> {
  final _customerBase = TextEditingController();
  final _customerPerKm = TextEditingController();
  final _customerMinimum = TextEditingController();
  final _customerCoverage = TextEditingController();
  final _customerTiers = TextEditingController();
  final _courierBase = TextEditingController();
  final _courierPerKm = TextEditingController();
  final _courierMinimum = TextEditingController();
  final _courierSalePercent = TextEditingController();
  List<Map<String, dynamic>> _companies = const [];
  String? _companyId;
  String _customerMode = 'per_km';
  String _courierMode = 'DISTANCE';
  bool _customerActive = false;
  bool _courierActive = false;
  bool _loading = true;
  bool _savingCustomer = false;
  bool _savingCourier = false;
  bool _started = false;
  String? _error;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_started) {
      _started = true;
      _loadCompanies();
    }
  }

  @override
  void dispose() {
    for (final controller in [
      _customerBase,
      _customerPerKm,
      _customerMinimum,
      _customerCoverage,
      _customerTiers,
      _courierBase,
      _courierPerKm,
      _courierMinimum,
      _courierSalePercent,
    ]) {
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> _loadCompanies() async {
    try {
      final rows = await CrmScope.of(
        context,
        listen: false,
      ).repository.logisticsCompanies();
      if (!mounted) return;
      setState(() {
        _companies = rows.where((row) => row['active'] != false).toList();
        _companyId = _companies.isEmpty ? null : str(_companies.first['id']);
      });
      await _loadPolicies();
    } on ApiException catch (error) {
      if (mounted)
        setState(() {
          _error = error.message;
          _loading = false;
        });
    }
  }

  Future<void> _loadPolicies() async {
    final id = _companyId;
    if (id == null || id.isEmpty) {
      setState(() => _loading = false);
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final repo = CrmScope.of(context, listen: false).repository;
      final customerData = await repo.customerDeliveryPolicy(id);
      final courierPolicies = await repo.courierCompensationPolicies();
      if (!mounted || _companyId != id) return;
      final customer = mapv(customerData['policy']);
      final courier =
          courierPolicies
              .where((row) => str(row['company_id']) == id)
              .firstOrNull ??
          <String, dynamic>{};
      setState(() {
        _customerActive = customer['active'] == true;
        _customerMode = str(customer['mode'], 'per_km');
        _customerBase.text = _pesos(
          customer[_customerMode == 'fixed' ? 'fixed_cents' : 'base_cents'],
        );
        _customerPerKm.text = _pesos(customer['per_km_cents']);
        _customerMinimum.text = _pesos(customer['minimum_cents']);
        _customerCoverage.text = customer['max_meters'] == null
            ? ''
            : (numv(customer['max_meters']) / 1000).toString();
        _customerTiers.text = listv(customer['tiers'])
            .map(
              (row) =>
                  '${numv(row['up_to_meters']) / 1000}: ${_pesos(row['fee_cents'])}',
            )
            .join('\n');
        _courierActive = courier['active'] == true;
        final savedCourierMode = str(courier['base_model'], 'DISTANCE');
        _courierMode = const ['FIXED', 'DISTANCE'].contains(savedCourierMode)
            ? savedCourierMode
            : 'DISTANCE';
        _courierBase.text = _pesos(
          courier[_courierMode == 'FIXED'
              ? 'fixed_fee_cents'
              : 'distance_base_cents'],
        );
        _courierPerKm.text = _pesos(courier['distance_per_km_cents']);
        _courierMinimum.text = _pesos(courier['distance_min_cents']);
        _courierSalePercent.text =
            courier['product_sale_percent']?.toString() ?? '';
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

  String _pesos(Object? cents) =>
      cents is num ? (cents / 100).toStringAsFixed(2) : '';

  int _cents(
    TextEditingController controller,
    String label, {
    bool optional = false,
  }) {
    final raw = controller.text.trim().replaceAll(',', '.');
    if (optional && raw.isEmpty) return 0;
    final value = double.tryParse(raw);
    if (value == null ||
        !value.isFinite ||
        value < 0 ||
        (value * 100 - (value * 100).round()).abs() > 0.00001) {
      throw FormatException(
        'Revisa $label: usa pesos con hasta dos decimales.',
      );
    }
    return (value * 100).round();
  }

  int _meters(TextEditingController controller, String label) {
    final km = double.tryParse(controller.text.trim().replaceAll(',', '.'));
    if (km == null || !km.isFinite || km <= 0) {
      throw FormatException(
        'Revisa $label: introduce kilómetros mayores que cero.',
      );
    }
    return (km * 1000).round();
  }

  List<Map<String, int>> _tiers() {
    final rows = <Map<String, int>>[];
    for (final line in _customerTiers.text.split('\n')) {
      if (line.trim().isEmpty) continue;
      final parts = line.split(':');
      if (parts.length != 2)
        throw const FormatException('Cada tramo debe ser «km: pesos».');
      final km = double.tryParse(parts[0].trim().replaceAll(',', '.'));
      final pesos = double.tryParse(parts[1].trim().replaceAll(',', '.'));
      if (km == null ||
          km <= 0 ||
          pesos == null ||
          pesos < 0 ||
          (pesos * 100 - (pesos * 100).round()).abs() > 0.00001) {
        throw const FormatException('Revisa el tramo: «km: pesos».');
      }
      rows.add({
        'up_to_meters': (km * 1000).round(),
        'fee_cents': (pesos * 100).round(),
      });
    }
    rows.sort((a, b) => a['up_to_meters']!.compareTo(b['up_to_meters']!));
    if (rows.isEmpty ||
        rows.last['up_to_meters']! < _meters(_customerCoverage, 'cobertura')) {
      throw const FormatException(
        'Los tramos deben cubrir todos los kilómetros permitidos.',
      );
    }
    return rows;
  }

  Future<void> _saveCustomer() async {
    final id = _companyId;
    if (id == null) return;
    try {
      final policy = <String, dynamic>{
        'active': _customerActive,
        'mode': _customerMode,
        'max_meters': _meters(_customerCoverage, 'cobertura'),
        'minimum_cents': _cents(
          _customerMinimum,
          'tarifa mínima',
          optional: true,
        ),
        if (_customerMode == 'fixed')
          'fixed_cents': _cents(_customerBase, 'tarifa fija'),
        if (_customerMode == 'per_km') ...{
          'base_cents': _cents(_customerBase, 'tarifa base'),
          'per_km_cents': _cents(_customerPerKm, 'precio por km'),
        },
        if (_customerMode == 'tiers') 'tiers': _tiers(),
      };
      setState(() => _savingCustomer = true);
      await CrmScope.of(
        context,
        listen: false,
      ).repository.saveCustomerDeliveryPolicy(id, policy);
      if (mounted) crmToast(context, 'Tarifa al cliente guardada.');
    } on FormatException catch (error) {
      if (mounted) crmToast(context, error.message);
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      if (mounted) setState(() => _savingCustomer = false);
    }
  }

  Future<void> _saveCourier() async {
    final id = _companyId;
    if (id == null) return;
    try {
      final percentText = _courierSalePercent.text.trim().replaceAll(',', '.');
      final percentage = percentText.isEmpty ? 0 : double.tryParse(percentText);
      if (percentage == null || !percentage.isFinite ||
          percentage < 0 || percentage > 100) {
        throw const FormatException('La comisión debe ser un porcentaje entre 0 y 100.');
      }
      final policy = <String, dynamic>{
        'active': _courierActive,
        'base_model': _courierMode,
        'product_sale_percent': percentage,
        if (_courierMode == 'FIXED')
          'fixed_fee_cents': _cents(_courierBase, 'pago fijo'),
        if (_courierMode == 'DISTANCE') ...{
          'distance_base_cents': _cents(_courierBase, 'pago base'),
          'distance_per_km_cents': _cents(_courierPerKm, 'pago por km'),
          'distance_min_cents': _cents(
            _courierMinimum,
            'pago mínimo',
            optional: true,
          ),
        },
      };
      setState(() => _savingCourier = true);
      await CrmScope.of(
        context,
        listen: false,
      ).repository.saveCourierCompensationPolicy(id, policy);
      if (mounted) crmToast(context, 'Pago al repartidor guardado.');
    } on FormatException catch (error) {
      if (mounted) crmToast(context, error.message);
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      if (mounted) setState(() => _savingCourier = false);
    }
  }

  Widget _field(
    String label,
    TextEditingController controller, {
    String? hint,
    int lines = 1,
  }) => SizedBox(
    width: 160,
    child: TextField(
      controller: controller,
      maxLines: lines,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        isDense: true,
        border: const OutlineInputBorder(),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    if (!CrmScope.of(context).session.isAdmin) {
      return Center(
        child: Text(
          'Solo administración puede editar las reglas.',
          style: TextStyle(color: p.inkSecondary),
        ),
      );
    }
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text(_error!));
    return SingleChildScrollView(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 970),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      'Reglas de entrega',
                      style: TextStyle(
                        fontWeight: FontWeight.w800,
                        fontSize: 17,
                        color: p.ink,
                      ),
                    ),
                    const Spacer(),
                    SizedBox(
                      width: 210,
                      child: DropdownButtonFormField<String>(
                        key: ValueKey('company:$_companyId'),
                        initialValue: _companyId,
                        decoration: const InputDecoration(
                          labelText: 'Empresa',
                          isDense: true,
                          border: OutlineInputBorder(),
                        ),
                        items: _companies
                            .map(
                              (row) => DropdownMenuItem(
                                value: str(row['id']),
                                child: Text(
                                  str(row['name'], str(row['id'])),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                            )
                            .toList(),
                        onChanged: (value) {
                          setState(() => _companyId = value);
                          _loadPolicies();
                        },
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                LayoutBuilder(
                  builder: (context, constraints) {
                    final width = constraints.maxWidth < 720
                        ? constraints.maxWidth
                        : (constraints.maxWidth - 12) / 2;
                    return Wrap(
                      spacing: 12,
                      runSpacing: 12,
                      children: [
                        _panel(
                          width,
                          'Tarifa al cliente',
                          'Se cobra junto a los productos.',
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              SwitchListTile(
                                dense: true,
                                value: _customerActive,
                                title: const Text('Regla activa'),
                                onChanged: (value) =>
                                    setState(() => _customerActive = value),
                              ),
                              DropdownButtonFormField<String>(
                                key: ValueKey(
                                  'customer:$_companyId:$_customerMode',
                                ),
                                initialValue: _customerMode,
                                decoration: const InputDecoration(
                                  labelText: 'Cálculo',
                                  isDense: true,
                                ),
                                items: const [
                                  DropdownMenuItem(
                                    value: 'fixed',
                                    child: Text('Fijo'),
                                  ),
                                  DropdownMenuItem(
                                    value: 'per_km',
                                    child: Text('Por kilómetro'),
                                  ),
                                  DropdownMenuItem(
                                    value: 'tiers',
                                    child: Text('Por tramos'),
                                  ),
                                ],
                                onChanged: (value) => setState(() {
                                  _customerMode = value!;
                                  _customerBase.clear();
                                }),
                              ),
                              const SizedBox(height: 12),
                              Wrap(
                                spacing: 8,
                                runSpacing: 10,
                                children: [
                                  _field('Cobertura · km', _customerCoverage),
                                  _field('Mínimo · RD\$', _customerMinimum),
                                  if (_customerMode != 'tiers')
                                    _field(
                                      _customerMode == 'fixed'
                                          ? 'Tarifa fija · RD\$'
                                          : 'Base · RD\$',
                                      _customerBase,
                                    ),
                                  if (_customerMode == 'per_km')
                                    _field('Cobrar por km · RD\$', _customerPerKm),
                                  if (_customerMode == 'tiers')
                                    _field(
                                      'Tramos · km: pesos',
                                      _customerTiers,
                                      hint: '3: 150\n8: 250',
                                      lines: 4,
                                    ),
                                ],
                              ),
                              const SizedBox(height: 12),
                              Align(
                                alignment: Alignment.centerRight,
                                child: FilledButton(
                                  onPressed: _savingCustomer
                                      ? null
                                      : _saveCustomer,
                                  child: const Text('Guardar tarifa'),
                                ),
                              ),
                            ],
                          ),
                        ),
                        _panel(
                          width,
                          'Pago al repartidor',
                          'Se registra por separado del efectivo en custodia.',
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              SwitchListTile(
                                dense: true,
                                value: _courierActive,
                                title: const Text('Regla activa'),
                                onChanged: (value) =>
                                    setState(() => _courierActive = value),
                              ),
                              DropdownButtonFormField<String>(
                                key: ValueKey(
                                  'courier:$_companyId:$_courierMode',
                                ),
                                initialValue: _courierMode,
                                decoration: const InputDecoration(
                                  labelText: 'Cálculo',
                                  isDense: true,
                                ),
                                items: const [
                                  DropdownMenuItem(
                                    value: 'FIXED',
                                    child: Text('Fijo'),
                                  ),
                                  DropdownMenuItem(
                                    value: 'DISTANCE',
                                    child: Text('Por kilómetro'),
                                  ),
                                ],
                                onChanged: (value) => setState(() {
                                  _courierMode = value!;
                                  _courierBase.clear();
                                }),
                              ),
                              const SizedBox(height: 12),
                              Wrap(
                                spacing: 8,
                                runSpacing: 10,
                                children: [
                                  _field(
                                    _courierMode == 'FIXED'
                                        ? 'Pago fijo · RD\$'
                                        : 'Base · RD\$',
                                    _courierBase,
                                  ),
                                  if (_courierMode == 'DISTANCE') ...[
                                    _field('Pagar por km · RD\$', _courierPerKm),
                                    _field('Mínimo · RD\$', _courierMinimum),
                                  ],
                                  _field(
                                    'Comisión por productos · %',
                                    _courierSalePercent,
                                  ),
                                ],
                              ),
                              const SizedBox(height: 8),
                              Text(
                                '0 % desactiva la comisión. Se aplica al importe neto de cada producto vendido; excluye delivery, descuentos e impuestos.',
                                style: TextStyle(
                                  fontSize: 11,
                                  color: p.inkSecondary,
                                ),
                              ),
                              const SizedBox(height: 12),
                              Align(
                                alignment: Alignment.centerRight,
                                child: FilledButton(
                                  onPressed: _savingCourier
                                      ? null
                                      : _saveCourier,
                                  child: const Text('Guardar pago'),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    );
                  },
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _panel(double width, String title, String caption, Widget child) {
    final p = context.crm;
    return Container(
      width: width,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: p.surface,
        border: Border.all(color: p.border),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w800,
              color: p.ink,
            ),
          ),
          Text(caption, style: TextStyle(fontSize: 11, color: p.inkSecondary)),
          const SizedBox(height: 10),
          child,
        ],
      ),
    );
  }
}
