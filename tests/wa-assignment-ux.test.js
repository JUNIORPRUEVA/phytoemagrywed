// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/admin/admin.css', import.meta.url), 'utf8');

describe('WhatsApp assignment UX', () => {
  it('no pinta controles grandes de asignación dentro del hilo', () => {
    expect(app).not.toContain('assignment-bar');
    expect(css).not.toContain('.assignment-bar');
    expect(app).toContain("$('#thread').innerHTML = messages.length ? waThreadHtml(messages)");
  });

  it('muestra el responsable en header y lista de forma compacta', () => {
    expect(app).toContain('function conversationAssignmentLabel');
    expect(app).toContain("conversationAssignmentLabel(conversation)");
    expect(app).toContain('conv__assign');
    expect(app).toContain('conv__assign--empty');
    expect(css).toContain('.conv__assign');
    expect(css).toContain('.conv__assign--empty');
  });

  it('usa un único menú discreto en el header del chat', () => {
    expect(html).toContain('class="wa__chat-menu"');
    expect(html).toContain('id="wa-actions"');
    expect(html).not.toContain('class="wa__fab-row"');
    expect(html).not.toContain('class="wa-fab"');
    expect(css).toContain('.wa__chat-menu');
  });

  it('el menú de conversación decide acciones según asignación y rol', () => {
    const start = app.indexOf('function openChatActions');
    const menu = app.slice(start, start + 4200);
    expect(menu).toContain('Tomar conversación');
    expect(menu).toContain('Liberar conversación');
    expect(menu).toContain('Reasignar');
    expect(menu).toContain('Asignada a otra persona');
    expect(menu).toContain("hasPermission('chats.take_unassigned')");
    expect(menu).toContain('assignedToMe || isAdmin()');
    expect(menu).toContain('isAdmin()');
  });
});
