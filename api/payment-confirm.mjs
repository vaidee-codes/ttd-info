import { logProviderFailure } from './_dodo.mjs';
import { beginRequest, boundedString, handleRequestError, readJsonBody, sendError } from './_http.mjs';
import { selectOne } from './_ledger.mjs';
import { purchaseTokenMatches, settleOrder } from './_payments.mjs';
import { paymentProvider, verifyPaymentSignature } from './_razorpay.mjs';

const RZP_ID = /^[A-Za-z0-9_]{1,40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

// POST /api/payment-confirm { razorpay_order_id, purchase_token, razorpay_payment_id?, razorpay_signature? }
// Called by the pass page after Razorpay Checkout succeeds, and again to retry
// or re-show the key. Payment is always re-verified with Razorpay's API.
export default async function handler(req, res) {
  if (!beginRequest(req, res, ['POST'])) return;
  if (paymentProvider() !== 'razorpay') return sendError(res, 404, 'not_found', 'Not found.');

  let orderId;
  let paymentId = '';
  let signature = '';
  let token;
  try {
    const body = readJsonBody(req);
    orderId = boundedString(body.razorpay_order_id, { field: 'razorpay_order_id', max: 40, pattern: RZP_ID });
    token = boundedString(body.purchase_token, { field: 'purchase_token', max: 43, pattern: TOKEN });
    paymentId = boundedString(body.razorpay_payment_id, { field: 'razorpay_payment_id', max: 40, pattern: RZP_ID, required: false });
    signature = boundedString(body.razorpay_signature, { field: 'razorpay_signature', max: 64, pattern: HEX64, required: false });
  } catch (error) {
    return handleRequestError(res, error);
  }
  if (paymentId && !verifyPaymentSignature({ orderId, paymentId, signature })) {
    return sendError(res, 400, 'invalid_signature', 'The payment confirmation could not be verified.');
  }

  try {
    const order = await selectOne('orders', { razorpay_order_id: orderId });
    if (!order || !purchaseTokenMatches(order, token)) {
      return sendError(res, 403, 'not_authorised', 'This payment cannot be looked up from this page.');
    }
    const result = await settleOrder(order, { paymentId: paymentId || null });
    if (result.state !== 'fulfilled') {
      return res.status(202).json({ ok: false, pending: true, message: 'Waiting for the payment to be confirmed.' });
    }
    return res.status(200).json({
      ok: true,
      license_key: result.licenseKey,
      plan: order.plan,
      quantity: Number(order.quantity || 1),
      activate: !!order.activate,
      extension_id: order.extension_id || null
    });
  } catch (error) {
    logProviderFailure('payment_confirm', error);
    // Payment may already be captured: the reconcile job and webhook finish the
    // fulfilment, and the page can retry. Never report this as a failed payment.
    return res.status(202).json({ ok: false, pending: true, message: 'Payment received. Your key is being prepared; this page will retry.' });
  }
}
