import { resolveLicenseForEmail, cors, readBody } from './_dodo.mjs';

// POST /api/license-lookup  { email } -> { found, license }
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }

  try {
    const license = await resolveLicenseForEmail(email);
    return res.status(200).json({ found: !!license, license });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
