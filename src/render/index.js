/**
 * Punto de entrada del render estático (build-time).
 * `scripts/build.mjs` lo usa para generar todas las páginas de una vez.
 */

import { DEFAULT_ASSETS, renderIndexPage, renderLegalPage } from './pages.js';
import { basename, renderRobots, renderSitemap } from './seo-files.js';
import { buildView } from './view.js';

export { buildView, DEFAULT_ASSETS, renderIndexPage, renderLegalPage };

/**
 * Genera todas las páginas del sitio.
 * @param {{ config?: { site?: any, product?: any, content?: any }, assets?: { css: string, js: string } }} [options]
 * @returns {{ pages: { path: string, html: string }[], robots: string, sitemap: string|null, view: ReturnType<typeof buildView> }}
 */
export function renderSite(options = {}) {
  const view = buildView(options.config);
  const assets = options.assets ?? DEFAULT_ASSETS;

  const pages = [
    { path: 'index.html', html: renderIndexPage(view, { assets }) },
    {
      path: basename(view.site.privacy.privacyPath),
      html: renderLegalPage(view, { assets, kind: 'privacy' }),
    },
    {
      path: basename(view.site.privacy.termsPath),
      html: renderLegalPage(view, { assets, kind: 'terms' }),
    },
  ];

  return {
    pages,
    robots: renderRobots(view),
    sitemap: renderSitemap(view),
    view,
  };
}
