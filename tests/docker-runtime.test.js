// @vitest-environment node
/**
 * LA IMAGEN FINAL TIENE QUE PODER ARRANCAR.
 *
 * Esta prueba nace de un fallo real en producción (30/09): `npm run verify`
 * pasaba en la etapa de *build* de Docker (donde `src/` existe), pero la imagen
 * final —etapa `runtime`— no copiaba `src/`, y el API moría al arrancar:
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find module '/app/src/config/product.config.js'
 *
 * Resultado: la imagen se construía, el contenedor se caía y Swarm hacía
 * rollback (producción siguió viva con la versión anterior).
 *
 * Aquí se comprueba, sin necesidad de Docker, que TODO lo que importa el
 * servidor en tiempo de ejecución viaja en la imagen final, y que existe la
 * guarda de runtime que lo verifica dentro del propio build.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

/** Solo la etapa final (`runtime`), que es la que se ejecuta en producción. */
const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('AS runtime'));

/** Rutas que la etapa runtime copia desde la etapa de build. */
const copiedPaths = [...runtimeStage.matchAll(/^COPY\s+--from=build\s+(\S+)/gm)].map((match) => match[1]);

/** `server/` está copiado al runtime ⇒ sus imports son seguros. */
const isCovered = (target) =>
  copiedPaths.some((copied) => {
    const relative = copied.replace(/^\/app\//, '');
    return target === relative || target.startsWith(`${relative}/`);
  });

/** Imports relativos reales de cada módulo del servidor. */
function relativeImports() {
  const files = readdirSync(path.join(ROOT, 'server')).filter((file) => file.endsWith('.mjs'));
  /** @type {{ from: string, target: string }[]} */
  const out = [];
  for (const file of files) {
    const code = readFileSync(path.join(ROOT, 'server', file), 'utf8');
    for (const match of code.matchAll(/from\s+'(\.[^']+)'/g)) {
      out.push({
        from: `server/${file}`,
        target: path.posix.normalize(path.posix.join('server', match[1])),
      });
    }
  }
  return out;
}

describe('imagen final (etapa runtime del Dockerfile)', () => {
  it('copia todo lo que el servidor importa en tiempo de ejecución', () => {
    const imports = relativeImports();
    expect(imports.length).toBeGreaterThan(5); // si esto baja, el escáner dejó de leer

    const missing = imports.filter((entry) => !isCovered(entry.target));
    expect(
      missing.map((entry) => `${entry.from} importa ${entry.target} (no se copia al runtime)`),
    ).toEqual([]);
  });

  it('mantiene la guarda de runtime que recorre los imports tras el build', () => {
    expect(runtimeStage).toMatch(
      /^RUN\s+node\s+--input-type=module\s+-e\s+"await import\('\/app\/server\/crm-server\.mjs'\)"/m,
    );
  });

  it('copia el panel y las dependencias de ejecución', () => {
    expect(copiedPaths).toContain('/app/dist/admin');
    expect(copiedPaths).toContain('/app/server');
    expect(runtimeStage).toMatch(/^COPY\s+--from=runtime-deps\s+\/app\/node_modules/m);
  });
});
