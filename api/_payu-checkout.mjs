import { buyerPhone } from './_cashfree-checkout.mjs';
import { logProviderFailure } from './_dodo.mjs';
import { boundedString, CANONICAL_ORIGIN, handleRequestError, sendError } from './_http.mjs';
import { insertOne, selectOne, sha256Hex, updateWhere } from './_ledger.mjs';
import { newPurchaseToken, normaliseEmail, settleOrder } from './_payments.mjs';
import { MAX_QUANTITY, priceFor } from './_pricing.mjs';
import { MAX_PHONEPE_ATTEMPTS, nextPhonePeOrderId, phonepeAttemptIds } from './_phonepe.mjs';
import { payuCheckoutForm, payuConfig } from './_payu.mjs';
import { reminderOptIn } from './_reminders.mjs';

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
// PayU requires a phone number; as with Cashfree, the buyer's optional mobile
// goes to PayU only and is never stored.
const PLACEHOLDER_PHONE = '9999999999';

// See _phonepe-checkout.mjs: only a known alternate site domain overrides the
// deployment's own origin, so a staging buyer never lands on production.
function appOrigin(siteOrigin) {
  if (siteOrigin && siteOrigin !== CANONICAL_ORIGIN) return siteOrigin;
  const host = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim();
  return host ? 'https://' + host : CANONICAL_ORIGIN;
}

// PayU's txnid is at most 25 characters and must be new for every attempt, so
// re-opened checkouts reuse PhonePe's _a1.._a5 scheme: "pu_" + 18 hex of our
// order id + "_aN" is 24. The "pu_" prefix keeps reconcile to PayU's own orders.
export function payuOrderId(order) {
  return 'pu_' + String(order.id).replace(/-/g, '').slice(0, 18);
}

// POST /api/checkout { plan, request_id, email, phone?, quantity?, activate?, extension_id? } with PAYMENT_PROVIDER=payu.
// Creates (or re-uses, for the same request_id) a server-priced order and returns
// the signed form the pass page posts to PayU's hosted checkout. The txnid is
// kept in the ledger's gateway-order column (razorpay_order_id) so reconcile,
// webhook and purchase-confirm work on one shape for every gateway.
export async function payuCheckout(res, { plan, body, requestId, extensionId, siteOrigin }) {
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
    const { live } = payuConfig();
    await insertOne('orders', {
      request_id: requestId, plan: plan.code, amount_paise: price.total, quantity: price.quantity, discount_pct: price.discountPct, currency: 'INR', email,
      razorpay_mode: live ? 'live' : 'test',
      activate: !!extensionId, extension_id: extensionId || null, reminder_opt_in: reminderOptIn(body)
    }, { onConflict: 'request_id', ignoreDuplicates: true });
    const order = await selectOne('orders', { request_id: requestId });
    if (!order || order.plan !== plan.code || order.email !== email || Number(order.quantity || 1) !== price.quantity) {
      return sendError(res, 409, 'request_conflict', 'This checkout was already started with different details. Reload the page and try again.');
    }
    // The reminder box may have been changed before checkout was re-opened.
    if (order.status === 'created' && !!order.reminder_opt_in !== reminderOptIn(body)) {
      await updateWhere('orders', { id: order.id, status: 'created' }, { reminder_opt_in: reminderOptIn(body) });
    }
    // A tab can carry a checkout begun under another gateway (the site switched
    // gateways meanwhile): that order is not ours to re-open; start a fresh one.
    if (order.status === 'created' && order.razorpay_order_id && !order.razorpay_order_id.startsWith('pu_')) {
      return sendError(res, 409, 'request_conflict', 'This checkout was started earlier with another payment method. Reload the page and try again.');
    }
    if (order.status !== 'created') {
      return sendError(res, 409, 'already_paid', 'This checkout is already paid. Your licence key is on the success page.');
    }

    // Re-opening checkout issues a new token; the previous one stays valid so a
    // first tab that completes payment can still show its key.
    const purchaseToken = newPurchaseToken();
    const tokenFields = { purchase_token_hash: sha256Hex(purchaseToken), purchase_token_hash_prev: order.purchase_token_hash || null };

    if (order.razorpay_order_id) {
      if (phonepeAttemptIds(order.razorpay_order_id).length >= MAX_PHONEPE_ATTEMPTS) {
        return sendError(res, 429, 'too_many_attempts', 'Too many checkout attempts. Please wait a few minutes and try again.');
      }
      // The earlier attempt may have been paid in another tab: settle it instead of charging twice.
      const settled = await settleOrder(order);
      if (settled.state === 'fulfilled') return sendError(res, 409, 'already_paid', 'This checkout is already paid. Your licence key is on the success page.');
    }
    const txnid = order.razorpay_order_id ? nextPhonePeOrderId(order.razorpay_order_id) : payuOrderId(order);
    // PayU posts the buyer back to these; /api/payu-return turns the POST into a
    // redirect to the site domain they started on.
    const back = new URLSearchParams({ plan: plan.code });
    if (extensionId) back.set('extension_id', extensionId);
    const returnBase = appOrigin(siteOrigin) + '/api/payu-return?';
    const form = payuCheckoutForm({
      txnid,
      amountPaise: order.amount_paise,
      productinfo: `TTD Autofill ${plan.code} pass` + (order.quantity > 1 ? ` x${order.quantity}` : ''),
      email,
      phone: phone || PLACEHOLDER_PHONE,
      surl: returnBase + back + '&result=ok',
      furl: returnBase + back + '&result=failed'
    });
    await updateWhere('orders', { id: order.id }, { razorpay_order_id: txnid, ...tokenFields });
    console.log(JSON.stringify({ event: 'checkout_created', provider: 'payu', plan: plan.code, auto_activate: !!extensionId }));
    return res.status(200).json({
      ok: true,
      provider: 'payu',
      mode: live ? 'production' : 'test',
      action: form.action,
      bolt: form.bolt,
      fields: form.fields,
      order_id: txnid,
      amount: order.amount_paise,
      currency: 'INR',
      plan: plan.code,
      quantity: price.quantity,
      discount_pct: price.discountPct,
      email,
      purchase_token: purchaseToken
    });
  } catch (error) {
    logProviderFailure('payu_checkout', error);
    return sendError(res, 503, 'checkout_unavailable', 'Secure checkout is temporarily unavailable.');
  }
}
