/* Actualizar la bandeja conserva sus filas y el punto donde se está leyendo. */
(() => {
  'use strict';
  const snapshots = new WeakMap();
  function render(box, html, scope) {
    const previous = snapshots.get(box);
    const sameScope = previous?.scope === scope;
    if (sameScope && previous.html === html && previous.nodes.length === box.children.length &&
      previous.nodes.every((row, index) => box.children[index] === row)) return;
    const scrollTop = box.scrollTop;
    let anchor = null;
    let offset = 0;
    if (sameScope && scrollTop > 0 && box.clientHeight > 0) {
      const top = box.getBoundingClientRect().top;
      anchor = [...box.children].find((row) => row.dataset.conversationRow && row.getBoundingClientRect().bottom > top);
      if (anchor) offset = anchor.getBoundingClientRect().top - top;
    }
    const template = document.createElement('template');
    template.innerHTML = html;
    const existing = new Map([...box.children].filter((row) => row.dataset.conversationRow)
      .map((row) => [row.dataset.conversationRow, row]));
    const next = [...template.content.children].map((row) => {
      const old = existing.get(row.dataset.conversationRow);
      return old?.isEqualNode(row) ? old : row;
    });
    // Mover solo las filas que cambiaron de orden; las demás conservan foco y gestos.
    let cursor = box.firstElementChild;
    for (const row of next) {
      if (row === cursor) cursor = cursor.nextElementSibling;
      else box.insertBefore(row, cursor);
    }
    while (cursor) {
      const removed = cursor;
      cursor = cursor.nextElementSibling;
      removed.remove();
    }
    if (!sameScope) box.scrollTop = 0;
    else if (anchor) {
      const current = next.find((row) => row.dataset.conversationRow === anchor.dataset.conversationRow);
      box.scrollTop = current
        ? scrollTop + current.getBoundingClientRect().top - box.getBoundingClientRect().top - offset
        : scrollTop;
    } else box.scrollTop = scrollTop;
    snapshots.set(box, { html, scope, nodes: next });
  }
  window.PhytoConversationList = { render };
})();
