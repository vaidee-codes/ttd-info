import { paymentProvider } from './_razorpay.mjs';

const EXTENSION_ID = /^[a-p]{32}$/;

// PayU's surl/furl: PayU POSTs the payment result here from its own page, and
// a static page cannot take a POST, so this only redirects the buyer (303, as a
// GET) back to our pages. Nothing is trusted from the posted fields: the success
// page confirms with /api/payment-confirm, which asks PayU's verify API.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ ok: false });
  if (paymentProvider() !== 'payu') return res.status(404).json({ ok: false });
  const url = new URL(req.url || '/', 'https://local');
  const plan = ['7d', '30d', '90d'].includes(url.searchParams.get('plan')) ? url.searchParams.get('plan') : '7d';
  const extensionId = url.searchParams.get('extension_id') || '';
  if (url.searchParams.get('result') === 'failed') {
    res.setHeader('Location', '/pass?payment=failed');
    return res.status(303).end();
  }
  const next = new URLSearchParams({ plan });
  if (EXTENSION_ID.test(extensionId)) next.set('extension_id', extensionId);
  res.setHeader('Location', '/pass/success?' + next);
  return res.status(303).end();
}
