/**
 * Imágenes responsive.
 *
 * Convenio de nombres (documentado en README): partiendo de una ruta base
 * `/assets/img/producto-hero` deben existir los archivos:
 *
 *   producto-hero-640.avif   producto-hero-640.webp   producto-hero-640.jpg
 *   producto-hero-1024.avif  producto-hero-1024.webp  producto-hero-1024.jpg
 *
 * El render genera un `<picture>` con AVIF → WebP → JPG, `width`/`height`
 * explícitos (evita CLS) y `loading`/`fetchpriority` configurables.
 */

import { attr, escapeHtml } from './html.js';

export const IMAGE_WIDTHS = Object.freeze([640, 1024]);
export const IMAGE_FORMATS = Object.freeze([
  ['avif', 'image/avif'],
  ['webp', 'image/webp'],
]);

/**
 * `sizes` de la portada: en móvil ocupa todo el ancho (full-bleed) y en desktop
 * se limita al ancho del contenedor. Debe coincidir con el CSS y con el preload.
 */
export const HERO_SIZES = '(min-width: 1200px) 1120px, (min-width: 768px) 92vw, 100vw';

/**
 * `sizes` de la foto de una tarjeta de frasco (carrusel horizontal).
 * Debe coincidir con el ancho de `.pe-variant` en `components.css`: así el
 * navegador descarga la foto de la tarjeta y no una de pantalla completa.
 */
export const VARIANT_SIZES = '(min-width: 1024px) 232px, 240px';

/** @param {unknown} basePath @returns {string|null} */
export function normalizeBase(basePath) {
  if (typeof basePath !== 'string') return null;
  const trimmed = basePath.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\.(avif|webp|jpe?g|png)$/i, '');
}

/**
 * @param {unknown} basePath
 * @param {{ width?: number, height?: number, alt?: string, widths?: number[] }} [options]
 */
export function resolveImage(basePath, options = {}) {
  const base = normalizeBase(basePath);
  if (!base) return null;
  const { width = 1024, height = 1024, alt = '', widths = [...IMAGE_WIDTHS] } = options;
  const ratio = height / width;

  return {
    base,
    alt,
    width,
    height,
    widths,
    /** @param {number} w @param {string} ext */
    file: (w, ext) => `${base}-${w}.${ext}`,
    srcset(ext) {
      return widths.map((w) => `${base}-${w}.${ext} ${w}w`).join(', ');
    },
    fallback(w = widths[widths.length - 1]) {
      return `${base}-${w}.jpg`;
    },
    heightFor(w) {
      return Math.round(w * ratio);
    },
  };
}

/**
 * @param {ReturnType<typeof resolveImage>} image
 * @param {{ sizes?: string, className?: string, loading?: 'lazy'|'eager', fetchPriority?: 'high'|'auto'|'low', decoding?: string, width?: number, height?: number }} [options]
 */
export function renderPicture(image, options = {}) {
  if (!image) return '';
  const {
    sizes = '(min-width: 1024px) 520px, 92vw',
    className = '',
    loading = 'lazy',
    fetchPriority = null,
    decoding = 'async',
    width = image.width,
    height = image.height,
  } = options;

  const sources = IMAGE_FORMATS.map(
    ([ext, type]) =>
      `<source type="${type}" srcset="${escapeHtml(image.srcset(ext))}" sizes="${escapeHtml(sizes)}"${attr('width', width)}${attr('height', height)}>`,
  ).join('');

  return `<picture class="pe-picture${className ? ` ${className}` : ''}">${sources}<img src="${escapeHtml(image.fallback())}" alt="${escapeHtml(image.alt)}"${attr('width', width)}${attr('height', height)}${attr('loading', loading)}${attr('decoding', decoding)}${attr('fetchpriority', fetchPriority)}></picture>`;
}

/** Marco de imagen pendiente (placeholder honesto, sin inventar fotos). */
export function renderImagePlaceholder(label = 'Imagen del producto pendiente') {
  return `<div class="pe-media-placeholder" role="img" aria-label="${escapeHtml(label)}">
      <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4 4 3 3-2 4 3"/></svg>
      <span>${escapeHtml(label)}</span>
    </div>`;
}
