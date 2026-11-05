import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TTD_LEDGER_URL = 'https://ledger.test';
process.env.TTD_LEDGER_SECRET_KEY = 'ledger-secret';
process.env.KEYGEN_API_URL = 'https://keygen.test';
process.env.KEYGEN_ACCOUNT_ID = 'acct-1';
process.env.KEYGEN_PRODUCT_TOKEN = 'prod-token';
process.env.KEYGEN_PRODUCT_ID = 'kg-product';
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;

const reports = (await import('../api/ops/reports.mjs')).default;
const { resolveRange, bucketsBetween } = await import('../api/_reports.mjs');
const { selectAll } = await import('../api/_ledger.mjs');

const ADMIN = 'admin-token';
const NOW = Date.parse('2026-10-05T10:00:00Z'); // 15:30 IST

// A PostgREST stand-in: filters (eq/neq/gte/lt/in), order, limit/offset, HEAD counts.
// Records every request so tests can assert nothing reached Keygen and nothing wrote.
function world(t, tables) {
  const w = { tables, calls: [] };
  t.mock.method(Date, 'now', () => NOW);
  const json = (v, s = 200, headers = {}) => new Response(JSON.stringify(v), { status: s, headers: { 'Content-Type': 'application/json', ...headers } });
  const match = (row, [k, v]) => {
    const value = row[k] == null ? null : String(row[k]);
    if (v.startsWith('eq.')) return value === v.slice(3);
    if (v.startsWith('neq.')) return value !== v.slice(4);
    if (v.startsWith('gte.')) return value !== null && value >= v.slice(4);
    if (v.startsWith('lt.')) return value !== null && value < v.slice(3);
    if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(value);
    throw new Error('unsupported filter ' + v);
  };
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = opts.method || 'GET';
    w.calls.push({ host: u.host, method, path: u.pathname });
    if (u.host === 'keygen.test' && u.pathname.endsWith('/me')) {
      return opts.headers.Authorization === 'Bearer ' + ADMIN
        ? json({ data: { id: 'admin-1', type: 'users', attributes: { email: 'owner@example.com', role: 'admin' } } })
        : json({ errors: [{ code: 'TOKEN_INVALID' }] }, 401);
    }
    if (u.host !== 'ledger.test' || !['GET', 'HEAD'].includes(method)) throw new Error('unexpected fetch ' + method + ' ' + url);
    const rows = w.tables[u.pathname.split('/').pop()];
    const filters = [...u.searchParams].filter(([k]) => !['select', 'limit', 'offset', 'order'].includes(k));
    let out = rows.filter((r) => filters.every((f) => match(r, f)));
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'Content-Range': `0-0/${out.length}` } });
    const [col] = (u.searchParams.get('order') || '').split('.');
    if (col) out = [...out].sort((a, b) => String(a[col]).localeCompare(String(b[col])));
    const offset = Number(u.searchParams.get('offset') || 0);
    return json(out.slice(offset, offset + Number(u.searchParams.get('limit') || 1e9)));
  });
  return w;
}

const ledger = () => ({
  orders: [
    { id: 'o1', plan: '7d', amount_paise: 9900, quantity: 1, discount_pct: 0, status: 'fulfilled', razorpay_mode: 'live', created_at: '2026-10-05T03:00:00Z', paid_at: '2026-10-05T03:01:00Z', email: 'a@example.com' },
    { id: 'o2', plan: '30d', amount_paise: 52600, quantity: 2, discount_pct: 12, status: 'fulfilled', razorpay_mode: 'live', created_at: '2026-10-04T05:00:00Z', paid_at: '2026-10-04T05:02:00Z', email: 'b@example.com' },
    { id: 'o3', plan: '7d', amount_paise: 9900, quantity: 1, discount_pct: 0, status: 'created', razorpay_mode: 'live', created_at: '2026-10-05T04:00:00Z', paid_at: null, email: null },
    { id: 'o4', plan: '90d', amount_paise: 69900, quantity: 1, discount_pct: 0, status: 'fulfilled', razorpay_mode: 'test', created_at: '2026-10-05T05:00:00Z', paid_at: '2026-10-05T05:01:00Z', email: 't@example.com' },
    { id: 'o5', plan: '7d', amount_paise: 9900, quantity: 1, discount_pct: 0, status: 'fulfilled', razorpay_mode: 'live', created_at: '2026-09-01T05:00:00Z', paid_at: '2026-09-01T05:01:00Z', email: 'old@example.com' }
  ],
  offline_sales: [
    { id: 's1', kind: 'paid', method: 'upi', plan: '30d', amount_inr: 299, activations: 1, email: 'w@example.com', reference: 'UTR1', status: 'provisioned', created_at: '2026-10-05T06:00:00Z' },
    { id: 's2', kind: 'grant', method: 'other', plan: '7d', amount_inr: 0, activations: 6, email: null, reference: 'GIFT1', status: 'provisioned', created_at: '2026-10-05T07:00:00Z' },
    { id: 's3', kind: 'paid', method: 'cash', plan: '7d', amount_inr: 99, activations: 1, email: null, reference: 'R9', status: 'pending', created_at: '2026-10-05T07:30:00Z' }
  ],
  email_outbox: [
    { id: 'e1', status: 'sent', kind: 'licence_key', provider: 'ses', created_at: '2026-10-05T03:01:00Z' },
    { id: 'e2', status: 'queued', kind: 'licence_key', provider: null, created_at: '2026-10-05T05:01:00Z' }
  ],
  audit_events: [
    { id: 1, action: 'ops_login', at: '2026-10-05T02:00:00Z' },
    { id: 2, action: 'grant_created', at: '2026-10-05T07:00:00Z' },
    { id: 3, action: 'ops_login', at: '2026-10-05T08:00:00Z' }
  ],
  invoices: [{ id: 'i1', issued_at: '2026-10-05T03:01:00Z' }, { id: 'i2', issued_at: '2026-10-04T05:02:00Z' }],
  licence_authority: [
    { key_hash: 'a', source: 'dodo-migrated' }, { key_hash: 'b', source: 'dodo-migrated' },
    { key_hash: 'c', source: 'razorpay' }, { key_hash: 'd', source: 'grant' }
  ]
});

function res() {
  return { statusCode: 200, body: undefined, setHeader() {}, status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; }, end() { return this; } };
}
async function call(body, token = ADMIN) {
  const r = res();
  await reports({ method: 'POST', body, headers: { origin: 'https://ttd-info.vercel.app', 'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(JSON.stringify(body))), ...(token ? { authorization: 'Bearer ' + token } : {}) } }, r);
  return r;
}

test('ranges are calendar periods in IST', () => {
  const iso = (r) => [new Date(r.from).toISOString(), new Date(r.to).toISOString(), r.bucket];
  assert.deepEqual(iso(resolveRange({ range: 'today' }, NOW)), ['2026-10-04T18:30:00.000Z', '2026-10-05T10:00:00.000Z', 'hour']);
  assert.deepEqual(iso(resolveRange({ range: 'yesterday' }, NOW)), ['2026-10-03T18:30:00.000Z', '2026-10-04T18:30:00.000Z', 'hour']);
  assert.deepEqual(iso(resolveRange({ range: '7d' }, NOW)).slice(0, 1), ['2026-09-28T18:30:00.000Z']);
  assert.equal(resolveRange({ range: '30d' }, NOW).bucket, 'day');
  assert.deepEqual(iso(resolveRange({ range: 'month' }, NOW)).slice(0, 1), ['2026-09-30T18:30:00.000Z']);
  assert.deepEqual(iso(resolveRange({ range: 'last_month' }, NOW)), ['2026-08-31T18:30:00.000Z', '2026-09-30T18:30:00.000Z', 'day']);
  assert.deepEqual(iso(resolveRange({ range: 'fy' }, NOW)), ['2026-03-31T18:30:00.000Z', '2026-10-05T10:00:00.000Z', 'month']);
  // Just after midnight IST (still the previous day in UTC) is already "today".
  assert.equal(new Date(resolveRange({ range: 'today' }, Date.parse('2026-10-05T19:00:00Z')).from).toISOString(), '2026-10-05T18:30:00.000Z');
});

test('custom ranges are inclusive dates and validated', () => {
  const r = resolveRange({ range: 'custom', from: '2026-10-01', to: '2026-10-03' }, NOW);
  assert.equal(new Date(r.from).toISOString(), '2026-09-30T18:30:00.000Z');
  assert.equal(new Date(r.to).toISOString(), '2026-10-03T18:30:00.000Z');
  assert.equal(resolveRange({ range: 'custom', from: '2026-10-03', to: '2026-10-01' }, NOW), null);
  assert.equal(resolveRange({ range: 'custom', from: '2026-02-30', to: '2026-03-01' }, NOW), null);
  assert.equal(resolveRange({ range: 'custom', from: '2025-01-01', to: '2026-10-01' }, NOW), null);
  assert.equal(resolveRange({ range: 'custom', from: 'x', to: '2026-10-01' }, NOW), null);
  assert.equal(resolveRange({ range: 'nope' }, NOW), null);
});

test('buckets cover the whole range in IST hours, days or months', () => {
  const today = resolveRange({ range: 'today' }, NOW);
  const hours = bucketsBetween(today.from, today.to, 'hour');
  assert.equal(hours[0], '2026-10-05 00:00');
  assert.equal(hours.at(-1), '2026-10-05 15:00');
  assert.deepEqual(bucketsBetween(Date.parse('2026-09-30T18:30:00Z'), NOW, 'day').slice(0, 2), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(bucketsBetween(Date.parse('2026-03-31T18:30:00Z'), NOW, 'month'), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
});

test('selectAll pages through rows and reports truncation', async (t) => {
  const w = world(t, { orders: Array.from({ length: 5 }, (_, i) => ({ id: 'o' + i, created_at: '2026-10-0' + (i + 1) })) });
  const all = await selectAll('orders', [['select', 'id']], { order: 'created_at.asc', pageSize: 2 });
  assert.deepEqual(all.rows.map((r) => r.id), ['o0', 'o1', 'o2', 'o3', 'o4']);
  assert.equal(all.truncated, false);
  const capped = await selectAll('orders', [['select', 'id']], { order: 'created_at.asc', pageSize: 2, maxRows: 4 });
  assert.equal(capped.rows.length, 4);
  assert.equal(capped.truncated, true);
  assert.equal(w.calls.length, 3 + 2);
});

test('report: live licences, revenue and checkouts for a range, from the ledger only', async (t) => {
  t.mock.method(console, 'error', () => {});
  const w = world(t, ledger());
  const r = await call({ range: 'custom', from: '2026-10-04', to: '2026-10-05', fresh: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const rep = r.body.report;
  assert.equal(rep.mode, 'live');
  assert.deepEqual(rep.licences, { total: 4, online: 2, offline: 1, grant: 1, passes: 10, multi_pass: 2, awaiting_licence: 0 });
  assert.deepEqual(rep.revenue, { total_paise: 9900 + 52600 + 29900, online_paise: 62500, offline_paise: 29900, average_order_paise: 31250 });
  assert.deepEqual(rep.checkouts, { started: 3, completed: 2, abandoned: 1 });
  assert.deepEqual(rep.plans.map((p) => [p.plan, p.licences, p.passes, p.revenue_paise]), [['7d', 2, 7, 9900], ['30d', 2, 3, 82500]]);
  assert.deepEqual(rep.offline_methods, [{ key: 'upi', count: 1 }]);
  assert.equal(rep.invoices_issued, 2);
  assert.deepEqual(rep.ops_activity, [{ key: 'ops_login', count: 2 }, { key: 'grant_created', count: 1 }]);
  assert.deepEqual(rep.emails.by_status.map((e) => e.key).sort(), ['queued', 'sent']);
  assert.equal(rep.emails.queued_now, 1);
  assert.deepEqual(rep.on_record, { dodo_migrated: 2, razorpay: 1, grant: 1 });
  assert.equal(rep.recent.length, 4);
  assert.equal(rep.recent[0].source, 'grant');
  assert.equal(rep.series.length, 2);
  assert.deepEqual(rep.series.map((s) => [s.bucket, s.online, s.offline, s.grant]), [['2026-10-04', 1, 0, 0], ['2026-10-05', 1, 1, 1]]);
  // Keygen: one admin check only. Ledger: reads only, one at a time.
  assert.deepEqual(w.calls.filter((c) => c.host === 'keygen.test').map((c) => c.path), ['/v1/accounts/acct-1/me']);
  assert.ok(w.calls.every((c) => c.host !== 'ledger.test' || ['GET', 'HEAD'].includes(c.method)));
});

test('report: test mode and all mode select which online orders count', async (t) => {
  world(t, ledger());
  const testMode = (await call({ range: 'custom', from: '2026-10-05', to: '2026-10-05', mode: 'test', fresh: true })).body.report;
  assert.equal(testMode.licences.online, 1);
  assert.equal(testMode.recent.find((x) => x.source === 'online').detail, 'test mode');
  const all = (await call({ range: 'custom', from: '2026-10-05', to: '2026-10-05', mode: 'all', fresh: true })).body.report;
  assert.equal(all.licences.online, 2);
});

test('report: repeat requests within a minute reuse the result and skip Keygen', async (t) => {
  const w = world(t, ledger());
  const first = await call({ range: 'custom', from: '2026-09-01', to: '2026-09-01' });
  const before = w.calls.length;
  const second = await call({ range: 'custom', from: '2026-09-01', to: '2026-09-01' });
  assert.equal(second.body.cached, true);
  assert.deepEqual(second.body.report, first.body.report);
  assert.equal(w.calls.length, before);
  // A forced refresh right away is still served from the cache.
  assert.equal((await call({ range: 'custom', from: '2026-09-01', to: '2026-09-01', fresh: true })).body.cached, true);
});

test('report: operators only, and bad ranges are rejected', async (t) => {
  t.mock.method(console, 'error', () => {});
  world(t, ledger());
  assert.equal((await call({ range: 'today' }, 'not-an-admin')).statusCode, 401);
  assert.equal((await call({ range: 'today' }, null)).statusCode, 401);
  assert.equal((await call({ range: 'forever' })).statusCode, 400);
  assert.equal((await call({ range: 'today', mode: 'sandbox' })).statusCode, 400);
  assert.equal((await call({ range: 'custom', from: '2026-10-05', to: '2026-10-01' })).body.error, 'invalid_range');
});
