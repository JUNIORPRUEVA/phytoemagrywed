"""Optimiza los iconos de interfaz (drawer, navbar, notificaciones, perfil).

Los originales son PNG de 512x512 (4-22 KB) con transparencia real. En la UI se
ven a 18-24 CSS px, así que se recortan los márgenes vacíos y se dejan en 72 px
(cubre pantallas 3x). Se guarda un único PNG por icono: en tema oscuro se
invierte por CSS, así no hay copias duplicadas.

Uso:  python scripts/optimize-ui-icons.py
"""

from pathlib import Path

from PIL import Image

ORIGEN = Path.home() / "Downloads"
DESTINO = Path(__file__).resolve().parent.parent / "public" / "admin" / "assets" / "icons" / "ui"

# archivo entregado -> nombre final
ICONOS = {
    "menus.png": "menu.png",
    "modo-claro.png": "sun.png",
    "modo-nocturno.png": "moon.png",
    "whatsapp (3).png": "whatsapp.png",
    "hacer-un-pedido.png": "orders.png",
    "usuario.png": "user.png",
    "notificacion.png": "bell.png",
    "atencion-al-cliente.png": "support.png",
    "carro.png": "cart.png",
    "anadir-grupo.png": "usersadd.png",
    "presupuesto.png": "billing.png",
    "barra-grafica.png": "chart.png",
    "compartir.png": "share.png",
    "interfaz-de-chat-de-ia.png": "robot.png",
    "el-tiempo-de-entrega.png": "delivery.png",
    "cerrar-sesion (1).png": "logout.png",
    "flecha-izquierda.png": "back.png",
}

TAMANO = 72
MARGEN = 0.08


def main() -> None:
    DESTINO.mkdir(parents=True, exist_ok=True)
    for origen, destino in ICONOS.items():
        ruta = ORIGEN / origen
        if not ruta.exists():
            print(f"falta: {ruta}")
            continue
        original = ruta.stat().st_size
        img = Image.open(ruta).convert("RGBA")
        caja = img.getbbox()
        if caja:
            img = img.crop(caja)
        lado = max(img.size)
        lienzo = Image.new("RGBA", (lado, lado), (0, 0, 0, 0))
        lienzo.paste(img, ((lado - img.size[0]) // 2, (lado - img.size[1]) // 2))
        interior = int(TAMANO * (1 - 2 * MARGEN))
        img = lienzo.resize((interior, interior), Image.LANCZOS)
        salida = DESTINO / destino
        img.save(salida, optimize=True)
        print(f"{origen:24} -> {destino:12} {original:6} B -> {salida.stat().st_size:5} B")


if __name__ == "__main__":
    main()
