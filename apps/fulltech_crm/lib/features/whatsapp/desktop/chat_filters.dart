import '../../../data/models/crm_models.dart';

/// Filtros de la bandeja de escritorio.
///
/// Son los MISMOS que aplica el servidor al panel PWA
/// (`GET /api/admin/conversations`): estado, etapa del cliente y rango de
/// fechas. Aquí se aplican en memoria sobre las filas que ya tiene el
/// `CrmState`, así el filtrado es instantáneo y no gasta peticiones.
enum ChatStatusFilter { todos, noLeidos, pendientes, clientes, seguimiento, sinAsignar, archivados }

enum ChatStageFilter { todas, prospectos, interesados, recompra, inactivos }

enum ChatDateFilter { cualquiera, hoy, ayer, ultimos7, esteMes }

const Map<ChatStatusFilter, String> chatStatusLabels = {
  ChatStatusFilter.todos: 'Todos',
  ChatStatusFilter.noLeidos: 'Sin leer',
  ChatStatusFilter.pendientes: 'Pendientes',
  ChatStatusFilter.clientes: 'Clientes con compra',
  ChatStatusFilter.seguimiento: 'Con seguimiento',
  ChatStatusFilter.sinAsignar: 'Sin asignar',
  ChatStatusFilter.archivados: 'Archivados',
};

const Map<ChatStageFilter, String> chatStageLabels = {
  ChatStageFilter.todas: 'Todas las etapas',
  ChatStageFilter.prospectos: 'Prospectos',
  ChatStageFilter.interesados: 'Interesados',
  ChatStageFilter.recompra: 'Recompra',
  ChatStageFilter.inactivos: 'Inactivos',
};

const Map<ChatDateFilter, String> chatDateLabels = {
  ChatDateFilter.cualquiera: 'Cualquier fecha',
  ChatDateFilter.hoy: 'Hoy',
  ChatDateFilter.ayer: 'Ayer',
  ChatDateFilter.ultimos7: 'Últimos 7 días',
  ChatDateFilter.esteMes: 'Este mes',
};

const Map<ChatStageFilter, String> _stageCodes = {
  ChatStageFilter.prospectos: 'PROSPECT',
  ChatStageFilter.interesados: 'INTERESTED',
  ChatStageFilter.recompra: 'REPEAT_CUSTOMER',
  ChatStageFilter.inactivos: 'INACTIVE',
};

class ChatFilters {
  const ChatFilters({
    this.status = ChatStatusFilter.todos,
    this.stage = ChatStageFilter.todas,
    this.date = ChatDateFilter.cualquiera,
  });

  final ChatStatusFilter status;
  final ChatStageFilter stage;
  final ChatDateFilter date;

  /// Cuántos filtros están activos (para el punto del botón).
  int get activeCount =>
      (status == ChatStatusFilter.todos ? 0 : 1) +
      (stage == ChatStageFilter.todas ? 0 : 1) +
      (date == ChatDateFilter.cualquiera ? 0 : 1);

  bool get isDefault => activeCount == 0;

  ChatFilters copyWith({ChatStatusFilter? status, ChatStageFilter? stage, ChatDateFilter? date}) =>
      ChatFilters(
        status: status ?? this.status,
        stage: stage ?? this.stage,
        date: date ?? this.date,
      );

  /// ¿La fila entra con estos filtros? [now] se inyecta para poder probarlo.
  bool matches(Conversation row, {DateTime? now}) {
    if (status == ChatStatusFilter.archivados) {
      if (!row.archived) return false;
    } else {
      if (row.archived) return false;
      switch (status) {
        case ChatStatusFilter.noLeidos:
          if (row.unread <= 0) return false;
        case ChatStatusFilter.pendientes:
          if (!row.awaitingReply) return false;
        case ChatStatusFilter.clientes:
          if (!row.hasPurchase) return false;
        case ChatStatusFilter.seguimiento:
          if (row.nextFollowupAt.isEmpty) return false;
        case ChatStatusFilter.sinAsignar:
          if (row.assigned) return false;
        case ChatStatusFilter.todos:
        case ChatStatusFilter.archivados:
          break;
      }
    }
    final code = _stageCodes[stage];
    if (code != null && row.stage.toUpperCase() != code) return false;
    if (date != ChatDateFilter.cualquiera) {
      final at = DateTime.tryParse(row.lastAt);
      if (at == null) return false;
      final today = _dayOf(now ?? DateTime.now());
      final day = _dayOf(at.toLocal());
      switch (date) {
        case ChatDateFilter.hoy:
          if (day != today) return false;
        case ChatDateFilter.ayer:
          if (day != today - 1) return false;
        case ChatDateFilter.ultimos7:
          if (today - day > 6) return false;
        case ChatDateFilter.esteMes:
          // Mismo año y mes (la codificación es año*10000 + mes*100 + día).
          if (day ~/ 100 != today ~/ 100) return false;
        case ChatDateFilter.cualquiera:
          break;
      }
    }
    return true;
  }

  @override
  bool operator ==(Object other) =>
      other is ChatFilters && other.status == status && other.stage == stage && other.date == date;

  @override
  int get hashCode => Object.hash(status, stage, date);
}

/// Día como entero comparable (año*10000 + mes*100 + día).
int _dayOf(DateTime value) => value.year * 10000 + value.month * 100 + value.day;
