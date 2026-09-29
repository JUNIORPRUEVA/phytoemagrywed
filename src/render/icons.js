/**
 * Iconos SVG inline (sin dependencias, sin peticiones extra).
 * Heredan `currentColor` y son decorativos (`aria-hidden`).
 */

/** @type {Record<string, string>} */
const PATHS = {
  leaf: '<path d="M4 20c0-8 6-14 16-14 0 10-6 16-14 16"/><path d="M4 20c4-4 8-6 12-7"/>',
  shield: '<path d="M12 3l7 3v6c0 5-3 8-7 9-4-1-7-4-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
  package:
    '<path d="M3 8l9-5 9 5v8l-9 5-9-5V8z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
  truck: '<path d="M3 7h11v9H3z"/><path d="M14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  heart: '<path d="M12 20s-7-4.3-7-9a4 4 0 017-2.6A4 4 0 0119 11c0 4.7-7 9-7 9z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  whatsapp:
    '<path d="M20.5 11.6a8.4 8.4 0 01-12.3 7.4L4 20l1.1-4.1a8.4 8.4 0 1115.4-4.3z"/><path d="M8.8 8.3c.3-.6.6-.6.9-.6h.6c.2 0 .5 0 .7.6l.7 1.6c.1.3 0 .5-.1.7l-.5.6c-.2.2-.2.4 0 .6.4.6 1.4 1.6 2.2 2 .3.2.5.1.6 0l.7-.8c.2-.2.4-.2.6-.1l1.6.8c.3.2.4.4.4.6 0 .6-.5 1.3-1.1 1.5-.6.2-1.3.3-3-.5-1.9-.9-3.4-2.6-4-3.7-.5-.9-.6-1.6-.5-2.2 0-.4.3-.8.5-1z"/>',
  cart: '<circle cx="9" cy="19" r="1.6"/><circle cx="17" cy="19" r="1.6"/><path d="M3 4h2l2.3 10.2h11L21 7H6"/>',
  arrowRight: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  chevronLeft: '<path d="M14 6l-6 6 6 6"/>',
  chevronRight: '<path d="M10 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
  star: '<path d="M12 4l2.4 5 5.6.6-4.2 3.7 1.2 5.5L12 16l-5 2.8 1.2-5.5L4 9.6 9.6 9z"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5"/>',
  chat: '<path d="M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v7A2.5 2.5 0 0117.5 16H9.5L4.5 20V6.5z"/><path d="M9 9h6"/><path d="M9 12h4"/>',
  users:
    '<circle cx="9.5" cy="8.5" r="3.2"/><path d="M3.5 19.5c1-3 3.2-4.6 6-4.6s5 1.6 6 4.6"/><path d="M16.5 6.2a3 3 0 010 5.4"/><path d="M18.4 19.5c-.3-1.3-.8-2.4-1.4-3.3"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.7 9.5a2.4 2.4 0 114.2 1.7c-.6.6-1.4 1-1.4 2.1"/><path d="M12.5 17h.01"/>',
};

/**
 * @param {string} name
 * @param {{ size?: number, className?: string, title?: string }} [options]
 */
export function icon(name, options = {}) {
  const path = PATHS[name] ?? PATHS.info;
  const { size = 24, className = '', title } = options;
  const titleTag = title ? `<title>${title}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${className ? ` class="${className}"` : ''}>${titleTag}${path}</svg>`;
}

export const ICON_NAMES = Object.keys(PATHS);
