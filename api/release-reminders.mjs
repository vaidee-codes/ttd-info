import { logProviderFailure } from './_dodo.mjs';
import { ledgerConfigured, selectMany } from './_ledger.mjs';
import { deliverOutboxRow } from './_email.mjs';
import { queueDueReleases, remindersEnabled } from './_reminders.mjs';

const BATCH = 150;
const TIME_BUDGET_MS = 45e3;

// Vercel Cron (every 15 min). Queues the day-before reminders for each quota
// release entered on /ops, then sends queued reminders. Runs on every payment
// provider: prod on Dodo does not drain the outbox in payments-reconcile.
// Only the deployment with RELEASE_REMINDERS_ENABLED=true sends (shared ledger).
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret || req.headers.authorization !== 'Bearer ' + secret) return res.status(401).json({ ok: false });
  if (!ledgerConfigured()) return res.status(200).json({ ok: true, skipped: 'ledger_not_configured' });
  if (!remindersEnabled()) return res.status(200).json({ ok: true, skipped: 'reminders_disabled' });

  const started = Date.now();
  const summary = { releases: 0, queued: 0, sent: 0, skipped: 0 };
  try {
    Object.assign(summary, await queueDueReleases(started));
  } catch (error) {
    logProviderFailure('release_reminders_queue', error);
  }
  let rows = [];
  try {
    rows = await selectMany('email_outbox', {
      select: '*', kind: 'eq.release_reminder', status: 'eq.queued', next_attempt_at: 'lte.' + new Date().toISOString(),
      order: 'next_attempt_at.asc', limit: String(BATCH)
    });
  } catch (error) {
    logProviderFailure('release_reminders_list', error);
  }
  for (const row of rows) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    try {
      if (await deliverOutboxRow(row)) summary.sent++;
      else summary.skipped++;
    } catch (error) {
      summary.skipped++;
      logProviderFailure('release_reminder_send', error);
    }
  }
  console.log(JSON.stringify({ event: 'release_reminders', ...summary, due: rows.length }));
  return res.status(200).json({ ok: true, ...summary, due: rows.length });
}
