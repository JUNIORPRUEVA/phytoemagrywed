import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import '../core/config/app_environment.dart';
import '../core/theme/crm_theme.dart';
import '../core/theme/crm_tokens.dart';
import '../features/auth/login_screen.dart';
import '../features/shell/crm_shell.dart';
import 'crm_scope.dart';
import 'crm_state.dart';

/// Entorno activo, disponible para cualquier pantalla.
class EnvironmentScope extends InheritedWidget {
  const EnvironmentScope({super.key, required this.environment, required super.child});

  final AppEnvironment environment;

  static AppEnvironment? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<EnvironmentScope>()?.environment;

  @override
  bool updateShouldNotify(EnvironmentScope oldWidget) => oldWidget.environment != environment;
}

class CrmApp extends StatelessWidget {
  const CrmApp({super.key, required this.state, required this.environment});

  final CrmState state;
  final AppEnvironment environment;

  @override
  Widget build(BuildContext context) {
    return EnvironmentScope(
      environment: environment,
      child: CrmScope(
        state: state,
        child: AnimatedBuilder(
          animation: state,
          builder: (context, _) => MaterialApp(
            title: 'FullTECH CRM',
            debugShowCheckedModeBanner: false,
            theme: CrmTheme.build(Brightness.light),
            darkTheme: CrmTheme.build(Brightness.dark),
            themeMode: state.themeMode,
            locale: const Locale('es', 'DO'),
            supportedLocales: const [Locale('es', 'DO'), Locale('es'), Locale('en')],
            localizationsDelegates: const [
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            home: !state.ready
                ? const _BootSplash()
                : state.authenticated
                    ? const _LiveLifecycle(child: CrmShell())
                    : const LoginScreen(),
          ),
        ),
      ),
    );
  }
}

/// Mantiene vivo el canal de eventos solo mientras la app está en primer plano.
///
/// Al volver de segundo plano se recarga una vez (puede haber cambiado todo) y
/// se reabre el canal desde el último evento conocido.
class _LiveLifecycle extends StatefulWidget {
  const _LiveLifecycle({required this.child});

  final Widget child;

  @override
  State<_LiveLifecycle> createState() => _LiveLifecycleState();
}

class _LiveLifecycleState extends State<_LiveLifecycle> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) CrmScope.of(context, listen: false).startRealtime();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final crm = CrmScope.of(context, listen: false);
    switch (state) {
      case AppLifecycleState.resumed:
        crm.startRealtime();
        crm.refresh(quiet: true);
      case AppLifecycleState.paused:
      case AppLifecycleState.inactive:
      case AppLifecycleState.detached:
        crm.stopRealtime();
      case AppLifecycleState.hidden:
        break;
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// Arranque: solo el logo, como la PWA (el panel abre en décimas).
class _BootSplash extends StatelessWidget {  const _BootSplash();

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    return Scaffold(
      backgroundColor: p.pageBg,
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 78,
              height: 78,
              decoration: BoxDecoration(
                color: p.primary,
                borderRadius: BorderRadius.circular(22),
              ),
              alignment: Alignment.center,
              child: const Text('FT', style: TextStyle(color: Colors.white, fontSize: 28, fontWeight: FontWeight.w900)),
            ),
            const SizedBox(height: 16),
            Text('FullTECH CRM', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: p.ink)),
            const SizedBox(height: 18),
            SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.2, color: p.primary)),
          ],
        ),
      ),
    );
  }
}

/// Marca del panel, reutilizada por el login y el menú.
class CrmBrandMark extends StatelessWidget {
  const CrmBrandMark({super.key, this.size = 44});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: CrmColors.primary,
        borderRadius: BorderRadius.circular(size / 3.4),
      ),
      alignment: Alignment.center,
      child: Text(
        'FT',
        style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: size * 0.38),
      ),
    );
  }
}
