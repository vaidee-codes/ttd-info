import { logProviderFailure } from './_dodo.mjs';
import { insertOne, selectMany, selectOne } from './_ledger.mjs';
import { settleOrder } from './_payments.mjs';
import { paymentProvider } from './_razorpay.mjs';
import { payuFormBody, verifyPayUResponse } from './_payu.mjs';
import { phonepeAttemptIds } from './_phonepe.mjs';

// PayU webhook (dashboard → Webhooks, payment success). PayU posts the same
// form fields as the surl, signed with the reverse hash. Events are stored before
// acknowledging; a storage or fulfilment failure returns 5xx so PayU retries.
// The webhook is only a trigger: settleOrder re-verifies with PayU's API first.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (paymentProvider() !== 'payu') return res.status(404).json({ ok: false });

  let fields;
  try {
    fields = await payuFormBody(req);
  } catch (error) {
    return res.status(error.status || 400).json({ ok: false, error: 'invalid_body' });
  }
  if (!verifyPayUResponse(fields)) {
    // Field names only (no values): enough to see how PayU's webhook differs from the surl post.
    console.log(JSON.stringify({ event: 'payu_webhook_rejected', type: String(req.headers['content-type'] || '').slice(0, 60), fields: Object.keys(fields || {}).slice(0, 80) }));
    return res.status(401).json({ ok: false, error: 'invalid_hash' });
  }

  const txnid = fields.txnid ? String(fields.txnid).slice(0, 40) : null;
  const status = String(fields.status || 'unknown').slice(0, 20);
  const eventId = `pu:${status}:${txnid}:${fields.mihpayid || ''}`.slice(0, 120);
  // Stored without the hash: it is a signature, not data we need.
  const { hash, ...payload } = fields;

  try {
    await insertOne('payment_events', {
      event_id: eventId, event: 'payu.' + status, razorpay_order_id: txnid,
      razorpay_payment_id: fields.mihpayid ? String(fields.mihpayid).slice(0, 40) : null, payload
    }, { onConflict: 'event_id', ignoreDuplicates: true });
    if (status === 'success' && txnid) {
      // The ledger keeps the newest attempt (pu_x_a2); a payment on an older one
      // (pu_x, pu_x_a1) is still this order.
      const base = phonepeAttemptIds(txnid).at(-1);
      const order = await selectOne('orders', { razorpay_order_id: txnid })
        || (await selectMany('orders', { select: '*', razorpay_order_id: 'like.' + base + '*', limit: '1' }))[0];
      if (order) await settleOrder(order);
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    logProviderFailure('payu_webhook', error);
    return res.status(503).json({ ok: false });
  }
}
