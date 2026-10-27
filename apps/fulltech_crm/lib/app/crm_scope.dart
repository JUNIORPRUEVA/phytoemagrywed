import 'package:flutter/material.dart';

import '../app/crm_state.dart';

/// Acceso al estado del panel desde cualquier pantalla.
class CrmScope extends InheritedNotifier<CrmState> {
  const CrmScope({super.key, required CrmState state, required super.child}) : super(notifier: state);

  static CrmState of(BuildContext context, {bool listen = true}) {
    if (listen) {
      final scope = context.dependOnInheritedWidgetOfExactType<CrmScope>();
      assert(scope != null, 'CrmScope no encontrado: envuelve la app con CrmScope.');
      return scope!.notifier!;
    }
    final element = context.getElementForInheritedWidgetOfExactType<CrmScope>();
    return (element?.widget as CrmScope).notifier!;
  }
}
