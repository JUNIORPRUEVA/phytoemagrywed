import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/files/file_opener.dart';
import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../core/theme/crm_theme.dart';
import '../../data/models/crm_models.dart';
import '../common/crm_ui.dart';
import '../common/remote_view.dart';

/// Cotizaciones guardadas, con sus dos acciones reales: abrir el PDF y enviarla
/// al cliente por la plantilla oficial de WhatsApp (nunca `wa.me`).
class CotizacionesScreen extends StatelessWidget {
  const CotizacionesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = CrmScope.of(context);
    final p = context.crm;

    return Column(
      children: [
        const CrmPageHeader(title: 'Cotizaciones', subtitle: 'Documentos guardados y su estado'),
        Expanded(
          child: RemoteLoader<List<Map<String, dynamic>>>(
            load: state.repository.quotes,
            loadingLabel: 'Cargando cotizaciones',
            emptyCheck: (rows) => rows.isEmpty,
            emptyBuilder: (context) => const EmptyState(
              title: 'Sin cotizaciones',
              message: 'Las cotizaciones que se guarden en el Punto de venta aparecen aquí.',
              icon: Icons.description_outlined,
            ),
            builder: (context, rows, reload) => ListView(
              padding: const EdgeInsets.only(bottom: 24),
              children: [
                for (final row in rows)
                  _QuoteCard(row: row, onChanged: () => state.refresh(quiet: true)),
                if (rows.isEmpty) const SizedBox.shrink(),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Text(
                    '${rows.length} documento(s). El envío sale por WhatsApp con la API oficial y deja el mensaje escrito en el CRM.',
                    style: TextStyle(fontSize: 11, color: p.inkSecondary),
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

class _QuoteCard extends StatefulWidget {
  const _QuoteCard({required this.row, required this.onChanged});

  final Map<String, dynamic> row;
  final VoidCallback onChanged;

  @override
  State<_QuoteCard> createState() => _QuoteCardState();
}

class _QuoteCardState extends State<_QuoteCard> {
  bool _busy = false;

  String get _id => str(widget.row['id']);
  String get _customer => str(mapv(widget.row['customer'])['name'], str(widget.row['customer_name'], 'Cliente'));
  String get _phone => str(mapv(widget.row['customer'])['phone_e164'], str(mapv(widget.row['customer'])['phone']));
  double get _total {
    final sale = mapv(widget.row['sale']);
    final cents = sale['total_cents'];
    if (cents is num) return cents / 100;
    return dub(widget.row['total'], dub(sale['total']));
  }

  Future<void> _openPdf() async {
    if (_busy) return;
    final repo = CrmScope.of(context, listen: false).repository;
    setState(() => _busy = true);
    try {
      final file = await repo.quoteFile(_id);
      await FileOpener.saveAndOpen(file);
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _send() async {
    if (_busy) return;
    final confirmed = await crmConfirm(
      context,
      title: 'Enviar al cliente',
      message: 'Se manda la cotización por WhatsApp a ${_phone.isEmpty ? 'su número' : _phone} con la plantilla oficial.',
      confirmLabel: 'Enviar',
    );
    if (!confirmed || !mounted) return;
    final repo = CrmScope.of(context, listen: false).repository;
    setState(() => _busy = true);
    try {
      await repo.sendQuoteWhatsapp(_id);
      if (mounted) crmToast(context, 'Cotización enviada.');
      widget.onChanged();
    } on ApiException catch (error) {
      if (mounted) crmToast(context, error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final status = str(widget.row['status'], str(widget.row['kind'], 'cotización'));
    final number = str(widget.row['number'], str(widget.row['id']));
    return SectionCard(
      title: '$number · $_customer',
      trailing: StatusPill(label: status, dense: true),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          CrmListTile(
            title: CrmFormat.money(_total),
            subtitle: [
              if (_phone.isNotEmpty) _phone,
              CrmFormat.ago(widget.row['created_at']),
            ].join(' · '),
            leading: CrmAvatar(label: _customer, icon: Icons.description_outlined),
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Expanded(
                child: CrmButton(
                  label: 'Ver PDF',
                  icon: Icons.picture_as_pdf_outlined,
                  filled: false,
                  onPressed: _busy ? null : _openPdf,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: CrmButton(
                  label: 'Enviar',
                  icon: Icons.send_rounded,
                  onPressed: _busy ? null : _send,
                ),
              ),
            ],
          ),
          if (_busy)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: LinearProgressIndicator(minHeight: 2, color: p.primary),
            ),
        ],
      ),
    );
  }
}
