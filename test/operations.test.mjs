import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

process.env.TTD_LEDGER_URL = 'https://ledger.test';
process.env.TTD_LEDGER_SECRET_KEY = 'ledger-secret';
process.env.LEDGER_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.KEYGEN_API_URL = 'https://keygen.test';
process.env.KEYGEN_ACCOUNT_ID = 'acct-1';
process.env.KEYGEN_PRODUCT_TOKEN = 'prod-token';
process.env.KEYGEN_PRODUCT_ID = 'kg-product';
process.env.KEYGEN_PLAN_POLICIES = JSON.stringify({ '7d': 'pass-7', '30d': 'pass-30', '90d': 'pass-90' });
process.env.KEYGEN_GRANT_POLICIES = JSON.stringify({ '7d': 'grant-7', '30d': 'grant-30', '90d': 'grant-90' });
process.env.RESEND_API_KEY = 're_test';
process.env.RESEND_FROM = 'TTD Autofill <keys@example.com>';
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;

const login = (await import('../api/ops/login.mjs')).default;
const lookup = (await import('../api/ops/lookup.mjs')).default;
const offlineSale = (await import('../api/ops/offline-sale.mjs')).default;
const reset = (await import('../api/ops/reset-activations.mjs')).default;
const setLimit = (await import('../api/ops/set-activation-limit.mjs')).default;
const findKey = (await import('../api/find-key.mjs')).default;
const licenceAction = (await import('../api/ops/licence-action.mjs')).default;
const { sealSecret, licenceKeyHash } = await import('../api/_ledger.mjs');

const ADMIN = 'admin-token';
const USER = 'user-token';

function world(t) {
  const w = { tables: { offline_sales: [], audit_events: [], find_key_challenges: [], instance_alias: [], orders: [], fulfilments: [], licence_authority: [], invoices: [], email_outbox: [] }, invoiceSeq: 0,
    licenses: [], machines: [], emails: [] };
  const json = (v, s = 200) => new Response(JSON.stringify(v), { status: s, headers: { 'Content-Type': 'application/json' } });
  const uniques = { offline_sales: [['method', 'reference']], licence_authority: [['key_hash']], invoices: [['offline_sale_id']], email_outbox: [['kind', 'offline_sale_id']] };
  const match = (row, [k, v]) => {
    if (v.startsWith('eq.')) return String(row[k]) === v.slice(3);
    if (v === 'is.null') return row[k] == null;
    if (v.startsWith('gte.')) return row[k] >= v.slice(4);
    if (v.startsWith('gt.')) return row[k] > v.slice(3);
    return true;
  };
  const licDoc = (l) => ({ id: l.id, type: 'licenses', attributes: { key: l.key, status: l.status || 'ACTIVE', expiry: null, maxMachines: l.maxMachines || 1, metadata: l.metadata, created: l.created },
    relationships: { policy: { data: { type: 'policies', id: l.policy } } } });
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
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
      if (method === 'GET') {
        let out = rows.filter((r) => filters.every((f) => match(r, f)));
        if ((u.searchParams.get('order') || '').endsWith('.desc')) out = [...out].reverse();
        return json(out.slice(0, Number(u.searchParams.get('limit') || 1e9)));
      }
      if (method === 'POST') {
        const clash = (uniques[table] || []).some((cols) => rows.some((r) => cols.every((c) => r[c] === body[c])));
        if (clash) return json([]);
        const row = { id: table === 'audit_events' ? rows.length + 1 : randomUUID(), created_at: new Date().toISOString(),
          ...(table === 'offline_sales' ? { status: 'pending' } : {}), ...(table === 'email_outbox' ? { status: 'queued', attempts: 0 } : {}), ...(table === 'find_key_challenges' ? { attempts: 0, consumed_at: null } : {}), ...body };
        rows.push(row);
        return json([row], 201);
      }
      if (method === 'PATCH') {
        const hit = rows.filter((r) => filters.every((f) => match(r, f)));
        hit.forEach((r) => Object.assign(r, body));
        return json(hit);
      }
    }
    if (u.host === 'api.resend.com') { w.emails.push(body); return json({ id: 'em' }); }
    if (u.host === 'keygen.test') {
      const path = u.pathname.replace('/v1/accounts/acct-1', '');
      const auth = opts.headers.Authorization;
      if (path === '/me') {
        if (auth === 'Bearer ' + ADMIN) return json({ data: { id: 'admin-1', type: 'users', attributes: { email: 'owner@example.com', role: 'admin' } } });
        if (auth === 'Bearer ' + USER) return json({ data: { id: 'user-1', type: 'users', attributes: { email: 'u@example.com', role: 'user' } } });
        return json({ errors: [{ code: 'TOKEN_INVALID' }] }, 401);
      }
      if (path === '/tokens' && method === 'POST') {
        const [email, password] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
        if (email === 'owner@example.com' && password === 'right') return json({ data: { attributes: { token: ADMIN, expiry: '2099-01-01T00:00:00Z' } } }, 201);
        if (email === 'u@example.com' && password === 'right') return json({ data: { attributes: { token: USER, expiry: '2099-01-01T00:00:00Z' } } }, 201);
        return json({ errors: [{ code: 'CREDENTIALS_INVALID' }] }, 401);
      }
      assert.equal(auth, 'Bearer prod-token');
      let m;
      if (path === '/licenses' && method === 'POST') {
        const a = body.data.attributes;
        if (w.licenses.some((l) => l.key === a.key)) return json({ errors: [{ code: 'KEY_TAKEN' }] }, 422);
        const l = { id: randomUUID(), key: a.key, metadata: a.metadata, maxMachines: a.maxMachines, policy: body.data.relationships.policy.data.id, created: new Date().toISOString() };
        w.licenses.push(l);
        return json({ data: licDoc(l) }, 201);
      }
      if (path === '/licenses' && method === 'GET') {
        const want = [...u.searchParams].filter(([k]) => k.startsWith('metadata['));
        return json({ data: w.licenses.filter((l) => want.every(([k, v]) => String(l.metadata[k.slice(9, -1)]) === v)).map(licDoc) });
      }
      if ((m = path.match(/^\/licenses\/([^/]+)$/))) {
        const l = w.licenses.find((x) => x.id === m[1]);
        if (l && method === 'PATCH') Object.assign(l, body.data.attributes);
        return l ? json({ data: licDoc(l) }) : json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
      }
      if (path === '/licenses/actions/validate-key') {
        const l = w.licenses.find((x) => x.key === body.meta.key);
        return json({ data: l ? licDoc(l) : null, meta: { valid: !!l, code: l ? 'VALID' : 'NOT_FOUND' } });
      }
      if (path === '/machines' && method === 'GET') {
        return json({ data: w.machines.filter((x) => x.license === u.searchParams.get('license')).map((x) => ({ id: x.id, type: 'machines', attributes: { name: x.name, created: 'now' } })) });
      }
      if ((m = path.match(/^\/machines\/([^/]+)$/)) && method === 'DELETE') {
        w.machines = w.machines.filter((x) => x.id !== m[1]);
        return new Response(null, { status: 204 });
      }
    }
    throw new Error('unexpected fetch ' + method + ' ' + url);
  });
  return w;
}

function res() {
  return { statusCode: 200, body: undefined, setHeader() {}, status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; }, end() { return this; } };
}
async function call(handler, body, token = ADMIN) {
  const r = res();
  await handler({ method: 'POST', body, headers: { origin: 'https://ttd-info.vercel.app', 'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(JSON.stringify(body))), ...(token ? { authorization: 'Bearer ' + token } : {}) } }, r);
  return r;
}
const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {}); };
const sale = (over = {}) => ({ plan: '30d', kind: 'paid', method: 'upi', reference: 'UTR123456789', amount_inr: 299, email: 'Walkin@Example.com', ...over });

// ---- access ---------------------------------------------------------------
test('ops: only Keygen admins can sign in or call operations', async (t) => {
  quiet(t);
  const w = world(t);
  const ok = await call(login, { email: 'owner@example.com', password: 'right' }, null);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.token, ADMIN);
  assert.equal(w.tables.audit_events[0].action, 'ops_login');
  assert.equal((await call(login, { email: 'owner@example.com', password: 'wrong' }, null)).statusCode, 401);
  assert.equal((await call(login, { email: 'u@example.com', password: 'right' }, null)).statusCode, 401);
  assert.equal((await call(offlineSale, sale(), null)).statusCode, 401);
  assert.equal((await call(offlineSale, sale(), USER)).statusCode, 401);
  assert.equal((await call(offlineSale, sale(), 'forged')).statusCode, 401);
  assert.equal(w.licenses.length, 0);
});

// ---- offline sales --------------------------------------------------------
test('ops: an offline UPI sale issues a paid licence with its reference, and records who did it', async (t) => {
  quiet(t);
  const w = world(t);
  const r = await call(offlineSale, sale());
  assert.equal(r.statusCode, 200);
  assert.match(r.body.license_key, /^TTD-/);
  const l = w.licenses[0];
  assert.equal(l.policy, 'pass-30');
  assert.deepEqual({ source: l.metadata.source, method: l.metadata.method, reference: l.metadata.reference, amountInr: l.metadata.amountInr, email: l.metadata.email },
    { source: 'offline', method: 'upi', reference: 'UTR123456789', amountInr: 299, email: 'Walkin@example.com' });
  assert.equal(l.metadata.publicProductId, 'pdt_0NkvjEpCQNkDuaCT65cFV');
  assert.equal(w.tables.licence_authority[0].key_hash, licenceKeyHash(r.body.license_key));
  const a = w.tables.audit_events.find((x) => x.action === 'offline_sale_created');
  assert.equal(a.actor, 'admin-1');
  assert.equal(a.target, l.id);
});

test('ops: retrying the same sale returns the same key; reusing the UTR for something else is refused', async (t) => {
  quiet(t);
  const w = world(t);
  const a = await call(offlineSale, sale());
  const b = await call(offlineSale, sale());
  assert.equal(b.body.license_key, a.body.license_key);
  assert.equal(w.licenses.length, 1);
  const c = await call(offlineSale, sale({ plan: '90d', amount_inr: 699 }));
  assert.equal(c.statusCode, 409);
  assert.equal(c.body.error, 'duplicate_reference');
  assert.equal(w.licenses.length, 1);
});

test('ops: a grant uses the first-activation policy and may be free; a paid sale may not', async (t) => {
  quiet(t);
  const w = world(t);
  const g = await call(offlineSale, sale({ kind: 'grant', method: 'other', reference: 'donor-2026-01', amount_inr: 0, email: '' }));
  assert.equal(g.statusCode, 200);
  assert.equal(w.licenses[0].policy, 'grant-30');
  assert.equal(w.licenses[0].metadata.source, 'grant');
  assert.equal((await call(offlineSale, sale({ reference: 'UTR-zero', amount_inr: 0 }))).statusCode, 400);
  assert.equal((await call(offlineSale, sale({ method: 'crypto' }))).statusCode, 400);
});

// ---- activations & lookup -------------------------------------------------
test('ops: reset frees every activation, tombstones migrated aliases, and is audited', async (t) => {
  quiet(t);
  const w = world(t);
  const l = { id: randomUUID(), key: 'KEY-1', metadata: { email: 'b@example.com' }, policy: 'pass-7' };
  w.licenses.push(l);
  w.machines.push({ id: randomUUID(), license: l.id, name: 'Chrome A' }, { id: randomUUID(), license: l.id, name: 'Chrome B' });
  w.tables.instance_alias.push({ public_instance_id: 'lki_old', keygen_machine_id: w.machines[0].id, tombstoned_at: null });
  const r = await call(reset, { license_id: l.id, reason: 'customer changed laptop' });
  assert.equal(r.body.removed, 2);
  assert.equal(w.machines.length, 0);
  assert.ok(w.tables.instance_alias[0].tombstoned_at);
  const a = w.tables.audit_events.find((x) => x.action === 'reset_activations');
  assert.equal(a.detail.reason, 'customer changed laptop');
  assert.equal(a.detail.machines_removed.length, 2);
});

test('ops: deactivating one activation leaves the others', async (t) => {
  quiet(t);
  const w = world(t);
  const l = { id: randomUUID(), key: 'KEY-2', metadata: {}, policy: 'pass-7' };
  w.licenses.push(l);
  const keep = randomUUID();
  const drop = randomUUID();
  w.machines.push({ id: keep, license: l.id, name: 'A' }, { id: drop, license: l.id, name: 'B' });
  const r = await call(reset, { license_id: l.id, machine_id: drop, reason: 'old browser' });
  assert.equal(r.body.removed, 1);
  assert.deepEqual(w.machines.map((x) => x.id), [keep]);
  assert.equal((await call(reset, { license_id: l.id, machine_id: randomUUID(), reason: 'x' })).statusCode, 404);
});

test('ops: lookup finds licences by buyer email, key or id, with their activations', async (t) => {
  quiet(t);
  const w = world(t);
  await call(offlineSale, sale());
  const l = w.licenses[0];
  w.machines.push({ id: randomUUID(), license: l.id, name: 'Chrome' });
  for (const query of ['walkin@EXAMPLE.com'.replace('walkin', 'Walkin'), l.key, l.id]) {
    const r = await call(lookup, { query });
    assert.equal(r.body.results.length, 1, query);
    assert.equal(r.body.results[0].machines.length, 1);
    assert.equal(r.body.results[0].reference, 'UTR123456789');
  }
  assert.equal((await call(lookup, { query: 'nobody@example.com' })).body.results.length, 0);
});

// ---- find my key ----------------------------------------------------------
test('find-key: a buyer gets a code by email and then sees their keys', async (t) => {
  quiet(t);
  const w = world(t);
  const order = { id: randomUUID(), email: 'buyer@example.com', plan: '7d', status: 'fulfilled', fulfilled_at: new Date().toISOString() };
  w.tables.orders.push(order);
  w.tables.fulfilments.push({ order_id: order.id, license_key_enc: sealSecret('TTD-AAAAA-BBBBB-CCCCC-DDDDD'), status: 'provisioned' });
  const req = await call(findKey, { email: 'buyer@example.com' }, null);
  assert.equal(req.statusCode, 200);
  assert.equal(w.emails.length, 1);
  const code = w.emails[0].subject.match(/(\d{6})/)[1];
  const got = await call(findKey, { email: 'buyer@example.com', code }, null);
  assert.equal(got.statusCode, 200);
  assert.deepEqual(got.body.keys.map((k) => [k.license_key, k.plan, k.source]), [['TTD-AAAAA-BBBBB-CCCCC-DDDDD', '7d', 'online']]);
  assert.equal((await call(findKey, { email: 'buyer@example.com', code }, null)).statusCode, 400);
});

test('find-key: a customer migrated from Dodo (licence only in Keygen) can recover their key too', async (t) => {
  quiet(t);
  const w = world(t);
  w.licenses.push({ id: randomUUID(), key: 'DODO-MIGRATED-KEY-1', policy: 'pol', created: '2026-08-01T00:00:00Z',
    metadata: { source: 'dodo-migrated', email: 'Old.Buyer@example.com', plan: '30d', dodoCreatedAt: '2026-08-01T00:00:00Z' } });
  w.licenses.push({ id: randomUUID(), key: 'SOMEONE-ELSE', policy: 'pol', metadata: { source: 'dodo-migrated', email: 'other@example.com', plan: '7d' } });
  await call(findKey, { email: 'Old.Buyer@example.com' }, null);
  assert.equal(w.emails.length, 1, 'a code is sent');
  const code = w.emails[0].subject.match(/(\d{6})/)[1];
  const got = await call(findKey, { email: 'Old.Buyer@example.com', code }, null);
  assert.deepEqual(got.body.keys.map((k) => [k.license_key, k.plan, k.days, k.source]), [['DODO-MIGRATED-KEY-1', '30d', 30, 'earlier']]);
});

test('find-key: unknown emails get the same answer and no email; guesses are limited', async (t) => {
  quiet(t);
  const w = world(t);
  const unknown = await call(findKey, { email: 'stranger@example.com' }, null);
  assert.equal(unknown.statusCode, 200);
  assert.equal(w.emails.length, 0);

  const order = { id: randomUUID(), email: 'buyer@example.com', plan: '7d', status: 'fulfilled', fulfilled_at: new Date().toISOString() };
  w.tables.orders.push(order);
  w.tables.fulfilments.push({ order_id: order.id, license_key_enc: sealSecret('TTD-X'), status: 'provisioned' });
  const known = await call(findKey, { email: 'buyer@example.com' }, null);
  assert.equal(known.body.message, unknown.body.message);
  const code = w.emails[0].subject.match(/(\d{6})/)[1];
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await call(findKey, { email: 'buyer@example.com', code: wrong }, null)).statusCode, 400);
  assert.equal((await call(findKey, { email: 'buyer@example.com', code }, null)).statusCode, 400);
});

test('find-key: an expired code does not work', async (t) => {
  quiet(t);
  const w = world(t);
  const order = { id: randomUUID(), email: 'buyer@example.com', plan: '7d', status: 'fulfilled', fulfilled_at: new Date().toISOString() };
  w.tables.orders.push(order);
  w.tables.fulfilments.push({ order_id: order.id, license_key_enc: sealSecret('TTD-X'), status: 'provisioned' });
  await call(findKey, { email: 'buyer@example.com' }, null);
  const code = w.emails[0].subject.match(/(\d{6})/)[1];
  w.tables.find_key_challenges[0].expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await call(findKey, { email: 'buyer@example.com', code }, null)).statusCode, 400);
});

// ---- activation limits ----------------------------------------------------
test('ops: an offline sale can cover several browsers with one key', async (t) => {
  quiet(t);
  const w = world(t);
  const r = await call(offlineSale, sale({ reference: 'whatsapp-6', amount_inr: 200, activations: 6, note: '6 coupons for 200' }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.activations, 6);
  assert.equal(w.licenses[0].maxMachines, 6);
  assert.equal(w.tables.offline_sales[0].activations, 6);
  assert.equal((await call(offlineSale, sale({ reference: 'one', amount_inr: 99 }))).body.activations, 1);
  assert.equal(w.licenses[1].maxMachines, undefined);
  for (const bad of [0, 1001, 2.5, 'many']) {
    assert.equal((await call(offlineSale, sale({ reference: 'bad-' + bad, activations: bad }))).statusCode, 400, String(bad));
  }
  assert.equal((await call(offlineSale, sale({ reference: 'whatsapp-6', amount_inr: 200, activations: 3 }))).statusCode, 409);
});

test('ops: the browser limit of an existing licence can be raised, and not lowered below what is in use', async (t) => {
  quiet(t);
  const w = world(t);
  const l = { id: randomUUID(), key: 'KEY-L', metadata: {}, policy: 'pass-7' };
  w.licenses.push(l);
  w.machines.push({ id: randomUUID(), license: l.id, name: 'A' }, { id: randomUUID(), license: l.id, name: 'B' });
  const up = await call(setLimit, { license_id: l.id, activations: 6, reason: 'sold 6 passes on WhatsApp' });
  assert.equal(up.statusCode, 200);
  assert.deepEqual([up.body.previous, up.body.activations], [1, 6]);
  assert.equal(l.maxMachines, 6);
  const a = w.tables.audit_events.find((x) => x.action === 'set_activation_limit');
  assert.deepEqual([a.detail.from, a.detail.to, a.detail.reason], [1, 6, 'sold 6 passes on WhatsApp']);
  const down = await call(setLimit, { license_id: l.id, activations: 1, reason: 'oops' });
  assert.equal(down.statusCode, 409);
  assert.equal(l.maxMachines, 6);
  assert.equal((await call(setLimit, { license_id: l.id, activations: 6, reason: 'x' }, null)).statusCode, 401);
});

// ---- invoices & opt-in email ------------------------------------------------
const { financialYear } = await import('../api/_invoice.mjs');

test('invoice: the financial year turns over on 1 April (India time)', () => {
  assert.equal(financialYear('2026-03-31T18:00:00Z'), '2025-26');
  assert.equal(financialYear('2026-03-31T18:31:00Z'), '2026-27');
  assert.equal(financialYear('2027-01-15T00:00:00Z'), '2026-27');
});

test('ops: an offline sale sends nothing unless asked, but a paid one is always invoiced', async (t) => {
  quiet(t);
  const w = world(t);
  const r = await call(offlineSale, sale({ reference: 'UTR-quiet' }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.email_sent, false);
  assert.match(r.body.invoice_number, /^TTDA\/\d{4}-\d{2}\/0001$/);
  assert.equal(w.emails.length, 0);
  assert.equal(w.tables.email_outbox.length, 0);
  const again = await call(offlineSale, sale({ reference: 'UTR-quiet' }));
  assert.equal(again.body.invoice_number, r.body.invoice_number);
  assert.equal(w.tables.invoices.length, 1);
});

test('ops: with "email the key" ticked, a sale emails the key and its payment summary (one email, no attachment); a grant has no payment section', async (t) => {
  quiet(t);
  const w = world(t);
  const paid = await call(offlineSale, sale({ reference: 'UTR-mail', activations: 6, send_email: true }));
  assert.equal(paid.body.email_sent, true);
  assert.deepEqual(w.emails[0].to, ['Walkin@example.com']);
  assert.match(w.emails[0].text, new RegExp(paid.body.license_key));
  assert.match(w.emails[0].text, /6 browsers/);
  assert.equal(w.emails[0].attachments, undefined, 'one email, no attachment');
  assert.match(w.emails[0].text, /Payment method: UPI/);
  assert.match(w.emails[0].text, /Invoice no\.: TTDA\//);
  const grant = await call(offlineSale, sale({ kind: 'grant', method: 'other', reference: 'gift-1', amount_inr: 0, send_email: true }));
  assert.equal(grant.body.email_sent, true);
  assert.equal(grant.body.invoice_number, null);
  assert.equal(w.emails[1].attachments, undefined);
  assert.match(w.emails[1].html, /Complimentary pass/);
  assert.doesNotMatch(w.emails[1].html, /Payment details/);
  assert.match(w.emails[1].text, /30 days from first activation/);
  assert.equal((await call(offlineSale, sale({ reference: 'no-addr', email: '', send_email: true }))).statusCode, 400);
});

test('ops: suspend, reinstate, change expiry and re-send the email — each audited', async (t) => {
  quiet(t);
  process.env.RESEND_API_KEY = 're_test'; process.env.RESEND_FROM = 'TTD Autofill <keys@example.com>';
  try {
    const w = world(t);
    const issued = (await call(offlineSale, sale({ reference: 'UTR-ACTIONS-1' }))).body;
    const l = w.licenses.find((x) => x.id === issued.license_id);
    // The fake has no action routes; record them.
    const realFetch = globalThis.fetch;
    const actions = [];
    t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
      const m = String(url).match(/\/licenses\/([^/]+)\/actions\/(suspend|reinstate)$/);
      if (m) { actions.push(m[2]); l.status = m[2] === 'suspend' ? 'SUSPENDED' : 'ACTIVE'; return new Response(JSON.stringify({ data: { id: m[1] } }), { status: 200 }); }
      return realFetch(url, opts);
    });
    assert.equal((await call(licenceAction, { license_id: l.id, action: 'suspend', reason: 'chargeback' })).statusCode, 200);
    assert.equal((await call(licenceAction, { license_id: l.id, action: 'reinstate', reason: 'resolved' })).statusCode, 200);
    assert.deepEqual(actions, ['suspend', 'reinstate']);
    const exp = await call(licenceAction, { license_id: l.id, action: 'set_expiry', expiry: '2027-01-31T23:59:59Z', reason: 'goodwill' });
    assert.equal(exp.statusCode, 200);
    assert.equal(l.expiry, '2027-01-31T23:59:59.000Z');
    const sent = await call(licenceAction, { license_id: l.id, action: 'resend_email', reason: 'customer lost it', to: 'new@example.com' });
    assert.equal(sent.statusCode, 200);
    assert.equal(sent.body.to, 'new@example.com');
    assert.match(JSON.stringify(w.emails.at(-1)), new RegExp(issued.license_key));
    assert.deepEqual(w.tables.audit_events.slice(-4).map((e) => e.action), ['licence_suspended', 'licence_reinstated', 'licence_expiry_changed', 'licence_email_resent']);
    assert.equal((await call(licenceAction, { license_id: l.id, action: 'suspend', reason: 'x' }, USER)).statusCode, 401);
  } finally { delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM; }
});
