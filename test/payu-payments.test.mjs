import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';

process.env.PAYMENT_PROVIDER = 'payu';
process.env.PAYU_MERCHANT_KEY = 'PUTESTKEY';
process.env.PAYU_MERCHANT_SALT = 'pu-test-salt';
process.env.PAYU_MODE = 'test';
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
const webhook = (await import('../api/payu-webhook.mjs')).default;
const payuReturn = (await import('../api/payu-return.mjs')).default;
const reconcile = (await import('../api/payments-reconcile.mjs')).default;
const config = (await import('../api/config.mjs')).default;
const { payuRequestHash, payuResponseHash } = await import('../api/_payu.mjs');

const sha512 = (v) => createHash('sha512').update(v).digest('hex');

// ---- in-memory world: PostgREST subset, PhonePe, Keygen -------------------
function world(t) {
  const w = { tables: { orders: [], payment_events: [], fulfilments: [], email_outbox: [], licence_authority: [], invoices: [] }, invoiceSeq: 0,
    txns: {}, verifyCalls: 0, licenses: [], emails: [], resendStatus: [], keygenDown: false, keygenLoseResponse: false, calls: [] };
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
    if (u.host === 'test.payu.in' && u.pathname === '/merchant/postservice.php') {
      const form = new URLSearchParams(opts.body);
      assert.equal(form.get('key'), 'PUTESTKEY');
      assert.equal(form.get('command'), 'verify_payment');
      assert.equal(form.get('hash'), sha512(['PUTESTKEY', 'verify_payment', form.get('var1'), 'pu-test-salt'].join('|')));
      w.verifyCalls++;
      const details = {};
      for (const id of form.get('var1').split('|')) details[id] = w.txns[id] || { status: 'Not Found' };
      return json({ status: 1, msg: 'Transactions Fetched', transaction_details: details });
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
  w.pay = (txnid, { amount, status = 'success', mode = 'UPI' } = {}) => {
    const order = w.tables.orders.find((o) => o.razorpay_order_id && txnid.startsWith(o.razorpay_order_id.replace(/_a\d+$/, '')));
    w.txns[txnid] = { txnid, status, mode, mihpayid: '40' + randomBytes(5).toString('hex'), amt: amount != null ? amount : (order.amount_paise / 100).toFixed(2) };
    return w.txns[txnid];
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
// PayU's webhook/redirect post: the checkout fields plus status, signed with the reverse hash.
function signedResult(fields, { status = 'success', salt = 'pu-test-salt', extra = {} } = {}) {
  const result = { ...fields, status, mihpayid: '403993715' + randomBytes(3).toString('hex'), mode: 'UPI', ...extra };
  delete result.hash;
  return { ...result, hash: payuResponseHash(result, salt) };
}
async function hook(fields, { raw = false } = {}) {
  const encoded = new URLSearchParams(fields).toString();
  const req = raw ? Readable.from([Buffer.from(encoded)]) : { body: fields };
  req.method = 'POST';
  req.headers = { 'content-type': 'application/x-www-form-urlencoded' };
  const r = res();
  await webhook(req, r);
  return r;
}
const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {}); };
const start = (plan = '7d', requestId = randomUUID(), extra = {}) =>
  post(checkout, { plan, request_id: requestId, email: 'Buyer+ttd@Example.COM', activate: false, ...extra });

// ---- checkout -------------------------------------------------------------
test('payu checkout returns a signed hosted-checkout form for a server-priced order', async (t) => {
  quiet(t);
  const w = world(t);
  const r = await start('30d');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.provider, 'payu');
  assert.equal(r.body.mode, 'test');
  assert.equal(r.body.action, 'https://test.payu.in/_payment');
  assert.equal(r.body.bolt, 'https://jssdk-uat.payu.in/bolt/bolt.min.js');
  assert.match(r.body.order_id, /^pu_[0-9a-f]{18}$/);
  const f = r.body.fields;
  assert.equal(f.key, 'PUTESTKEY');
  assert.equal(f.txnid, r.body.order_id);
  assert.equal(f.amount, '299.00');
  assert.equal(f.email, 'Buyer+ttd@example.com');
  assert.equal(f.phone, '9999999999');
  assert.equal(f.hash, payuRequestHash(f, 'pu-test-salt'));
  assert.equal(f.hash, sha512(`PUTESTKEY|${f.txnid}|299.00|${f.productinfo}|Customer|${f.email}|||||||||||pu-test-salt`));
  assert.ok(!JSON.stringify(r.body).includes('pu-test-salt'), 'the salt never leaves the server');
  assert.match(f.surl, /^https:\/\/ttd-info\.vercel\.app\/api\/payu-return\?plan=30d&result=ok$/);
  assert.match(f.furl, /result=failed$/);
  const order = w.tables.orders[0];
  assert.equal(order.razorpay_order_id, r.body.order_id);
  assert.equal(order.razorpay_mode, 'test');
});

test('payu passes the optional mobile to PayU and refuses a bad one', async (t) => {
  quiet(t);
  world(t);
  const r = await start('7d', randomUUID(), { phone: '+91 98765 43210' });
  assert.equal(r.body.fields.phone, '9876543210');
  const bad = await start('7d', randomUUID(), { phone: '12345' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error, 'invalid_phone');
  assert.equal((await start('7d', randomUUID(), { email: 'nope' })).statusCode, 400);
});

test('payu returns the buyer to the site domain they started on', async (t) => {
  quiet(t);
  world(t);
  const fromNew = await post(checkout, { plan: '7d', request_id: randomUUID(), email: 'a@example.com', activate: false }, { origin: 'https://ttd-autofill.com' });
  assert.match(fromNew.body.fields.surl, /^https:\/\/ttd-autofill\.com\/api\/payu-return\?plan=7d/);
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'ttd-info-keygen.vercel.app';
  try {
    const staging = await post(checkout, { plan: '7d', request_id: randomUUID(), email: 'a@example.com', activate: false }, { origin: 'https://ttd-info-keygen.vercel.app' });
    assert.match(staging.body.fields.surl, /^https:\/\/ttd-info-keygen\.vercel\.app\/api\/payu-return\?plan=7d/);
  } finally { delete process.env.VERCEL_PROJECT_PRODUCTION_URL; }
});

test('payu sells several passes on one key at the tiered price', async (t) => {
  quiet(t);
  const w = world(t);
  const { priceFor } = await import('../api/_pricing.mjs');
  const { planByCode } = await import('../api/_dodo.mjs');
  const expected = priceFor(planByCode('7d'), 5);
  const r = await start('7d', randomUUID(), { quantity: 5 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.fields.amount, (expected.total / 100).toFixed(2));
  assert.equal(w.tables.orders[0].quantity, 5);
});

test('re-opening payu checkout uses a new txnid and a payment on the old one still fulfils', async (t) => {
  quiet(t);
  const w = world(t);
  const id = randomUUID();
  const first = await start('7d', id);
  const second = await start('7d', id);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.order_id, first.body.order_id + '_a1');
  assert.ok(second.body.order_id.length <= 25);
  w.pay(first.body.order_id);
  const r = await post(confirm, { razorpay_order_id: second.body.order_id, purchase_token: first.body.purchase_token });
  assert.equal(r.statusCode, 200);
  assert.match(r.body.license_key, /^TTD-/);
  assert.equal((await start('7d', id)).body.error, 'already_paid');
});

// ---- confirm --------------------------------------------------------------
test('payment-confirm fulfils a PayU order only once the verify API says success', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  assert.equal((await post(confirm, { razorpay_order_id: c.order_id, purchase_token: c.purchase_token })).statusCode, 202);
  const txn = w.pay(c.order_id);
  const a = await post(confirm, { razorpay_order_id: c.order_id, purchase_token: c.purchase_token });
  const b = await post(confirm, { razorpay_order_id: c.order_id, purchase_token: c.purchase_token });
  assert.equal(a.statusCode, 200);
  assert.equal(b.body.license_key, a.body.license_key);
  assert.equal(w.licenses.length, 1);
  assert.equal(w.tables.orders[0].status, 'fulfilled');
  assert.equal(w.tables.orders[0].razorpay_payment_id, txn.mihpayid);
  assert.equal(w.tables.licence_authority[0].source, 'payu');
});

test('a wrong token, a short amount or a failed PayU payment never fulfils', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  assert.equal((await post(confirm, { razorpay_order_id: c.order_id, purchase_token: 'A'.repeat(43) })).statusCode, 403);
  w.pay(c.order_id, { amount: '1.00' });
  assert.equal((await post(confirm, { razorpay_order_id: c.order_id, purchase_token: c.purchase_token })).statusCode, 202);
  w.pay(c.order_id, { status: 'failure' });
  assert.equal((await post(confirm, { razorpay_order_id: c.order_id, purchase_token: c.purchase_token })).statusCode, 202);
  w.pay(c.order_id, { status: 'pending' });
  assert.equal((await post(confirm, { razorpay_order_id: c.order_id, purchase_token: c.purchase_token })).statusCode, 202);
  assert.equal(w.licenses.length, 0);
});

// ---- webhook --------------------------------------------------------------
test('a correctly signed PayU webhook fulfils once, even when delivered twice or as a raw body', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  const txn = w.pay(c.order_id);
  const event = signedResult(c.fields, { extra: { mihpayid: txn.mihpayid } });
  assert.equal((await hook(event)).statusCode, 200);
  assert.equal((await hook(event, { raw: true })).statusCode, 200);
  assert.equal(w.licenses.length, 1);
  assert.equal(w.tables.orders[0].status, 'fulfilled');
  assert.equal(w.tables.payment_events.length, 1);
  assert.equal(w.tables.payment_events[0].payload.hash, undefined);
});

test('a webhook for an older attempt still finds the order', async (t) => {
  quiet(t);
  const w = world(t);
  const id = randomUUID();
  const first = (await start('7d', id)).body;
  await start('7d', id);
  w.pay(first.order_id);
  assert.equal((await hook(signedResult(first.fields))).statusCode, 200);
  assert.equal(w.tables.orders[0].status, 'fulfilled');
});

test('a forged or tampered PayU webhook is rejected; a signed one PayU does not confirm fulfils nothing', async (t) => {
  quiet(t);
  const w = world(t);
  const c = (await start()).body;
  assert.equal((await hook(signedResult(c.fields, { salt: 'wrong-salt' }))).statusCode, 401);
  const tampered = signedResult(c.fields);
  tampered.amount = '1.00';
  assert.equal((await hook(tampered)).statusCode, 401);
  assert.equal((await hook({ txnid: c.order_id, status: 'success' })).statusCode, 401);
  // Correctly signed, but the verify API has no success for it.
  assert.equal((await hook(signedResult(c.fields))).statusCode, 200);
  assert.equal(w.licenses.length, 0);
  assert.equal(w.tables.orders[0].status, 'created');
});

test('the response hash puts additionalCharges first when PayU adds them', () => {
  const f = { key: 'K', txnid: 't', amount: '99.00', productinfo: 'p', firstname: 'Customer', email: 'e@x.in', status: 'success' };
  assert.equal(payuResponseHash(f, 'S'), sha512('S|success|||||||||||e@x.in|Customer|p|99.00|t|K'));
  assert.equal(payuResponseHash({ ...f, additionalCharges: '2.00' }, 'S'), sha512('2.00|S|success|||||||||||e@x.in|Customer|p|99.00|t|K'));
});

// ---- return, reconcile and config -----------------------------------------
test('payu-return turns PayU\'s POST into a redirect, success or failure', async (t) => {
  quiet(t);
  world(t);
  const go = (url) => { const r = res(); payuReturn({ method: 'POST', url, headers: {} }, r); return r; };
  const ok = go('/api/payu-return?plan=30d&extension_id=' + 'a'.repeat(32) + '&result=ok');
  assert.equal(ok.statusCode, 303);
  assert.equal(ok.headers.location, '/pass/success?plan=30d&extension_id=' + 'a'.repeat(32));
  assert.equal(go('/api/payu-return?plan=7d&result=failed').headers.location, '/pass?payment=failed');
  assert.equal(go('/api/payu-return?plan=evil&extension_id=x&result=ok').headers.location, '/pass/success?plan=7d');
});

test('reconcile finishes a paid PayU order whose webhook never arrived', async (t) => {
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

test('config reports payu with multi-pass pricing', async (t) => {
  quiet(t);
  const r = res();
  config({ method: 'GET', headers: { origin: 'https://ttd-info.vercel.app' } }, r);
  assert.equal(r.body.payment_provider, 'payu');
  assert.ok(r.body.bulk && r.body.bulk.tiers.length);
});

test('PayU stays on the test host unless PAYU_MODE is exactly production', async () => {
  const { payuConfig } = await import('../api/_payu.mjs');
  assert.equal(payuConfig().hosts.pay, 'https://test.payu.in/_payment');
  process.env.PAYU_MODE = 'live';
  try {
    assert.equal(payuConfig().live, false);
    process.env.PAYU_MODE = 'production';
    assert.equal(payuConfig().hosts.pay, 'https://secure.payu.in/_payment');
    assert.equal(payuConfig().hosts.api, 'https://info.payu.in/merchant/postservice.php?form=2');
  } finally { process.env.PAYU_MODE = 'test'; }
});
