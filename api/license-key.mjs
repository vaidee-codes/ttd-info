import { dodo, cors, readBody, findLicenseKeyByValue, resolveLicenseForCustomer } from './_dodo.mjs';

// POST /api/license-key  { license_key } -> { valid, key, expires_at, status, ... }
// Returns the customer's EFFECTIVE (stacked) expiry, not the raw key expiry,
// so the extension countdown reflects all passes/support on the same email.
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = readBody(req);
  const licenseKey = String(body.license_key || '').trim();
  if (!licenseKey) return res.status(400).json({ error: 'license_key required' });

  try {
    const lic = await findLicenseKeyByValue(licenseKey);
    if (!lic) return res.status(404).json({ error: 'License key not found' });
    const expired = !!lic.expires_at && Date.parse(lic.expires_at) <= Date.now();
    const valid = lic.status === 'active' && !expired;

    // Which instances exist for this key? (Single-activation: if one already
    // exists and it isn't ours, the key can't be claimed on another browser.)
    let instanceIds = [];
    try {
      const inst = await dodo(`/license_key_instances?license_key_id=${encodeURIComponent(lic.id)}&page_size=10&page_number=0`);
      instanceIds = (inst.items || []).map((i) => i.id);
    } catch { /* instance lookup unavailable — leave empty */ }

    let effective = null;
    if (valid && lic.customer_id) {
      try {
        const resolved = await resolveLicenseForCustomer(lic.customer_id);
        if (resolved) effective = resolved.effective_expires_at;
      } catch { /* keep raw expiry */ }
    }

    return res.status(200).json({
      valid,
      key: lic.key,
      expires_at: effective || lic.expires_at || null,
      raw_expires_at: lic.expires_at || null,
      status: lic.status,
      customer_id: lic.customer_id || null,
      activations_used: lic.instances_count != null ? lic.instances_count : lic.activations_used,
      activations_limit: lic.activations_limit,
      instance_ids: instanceIds
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
