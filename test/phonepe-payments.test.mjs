import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';

process.env.PAYMENT_PROVIDER = 'phonepe';
process.env.PHONEPE_CLIENT_ID = 'TESTCLIENT';
process.env.PHONEPE_CLIENT_SECRET = 'pp-test-secret';
process.env.PHONEPE_MODE = 'sandbox';
process.env.PHONEPE_WEBHOOK_USERNAME = 'hook-user';
process.env.PHONEPE_WEBHOOK_PASSWORD = 'hook-pass-1';
process.env.PASS_SALES_ENABLED = 'true';
process.env.TTD_LEDGER_URL = 'https://ledger.test';
process.env.TTD_LEDGER_SECRET_KEY = 'ledger-secret';
process.env.LEDGER_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.KEYGEN_API_URL = 'https://keygen.test';
process.env.KEYGEN_ACCOUNT_ID = 'acct-1';
process.env.KEYGEN_PRODUCT_TOKEN = 'prod-token';
process.env.KEYGEN_PRODUCT_ID = 'kg-product';
process.env.KEYGEN_PLAN_POLICIES = JSON.stringify({ '7d': 'pol-7', '30d': 'pol-30', '90d': 'pol-90' });
process.env.CRON_SECRET = 'cron-secret';
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;

const checkout = (await import('../api/checkout.mjs')).default;
const confirm = (await import('../api/payment-confirm.mjs')).default;
const webhook = (await import('../api/phonepe-webhook.mjs')).default;
const reconcile = (await import('../api/payments-reconcile.mjs')).default;
const config = (await import('../api/config.mjs')).default;
const { openSecret } = await import('../api/_ledger.mjs');

// ---- in-memory world: PostgREST subset, PhonePe, Keygen -------------------
function world(t) {
  const w = { tables: { orders: [], payment_events: [], fulfilments: [], email_outbox: [], licence_authority: [], invoices: [] }, invoiceSeq: 0,
    ppOrders: {}, licenses: [], emails: [], resendStatus: [], keygenDown: false, keygenLoseResponse: false, calls: [] };
  const json = (v, s = 200) => new Response(JSON.stringify(v), { status: s, headers: { 'Content-Type': 'application/json' } });
  const uniques = { orders: [['request_id'], ['razorpay_order_id']], payment_events: [['event_id']], fulfilments: [['order_id']],
    email_outbox: [['kind', 'order_id']], licence_authority: [['key_hash']], invoices: [['order_id']] };
  const match = (row, [k, v]) => {
    if (k === 'and') {
      return v.slice(1, -1).split(/,(?=[a-z_]+\.)/).every((part) => {
        const [col, op, ...rest] = part.split('.'); const val = rest.join('.');
        return op === 'gte' ? row[col] >= val : op === 'lte' ? row[col] <= val : true;
      });
    }
    if (v.startsWith('eq.')) return String(row[k]) === v.slice(3);
    if (v === 'is.null') return row[k] == null;
    if (v === 'not.is.null') return row[k] != null;
    if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(String(row[k]));
    const cmp = /^(lt|lte|gt|gte)\.(.*)$/.exec(v);
    if (cmp) {
      const a = row[k]; const b = cmp[2];
      if (a == null) return false;
      return cmp[1] === 'lt' ? a < b : cmp[1] === 'lte' ? a <= b : cmp[1] === 'gt' ? a > b : a >= b;
    }
    return true;
  };
  const sortBy = (list, spec) => {
    if (!spec) return list;
    const keys = spec.split(',').map((part) => { const [col, dir = 'asc', nulls] = part.split('.'); return { col, desc: dir === 'desc', nullsFirst: nulls === 'nullsfirst' }; });
    return [...list].sort((x, y) => {
      for (const { col, desc, nullsFirst } of keys) {
        const a = x[col]; const b = y[col];
        if (a == null && b == null) continue;
        if (a == null) return nullsFirst ? -1 : 1;
        if (b == null) return nullsFirst ? 1 : -1;
        if (a !== b) return (a < b ? -1 : 1) * (desc ? -1 : 1);
      }
      return 0;
    });
  };
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = opts.method || 'GET';
    const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    w.calls.push(`${method} ${u.host}${u.pathname}`);
    if (u.host === 'ledger.test') {
      if (u.pathname.endsWith('/rpc/allocate_invoice_seq')) return json(++w.invoiceSeq);
      if (u.pathname.endsWith('/rpc/claim_outbox_row')) {
        const row = w.tables.email_outbox.find((r) => r.id === body.p_id);
        const free = row && row.status === 'queued' && (!row.claimed_until || Date.parse(row.claimed_until) < Date.now());
        if (free) row.claimed_until = new Date(Date.now() + 120e3).toISOString();
        return json(!!free);
      }
      const table = u.pathname.split('/').pop();
      const rows = w.tables[table];
      const filters = [...u.searchParams].filter(([k]) => !['select', 'limit', 'on_conflict', 'order'].includes(k));
      if (method === 'GET') return json(sortBy(rows.filter((r) => filters.every((f) => match(r, f))), u.searchParams.get('order')).slice(0, Number(u.searchParams.get('limit') || 1e9)));
      if (method === 'POST') {
        const clash = (uniques[table] || []).some((cols) => rows.some((r) => cols.every((c) => r[c] != null && r[c] === body[c])));
        if (clash) return (opts.headers.Prefer || '').includes('ignore-duplicates') ? json([]) : json({ code: '23505' }, 409);
        const row = { id: randomUUID(), status: table === 'orders' ? 'created' : table === 'fulfilments' ? 'pending' : table === 'email_outbox' ? 'queued' : undefined,
          created_at: new Date(Date.now() - (w.backdate || 0)).toISOString(), ...(table === 'email_outbox' ? { attempts: 0, next_attempt_at: new Date(Date.now() - (w.backdate || 0)).toISOString() } : {}), ...body };
        rows.push(row);
        return json([row], 201);
      }
      if (method === 'PATCH') {
        const hit = rows.filter((r) => filters.every((f) => match(r, f)));
        hit.forEach((r) => Object.assign(r, body));
        return json(hit);
      }
    }
    if (u.host === 'api-preprod.phonepe.com') {
      if (u.pathname === '/apis/pg-sandbox/v1/oauth/token') {
        const form = new URLSearchParams(opts.body);
        assert.equal(form.get('client_id'), 'TESTCLIENT');
        assert.equal(form.get('client_secret'), 'pp-test-secret');
        assert.equal(form.get('grant_type'), 'client_credentials');
        return json({ access_token: 'tok-1', token_type: 'O-Bearer', expires_at: Math.floor(Date.now() / 1000) + 3600 });
      }
      assert.equal(opts.headers.Authorization, 'O-Bearer tok-1');
      let m;
      if (u.pathname === '/apis/pg-sandbox/checkout/v2/pay' && method === 'POST') {
        if (w.ppOrders[body.merchantOrderId]) return json({ code: 'DUPLICATE_TXN_REQUEST' }, 400);
        const o = { merchantOrderId: body.merchantOrderId, orderId: 'OMO' + randomBytes(6).toString('hex'), amount: body.amount, state: 'PENDING', body, paymentDetails: [] };
        w.ppOrders[o.merchantOrderId] = o;
        return json({ orderId: o.orderId, state: 'PENDING', expireAt: Date.now() + 1800e3, redirectUrl: w.ppRedirect || 'https://mercury-uat.phonepe.com/transact/uat_v2?token=' + o.orderId });
      }
      if ((m = u.pathname.match(/^\/apis\/pg-sandbox\/checkout\/v2\/order\/([^/]+)\/status$/))) {
        const o = w.ppOrders[m[1]];
        return o ? json({ orderId: o.orderId, state: o.state, amount: o.amount, paymentDetails: o.paymentDetails }) : json({ code: 'ORDER_NOT_FOUND' }, 404);
      }
    }
    if (u.host === 'api.resend.com') {
      if (w.emailDelayMs) await new Promise((r) => setTimeout(r, w.emailDelayMs));
      w.emails.push({ idem: opts.headers['Idempotency-Key'], body });
      const status = w.resendStatus.shift() || 200;
      return json(status === 200 ? { id: 'em_' + w.emails.length } : { name: 'error' }, status);
    }
    if (u.host === 'keygen.test') {
      if (w.keygenDown) throw new TypeError('fetch failed');
      const path = u.pathname.replace('/v1/accounts/acct-1', '');
      if (path === '/licenses' && method === 'POST') {
        const a = body.data.attributes;
        // Hold overlapping creates before the unique insert. A real database
        // race returns 409, whereas a later ordinary duplicate returns 422.
        if (w.keygenCreateBarrier && !w.licenses.some((l) => l.key === a.key)) {
          w.keygenCreateBarrier.arrived++;
          if (w.keygenCreateBarrier.arrived === w.keygenCreateBarrier.expected) w.keygenCreateBarrier.release();
          await w.keygenCreateBarrier.ready;
        }
        if (w.licenses.some((l) => l.key === a.key)) {
          if (w.keygenCreateBarrier) {
            w.keygenConflicts = (w.keygenConflicts || 0) + 1;
            return json({ errors: [{ code: null }] }, 409);
          }
          return json({ errors: [{ code: 'KEY_TAKEN' }] }, 422);
        }
        const l = { id: randomUUID(), key: a.key, metadata: a.metadata, maxMachines: a.maxMachines, policy: body.data.relationships.policy.data.id };
        w.licenses.push(l);
        if (w.keygenLoseResponse) { w.keygenLoseResponse = false; throw new TypeError('socket hang up'); }
        return json({ data: { id: l.id, type: 'licenses', attributes: { key: l.key, metadata: l.metadata } } }, 201);
      }
      if (path === '/licenses/actions/validate-key') {
        const l = w.licenses.find((x) => x.key === body.meta.key);
        return json({ data: l ? { id: l.id, type: 'licenses', attributes: { key: l.key, metadata: l.metadata }, relationships: { policy: { data: { id: l.policy } } } } : null, meta: { valid: !!l, code: l ? 'VALID' : 'NOT_FOUND' } });
      }
    }
    throw new Error('unexpected fetch ' + method + ' ' + url);
  });
  w.pay = (orderId, { amount, state = 'COMPLETED', mode = 'UPI_QR' } = {}) => {
    const o = w.ppOrders[orderId];
    if (amount != null) o.amount = amount;
    o.state = state;
    o.paymentDetails = [{ paymentMode: mode, transactionId: 'OM' + randomBytes(6).toString('hex'), amount: o.amount, state }];
    return o;
  };
  return w;
}

function res() {
  return { statusCode: 200, headers: {}, body: undefined, setHeader(n, v) { this.headers[n.toLowerCase()] = v; },
    status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; }, end() { return this; } };
}
async function post(handler, body, headers = {}) {
  const r = res();
  await handler({ method: 'POST', body, headers: { origin: 'https://ttd-info.vercel.app', 'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(JSON.stringify(body))), ...headers } }, r);
  return r;
}
async function hook(event, { username = 'hook-user', password = 'hook-pass-1', authorization } = {}) {
  const raw = Buffer.from(JSON.stringify(event));
  const req = Readable.from([raw]);
  req.method = 'POST';
  req.headers = { authorization: authorization ?? createHash('sha256').update(`${username}:${password}`).digest('hex') };
  const r = res();
  await webhook(req, r);
  return r;
}
const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {}); };
const start = (plan = '7d', requestId = randomUUID(), extra = {}) =>
  post(checkout, { plan, request_id: requestId, email: 'Buyer+ttd@Example.COM', activate: false, ...extra });
const completedEvent = (order, state = 'COMPLETED') => ({ event: 'checkout.order.completed', payload: { merchantOrderId: order, orderId: 'OMOx', state, expireAt: 1793172655297 } });

// ---- checkout -------------------------------------------------------------
test('phonepe checkout creates a server-priced order and returns the hosted checkout URL', async (t) => {
  quiet(t);
  const w = world(t);
  const r = await start('30d');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.provider, 'phonepe');
  assert.equal(r.body.mode, 'sandbox');
  assert.equal(r.body.amount, 29900);
  assert.match(r.body.redirect_url, /^https:\/\/mercury-uat\.phonepe\.com\//);
  assert.match(r.body.order_id, /^pp_[0-9a-f]{32}$/);
  assert.match(r.body.purchase_token, /^[A-Za-z0-9_-]{43}$/);
  const pp = w.ppOrders[r.body.order_id];
  assert.equal(pp.amount, 29900);
  assert.equal(pp.body.paymentFlow.type, 'PG_CHECKOUT');
  const order = w.tables.orders[0];
  assert.equal(order.razorpay_order_id, r.body.order_id);
  assert.equal(order.razorpay_mode, 'test');
  assert.notEqual(order.purchase_token_hash, r.body.purchase_token);
});

test('phonepe returns the buyer to the site domain they started on', async (t) => {
  quiet(t);
  const w = world(t);
  const fromNew = await post(checkout, { plan: '7d', request_id: randomUUID(), email: 'a@example.com', activate: false }, { origin: 'https://ttd-autofill.com' });
  assert.match(w.ppOrders[fromNew.body.order_id].body.paymentFlow.merchantUrls.redirectUrl, /^https:\/\/ttd-autofill\.com\/pass\/success\?plan=7d/);
  const fromOld = await start('7d');
  assert.match(w.ppOrders[fromOld.body.order_id].body.paymentFlow.merchantUrls.redirectUrl, /^https:\/\/ttd-info\.vercel\.app\/pass\/success\?plan=7d/);
  // A deployment on its own host (staging) returns buyers to itself, not to production.
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'ttd-info-keygen.vercel.app';
  try {
    const staging = await post(checkout, { plan: '7d', request_id: randomUUID(), email: 'a@example.com', activate: false }, { origin: 'https://ttd-info-keygen.vercel.app' });
    assert.match(w.ppOrders[staging.body.order_id].body.paymentFlow.merchantUrls.redirectUrl, /^https:\/\/ttd-info-keygen\.vercel\.app\/pass\/success\?plan=7d/);
  } finally { delete process.env.VERCEL_PROJECT_PRODUCTION_URL; }
});

test('phonepe sells several passes on one key at the tiered price', async (t) => {
  quiet(t);
  const w = world(t);
  const { priceFor } = await import('../api/_pricing.mjs');
  const { planByCode } = await import('../api/_dodo.mjs');
  const expected = priceFor(planByCode('7d'), 5);
  const r = await start('7d', randomUUID(), { quantity: 5 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.amount, expected.total);
  assert.equal(w.tables.orders[0].quantity, 5);
  assert.equal(w.ppOrders[r.body.order_id].amount, expected.total);
  const bad = await start('7d', randomUUID(), { quantity: 51 });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error, 'invalid_quantity');
});

test('phonepe checkout needs a valid email and refuses a redirect URL outside phonepe.com', async (t) => {
  quiet(t);
  const w = world(t);
  assert.equal((await start('7d', randomUUID(), { email: 'nope' })).statusCode, 400);
  w.ppRedirect = 'https://evil.example/pay';
  assert.equal((await start()).statusCode, 503);
});

test('re-opening checkout starts a new PhonePe attempt and a payment on the old one still fulfils', async (t) => {
  quiet(t);
  const w = world(t);
  const id = randomUUID();
  const first = await start('7d', id);
  const second = await start('7d', id);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.order_id, first.body.order_id + '_a1');
  assert.notEqual(second.body.purchase_token, first.body.purchase_token);
  assert.equal(Object.keys(w.ppOrders).length, 2);
  // The first tab's payment lands after the second attempt was opened.
  w.pay(first.body.order_id);
  const r = await post(confirm, { razorpay_order_id: second.body.order_id, purchase_token: first.body.purchase_token });
  assert.equal(r.statusCode, 200);
  assert.match(r.body.license_key, /^TTD-/);
  // A paid order cannot be paid for again.
  const third = await start('7d', id);
  assert.equal(third.statusCode, 409);
  assert.equal(third.body.error, 'already_paid');
});

// ---- confirm --------------------------------------------------------------
test('payment-confirm fulfils a paid PhonePe order and is idempotent', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  const pending = await post(confirm, { razorpay_order_id: c.order_id, purchase_token: c.purchase_token });
  assert.equal(pending.statusCode, 202);
  w.pay(c.order_id);
  const a = await post(confirm, { razorpay_order_id: c.order_id, purchase_token: c.purchase_token });
  const b = await post(confirm, { razorpay_order_id: c.order_id, purchase_token: c.purchase_token });
  assert.equal(a.statusCode, 200);
  assert.match(a.body.license_key, /^TTD-/);
  assert.equal(b.body.license_key, a.body.license_key);
  assert.equal(w.licenses.length, 1);
  assert.equal(w.tables.orders[0].status, 'fulfilled');
  assert.equal(w.tables.licence_authority[0].source, 'phonepe');
  assert.equal(w.tables.licence_authority[0].authority, 'keygen');
});

test('a wrong token, a short payment or a failed payment never fulfils', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  const bad = await post(confirm, { razorpay_order_id: c.order_id, purchase_token: 'A'.repeat(43) });
  assert.equal(bad.statusCode, 403);
  w.pay(c.order_id, { amount: 1 });
  assert.equal((await post(confirm, { razorpay_order_id: c.order_id, purchase_token: c.purchase_token })).statusCode, 202);
  w.pay(c.order_id, { state: 'FAILED' });
  assert.equal((await post(confirm, { razorpay_order_id: c.order_id, purchase_token: c.purchase_token })).statusCode, 202);
  assert.equal(w.licenses.length, 0);
});

// ---- webhook --------------------------------------------------------------
test('an authorised checkout.order.completed webhook fulfils the order once, even when delivered twice', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  w.pay(c.order_id);
  assert.equal((await hook(completedEvent(c.order_id))).statusCode, 200);
  assert.equal((await hook(completedEvent(c.order_id))).statusCode, 200);
  assert.equal(w.licenses.length, 1);
  assert.equal(w.tables.orders[0].status, 'fulfilled');
  assert.equal(w.tables.payment_events.length, 1);
});

test('a webhook with bad credentials is rejected; a claimed payment PhonePe does not confirm fulfils nothing', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  assert.equal((await hook(completedEvent(c.order_id), { password: 'other' })).statusCode, 401);
  assert.equal((await hook(completedEvent(c.order_id), { authorization: '' })).statusCode, 401);
  // Correctly authorised, but PhonePe's API shows the order still pending.
  assert.equal((await hook(completedEvent(c.order_id))).statusCode, 200);
  assert.equal(w.licenses.length, 0);
  assert.equal(w.tables.orders[0].status, 'created');
});

// ---- reconcile and config -------------------------------------------------
test('reconcile finishes a paid order whose webhook never arrived', async (t) => {
  quiet(t);
  const w = world(t);
  w.backdate = 5 * 60e3;
  const c = (await start()).body;
  w.pay(c.order_id);
  const r = res();
  await reconcile({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.fulfilled, 1);
  assert.equal(w.tables.orders[0].status, 'fulfilled');
});

test('config reports phonepe with multi-pass pricing', async (t) => {
  quiet(t);
  const r = res();
  config({ method: 'GET', headers: { origin: 'https://ttd-info.vercel.app' } }, r);
  assert.equal(r.body.payment_provider, 'phonepe');
  assert.ok(r.body.bulk && r.body.bulk.tiers.length);
});

test('PhonePe stays in the sandbox unless PHONEPE_MODE is exactly production; cashfree is selectable again', async (t) => {
  quiet(t);
  const { phonepeConfig, phonepeAttemptIds, nextPhonePeOrderId } = await import('../api/_phonepe.mjs');
  const { paymentProvider } = await import('../api/_razorpay.mjs');
  assert.equal(phonepeConfig().hosts.api, 'https://api-preprod.phonepe.com/apis/pg-sandbox');
  process.env.PHONEPE_MODE = 'prod';
  try {
    assert.equal(phonepeConfig().live, false);
    process.env.PHONEPE_MODE = 'production';
    assert.equal(phonepeConfig().hosts.api, 'https://api.phonepe.com/apis/pg');
  } finally { process.env.PHONEPE_MODE = 'sandbox'; }
  assert.deepEqual(phonepeAttemptIds('pp_ab_a2'), ['pp_ab_a2', 'pp_ab_a1', 'pp_ab']);
  assert.equal(nextPhonePeOrderId('pp_ab'), 'pp_ab_a1');
  assert.equal(nextPhonePeOrderId('pp_ab_a1'), 'pp_ab_a2');
  process.env.PAYMENT_PROVIDER = 'cashfree';
  try { assert.equal(paymentProvider(), 'cashfree'); } finally { process.env.PAYMENT_PROVIDER = 'phonepe'; }
});
