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

  it('usa un único menú discreto flotante al pie del chat', () => {
    expect(html).not.toContain('class="wa__chat-menu"');
    expect(html).toContain('id="wa-actions"');
    expect(html).toContain('class="wa__fab-row"');
    expect(html).toContain('class="wa-fab"');
    expect(css).toContain('.wa-fab');
  });

  it('el menú de conversación decide acciones según asignación y rol', () => {
    const start = app.indexOf('function assignmentMenuHtml');
    const menu = app.slice(start, start + 2800);
    expect(app).toContain('function assignmentMenuHtml');
    expect(app).toContain('const assignmentMenu = assignmentMenuHtml(conversation, { conversationId });');
    expect(menu).toContain('Tomar conversación');
    expect(menu).toContain('Liberar conversación');
    expect(menu).toContain('Reasignar / transferir');
    expect(menu).toContain('Asignada a otra persona');
    expect(menu).toContain("hasPermission('chats.take_unassigned')");
    expect(menu).toContain('assignedToMe || isAdmin()');
    expect(menu).toContain('isAdmin()');
  });

  it('también ofrece asignación desde el ⋯ de la lista de conversaciones', () => {
    const start = app.indexOf('function openConvMenu');
    const menu = app.slice(start, start + 2600);
    expect(menu).toContain('assignmentMenuHtml(row, { conversationId })');
    expect(app).toContain("data-conv-take=\"${escapeHtml(conversationId)}\"");
    expect(app).toContain("data-conv-reassign=\"${escapeHtml(conversationId)}\"");
    expect(app).toContain('assignCurrentConversation(action, userId = null, conversationId = state.wa.selectedId)');
  });
});
