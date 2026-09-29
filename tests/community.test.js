/**
 * COMUNIDAD: selección automática del grupo de WhatsApp.
 *
 * Regla: se usa el primer grupo `active` con estado `available` por prioridad.
 * Si ninguno está disponible, el CTA se oculta (nunca se muestran los 5 enlaces).
 */

import { describe, expect, it } from 'vitest';

import { siteConfig } from '../src/config/site.config.js';
import { GROUP_STATUS, buildGroups, cleanGroupUrl, groupSummary, resolveGroup } from '../src/lib/community.js';
import { renderIndexPage } from '../src/render/pages.js';
import { makeView } from './helpers.js';

const URLS = {
  g1: 'https://chat.whatsapp.com/DzhnvGqRxwq38CHJc05bGz?mode=gi_t',
  g2: 'https://chat.whatsapp.com/CrB5NoaCBdIIKBO35bKfrz?mode=ac_t',
  g3: 'https://chat.whatsapp.com/H4p1nmI1w9x0rGjQ8MvLRK',
  g4: 'https://chat.whatsapp.com/GWHAEb67e2JA59cQ0H8qRV',
  g5: 'https://chat.whatsapp.com/Da9M4Zml4p3Kxc3lME8JqC?s=cl&p=a&mlu=4',
};

/** @param {object[]} groups */
const groups = (list) => buildGroups(list);

describe('configuración real de grupos', () => {
  it('los 5 grupos están configurados con URL válida', () => {
    const configured = buildGroups(siteConfig.community.groups);
    expect(configured).toHaveLength(5);
    for (const group of configured) {
      expect(group.url).toMatch(/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+$/);
    }
  });

  it('limpia los parámetros de sesión de las URLs copiadas', () => {
    expect(cleanGroupUrl(URLS.g1)).toBe('https://chat.whatsapp.com/DzhnvGqRxwq38CHJc05bGz');
    expect(cleanGroupUrl(URLS.g5)).toBe('https://chat.whatsapp.com/Da9M4Zml4p3Kxc3lME8JqC');
    expect(cleanGroupUrl('https://ejemplo.com/grupo')).toBeNull();
    expect(cleanGroupUrl('no es una url')).toBeNull();
  });
});

describe('selección automática del grupo', () => {
  it('elige el de mayor prioridad (menor número) disponible', () => {
    const resolved = resolveGroup(
      groups([
        { id: 'b', url: URLS.g2, priority: 2, status: 'available' },
        { id: 'a', url: URLS.g1, priority: 1, status: 'available' },
      ]),
    );
    expect(resolved.id).toBe('a');
  });

  it('salta los grupos llenos, casi llenos y desactivados', () => {
    const resolved = resolveGroup(
      groups([
        { id: 'full', url: URLS.g1, priority: 1, status: 'full' },
        { id: 'almost', url: URLS.g2, priority: 2, status: 'almost_full' },
        { id: 'off', url: URLS.g3, priority: 3, status: 'disabled', active: false },
        { id: 'ok', url: URLS.g4, priority: 4, status: 'available' },
      ]),
    );
    expect(resolved.id).toBe('ok');
  });

  it('ignora los grupos inactivos aunque estén disponibles', () => {
    const resolved = resolveGroup(
      groups([
        { id: 'inactivo', url: URLS.g1, priority: 1, status: 'available', active: false },
        { id: 'activo', url: URLS.g2, priority: 2, status: 'available' },
      ]),
    );
    expect(resolved.id).toBe('activo');
  });

  it('devuelve null cuando todos están deshabilitados o llenos', () => {
    expect(
      resolveGroup(
        groups([
          { id: 'a', url: URLS.g1, priority: 1, status: 'disabled', active: false },
          { id: 'b', url: URLS.g2, priority: 2, status: 'full' },
        ]),
      ),
    ).toBeNull();
    expect(resolveGroup([])).toBeNull();
  });

  it('aplica el estado por defecto "available" si no se indica', () => {
    const [group] = groups([{ id: 'a', url: URLS.g1, priority: 1 }]);
    expect(group.status).toBe(GROUP_STATUS.AVAILABLE);
    expect(resolveGroup([group]).id).toBe('a');
  });

  it('descarta entradas sin URL utilizable', () => {
    const resolved = groups([{ id: 'roto', url: 'https://google.com', priority: 1 }, { id: 'ok', url: URLS.g3, priority: 2 }]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe('ok');
  });

  it('resume el estado para herramientas internas', () => {
    const summary = groupSummary(groups([{ id: 'a', url: URLS.g1, priority: 1, status: 'available' }]));
    expect(summary).toMatchObject({ total: 1, active: 1, available: 1, hasUsableGroup: true });
  });
});

describe('sección de comunidad en la página', () => {
  /** Vista con la comunidad ACTIVADA (capacidad), independiente del interruptor. */
  const withCommunity = (overrides = {}) =>
    makeView({
      ...overrides,
      site: {
        ...(overrides.site ?? {}),
        community: { ...siteConfig.community, enabled: true, ...(overrides.site?.community ?? {}) },
      },
    });

  it('con la configuración real NO se publica la comunidad (decisión del negocio)', () => {
    // Los grupos no se muestran para que el visitante escriba al WhatsApp 1:1 y
    // se pueda capturar su número.
    expect(siteConfig.community.enabled).toBe(false);
    const view = makeView();
    const html = renderIndexPage(view);
    expect(view.flags.community).toBe(false);
    expect(html).not.toContain('id="comunidad"');
    expect(html).not.toContain('chat.whatsapp.com');
    expect(html).not.toContain('Unirme al grupo');
    // Tampoco el acceso del menú, la pregunta de la FAQ ni el enlace de compra.
    expect(html).not.toContain('>Comunidad</a>');
    expect(html).not.toContain('¿Tienen comunidad de apoyo?');
    expect(html).not.toContain('data-action="scroll-to-community"');
  });

  it('activada, renderiza un solo enlace al grupo (nunca los cinco)', () => {
    const view = withCommunity();
    const html = renderIndexPage(view);
    const links = [...html.matchAll(/https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+/g)].map((match) => match[0]);
    expect(links).toHaveLength(1);
    expect(links[0]).toBe('https://chat.whatsapp.com/DzhnvGqRxwq38CHJc05bGz');
  });

  it('activada, vuelve el enlace del menú y el de la zona de compra', () => {
    const html = renderIndexPage(withCommunity());
    expect(html).toContain('>Comunidad</a>');
    expect(html).toContain('data-action="scroll-to-community"');
    expect(html).toContain('¿Tienen comunidad de apoyo?');
  });

  it('oculta el CTA de comunidad cuando no hay grupos disponibles', () => {
    const view = withCommunity({
      site: { community: { groups: [{ id: 'a', url: URLS.g1, priority: 1, status: 'full' }] } },
    });
    const html = renderIndexPage(view);
    expect(view.flags.community).toBe(false);
    expect(html).not.toContain('id="comunidad"');
    expect(html).not.toContain('chat.whatsapp.com/');
  });

  it('incluye el aviso de que la comunidad no sustituye información médica', () => {
    const html = renderIndexPage(withCommunity());
    expect(html).toContain('no sustituye la información médica ni garantiza resultados');
  });

  it('la comunidad no promete resultados', () => {
    const html = renderIndexPage(withCommunity());
    const start = html.indexOf('id="comunidad"');
    const block = html.slice(start, html.indexOf('</section>', start));
    // Se excluye el aviso legal, que precisamente dice que NO garantiza nada.
    const withoutDisclaimer = block.replace(/<p class="pe-note[^>]*>.*?<\/p>/s, '');
    expect(withoutDisclaimer).not.toMatch(/garantiz|resultados? (asegurad|garantiz)|pierde|adelgaz|libras|100\s*%/i);
    expect(withoutDisclaimer).not.toMatch(/curar?\b|enfermedad|efectos secundarios/i);
  });
});

describe('cifra de la comunidad (memberClaim)', () => {
  it('NO se publica mientras no esté verificada en configuración', () => {
    // Configuración real: el negocio ha comentado "más de 4.000 clientes", pero
    // sin verificar, así que la landing no lo dice de ninguna forma.
    expect(siteConfig.community.memberClaimVerified).toBe(false);
    const html = renderIndexPage(makeView());
    expect(html).not.toMatch(/4[.,]?000 clientes/i);
    expect(html).not.toMatch(/m[aá]s de \d[\d.,]*\s*(clientes|personas)/i);
  });

  it('solo se publica con la formulación factual y la verificación explícita', () => {
    const claim = 'Más de 4.000 personas forman parte de los grupos de la comunidad.';
    const base = { ...siteConfig.community, enabled: true };
    const verified = makeView({
      site: { community: { ...base, memberClaim: claim, memberClaimVerified: true } },
    });
    const html = renderIndexPage(verified);
    expect(verified.community.memberClaim).toBe(claim);
    expect(html).toContain(claim);

    // Con el texto pero SIN verificar, no se muestra nada.
    const notVerified = makeView({ site: { community: { ...base, memberClaim: claim } } });
    expect(notVerified.community.memberClaim).toBeNull();
    expect(renderIndexPage(notVerified)).not.toContain(claim);
  });

  it('una cifra vacía no se publica ni con la verificación activada', () => {
    const empty = makeView({
      site: { community: { ...siteConfig.community, memberClaim: '   ', memberClaimVerified: true } },
    });
    expect(empty.community.memberClaim).toBeNull();
  });
});

describe('afirmación de confianza publicada (trust.claim)', () => {
  const CLAIM = 'Miles de personas ya cuentan con Phytoemagry.';

  it('se muestra en la información del producto con la configuración real', () => {
    expect(siteConfig.trust.claimVerified).toBe(true);
    expect(siteConfig.trust.claim).toBe(CLAIM);
    const html = renderIndexPage(makeView());
    expect(html).toContain(CLAIM);
    expect(html).toContain('pe-trust');
  });

  it('no se muestra si el negocio retira la verificación (una línea de config)', () => {
    const view = makeView({
      site: { trust: { claim: CLAIM, claimVerified: false } },
    });
    expect(view.trust.claim).toBeNull();
    expect(renderIndexPage(view)).not.toContain(CLAIM);
  });

  it('no se muestra una afirmación vacía ni sin texto', () => {
    expect(makeView({ site: { trust: { claim: '   ', claimVerified: true } } }).trust.claim).toBeNull();
    expect(makeView({ site: { trust: { claimVerified: true } } }).trust.claim).toBeNull();
  });
});
