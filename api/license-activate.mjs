import { cors, readBody, findLicenseKeyByValue, resolveLicenseForCustomer, activateLicenseKey } from './_dodo.mjs';

// POST /api/license-activate  { license_key, name? } -> { ok, key, expires_at, instance_id, ... }
// Claims a license key for this browser (Dodo enforces activations_limit, so a
// key already activated on another browser fails with LICENSE_KEY_LIMIT_REACHED).
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = readBody(req);
  const licenseKey = String(body.license_key || '').trim();
  if (!licenseKey) return res.status(400).json({ error: 'license_key required' });

  try {
    const lic = await findLicenseKeyByValue(licenseKey);
    if (!lic) return res.status(404).json({ ok: false, error: 'License key not found. Check and try again.' });
    const expired = !!lic.expires_at && Date.parse(lic.expires_at) <= Date.now();
    if (lic.status !== 'active' || expired) {
      return res.status(200).json({ ok: false, error: 'This licence key has expired and can no longer be activated.' });
    }

    let activation;
    try {
      activation = await activateLicenseKey(licenseKey, String(body.name || 'TTD Autofill - Chrome').slice(0, 64));
    } catch (e) {
      if (e.code === 'LICENSE_KEY_LIMIT_REACHED') {
        return res.status(200).json({ ok: false, error: 'This key is already activated on another browser. A pass works on one browser at a time — use the key on the browser where it was first activated.' });
      }
      throw e;
    }

    let expires_at = null;
    let effective_expires_at = null;
    let raw_expires_at = lic.expires_at || null;
    if (lic.customer_id) {
      try {
        const resolved = await resolveLicenseForCustomer(lic.customer_id);
        if (resolved) {
          effective_expires_at = resolved.effective_expires_at;
          raw_expires_at = resolved.raw_expires_at || raw_expires_at;
        }
      } catch { /* keep raw */ }
    }
    expires_at = effective_expires_at || raw_expires_at;

    return res.status(200).json({
      ok: true,
      key: lic.key,
      expires_at,
      effective_expires_at,
      instance_id: activation.id || null,
      license_key_id: activation.license_key_id || lic.id || null,
      customer_id: lic.customer_id || null,
      product_name: (activation.product && activation.product.name) || null
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
}
