import { dodo, resolveLicenseForEmail, cors } from './_dodo.mjs';

// GET /api/session?session_id=... -> { id, email, payment_status, paid, license, product_days }
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const sessionId = String(req.query.session_id || '').trim();
  if (!sessionId) return res.status(400).json({ error: 'session_id required' });

  try {
    const s = await dodo('/checkouts/' + encodeURIComponent(sessionId));
    const paid = s.payment_status === 'succeeded' || (s.payment_status && s.payment_status !== 'requires_payment_method' && s.payment_status !== 'abandoned' && s.payment_status !== 'cancelled');
    let license = null;
    if (paid && s.customer_email) {
      try { license = await resolveLicenseForEmail(s.customer_email); } catch { license = null; }
    }
    const productDays = s.metadata && s.metadata.product_days ? Number(s.metadata.product_days) : null;
    return res.status(200).json({
      id: s.id,
      email: s.customer_email || null,
      payment_status: s.payment_status || null,
      paid: !!paid,
      license,
      product: (s.metadata && s.metadata.product) || null,
      product_days: productDays,
      extension_id: (s.metadata && s.metadata.extension_id) || null
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
