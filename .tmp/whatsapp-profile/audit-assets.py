"""
Auditoría READ-ONLY de los recursos de marca para el perfil de WhatsApp.

Para cada imagen informa: formato, modo, si tiene transparencia, tamaño en
píxeles, relación de aspecto, peso, y si el CONTENIDO (los píxeles que no son
fondo/transparentes) entra dentro del círculo que usa WhatsApp al recortar.

Uso: python .tmp/whatsapp-profile/audit-assets.py
"""
from pathlib import Path

from PIL import Image

RAIZ = Path(__file__).resolve().parents[2]
OBJETIVOS = [
    RAIZ / "assets" / "perfilwhatsapp.png",
    RAIZ / "assets" / "portadaprincipal.png",
]


def analizar(ruta: Path) -> None:
    if not ruta.exists():
        print(f"{ruta.name}: NO EXISTE")
        return
    peso = ruta.stat().st_size
    imagen = Image.open(ruta)
    ancho, alto = imagen.size
    tiene_alfa = imagen.mode in ("RGBA", "LA") or "transparency" in imagen.info

    rgba = imagen.convert("RGBA")
    alfa = rgba.getchannel("A")
    # Caja del contenido: píxeles con alfa útil (o, si no hay alfa, distintos del
    # color de la esquina, que se toma como fondo).
    if tiene_alfa:
        caja = alfa.point(lambda v: 255 if v > 8 else 0).getbbox()
    else:
        fondo = rgba.getpixel((0, 0))
        mascara = Image.new("L", (ancho, alto), 0)
        datos = []
        for pixel in rgba.getdata():
            lejos = sum(abs(pixel[i] - fondo[i]) for i in range(3)) > 40
            datos.append(255 if lejos else 0)
        mascara.putdata(datos)
        caja = mascara.getbbox()

    relacion = ancho / alto
    print(f"--- {ruta.name}")
    print(f"    formato: {imagen.format} · modo: {imagen.mode} · transparencia: {'sí' if tiene_alfa else 'no'}")
    print(f"    tamaño: {ancho}x{alto} px · relación: {relacion:.3f} ({'cuadrada' if abs(relacion - 1) < 0.01 else 'no cuadrada'})")
    print(f"    peso: {peso / 1024 / 1024:.2f} MB")
    if caja:
        izq, arriba, der, abajo = caja
        margenes = (izq, arriba, ancho - der, alto - abajo)
        print(f"    contenido: caja {der - izq}x{abajo - arriba} px · márgenes L/T/R/B = {margenes}")
        # ¿Entra en el círculo inscrito con margen de seguridad (80% del radio)?
        import math

        centro_x, centro_y = ancho / 2, alto / 2
        radio = min(ancho, alto) / 2 * 0.8
        esquinas = [(izq, arriba), (der, arriba), (izq, abajo), (der, abajo)]
        fuera = [p for p in esquinas if math.dist(p, (centro_x, centro_y)) > radio]
        print(f"    recorte circular (80% del radio): {'ENTRA con margen' if not fuera else 'SE CORTARÍA en ' + str(len(fuera)) + ' esquina(s)'}")
        centrado = abs((izq + der) / 2 - centro_x) < ancho * 0.03 and abs((arriba + abajo) / 2 - centro_y) < alto * 0.03
        print(f"    centrado del contenido: {'sí' if centrado else 'no'}")


if __name__ == "__main__":
    for ruta in OBJETIVOS:
        analizar(ruta)
