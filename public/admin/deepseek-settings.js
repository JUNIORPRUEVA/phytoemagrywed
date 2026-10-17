(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let loading = false;
  const feedback = message => { $('deepseek-feedback').textContent = message; };
  function busy(value) { $('deepseek-settings-form').querySelectorAll('input,button,select').forEach(node => { node.disabled = value; }); }
  async function request(path, body) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || 'No se pudo completar la operación.');
    return result;
  }
  function render(config) {
    $('deepseek-api-key').value = '';
    $('deepseek-api-key').placeholder = config.configured ? '•••••••••••••••• · Clave guardada' : 'Pega tu clave para configurarla';
    $('deepseek-key-status').textContent = `${config.configured ? '✓ Clave guardada en el servidor. El campo queda vacío por seguridad; escribe aquí solo si quieres cambiarla.' : 'Todavía no hay una clave guardada.'} ${config.enabled ? 'Correcciones de apoyo activadas.' : 'Correcciones de apoyo desactivadas.'} Consultas de hoy: ${config.usedToday} de ${config.dailyLimit}.`;
    $('deepseek-model').value = config.model;
    $('deepseek-daily-limit').value = config.dailyLimit;
    $('deepseek-enabled').checked = config.enabled;
  }
  async function load() {
    if (loading || !$('config-deepseek') || $('config-deepseek').hidden) return;
    loading = true; busy(true); feedback('');
    try { render((await request('/api/admin/settings/deepseek')).deepseek); }
    catch { feedback('No se pudo cargar la configuración. Vuelve a intentarlo.'); }
    finally { loading = false; busy(false); }
  }
  document.addEventListener('DOMContentLoaded', () => {
    const card = $('config-deepseek'); if (!card) return;
    let wasHidden = card.hidden;
    new MutationObserver(() => {
      if (wasHidden && !card.hidden) load();
      wasHidden = card.hidden;
    }).observe(card, { attributes: true, attributeFilter: ['hidden'] });
    $('deepseek-settings-form').addEventListener('submit', async event => {
      event.preventDefault(); if (loading) return;
      const input = { apiKey: $('deepseek-api-key').value.trim(), enabled: $('deepseek-enabled').checked, model: $('deepseek-model').value, dailyLimit: Number($('deepseek-daily-limit').value) };
      loading = true; busy(true); feedback('Guardando…');
      try {
        await request('/api/admin/settings/deepseek', input);
        const persisted = (await request('/api/admin/settings/deepseek')).deepseek;
        if (!persisted || (input.apiKey && !persisted.configured) || persisted.enabled !== input.enabled || persisted.dailyLimit !== input.dailyLimit || persisted.model !== input.model) throw new Error('No se pudo confirmar el guardado. Vuelve a intentarlo; tu clave sigue en el campo.');
        render(persisted);
        feedback(persisted.configured ? `Clave guardada y confirmada en el servidor. Apoyo ${persisted.enabled ? 'activado' : 'desactivado'}.` : 'Preferencias guardadas. Falta añadir una clave API para activar el apoyo.');
        window.dispatchEvent(new Event('fulltech:proofreading-config-updated'));
      } catch (error) { feedback(error.message); }
      finally { loading = false; busy(false); }
    });
    $('deepseek-test').addEventListener('click', async () => {
      if (loading) return; loading = true; busy(true); feedback('Comprobando…');
      try { feedback((await request('/api/admin/settings/deepseek/test', {})).connected ? 'Conexión correcta. Flash está disponible.' : 'No se pudo conectar. Revisa la clave y el estado de tu cuenta en DeepSeek.'); }
      catch { feedback('No se pudo comprobar la conexión.'); }
      finally { loading = false; busy(false); }
    });
    $('deepseek-remove').addEventListener('click', async () => {
      if (loading) return; loading = true; busy(true);
      try { render((await request('/api/admin/settings/deepseek', { removeKey: true, enabled: false })).deepseek); feedback('Clave eliminada. El corrector local sigue disponible.'); window.dispatchEvent(new Event('fulltech:proofreading-config-updated')); }
      catch { feedback('No se pudo eliminar la clave.'); }
      finally { loading = false; busy(false); }
    });
    load();
  });
  window.addEventListener('fulltech:deepseek-settings', load);
})();
