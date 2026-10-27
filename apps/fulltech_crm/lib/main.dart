import 'package:flutter/material.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'app/crm_app.dart';
import 'app/crm_state.dart';
import 'core/config/app_config.dart';
import 'core/config/app_environment.dart';
import 'core/net/api_client.dart';
import 'data/crm_repository.dart';
import 'features/config/config_error_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initializeDateFormatting('es', null);

  // PRIMERO EL ENTORNO. Si la configuración es incoherente (por ejemplo una
  // compilación de pruebas apuntando a producción) NO se arranca el panel: se
  // muestra el error con la instrucción exacta y se para.
  final AppEnvironment environment;
  try {
    environment = AppEnvironment.current;
  } on ConfigException catch (error) {
    runApp(ConfigErrorApp(error: error));
    return;
  }
  AppConfig.init(environment);

  final repository = CrmRepository(ApiClient(baseUrl: environment.apiBaseUrl));
  final state = CrmState(repository);
  runApp(CrmApp(state: state, environment: environment));
  await state.boot();
}
