import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  'env-file': { type: 'string' },
  apply: { type: 'boolean', default: false },
  'request-display-name': { type: 'boolean', default: false },
} });

function parseEnv(source) {
  const out = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const env = {
  ...(values['env-file'] ? parseEnv(await readFile(path.resolve(values['env-file']), 'utf8')) : {}),
  ...process.env,
};
const token = env.WHATSAPP_ACCESS_TOKEN?.trim();
const phoneId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
const appId = env.META_APP_ID?.trim();
const version = env.WHATSAPP_GRAPH_VERSION?.trim() || 'v21.0';
const imagePath = path.join(root, 'public', 'admin', 'fulltech-logo.png');
const about = 'Tecnología, ventas y servicio a buen precio, con atención cercana y entrega ágil.';
const displayName = 'FULLTECH, SRL';

if (!token || !/^\d+$/.test(phoneId || '') || !/^\d+$/.test(appId || '') || !/^v\d+\.\d+$/.test(version)) {
  console.log(JSON.stringify({ ok: false, error: 'missing_or_invalid_configuration', required: ['META_APP_ID', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN'] }));
  process.exitCode = 1;
} else {
  const { stat } = await import('node:fs/promises');
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      const error = new Error('meta_request_failed');
      error.status = response.status;
      error.code = data.error?.code ?? null;
      throw error;
    }
    return data;
  }

  if (values['request-display-name']) {
    if (!values.apply) {
      console.log(JSON.stringify({ ok: true, mode: 'preview', requestedDisplayName: displayName }));
    } else {
      try {
        const current = await request(`https://graph.facebook.com/${version}/${phoneId}?fields=verified_name`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (String(current.verified_name ?? '').trim().toLocaleLowerCase() === displayName.toLocaleLowerCase()) {
          console.log(JSON.stringify({ ok: true, displayNameAlreadyActive: true, verifiedName: current.verified_name }));
        } else {
          const submitted = await request(`https://graph.facebook.com/${version}/${phoneId}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', new_display_name: displayName }),
          });
          const status = await request(`https://graph.facebook.com/${version}/${phoneId}?fields=name_status`, {
            headers: { Authorization: `Bearer ${token}` },
          }).catch(() => ({}));
          console.log(JSON.stringify({ ok: submitted.success === true, submitted: submitted.success === true, requestedDisplayName: displayName, reviewStatus: status.name_status ?? 'submitted; status unavailable' }));
          if (submitted.success !== true) process.exitCode = 1;
        }
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error.message === 'meta_request_failed' ? error.message : 'display_name_request_failed', httpStatus: error.status ?? null, code: error.code ?? null }));
        process.exitCode = 1;
      }
    }
  } else {
  const imageStat = await stat(imagePath);
  console.log(JSON.stringify({
    ok: true,
    mode: values.apply ? 'apply' : 'preview',
    profile: { about, image: 'public/admin/fulltech-logo.png', imageBytes: imageStat.size },
    displayName: 'FULLTECH, SRL (solicitar por WhatsApp Manager; requiere aprobación de Meta)',
  }));

  if (values.apply) {
    try {
      const uploadUrl = new URL(`https://graph.facebook.com/${version}/${appId}/uploads`);
      uploadUrl.searchParams.set('file_length', String(imageStat.size));
      uploadUrl.searchParams.set('file_type', 'image/png');
      uploadUrl.searchParams.set('access_token', token);
      const session = await request(uploadUrl, { method: 'POST' });
      if (!session.id) throw new Error('upload_session_missing');

      const bytes = await readFile(imagePath);
      const uploaded = await request(`https://graph.facebook.com/${version}/${session.id}`, {
        method: 'POST',
        headers: { Authorization: `OAuth ${token}`, file_offset: '0', 'Content-Type': 'application/octet-stream' },
        body: bytes,
      });
      if (!uploaded.h) throw new Error('profile_picture_handle_missing');

      const updated = await request(`https://graph.facebook.com/${version}/${phoneId}/whatsapp_business_profile`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', about, profile_picture_handle: uploaded.h }),
      });
      console.log(JSON.stringify({ ok: updated.success === true, profileUpdated: updated.success === true }));
      if (updated.success !== true) process.exitCode = 1;
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error.message === 'meta_request_failed' ? error.message : 'profile_update_failed', httpStatus: error.status ?? null, code: error.code ?? null }));
      process.exitCode = 1;
    }
  }
  }
}
