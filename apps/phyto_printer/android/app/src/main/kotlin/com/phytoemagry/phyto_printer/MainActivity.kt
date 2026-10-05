package com.phytoemagry.phyto_printer

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.IOException
import java.util.UUID

class MainActivity : FlutterActivity() {
    private val channelName = "phytoemagry/printer"
    private val sppUuid: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    private val requestBluetooth = 4208
    private var channel: MethodChannel? = null
    private var pendingPermissionResult: MethodChannel.Result? = null
    private var socket: BluetoothSocket? = null
    private var connectedAddress: String? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
        channel?.setMethodCallHandler { call, result ->
            when (call.method) {
                "bluetoothStatus" -> result.success(bluetoothStatus())
                "requestPermissions" -> requestPermissions(result)
                "getBondedDevices" -> getBondedDevices(result)
                "connect" -> connect(call, result)
                "write" -> write(call, result)
                "disconnect" -> {
                    disconnect()
                    result.success(null)
                }
                "loadSettings" -> result.success(loadSettings())
                "saveSettings" -> {
                    saveSettings(call.arguments as? Map<*, *>)
                    result.success(null)
                }
                "openExternalUrl" -> openExternalUrl(call.arguments as? String, result)
                else -> result.notImplemented()
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != requestBluetooth) return
        val granted = grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }
        pendingPermissionResult?.success(granted)
        pendingPermissionResult = null
    }

    private fun bluetoothAdapter(): BluetoothAdapter? {
        val manager = getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        return manager?.adapter ?: BluetoothAdapter.getDefaultAdapter()
    }

    private fun bluetoothStatus(): String {
        val adapter = bluetoothAdapter() ?: return "unsupported"
        if (!hasBluetoothPermission()) return "permissionDenied"
        if (!adapter.isEnabled) return "disabled"
        return "available"
    }

    private fun hasBluetoothPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
    }

    private fun requestPermissions(result: MethodChannel.Result) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            result.success(true)
            return
        }
        if (hasBluetoothPermission()) {
            result.success(true)
            return
        }
        if (pendingPermissionResult != null) {
            result.error("permission_pending", "Ya hay una solicitud de permisos abierta.", null)
            return
        }
        pendingPermissionResult = result
        ActivityCompat.requestPermissions(
            this,
            arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN),
            requestBluetooth,
        )
    }

    private fun getBondedDevices(result: MethodChannel.Result) {
        val adapter = bluetoothAdapter()
        if (adapter == null) {
            result.error("unsupported", "Bluetooth no disponible.", null)
            return
        }
        if (!hasBluetoothPermission()) {
            result.error("permission_denied", "Falta permiso Bluetooth.", null)
            return
        }
        if (!adapter.isEnabled) {
            result.error("bluetooth_disabled", "Bluetooth apagado.", null)
            return
        }
        try {
            val rows = adapter.bondedDevices.map { device ->
                mapOf(
                    "id" to device.address,
                    "name" to safeDeviceName(device),
                    "address" to device.address,
                    "bonded" to (device.bondState == BluetoothDevice.BOND_BONDED),
                )
            }.sortedBy { it["name"] as String }
            result.success(rows)
        } catch (_: SecurityException) {
            result.error("permission_denied", "Falta permiso Bluetooth.", null)
        }
    }

    private fun connect(call: MethodCall, result: MethodChannel.Result) {
        val args = call.arguments as? Map<*, *>
        val address = (args?.get("address") ?: args?.get("id")) as? String
        if (address.isNullOrBlank()) {
            result.error("device_not_found", "Impresora no encontrada.", null)
            return
        }
        val adapter = bluetoothAdapter()
        if (adapter == null) {
            result.error("unsupported", "Bluetooth no disponible.", null)
            return
        }
        if (!hasBluetoothPermission()) {
            result.error("permission_denied", "Falta permiso Bluetooth.", null)
            return
        }
        if (!adapter.isEnabled) {
            result.error("bluetooth_disabled", "Bluetooth apagado.", null)
            return
        }
        if (connectedAddress == address && socket?.isConnected == true) {
            result.success(true)
            return
        }
        disconnect()
        try {
            val device = adapter.getRemoteDevice(address)
            val nextSocket = device.createRfcommSocketToServiceRecord(sppUuid)
            adapter.cancelDiscovery()
            nextSocket.connect()
            socket = nextSocket
            connectedAddress = address
            result.success(true)
        } catch (_: IllegalArgumentException) {
            result.error("device_not_found", "Impresora no encontrada.", null)
        } catch (_: SecurityException) {
            result.error("permission_denied", "Falta permiso Bluetooth.", null)
        } catch (_: IOException) {
            disconnect()
            result.error("connection_failed", "No se pudo conectar.", null)
        }
    }

    private fun write(call: MethodCall, result: MethodChannel.Result) {
        val bytes = call.arguments as? ByteArray
        if (bytes == null || bytes.isEmpty()) {
            result.success(null)
            return
        }
        val current = socket
        if (current == null || !current.isConnected) {
            result.error("connection_failed", "No hay conexion con la impresora.", null)
            return
        }
        try {
            current.outputStream.write(bytes)
            current.outputStream.flush()
            result.success(null)
        } catch (_: IOException) {
            disconnect()
            result.error("write_failed", "No se pudo escribir en la impresora.", null)
        } catch (_: SecurityException) {
            result.error("permission_denied", "Falta permiso Bluetooth.", null)
        }
    }

    private fun disconnect() {
        try {
            socket?.close()
        } catch (_: IOException) {
            // Cerrar es mejor esfuerzo.
        }
        socket = null
        connectedAddress = null
    }

    private fun openExternalUrl(url: String?, result: MethodChannel.Result) {
        if (url.isNullOrBlank()) {
            result.error("invalid_url", "URL externa invalida.", null)
            return
        }
        val uri = Uri.parse(url)
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") {
            result.error("invalid_url", "URL externa invalida.", null)
            return
        }
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
            result.success(null)
        } catch (_: Exception) {
            result.error("open_failed", "No se pudo abrir el enlace externo.", null)
        }
    }

    private fun safeDeviceName(device: BluetoothDevice): String {
        return try {
            device.name ?: "Impresora Bluetooth"
        } catch (_: SecurityException) {
            "Impresora Bluetooth"
        }
    }

    private fun prefs() = getSharedPreferences("phyto_printer_settings", Context.MODE_PRIVATE)

    private fun loadSettings(): Map<String, Any?> {
        val p = prefs()
        val hasDevice = p.getString("device_id", null) != null
        val device = if (hasDevice) {
            mapOf(
                "id" to p.getString("device_id", ""),
                "name" to p.getString("device_name", "Impresora Bluetooth"),
                "address" to p.getString("device_address", ""),
                "bonded" to true,
            )
        } else {
            null
        }
        return mapOf(
            "defaultDevice" to device,
            "paperWidth" to p.getString("paper_width", "mm58"),
            "profile" to "genericEscPos",
            "autoPrint" to p.getBoolean("auto_print", false),
            "autoCut" to p.getBoolean("auto_cut", true),
            "lastConnectedAt" to p.getString("last_connected_at", null),
        )
    }

    private fun saveSettings(input: Map<*, *>?) {
        val editor = prefs().edit()
        val device = input?.get("defaultDevice") as? Map<*, *>
        if (device == null) {
            editor.remove("device_id")
            editor.remove("device_name")
            editor.remove("device_address")
        } else {
            editor.putString("device_id", device["id"] as? String ?: "")
            editor.putString("device_name", device["name"] as? String ?: "Impresora Bluetooth")
            editor.putString("device_address", device["address"] as? String ?: device["id"] as? String ?: "")
        }
        editor.putString("paper_width", input?.get("paperWidth") as? String ?: "mm58")
        editor.putBoolean("auto_print", input?.get("autoPrint") as? Boolean ?: false)
        editor.putBoolean("auto_cut", input?.get("autoCut") as? Boolean ?: true)
        editor.putString("last_connected_at", input?.get("lastConnectedAt") as? String)
        editor.apply()
    }
}
