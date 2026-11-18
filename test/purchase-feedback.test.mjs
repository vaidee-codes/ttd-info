import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';

process.env.TTD_LEDGER_URL = 'https://ledger.test';
process.env.TTD_LEDGER_SECRET_KEY = 'ledger-secret';
process.env.LEDGER_ENCRYPTION_KEY = randomBytes(32).toString('base64');
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;

const handler = (await import('../api/purchase-feedback.mjs')).default;

const TOKEN = 'a'.repeat(43);
const hash = (v) => createHash('sha256').update(v, 'utf8').digest('hex');

function ledger(t, orders, { down = false } = {}) {
  const w = { feedback: [], requests: [] };
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = new URL(String(url));
    w.requests.push({ method: opts.method || 'GET', path: u.pathname, query: u.searchParams, prefer: opts.headers?.Prefer });
    if (down) throw new Error('down');
    if (u.pathname === '/rest/v1/orders') {
      const id = (u.searchParams.get('razorpay_order_id') || '').replace(/^eq\./, '');
      return Response.json(orders.filter((o) => o.razorpay_order_id === id));
    }
    if (u.pathname === '/rest/v1/purchase_feedback' && opts.method === 'POST') {
      const row = JSON.parse(opts.body);
      w.feedback = w.feedback.filter((r) => r.order_id !== row.order_id).concat(row);
      return Response.json([row], { status: 201 });
    }
    return new Response('not found', { status: 404 });
  });
  return w;
}

async function call(body, headers = {}) {
  const res = { statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; },
    json(v) { this.body = v; return this; }, end() { return this; } };
  await handler({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }, res);
  return res;
}

const paid = { id: '11111111-1111-4111-8111-111111111111', razorpay_order_id: 'ttd_abc', status: 'fulfilled', purchase_token_hash: hash(TOKEN) };

test('a paid buyer can answer; answering again replaces the earlier answer', async (t) => {
  const w = ledger(t, [paid]);
  let res = await call({ razorpay_order_id: 'ttd_abc', purchase_token: TOKEN, other_temple: '  Srisailam\n Mallikarjuna ', heard_from: 'youtube', heard_from_detail: 'ignored unless other/friend' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(w.feedback.length, 1);
  assert.equal(w.feedback[0].order_id, paid.id);
  assert.equal(w.feedback[0].other_temple, 'Srisailam Mallikarjuna');
  assert.equal(w.feedback[0].heard_from, 'youtube');
  assert.equal(w.feedback[0].heard_from_detail, null);
  const post = w.requests.find((r) => r.method === 'POST');
  assert.equal(post.query.get('on_conflict'), 'order_id');
  assert.match(post.prefer, /resolution=merge-duplicates/);

  res = await call({ razorpay_order_id: 'ttd_abc', purchase_token: TOKEN, heard_from: 'friend', heard_from_detail: 'cousin' });
  assert.equal(res.statusCode, 200);
  assert.equal(w.feedback.length, 1);
  assert.equal(w.feedback[0].other_temple, null);
  assert.equal(w.feedback[0].heard_from_detail, 'cousin');
});

test('wrong token, unpaid order and unknown order are refused without writing', async (t) => {
  const w = ledger(t, [paid, { ...paid, id: '22222222-2222-4222-8222-222222222222', razorpay_order_id: 'ttd_new', status: 'created' }]);
  assert.equal((await call({ razorpay_order_id: 'ttd_abc', purchase_token: 'b'.repeat(43), heard_from: 'google' })).statusCode, 403);
  assert.equal((await call({ razorpay_order_id: 'ttd_zzz', purchase_token: TOKEN, heard_from: 'google' })).statusCode, 403);
  assert.equal((await call({ razorpay_order_id: 'ttd_new', purchase_token: TOKEN, heard_from: 'google' })).statusCode, 409);
  assert.equal(w.feedback.length, 0);
});

test('bad input is rejected before the ledger is touched', async (t) => {
  const w = ledger(t, [paid]);
  for (const body of [
    { razorpay_order_id: 'ttd_abc', purchase_token: TOKEN },
    { razorpay_order_id: 'ttd_abc', purchase_token: TOKEN, other_temple: '   ' },
    { razorpay_order_id: 'ttd_abc', purchase_token: TOKEN, heard_from: 'tv' },
    { razorpay_order_id: 'ttd_abc', purchase_token: TOKEN, other_temple: 'x'.repeat(301) },
    { razorpay_order_id: 'bad id!', purchase_token: TOKEN, heard_from: 'google' },
    { razorpay_order_id: 'ttd_abc', purchase_token: 'short', heard_from: 'google' }
  ]) {
    assert.equal((await call(body)).statusCode, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(w.requests.length, 0);
});

test('a ledger outage is a retryable 503, and foreign origins are refused', async (t) => {
  ledger(t, [paid], { down: true });
  assert.equal((await call({ razorpay_order_id: 'ttd_abc', purchase_token: TOKEN, heard_from: 'google' })).statusCode, 503);
  assert.equal((await call({ razorpay_order_id: 'ttd_abc', purchase_token: TOKEN, heard_from: 'google' }, { origin: 'https://evil.example' })).statusCode, 403);
});
