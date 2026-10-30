import 'package:flutter/material.dart';

import '../../core/format/crm_format.dart';
import '../../core/net/api_client.dart';
import '../../core/net/operation_key.dart';
import '../../core/pos/pos_sale.dart';
import '../../data/crm_repository.dart';
import '../../data/models/crm_models.dart';
import 'pos_tokens.dart';

/// Tickets aparcados del POS (`/api/admin/pos/tickets`).
///
/// Qué son: un ticket guardado es un **borrador**, no una venta. No descuenta
/// stock, no mueve caja y no genera pedido. Lo que sí hace el servidor es
/// versionarlo: dos cajas no pueden cobrar el mismo ticket porque el segundo
/// `checkout` con `ticketId` recibe `409 ticket_conflict`.
///
/// Estado y transiciones (en `server/pos-tickets.mjs`): `open` → `processing` →
/// `completed` | `discarded`. La lista trae hasta 200; ADMIN ve las de todos y
/// cada usuario solo las suyas.
class PosTicketSummary {
  const PosTicketSummary({
    required this.id,
    required this.name,
    required this.status,
    required this.version,
    required this.updatedAt,
    required this.customerName,
    required this.lines,
    required this.totalCents,
    required this.raw,
  });

  final String id;
  final String name;
  final String status;
  final int version;
  final String updatedAt;
  final String customerName;
  final int lines;
  final int totalCents;
  final Map<String, dynamic> raw;

  static PosTicketSummary fromJson(Map<String, dynamic> row) {
    final draft = mapv(row['draft']);
    final items = listv(draft['items']);
    final discount = mapv(draft['discount']);
    final subtotal = items.fold<int>(0, (sum, line) {
      final price = numv(line['unitPriceCents'] ?? line['price_cents'], 0).toInt();
      final quantity = numv(line['quantity'], 1).toInt();
      return sum + price * quantity;
    });
    final value = numv(discount['value'], 0).toDouble();
    final reduction = discount['type'] == 'percent'
        ? (subtotal * value / 100).round()
        : discount['type'] == 'amount'
            ? (value * 100).round()
            : 0;
    final delivery = (numv(draft['deliveryFee'], 0).toDouble() * 100).round();
    return PosTicketSummary(
      id: str(row['id']),
      name: str(row['name'], 'Ticket'),
      status: str(row['status'], 'open'),
      version: numv(row['version'], 1).toInt(),
      updatedAt: str(row['updated_at']),
      customerName: str(mapv(draft['customer'])['name']),
      lines: items.length,
      totalCents: subtotal - reduction + delivery,
      raw: row,
    );
  }

  bool get isOpen => status == 'open';
}

/// Carga la lista de tickets y deja elegir uno para reanudar, o descartarlo.
/// Devuelve el ticket elegido (o `null` si se cierra el diálogo).
Future<PosTicketSummary?> showTicketsDialog(
  BuildContext context, {
  required CrmRepository repository,
}) async {
  final p = PosPalette.of(context);
  List<PosTicketSummary> tickets = const [];
  String? error;
  String? busyId;
  var loading = true;

  return showDialog<PosTicketSummary>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (dialogContext, setDialogState) {
        Future<void> load() async {
          setDialogState(() {
            loading = true;
            error = null;
          });
          try {
            final data = await repository.posTickets();
            setDialogState(() {
              tickets = data.map(PosTicketSummary.fromJson).toList();
              loading = false;
            });
          } on ApiException catch (exception) {
            setDialogState(() {
              error = exception.message;
              loading = false;
            });
          }
        }

        Future<void> discard(PosTicketSummary ticket) async {
          setDialogState(() => busyId = ticket.id);
          try {
            await repository.discardTicket(
              ticket.id,
              version: ticket.version,
              operationKey: newOperationKey('tkt'),
            );
            await load();
          } on ApiException catch (exception) {
            setDialogState(() => error = exception.message);
          } finally {
            setDialogState(() => busyId = null);
          }
        }

        if (loading && tickets.isEmpty && error == null) load();

        return AlertDialog(
          title: const Text('Tickets guardados'),
          content: SizedBox(
            width: 520,
            height: 380,
            child: loading
                ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Un ticket guardado es un borrador: no descuenta stock ni registra cobro. '
                        'Al cobrarlo, el servidor lo cierra y no permite cobrarlo dos veces.',
                        style: TextStyle(fontSize: 12, color: p.inkSecondary),
                      ),
                      const SizedBox(height: 8),
                      if (error != null)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: Text(error!, style: TextStyle(fontSize: 12.5, color: p.danger)),
                        ),
                      Expanded(
                        child: tickets.isEmpty
                            ? Center(
                                child: Text('No hay tickets guardados.', style: TextStyle(fontSize: 13, color: p.inkSecondary)),
                              )
                            : ListView.separated(
                                itemCount: tickets.length,
                                separatorBuilder: (_, _) => Divider(height: 1, color: p.borderSoft),
                                itemBuilder: (context, index) {
                                  final ticket = tickets[index];
                                  return ListTile(
                                    dense: true,
                                    title: Text('${ticket.name} · ${ticket.customerName.isEmpty ? 'sin cliente' : ticket.customerName}'),
                                    subtitle: Text(
                                      [
                                        '${ticket.lines} artículo(s)',
                                        CrmFormat.money(ticket.totalCents / 100),
                                        CrmFormat.ago(ticket.updatedAt),
                                        if (!ticket.isOpen) ticket.status,
                                      ].join(' · '),
                                      style: const TextStyle(fontSize: 11.5),
                                    ),
                                    trailing: ticket.isOpen
                                        ? Row(
                                            mainAxisSize: MainAxisSize.min,
                                            children: [
                                              TextButton(
                                                onPressed: () => Navigator.of(dialogContext).pop(ticket),
                                                child: const Text('Reanudar'),
                                              ),
                                              IconButton(
                                                tooltip: 'Descartar',
                                                onPressed: busyId == ticket.id ? null : () => discard(ticket),
                                                icon: busyId == ticket.id
                                                    ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                                                    : Icon(Icons.delete_outline_rounded, size: 18, color: p.danger),
                                              ),
                                            ],
                                          )
                                        : Text(ticket.status, style: TextStyle(fontSize: 11.5, color: p.inkSecondary)),
                                  );
                                },
                              ),
                      ),
                    ],
                  ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: const Text('Cerrar')),
            TextButton(onPressed: load, child: const Text('Recargar')),
          ],
        );
      },
    ),
  );
}

/// Convierte el borrador de un ticket en líneas del POS.
///
/// El ticket guarda `variantId` y `cantidad`, no precios: el precio se toma del
/// catálogo vigente, porque el servidor recalcula todo al cobrar y un precio
/// viejo acabaría en `409 price_changed`.
({Customer? customer, List<PosLine> lines, String? problem}) resumeTicket(
  PosTicketSummary ticket,
  List<Map<String, dynamic>> catalogRows,
) {
  final draft = mapv(ticket.raw['draft']);
  final customerRow = mapv(draft['customer']);
  final customerId = str(draft['customerId'], str(customerRow['id']));
  final customer = customerId.isEmpty
      ? null
      : Customer(
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
  final lines = <PosLine>[];
  final missing = <String>[];
  for (final item in listv(draft['items'])) {
    final variantId = str(item['variantId']);
    final quantity = numv(item['quantity'], 1).toInt();
    // Descuento de línea guardado (misma forma que `line.discount`).
    final descuento = mapv(item['discount']);
    final tipoDescuento = str(descuento['type'], 'none');
    final valorDescuento = numv(descuento['value'], 0).toDouble();
    // Las ventas fuera de inventario NO existen en el catálogo: se reconstruyen
    // tal como se guardaron (si no, al reanudar el ticket se perdían la línea,
    // su precio y su descuento).
    final manual = mapv(item['manual']);
    if (manual.isNotEmpty) {
      final precio = numv(manual['price'], 0).toDouble();
      lines.add(
        PosLine(
          variantId: variantId,
          productName: str(manual['name'], 'Fuera de inventario'),
          presentationName: 'Fuera de inventario',
          unitPriceCents: (precio * 100).round(),
          quantity: quantity,
          discountType: tipoDescuento,
          discountValue: valorDescuento,
          manualName: str(manual['name']),
          manualKind: str(manual['kind'], 'product'),
          manualPrice: precio,
          manualCost: manual['cost'] == null ? null : numv(manual['cost'], 0).toDouble(),
        ),
      );
      continue;
    }
    Map<String, dynamic>? row;
    for (final candidate in catalogRows) {
      if (str(candidate['id']) == variantId) {
        row = candidate;
        break;
      }
    }
    if (row == null) {
      missing.add(variantId);
      continue;
    }
    lines.add(
      PosLine(
        variantId: variantId,
        productName: str(row['name'], str(row['label'], 'Producto')),
        presentationName: str(row['label'], str(row['presentation'])),
        unitPriceCents: (numv(row['price'], 0).toDouble() * 100).round(),
        quantity: quantity,
        discountType: tipoDescuento,
        discountValue: valorDescuento,
      ),
    );
  }
  return (
    customer: customer,
    lines: lines,
    problem: missing.isEmpty ? null : 'Estos artículos ya no están en el catálogo: ${missing.join(', ')}.',
  );
}
