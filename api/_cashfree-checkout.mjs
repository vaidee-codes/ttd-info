import { createHash } from 'node:crypto';
import { logProviderFailure } from './_dodo.mjs';
import { boundedString, CANONICAL_ORIGIN, handleRequestError, sendError } from './_http.mjs';
import { insertOne, selectOne, sha256Hex, updateWhere } from './_ledger.mjs';
import { newPurchaseToken, normaliseEmail } from './_payments.mjs';
import { MAX_QUANTITY, priceFor } from './_pricing.mjs';
import { cashfreeConfig, createCashfreeOrder, getCashfreeOrder } from './_cashfree.mjs';

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
// Cashfree requires a customer phone number, but its docs allow dummy details
// when the merchant does not need them (we do not). The buyer may give one for
// Cashfree's own payment updates; it goes to Cashfree only and is never stored.
const PLACEHOLDER_PHONE = '9999999999';

// Optional Indian mobile: "+91 98765 43210" -> "9876543210"; empty -> null.
export function buyerPhone(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const digits = raw.replace(/[\s()-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(digits) ? digits : undefined;
}

function appOrigin() {
  const host = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim();
  return host ? 'https://' + host : CANONICAL_ORIGIN;
}

// Our own order id doubles as the Cashfree order id (letters, digits and "_"
// only, so it also passes the purchase-confirm id check).
export function cashfreeOrderId(order) {
  return 'ttd_' + String(order.id).replace(/-/g, '');
}

// POST /api/checkout { plan, request_id, email, quantity?, activate?, extension_id? } with PAYMENT_PROVIDER=cashfree.
// Creates (or re-uses, for the same request_id) a server-priced Cashfree order and
// returns its payment session for the Cashfree JS checkout. The order id is kept
// in the ledger's gateway-order column (razorpay_order_id) so reconcile, webhook
// and purchase-confirm work on one shape for every gateway.
export async function cashfreeCheckout(res, { plan, body, requestId, extensionId, siteOrigin }) {
  let email;
  try {
    email = normaliseEmail(boundedString(body.email, { field: 'email', max: 254, pattern: EMAIL }));
  } catch (error) {
    return handleRequestError(res, error);
  }
  const phone = buyerPhone(body.phone);
  if (phone === undefined) return sendError(res, 400, 'invalid_phone', 'Enter a 10-digit mobile number, or leave it empty.');
  const price = priceFor(plan, body.quantity == null ? 1 : Number(body.quantity));
  if (!price) return sendError(res, 400, 'invalid_quantity', `Choose between 1 and ${MAX_QUANTITY} passes.`);
  // A multi-pass key is shared across browsers: never auto-activate the buyer's one.
  if (price.quantity > 1) extensionId = '';

  try {
    const { live } = cashfreeConfig();
    await insertOne('orders', {
      request_id: requestId, plan: plan.code, amount_paise: price.total, quantity: price.quantity, discount_pct: price.discountPct, currency: 'INR', email,
      razorpay_mode: live ? 'live' : 'test',
      activate: !!extensionId, extension_id: extensionId || null
    }, { onConflict: 'request_id', ignoreDuplicates: true });
    let order = await selectOne('orders', { request_id: requestId });
    if (!order || order.plan !== plan.code || order.email !== email || Number(order.quantity || 1) !== price.quantity) {
      return sendError(res, 409, 'request_conflict', 'This checkout was already started with different details. Reload the page and try again.');
    }
    if (order.status !== 'created') {
      return sendError(res, 409, 'already_paid', 'This checkout is already paid. Your licence key is on the success page.');
    }

    // Re-opening checkout issues a new token; the previous one stays valid so a
    // first tab that completes payment can still show its key.
    const purchaseToken = newPurchaseToken();
    const tokenFields = { purchase_token_hash: sha256Hex(purchaseToken), purchase_token_hash_prev: order.purchase_token_hash || null };
    let tokenSaved = false;

    let sessionId;
    if (!order.razorpay_order_id) {
      const gatewayId = cashfreeOrderId(order);
      const origin = appOrigin();
      const created = await createCashfreeOrder({
        orderId: gatewayId,
        amountPaise: order.amount_paise,
        customerId: 'c_' + createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 24),
        email,
        phone: phone || PLACEHOLDER_PHONE,
        // The buyer returns to the site domain they started on; the webhook stays on the app origin.
        returnUrl: (siteOrigin || origin) + '/pass/success?plan=' + encodeURIComponent(plan.code) + (extensionId ? '&extension_id=' + encodeURIComponent(extensionId) : ''),
        notifyUrl: origin + '/api/cashfree-webhook',
        note: `TTD Autofill ${plan.code} pass` + (order.quantity > 1 ? ` x${order.quantity}` : '')
      });
      sessionId = created.payment_session_id;
      // One write for both the gateway order id and the token (one round trip less).
      const [updated] = await updateWhere('orders', { id: order.id, razorpay_order_id: null }, { razorpay_order_id: gatewayId, ...tokenFields });
      tokenSaved = !!updated;
      order = updated || await selectOne('orders', { id: order.id });
    } else {
      // Re-opened checkout for an order we already created: fetch its session again.
      sessionId = (await getCashfreeOrder(order.razorpay_order_id)).payment_session_id;
    }
    if (!sessionId) throw new Error('Cashfree returned no payment session');

    if (!tokenSaved) await updateWhere('orders', { id: order.id }, tokenFields);
    console.log(JSON.stringify({ event: 'checkout_created', provider: 'cashfree', plan: plan.code, auto_activate: !!extensionId }));
    return res.status(200).json({
      ok: true,
      provider: 'cashfree',
      mode: live ? 'production' : 'sandbox',
      payment_session_id: sessionId,
      order_id: order.razorpay_order_id,
      amount: order.amount_paise,
      currency: 'INR',
      plan: plan.code,
      quantity: price.quantity,
      discount_pct: price.discountPct,
      email,
      purchase_token: purchaseToken
    });
  } catch (error) {
    logProviderFailure('cashfree_checkout', error);
    return sendError(res, 503, 'checkout_unavailable', 'Secure checkout is temporarily unavailable.');
  }
}
