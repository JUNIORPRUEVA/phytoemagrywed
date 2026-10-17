// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let dom;
afterEach(() => dom?.window.close());
function setup() {
  dom = new JSDOM('<div id="list"></div>', { runScripts: 'outside-only' });
  const win = dom.window;
  const box = win.document.getElementById('list');
  Object.defineProperty(box, 'clientHeight', { value: 400 });
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    const top = this === box ? 56 : 56 + [...box.children].indexOf(this) * 76 - box.scrollTop;
    return { top, bottom: top + (this === box ? 400 : 76) };
  };
  win.eval(readFileSync('public/admin/conversation-list.js', 'utf8'));
  const paint = (ids, scope = 'all') => win.PhytoConversationList.render(box,
    ids.map((id) => `<div data-conversation-row="${id}"><button>${id}</button></div>`).join(''), scope);
  return { box, paint, win };
}

describe('bandeja continua de conversaciones', () => {
  it('un refresco sin cambios conserva el nodo, el foco y el desplazamiento', () => {
    const { box, paint, win } = setup();
    paint(['a', 'b', 'c', 'd']);
    const row = box.children[1]; const button = row.firstElementChild;
    button.focus(); box.scrollTop = 100;
    paint(['a', 'b', 'c', 'd']);
    expect(box.children[1]).toBe(row);
    expect(win.document.activeElement).toBe(button);
    expect(box.scrollTop).toBe(100);
  });

  it('al llegar un chat nuevo mantiene la fila que se estaba leyendo en el mismo sitio', () => {
    const { box, paint } = setup();
    paint(['a', 'b', 'c', 'd', 'e']); box.scrollTop = 100;
    const reading = box.children[1]; const before = reading.getBoundingClientRect().top;
    paint(['new', 'a', 'b', 'c', 'd', 'e']);
    expect(box.scrollTop).toBe(176);
    expect(reading.getBoundingClientRect().top).toBe(before);
    expect(box.children[2]).toBe(reading);
  });

  it('en el inicio permite ver inmediatamente el chat nuevo', () => {
    const { box, paint } = setup(); paint(['a', 'b']); paint(['new', 'a', 'b']);
    expect(box.scrollTop).toBe(0);
    expect(box.firstElementChild.dataset.conversationRow).toBe('new');
  });

  it('al cambiar de búsqueda o filtro comienza al principio de los resultados', () => {
    const { box, paint } = setup(); paint(['a', 'b', 'c']); box.scrollTop = 130;
    paint(['c'], 'search:c'); expect(box.scrollTop).toBe(0);
  });

  it('reordenar chats conserva la conversación visible y retira filas eliminadas', () => {
    const { box, paint } = setup(); paint(['a', 'b', 'c', 'd']); box.scrollTop = 160;
    const reading = box.children[2]; const before = reading.getBoundingClientRect().top;
    paint(['d', 'c', 'b']);
    expect(reading.getBoundingClientRect().top).toBe(before);
    expect([...box.children].map((row) => row.dataset.conversationRow)).toEqual(['d', 'c', 'b']);
  });

  it('recupera las filas si la bandeja pasó por error o estado vacío', () => {
    const { box, paint } = setup(); paint(['a', 'b']); box.innerHTML = '';
    paint(['a', 'b']); expect(box.children).toHaveLength(2);
  });
});
