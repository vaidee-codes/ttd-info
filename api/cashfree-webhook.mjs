import { logProviderFailure } from './_dodo.mjs';
import { insertOne, selectOne } from './_ledger.mjs';
import { settleOrder } from './_payments.mjs';
import { paymentProvider } from './_razorpay.mjs';
import { verifyCashfreeWebhook } from './_cashfree.mjs';

const MAX_BODY_BYTES = 256 * 1024;
const FULFILLING_EVENTS = new Set(['PAYMENT_SUCCESS_WEBHOOK']);

async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function header(req, name) {
  const value = req.headers && req.headers[name];
  return Array.isArray(value) ? value[0] : String(value || '');
}

// Cashfree webhook. The signature covers the timestamp header plus the exact raw
// bytes, so the body is read unparsed. Events are stored before acknowledging; a
// storage or fulfilment failure returns 5xx so Cashfree retries.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (paymentProvider() !== 'cashfree') return res.status(404).json({ ok: false });

  let raw;
  try {
    raw = await rawBody(req);
  } catch (error) {
    return res.status(error.status || 400).json({ ok: false });
  }
  if (!raw.length || !verifyCashfreeWebhook(raw, header(req, 'x-webhook-timestamp'), header(req, 'x-webhook-signature'))) {
    return res.status(400).json({ ok: false, error: 'invalid_signature' });
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }
  const data = event && event.data || {};
  const payment = data.payment || null;
  const orderId = data.order && data.order.order_id || null;
  const paymentId = payment && payment.cf_payment_id != null ? String(payment.cf_payment_id) : null;
  const eventId = `cf:${event.type}:${orderId}:${paymentId || ''}:${event.event_time || ''}`.slice(0, 120);

  try {
    await insertOne('payment_events', {
      event_id: eventId, event: String(event.type || 'unknown'),
      razorpay_order_id: orderId, razorpay_payment_id: paymentId, payload: event
    }, { onConflict: 'event_id', ignoreDuplicates: true });

    // Refunds and disputes are recorded only: by owner decision they do not
    // change the licence. The webhook is only a trigger; settleOrder re-verifies
    // the payment with Cashfree's API before anything is fulfilled.
    if (FULFILLING_EVENTS.has(event.type) && orderId) {
      const order = await selectOne('orders', { razorpay_order_id: orderId });
      if (order) await settleOrder(order, { paymentId });
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    logProviderFailure('cashfree_webhook', error);
    return res.status(503).json({ ok: false });
  }
}
