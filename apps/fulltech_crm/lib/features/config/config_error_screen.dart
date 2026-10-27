import 'package:flutter/material.dart';

import '../../core/config/app_environment.dart';
import '../../core/theme/crm_theme.dart';
import '../../core/theme/crm_tokens.dart';

/// Pantalla de emergencia cuando la configuración de entorno no es válida.
///
/// Es deliberadamente dura: si alguien compila para UAT y apunta a producción,
/// es mejor un error legible que un panel que escribe en el CRM real.
class ConfigErrorApp extends StatelessWidget {
  const ConfigErrorApp({super.key, required this.error});

  final ConfigException error;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: CrmTheme.build(Brightness.light),
      darkTheme: CrmTheme.build(Brightness.dark),
      home: Scaffold(
        body: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 520),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      width: 52,
                      height: 52,
                      decoration: BoxDecoration(
                        color: CrmColors.dangerSoft,
                        borderRadius: BorderRadius.circular(16),
                      ),
                      child: const Icon(Icons.report_gmailerrorred_rounded, color: CrmColors.danger, size: 28),
                    ),
                    const SizedBox(height: 16),
                    const Text(
                      'Configuración de entorno bloqueada',
                      style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: CrmColors.ink),
                    ),
                    const SizedBox(height: 10),
                    Text(
                      error.message,
                      style: const TextStyle(fontSize: 14, height: 1.45, color: CrmColors.ink),
                    ),
                    if (error.hint.isNotEmpty) ...[
                      const SizedBox(height: 14),
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: CrmColors.surfaceMuted,
                          borderRadius: BorderRadius.circular(CrmRadii.md),
                          border: Border.all(color: CrmColors.border),
                        ),
                        child: Text(
                          error.hint,
                          style: const TextStyle(fontSize: 12.5, height: 1.45, color: CrmColors.inkSecondary),
                        ),
                      ),
                    ],
                    const SizedBox(height: 18),
                    const Text(
                      'Compila de nuevo con los parámetros correctos:',
                      style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: CrmColors.inkSecondary),
                    ),
                    const SizedBox(height: 6),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: const Color(0xFF0B1220),
                        borderRadius: BorderRadius.circular(CrmRadii.md),
                      ),
                      child: const Text(
                        'flutter run \\\n'
                        '  --dart-define=APP_ENV=dev \\\n'
                        '  --dart-define=API_BASE_URL=http://10.0.2.2:4000',
                        style: TextStyle(fontFamily: 'monospace', fontSize: 11.5, height: 1.5, color: Color(0xFFD7E5FF)),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
