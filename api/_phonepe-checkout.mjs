import { logProviderFailure } from './_dodo.mjs';
import { boundedString, CANONICAL_ORIGIN, handleRequestError, sendError } from './_http.mjs';
import { insertOne, selectOne, sha256Hex, updateWhere } from './_ledger.mjs';
import { newPurchaseToken, normaliseEmail, settleOrder } from './_payments.mjs';
import { MAX_QUANTITY, priceFor } from './_pricing.mjs';
import { createPhonePeOrder, MAX_PHONEPE_ATTEMPTS, nextPhonePeOrderId, phonepeAttemptIds, phonepeConfig } from './_phonepe.mjs';

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// siteOriginFor() falls back to the production origin for any host it does not
// know, which would send a staging buyer to the production site. Only a known
// alternate site domain overrides the deployment's own origin.
function appOrigin(siteOrigin) {
  if (siteOrigin && siteOrigin !== CANONICAL_ORIGIN) return siteOrigin;
  const host = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim();
  return host ? 'https://' + host : CANONICAL_ORIGIN;
}

// Our own order id doubles as the PhonePe merchantOrderId (letters, digits and
// "_" only, so it also passes the purchase-confirm id check).
export function phonepeOrderId(order) {
  return 'ttd_' + String(order.id).replace(/-/g, '');
}

// POST /api/checkout { plan, request_id, email, quantity?, activate?, extension_id? } with PAYMENT_PROVIDER=phonepe.
// Creates (or re-uses, for the same request_id) a server-priced PhonePe order and
// returns its hosted checkout URL. The order id is kept in the ledger's
// gateway-order column (razorpay_order_id) so reconcile, webhook and
// purchase-confirm work on one shape for every gateway.
export async function phonepeCheckout(res, { plan, body, requestId, extensionId, siteOrigin }) {
  let email;
  try {
    email = normaliseEmail(boundedString(body.email, { field: 'email', max: 254, pattern: EMAIL }));
  } catch (error) {
    return handleRequestError(res, error);
  }
  const price = priceFor(plan, body.quantity == null ? 1 : Number(body.quantity));
  if (!price) return sendError(res, 400, 'invalid_quantity', `Choose between 1 and ${MAX_QUANTITY} passes.`);
  // A multi-pass key is shared across browsers: never auto-activate the buyer's one.
  if (price.quantity > 1) extensionId = '';

  try {
    const { live } = phonepeConfig();
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

    // PhonePe refuses a second create for the same merchantOrderId, so a
    // re-opened checkout gets a fresh gateway order id (see phonepeAttemptIds).
    if (order.razorpay_order_id) {
      if (phonepeAttemptIds(order.razorpay_order_id).length >= MAX_PHONEPE_ATTEMPTS) {
        return sendError(res, 429, 'too_many_attempts', 'Too many checkout attempts. Please wait a few minutes and try again.');
      }
      // The earlier attempt may have been paid in another tab: settle it instead of charging twice.
      const settled = await settleOrder(order);
      if (settled.state === 'fulfilled') return sendError(res, 409, 'already_paid', 'This checkout is already paid. Your licence key is on the success page.');
    }
    const gatewayId = order.razorpay_order_id ? nextPhonePeOrderId(order.razorpay_order_id) : phonepeOrderId(order);
    const created = await createPhonePeOrder({
      orderId: gatewayId,
      amountPaise: order.amount_paise,
      // The buyer returns to the site domain they started on.
      returnUrl: appOrigin(siteOrigin) + '/pass/success?plan=' + encodeURIComponent(plan.code) + (extensionId ? '&extension_id=' + encodeURIComponent(extensionId) : ''),
      note: `TTD Autofill ${plan.code} pass` + (order.quantity > 1 ? ` x${order.quantity}` : '')
    });
    const redirectUrl = String(created && created.redirectUrl || '');
    const parsed = new URL(redirectUrl);
    if (parsed.protocol !== 'https:' || !/(^|\.)phonepe\.com$/.test(parsed.hostname)) throw new Error('Unexpected PhonePe checkout URL');
    await updateWhere('orders', { id: order.id }, { razorpay_order_id: gatewayId, ...tokenFields });
    console.log(JSON.stringify({ event: 'checkout_created', provider: 'phonepe', plan: plan.code, auto_activate: !!extensionId }));
    return res.status(200).json({
      ok: true,
      provider: 'phonepe',
      mode: live ? 'production' : 'sandbox',
      redirect_url: redirectUrl,
      order_id: gatewayId,
      amount: order.amount_paise,
      currency: 'INR',
      plan: plan.code,
      quantity: price.quantity,
      discount_pct: price.discountPct,
      email,
      purchase_token: purchaseToken
    });
  } catch (error) {
    logProviderFailure('phonepe_checkout', error);
    return sendError(res, 503, 'checkout_unavailable', 'Secure checkout is temporarily unavailable.');
  }
}
