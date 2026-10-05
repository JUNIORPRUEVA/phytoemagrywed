# Phytoemagry Android

Aplicacion Android principal de Phytoemagry. Carga el CRM existente en un
WebView y agrega una capa nativa segura para impresion termica Bluetooth
Classic + ESC/POS.

## Alcance

- Android solamente.
- CRM web como interfaz principal.
- Dispositivos Bluetooth ya emparejados desde Ajustes de Android.
- Conexion RFCOMM/SPP con UUID generico `00001101-0000-1000-8000-00805F9B34FB`.
- Tickets ESC/POS directos, sin PDF ni dialogo de impresion.
- Perfil inicial: `Generic ESC/POS`.
- Anchos soportados: 58 mm y 80 mm.
- Auto impresion preparada pero OFF por defecto.

## Arquitectura

- `lib/main.dart`: shell Android con WebView del CRM.
- `PhytoDeviceBridge`: canal controlado para funciones nativas.
- `PrinterTransport`: contrato reusable para transportes futuros.
- `BluetoothClassicTransport`: implementacion Android inicial via `MethodChannel`.
- `PrinterService`: seleccion, configuracion, conexion, reconexion e impresion.
- `ReceiptBuilder`: genera bytes ESC/POS desde datos estructurados.
- `MockPrinterTransport`: pruebas sin impresora fisica.

El bridge solo acepta acciones de impresora (`printerStatus`, `listPrinters`,
`configurePrinter`, `testPrint`, `printReceipt`) y valida que la URL actual del
WebView sea el origen permitido antes de ejecutar Bluetooth.

## Permisos Android

- Android 12+: `BLUETOOTH_CONNECT` y `BLUETOOTH_SCAN`.
- Android 11 o anterior: permisos Bluetooth clasicos declarados con `maxSdkVersion=30`.
- No se solicita ubicacion porque esta fase usa dispositivos ya emparejados, no discovery BLE ni escaneo con localizacion.

## Prueba fisica

1. Emparejar la impresora desde Bluetooth de Android.
2. Instalar y abrir el APK `app-debug.apk`.
3. Entrar a Configuracion -> Impresora.
4. Tocar Seleccionar impresora.
5. Elegir la impresora emparejada.
6. Elegir 58 mm u 80 mm.
7. Imprimir prueba.
8. Abrir un pedido real y tocar Imprimir factura.

Si no imprime, revisar que la impresora soporte ESC/POS generico por Bluetooth Classic/SPP.
