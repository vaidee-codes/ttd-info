import { logProviderFailure } from './_dodo.mjs';
import { insertOne, selectOne } from './_ledger.mjs';
import { settleOrder } from './_payments.mjs';
import { verifyWebhookSignature } from './_razorpay.mjs';

const MAX_BODY_BYTES = 256 * 1024;
const FULFILLING_EVENTS = new Set(['payment.captured', 'order.paid', 'payment.authorized']);

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

// Razorpay webhook. The signature covers the exact raw bytes, so the body is
// read unparsed. Events are stored before acknowledging; a storage or
// fulfilment failure returns 5xx so Razorpay retries (up to 24 h).
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  let raw;
  try {
    raw = await rawBody(req);
  } catch (error) {
    return res.status(error.status || 400).json({ ok: false });
  }
  if (!raw.length || !verifyWebhookSignature(raw, header(req, 'x-razorpay-signature'))) {
    return res.status(400).json({ ok: false, error: 'invalid_signature' });
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }
  const eventId = header(req, 'x-razorpay-event-id') || `${event.event}:${event.created_at}:${event.payload && event.payload.payment && event.payload.payment.entity && event.payload.payment.entity.id}`;
  const payment = event.payload && event.payload.payment && event.payload.payment.entity || null;
  const orderId = payment && payment.order_id || event.payload && event.payload.order && event.payload.order.entity && event.payload.order.entity.id || null;

  try {
    await insertOne('payment_events', {
      event_id: eventId.slice(0, 120), event: String(event.event || 'unknown'),
      razorpay_order_id: orderId, razorpay_payment_id: payment && payment.id || null, payload: event
    }, { onConflict: 'event_id', ignoreDuplicates: true });

    // Refunds and disputes are recorded only: by owner decision they do not
    // change the licence.
    if (FULFILLING_EVENTS.has(event.event) && orderId) {
      const order = await selectOne('orders', { razorpay_order_id: orderId });
      if (order) await settleOrder(order, { paymentId: payment && payment.id || null });
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    logProviderFailure('razorpay_webhook', error);
    return res.status(503).json({ ok: false });
  }
}
