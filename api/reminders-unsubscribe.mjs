import { logProviderFailure } from './_dodo.mjs';
import { beginRequest, sendError } from './_http.mjs';
import { updateWhere } from './_ledger.mjs';
import { readUnsubscribe } from './_reminders.mjs';

// POST /api/reminders-unsubscribe?e=<email, base64url>&t=<signed tag>
// Used by the /pass/unsubscribe page and by mail apps' one-click unsubscribe
// (RFC 8058: a form POST with no Origin). GET sends a browser to the page, so a
// link scanner that only fetches the URL never unsubscribes anyone.
export default async function handler(req, res) {
  if (!beginRequest(req, res, ['GET', 'POST'])) return;
  const params = new URL(req.url || '/', 'https://x').searchParams;
  if (req.method === 'GET') {
    res.setHeader('Location', '/pass/unsubscribe?' + new URLSearchParams({ e: params.get('e') || '', t: params.get('t') || '' }));
    return res.status(303).end();
  }
  const email = readUnsubscribe(params.get('e'), params.get('t'));
  if (!email) return sendError(res, 400, 'invalid_link', 'This unsubscribe link is not valid. Reply to any reminder email and we will remove you.');
  try {
    await updateWhere('reminder_subscribers', { email, unsubscribed_at: null }, { unsubscribed_at: new Date().toISOString() });
  } catch (error) {
    logProviderFailure('reminders_unsubscribe', error);
    return sendError(res, 503, 'unavailable', 'Could not unsubscribe right now. Try again in a minute.');
  }
  console.log(JSON.stringify({ event: 'reminders_unsubscribed' }));
  return res.status(200).json({ ok: true });
}
