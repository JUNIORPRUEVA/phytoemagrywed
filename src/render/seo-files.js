/**
 * Archivos SEO generados en el build: robots.txt y sitemap.xml.
 * Si no hay `SEO_SITE_URL` configurado, no se inventa ninguna URL:
 * se omite el sitemap y el build avisa por consola.
 */

/** @param {string} path */
function basename(path) {
  return String(path).replace(/^\/+/, '');
}

/** @param {ReturnType<import('./view.js').buildView>} view */
export function renderRobots(view) {
  const { site } = view;
  const lines = [
    '# robots.txt — generado por scripts/build.mjs',
    'User-agent: *',
    site.seo.noindex ? 'Disallow: /' : 'Allow: /',
    '',
  ];
  if (view.seo.siteUrl) lines.push(`Sitemap: ${view.seo.siteUrl}/sitemap.xml`, '');
  else lines.push('# PENDIENTE: define SEO_SITE_URL para publicar el sitemap.', '');
  return lines.join('\n');
}

/** @param {ReturnType<import('./view.js').buildView>} view @param {string} [lastmod] */
export function renderSitemap(view, lastmod = new Date().toISOString().slice(0, 10)) {
  if (!view.seo.siteUrl) return null;
  const paths = ['/', view.site.privacy.privacyPath, view.site.privacy.termsPath];
  const urls = paths
    .map(
      (path) =>
        `  <url>\n    <loc>${view.seo.siteUrl}${path}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export { basename };
