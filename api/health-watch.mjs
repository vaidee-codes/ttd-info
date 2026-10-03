import { noKeepAlive } from './_keygen.mjs';
import { sendEmail } from './_email.mjs';
import { insertOne, selectMany, selectOne, updateWhere } from './_ledger.mjs';

const REMIND_EVERY_MS = 6 * 3600e3;
// A check must fail twice, this far apart, before it counts: one dropped
// request (a Supabase or network blip) should not page anyone.
const RECHECK_DELAY_MS = Number(process.env.HEALTH_RECHECK_MS ?? 2000);

// Alert emails show India time, e.g. "1 Oct 2026, 7:30:15 pm IST".
export function ist(ts) {
  return new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }) + ' IST';
}

async function runOnce(name, check) {
  try {
    return await check();
  } catch (error) {
    const code = String(error && (error.code || error.status || error.name) || 'error').slice(0, 60);
    console.error(JSON.stringify({ event: 'health_check_error', check: name, code }));
    return { ok: false, detail: `The check itself failed (${code}); the ledger or a provider did not answer.` };
  }
}

export async function runCheck(name, check) {
  const first = await runOnce(name, check);
  if (!first || first.ok) return first;
  await new Promise((r) => setTimeout(r, RECHECK_DELAY_MS));
  const second = await runOnce(name, check);
  if (second && second.ok) console.log(JSON.stringify({ event: 'health_check_flap', check: name, first: first.detail }));
  return second;
}
const BACKUP_MAX_AGE_MS = 26 * 3600e3;

async function checkKeygen() {
  const base = String(process.env.KEYGEN_API_URL || '').trim().replace(/\/$/, '');
  if (!base) return null;
  try {
    const r = await fetch(base + '/v1/health', { dispatcher: noKeepAlive, signal: AbortSignal.timeout(10000) });
    return r.ok ? { ok: true } : { ok: false, detail: `Keygen health returned HTTP ${r.status}` };
  } catch {
    return { ok: false, detail: 'Keygen did not answer within 10 s' };
  }
}

// Touches the Keygen database (a lookup of a key that does not exist), which also
// keeps the Supabase `keygen` project from pausing after 7 idle days.
async function checkKeygenDatabase() {
  const base = String(process.env.KEYGEN_API_URL || '').trim().replace(/\/$/, '');
  const account = String(process.env.KEYGEN_ACCOUNT_ID || '').trim();
  if (!base || !account) return null;
  try {
    const r = await fetch(`${base}/v1/accounts/${account}/licenses/actions/validate-key`, {
      method: 'POST', dispatcher: noKeepAlive, signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/vnd.api+json', Accept: 'application/vnd.api+json', 'Keygen-Version': '1.8' },
      body: JSON.stringify({ meta: { key: 'HEALTH-CHECK-NOT-A-KEY' } })
    });
    const json = await r.json().catch(() => null);
    return r.ok && json && json.meta && json.meta.code === 'NOT_FOUND'
      ? { ok: true }
      : { ok: false, detail: `Keygen could not query its database (HTTP ${r.status}). If Supabase paused the "keygen" project: Supabase Dashboard → keygen → Restore.` };
  } catch {
    return { ok: false, detail: 'Keygen database check timed out. If Supabase paused the "keygen" project: Supabase Dashboard → keygen → Restore.' };
  }
}

async function checkBackup() {
  const [last] = await selectMany('backup_runs', { select: 'at,ok', ok: 'eq.true', order: 'at.desc', limit: '1' });
  if (!last) return { ok: false, detail: 'No successful database backup has been recorded' };
  const age = Date.now() - Date.parse(last.at);
  return age <= BACKUP_MAX_AGE_MS ? { ok: true } : { ok: false, detail: `Last successful backup was ${Math.round(age / 3600e3)} h ago` };
}

async function checkPaidUnfulfilled() {
  const before = new Date(Date.now() - 2 * 60e3).toISOString();
  const rows = await selectMany('orders', { select: 'id', status: 'eq.paid', paid_at: 'lt.' + before, limit: '50' });
  return rows.length ? { ok: false, detail: `${rows.length} paid order(s) have no licence after 2 minutes` } : { ok: true };
}

// Emails still waiting after 6 h: every provider is refusing or out of its
// daily limit. They keep retrying for 7 days; this is the early warning.
async function checkEmailBacklog() {
  const before = new Date(Date.now() - 6 * 3600e3).toISOString();
  const rows = await selectMany('email_outbox', { select: 'id', status: 'eq.queued', created_at: 'lt.' + before, limit: '200' });
  return rows.length
    ? { ok: false, detail: `${rows.length} licence email(s) have been waiting over 6 h. They keep retrying for 7 days; check provider limits (SES / Resend / Brevo).` }
    : { ok: true };
}

// SES is the sender; Resend/Brevo are only for when SES refuses. Any email
// that went out through a backup in the last 24 h means SES needs a look
// (sending paused, quota, reputation).
async function checkEmailOnSes() {
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const rows = await selectMany('email_outbox', { select: 'provider', status: 'eq.sent', sent_at: 'gte.' + since, provider: 'neq.ses', limit: '200' });
  if (!rows.length) return { ok: true };
  const by = rows.reduce((m, r) => ((m[r.provider || 'unknown'] = (m[r.provider || 'unknown'] || 0) + 1), m), {});
  return { ok: false, detail: `${rows.length} email(s) in the last 24 h went out through a backup provider (${Object.entries(by).map(([k, v]) => k + ': ' + v).join(', ')}), so SES refused them. Check SES in the AWS console (account status, sending quota, bounces).` };
}

async function checkEmailFailures() {
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const rows = await selectMany('email_outbox', { select: 'id', status: 'eq.failed', created_at: 'gte.' + since, limit: '50' });
  return rows.length ? { ok: false, detail: `${rows.length} licence email(s) failed in the last 24 h` } : { ok: true };
}

// Optional self-heal for a paused free-plan Supabase project. Needs a Supabase
// personal access token (SUPABASE_ACCESS_TOKEN) and the project refs to watch
// (SUPABASE_PROJECT_REFS, comma-separated). Without them we only alert.
export async function restorePausedSupabase() {
  const token = String(process.env.SUPABASE_ACCESS_TOKEN || '').trim();
  const refs = String(process.env.SUPABASE_PROJECT_REFS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!token || !refs.length) return [];
  const actions = [];
  for (const ref of refs) {
    try {
      const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
      const r = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}`, { headers, signal: AbortSignal.timeout(10000) });
      const project = r.ok ? await r.json() : null;
      const status = project && project.status;
      if (status === 'INACTIVE' || status === 'PAUSED') {
        const restore = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/restore`, { method: 'POST', headers, signal: AbortSignal.timeout(10000) });
        actions.push(`${ref}: was ${status}, restore ${restore.ok ? 'requested' : 'FAILED (HTTP ' + restore.status + ')'}`);
      } else if (status && status !== 'ACTIVE_HEALTHY') {
        actions.push(`${ref}: ${status}`);
      }
    } catch {
      actions.push(`${ref}: status check failed`);
    }
  }
  return actions;
}

const CHECKS = { keygen: checkKeygen, keygen_db: checkKeygenDatabase, backup: checkBackup, paid_unfulfilled: checkPaidUnfulfilled, email_failures: checkEmailFailures, email_backlog: checkEmailBacklog, email_on_ses: checkEmailOnSes };

async function notify(subject, lines, idempotencyKey) {
  const to = String(process.env.ALERT_EMAIL || '').trim();
  if (!to) return false;
  const text = lines.join('\n') + '\n\n— TTD Autofill monitoring';
  const result = await sendEmail({ to, subject, text, html: '<pre style="font:14px/1.5 ui-monospace,Menlo,monospace">' + text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) + '</pre>',
    idempotencyKey: idempotencyKey || 'alert/' + subject + '/' + new Date().toISOString().slice(0, 16) });
  return result.ok;
}

// Vercel Cron (every 5 min). Emails ALERT_EMAIL when a check starts failing,
// reminds every 6 h while it keeps failing, and says when it recovers.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret || req.headers.authorization !== 'Bearer ' + secret) return res.status(401).json({ ok: false });

  const now = new Date();
  // The ledger holds alert state, so if it is unreachable (e.g. Supabase paused
  // the project) alert directly, at most once an hour.
  try {
    await selectMany('alert_state', { select: 'check_name', limit: '1' });
  } catch {
    const healed = await restorePausedSupabase();
    await notify('[TTD Autofill] ALERT: ledger database unreachable', [
      'The ttd-ledger database did not answer. Payments cannot be recorded and licences for new purchases cannot be issued.',
      'Activated browsers keep working for up to 72 h (outage access).',
      healed.length ? 'Supabase: ' + healed.join('; ') : 'If Supabase paused the project: Supabase Dashboard → ttd-ledger → Restore project.'
    ], 'alert/ledger/' + now.toISOString().slice(0, 13));
    return res.status(200).json({ ok: false, alerts: ['ledger'] });
  }
  const results = {};
  await Promise.all(Object.entries(CHECKS).map(async ([name, check]) => { results[name] = await runCheck(name, check); }));

  if (results.keygen_db && !results.keygen_db.ok) {
    const healed = await restorePausedSupabase();
    if (healed.length) results.keygen_db.detail += ' Supabase: ' + healed.join('; ');
  }

  const alerts = [];
  for (const [name, result] of Object.entries(results)) {
    if (!result) continue;
    try {
      await insertOne('alert_state', { check_name: name }, { onConflict: 'check_name', ignoreDuplicates: true });
      const state = await selectOne('alert_state', { check_name: name });
      if (!result.ok) {
        const remind = !state.failing || !state.last_sent_at || now - Date.parse(state.last_sent_at) > REMIND_EVERY_MS;
        let sent = false;
        if (remind) sent = await notify(`[TTD Autofill] ALERT: ${name.replace(/_/g, ' ')}`, [result.detail, '', `Failing since ${ist(state.failing ? state.since : now)}.`]);
        await updateWhere('alert_state', { check_name: name }, {
          failing: true, since: state.failing ? state.since : now.toISOString(), detail: result.detail,
          ...(sent ? { last_sent_at: now.toISOString() } : {}), updated_at: now.toISOString()
        });
        alerts.push(name);
      } else if (state.failing) {
        await notify(`[TTD Autofill] RECOVERED: ${name.replace(/_/g, ' ')}`, [`Recovered at ${ist(now)}.`, `Was failing since ${ist(state.since)}: ${state.detail}`]);
        await updateWhere('alert_state', { check_name: name }, { failing: false, since: null, detail: null, updated_at: now.toISOString() });
      }
    } catch {
      alerts.push(name + ':state_error');
    }
  }
  console.log(JSON.stringify({ event: 'health_watch', alerts, checks: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v ? v.ok : 'skipped'])) }));
  return res.status(200).json({ ok: true, alerts });
}
