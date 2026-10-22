"""Optimiza los iconos de facturación entregados por el usuario.

Los PNG originales son de 512x512 (43-176 KB). En la interfaz se ven a 18-24 CSS
px, así que se reducen a 96x96 (cubre pantallas 4x sin perder nitidez) y se
guardan con paleta; la transparencia se conserva porque el fondo es alfa.

Uso:  python scripts/optimize-billing-icons.py
"""

from pathlib import Path

from PIL import Image

ORIGEN = Path.home() / "Downloads"
DESTINO = Path(__file__).resolve().parent.parent / "public" / "admin" / "assets" / "icons" / "billing"

# nombre original -> nombre final (sin espacios ni paréntesis para la URL)
ICONOS = {
    "entradas.png": "tickets.png",
    "cruz-quitar-signo.png": "remove.png",
    "nueva-cuenta (2).png": "customer.png",
    "lista-de-opciones.png": "options.png",
    "mas (1).png": "plus.png",
    "arriba.png": "chevron-up.png",
    "abajo.png": "chevron-down.png",
}

# Las flechas vienen con mucho aire alrededor: se recortan para que se vean grandes
# al tamaño real (16 px) y queden opticamente iguales al resto.
RECORTAR = {"chevron-up.png", "chevron-down.png"}

TAMANO = 96
MARGEN = 0.10


def main() -> None:
    DESTINO.mkdir(parents=True, exist_ok=True)
    for origen, destino in ICONOS.items():
        ruta = ORIGEN / origen
        if not ruta.exists():
            print(f"falta: {ruta}")
            continue
        img = Image.open(ruta).convert("RGBA")
        if destino in RECORTAR:
            caja = img.getbbox()
            if caja:
                img = img.crop(caja)
            lado = max(img.size)
            lienzo = Image.new("RGBA", (lado, lado), (0, 0, 0, 0))
            lienzo.paste(img, ((lado - img.size[0]) // 2, (lado - img.size[1]) // 2))
            img = lienzo
            interior = int(TAMANO * (1 - 2 * MARGEN))
            img = img.resize((interior, interior), Image.LANCZOS)
        else:
            img.thumbnail((TAMANO, TAMANO), Image.LANCZOS)
        salida = DESTINO / destino
        img.save(salida, optimize=True)
        print(f"{origen} -> {destino} {img.size[0]}x{img.size[1]} {salida.stat().st_size} bytes")


if __name__ == "__main__":
    main()
