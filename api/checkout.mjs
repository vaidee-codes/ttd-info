import { dodo, cors, readBody, getPassPlan } from './_dodo.mjs';

// POST /api/checkout  { email?, pincode?, product?, activate, extension_id? }
//   -> { checkout_url, session_id }
// Creates a Dodo checkout for the chosen pass (7/30/90 days). The Dodo hosted
// page is configured to ask for as little as possible (minimal_address: only a
// zipcode is required; street/city/state/country editing are hidden).
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = readBody(req);
  const email = String(body.email || '').trim();
  const pincode = String(body.pincode || '').trim().replace(/[^\d]/g, '').slice(0, 10);
  const plan = getPassPlan(body.product);
  const activate = body.activate !== false && body.activate !== 'false';
  const extensionId = activate ? String(body.extension_id || '').trim().slice(0, 64) : '';
  const origin = 'https://' + (req.headers.host || 'ttdautofill.com');
  // Carry the extension id through the Dodo redirect so /pass/success can
  // auto-activate this browser (Dodo appends its params to this URL).
  const returnUrl = origin + '/pass/success' + (extensionId ? '?extension_id=' + encodeURIComponent(extensionId) + '&activate=1' : '');

  try {
    const session = await dodo('/checkouts', {
      method: 'POST',
      body: {
        product_cart: [{ product_id: plan.product_id, quantity: 1 }],
        ...(email ? { customer: { email } } : {}),
        ...(pincode ? { billing_address: { country: 'IN', zipcode: pincode } } : {}),
        minimal_address: true,
        feature_flags: {
          allow_customer_editing_street: false,
          allow_customer_editing_city: false,
          allow_customer_editing_state: false,
          allow_customer_editing_country: false,
          allow_tax_id: false,
          // Offer/discount codes enabled for now (end-to-end testing with a
          // 100%-off code). Disable before launch.
          allow_discount_code: true,
          allow_phone_number_collection: false
        },
        return_url: returnUrl,
        metadata: {
          activate: activate ? 'true' : 'false',
          product: plan.label,
          product_days: String(plan.days),
          ...(extensionId ? { extension_id: extensionId } : {})
        }
      }
    });
    return res.status(200).json({ checkout_url: session.checkout_url, session_id: session.session_id });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
