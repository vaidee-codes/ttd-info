import { timingSafeEqual } from 'node:crypto';
import { PLANS } from './_dodo.mjs';
import { featureEnabled } from './_http.mjs';
import { rpc, selectMany, selectOne, signedTag } from './_ledger.mjs';

// Opt-in "TTD quota release tomorrow" emails. The buyer ticks a box at
// checkout; the operator enters release dates on /ops; the cron job
// (api/release-reminders) queues one email per subscriber through the outbox.

const SUPPORT_EMAIL = 'ttdautofill@gmail.com';
// Releases are queued between 7 am and 9 pm IST, from 36 h before the release
// until 30 min before it, so a 10 am release is announced at 7 am the day before.
export const QUEUE_AHEAD_MS = 36 * 3600e3;
export const QUEUE_MIN_LEAD_MS = 30 * 60e3;
const QUEUE_HOURS_IST = [7, 21];

// Staging and prod share one ledger, so exactly one deployment may send
// reminders: the one with RELEASE_REMINDERS_ENABLED=true.
export function remindersEnabled() {
  return featureEnabled('RELEASE_REMINDERS_ENABLED');
}

export function reminderOptIn(body) {
  return !!(body && body.reminders === true);
}

// After a paid order is fulfilled: a ticked box subscribes the buyer, and any
// purchase by an existing subscriber moves their "covered until" date on, so
// someone holding a pass through the release is not reminded.
export async function noteReminderPurchase(order) {
  if (!order || !order.email || !PLANS[order.plan]) return;
  const from = Date.parse(order.fulfilled_at || order.paid_at || new Date().toISOString());
  await rpc('note_reminder_purchase', {
    p_email: order.email, p_opt_in: !!order.reminder_opt_in,
    p_covered_until: new Date(from + PLANS[order.plan].days * 86400e3).toISOString(), p_order_id: order.id
  });
}

function siteUrl() {
  const host = String(process.env.PUBLIC_SITE_HOST || process.env.VERCEL_PROJECT_PRODUCTION_URL || 'ttd-info.vercel.app').trim();
  return 'https://' + host.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

const emailParam = (email) => Buffer.from(String(email).toLowerCase(), 'utf8').toString('base64url');

export function unsubscribeToken(email) {
  return signedTag('reminder-unsubscribe', String(email).toLowerCase());
}

export function unsubscribeLinks(email) {
  const query = 'e=' + emailParam(email) + '&t=' + unsubscribeToken(email);
  return { page: siteUrl() + '/pass/unsubscribe?' + query, oneClick: siteUrl() + '/api/reminders-unsubscribe?' + query };
}

// Returns the lower-cased email for a valid (e, t) pair, else null.
export function readUnsubscribe(e, t) {
  let email;
  try {
    email = Buffer.from(String(e || ''), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!email || email.length > 254 || !email.includes('@')) return null;
  const expected = Buffer.from(unsubscribeToken(email));
  const given = Buffer.from(String(t || ''));
  return expected.length === given.length && timingSafeEqual(expected, given) ? email.toLowerCase() : null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function istDateTime(ts) {
  return new Date(ts).toLocaleString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true
  }) + ' IST';
}

export function reminderEmail({ release, email }) {
  const site = siteUrl();
  const when = istDateTime(release.release_at);
  const links = unsubscribeLinks(email);
  const subject = `TTD quota release: ${release.title} — ${when}`;
  const text = [
    `TTD releases ${release.title} on ${when}.`,
    '',
    'If you plan to book and your TTD Autofill pass has ended, get a new one before the release so autofill is ready when booking opens:',
    site + '/pass',
    '',
    'Pass still active on that day? You are all set — ignore this email.',
    '',
    'Release times come from TTD and can change. Check the official TTD site before you book.',
    '',
    'Thanks,',
    'TTD Autofill',
    '',
    `You get this because you asked for release reminders when you bought a pass. Unsubscribe: ${links.page}`
  ].join('\n');

  const e = escapeHtml;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-top:4px solid #7c3aed;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<tr><td style="padding:24px 24px 4px">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="vertical-align:middle"><img src="${site}/assets/logo-128.png" width="28" height="28" alt="" style="display:block;border-radius:6px"></td>
    <td style="vertical-align:middle;padding-left:10px;font-size:20px;font-weight:800">TTD Autofill</td></tr></table>
  <h1 style="font-size:22px;margin:22px 0 8px;font-weight:800">${e(release.title)}</h1>
  <p style="margin:0 0 16px;font-size:16px;color:#374151">TTD releases it on <b>${e(when)}</b>.</p>
</td></tr>
<tr><td style="padding:0 24px;font-size:14px;line-height:1.6;color:#374151">
  <p style="margin:0 0 16px">If you plan to book and your TTD Autofill pass has ended, get a new one before the release so autofill is ready when booking opens.</p>
  <a href="${site}/pass" style="display:inline-block;background:#5b21b6;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 18px;border-radius:8px">Get a pass</a>
  <p style="margin:16px 0 0">Pass still active on that day? You are all set — ignore this email.</p>
  <p style="margin:10px 0 0;color:#6b7280;font-size:13px">Release times come from TTD and can change. Check the official TTD site before you book.</p>
  <p style="margin:18px 0 0">Thanks,<br>TTD Autofill</p>
</td></tr>
<tr><td style="padding:20px 24px;border-top:1px solid #f3f4f6;font-size:11px;color:#9ca3af;text-align:center;line-height:1.6">You get this because you asked for release reminders when you bought a pass.
  <a href="${e(links.page)}" style="color:#6b7280">Unsubscribe</a><br>TTD Autofill · Bengaluru, India · Not affiliated with TTD · <a href="mailto:${SUPPORT_EMAIL}" style="color:#6b7280">${SUPPORT_EMAIL}</a></td></tr>
</table></td></tr></table></body></html>`;
  return {
    subject, text, html,
    headers: { 'List-Unsubscribe': `<${links.oneClick}>, <mailto:${SUPPORT_EMAIL}?subject=unsubscribe>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
  };
}

// The message for one queued reminder, or { skip } when it must not be sent:
// the release was cancelled or has passed, or the address unsubscribed.
export async function releaseReminderMessage(row, now = Date.now()) {
  const release = await selectOne('quota_releases', { id: row.release_id });
  if (!release) return { skip: 'release_missing' };
  if (release.cancelled_at) return { skip: 'release_cancelled' };
  if (Date.parse(release.release_at) <= now) return { skip: 'release_passed' };
  const subscriber = await selectOne('reminder_subscribers', { email: String(row.to_email).toLowerCase() });
  if (!subscriber || subscriber.unsubscribed_at) return { skip: 'unsubscribed' };
  return { message: reminderEmail({ release, email: row.to_email }) };
}

function istHour(now) {
  return Number(new Date(now).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }));
}

// Queues reminders for every release now inside the window (each one once).
export async function queueDueReleases(now = Date.now()) {
  const hour = istHour(now);
  if (hour < QUEUE_HOURS_IST[0] || hour >= QUEUE_HOURS_IST[1]) return { quiet: true, releases: 0, queued: 0 };
  const from = new Date(now + QUEUE_MIN_LEAD_MS).toISOString();
  const to = new Date(now + QUEUE_AHEAD_MS).toISOString();
  const due = await selectMany('quota_releases', {
    select: 'id,release_at', cancelled_at: 'is.null', reminders_queued_at: 'is.null',
    and: `(release_at.gt.${from},release_at.lte.${to})`, order: 'release_at.asc', limit: '10'
  });
  let queued = 0;
  for (const release of due) {
    const n = await rpc('queue_release_reminders', { p_release_id: release.id });
    queued += Number(n || 0);
    console.log(JSON.stringify({ event: 'release_reminders_queued', release_id: release.id, queued: n }));
  }
  return { quiet: false, releases: due.length, queued };
}
