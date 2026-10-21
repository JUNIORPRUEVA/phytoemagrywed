// @vitest-environment node
/**
 * UAT DE LOS AUDIOS DEL HILO — la DIRECCIÓN manda.
 *
 * Un audio del cliente y un audio del negocio se parecían demasiado: el
 * reproductor era el mismo recuadro con dos verdes casi iguales y el saliente
 * llevaba un color escrito a mano que en modo oscuro se veía como un parche.
 *
 * Aquí se comprueba lo que es fácil de romper al tocar CSS y que no se ve en los
 * tests de negocio: que los colores del reproductor salgan de la CLASE de la
 * burbuja (`.bubble--in` / `.bubble--out`, es decir, la dirección real del
 * mensaje), que el tema oscuro tenga sus propios valores y que no queden colores
 * fijos claros en el componente. Se midió aparte en un navegador real, a
 * 390x844 (Android/PWA) y 1440x900 (escritorio), en claro y en oscuro.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const adminDir = path.join(process.cwd(), 'public', 'admin');
const read = (name) => readFileSync(path.join(adminDir, name), 'utf8').replaceAll('\r\n', '\n');

const css = read('admin.css');
const tema = read('shell-v2-tema.css');
const escritorio = read('wa-desktop.css');

/** Bloque de una regla, desde su selector hasta la llave que lo cierra. */
const blockOf = (source, selector, { last = false } = {}) => {
  const start = last ? source.lastIndexOf(selector) : source.indexOf(selector);
  if (start < 0) return '';
  return source.slice(start, source.indexOf('}', start) + 1);
};

describe('audio del hilo: entrante y saliente se distinguen por la dirección', () => {
  it('el color del reproductor sale de la CLASE DE LA BURBUJA, no del archivo', () => {
    const base = blockOf(css, '\n.audio {', { last: true });
    const saliente = blockOf(css, '.bubble--out .audio {');
    expect(base).toContain('--audio-bg: var(--pe-bubble-in)');
    expect(saliente).toContain('--audio-bg: var(--pe-audio-out-bg)');
    expect(saliente).toContain('--audio-accent: var(--pe-audio-out-accent)');
    // Una dirección tiene su «colita» a la izquierda y la otra a la derecha.
    expect(base).toContain('border-bottom-left-radius: 6px');
    expect(saliente).toContain('border-bottom-right-radius: 6px');
  });

  it('el saliente usa el verde del negocio y el entrante el azul de la marca', () => {
    const base = blockOf(css, '\n.audio {', { last: true });
    const saliente = blockOf(css, '.bubble--out .audio {');
    const claro = blockOf(css, ':root {');
    expect(claro).toContain('--pe-audio-in-accent: var(--phyto-primary)');
    expect(claro).toMatch(/--pe-audio-out-bg: #[0-9a-f]{6}/);
    expect(claro).toMatch(/--pe-audio-out-accent: #[0-9a-f]{6}/);
    const acentoEntrante = claro.match(/--pe-audio-in-accent: ([^;]+);/)[1];
    const acentoSaliente = claro.match(/--pe-audio-out-accent: ([^;]+);/)[1];
    expect(acentoEntrante).not.toBe(acentoSaliente);
    // Nada de verdes claros escritos a mano en el reproductor (era el parche que
    // se veía sobre la burbuja oscura).
    expect(base).not.toContain('#d5ecdd');
    expect(saliente).not.toContain('#d5ecdd');
  });

  it('el modo oscuro tiene sus propios colores (sin fondos blancos ni controles sin contraste)', () => {
    const oscuro = blockOf(tema, ":root[data-theme='dark'] {");
    for (const variable of [
      '--pe-audio-in-border',
      '--pe-audio-in-ink',
      '--pe-audio-in-accent',
      '--pe-audio-in-track',
      '--pe-audio-in-play-ink',
      '--pe-audio-out-bg',
      '--pe-audio-out-border',
      '--pe-audio-out-ink',
      '--pe-audio-out-accent',
      '--pe-audio-out-track',
      '--pe-audio-out-play-ink',
    ]) {
      expect(oscuro).toContain(variable);
    }
    // La tinta del play sobre el acento mint es OSCURA: blanco sobre #54dda2 no
    // se lee.
    expect(oscuro).toMatch(/--pe-audio-out-play-ink: #0[0-9a-f]{5}/);
  });

  it('la onda es una onda: barras y avance sin repintar el hilo', () => {
    const pista = blockOf(css, '.audio__seek::-webkit-slider-runnable-track {');
    expect(pista).toContain('repeating-linear-gradient');
    expect(pista).toContain('var(--audio-progress, 0%)');
  });

  it('el escritorio (WhatsApp Web) también separa entrante y saliente', () => {
    expect(escritorio).toContain('--audio-bg: var(--wad-bubble-in)');
    expect(escritorio).toContain('--audio-bg: var(--wad-bubble-out)');
    // El reproductor ES la burbuja: el saliente ya no se queda transparente.
    expect(escritorio).not.toMatch(/\.bubble--out \.audio \{\s*background: transparent/);
  });
});
