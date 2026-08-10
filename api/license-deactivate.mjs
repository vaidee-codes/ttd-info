import { cors, readBody, deactivateLicenseKey } from './_dodo.mjs';

// POST /api/license-deactivate  { license_key, instance_id } -> { ok }
// Frees this browser's activation slot (used by the "remove pass" testing
// helper so a key can be re-entered and re-activated for testing).
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = readBody(req);
  const licenseKey = String(body.license_key || '').trim();
  const instanceId = String(body.instance_id || '').trim();
  if (!licenseKey || !instanceId) return res.status(400).json({ ok: false, error: 'license_key and instance_id required' });

  try {
    await deactivateLicenseKey(licenseKey, instanceId);
    return res.status(200).json({ ok: true });
  } catch (e) {
    // Deactivation is best-effort (the key may already be expired/removed).
    return res.status(200).json({ ok: true, warned: e.message });
  }
}
