# Captura la ventana del harness de diseño (sin robar el foco).
# Uso: .\capture.ps1 -View shell -Mode light -Width 1920 -Height 1080 -Out shot.png
param(
  [string]$View = 'shell',
  [string]$Module = '',
  [string]$Mode = 'light',
  [int]$Width = 1920,
  [int]$Height = 1080,
  [string]$Out = 'shot.png'
)

Add-Type -AssemblyName System.Drawing.Common
if (-not ("Win32Win" -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Win {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
}

$env:HARNESS_VIEW = $View
$env:HARNESS_MODULE = $Module
$env:HARNESS_MODE = $Mode
$exe = 'C:\h\harness\build\windows\x64\runner\Debug\design_harness.exe'
$p = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 7
for ($i = 0; $i -lt 25; $i++) {
  if ($p.MainWindowHandle -ne 0) { break }
  Start-Sleep -Milliseconds 400
  $p.Refresh()
}
if ($p.MainWindowHandle -eq 0) { Stop-Process -Id $p.Id -Force; throw 'La ventana no apareció' }

$h = $p.MainWindowHandle
# SWP_NOZORDER | SWP_NOACTIVATE: no se activa, no roba el foco a nadie.
for ($i = 0; $i -lt 20; $i++) {
  $p.Refresh()
  if ($p.MainWindowHandle -ne 0) { $h = $p.MainWindowHandle }
  [Win32Win]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, $Width, $Height, 0x0014) | Out-Null
  Start-Sleep -Milliseconds 500
  $probe = New-Object Win32Win+RECT
  [Win32Win]::GetWindowRect($h, [ref]$probe) | Out-Null
  if (($probe.R - $probe.L) -ge ([Math]::Min($Width, 400))) { break }
}
Start-Sleep -Seconds 3

$rect = New-Object Win32Win+RECT
[Win32Win]::GetWindowRect($h, [ref]$rect) | Out-Null
$w = [Math]::Max(1, $rect.R - $rect.L)
$hh = [Math]::Max(1, $rect.B - $rect.T)
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[Win32Win]::PrintWindow($h, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Stop-Process -Id $p.Id -Force
"captura $Out (${w}x${hh}) · view=$View module=$Module mode=$Mode"
