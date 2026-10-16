// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// WCAG: luminancia sRGB y contraste, independiente de los colores elegidos.
const base = readFileSync('public/admin/admin.css', 'utf8');
const shell = readFileSync('public/admin/shell-v2-tema.css', 'utf8');
const fulltech = readFileSync('public/admin/fulltech.css', 'utf8');
const declarations = (body) => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const root = declarations(base.match(/:root\s*\{([^}]+)\}/s)[1]);
const light = { ...root, ...declarations(shell.match(/:root\s*\{([^}]+)\}/s)[1]) };
const dark = { ...light, ...declarations(shell.match(/:root\[data-theme='dark'\]\s*\{([^}]+)\}/s)[1]) };
function color(value, vars, background = [255,255,255]) {
  if (value.startsWith('var(')) return color(vars[value.slice(4,-1)], vars, background);
  if (value.startsWith('#')) { let h = value.slice(1); if (h.length === 3) h = [...h].map((v) => v+v).join(''); return [0,2,4].map((i) => parseInt(h.slice(i,i+2),16)); }
  const c = value.match(/[\d.]+/g).map(Number);
  return c.length === 4 ? c.slice(0,3).map((v,i) => v*c[3] + background[i]*(1-c[3])) : c;
}
function contrast(a,b) {
  const luminance = (rgb) => rgb.map((v) => v/255).map((v) => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((sum,v,i) => sum+v*[.2126,.7152,.0722][i],0);
  const x = luminance(a), y = luminance(b);
  return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}

describe.each([['claro', light], ['oscuro', dark]])('contraste de la paleta %s', (name, vars) => {
  it('el texto de las acciones es legible en todo el degradado', () => {
    const blocks = [...fulltech.matchAll(/--ft-gradient:\s*([^;]+);/g)];
    const gradient = blocks[name === 'claro' ? 0 : 1][1];
    for (const stop of gradient.match(/#[a-f0-9]{6}/g)) {
      expect(contrast(color(vars['--pe-on-brand'],vars),color(stop,vars))).toBeGreaterThanOrEqual(4.5);
    }
  });
  for (const foreground of ['--text-primary','--text-secondary','--pe-ink-600','--pe-ink-800']) {
    it(`${foreground} es legible en tarjetas, controles y fondo`, () => {
      for (const background of ['--pe-card-bg','--pe-page-bg','--pe-control-bg']) {
        expect(contrast(color(vars[foreground],vars),color(vars[background],vars))).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
  it('la opción activa del menú y su icono mantienen contraste', () => {
    const background = color(vars['--pe-brand-soft'],vars,color(vars['--pe-card-bg'],vars));
    expect(contrast(color(vars['--pe-brand-text'],vars),background)).toBeGreaterThanOrEqual(4.5);
  });
  it('la acción primaria tiene texto legible', () => {
    expect(contrast(color(vars['--pe-on-brand'],vars), color(vars['--pe-brand-text'],vars))).toBeGreaterThanOrEqual(4.5);
  });
  it('cerrar sesión se distingue del fondo', () => {
    expect(contrast(color(vars['--danger'],vars),color(vars['--pe-card-bg'],vars))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('semáforo de pedidos en oscuro', () => {
  it.each(['pendiente','en_camino','incidencia','entregado','cancelado'])('%s conserva un estado legible', (state) => {
    const pattern = new RegExp(":root\\[data-theme='dark'\\] body\\[data-tab='pedidos'\\] \\.order-card--"+state+" \\{([^}]+)\\}");
    const vars = declarations(shell.match(pattern)[1]);
    expect(contrast(color(vars['--order-tone'],vars),color(vars['--order-bg'],vars))).toBeGreaterThanOrEqual(4.5);
  });
});
