import {
  assertDodoConfiguration,
  createCheckoutIdempotencyKey,
  dodo,
  logProviderFailure,
  WEEKLY_PLAN
} from './_dodo.mjs';
import {
  beginRequest,
  boundedString,
  CANONICAL_ORIGIN,
  featureEnabled,
  handleRequestError,
  readJsonBody,
  sendError
} from './_http.mjs';

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTENSION_ID = /^[a-p]{32}$/;

// POST /api/checkout { plan: '7d', request_id, activate?, extension_id? }
export default async function handler(req, res) {
  if (!beginRequest(req, res, ['POST'])) return;
  if (!featureEnabled('PASS_SALES_ENABLED')) {
    return sendError(res, 503, 'sales_disabled', 'Pass sales are temporarily unavailable.');
  }

  let body;
  try {
    body = readJsonBody(req);
    if (body.plan !== '7d') return sendError(res, 400, 'invalid_plan', 'Only the 7-day pass is available.');
  } catch (error) {
    return handleRequestError(res, error);
  }

  let requestId;
  let extensionId = '';
  try {
    requestId = boundedString(body.request_id, { field: 'request_id', max: 36, pattern: REQUEST_ID });
    const activate = body.activate !== false;
    if (activate) {
      extensionId = boundedString(body.extension_id, { field: 'extension_id', max: 32, pattern: EXTENSION_ID });
    }
  } catch (error) {
    return handleRequestError(res, error);
  }

  const returnUrl = CANONICAL_ORIGIN + '/pass/success' +
    (extensionId ? '?extension_id=' + encodeURIComponent(extensionId) + '&activate=1' : '');

  try {
    // Fail closed if the live provider drifts from INR 99, one-time, seven
    // days, automatic fulfilment, or one activation.
    await assertDodoConfiguration();
    const session = await dodo('/checkouts', {
      method: 'POST',
      headers: { 'Idempotency-Key': createCheckoutIdempotencyKey(requestId) },
      body: {
        product_cart: [{ product_id: WEEKLY_PLAN.product_id, quantity: 1 }],
        minimal_address: true,
        feature_flags: {
          allow_customer_editing_street: false,
          allow_customer_editing_city: false,
          allow_customer_editing_state: false,
          allow_customer_editing_country: false,
          allow_tax_id: false,
          allow_discount_code: false,
          allow_phone_number_collection: false
        },
        return_url: returnUrl,
        metadata: {
          plan: '7d',
          activate: extensionId ? 'true' : 'false',
          ...(extensionId ? { extension_id: extensionId } : {})
        }
      }
    });
    const checkoutUrl = String(session && session.checkout_url || '');
    const parsed = new URL(checkoutUrl);
    if (parsed.protocol !== 'https:' || !(parsed.hostname === 'dodopayments.com' || parsed.hostname.endsWith('.dodopayments.com'))) {
      throw new Error('Unexpected checkout URL');
    }
    return res.status(200).json({ ok: true, checkout_url: checkoutUrl });
  } catch (error) {
    logProviderFailure('checkout_create', error);
    return sendError(res, 503, 'checkout_unavailable', 'Secure checkout is temporarily unavailable.');
  }
}
