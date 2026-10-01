import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';

process.env.PAYMENT_PROVIDER = 'razorpay';
process.env.RAZORPAY_KEY_ID = 'rzp_test_abc123';
process.env.RAZORPAY_KEY_SECRET = 'test-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'wh-secret';
process.env.RAZORPAY_MODE = 'test';
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
const webhook = (await import('../api/razorpay-webhook.mjs')).default;
const reconcile = (await import('../api/payments-reconcile.mjs')).default;
const config = (await import('../api/config.mjs')).default;
const { openSecret } = await import('../api/_ledger.mjs');

// ---- in-memory world: PostgREST subset, Razorpay, Keygen -------------------
function world(t) {
  const w = { tables: { orders: [], payment_events: [], fulfilments: [], email_outbox: [], licence_authority: [], invoices: [] }, invoiceSeq: 0,
    rzpOrders: {}, payments: {}, licenses: [], emails: [], resendStatus: [], keygenDown: false, keygenLoseResponse: false, calls: [] };
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
    if (u.host === 'api.razorpay.com') {
      assert.equal(opts.headers.Authorization, 'Basic ' + Buffer.from('rzp_test_abc123:test-secret').toString('base64'));
      let m;
      if (u.pathname === '/v1/orders' && method === 'POST') {
        const o = { id: 'order_' + randomBytes(6).toString('hex'), amount: body.amount, currency: body.currency, receipt: body.receipt, status: 'created' };
        w.rzpOrders[o.id] = o;
        return json(o);
      }
      if ((m = u.pathname.match(/^\/v1\/orders\/([^/]+)\/payments$/))) return json({ items: Object.values(w.payments).filter((p) => p.order_id === m[1]) });
      if ((m = u.pathname.match(/^\/v1\/payments\/([^/]+)\/capture$/))) { w.payments[m[1]].status = 'captured'; return json(w.payments[m[1]]); }
      if ((m = u.pathname.match(/^\/v1\/payments\/([^/]+)$/))) return w.payments[m[1]] ? json(w.payments[m[1]]) : json({ error: { code: 'BAD_REQUEST_ERROR' } }, 400);
    }
    if (u.host === 'api.resend.com') {
      w.emails.push({ idem: opts.headers['Idempotency-Key'], body });
      const status = w.resendStatus.shift() || 200;
      return json(status === 200 ? { id: 'em_' + w.emails.length } : { name: 'error' }, status);
    }
    if (u.host === 'keygen.test') {
      if (w.keygenDown) throw new TypeError('fetch failed');
      const path = u.pathname.replace('/v1/accounts/acct-1', '');
      if (path === '/licenses' && method === 'POST') {
        const a = body.data.attributes;
        if (w.licenses.some((l) => l.key === a.key)) return json({ errors: [{ code: 'KEY_TAKEN' }] }, 422);
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
  w.pay = (rzpOrderId, { amount, status = 'captured', currency = 'INR', email = 'Buyer+ttd@Example.COM' } = {}) => {
    const o = w.rzpOrders[rzpOrderId];
    const p = { id: 'pay_' + randomBytes(6).toString('hex'), order_id: rzpOrderId, amount: amount ?? o.amount, currency, status, email };
    w.payments[p.id] = p;
    return { payment: p, signature: createHmac('sha256', 'test-secret').update(`${rzpOrderId}|${p.id}`).digest('hex') };
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
async function hook(event, { secret = 'wh-secret', eventId = randomUUID() } = {}) {
  const raw = Buffer.from(JSON.stringify(event));
  const req = Readable.from([raw]);
  req.method = 'POST';
  req.headers = { 'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'), 'x-razorpay-event-id': eventId };
  const r = res();
  await webhook(req, r);
  return r;
}
const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {}); };
const start = (plan = '7d', requestId = randomUUID(), email = 'Buyer+ttd@Example.COM') =>
  post(checkout, { plan, request_id: requestId, email, activate: false });

// ---- checkout -------------------------------------------------------------
test('razorpay checkout creates a server-priced INR order and a one-time purchase token', async (t) => {
  quiet(t);
  const w = world(t);
  const r = await start('30d');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.provider, 'razorpay');
  assert.equal(r.body.key_id, 'rzp_test_abc123');
  assert.equal(r.body.amount, 29900);
  assert.equal(r.body.email, 'Buyer+ttd@example.com');
  assert.equal(w.tables.orders[0].email, 'Buyer+ttd@example.com');
  assert.match(r.body.purchase_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(w.rzpOrders[r.body.razorpay_order_id].amount, 29900);
  const order = w.tables.orders[0];
  assert.equal(order.razorpay_order_id, r.body.razorpay_order_id);
  assert.notEqual(order.purchase_token_hash, r.body.purchase_token);
});

test('the same request_id re-uses its order; a different plan is refused', async (t) => {
  quiet(t);
  const w = world(t);
  const id = randomUUID();
  const a = await start('7d', id);
  const b = await start('7d', id);
  assert.equal(b.body.razorpay_order_id, a.body.razorpay_order_id);
  assert.equal(Object.keys(w.rzpOrders).length, 1);
  const c = await start('30d', id);
  assert.equal(c.statusCode, 409);
  const d = await start('7d', id, 'someone-else@example.com');
  assert.equal(d.statusCode, 409);
});

test('checkout requires a valid email', async (t) => {
  quiet(t);
  const w = world(t);
  assert.equal((await start('7d', randomUUID(), 'not-an-email')).statusCode, 400);
  assert.equal((await post(checkout, { plan: '7d', request_id: randomUUID(), activate: false })).statusCode, 400);
  assert.equal(w.tables.orders.length, 0);
});

// ---- confirm --------------------------------------------------------------
test('a verified, captured payment issues exactly one Keygen licence for the plan', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start('90d')).body;
  const { payment, signature } = w.pay(c.razorpay_order_id);
  const body = { razorpay_order_id: c.razorpay_order_id, razorpay_payment_id: payment.id, razorpay_signature: signature, purchase_token: c.purchase_token };
  const r = await post(confirm, body);
  assert.equal(r.statusCode, 200);
  assert.match(r.body.license_key, /^TTD-[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  assert.equal(w.licenses.length, 1);
  assert.equal(w.licenses[0].key, r.body.license_key);
  assert.equal(w.licenses[0].policy, 'pol-90');
  assert.equal(w.licenses[0].metadata.publicProductId, 'pdt_0NkvjEr1l8rhSF6Ibxlj3');
  assert.equal(w.licenses[0].metadata.source, 'razorpay');
  assert.equal(w.tables.orders[0].status, 'fulfilled');
  assert.equal(w.tables.orders[0].email, 'Buyer+ttd@example.com');
  assert.equal(w.licenses[0].metadata.email, 'Buyer+ttd@example.com');
  assert.equal(w.tables.email_outbox[0].to_email, 'Buyer+ttd@example.com');
  assert.equal(w.tables.licence_authority[0].authority, 'keygen');
  assert.equal(w.tables.email_outbox.length, 1);
  assert.notEqual(w.tables.fulfilments[0].license_key_enc, r.body.license_key);
  assert.equal(openSecret(w.tables.fulfilments[0].license_key_enc), r.body.license_key);

  const again = await post(confirm, body);
  assert.equal(again.body.license_key, r.body.license_key);
  assert.equal(w.licenses.length, 1);
  assert.equal(w.tables.email_outbox.length, 1);
});

test('a forged signature or someone else\'s purchase token gets nothing', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  const { payment, signature } = w.pay(c.razorpay_order_id);
  const forged = await post(confirm, { razorpay_order_id: c.razorpay_order_id, razorpay_payment_id: payment.id, razorpay_signature: 'f'.repeat(64), purchase_token: c.purchase_token });
  assert.equal(forged.statusCode, 400);
  const wrongToken = await post(confirm, { razorpay_order_id: c.razorpay_order_id, razorpay_payment_id: payment.id, razorpay_signature: signature, purchase_token: 'x'.repeat(43) });
  assert.equal(wrongToken.statusCode, 403);
  assert.equal(w.licenses.length, 0);
});

test('an under-paid or foreign-currency payment never issues a licence', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start('30d')).body;
  const cheap = w.pay(c.razorpay_order_id, { amount: 100 });
  const r = await post(confirm, { razorpay_order_id: c.razorpay_order_id, razorpay_payment_id: cheap.payment.id, razorpay_signature: cheap.signature, purchase_token: c.purchase_token });
  assert.equal(r.statusCode, 202);
  const usd = w.pay(c.razorpay_order_id, { currency: 'USD' });
  await post(confirm, { razorpay_order_id: c.razorpay_order_id, razorpay_payment_id: usd.payment.id, razorpay_signature: usd.signature, purchase_token: c.purchase_token });
  assert.equal(w.licenses.length, 0);
  assert.equal(w.tables.orders[0].status, 'created');
});

test('an authorized (not yet captured) payment is captured, then fulfilled', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  const { payment, signature } = w.pay(c.razorpay_order_id, { status: 'authorized' });
  const r = await post(confirm, { razorpay_order_id: c.razorpay_order_id, razorpay_payment_id: payment.id, razorpay_signature: signature, purchase_token: c.purchase_token });
  assert.equal(r.statusCode, 200);
  assert.equal(w.payments[payment.id].status, 'captured');
});

// ---- webhook --------------------------------------------------------------
test('webhook: a closed-tab purchase is fulfilled from order.paid, once, even when redelivered', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  const { payment } = w.pay(c.razorpay_order_id);
  const event = { event: 'order.paid', created_at: 1, payload: { payment: { entity: payment }, order: { entity: { id: c.razorpay_order_id } } } };
  assert.equal((await hook(event, { eventId: 'evt_1' })).statusCode, 200);
  assert.equal((await hook(event, { eventId: 'evt_1' })).statusCode, 200);
  assert.equal(w.licenses.length, 1);
  assert.equal(w.tables.payment_events.length, 1);
  assert.equal(w.tables.orders[0].status, 'fulfilled');
  const later = await post(confirm, { razorpay_order_id: c.razorpay_order_id, purchase_token: c.purchase_token });
  assert.equal(later.body.license_key, w.licenses[0].key);
});

test('webhook: a bad signature is rejected and nothing is stored', async (t) => {
  quiet(t);
  const w = world(t);
  const r = await hook({ event: 'order.paid', payload: {} }, { secret: 'wrong' });
  assert.equal(r.statusCode, 400);
  assert.equal(w.tables.payment_events.length, 0);
});

test('webhook: refunds are recorded but do not touch the licence', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  const { payment, signature } = w.pay(c.razorpay_order_id);
  await post(confirm, { razorpay_order_id: c.razorpay_order_id, razorpay_payment_id: payment.id, razorpay_signature: signature, purchase_token: c.purchase_token });
  const r = await hook({ event: 'refund.processed', payload: { payment: { entity: { ...payment, status: 'refunded' } }, refund: { entity: { id: 'rfnd_1' } } } });
  assert.equal(r.statusCode, 200);
  assert.equal(w.tables.payment_events.length, 1);
  assert.equal(w.licenses.length, 1);
  assert.ok(!w.calls.some((c2) => c2.startsWith('PATCH keygen.test') || c2.includes('suspend')));
});

// ---- failure recovery -----------------------------------------------------
test('a Keygen outage leaves the paid order pending; reconcile finishes it with the same key', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  const { payment, signature } = w.pay(c.razorpay_order_id);
  w.keygenDown = true;
  const r = await post(confirm, { razorpay_order_id: c.razorpay_order_id, razorpay_payment_id: payment.id, razorpay_signature: signature, purchase_token: c.purchase_token });
  assert.equal(r.statusCode, 202);
  assert.equal(r.body.pending, true);
  assert.equal(w.tables.orders[0].status, 'paid');
  const sealed = w.tables.fulfilments[0].license_key_enc;

  w.keygenDown = false;
  w.tables.orders[0].created_at = new Date(Date.now() - 10 * 60e3).toISOString();
  const cron = res();
  await reconcile({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, cron);
  assert.equal(cron.body.fulfilled, 1);
  assert.equal(w.licenses.length, 1);
  assert.equal(w.licenses[0].key, openSecret(sealed));
});

test('a Keygen create whose response was lost is recovered without a second licence', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  const { payment, signature } = w.pay(c.razorpay_order_id);
  w.keygenLoseResponse = true;
  const body = { razorpay_order_id: c.razorpay_order_id, razorpay_payment_id: payment.id, razorpay_signature: signature, purchase_token: c.purchase_token };
  assert.equal((await post(confirm, body)).statusCode, 202);
  const r = await post(confirm, body);
  assert.equal(r.statusCode, 200);
  assert.equal(w.licenses.length, 1);
  assert.equal(r.body.license_key, w.licenses[0].key);
});

test('reconcile requires the cron secret', async (t) => {
  quiet(t);
  world(t);
  const r = res();
  await reconcile({ method: 'GET', headers: { authorization: 'Bearer nope' } }, r);
  assert.equal(r.statusCode, 401);
});

test('a live Razorpay key is refused unless RAZORPAY_MODE=live', async (t) => {
  quiet(t);
  world(t);
  process.env.RAZORPAY_KEY_ID = 'rzp_live_xyz';
  try {
    const r = await start();
    assert.equal(r.statusCode, 503);
  } finally {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc123';
  }
});

test('config tells the pass page which payment provider is active', async () => {
  const r = res();
  await config({ method: 'GET', headers: { origin: 'https://ttd-info.vercel.app' } }, r);
  assert.equal(r.body.payment_provider, 'razorpay');
});

// ---- email ----------------------------------------------------------------
async function paidOrder(w) {
  const c = (await start('30d', randomUUID(), 'buyer@example.com')).body;
  const { payment, signature } = w.pay(c.razorpay_order_id, { email: 'void@razorpay.com' });
  return post(confirm, { razorpay_order_id: c.razorpay_order_id, razorpay_payment_id: payment.id, razorpay_signature: signature, purchase_token: c.purchase_token });
}

test('email: the licence key is emailed once, with an idempotency key, after fulfilment', async (t) => {
  quiet(t);
  process.env.RESEND_API_KEY = 're_test'; process.env.RESEND_FROM = 'TTD Autofill <keys@example.com>';
  try {
    const w = world(t);
    const r = await paidOrder(w);
    assert.equal(w.emails.length, 1);
    assert.deepEqual(w.emails[0].body.to, ['buyer@example.com']);
    assert.match(w.emails[0].body.text, new RegExp(r.body.license_key));
    assert.match(w.emails[0].body.subject, /30-day pass/);
    assert.equal(w.emails[0].idem, 'licence_key/' + w.tables.orders[0].id);
    assert.equal(w.tables.invoices.length, 1);
    assert.match(w.tables.invoices[0].number, /^TTDA\/\d{4}-\d{2}\/0001$/);
    assert.equal(w.tables.invoices[0].amount_paise, 29900);
    // One email: key + purchase summary, no attachment (Razorpay sends its own receipt).
    assert.equal(w.emails[0].body.attachments, undefined);
    assert.match(w.emails[0].body.text, /Paid: ₹299\.00/);
    assert.match(w.emails[0].body.text, /Invoice no\.: TTDA\//);
    assert.match(w.emails[0].body.html, /Your licence key is ready to use\./);
    assert.match(w.emails[0].body.html, /Payment details/);
    assert.match(w.emails[0].body.html, new RegExp(r.body.license_key));
    assert.equal(w.tables.email_outbox[0].status, 'sent');
    await paidOrder(w).catch(() => {});
    const cron = res();
    await reconcile({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, cron);
    assert.equal(w.emails.filter((e) => e.idem === 'licence_key/' + w.tables.orders[0].id).length, 1);
  } finally { delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM; }
});

test('email: a Resend outage is retried by the reconcile job; a rejected address is not', async (t) => {
  quiet(t);
  process.env.RESEND_API_KEY = 're_test'; process.env.RESEND_FROM = 'TTD Autofill <keys@example.com>';
  try {
    const w = world(t);
    w.resendStatus = [503];
    await paidOrder(w);
    assert.equal(w.tables.email_outbox[0].status, 'queued');
    assert.equal(w.tables.email_outbox[0].attempts, 1);
    assert.ok(Date.parse(w.tables.email_outbox[0].next_attempt_at) > Date.now() + 4 * 60e3, 'next try about 5 min later');
    await reconcile({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, res());
    assert.equal(w.tables.email_outbox[0].status, 'queued', 'not retried before it is due');
    w.tables.email_outbox[0].next_attempt_at = new Date(Date.now() - 1000).toISOString();
    await reconcile({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, res());
    assert.equal(w.tables.email_outbox[0].status, 'sent');

    w.resendStatus = [422];
    await paidOrder(w);
    assert.equal(w.tables.email_outbox[1].status, 'failed');
  } finally { delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM; }
});

test('email: without Resend configured the row simply waits in the outbox', async (t) => {
  quiet(t);
  const w = world(t);
  await paidOrder(w);
  assert.equal(w.emails.length, 0);
  assert.equal(w.tables.email_outbox[0].status, 'queued');
  assert.equal(w.tables.email_outbox[0].attempts, 0);
});

test('the email typed on our page wins; Razorpay\'s placeholder is never used as the buyer', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start('7d', randomUUID(), 'real.buyer@example.com')).body;
  const { payment, signature } = w.pay(c.razorpay_order_id, { email: 'void@razorpay.com' });
  const r = await post(confirm, { razorpay_order_id: c.razorpay_order_id, razorpay_payment_id: payment.id, razorpay_signature: signature, purchase_token: c.purchase_token });
  assert.equal(r.statusCode, 200);
  assert.equal(w.tables.orders[0].email, 'real.buyer@example.com');
  assert.equal(w.licenses[0].metadata.email, 'real.buyer@example.com');
  assert.equal(w.tables.email_outbox[0].to_email, 'real.buyer@example.com');
});

// ---- multi-pass ------------------------------------------------------------
test('multi-pass: 5 × 7-day passes cost ₹421 (15% off), and the one key works on 5 browsers', async (t) => {
  quiet(t);
  process.env.RESEND_API_KEY = 're_test'; process.env.RESEND_FROM = 'TTD Autofill <keys@example.com>';
  try {
    const w = world(t);
    const c = await post(checkout, { plan: '7d', request_id: randomUUID(), email: 'group@example.com', quantity: 5, activate: false });
    assert.equal(c.statusCode, 200);
    assert.deepEqual([c.body.amount, c.body.quantity, c.body.discount_pct], [42100, 5, 15]);
    assert.equal(w.rzpOrders[c.body.razorpay_order_id].amount, 42100);
    const { payment, signature } = w.pay(c.body.razorpay_order_id);
    const r = await post(confirm, { razorpay_order_id: c.body.razorpay_order_id, razorpay_payment_id: payment.id, razorpay_signature: signature, purchase_token: c.body.purchase_token });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.quantity, 5);
    assert.equal(w.licenses.length, 1);
    assert.equal(w.licenses[0].maxMachines, 5);
    assert.equal(w.tables.invoices[0].quantity, 5);
    assert.equal(w.tables.invoices[0].discount_pct, 15);
    assert.equal(w.tables.invoices[0].amount_paise, 42100);
    assert.match(w.emails[0].body.text, /5 browsers/);
  } finally { delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM; }
});

test('multi-pass: quantity is validated, fixed per checkout, and fully paid', async (t) => {
  quiet(t);
  const w = world(t);
  for (const q of [0, 51, 2.5, 'lots']) {
    assert.equal((await post(checkout, { plan: '30d', request_id: randomUUID(), email: 'g@example.com', quantity: q, activate: false })).statusCode, 400, String(q));
  }
  const id = randomUUID();
  const a = await post(checkout, { plan: '30d', request_id: id, email: 'g@example.com', quantity: 3, activate: false });
  assert.equal(a.body.amount, 80700, JSON.stringify(a.body));
  assert.equal((await post(checkout, { plan: '30d', request_id: id, email: 'g@example.com', quantity: 4, activate: false })).statusCode, 409);
  const cheap = w.pay(a.body.razorpay_order_id, { amount: 29900 });
  const r = await post(confirm, { razorpay_order_id: a.body.razorpay_order_id, razorpay_payment_id: cheap.payment.id, razorpay_signature: cheap.signature, purchase_token: a.body.purchase_token });
  assert.equal(r.statusCode, 202);
  assert.equal(w.licenses.length, 0);
});

test('SES is used when configured, builds a MIME message with the invoice, and falls back to Resend on a definite refusal', async () => {
  const email = await import('../api/_email.mjs');
  const mime = email.buildMime({ from: 'TTD Autofill <keys@example.com>', to: 'a@example.com', replyTo: 'r@example.com', subject: 'Key – ₹99',
    text: 'hello', html: '<p>hello</p>', attachments: [{ filename: 'invoice-TTDA-2026-27-0001.pdf', content: Buffer.from('%PDF').toString('base64') }], boundary: 'B' });
  assert.match(mime, /Subject: =\?UTF-8\?B\?/);
  assert.match(mime, /Content-Disposition: attachment; filename="invoice-TTDA-2026-27-0001.pdf"/);
  assert.match(mime, /--B--\r\n$/);

  process.env.SES_ACCESS_KEY_ID = 'AKIATEST'; process.env.SES_SECRET_ACCESS_KEY = 'secret'; process.env.SES_FROM = 'TTD Autofill <keys@example.com>';
  const sent = [];
  try {
    assert.deepEqual(email.emailProviders(), ['ses', 'resend', 'brevo']);
    email.setSesSenderForTests(async (input) => { sent.push(input); return { MessageId: 'm1' }; });
    const ok = await email.sendEmail({ to: 'a@example.com', subject: 's', text: 't', html: 'h', idempotencyKey: 'k' });
    assert.deepEqual([ok.ok, ok.provider], [true, 'ses']);
    assert.deepEqual(sent[0].Destination.ToAddresses, ['a@example.com']);

    // A definite SES refusal with Resend configured → Resend.
    email.setSesSenderForTests(async () => { throw Object.assign(new Error('x'), { name: 'MessageRejected', $metadata: { httpStatusCode: 400 } }); });
    process.env.RESEND_API_KEY = 're_test'; process.env.RESEND_FROM = 'TTD Autofill <keys@example.com>';
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{"id":"r1"}', { status: 200 });
    try {
      const fb = await email.sendEmail({ to: 'a@example.com', subject: 's', text: 't', html: 'h', idempotencyKey: 'k' });
      assert.deepEqual([fb.ok, fb.provider, fb.fallbackFrom], [true, 'resend', 'ses:400:MessageRejected']);
      // A network failure (SES may have sent it) → retry later, never a second provider.
      email.setSesSenderForTests(async () => { throw new Error('socket hang up'); });
      const net = await email.sendEmail({ to: 'a@example.com', subject: 's', text: 't', html: 'h', idempotencyKey: 'k' });
      assert.deepEqual([net.ok, net.retry, net.error], [false, true, 'ses:network']);
    } finally { globalThis.fetch = realFetch; }
  } finally {
    email.setSesSenderForTests(null);
    for (const k of ['SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY', 'SES_FROM', 'RESEND_API_KEY', 'RESEND_FROM']) delete process.env[k];
  }
});

test('email chain: SES → Resend → Brevo; daily limits fall through, and a network failure stops the chain', async () => {
  const email = await import('../api/_email.mjs');
  Object.assign(process.env, { SES_ACCESS_KEY_ID: 'AKIATEST', SES_SECRET_ACCESS_KEY: 'secret', SES_FROM: 'TTD Autofill <keys@example.com>',
    RESEND_API_KEY: 're_test', RESEND_FROM: 'TTD Autofill <keys@example.com>', BREVO_API_KEY: 'xkeysib-test' });
  const realFetch = globalThis.fetch;
  const calls = [];
  let resendStatus = 429;
  let brevoStatus = 201;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('resend')) return new Response('{"name":"daily_quota_exceeded"}', { status: resendStatus });
    if (String(url).includes('brevo')) { if (brevoStatus === 0) throw new Error('socket'); calls.brevoBody = JSON.parse(init.body); return new Response('{"messageId":"b1"}', { status: brevoStatus }); }
    throw new Error('unexpected ' + url);
  };
  const msg = { to: 'a@example.com', subject: 's', text: 't', html: 'h', idempotencyKey: 'k', attachments: [{ filename: 'invoice.pdf', content: 'JVBERg==' }] };
  try {
    email.setSesSenderForTests(async () => { throw Object.assign(new Error('x'), { name: 'MessageRejected', $metadata: { httpStatusCode: 400 } }); });
    const viaBrevo = await email.sendEmail(msg);
    assert.deepEqual([viaBrevo.ok, viaBrevo.provider], [true, 'brevo']);
    assert.match(viaBrevo.fallbackFrom, /ses:400:MessageRejected;429:daily_quota_exceeded/);
    assert.deepEqual(calls.brevoBody.sender, { name: 'TTD Autofill', email: 'keys@example.com' });
    assert.deepEqual(calls.brevoBody.attachment, [{ name: 'invoice.pdf', content: 'JVBERg==' }]);

    // Every provider out of daily credits → retry later (not a permanent failure).
    brevoStatus = 402;
    const allFull = await email.sendEmail(msg);
    assert.deepEqual([allFull.ok, allFull.retry], [false, true]);

    // Every provider permanently refuses → no retry.
    resendStatus = 422; brevoStatus = 400;
    const refused = await email.sendEmail(msg);
    assert.deepEqual([refused.ok, refused.retry], [false, false]);

    // Brevo network failure → retry later.
    resendStatus = 422; brevoStatus = 0;
    const net = await email.sendEmail(msg);
    assert.deepEqual([net.ok, net.retry], [false, true]);

    // Provider order is configurable.
    process.env.EMAIL_PROVIDERS = 'brevo,resend';
    assert.deepEqual(email.emailProviders(), ['brevo', 'resend']);
  } finally {
    globalThis.fetch = realFetch;
    email.setSesSenderForTests(null);
    for (const k of ['SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY', 'SES_FROM', 'RESEND_API_KEY', 'RESEND_FROM', 'BREVO_API_KEY', 'EMAIL_PROVIDERS']) delete process.env[k];
  }
});

test('outbox backoff: 5 min doubling, capped at 3 h', async () => {
  const { nextAttemptDelay } = await import('../api/_email.mjs');
  assert.deepEqual([1, 2, 3, 6, 7, 20].map((n) => nextAttemptDelay(n) / 60e3), [5, 10, 20, 160, 180, 180]);
});

test('email: daily limits do not lose an email — it keeps retrying the next day and only gives up after 7 days', async (t) => {
  quiet(t);
  process.env.RESEND_API_KEY = 're_test'; process.env.RESEND_FROM = 'TTD Autofill <keys@example.com>';
  try {
    const w = world(t);
    w.resendStatus = [429];
    await paidOrder(w);
    const row = w.tables.email_outbox[0];
    // 20 failed attempts over a day: still queued.
    for (let i = 0; i < 20; i++) {
      w.resendStatus = [429];
      row.next_attempt_at = new Date(Date.now() - 1000).toISOString();
      await reconcile({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, res());
    }
    assert.equal(row.status, 'queued');
    // Next day the limit has reset.
    row.next_attempt_at = new Date(Date.now() - 1000).toISOString();
    await reconcile({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, res());
    assert.equal(row.status, 'sent');

    // A row older than 7 days that still cannot be sent is finally marked failed.
    w.backdate = 8 * 24 * 3600e3;
    w.resendStatus = [429];
    await paidOrder(w);
    assert.equal(w.tables.email_outbox[1].status, 'failed');
  } finally { delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM; }
});

test('reconcile: 30 abandoned checkouts cannot hide a newer paid order whose webhook was missed', async (t) => {
  quiet(t);
  const w = world(t);
  const open = async () => {
    const r = await start('7d', randomUUID(), 'buyer@example.com');
    return w.tables.orders.find((o) => o.razorpay_order_id === r.body.razorpay_order_id);
  };
  w.backdate = 30 * 60e3;
  for (let i = 0; i < 30; i++) await open();
  const paidLater = await open();
  w.backdate = 0;
  w.payments.pay_late = { id: 'pay_late', order_id: paidLater.razorpay_order_id, amount: paidLater.amount_paise, currency: 'INR', status: 'captured' };
  // At most two runs (25 unpaid per run, least-recently-checked first).
  await reconcile({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, res());
  await reconcile({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, res());
  assert.equal(paidLater.status, 'fulfilled');
  assert.equal(w.licenses.length, 1);
});
