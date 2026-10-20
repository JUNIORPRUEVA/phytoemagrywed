/**
 * UAT aislada de identidad de cliente y SEO de FULLTECH Store.
 *
 * Cubre la LÓGICA PURA (validación de teléfono, OTP, verificación de Google en
 * servidor y renderizado SEO). No necesita base de datos, no envía SMS reales ni
 * toca el CRM: se ejecuta con `npx vitest run tests/store-auth-uat.test.js`.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  codeMatches,
  createMailSender,
  createSmsSender,
  generateCode,
  hashCode,
  maskPhone,
  normalizeDnPhone,
  phoneRequirement,
} from '../server/store-verifications.mjs';
import { createGoogleIdVerifier } from '../server/store-google-idtoken.mjs';
import {
  metaDescription,
  renderProductPage,
  renderRobots,
  renderSitemap,
  renderStoreGone,
  renderStoreNotFound,
} from '../server/store-seo.mjs';

const b64url = (value) => Buffer.from(value).toString('base64url');
const b64urlJson = (value) => b64url(JSON.stringify(value));

describe('teléfono dominicano', () => {
  it('acepta 809, 829 y 849 en sus formas habituales', () => {
    expect(normalizeDnPhone('809 555 0123')).toMatchObject({ ok: true, e164: '+18095550123' });
    expect(normalizeDnPhone('+1 (829) 555-0199')).toMatchObject({ ok: true, e164: '+18295550199' });
    expect(normalizeDnPhone('18495550123')).toMatchObject({ ok: true, e164: '+18495550123' });
    expect(normalizeDnPhone('00 1 849 555 0123')).toMatchObject({ ok: true, e164: '+18495550123' });
    expect(normalizeDnPhone('(809) 555 0123')).toMatchObject({ ok: true, area: '809' });
  });

  it('NO asume que todo +1 sea dominicano', () => {
    expect(normalizeDnPhone('+1 212 555 0100')).toMatchObject({ ok: false, reason: 'not_dr' });
    expect(normalizeDnPhone('+1 787 555 0100')).toMatchObject({ ok: false, reason: 'not_dr' });
  });

  it('rechaza lo incompleto sin inventar dígitos', () => {
    expect(normalizeDnPhone('')).toMatchObject({ ok: false, reason: 'empty' });
    expect(normalizeDnPhone('12345')).toMatchObject({ ok: false, reason: 'length' });
    expect(normalizeDnPhone('809 123')).toMatchObject({ ok: false, reason: 'length' });
    expect(normalizeDnPhone('+34 600 123 456')).toMatchObject({ ok: false, reason: 'length' });
  });

  it('enmascara dejando solo los últimos cuatro dígitos', () => {
    expect(maskPhone('+18091234567')).toBe('+1 ••• ••• 4567');
    expect(maskPhone('')).toBe('');
    expect(maskPhone('12')).toBe('');
  });
});

describe('código de un solo uso', () => {
  it('genera seis dígitos sin ceros iniciales perdidos', () => {
    expect(generateCode(() => 123456)).toBe('123456');
    for (let index = 0; index < 200; index += 1) {
      const code = generateCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(Number(code)).toBeGreaterThanOrEqual(100000);
    }
  });

  it('guarda solo el hash con sal y compara en tiempo constante', () => {
    const salt = 'sal-de-prueba';
    const stored = hashCode('654321', salt);
    expect(stored).toMatch(/^[a-f0-9]{64}$/);
    expect(stored).not.toContain('654321');
    expect(codeMatches('654321', salt, stored)).toBe(true);
    expect(codeMatches('654322', salt, stored)).toBe(false);
    expect(codeMatches('654321', 'otra-sal', stored)).toBe(false);
    expect(hashCode('654321', salt)).toBe(stored);
  });
});

describe('regla de teléfono en Fase 1 (sin OTP)', () => {
  it('exige un número GUARDADO, no verificado', () => {
    expect(phoneRequirement({ phone_e164: '+18095550123' })).toMatchObject({ ok: true });
    expect(phoneRequirement({ phone_e164: null })).toMatchObject({ ok: false, code: 'phone_required' });
    expect(phoneRequirement({})).toMatchObject({ ok: false });
    expect(phoneRequirement(null)).toMatchObject({ ok: false });
  });

  it('los canales de mensaje están apagados por defecto', () => {
    expect(createSmsSender().configured).toBe(false);
    expect(createSmsSender().mode).toBe('off');
    expect(createMailSender().configured).toBe(false);
    /* El buzón UAT sí existe cuando se pide expresamente. */
    expect(createSmsSender({ mode: 'outbox' }).exposesCodes).toBe(true);
  });
});

describe('Google Identity — verificación en servidor', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'kid-uat', alg: 'RS256', use: 'sig' };
  const fetchJwks = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
  const nowSeconds = Math.floor(Date.now() / 1000);

  const tokenFor = (claims, { header = { alg: 'RS256', kid: 'kid-uat' }, tamper = false } = {}) => {
    const head = b64urlJson(header);
    const payload = b64urlJson(claims);
    const signature = sign('RSA-SHA256', Buffer.from(`${head}.${payload}`), privateKey).toString('base64url');
    if (!tamper) return `${head}.${payload}.${signature}`;
    const other = b64urlJson({ ...claims, sub: 'otro-sujeto' });
    return `${head}.${other}.${signature}`;
  };

  const baseClaims = {
    iss: 'https://accounts.google.com',
    aud: 'cliente-uat.apps.googleusercontent.com',
    sub: '1234567890',
    email: 'Cliente@Example.com',
    email_verified: true,
    name: 'Cliente UAT',
    iat: nowSeconds - 30,
    exp: nowSeconds + 600,
  };

  const verifier = createGoogleIdVerifier({
    clientId: 'cliente-uat.apps.googleusercontent.com',
    fetchImpl: fetchJwks,
  });

  it('acepta un token firmado con las reclamaciones correctas', async () => {
    const identity = await verifier.verify(tokenFor(baseClaims));
    expect(identity).toMatchObject({
      provider: 'google',
      sub: '1234567890',
      email: 'cliente@example.com',
      emailVerified: true,
    });
  });

  it('rechaza audiencia ajena, emisor falso, token vencido y firma manipulada', async () => {
    await expect(verifier.verify(tokenFor({ ...baseClaims, aud: 'otra-app' }))).rejects.toMatchObject({ code: 'invalid_audience' });
    await expect(verifier.verify(tokenFor({ ...baseClaims, iss: 'https://evil.example' }))).rejects.toMatchObject({ code: 'invalid_issuer' });
    await expect(verifier.verify(tokenFor({ ...baseClaims, exp: nowSeconds - 10 }))).rejects.toMatchObject({ code: 'expired_credential' });
    await expect(verifier.verify(tokenFor(baseClaims, { tamper: true }))).rejects.toMatchObject({ code: 'invalid_signature' });
    await expect(verifier.verify('no-es-un-jwt')).rejects.toMatchObject({ code: 'invalid_credential' });
  });

  it('no verifica nada si el client_id no está configurado', async () => {
    const off = createGoogleIdVerifier({ clientId: '', fetchImpl: fetchJwks });
    expect(off.enabled).toBe(false);
    await expect(off.verify(tokenFor(baseClaims))).rejects.toMatchObject({ code: 'provider_not_configured' });
  });
});

describe('SEO de la tienda', () => {
  const product = {
    id: 'prod-1',
    kind: 'product',
    name: 'Router <AC1200>',
    category: 'Redes',
    price: 2500,
    currency: 'DOP',
    availabilityState: 'AVAILABLE_NOW',
    description: 'Router de doble banda para el hogar',
    brand: 'TP-Link',
    imageUrl: '/api/store/products/prod-1/image',
  };

  it('publica una URL canónica única con título y descripción propios', () => {
    const page = renderProductPage({ product, origin: 'https://fulltech.test', indexable: true });
    expect(page.canonical).toBe('https://fulltech.test/store/p/prod-1');
    expect(page.title).toContain('Router <AC1200>');
    expect(page.html).toContain('<link rel="canonical" href="https://fulltech.test/store/p/prod-1">');
    expect(page.html).toContain('content="index,follow');
    expect(page.html).toContain('name="description" content="Router de doble banda para el hogar"');
    expect(page.html).toContain('property="og:title"');
  });

  it('escapa el HTML y mantiene los datos estructurados parseables', () => {
    const page = renderProductPage({ product, origin: 'https://fulltech.test', indexable: true });
    expect(page.html).toContain('Router &lt;AC1200&gt;');
    expect(page.html).not.toContain('<AC1200>');
    const blocks = [...page.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
    const productNode = blocks.find((node) => node['@type'] === 'Product');
    const breadcrumb = blocks.find((node) => node['@type'] === 'BreadcrumbList');
    expect(productNode).toMatchObject({ name: 'Router <AC1200>', url: 'https://fulltech.test/store/p/prod-1' });
    expect(productNode.offers).toMatchObject({ price: '2500.00', priceCurrency: 'DOP', availability: 'https://schema.org/InStock' });
    expect(breadcrumb.itemListElement.at(-1)).toMatchObject({ name: 'Router <AC1200>' });
  });

  it('no inventa precio, valoraciones ni reseñas', () => {
    const page = renderProductPage({ product: { ...product, price: null }, origin: 'https://fulltech.test', indexable: true });
    const blocks = [...page.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
    const productNode = blocks.find((node) => node['@type'] === 'Product');
    expect(productNode.offers).toBeUndefined();
    expect(page.html).not.toContain('aggregateRating');
    expect(page.html).not.toContain('reviewCount');
  });

  it('marca fuera de stock cuando el catálogo lo dice', () => {
    const page = renderProductPage({ product: { ...product, availabilityState: 'UNAVAILABLE' }, origin: 'https://fulltech.test', indexable: true });
    expect(page.html).toContain('https://schema.org/OutOfStock');
    expect(page.html).toContain('No disponible por ahora');
  });

  it('el sitemap incluye solo los artículos recibidos (los publicados)', () => {
    const sitemap = renderSitemap({ origin: 'https://fulltech.test', products: [product] });
    expect(sitemap.included).toEqual(['prod-1']);
    expect(sitemap.xml).toContain('https://fulltech.test/store/p/prod-1');
    expect(sitemap.xml).not.toContain('sin-publicar');
    expect(sitemap.xml.match(/<url>/g)).toHaveLength(2);
  });

  it('robots cierra el rastreo en UAT y lo abre con sitemap en producción', () => {
    const closed = renderRobots({ origin: 'https://uat.test', indexable: false });
    expect(closed).toContain('Disallow: /');
    expect(closed).not.toContain('Sitemap:');
    const open = renderRobots({ origin: 'https://fulltech.test', indexable: true });
    expect(open).toContain('Allow: /store/');
    expect(open).toContain('Disallow: /admin/');
    expect(open).toContain('Sitemap: https://fulltech.test/store/sitemap.xml');
  });

  it('404 y 410 nunca se indexan', () => {
    expect(renderStoreNotFound({ origin: 'https://fulltech.test' }).html).toContain('noindex,nofollow');
    const gone = renderStoreGone({ origin: 'https://fulltech.test', name: 'Router' });
    expect(gone.html).toContain('ya no está en la tienda');
    expect(gone.html).toContain('noindex,nofollow');
  });

  it('recorta la meta descripción sin cortar palabras', () => {
    const description = metaDescription({ name: 'X', description: 'palabra '.repeat(40) });
    expect(description.length).toBeLessThanOrEqual(156);
    expect(description.endsWith('…')).toBe(true);
  });
});
