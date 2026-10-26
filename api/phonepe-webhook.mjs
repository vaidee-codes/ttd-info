import { logProviderFailure } from './_dodo.mjs';
import { insertOne, selectOne } from './_ledger.mjs';
import { settleOrder } from './_payments.mjs';
import { paymentProvider } from './_razorpay.mjs';
import { verifyPhonePeWebhook } from './_phonepe.mjs';

const MAX_BODY_BYTES = 256 * 1024;
const FULFILLING_EVENTS = new Set(['checkout.order.completed']);

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

// PhonePe webhook. Events are stored before acknowledging; a storage or
// fulfilment failure returns 5xx so PhonePe retries. The webhook is only a
// trigger: settleOrder re-verifies the payment with PhonePe's API first.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (paymentProvider() !== 'phonepe') return res.status(404).json({ ok: false });
  if (!verifyPhonePeWebhook(header(req, 'authorization'))) return res.status(401).json({ ok: false, error: 'invalid_auth' });

  let event;
  try {
    const raw = await rawBody(req);
    event = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    return res.status(error.status || 400).json({ ok: false, error: 'invalid_body' });
  }
  const payload = event && event.payload || {};
  const orderId = payload.merchantOrderId ? String(payload.merchantOrderId) : null;
  const eventName = String(event && (event.event || event.type) || 'unknown');
  const eventId = `pp:${eventName}:${orderId}:${payload.state || ''}:${payload.expireAt || ''}`.slice(0, 120);

  try {
    await insertOne('payment_events', {
      event_id: eventId, event: eventName, razorpay_order_id: orderId,
      razorpay_payment_id: payload.orderId ? String(payload.orderId) : null, payload: event
    }, { onConflict: 'event_id', ignoreDuplicates: true });
    if (FULFILLING_EVENTS.has(eventName) && orderId) {
      const order = await selectOne('orders', { razorpay_order_id: orderId });
      if (order) await settleOrder(order);
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    logProviderFailure('phonepe_webhook', error);
    return res.status(503).json({ ok: false });
  }
}
