import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../core/net/operation_key.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';

/// Ganancias del repartidor; nunca compensa dinero en custodia.
class LiquidacionesScreen extends StatefulWidget {
  const LiquidacionesScreen({super.key});

  @override
  State<LiquidacionesScreen> createState() => _LiquidacionesScreenState();
}

class _LiquidacionesScreenState extends State<LiquidacionesScreen> {
  List<Map<String, dynamic>> _companies = const [];
  List<Map<String, dynamic>> _accounts = const [];
  List<Map<String, dynamic>> _rows = const [];
  List<Map<String, dynamic>> _payouts = const [];
  Map<String, dynamic> _summary = const {};
  String? _company;
  String? _error;
  bool _started = false;
  bool _loading = true;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    _start();
  }

  Future<void> _start() async {
    try {
      final repo = CrmScope.of(context, listen: false).repository;
      final companies = await repo.logisticsCompanies();
      final accounts = await repo.courierAccounts();
      if (!mounted) return;
      setState(() {
        _companies = companies.where((row) => row['active'] != false).toList();
        _accounts = accounts;
        _company = _companies.isEmpty ? null : str(_companies.first['id']);
      });
      await _load();
    } on ApiException catch (error) {
      if (mounted)
        setState(() {
          _error = error.message;
          _loading = false;
        });
    }
  }

  Future<void> _load() async {
    final company = _company;
    if (company == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final repo = CrmScope.of(context, listen: false).repository;
      final earnings = await repo.courierEarnings(company);
      final payouts = await repo.courierPayouts(company);
      if (!mounted || company != _company) return;
      setState(() {
        _rows = listv(earnings['rows']);
        _summary = mapv(earnings['summary']);
        _payouts = listv(payouts['payouts']);
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

  String _money(Object? cents) => CrmFormat.money(numv(cents) / 100);

  String _courierName(String id) {
    for (final account in _accounts) {
      if (str(account['id']) == id) {
        return str(account['display_name'], id);
      }
    }
    return id;
  }

  Future<void> _initiate(
    String courierId,
    List<Map<String, dynamic>> rows,
  ) async {
    if (_loading) return;
    final available = rows
        .where((row) => numv(row['available_cents']) > 0)
        .toList();
    if (available.isEmpty) return;
    String method = 'transfer';
    final reference = TextEditingController();
    final note = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, update) => AlertDialog(
          title: Text('Iniciar liquidación · ${_courierName(courierId)}'),
          content: SizedBox(
            width: 420,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Saldo disponible: ${_money(available.fold<int>(0, (sum, row) => sum + numv(row['available_cents']).round()))}',
                ),
                const SizedBox(height: 10),
                DropdownButtonFormField<String>(
                  initialValue: method,
                  decoration: const InputDecoration(labelText: 'Forma de pago'),
                  items: const [
                    DropdownMenuItem(
                      value: 'transfer',
                      child: Text('Transferencia'),
                    ),
                    DropdownMenuItem(value: 'cash', child: Text('Efectivo')),
                    DropdownMenuItem(value: 'other', child: Text('Otro')),
                  ],
                  onChanged: (value) => update(() => method = value!),
                ),
                TextField(
                  controller: reference,
                  decoration: const InputDecoration(
                    labelText: 'Referencia de pago',
                  ),
                ),
                TextField(
                  controller: note,
                  decoration: const InputDecoration(labelText: 'Nota interna'),
                ),
                const SizedBox(height: 8),
                const Text(
                  'Al iniciar se reserva el saldo. Se marcará pagado solo al confirmar la salida del dinero.',
                  style: TextStyle(fontSize: 11),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancelar'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Iniciar'),
            ),
          ],
        ),
      ),
    );
    if (confirmed != true || !mounted) {
      reference.dispose();
      note.dispose();
      return;
    }
    final company = _company;
    if (company == null) return;
    try {
      await CrmScope.of(
        context,
        listen: false,
      ).repository.initiateCourierPayout({
        'company_id': company,
        'courier_account_id': courierId,
        'method': method,
        'reference': reference.text.trim(),
        'note': note.text.trim(),
        'allocations': available
            .map(
              (row) => {
                'earning_id': row['id'],
                'amount_cents': numv(row['available_cents']).round(),
              },
            )
            .toList(),
        'idempotencyKey': newOperationKey('payout'),
      });
      if (mounted) {
        crmToast(context, 'Liquidación iniciada.');
        await _load();
      }
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      reference.dispose();
      note.dispose();
    }
  }

  Future<void> _finish(Map<String, dynamic> payout, String action) async {
    if (_loading) return;
    final reference = TextEditingController(text: str(payout['reference']));
    final note = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(
          action == 'settle'
              ? 'Confirmar dinero entregado'
              : 'Registrar pago fallido',
        ),
        content: SizedBox(
          width: 410,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '${_courierName(str(payout['courier_account_id']))} · ${_money(payout['total_cents'])}',
              ),
              TextField(
                controller: reference,
                decoration: const InputDecoration(labelText: 'Referencia'),
              ),
              TextField(
                controller: note,
                decoration: const InputDecoration(labelText: 'Nota'),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(
              action == 'settle' ? 'Confirmar pago' : 'Liberar reserva',
            ),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) {
      reference.dispose();
      note.dispose();
      return;
    }
    try {
      await CrmScope.of(
        context,
        listen: false,
      ).repository.finishCourierPayout(str(payout['id']), action, {
        'company_id': _company,
        'reference': reference.text.trim(),
        'note': note.text.trim(),
        'idempotencyKey': newOperationKey('payout_finish'),
      });
      if (mounted) {
        crmToast(context, 'Liquidación actualizada.');
        await _load();
      }
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      reference.dispose();
      note.dispose();
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    if (!CrmScope.of(context).session.isAdmin) {
      return const Center(
        child: Text('Solo administración puede ver liquidaciones.'),
      );
    }
    final byCourier = <String, List<Map<String, dynamic>>>{};
    for (final row in _rows) {
      byCourier.putIfAbsent(str(row['courier_account_id']), () => []).add(row);
    }
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
          decoration: BoxDecoration(
            color: p.surface,
            border: Border(bottom: BorderSide(color: p.border)),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  'Liquidaciones · repartidores',
                  style: TextStyle(
                    color: p.ink,
                    fontWeight: FontWeight.w800,
                    fontSize: 14,
                  ),
                ),
              ),
              if (_companies.isNotEmpty)
                SizedBox(
                  width: 190,
                  child: DropdownButtonFormField<String>(
                    initialValue: _company,
                    isDense: true,
                    items: _companies
                        .map(
                          (row) => DropdownMenuItem(
                            value: str(row['id']),
                            child: Text(str(row['name'], str(row['id']))),
                          ),
                        )
                        .toList(),
                    onChanged: (value) {
                      setState(() {
                        _company = value;
                        _rows = const [];
                        _payouts = const [];
                        _summary = const {};
                      });
                      _load();
                    },
                  ),
                ),
              IconButton(
                onPressed: _load,
                tooltip: 'Actualizar',
                icon: const Icon(Icons.refresh_rounded),
              ),
            ],
          ),
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.all(8),
            child: Text(_error!, style: TextStyle(color: p.danger)),
          ),
        if (_loading) const LinearProgressIndicator(minHeight: 2),
        Expanded(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 900),
              child: ListView(
                padding: const EdgeInsets.all(12),
                children: [
                  Wrap(
                    spacing: 16,
                    runSpacing: 4,
                    children: [
                      Text('Ganado ${_money(_summary['earned_cents'])}'),
                      Text('Pagado ${_money(_summary['paid_cents'])}'),
                      Text('Reservado ${_money(_summary['reserved_cents'])}'),
                      Text(
                        'Pendiente ${_money(_summary['pending_cents'])}',
                        style: TextStyle(
                          color: p.primary,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                  const Divider(height: 24),
                  ...byCourier.entries.map((entry) {
                    final available = entry.value.fold<int>(
                      0,
                      (sum, row) => sum + numv(row['available_cents']).round(),
                    );
                    final pending = entry.value.fold<int>(
                      0,
                      (sum, row) =>
                          sum + numv(row['outstanding_cents']).round(),
                    );
                    return ListTile(
                      dense: true,
                      contentPadding: const EdgeInsets.symmetric(horizontal: 8),
                      title: Text(_courierName(entry.key)),
                      subtitle: Text(
                        '${entry.value.length} asientos · Pendiente ${_money(pending)}',
                      ),
                      trailing: available > 0
                          ? TextButton(
                              onPressed: () =>
                                  _initiate(entry.key, entry.value),
                              child: Text('Iniciar ${_money(available)}'),
                            )
                          : const Text('Sin saldo disponible'),
                    );
                  }),
                  if (byCourier.isEmpty && !_loading)
                    const Padding(
                      padding: EdgeInsets.all(18),
                      child: Text('No hay ganancias confirmadas.'),
                    ),
                  const Divider(height: 24),
                  Text(
                    'Pagos registrados',
                    style: TextStyle(color: p.ink, fontWeight: FontWeight.w700),
                  ),
                  ..._payouts.reversed.map(
                    (row) => ListTile(
                      dense: true,
                      title: Text(
                        '${_courierName(str(row['courier_account_id']))} · ${_money(row['total_cents'])}',
                      ),
                      subtitle: Text(
                        '${str(row['method'])} · ${str(row['state'], 'settled')} · ${str(row['reference'])}',
                      ),
                      trailing: row['state'] == 'initiated'
                          ? Wrap(
                              spacing: 4,
                              children: [
                                TextButton(
                                  onPressed: () => _finish(row, 'fail'),
                                  child: const Text('Falló'),
                                ),
                                FilledButton(
                                  onPressed: () => _finish(row, 'settle'),
                                  child: const Text('Confirmar'),
                                ),
                              ],
                            )
                          : null,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}
