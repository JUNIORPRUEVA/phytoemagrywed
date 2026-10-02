export const SALE_SOURCES = Object.freeze(['META_ADS', 'ORGANIC', 'REFERRAL', 'MANUAL', 'WHATSAPP', 'STORE', 'OTHER']);
export const SOURCE_ORIGINS = Object.freeze(['AUTO', 'MANUAL']);

export const SOURCE_LABELS = Object.freeze({
  META_ADS: 'Meta Ads',
  ORGANIC: 'Orgánico',
  REFERRAL: 'Referido',
  MANUAL: 'Tienda / Manual',
  WHATSAPP: 'WhatsApp',
  STORE: 'Tienda',
  OTHER: 'Otro',
});

const FIELD_LIMITS = Object.freeze({
  source_url: 500,
  source_type: 80,
  headline: 240,
  body: 500,
  ctwa_clid: 240,
  ad_id: 120,
  campaign_id: 120,
  adset_id: 120,
  fbclid: 400,
  fbc: 500,
  fbp: 500,
  utm_source: 120,
  utm_campaign: 200,
  utm_content: 200,
});

function clean(value, max = 200) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const trimmed = String(value).replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function cleanJson(value, max = 4000) {
  if (!value || typeof value !== 'object') return null;
  try {
    return JSON.parse(JSON.stringify(value).slice(0, max));
  } catch {
    return null;
  }
}

export function normalizeSaleSource(value, fallback = 'OTHER') {
  const raw = String(value ?? '').trim().toUpperCase();
  const mapped =
    raw === 'FACEBOOK' || raw === 'FACEBOOK_ADS' || raw === 'INSTAGRAM_ADS' || raw === 'META' || raw === 'META_ADS'
      ? 'META_ADS'
      : raw === 'ORGANICO' || raw === 'ORGANIC'
        ? 'ORGANIC'
        : raw === 'REFERIDO' || raw === 'REFERRAL'
          ? 'REFERRAL'
          : raw === 'MANUAL' || raw === 'TIENDA' || raw === 'STORE'
            ? raw === 'STORE'
              ? 'STORE'
              : 'MANUAL'
            : raw === 'WHATSAPP'
              ? 'WHATSAPP'
              : raw === 'OTHER' || raw === 'OTRO'
                ? 'OTHER'
                : '';
  return SALE_SOURCES.includes(mapped) ? mapped : fallback;
}

export function normalizeSourceOrigin(value, fallback = 'MANUAL') {
  const raw = String(value ?? '').trim().toUpperCase();
  return SOURCE_ORIGINS.includes(raw) ? raw : fallback;
}

export function captureMetaReferral(message = {}, now = new Date().toISOString()) {
  const referral = message?.referral && typeof message.referral === 'object' ? message.referral : null;
  if (!referral) return null;
  const out = {};
  for (const [key, max] of Object.entries(FIELD_LIMITS)) {
    const value = clean(referral[key], max);
    if (value) out[key] = value;
  }
  const payload = cleanJson(referral);
  if (payload) out.referral_payload = payload;
  if (Object.keys(out).length === 0) return null;
  out.captured_at = now;
  return out;
}

export function hasAutomaticMetaEvidence(attribution) {
  if (!attribution || typeof attribution !== 'object') return false;
  return Boolean(
    attribution.ctwa_clid ||
      attribution.ad_id ||
      attribution.campaign_id ||
      attribution.adset_id ||
      attribution.fbclid ||
      attribution.clickIds?.fbclid ||
      attribution.fbc ||
      attribution.referral_payload,
  );
}

export function sourceFromAttribution(attribution) {
  return hasAutomaticMetaEvidence(attribution) ? { source: 'META_ADS', source_origin: 'AUTO' } : null;
}

export function manualAttribution(input = {}, actor = null) {
  const source = normalizeSaleSource(input.source ?? input.saleSource ?? input.orderSource, 'MANUAL');
  const sourceOrigin = normalizeSourceOrigin(input.source_origin ?? input.sourceOrigin, 'MANUAL');
  const meta = {};
  for (const key of ['utm_campaign', 'utm_content', 'ad_id', 'campaign_id', 'adset_id']) {
    const value = clean(input[key] ?? input.meta_attribution?.[key], FIELD_LIMITS[key] ?? 200);
    if (value) meta[key] = value;
  }
  const note = clean(input.source_note ?? input.sourceNote ?? input.meta_note, 500);
  if (note) meta.note = note;
  if (actor?.actor_type === 'USER') {
    meta.marked_by_user_id = actor.id;
    meta.marked_by_display_name = actor.display_name;
  } else if (actor?.display_name) {
    meta.marked_by_display_name = actor.display_name;
  }
  return {
    source,
    source_origin: sourceOrigin,
    meta_attribution: Object.keys(meta).length ? meta : null,
  };
}

export function orderAttributionSnapshot(input = {}) {
  const source = normalizeSaleSource(input.source, 'OTHER');
  const sourceOrigin = normalizeSourceOrigin(input.source_origin, 'MANUAL');
  const meta = input.meta_attribution && typeof input.meta_attribution === 'object' ? cleanJson(input.meta_attribution) : null;
  return {
    source,
    source_origin: sourceOrigin,
    meta_attribution_snapshot: meta,
    source_label: SOURCE_LABELS[source] ?? source,
  };
}

export function readOrderAttribution(itemOrOrder) {
  const raw = itemOrOrder?.order_json ?? itemOrOrder?.orderJson;
  let order = itemOrOrder;
  if (typeof raw === 'string') {
    try {
      order = JSON.parse(raw);
    } catch {
      order = itemOrOrder;
    }
  }
  const payloadRaw = itemOrOrder?.payload;
  let payload = {};
  if (typeof payloadRaw === 'string') {
    try {
      payload = JSON.parse(payloadRaw);
    } catch {
      payload = {};
    }
  } else if (payloadRaw && typeof payloadRaw === 'object') {
    payload = payloadRaw;
  }
  const source = normalizeSaleSource(order?.source ?? payload?.sale_source ?? payload?.source, 'OTHER');
  const source_origin = normalizeSourceOrigin(order?.source_origin ?? payload?.source_origin, 'MANUAL');
  return {
    source,
    source_origin,
    source_label: SOURCE_LABELS[source] ?? source,
    meta_attribution_snapshot: order?.meta_attribution_snapshot ?? payload?.meta_attribution ?? null,
  };
}
