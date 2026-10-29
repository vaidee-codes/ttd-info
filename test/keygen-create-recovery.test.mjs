import assert from 'node:assert/strict';
import test from 'node:test';
import { createLicenseWithKey } from '../api/_keygen.mjs';
import { ProviderError } from '../api/_dodo.mjs';

process.env.KEYGEN_API_URL = 'https://keygen.test';
process.env.KEYGEN_ACCOUNT_ID = 'account-test';
process.env.KEYGEN_PRODUCT_TOKEN = 'token-test';
process.env.KEYGEN_PRODUCT_ID = 'product-test';

const purchase = {
  key: 'test-order-key', policyId: 'policy-test',
  metadata: { source: 'razorpay', orderId: 'order-test', publicProductId: 'public-product-test' }
};
const licence = () => ({
  id: 'licence-test', type: 'licenses',
  attributes: { key: purchase.key, metadata: { ...purchase.metadata }, expiry: '2026-10-01T00:00:00Z' },
  relationships: { policy: { data: { type: 'policies', id: purchase.policyId } } }
});

function provider(t, { status = 409, data = licence(), code = 'VALID', lookupStatus = 200, networkFailure = false } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(options.body);
    calls.push({ path, body });
    if (path.endsWith('/licenses')) {
      if (networkFailure) throw new TypeError('connection reset');
      return new Response(JSON.stringify(status === 201 ? { data } : { errors: [{ code: status === 422 ? 'KEY_TAKEN' : null }] }), { status });
    }
    assert.ok(path.endsWith('/licenses/actions/validate-key'));
    assert.deepEqual(body.meta, { key: purchase.key, scope: { product: 'product-test' } });
    return new Response(JSON.stringify(lookupStatus === 200
      ? { data, meta: { valid: code === 'VALID', code } }
      : { errors: [{ code: null }] }), { status: lookupStatus });
  });
  return calls;
}

test('concurrent 409 and ordinary 422 conflicts recover the existing order licence', async (t) => {
  for (const status of [409, 422]) {
    await t.test(String(status), async (t) => {
      const data = licence();
      const calls = provider(t, { status, data });
      assert.deepEqual(await createLicenseWithKey(purchase), data);
      assert.equal(calls.length, 2);
    });
  }
});

test('late callbacks reuse expired or unactivated licences without extending them', async (t) => {
  for (const code of ['EXPIRED', 'NO_MACHINES', 'SUSPENDED']) {
    await t.test(code, async (t) => {
      const data = licence();
      const calls = provider(t, { data, code });
      assert.deepEqual(await createLicenseWithKey(purchase), data);
      assert.equal(calls.length, 2);
      assert.equal(calls.filter((call) => call.path.endsWith('/licenses')).length, 1);
    });
  }
});

test('conflict recovery rejects licences belonging to another fulfilment or policy', async (t) => {
  const cases = [
    ['different key', (data) => { data.attributes.key = 'another-key'; }],
    ['different policy', (data) => { data.relationships.policy.data.id = 'another-policy'; }],
    ['different order', (data) => { data.attributes.metadata.orderId = 'another-order'; }],
    ['missing order identity', (data) => { delete data.attributes.metadata.orderId; }],
    ['different source', (data) => { data.attributes.metadata.source = 'offline'; }],
    ['different public product', (data) => { data.attributes.metadata.publicProductId = 'another-product'; }],
    ['missing licence id', (data) => { delete data.id; }]
  ];
  for (const [name, change] of cases) {
    await t.test(name, async (t) => {
      const data = licence();
      change(data);
      provider(t, { data });
      await assert.rejects(createLicenseWithKey(purchase), (error) => error instanceof ProviderError && error.status === 409);
    });
  }
});

test('offline conflict recovery is scoped to its own sale', async (t) => {
  const offline = { ...purchase, metadata: { source: 'offline', offlineSaleId: 'sale-test', publicProductId: 'public-product-test' } };
  const data = licence();
  data.attributes.metadata = { ...offline.metadata, offlineSaleId: 'another-sale' };
  provider(t, { data });
  await assert.rejects(createLicenseWithKey(offline), (error) => error instanceof ProviderError && error.status === 409);
});

test('missing licences and product scope mismatches keep the original conflict', async (t) => {
  for (const [name, options] of [
    ['missing', { data: null, code: 'NOT_FOUND' }],
    ['wrong product', { code: 'PRODUCT_SCOPE_MISMATCH' }]
  ]) {
    await t.test(name, async (t) => {
      provider(t, options);
      await assert.rejects(createLicenseWithKey(purchase), (error) => error instanceof ProviderError && error.status === 409);
    });
  }
});

test('availability and permission failures are not treated as duplicate success', async (t) => {
  for (const [name, options, expectedStatus, expectedCalls] of [
    ['server failure', { status: 503 }, 503, 1],
    ['forbidden', { status: 403 }, 403, 1],
    ['network failure', { networkFailure: true }, 503, 1],
    ['lookup failure', { lookupStatus: 503 }, 503, 2]
  ]) {
    await t.test(name, async (t) => {
      const calls = provider(t, options);
      await assert.rejects(createLicenseWithKey(purchase), (error) => error instanceof ProviderError && error.status === expectedStatus);
      assert.equal(calls.length, expectedCalls);
    });
  }
});

test('fresh licence creation does not perform conflict recovery', async (t) => {
  const data = licence();
  const calls = provider(t, { status: 201, data });
  assert.deepEqual(await createLicenseWithKey(purchase), data);
  assert.equal(calls.length, 1);
});
