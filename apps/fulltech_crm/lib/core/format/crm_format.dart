import 'package:intl/intl.dart';

/// Formato del panel: dinero en DOP, fechas y horas en español de RD.
class CrmFormat {
  const CrmFormat._();

  static final NumberFormat _money = NumberFormat.currency(locale: 'es_DO', symbol: r'RD$', decimalDigits: 2);
  static final NumberFormat _moneyShort = NumberFormat.currency(locale: 'es_DO', symbol: r'RD$', decimalDigits: 0);
  static final NumberFormat _int = NumberFormat.decimalPattern('es_DO');
  static final DateFormat _time = DateFormat('h:mm a', 'es');
  static final DateFormat _day = DateFormat('d MMM', 'es');
  static final DateFormat _dayFull = DateFormat('d MMM yyyy', 'es');
  static final DateFormat _month = DateFormat('MMMM', 'es');

  /// `RD$1,234.50`. Cantidades grandes se redondean (como en el panel).
  static String money(num? value, {bool short = false}) {
    final amount = (value ?? 0).toDouble();
    if (short && amount.abs() >= 1000) return _moneyShort.format(amount);
    return _money.format(amount);
  }

  static String integer(num? value) => _int.format(value ?? 0);

  static String compact(num? value) {
    final v = (value ?? 0).toDouble();
    if (v.abs() >= 1000000) return '${(v / 1000000).toStringAsFixed(1)}M';
    if (v.abs() >= 1000) return '${(v / 1000).toStringAsFixed(1)}k';
    return v.toStringAsFixed(0);
  }

  static DateTime? parse(Object? value) {
    if (value == null) return null;
    if (value is DateTime) return value;
    return DateTime.tryParse(value.toString())?.toLocal();
  }

  static String time(Object? value) {
    final date = parse(value);
    return date == null ? '' : _time.format(date);
  }

  static String day(Object? value) {
    final date = parse(value);
    return date == null ? '' : _day.format(date);
  }

  static String dayFull(Object? value) {
    final date = parse(value);
    return date == null ? '' : _dayFull.format(date);
  }

  static String month(Object? value) {
    final date = parse(value);
    return date == null ? '' : _month.format(date);
  }

  /// «Ahora», «Hace 5 min», «Ayer», «12 oct».
  static String ago(Object? value) {
    final date = parse(value);
    if (date == null) return '';
    final diff = DateTime.now().difference(date);
    if (diff.inMinutes < 1) return 'Ahora';
    if (diff.inMinutes < 60) return 'Hace ${diff.inMinutes} min';
    if (diff.inHours < 24 && date.day == DateTime.now().day) return 'Hoy ${_time.format(date)}';
    if (diff.inDays < 2) return 'Ayer ${_time.format(date)}';
    if (diff.inDays < 7) return _day.format(date);
    return _dayFull.format(date);
  }

  /// Hora corta del hilo: la hora si es hoy, si no el día.
  static String chatStamp(Object? value) {
    final date = parse(value);
    if (date == null) return '';
    final now = DateTime.now();
    if (date.year == now.year && date.month == now.month && date.day == now.day) return _time.format(date);
    return _day.format(date);
  }

  static String range(Object? from, Object? to) {
    final a = parse(from);
    final b = parse(to);
    if (a == null || b == null) return '';
    return '${_time.format(a)} – ${_time.format(b)}';
  }
}
