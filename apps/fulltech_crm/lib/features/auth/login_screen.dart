import 'package:flutter/material.dart';

import '../../app/crm_scope.dart';
import '../../core/theme/crm_theme.dart';
import '../../core/theme/crm_tokens.dart';
import '../common/crm_ui.dart';

/// Entrada al panel, calcada del PWA (`.login` / `.login__card` de `admin.css`).
///
/// Tarjeta estrecha (máx. 318 px) centrada sobre el fondo con los dos
/// degradados radiales del panel, la marca en una placa de 62 px, el rótulo
/// «ACCESO PRIVADO DEL EQUIPO» y el botón azul degradado de 156 px.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _username = TextEditingController();
  final _password = TextEditingController();
  bool _obscure = true;
  bool _sending = false;

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_sending) return;
    final user = _username.text.trim();
    final pass = _password.text;
    if (user.isEmpty || pass.isEmpty) {
      crmToast(context, 'Escribe usuario y contraseña.');
      return;
    }
    setState(() => _sending = true);
    final state = CrmScope.of(context, listen: false);
    final ok = await state.login(user, pass);
    if (!mounted) return;
    setState(() => _sending = false);
    if (!ok) crmToast(context, state.error ?? 'No pudimos entrar.');
  }

  @override
  Widget build(BuildContext context) {
    final p = context.crm;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final state = CrmScope.of(context);

    return Scaffold(
      backgroundColor: p.pageBg,
      body: DecoratedBox(
        decoration: BoxDecoration(
          gradient: dark ? CrmGradients.darkPage : CrmGradients.page,
        ),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 318),
                child: Container(
                  padding: const EdgeInsets.fromLTRB(20, 26, 20, 22),
                  decoration: BoxDecoration(
                    color: p.surface,
                    borderRadius: BorderRadius.circular(CrmRadii.lg),
                    border: Border.all(color: p.border),
                    boxShadow: const [BoxShadow(color: Color(0x29140E1B), blurRadius: 48, offset: Offset(0, 20))],
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Container(
                        width: 62,
                        height: 62,
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(color: p.primary.withValues(alpha: 0.22)),
                          gradient: LinearGradient(
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                            colors: [Colors.white, p.primaryTint],
                          ),
                          boxShadow: const [BoxShadow(color: Color(0x2E143C78), blurRadius: 24, offset: Offset(0, 10))],
                        ),
                        child: Center(
                          child: Image.asset(PwaIcons.brandLogo, width: 42, height: 42, filterQuality: FilterQuality.medium),
                        ),
                      ),
                      const SizedBox(height: 12),
                      RichText(
                        textAlign: TextAlign.center,
                        text: TextSpan(
                          style: TextStyle(fontSize: 17.9, fontWeight: FontWeight.w600, color: p.ink, letterSpacing: 0.18),
                          children: [
                            const TextSpan(text: 'FT '),
                            TextSpan(
                              text: 'CRM',
                              style: TextStyle(
                                color: p.primary,
                                fontWeight: FontWeight.w800,
                                letterSpacing: 1.43,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 5),
                      Text(
                        'ACCESO PRIVADO DEL EQUIPO',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 11.2,
                          fontWeight: FontWeight.w500,
                          letterSpacing: 1.79,
                          color: p.inkSecondary,
                        ),
                      ),
                      const SizedBox(height: 18),
                      _label('Usuario'),
                      const SizedBox(height: 3),
                      _field(
                        controller: _username,
                        hint: 'tu usuario',
                        autofocus: true,
                        textInputAction: TextInputAction.next,
                      ),
                      const SizedBox(height: 11),
                      _label('Contraseña'),
                      const SizedBox(height: 3),
                      _field(
                        controller: _password,
                        hint: 'Tu contraseña',
                        obscure: _obscure,
                        onSubmitted: (_) => _submit(),
                        suffix: IconButton(
                          tooltip: _obscure ? 'Mostrar' : 'Ocultar',
                          icon: Icon(
                            _obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                            size: 18,
                            color: p.inkSecondary,
                          ),
                          onPressed: () => setState(() => _obscure = !_obscure),
                        ),
                      ),
                      if ((state.error ?? '').isNotEmpty) ...[
                        const SizedBox(height: 8),
                        Text(
                          state.error!,
                          textAlign: TextAlign.center,
                          style: TextStyle(color: p.danger, fontSize: 13.1, fontWeight: FontWeight.w600),
                        ),
                      ],
                      const SizedBox(height: 16),
                      _submitButton(p),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _label(String text) => Align(
        alignment: Alignment.centerLeft,
        child: Text(
          text,
          style: TextStyle(fontSize: 12.2, fontWeight: FontWeight.w600, letterSpacing: 0.24, color: context.crm.inkSecondary),
        ),
      );

  Widget _field({
    required TextEditingController controller,
    required String hint,
    bool obscure = false,
    bool autofocus = false,
    ValueChanged<String>? onSubmitted,
    Widget? suffix,
    TextInputAction? textInputAction,
  }) {
    final p = context.crm;
    return SizedBox(
      height: 40,
      child: TextField(
        controller: controller,
        obscureText: obscure,
        autofocus: autofocus,
        autocorrect: false,
        enableSuggestions: false,
        textInputAction: textInputAction,
        onSubmitted: onSubmitted,
        style: TextStyle(fontSize: 14.7, color: p.ink),
        decoration: InputDecoration(
          isDense: true,
          hintText: hint,
          hintStyle: TextStyle(fontSize: 14.7, color: p.inkSecondary.withValues(alpha: 0.8)),
          filled: true,
          fillColor: p.surface,
          contentPadding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
          suffixIcon: suffix,
          suffixIconConstraints: const BoxConstraints(minWidth: 40, minHeight: 32),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(CrmRadii.sm),
            borderSide: BorderSide(color: p.border),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(CrmRadii.sm),
            borderSide: BorderSide(color: p.border),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(CrmRadii.sm),
            borderSide: BorderSide(color: p.primary, width: 1.6),
          ),
        ),
      ),
    );
  }

  Widget _submitButton(CrmPalette p) {
    return SizedBox(
      height: 40,
      child: FilledButton(
        onPressed: _sending ? null : _submit,
        style: FilledButton.styleFrom(
          backgroundColor: Colors.transparent,
          foregroundColor: Colors.white,
          elevation: 0,
          shadowColor: Colors.transparent,
          padding: const EdgeInsets.symmetric(horizontal: 26),
          minimumSize: const Size(156, 40),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        ).copyWith(backgroundColor: const WidgetStatePropertyAll(Colors.transparent)),
        child: Ink(
          decoration: BoxDecoration(
            gradient: CrmGradients.primaryButton,
            borderRadius: BorderRadius.circular(10),
            boxShadow: const [BoxShadow(color: Color(0x42145BD7), blurRadius: 16, offset: Offset(0, 6))],
          ),
          child: Container(
            height: 40,
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(horizontal: 26),
            child: _sending
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.2, color: Colors.white))
                : const Text('Entrar', style: TextStyle(fontSize: 14.4, fontWeight: FontWeight.w700, letterSpacing: 0.72)),
          ),
        ),
      ),
    );
  }
}
