"""
¿La foto que Meta tiene puesta es REALMENTE la nuestra?

Compara la imagen descargada del perfil contra:
  · la copia derivada que subimos (.tmp/whatsapp-profile-ready.png), y
  · el original a sangre de `assets/perfilwhatsapp.png` (como si se hubiera subido
    ese, sin margen).

Meta recomprime y redimensiona, así que se comparan reescalando ambas a 64x64 y
midiendo la diferencia media por canal (0 = idénticas). La derivada debe quedar
CLARAMENTE más cerca que el original; si el resultado fuera al revés, significaría
que se subió otra imagen.

Uso: python .tmp/whatsapp-profile/comparar-foto-descargada.py
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageStat

RAIZ = Path(__file__).resolve().parents[2]
ACTUAL = Path(__file__).resolve().parent / "whatsapp-profile-actual.png"
ORIGEN = RAIZ / "assets" / "perfilwhatsapp.png"
LADO = 1024
ESCALAS = [0.80, 0.86, 0.90, 0.94, 0.96, 0.98, 1.00]


def fondo_de_borde(imagen: Image.Image) -> tuple[int, int, int]:
    ancho, alto = imagen.size
    sumas = [0, 0, 0]
    cuenta = 0
    for x in range(ancho):
        for y in (0, alto - 1):
            p = imagen.getpixel((x, y))
            for i in range(3):
                sumas[i] += p[i]
            cuenta += 1
    for y in range(alto):
        for x in (0, ancho - 1):
            p = imagen.getpixel((x, y))
            for i in range(3):
                sumas[i] += p[i]
            cuenta += 1
    return tuple(round(s / cuenta) for s in sumas)


def firma(imagen: Image.Image, lado: int = 64) -> Image.Image:
    return imagen.convert("RGB").resize((lado, lado), Image.LANCZOS)


def diferencia(a: Image.Image, b: Image.Image) -> float:
    return sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3


def variante(original: Image.Image, fondo, escala: float) -> tuple[Image.Image, int]:
    """Rehace la copia derivada con esa escala, para poder compararla."""
    contenido = round(LADO * escala)
    aire = (LADO - contenido) // 2
    lienzo = Image.new("RGB", (LADO, LADO), fondo)
    lienzo.paste(original.resize((contenido, contenido), Image.LANCZOS), (aire, aire))
    return lienzo, aire


if not ACTUAL.exists():
    print("no hay imagen descargada todavía (ejecuta antes verify-profile.mjs)")
    raise SystemExit(1)

original = Image.open(ORIGEN).convert("RGB")
fondo = fondo_de_borde(original)
objetivo = firma(Image.open(ACTUAL))

print(f"foto en el perfil tal como la devuelve Meta: {Image.open(ACTUAL).size}")
print(f"{'escala':>7} {'anillo':>7} {'diferencia':>11}")
resultados = []
for escala in ESCALAS:
    lienzo, aire = variante(original, fondo, escala)
    d = diferencia(objetivo, firma(lienzo))
    resultados.append((d, escala, aire))
    print(f"{escala:7.2f} {aire:5d}px {d:10.2f}")

resultados.sort()
mejor_d, mejor_escala, mejor_aire = resultados[0]
print(f"\nmejor encaje: escala {mejor_escala:.2f} · anillo {mejor_aire}px · diferencia {mejor_d:.2f}")
if mejor_d < 6:
    print("VEREDICTO: el perfil tiene esa versión puesta (la diferencia es la recompresión de Meta).")
else:
    print("VEREDICTO: no encaja con ninguna versión conocida: revisar a ojo.")
