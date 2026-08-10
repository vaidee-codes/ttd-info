import { cors, readBody } from './_dodo.mjs';

// POST /api/license-validate  { license_key } -> Dodo public validate result
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = readBody(req);
  const licenseKey = String(body.license_key || '').trim();
  if (!licenseKey) return res.status(400).json({ error: 'license_key required' });

  try {
    const r = await fetch('https://live.dodopayments.com/licenses/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: licenseKey }),
      signal: AbortSignal.timeout(8000)
    });
    const json = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : 502).json(json);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
