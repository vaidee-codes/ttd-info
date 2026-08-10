// Shared server-side Dodo Payments helper. The API key lives only in Vercel env.
const BASE = 'https://live.dodopayments.com';
const KEY = process.env.DODO_API_KEY || '';

export const WEEKLY_PRODUCT_ID = 'pdt_0Nk4Gw67usedtjPoO6hX2';
export const WEEKLY_ENTITLEMENT_ID = 'ent_0Nk4GugPIsPbnFf5dYYqC';
// Attached to the Monthly Supporter product so every paid month issues a 1-month key.
export const MONTHLY_ENTITLEMENT_ID = 'ent_0NktSBrbESJK6IQ99toyW';

// One-time pass plans sold on the pass page. prices are in INR paise.
export const PASS_PLANS = {
  '7d': {
    product_id: 'pdt_0Nk4Gw67usedtjPoO6hX2',
    entitlement_id: 'ent_0Nk4GugPIsPbnFf5dYYqC',
    days: 7,
    price: 9900,
    old_price: 19800,
    label: '7-day pass'
  },
  '30d': {
    product_id: 'pdt_0NkvjEpCQNkDuaCT65cFV',
    entitlement_id: 'ent_0NkvjEit63fF12KazuaN1',
    days: 30,
    price: 29900,
    old_price: null,
    label: '30-day pass'
  },
  '90d': {
    product_id: 'pdt_0NkvjEr1l8rhSF6Ibxlj3',
    entitlement_id: 'ent_0NkvjEqEgOtu4zXZbpSnR',
    days: 90,
    price: 69900,
    old_price: null,
    label: '90-day pass'
  }
};

export function isPassSalesEnabled() {
  return String(process.env.PASS_SALES_ENABLED || '').trim().toLowerCase() === 'true';
}

export function getPassPlan(code) {
  return PASS_PLANS[String(code || '').trim()] || PASS_PLANS['7d'];
}

export async function dodo(path, opts = {}) {
  if (!KEY) throw new Error('DODO_API_KEY is not configured');
  // Hard 8s cap: a slow/hung Dodo request fails fast so a serverless
  // function never burns compute waiting, and callers degrade gracefully
  // instead of piling up requests.
  const r = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: {
      Authorization: 'Bearer ' + KEY,
      Accept: 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(8000)
  });
  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) {
    const detail = typeof json === 'string' ? json : JSON.stringify(json);
    const err = new Error('Dodo ' + r.status + ': ' + String(detail).slice(0, 300));
    err.status = r.status;
    err.code = (json && json.code) || null;
    throw err;
  }
  return json;
}

// All grants (and their license keys) for a customer across every entitlement.
// Any promised stacking is normalized operationally onto one canonical Dodo
// key, so the effective expiry is the farthest provider expiry.
export async function resolveLicenseForCustomer(customerId) {
  const entIds = [...new Set(
    [WEEKLY_ENTITLEMENT_ID, MONTHLY_ENTITLEMENT_ID]
      .concat(Object.values(PASS_PLANS).map((plan) => plan.entitlement_id))
      .filter(Boolean)
  )];
  let effectiveExpiry = 0;
  let best = null; // newest valid key, for display
  let bestCreated = 0;
  let keys = [];

  for (const entId of entIds) {
    let grants;
    try {
      grants = await dodo(`/entitlements/${entId}/grants?customer_id=${encodeURIComponent(customerId)}&limit=100`);
    } catch { continue; /* entitlement not attached yet — skip */ }
    for (const g of grants.items || []) {
      const lic = g.license_key || g.license;
      if (!lic || !lic.key) continue;
      if (g.status && /revok|pending|failed|cancelled/i.test(String(g.status))) continue;
      const exp = lic.expires_at ? Date.parse(lic.expires_at) : null;
      if (exp) effectiveExpiry = Math.max(effectiveExpiry, exp);
      const created = g.created_at ? Date.parse(g.created_at) : 0;
      keys.push({ key: lic.key, expires_at: lic.expires_at || null });
      if (created > bestCreated) {
        bestCreated = created;
        best = {
          key: lic.key,
          expires_at: lic.expires_at || null,
          entitlement_id: entId,
          grant_status: g.status,
          activations_used: lic.activations_used,
          activations_limit: lic.activations_limit
        };
      }
    }
  }

  if (!best) return null;
  const effectiveExpiresAt = effectiveExpiry
    ? new Date(effectiveExpiry).toISOString()
    : best.expires_at;
  return {
    key: best.key,
    // Effective expiry after operational stacking normalization.
    expires_at: effectiveExpiresAt,
    raw_expires_at: best.expires_at,
    effective_expires_at: effectiveExpiresAt,
    keys,
    entitlement_id: best.entitlement_id,
    grant_status: best.grant_status,
    activations_used: best.activations_used,
    activations_limit: best.activations_limit
  };
}

// Locate a license key record by its exact value (Dodo's /license_keys query
// params ignore license_key=, so we page through and match exactly).
export async function findLicenseKeyByValue(licenseKey) {
  const clean = String(licenseKey || '').trim();
  if (!clean) return null;
  const PAGE_SIZE = 100;
  for (let page = 0; page < 3; page++) {
    const { items } = await dodo(`/license_keys?page_size=${PAGE_SIZE}&page_number=${page}`);
    for (const item of items || []) {
      if (item.key === clean) return item;
    }
  }
  return null;
}

export async function activateLicenseKey(key, name) {
  return dodo('/licenses/activate', {
    method: 'POST',
    body: { license_key: String(key).trim(), name: String(name || 'TTD Autofill - Chrome') }
  });
}

export async function deactivateLicenseKey(key, instanceId) {
  return dodo('/licenses/deactivate', {
    method: 'POST',
    body: { license_key: String(key).trim(), license_key_instance_id: String(instanceId) }
  });
}

// Robust body parser: Vercel may hand us a parsed object, a JSON string, or a Buffer.
export function readBody(req) {
  try {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Same-origin + extension CORS.
export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
