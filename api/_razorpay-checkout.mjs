import { logProviderFailure } from './_dodo.mjs';
import { boundedString, handleRequestError, sendError } from './_http.mjs';
import { insertOne, selectOne, sha256Hex, updateWhere } from './_ledger.mjs';
import { newPurchaseToken, normaliseEmail } from './_payments.mjs';
import { MAX_QUANTITY, priceFor } from './_pricing.mjs';
import { createOrder, razorpayConfig } from './_razorpay.mjs';

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// POST /api/checkout { plan, request_id, email, quantity?, activate?, extension_id? } with PAYMENT_PROVIDER=razorpay.
// Creates (or re-uses, for the same request_id) a server-priced Razorpay order.
// The buyer's email is collected by Razorpay Checkout (account setting) and read
// from the verified payment. An email sent here (older page) is still validated and used.
export async function razorpayCheckout(res, { plan, body, requestId, extensionId }) {
  let email;
  try {
    const given = boundedString(body.email, { field: 'email', max: 254, pattern: EMAIL, required: false });
    email = given ? normaliseEmail(given) : null;
  } catch (error) {
    return handleRequestError(res, error);
  }
  const price = priceFor(plan, body.quantity == null ? 1 : Number(body.quantity));
  if (!price) return sendError(res, 400, 'invalid_quantity', `Choose between 1 and ${MAX_QUANTITY} passes.`);
  // A multi-pass key is shared across browsers: never auto-activate the buyer's one.
  if (price.quantity > 1) extensionId = '';

  try {
    const { keyId, live } = razorpayConfig();
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
    if (!order.razorpay_order_id) {
      const created = await createOrder({ amountPaise: order.amount_paise, receipt: order.id, notes: { order_id: order.id, plan: order.plan, quantity: String(order.quantity || 1) } });
      const [updated] = await updateWhere('orders', { id: order.id, razorpay_order_id: null }, { razorpay_order_id: created.id });
      order = updated || await selectOne('orders', { id: order.id });
    }
    // Re-opening checkout issues a new token; the previous one stays valid so a
    // first tab that completes payment can still show its key.
    const purchaseToken = newPurchaseToken();
    await updateWhere('orders', { id: order.id }, { purchase_token_hash: sha256Hex(purchaseToken), purchase_token_hash_prev: order.purchase_token_hash || null });
    console.log(JSON.stringify({ event: 'checkout_created', provider: 'razorpay', plan: plan.code, auto_activate: !!extensionId }));
    return res.status(200).json({
      ok: true,
      provider: 'razorpay',
      key_id: keyId,
      razorpay_order_id: order.razorpay_order_id,
      amount: order.amount_paise,
      currency: 'INR',
      plan: plan.code,
      quantity: price.quantity,
      discount_pct: price.discountPct,
      email,
      purchase_token: purchaseToken
    });
  } catch (error) {
    logProviderFailure('razorpay_checkout', error);
    return sendError(res, 503, 'checkout_unavailable', 'Secure checkout is temporarily unavailable.');
  }
}
