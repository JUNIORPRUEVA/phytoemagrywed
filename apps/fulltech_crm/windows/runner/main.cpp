#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <dwmapi.h>
#include <windows.h>

#include "flutter_window.h"
#include "utils.h"

// Atributos de la barra de título (Windows 11). Se definen aquí porque el SDK
// antiguo no los trae; en Windows 10 las llamadas fallan sin efecto.
#ifndef DWMWA_BORDER_COLOR
#define DWMWA_BORDER_COLOR 34
#endif
#ifndef DWMWA_CAPTION_COLOR
#define DWMWA_CAPTION_COLOR 35
#endif
#ifndef DWMWA_TEXT_COLOR
#define DWMWA_TEXT_COLOR 36
#endif
#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  // Attach to console when present (e.g., 'flutter run') or create a
  // new console when running with a debugger.
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  // Initialize COM, so that it is available for use in the library and/or
  // plugins.
  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  flutter::DartProject project(L"data");

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();

  project.set_dart_entrypoint_arguments(std::move(command_line_arguments));

  FlutterWindow window(project);
  Win32Window::Point origin(10, 10);
  Win32Window::Size size(1280, 720);
  if (!window.Create(L"FULLTECH CRM", origin, size)) {
    return EXIT_FAILURE;
  }
  window.SetQuitOnClose(true);

  /*
   * Barra de título con el azul claro de marca (#E5EFFF) y texto oscuro.
   *
   * Sin esto Windows la pintaba negra cuando el sistema está en tema oscuro y
   * el usuario la percibía como una franja negra encima de la app.
   */
  if (HWND handle = window.GetHandle()) {
    const COLORREF caption_color = RGB(0xE5, 0xEF, 0xFF);
    const COLORREF text_color = RGB(0x14, 0x24, 0x3D);
    const COLORREF border_color = RGB(0xDC, 0xE5, 0xF2);
    const BOOL light_titlebar = FALSE;
    ::DwmSetWindowAttribute(handle, DWMWA_USE_IMMERSIVE_DARK_MODE,
                            &light_titlebar, sizeof(light_titlebar));
    ::DwmSetWindowAttribute(handle, DWMWA_CAPTION_COLOR, &caption_color,
                            sizeof(caption_color));
    ::DwmSetWindowAttribute(handle, DWMWA_TEXT_COLOR, &text_color,
                            sizeof(text_color));
    ::DwmSetWindowAttribute(handle, DWMWA_BORDER_COLOR, &border_color,
                            sizeof(border_color));
  }

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  ::CoUninitialize();
  return EXIT_SUCCESS;
}
