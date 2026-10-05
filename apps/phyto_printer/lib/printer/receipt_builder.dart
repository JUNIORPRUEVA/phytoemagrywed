import 'dart:convert';
import 'dart:math';

import 'printer_models.dart';

enum ReceiptAlign { left, center, right }

class ReceiptBuilder {
  ReceiptBuilder({required this.paperWidth, this.autoCut = true});

  final PrinterPaperWidth paperWidth;
  final bool autoCut;
  final List<int> _bytes = <int>[];

  int get columns => paperWidth.columns;

  List<int> buildTestTicket(PrinterDevice device) {
    reset();
    text('PHYTOEMAGRY', align: ReceiptAlign.center, bold: true);
    feed();
    text('Prueba de impresion', align: ReceiptAlign.center);
    feed();
    text('Impresora:', bold: true);
    text(device.userLabel);
    feed();
    text('Ancho:', bold: true);
    text(paperWidth.label);
    feed();
    text('Estado:', bold: true);
    text('Conexion correcta');
    divider();
    text('Impresion realizada con exito', align: ReceiptAlign.center);
    feed(lines: 3);
    cut();
    return bytes();
  }

  List<int> buildOrderTicket(ReceiptOrder order) {
    reset();
    text('PHYTOEMAGRY', align: ReceiptAlign.center, bold: true);
    text('Factura de compra', align: ReceiptAlign.center);
    feed();
    keyValue('Pedido:', order.orderNumber);
    keyValue('Fecha:', _date(order.createdAt));
    keyValue('Cliente:', order.customerName);
    if ((order.paymentMethod ?? '').trim().isNotEmpty) {
      keyValue('Pago:', order.paymentMethod!.trim());
    }
    divider();
    for (final item in order.items) {
      text(item.name, bold: true);
      columnsText(
        '${item.quantity} x ${money(item.unitPrice, order.currency)}',
        money(item.total, order.currency),
      );
    }
    divider();
    columnsText('TOTAL', money(order.total, order.currency), bold: true);
    if ((order.note ?? '').trim().isNotEmpty) {
      feed();
      text(order.note!.trim());
    }
    feed();
    text('Gracias por su compra', align: ReceiptAlign.center);
    feed(lines: 3);
    cut();
    return bytes();
  }

  void reset() {
    _bytes
      ..clear()
      ..addAll([0x1b, 0x40]);
  }

  void text(
    String value, {
    ReceiptAlign align = ReceiptAlign.left,
    bool bold = false,
  }) {
    _align(align);
    _bold(bold);
    for (final line in _wrap(_sanitize(value), columns)) {
      _bytes.addAll(latin1.encode(line));
      _newline();
    }
    _bold(false);
    _align(ReceiptAlign.left);
  }

  void keyValue(String key, String value) {
    final cleanKey = _sanitize(key);
    final cleanValue = _sanitize(value);
    final available = max(1, columns - cleanKey.length - 1);
    final wrapped = _wrap(cleanValue, available);
    for (var index = 0; index < wrapped.length; index += 1) {
      final left = index == 0 ? cleanKey : '';
      columnsText(left, wrapped[index]);
    }
  }

  void columnsText(String left, String right, {bool bold = false}) {
    _align(ReceiptAlign.left);
    _bold(bold);
    final cleanLeft = _sanitize(left);
    final cleanRight = _sanitize(right);
    final rightWidth = min(max(10, columns ~/ 3), max(1, columns - 1));
    final leftWidth = max(1, columns - rightWidth);
    final leftLines = _wrap(cleanLeft, leftWidth);
    final rightLines = _wrap(cleanRight, rightWidth);
    final lineCount = max(leftLines.length, rightLines.length);
    for (var i = 0; i < lineCount; i += 1) {
      final l = i < leftLines.length ? leftLines[i] : '';
      final r = i < rightLines.length ? rightLines[i] : '';
      final gap = max(1, columns - l.length - r.length);
      _bytes.addAll(latin1.encode('$l${' ' * gap}$r'));
      _newline();
    }
    _bold(false);
  }

  void divider([String char = '-']) {
    _bytes.addAll(latin1.encode(char.substring(0, 1) * columns));
    _newline();
  }

  void feed({int lines = 1}) {
    for (var i = 0; i < lines; i += 1) {
      _newline();
    }
  }

  void cut() {
    if (!autoCut) return;
    _bytes.addAll([0x1d, 0x56, 0x42, 0x00]);
  }

  List<int> bytes() => List<int>.unmodifiable(_bytes);

  static String money(num value, [String currency = 'DOP']) {
    final amount = value.round().toString();
    final parts = <String>[];
    for (var i = amount.length; i > 0; i -= 3) {
      parts.insert(0, amount.substring(max(0, i - 3), i));
    }
    final symbol = currency == 'DOP' ? 'RD\$' : currency;
    return '$symbol${parts.join(',')}';
  }

  void _align(ReceiptAlign align) {
    final value = switch (align) {
      ReceiptAlign.left => 0,
      ReceiptAlign.center => 1,
      ReceiptAlign.right => 2,
    };
    _bytes.addAll([0x1b, 0x61, value]);
  }

  void _bold(bool enabled) {
    _bytes.addAll([0x1b, 0x45, enabled ? 1 : 0]);
  }

  void _newline() {
    _bytes.add(0x0a);
  }

  String _date(DateTime value) {
    final local = value.toLocal();
    String two(int input) => input.toString().padLeft(2, '0');
    return '${two(local.day)}/${two(local.month)}/${local.year} ${two(local.hour)}:${two(local.minute)}';
  }

  String _sanitize(String value) {
    const replacements = {
      'á': 'a',
      'é': 'e',
      'í': 'i',
      'ó': 'o',
      'ú': 'u',
      'Á': 'A',
      'É': 'E',
      'Í': 'I',
      'Ó': 'O',
      'Ú': 'U',
      'ñ': 'n',
      'Ñ': 'N',
      'ü': 'u',
      'Ü': 'U',
      '–': '-',
      '—': '-',
      '“': '"',
      '”': '"',
      '’': "'",
    };
    var out = value.trim().replaceAll(RegExp(r'\s+'), ' ');
    for (final entry in replacements.entries) {
      out = out.replaceAll(entry.key, entry.value);
    }
    return out.replaceAll(RegExp(r'[^\x20-\x7E]'), '');
  }

  List<String> _wrap(String value, int width) {
    if (value.isEmpty) return [''];
    final lines = <String>[];
    final words = value.split(' ');
    var current = '';
    for (final word in words) {
      if (word.length > width) {
        if (current.isNotEmpty) {
          lines.add(current);
          current = '';
        }
        for (var i = 0; i < word.length; i += width) {
          lines.add(word.substring(i, min(i + width, word.length)));
        }
      } else if (current.isEmpty) {
        current = word;
      } else if (current.length + 1 + word.length <= width) {
        current = '$current $word';
      } else {
        lines.add(current);
        current = word;
      }
    }
    if (current.isNotEmpty) lines.add(current);
    return lines;
  }
}
