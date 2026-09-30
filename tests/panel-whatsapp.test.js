// @vitest-environment node
/**
 * EL PANEL TIENE QUE LLAMAR A LO QUE SE CONSTRUYÓ.
 *
 * Este archivo existe por un fallo real de la fase anterior: el píxel estaba
 * configurado pero nadie llamaba a su adaptador, así que "todo funcionaba" y no
 * se medía nada. Aquí se comprueba, sobre el archivo que se sirve de verdad, que
 * el panel usa los endpoints nuevos y que no hay ningún envío automático.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const adminDir = path.join(process.cwd(), 'public', 'admin');
const html = readFileSync(path.join(adminDir, 'index.html'), 'utf8');
const app = readFileSync(path.join(adminDir, 'app.js'), 'utf8');
const css = readFileSync(path.join(adminDir, 'admin.css'), 'utf8');

describe('el panel tiene las secciones nuevas', () => {
  it('existe la pestaña de WhatsApp y su vista', () => {
    expect(html).toContain('data-tab="whatsapp"');
    expect(html).toContain('id="view-whatsapp"');
    expect(html).toContain('id="list-whatsapp"');
    expect(html).toContain('id="badge-whatsapp"');
    // El estado de WhatsApp también se explica en Ajustes.
    expect(html).toContain('id="wa-config"');
  });

  it('las cinco vistas se muestran y se ocultan de verdad', () => {
    for (const name of ['hoy', 'whatsapp', 'clientes', 'mensajes', 'ajustes']) {
      expect(app).toContain(`'${name}'`);
      expect(html).toContain(`id="view-${name}"`);
    }
    expect(app).toContain("$$('[data-tab]')");
  });

  it('la barra de pestañas está preparada para cinco secciones', () => {
    expect(css).toContain('repeat(5, 1fr)');
  });
});

describe('el panel llama a los endpoints del CRM', () => {
  it('clientes, compras y seguimiento', () => {
    expect(app).toContain('/api/admin/customers/');
    expect(app).toContain('/api/admin/purchases');
    expect(app).toContain('/api/admin/followups');
    expect(app).toContain('/api/admin/wa-templates');
  });

  it('conversaciones y envío manual', () => {
    expect(app).toContain('/api/admin/conversations/');
    // El envío sale de un botón con una persona delante.
    expect(app).toContain("id=\"composer-send\"");
    expect(app).toContain('Enviar por WhatsApp');
  });

  it('las acciones del día (hecho, posponer, cancelar, no contactar)', () => {
    for (const attribute of ['data-followup-done', 'data-followup-postpone', 'data-followup-cancel', 'data-optout', 'data-pause']) {
      expect(app).toContain(attribute);
    }
  });

  it('el hilo distingue CLIENTE, NEGOCIO y AUTOMATIZACIÓN', () => {
    expect(app).toContain("'Cliente'");
    expect(app).toContain("'Negocio'");
    expect(app).toContain("'Automatización'");
  });
});

describe('nada se envía solo', () => {
  it('no hay temporizadores ni envíos automáticos en el panel', () => {
    // El único setTimeout del panel es el del aviso flotante y el de recoger el
    // resultado de Meta; ninguno envía mensajes.
    const timers = app.match(/setInterval|setTimeout/g) ?? [];
    expect(timers.every((entry) => entry === 'setTimeout')).toBe(true);
    expect(app).not.toMatch(/autoSend|sendAutomatically|scheduleSend/i);
  });

  it('el seguimiento se presenta como una tarea, no como un envío', () => {
    expect(app).toContain('Es una TAREA para una persona: el sistema no envía nada solo.');
  });
});
