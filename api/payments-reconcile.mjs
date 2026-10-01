import { logProviderFailure } from './_dodo.mjs';
import { selectMany, updateWhere } from './_ledger.mjs';
import { drainOutbox } from './_email.mjs';
import { settleOrder } from './_payments.mjs';
import { paymentProvider } from './_razorpay.mjs';

const BATCH = 25;

// Vercel Cron (every 5 min). Finishes orders that were paid but never fulfilled
// (closed tab plus a missed or failed webhook), without waiting for the customer.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret || req.headers.authorization !== 'Bearer ' + secret) return res.status(401).json({ ok: false });
  if (paymentProvider() !== 'razorpay') return res.status(200).json({ ok: true, skipped: 'razorpay_disabled' });

  const now = Date.now();
  const since = new Date(now - 48 * 3600e3).toISOString();
  const before = new Date(now - 2 * 60e3).toISOString();
  // Paid-but-unfulfilled orders first (always few), then unpaid checkouts in
  // round-robin order of when we last looked, so a pile of abandoned checkouts
  // can never starve a newer paid order whose webhook was missed.
  let orders;
  try {
    const window = `(created_at.gte.${since},created_at.lte.${before})`;
    const paid = await selectMany('orders', {
      select: '*', status: 'eq.paid', razorpay_order_id: 'not.is.null', order: 'paid_at.asc', limit: String(BATCH)
    });
    const unpaid = await selectMany('orders', {
      select: '*', status: 'eq.created', razorpay_order_id: 'not.is.null', and: window,
      order: 'reconcile_checked_at.asc.nullsfirst,created_at.desc', limit: String(BATCH)
    });
    orders = [...paid, ...unpaid];
  } catch (error) {
    logProviderFailure('payments_reconcile_list', error);
    return res.status(503).json({ ok: false });
  }

  const summary = { checked: orders.length, fulfilled: 0, unpaid: 0, failed: 0 };
  for (const order of orders) {
    try {
      if (order.status === 'created') {
        await updateWhere('orders', { id: order.id }, { reconcile_checked_at: new Date().toISOString() }).catch(() => []);
      }
      const result = await settleOrder(order);
      if (result.state === 'fulfilled') summary.fulfilled++;
      else summary.unpaid++;
    } catch (error) {
      summary.failed++;
      logProviderFailure('payments_reconcile', error);
    }
  }
  try {
    summary.email = await drainOutbox();
  } catch (error) {
    logProviderFailure('email_outbox_drain', error);
  }
  console.log(JSON.stringify({ event: 'payments_reconcile', ...summary }));
  const stuckPaid = orders.filter((o) => o.status === 'paid' && Date.parse(o.paid_at || o.created_at) < now - 2 * 60e3).length;
  if (stuckPaid) console.error(JSON.stringify({ event: 'alert_paid_unfulfilled', count: stuckPaid }));
  return res.status(200).json({ ok: true, ...summary });
}
