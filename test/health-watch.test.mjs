import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TTD_LEDGER_URL = 'https://ledger.test';
process.env.TTD_LEDGER_SECRET_KEY = 'ledger-secret';
process.env.KEYGEN_API_URL = 'https://keygen.test';
process.env.KEYGEN_ACCOUNT_ID = 'acct-1';
process.env.CRON_SECRET = 'cron-secret';
process.env.HEALTH_RECHECK_MS = '0';
process.env.RESEND_API_KEY = 're_test';
process.env.RESEND_FROM = 'TTD Autofill <alerts@example.com>';
process.env.ALERT_EMAIL = 'owner@example.com';

const watch = (await import('../api/health-watch.mjs')).default;

function world(t) {
  const w = { tables: { backup_runs: [{ at: new Date().toISOString(), ok: true }], orders: [], email_outbox: [], alert_state: [] }, keygenUp: true, keygenDbUp: true, ledgerDown: false, emails: [] };
  const json = (v, s = 200) => new Response(JSON.stringify(v), { status: s });
  const match = (row, [k, v]) => v.startsWith('neq.') ? String(row[k]) !== v.slice(4) : v.startsWith('eq.') ? String(row[k]) === v.slice(3) : v.startsWith('lt.') ? row[k] < v.slice(3) : v.startsWith('gte.') ? row[k] >= v.slice(4) : true;
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.host === 'keygen.test') {
      if (!w.keygenUp) throw new TypeError('down');
      if (u.pathname.endsWith('/validate-key')) return w.keygenDbUp ? json({ data: null, meta: { valid: false, code: 'NOT_FOUND' } }) : json({ errors: [{ code: 'INTERNAL' }] }, 500);
      return new Response(null, { status: 204 });
    }
    if (u.host === 'api.resend.com') { w.emails.push(body); return json({ id: 'x' }); }
    if (w.ledgerDown) throw new TypeError('ledger down');
    const table = u.pathname.split('/').pop();
    const rows = w.tables[table];
    const filters = [...u.searchParams].filter(([k]) => !['select', 'limit', 'on_conflict', 'order'].includes(k));
    if (method === 'GET') {
      let out = rows.filter((r) => filters.every((f) => match(r, f)));
      if ((u.searchParams.get('order') || '').endsWith('.desc')) out = [...out].sort((a, b) => (a.at < b.at ? 1 : -1));
      return json(out.slice(0, Number(u.searchParams.get('limit') || 1e9)));
    }
    if (method === 'POST') {
      if (rows.some((r) => r.check_name === body.check_name)) return json([]);
      const row = { failing: false, since: null, last_sent_at: null, ...body };
      rows.push(row);
      return json([row], 201);
    }
    if (method === 'PATCH') { const hit = rows.filter((r) => filters.every((f) => match(r, f))); hit.forEach((r) => Object.assign(r, body)); return json(hit); }
    throw new Error('unexpected ' + url);
  });
  return w;
}
async function run() {
  const r = { statusCode: 200, body: null, setHeader() {}, status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; } };
  await watch({ headers: { authorization: 'Bearer cron-secret' } }, r);
  return r;
}
const quiet = (t) => t.mock.method(console, 'log', () => {});

test('health-watch: all green sends nothing', async (t) => {
  quiet(t);
  const w = world(t);
  assert.deepEqual((await run()).body.alerts, []);
  assert.equal(w.emails.length, 0);
});

test('health-watch: Keygen down alerts once, stays quiet while failing, then reports recovery', async (t) => {
  quiet(t);
  const w = world(t);
  w.keygenUp = false;
  assert.deepEqual((await run()).body.alerts.sort(), ['keygen', 'keygen_db']);
  await run();
  assert.equal(w.emails.length, 2);
  assert.match(w.emails[0].subject, /ALERT: keygen/);
  assert.deepEqual(w.emails[0].to, ['owner@example.com']);
  w.keygenUp = true;
  await run();
  assert.equal(w.emails.length, 4);
  assert.ok(w.emails.slice(2).every((e) => /RECOVERED: keygen/.test(e.subject)));
  await run();
  assert.equal(w.emails.length, 4);
});

test('health-watch: a stale backup and a paid order without a licence both alert', async (t) => {
  quiet(t);
  const w = world(t);
  w.tables.backup_runs = [{ at: new Date(Date.now() - 30 * 3600e3).toISOString(), ok: true }];
  w.tables.orders = [{ id: 'o1', status: 'paid', paid_at: new Date(Date.now() - 10 * 60e3).toISOString() }];
  const r = await run();
  assert.deepEqual(r.body.alerts.sort(), ['backup', 'paid_unfulfilled']);
  assert.ok(w.emails.some((e) => /30 h ago/.test(e.text)));
  assert.ok(w.emails.some((e) => /1 paid order/.test(e.text)));
});

test('health-watch: requires the cron secret', async (t) => {
  quiet(t);
  world(t);
  const r = { statusCode: 200, setHeader() {}, status(v) { this.statusCode = v; return this; }, json() { return this; } };
  await watch({ headers: {} }, r);
  assert.equal(r.statusCode, 401);
});

test('health-watch: a paused Keygen database is reported with the restore instructions', async (t) => {
  quiet(t);
  const w = world(t);
  w.keygenDbUp = false;
  assert.deepEqual((await run()).body.alerts, ['keygen_db']);
  assert.match(w.emails[0].text, /Restore/);
});

test('health-watch: an unreachable ledger still alerts, with an hourly idempotency key', async (t) => {
  quiet(t);
  const w = world(t);
  w.ledgerDown = true;
  const r = await run();
  assert.deepEqual(r.body.alerts, ['ledger']);
  assert.equal(w.emails.length, 1);
  assert.match(w.emails[0].subject, /ledger database unreachable/);
});

test('supabase self-heal: a paused project is restored when a token is configured; nothing happens without one', async (t) => {
  const { restorePausedSupabase } = await import('../api/health-watch.mjs');
  assert.deepEqual(await restorePausedSupabase(), []);
  process.env.SUPABASE_ACCESS_TOKEN = 'sbp_test'; process.env.SUPABASE_PROJECT_REFS = 'refpaused,refok';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    calls.push((opts.method || 'GET') + ' ' + url);
    if (String(url).endsWith('/restore')) return new Response('{}', { status: 200 });
    const paused = String(url).includes('refpaused');
    return new Response(JSON.stringify({ status: paused ? 'INACTIVE' : 'ACTIVE_HEALTHY' }), { status: 200 });
  });
  try {
    assert.deepEqual(await restorePausedSupabase(), ['refpaused: was INACTIVE, restore requested']);
    assert.ok(calls.includes('POST https://api.supabase.com/v1/projects/refpaused/restore'));
    assert.ok(!calls.some((c) => c.includes('refok/restore')));
  } finally { delete process.env.SUPABASE_ACCESS_TOKEN; delete process.env.SUPABASE_PROJECT_REFS; }
});

test('a single failed check (one dropped request) is rechecked and does not alert; two failures do', async () => {
  const { runCheck } = await import('../api/health-watch.mjs');
  let calls = 0;
  const blip = async () => { calls++; if (calls === 1) throw Object.assign(new Error('x'), { code: 'LEDGER_UNAVAILABLE' }); return { ok: true }; };
  assert.deepEqual(await runCheck('backup', blip), { ok: true });
  assert.equal(calls, 2);
  const down = async () => { throw Object.assign(new Error('x'), { code: 'LEDGER_UNAVAILABLE' }); };
  const r = await runCheck('backup', down);
  assert.equal(r.ok, false);
  assert.match(r.detail, /LEDGER_UNAVAILABLE/);
});

test('alert times are shown in IST', async () => {
  const { ist } = await import('../api/health-watch.mjs');
  assert.equal(ist('2026-10-01T14:00:15.667Z'), '1 Oct 2026, 7:30:15 pm IST');
});

test('health-watch: emails sent through a backup provider raise the "email on SES" alert; SES-only is fine', async (t) => {
  quiet(t);
  const w = world(t);
  const sentAt = new Date().toISOString();
  w.tables.email_outbox.push({ id: 'a', status: 'sent', provider: 'ses', sent_at: sentAt, created_at: sentAt });
  assert.deepEqual((await run()).body.alerts, [], 'SES only: no alert');
  w.tables.email_outbox.push({ id: 'b', status: 'sent', provider: 'resend', sent_at: sentAt, created_at: sentAt });
  assert.deepEqual((await run()).body.alerts, ['email_on_ses']);
  assert.match(w.emails.at(-1).subject, /ALERT: email on ses/);
  assert.match(w.emails.at(-1).text, /resend: 1/);
});
