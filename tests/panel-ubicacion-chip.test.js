// @vitest-environment node
/**
 * LA TARJETA DE UBICACIÓN DEL HILO — comprobación de piel, no de negocio.
 *
 * Lo que se pidió y aquí se sujeta para que no se pierda al tocar CSS:
 *   - cuando el cliente comparte su ubicación, en el chat se ve UNA tarjeta
 *     pequeña (y la burbuja desaparece: nada de tarjeta dentro de tarjeta);
 *   - el menú de la ubicación es un «⋮» VERTICAL, de verdad (SVG de la tabla de
 *     iconos), no el carácter `⋯` que se veía tumbado y apagado;
 *   - ese botón y el de «Ver en mapa» miden 44 px: se pulsan con el pulgar.
 *
 * Se mide sobre los archivos que se publican (`index.html`, `admin.css`, `app.js`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const adminDir = path.join(process.cwd(), 'public', 'admin');
/** Los finales de línea se normalizan: así las reglas se comparan como bloques. */
const read = (name) => readFileSync(path.join(adminDir, name), 'utf8').replaceAll('\r\n', '\n');
const app = read('app.js');
const css = read('admin.css');

describe('ubicación compartida en el chat', () => {
  it('es UNA tarjeta pequeña (la burbuja desaparece)', () => {
    expect(app).toContain('locationChip');
    // .loc ES la pieza: radio propio y sombra suave, no la burbuja del mensaje.
    expect(css).toMatch(/\.loc \{[\s\S]*?border-radius: 14px;[\s\S]*?box-shadow: 0 6px 16px/);
    // El pin va en su círculo, alineado con el título.
    expect(css).toMatch(/\.loc__pin \{[\s\S]*?width: 26px;\n\s+height: 26px;/);
  });

  it('el «⋮» es vertical y relleno, no el carácter ⋯', () => {
    // Tres puntos VERTICALES con relleno (con trazo salían huecos y no se veían).
    expect(app).toMatch(/more: svg\('<circle[\s\S]*?fill="currentColor" stroke="none"/);
    // La tarjeta usa ese icono y ya no el carácter tumbado.
    expect(app).toContain('${ICONS.more}');
    expect(app).not.toContain('⋯</button>');
    expect(css).toMatch(/\.loc__more \.svg \{ width: 20px; height: 20px; \}/);
  });

  it('las dos acciones del chip se pulsan: 44 px, no 30x28', () => {
    expect(css).toMatch(/\.loc__more \{[\s\S]*?width: 44px;\n\s+height: 44px;/);
    expect(css).toMatch(/\.loc__actions \.loc__link \{[\s\S]*?min-height: 44px;/);
    // El botón del «⋮» responde al toque (no se queda muerto).
    expect(css).toMatch(/\.loc__more:active \{ transform: scale\(0\.94\); \}/);
    // Y el enlace discreto de listas y formularios sigue siendo el mismo: los
    // estilos de botón NO se filtran a `.loc__link` a secas.
    expect(css).toMatch(/\n\.loc__link \{\n {2}font-size: 13px;/);
  });
});
