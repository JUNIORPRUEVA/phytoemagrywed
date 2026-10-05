import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'native_bridge/printer_bridge.dart';
import 'printer/bluetooth_classic_transport.dart';
import 'printer/printer_models.dart';
import 'printer/printer_service.dart';

void main() {
  runApp(const PhytoemagryApp());
}

class PhytoemagryApp extends StatelessWidget {
  const PhytoemagryApp({super.key});

  @override
  Widget build(BuildContext context) {
    const seed = Color(0xff087a5b);
    return MaterialApp(
      title: 'Phytoemagry',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: seed),
        scaffoldBackgroundColor: const Color(0xfff4fbf8),
      ),
      home: const CrmWebShell(),
    );
  }
}

class CrmWebShell extends StatefulWidget {
  const CrmWebShell({super.key});

  @override
  State<CrmWebShell> createState() => _CrmWebShellState();
}

class _CrmWebShellState extends State<CrmWebShell> {
  static const MethodChannel _nativeChannel = MethodChannel(
    'phytoemagry/printer',
  );
  static const _crmUrl = String.fromEnvironment(
    'PHYTO_CRM_URL',
    defaultValue: 'https://phytoemagryrd.lat/admin/',
  );

  late final Uri _crmUri = Uri.parse(_crmUrl);
  late final PrinterService _printerService = PrinterService(
    transport: BluetoothClassicTransport(),
    store: NativePrinterSettingsStore(),
  );
  late final PrinterBridge _printerBridge = PrinterBridge(
    service: _printerService,
    isTrustedOrigin: _currentOriginIsTrusted,
    configurePrinter: _openPrinterSheet,
  );
  late final WebViewController _webController;

  int _progress = 0;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    _webController = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setUserAgent('PhytoemagryAndroid WebView')
      ..addJavaScriptChannel(
        'PhytoDeviceBridge',
        onMessageReceived: _handleBridgeMessage,
      )
      ..setNavigationDelegate(
        NavigationDelegate(
          onProgress: (progress) => setState(() => _progress = progress),
          onPageStarted: (_) => setState(() => _loadError = null),
          onWebResourceError: (error) {
            if (error.isForMainFrame == true) {
              setState(() => _loadError = error.description);
            }
          },
          onNavigationRequest: (request) {
            if (_isTrustedUrl(request.url)) {
              return NavigationDecision.navigate;
            }
            _openExternalUrl(request.url);
            return NavigationDecision.prevent;
          },
        ),
      )
      ..loadRequest(_crmUri);
  }

  Future<bool> _currentOriginIsTrusted() async {
    final url = await _webController.currentUrl();
    return _isTrustedUrl(url);
  }

  bool _isTrustedUrl(String? value) {
    if (value == null || value.trim().isEmpty) return false;
    final uri = Uri.tryParse(value);
    if (uri == null) return false;
    if (uri.scheme == 'about') return true;
    return uri.scheme == _crmUri.scheme &&
        uri.host == _crmUri.host &&
        _portOf(uri) == _portOf(_crmUri);
  }

  int _portOf(Uri uri) {
    if (uri.hasPort) return uri.port;
    return uri.scheme == 'https' ? 443 : 80;
  }

  Future<void> _openExternalUrl(String url) async {
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;
    try {
      await _nativeChannel.invokeMethod<void>('openExternalUrl', url);
    } catch (_) {
      // Si Android no encuentra actividad externa, simplemente no navegamos.
    }
  }

  Future<void> _handleBridgeMessage(JavaScriptMessage message) async {
    String? id;
    try {
      final decoded = jsonDecode(message.message);
      if (decoded is! Map) {
        throw const PrinterBridgeException(
          'invalid_message',
          'Mensaje nativo invalido.',
        );
      }
      final request = Map<String, Object?>.from(decoded);
      id = request['id']?.toString();
      final data = await _printerBridge.handle(request);
      await _sendBridgeResponse(id, ok: true, data: data);
    } on PrinterBridgeException catch (error) {
      await _sendBridgeResponse(
        id,
        ok: false,
        error: {'code': error.code, 'message': error.message},
      );
    } on PrinterException catch (error) {
      await _sendBridgeResponse(
        id,
        ok: false,
        error: {'code': error.code, 'message': error.message},
      );
    } catch (_) {
      await _sendBridgeResponse(
        id,
        ok: false,
        error: {
          'code': 'native_error',
          'message': 'No se pudo completar la accion nativa.',
        },
      );
    }
  }

  Future<void> _sendBridgeResponse(
    String? id, {
    required bool ok,
    Map<String, Object?>? data,
    Map<String, Object?>? error,
  }) async {
    final payload = jsonEncode({
      'id': id,
      'ok': ok,
      'data': data,
      'error': error,
    });
    await _webController.runJavaScript(
      'window.dispatchEvent(new CustomEvent("phyto-device-response",{detail:$payload}));',
    );
  }

  Future<PrinterSettings?> _openPrinterSheet() async {
    final settings = await _printerService.loadSettings();
    var bluetooth = await _printerService.bluetoothAvailability();
    if (bluetooth == BluetoothAvailability.permissionDenied) {
      await _printerService.requestPermissions();
      bluetooth = await _printerService.bluetoothAvailability();
    }
    final devices = bluetooth == BluetoothAvailability.available
        ? await _printerService.devices()
        : <PrinterDevice>[];
    if (!mounted) return settings;
    return showModalBottomSheet<PrinterSettings>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      builder: (context) => _PrinterBottomSheet(
        initialSettings: settings,
        bluetooth: bluetooth,
        devices: devices,
        onSave: (next) async {
          await _printerService.saveSettings(next);
        },
      ),
    );
  }

  Future<void> _handleBack() async {
    if (await _webController.canGoBack()) {
      await _webController.goBack();
      return;
    }
    await SystemNavigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_handleBack());
      },
      child: Scaffold(
        body: SafeArea(
          child: Stack(
            children: [
              WebViewWidget(controller: _webController),
              if (_progress < 100)
                LinearProgressIndicator(
                  value: _progress <= 0 ? null : _progress / 100,
                  minHeight: 2,
                ),
              if (_loadError != null)
                _LoadError(
                  message: _loadError!,
                  onRetry: () => _webController.loadRequest(_crmUri),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _LoadError extends StatelessWidget {
  const _LoadError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: const Color(0xfff4fbf8),
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.wifi_off_rounded, size: 44),
              const SizedBox(height: 12),
              const Text(
                'No se pudo cargar Phytoemagry.',
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              Text(message, textAlign: TextAlign.center),
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh_rounded),
                label: const Text('Reintentar'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PrinterBottomSheet extends StatefulWidget {
  const _PrinterBottomSheet({
    required this.initialSettings,
    required this.bluetooth,
    required this.devices,
    required this.onSave,
  });

  final PrinterSettings initialSettings;
  final BluetoothAvailability bluetooth;
  final List<PrinterDevice> devices;
  final Future<void> Function(PrinterSettings settings) onSave;

  @override
  State<_PrinterBottomSheet> createState() => _PrinterBottomSheetState();
}

class _PrinterBottomSheetState extends State<_PrinterBottomSheet> {
  late PrinterSettings _settings = widget.initialSettings;
  bool _saving = false;

  Future<void> _save() async {
    setState(() => _saving = true);
    await widget.onSave(_settings);
    if (mounted) Navigator.of(context).pop(_settings);
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(18, 0, 18, 18 + bottom),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Impresoras Bluetooth',
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 4),
            Text(
              widget.bluetooth == BluetoothAvailability.available
                  ? 'Elige una impresora emparejada con Android.'
                  : widget.bluetooth.label,
            ),
            const SizedBox(height: 14),
            SegmentedButton<PrinterPaperWidth>(
              segments: PrinterPaperWidth.values
                  .map(
                    (width) =>
                        ButtonSegment(value: width, label: Text(width.label)),
                  )
                  .toList(growable: false),
              selected: {_settings.paperWidth},
              onSelectionChanged: (value) {
                setState(
                  () => _settings = _settings.copyWith(paperWidth: value.first),
                );
              },
            ),
            const SizedBox(height: 10),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Corte automatico'),
              value: _settings.autoCut,
              onChanged: (value) {
                setState(() => _settings = _settings.copyWith(autoCut: value));
              },
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Impresion automatica'),
              subtitle: const Text(
                'Preparada para otra fase. OFF por defecto.',
              ),
              value: _settings.autoPrint,
              onChanged: (value) {
                setState(
                  () => _settings = _settings.copyWith(autoPrint: value),
                );
              },
            ),
            const Divider(height: 22),
            Flexible(
              child: widget.devices.isEmpty
                  ? const Padding(
                      padding: EdgeInsets.symmetric(vertical: 12),
                      child: Text(
                        'No hay dispositivos emparejados. Empareja la impresora en Bluetooth de Android y vuelve a intentar.',
                      ),
                    )
                  : ListView.separated(
                      shrinkWrap: true,
                      itemCount: widget.devices.length,
                      separatorBuilder: (_, _) => const Divider(height: 1),
                      itemBuilder: (context, index) {
                        final device = widget.devices[index];
                        final selected =
                            _settings.defaultDevice?.id == device.id;
                        return ListTile(
                          contentPadding: EdgeInsets.zero,
                          leading: Icon(
                            selected
                                ? Icons.radio_button_checked_rounded
                                : Icons.radio_button_unchecked_rounded,
                            color: selected
                                ? Theme.of(context).colorScheme.primary
                                : null,
                          ),
                          title: Text(device.userLabel),
                          subtitle: Text(device.maskedAddress),
                          onTap: () {
                            setState(
                              () => _settings = _settings.copyWith(
                                defaultDevice: device,
                              ),
                            );
                          },
                        );
                      },
                    ),
            ),
            const SizedBox(height: 14),
            FilledButton.icon(
              onPressed: _saving ? null : _save,
              icon: _saving
                  ? const SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.save_rounded),
              label: const Text('Guardar'),
            ),
          ],
        ),
      ),
    );
  }
}
