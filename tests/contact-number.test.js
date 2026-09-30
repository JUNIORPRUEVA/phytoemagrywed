/**
 * UN SOLO NÚMERO DE WHATSAPP, Y ES EL OFICIAL.
 *
 * Prueba de regresión: el número viejo (`+1 829 785 3794`) NO puede volver a
 * ninguna superficie de EJECUCIÓN — lo que la web o el CRM pueden mostrar,
 * enlazar o usar para enviar — y el número oficial (`+1 849-424-0621`) tiene que
 * ser el que usan los enlaces comerciales, generados desde la configuración
 * central (nunca escritos a mano en un componente).
 *
 * Qué NO se revisa, a propósito:
 *   · `docs/DECISIONES.md` conserva el número anterior como registro histórico
 *     de lo que se decidió en su momento (con una entrada nueva que lo supera).
 *   · los propios tests, que necesitan el número viejo para poder detectarlo.
 *   · artefactos generados (`dist/`, `dist-dev/`, `.tmp/`) y `tools/`, que son
 *     herramientas locales y se comprueban aparte al construir.
 *
 * Sí se revisa, en cambio, `.env` y `.env.local` (locales, no versionados): un
 * override de desarrollo con el número viejo vuelve a servirlo en `dist-dev/`,
 * que es justo lo que esta fase tiene que impedir.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { siteConfig } from '../src/config/site.config.js';
import { buildWhatsAppUrl } from '../src/lib/whatsapp.js';
import { renderIndexPage, renderLegalPage } from '../src/render/pages.js';
import { makeShopView } from './helpers.js';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Número oficial: +1 849-424-0621 (el que recibe pedidos y consultas). */
const OFICIAL = '18494240621';
const OFICIAL_DISPLAY = '+1 849-424-0621';

/**
 * Número viejo, montado en trozos para que este archivo no sea en sí mismo una
 * aparición del número (así el escaneo de superficies puede ser estricto).
 */
const VIEJO = ['1829', '785', '3794'].join('');
const VIEJO_DISPLAY = ['+1 829 785 3794'].join('');

/** Carpetas y archivos de ejecución: aquí el número viejo sería un fallo real. */
const CARPETAS_VIGILADAS = ['src', 'public', 'server', 'scripts', 'nginx'];
const ARCHIVOS_VIGILADOS = ['Dockerfile', 'docker-compose.yml'];
const IGNORADAS = new Set(['node_modules', '.git', 'dist', 'dist-dev', '.tmp', '.venv', '.playwright-mcp', 'data', 'tools']);
const EXTENSIONES = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.html',
  '.yml',
  '.yaml',
  '.conf',
  '.txt',
  '.webmanifest',
  '.svg',
]);

/** @param {string} dir @returns {string[]} */
function archivosDe(dir) {
  const encontrados = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    if (entrada.name.startsWith('.') && entrada.name !== '.env.example') continue;
    const completo = path.join(dir, entrada.name);
    if (entrada.isDirectory()) {
      if (IGNORADAS.has(entrada.name)) continue;
      encontrados.push(...archivosDe(completo));
      continue;
    }
    if (!EXTENSIONES.has(path.extname(entrada.name))) continue;
    encontrados.push(completo);
  }
  return encontrados;
}

const leer = (relativo) => readFileSync(path.join(RAIZ, relativo), 'utf8');

describe('el WhatsApp de atención es el oficial, en un solo sitio', () => {
  it('la configuración central usa el número oficial (dígitos y texto visible)', () => {
    // `number` sale del entorno; en los tests puede estar vacío, así que lo que
    // se comprueba aquí es el número que SÍ vive en el repositorio.
    expect(siteConfig.contact.whatsapp.displayNumber).toBe(OFICIAL_DISPLAY);
    expect(siteConfig.contact.whatsapp.displayNumber.replace(/\D/g, '')).toBe(OFICIAL);
  });

  it('el constructor de enlaces produce wa.me con el número oficial', () => {
    const url = buildWhatsAppUrl({ number: OFICIAL, message: 'Hola' });
    expect(url).toBe(`https://wa.me/${OFICIAL}?text=Hola`);
    // Y si recibe el viejo, el enlace sale con el viejo: por eso el número
    // correcto tiene que venir de configuración.
    expect(buildWhatsAppUrl({ number: VIEJO, message: 'Hola' })).toContain(VIEJO);
  });

  it('ningún archivo de ejecución vuelve a contener el número viejo', () => {
    const vigilados = [
      ...CARPETAS_VIGILADAS.flatMap((carpeta) => archivosDe(path.join(RAIZ, carpeta))),
      ...ARCHIVOS_VIGILADOS.map((archivo) => path.join(RAIZ, archivo)),
    ];
    expect(vigilados.length).toBeGreaterThan(20);

    const apariciones = [];
    for (const archivo of vigilados) {
      const contenido = readFileSync(archivo, 'utf8');
      if (contenido.includes(VIEJO) || contenido.includes(VIEJO_DISPLAY.replace(/\D/g, ''))) {
        apariciones.push(path.relative(RAIZ, archivo));
      }
    }
    expect(apariciones, `el número viejo sigue en: ${apariciones.join(', ')}`).toEqual([]);
  });

  it('los valores por defecto de la imagen y del compose son el número oficial', () => {
    const dockerfile = leer('Dockerfile');
    const compose = leer('docker-compose.yml');
    expect(dockerfile).toContain(`ARG PHYTO_WHATSAPP_NUMBER="${OFICIAL}"`);
    expect(compose).toContain(`PHYTO_WHATSAPP_NUMBER:-${OFICIAL}`);
    expect(dockerfile).not.toContain(VIEJO);
    expect(compose).not.toContain(VIEJO);
  });
});

describe('la web no muestra ni enlaza el número viejo', () => {
  const view = makeShopView({
    whatsapp: OFICIAL,
    site: { contact: { whatsapp: { number: OFICIAL, displayNumber: OFICIAL_DISPLAY } } },
  });

  it('TODOS los enlaces comerciales de la landing apuntan al número oficial', () => {
    const html = renderIndexPage(view);
    const enlaces = [...html.matchAll(/href="(https:\/\/wa\.me\/[^"]*)"/g)].map((m) => m[1]);
    expect(enlaces.length).toBeGreaterThanOrEqual(8);
    for (const href of enlaces) {
      expect(href.startsWith(`https://wa.me/${OFICIAL}?text=`), `revisa ${href}`).toBe(true);
    }
    // Ni el número viejo ni ningún otro wa.me con dígitos distintos.
    expect(html).not.toContain(VIEJO);
    expect(html.replaceAll(OFICIAL, '')).not.toMatch(/wa\.me\/\d/);
  });

  it('el número a la vista y las páginas legales usan el oficial', () => {
    const landing = renderIndexPage(view);
    expect(landing).toContain(OFICIAL_DISPLAY);

    for (const kind of ['privacy', 'terms']) {
      const legal = renderLegalPage(view, { kind });
      expect(legal).not.toContain(VIEJO);
      expect(legal).not.toContain(VIEJO_DISPLAY);
    }
  });

  it('el número oficial NO viaja con identificadores de Meta (eso es del backend)', () => {
    // El frontend solo necesita el número público: ni Phone Number ID, ni WABA.
    const html = renderIndexPage(view) + renderLegalPage(view, { kind: 'privacy' });
    const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim();
    const waba = String(process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? '').trim();
    for (const secreto of [phoneNumberId, waba]) {
      if (secreto) expect(html).not.toContain(secreto);
    }
    // Un Phone Number ID tiene 16 dígitos: no puede aparecer en el HTML.
    expect(html).not.toMatch(/\b\d{16}\b/);
    expect(html).not.toMatch(/access_token|Bearer\s/i);
  });
});

describe('los ficheros de entorno locales apuntan al número oficial', () => {
  it('.env y .env.local (si existen) definen el número oficial', () => {
    // `PHYTO_WHATSAPP_NUMBER` es el único sitio del que salen los enlaces, así que
    // un override local viejo reintroduce el número viejo en todo el sitio. Si
    // alguien necesita probar con otro número, lo que toca es quitar la línea,
    // no dejarla apuntando a un teléfono que ya no atiende.
    for (const archivo of ['.env', '.env.local']) {
      const ruta = path.join(RAIZ, archivo);
      if (!existsSync(ruta)) continue;
      const linea = readFileSync(ruta, 'utf8').match(/^\s*PHYTO_WHATSAPP_NUMBER\s*=\s*(.*)$/m);
      if (!linea) continue;
      const valor = linea[1].trim().replace(/^["']|["']$/g, '');
      expect(valor.replace(/\D/g, ''), `${archivo} no apunta al número oficial`).toBe(OFICIAL);
    }
    // En un clon limpio no hay ficheros de entorno (están ignorados por git), así
    // que aquí no se exige que existan: solo que, si existen, digan lo correcto.
  });
});
