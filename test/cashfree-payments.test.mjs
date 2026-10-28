import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';

process.env.PAYMENT_PROVIDER = 'cashfree';
process.env.CASHFREE_APP_ID = 'TEST123abc';
process.env.CASHFREE_SECRET_KEY = 'cfsk_test_secret';
process.env.CASHFREE_MODE = 'sandbox';
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
const webhook = (await import('../api/cashfree-webhook.mjs')).default;
const reconcile = (await import('../api/payments-reconcile.mjs')).default;
const config = (await import('../api/config.mjs')).default;
const { openSecret } = await import('../api/_ledger.mjs');

// ---- in-memory world: PostgREST subset, Razorpay, Keygen -------------------
function world(t) {
  const w = { tables: { orders: [], payment_events: [], fulfilments: [], email_outbox: [], licence_authority: [], invoices: [] }, invoiceSeq: 0,
    cfOrders: {}, payments: {}, licenses: [], emails: [], resendStatus: [], keygenDown: false, keygenLoseResponse: false, calls: [] };
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
    const body = opts.body ? JSON.parse(opts.body) : null;
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
    if (u.host === 'sandbox.cashfree.com') {
      assert.equal(opts.headers['x-client-id'], 'TEST123abc');
      assert.equal(opts.headers['x-client-secret'], 'cfsk_test_secret');
      let m;
      if (u.pathname === '/pg/orders' && method === 'POST') {
        const o = { order_id: body.order_id, order_amount: body.order_amount, order_currency: body.order_currency, customer_details: body.customer_details,
          order_meta: body.order_meta, payment_session_id: 'session_' + randomBytes(6).toString('hex'), order_status: 'ACTIVE' };
        w.cfOrders[o.order_id] = o;
        return json(o);
      }
      if ((m = u.pathname.match(/^\/pg\/orders\/([^/]+)\/payments$/))) return json(Object.values(w.payments).filter((p) => p.order_id === m[1]));
      if ((m = u.pathname.match(/^\/pg\/orders\/([^/]+)$/))) return w.cfOrders[m[1]] ? json(w.cfOrders[m[1]]) : json({ code: 'order_not_found' }, 404);
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
  w.pay = (orderId, { amount, status = 'SUCCESS', currency = 'INR' } = {}) => {
    const o = w.cfOrders[orderId];
    const p = { cf_payment_id: Math.floor(Math.random() * 1e9), order_id: orderId, payment_status: status, payment_amount: amount ?? o.order_amount, payment_currency: currency, payment_method: { upi: { channel: 'qrcode' } } };
    w.payments[p.cf_payment_id] = p;
    return p;
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
async function hook(event, { secret = 'cfsk_test_secret', timestamp = String(Date.now()) } = {}) {
  const raw = Buffer.from(JSON.stringify(event));
  const req = Readable.from([raw]);
  req.method = 'POST';
  req.headers = { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': createHmac('sha256', secret).update(timestamp + raw.toString('utf8')).digest('base64') };
  const r = res();
  await webhook(req, r);
  return r;
}
const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {}); };
const start = (plan = '7d', requestId = randomUUID(), extra = {}) =>
  post(checkout, { plan, request_id: requestId, email: 'Buyer+ttd@Example.COM', activate: false, ...extra });
const successEvent = (order, p) => ({ type: 'PAYMENT_SUCCESS_WEBHOOK', event_time: '2026-10-25T10:00:00+05:30', data: { order: { order_id: order }, payment: { cf_payment_id: p.cf_payment_id, payment_status: 'SUCCESS' } } });

// ---- checkout -------------------------------------------------------------
test('cashfree checkout creates a server-priced INR order with a payment session', async (t) => {
  quiet(t);
  const w = world(t);
  const r = await start('30d');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.provider, 'cashfree');
  assert.equal(r.body.mode, 'sandbox');
  assert.equal(r.body.amount, 29900);
  assert.match(r.body.payment_session_id, /^session_/);
  assert.match(r.body.order_id, /^ttd_[0-9a-f]{32}$/);
  assert.match(r.body.purchase_token, /^[A-Za-z0-9_-]{43}$/);
  const cf = w.cfOrders[r.body.order_id];
  assert.equal(cf.order_amount, 299);
  assert.equal(cf.customer_details.customer_phone, '9999999999');
  assert.equal(cf.customer_details.customer_email, 'Buyer+ttd@example.com');
  assert.match(cf.order_meta.notify_url, /\/api\/cashfree-webhook$/);
  const order = w.tables.orders[0];
  assert.equal(order.razorpay_order_id, r.body.order_id);
  assert.equal(order.razorpay_mode, 'test');
  assert.notEqual(order.purchase_token_hash, r.body.purchase_token);
});

test('cashfree returns the buyer to the site domain they started on; the webhook stays on the app origin', async (t) => {
  quiet(t);
  const w = world(t);
  const fromNew = await post(checkout, { plan: '7d', request_id: randomUUID(), email: 'a@example.com', activate: false }, { origin: 'https://ttd-autofill.com' });
  assert.equal(fromNew.statusCode, 200);
  const first = w.cfOrders[fromNew.body.order_id].order_meta;
  assert.match(first.return_url, /^https:\/\/ttd-autofill\.com\/pass\/success\?plan=7d/);
  assert.match(first.notify_url, /^https:\/\/ttd-info\.vercel\.app\/api\/cashfree-webhook$/);
  const fromOld = await start('7d');
  assert.match(w.cfOrders[fromOld.body.order_id].order_meta.return_url, /^https:\/\/ttd-info\.vercel\.app\/pass\/success\?plan=7d/);
});

test('cashfree sells several passes on one key at the tiered price', async (t) => {
  quiet(t);
  const w = world(t);
  const { priceFor } = await import('../api/_pricing.mjs');
  const { planByCode } = await import('../api/_dodo.mjs');
  const expected = priceFor(planByCode('7d'), 5);
  const r = await start('7d', randomUUID(), { quantity: 5 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.quantity, 5);
  assert.equal(r.body.amount, expected.total);
  assert.ok(expected.discountPct > 0 && r.body.amount < 5 * 9900);
  const order = w.tables.orders[0];
  assert.equal(order.quantity, 5);
  assert.equal(order.amount_paise, expected.total);
  assert.equal(w.cfOrders[r.body.order_id].order_amount, expected.total / 100);
  const bad = await start('7d', randomUUID(), { quantity: 51 });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error, 'invalid_quantity');
});

test('cashfree checkout needs a valid email; the buyer is never asked for a phone number', async (t) => {
  quiet(t);
  const w = world(t);
  assert.equal((await start('7d', randomUUID(), { email: 'nope' })).statusCode, 400);
  const ok = await start('7d', randomUUID(), { phone: '12345' });
  assert.equal(ok.statusCode, 200);
  // Whatever the page sends, Cashfree only ever gets the placeholder number.
  assert.equal(w.cfOrders[ok.body.order_id].customer_details.customer_phone, '9999999999');
});

test('re-opening the same checkout reuses the Cashfree order and issues a fresh token', async (t) => {
  quiet(t);
  const w = world(t);
  const id = randomUUID();
  const first = await start('7d', id);
  const second = await start('7d', id);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.order_id, first.body.order_id);
  assert.equal(second.body.payment_session_id, first.body.payment_session_id);
  assert.notEqual(second.body.purchase_token, first.body.purchase_token);
  assert.equal(Object.keys(w.cfOrders).length, 1);
});

// ---- confirm --------------------------------------------------------------
test('payment-confirm fulfils a paid Cashfree order and is idempotent', async (t) => {
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
  assert.equal(w.tables.licence_authority[0].source, 'cashfree');
  assert.equal(w.tables.licence_authority[0].authority, 'keygen');
  // The invoice names Cashfree, not the Razorpay fallback.
  assert.equal(w.tables.invoices.length, 1);
  assert.equal(w.tables.invoices[0].payment_method, 'Cashfree');
});

test('a wrong token, a short payment or a failed payment never fulfils', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  w.pay(c.order_id, { amount: 1 });
  w.pay(c.order_id, { status: 'FAILED' });
  w.pay(c.order_id, { status: 'USER_DROPPED' });
  const bad = await post(confirm, { razorpay_order_id: c.order_id, purchase_token: 'A'.repeat(43) });
  assert.equal(bad.statusCode, 403);
  const short = await post(confirm, { razorpay_order_id: c.order_id, purchase_token: c.purchase_token });
  assert.equal(short.statusCode, 202);
  assert.equal(w.licenses.length, 0);
});

// ---- webhook --------------------------------------------------------------
test('a signed PAYMENT_SUCCESS webhook fulfils the order once, even when delivered twice', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  const p = w.pay(c.order_id);
  assert.equal((await hook(successEvent(c.order_id, p))).statusCode, 200);
  assert.equal((await hook(successEvent(c.order_id, p))).statusCode, 200);
  assert.equal(w.licenses.length, 1);
  assert.equal(w.tables.orders[0].status, 'fulfilled');
  assert.equal(w.tables.orders[0].razorpay_payment_id, String(p.cf_payment_id));
  assert.equal(w.tables.payment_events.length, 1);
});

test('a webhook with a bad signature is rejected; a claimed payment Cashfree does not confirm fulfils nothing', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  const forged = await hook(successEvent(c.order_id, { cf_payment_id: 1 }), { secret: 'other' });
  assert.equal(forged.statusCode, 400);
  // Correctly signed, but Cashfree's API shows no successful payment.
  const unpaid = await hook(successEvent(c.order_id, { cf_payment_id: 1 }));
  assert.equal(unpaid.statusCode, 200);
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

test('config reports cashfree with multi-pass pricing', async (t) => {
  quiet(t);
  const r = res();
  config({ method: 'GET', headers: { origin: 'https://ttd-info.vercel.app' } }, r);
  assert.equal(r.body.payment_provider, 'cashfree');
  assert.ok(r.body.bulk && r.body.bulk.tiers.length);
});

test('a production key cannot run against the sandbox, or a test key against production', async (t) => {
  quiet(t);
  const { cashfreeConfig } = await import('../api/_cashfree.mjs');
  const save = { id: process.env.CASHFREE_APP_ID, mode: process.env.CASHFREE_MODE };
  try {
    process.env.CASHFREE_APP_ID = 'prodkey123';
    assert.throws(() => cashfreeConfig());
    process.env.CASHFREE_MODE = 'production';
    assert.equal(cashfreeConfig().base, 'https://api.cashfree.com/pg');
    process.env.CASHFREE_APP_ID = 'TEST123abc';
    assert.throws(() => cashfreeConfig());
  } finally {
    process.env.CASHFREE_APP_ID = save.id; process.env.CASHFREE_MODE = save.mode;
  }
});
