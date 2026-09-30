"""
Diagnóstico visual: ¿el botón verde de «Registrar compra» queda tapado por la
barra inferior fija?

Compara la captura BASE de la fase comercial (docs/capturas/ventas) con la
captura nueva de la UAT multimedia: en las dos se busca el verde de marca
(#0b6b4f aprox.) en la franja inferior y se dice si el bloque verde toca el
borde de la imagen (señal de quedar cortado por la barra).

Uso: python .tmp/s3-uat/diagnostico-barra.py
"""
from pathlib import Path

from PIL import Image

RAIZ = Path(__file__).resolve().parents[2]
OBJETIVO = (11, 107, 79)  # --phyto-primary
TOLERANCIA = 26


def es_verde_marca(pixel) -> bool:
    return all(abs(pixel[i] - OBJETIVO[i]) <= TOLERANCIA for i in range(3))


def analizar(ruta: Path) -> dict:
    imagen = Image.open(ruta).convert("RGB")
    ancho, alto = imagen.size
    franja = imagen.crop((0, max(0, alto - 110), ancho, alto))
    pixeles = franja.load()

    filas_verdes = []
    for y in range(franja.size[1]):
        verdes = sum(1 for x in range(franja.size[0]) if es_verde_marca(pixeles[x, y]))
        if verdes > ancho * 0.3:  # una fila "llena" de verde = botón, no icono
            filas_verdes.append(y + alto - 110)

    return {
        "archivo": ruta.name,
        "tamano": f"{ancho}x{alto}",
        "filasVerdesAbajo": (filas_verdes[0], filas_verdes[-1]) if filas_verdes else None,
        "tocaElBordeInferior": bool(filas_verdes) and filas_verdes[-1] >= alto - 3,
    }


if __name__ == "__main__":
    objetivos = [
        RAIZ / "docs" / "capturas" / "ventas" / "panel-chat-movil.png",
        RAIZ / "docs" / "capturas" / "multimedia" / "chat-412.png",
        RAIZ / "docs" / "capturas" / "multimedia" / "chat-360.png",
    ]
    for ruta in objetivos:
        if ruta.exists():
            datos = analizar(ruta)
            print(f"{datos['archivo']:26} {datos['tamano']:9} franja verde: {datos['filasVerdesAbajo']} corte={datos['tocaElBordeInferior']}")
        else:
            print(f"{ruta.name}: no existe")
