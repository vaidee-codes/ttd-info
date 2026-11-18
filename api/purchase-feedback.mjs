import { logProviderFailure } from './_dodo.mjs';
import { beginRequest, boundedString, handleRequestError, readJsonBody, RequestError, sendError } from './_http.mjs';
import { insertOne, selectOne } from './_ledger.mjs';
import { purchaseTokenMatches } from './_payments.mjs';

const ORDER_ID = /^[A-Za-z0-9_]{1,40}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const HEARD_FROM = ['chrome_web_store', 'youtube', 'whatsapp', 'telegram', 'instagram', 'facebook', 'google', 'friend', 'other'];

// Free text from the page: drop control characters and squeeze whitespace.
function freeText(value, field, max) {
  const clean = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length > max) throw new RequestError(400, 'invalid_request', `${field} is too long.`);
  return clean;
}

// POST /api/purchase-feedback { razorpay_order_id, purchase_token, other_temple?, heard_from?, heard_from_detail? }
// The two optional questions on the success page. Only the browser that paid
// (it holds the purchase token) can answer, once the order is paid; answering
// again replaces the earlier answer.
export default async function handler(req, res) {
  if (!beginRequest(req, res, ['POST'])) return;

  let orderId;
  let token;
  let answer;
  try {
    const body = readJsonBody(req);
    orderId = boundedString(body.razorpay_order_id, { field: 'razorpay_order_id', max: 40, pattern: ORDER_ID });
    token = boundedString(body.purchase_token, { field: 'purchase_token', max: 43, pattern: TOKEN });
    const heardFrom = String(body.heard_from || '').trim();
    if (heardFrom && !HEARD_FROM.includes(heardFrom)) throw new RequestError(400, 'invalid_request', 'heard_from is invalid.');
    answer = {
      other_temple: freeText(body.other_temple, 'other_temple', 300) || null,
      heard_from: heardFrom || null,
      heard_from_detail: freeText(body.heard_from_detail, 'heard_from_detail', 200) || null
    };
    if (!answer.other_temple && !answer.heard_from) throw new RequestError(400, 'empty_feedback', 'Answer at least one question.');
    if (answer.heard_from !== 'other' && answer.heard_from !== 'friend') answer.heard_from_detail = null;
  } catch (error) {
    return handleRequestError(res, error);
  }

  try {
    const order = await selectOne('orders', { razorpay_order_id: orderId }, 'id,status,purchase_token_hash,purchase_token_hash_prev');
    if (!order || !purchaseTokenMatches(order, token)) {
      return sendError(res, 403, 'not_authorised', 'This purchase cannot be found from this page.');
    }
    if (order.status !== 'paid' && order.status !== 'fulfilled') {
      return sendError(res, 409, 'not_paid', 'Feedback opens once the payment is confirmed.');
    }
    await insertOne('purchase_feedback', { order_id: order.id, ...answer, updated_at: new Date().toISOString() },
      { onConflict: 'order_id', mergeDuplicates: true });
    return res.status(200).json({ ok: true });
  } catch (error) {
    logProviderFailure('purchase_feedback', error);
    return sendError(res, 503, 'unavailable', 'Could not save your answer just now. Please try again.');
  }
}
