import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
process.env.TTDAF_ENTITLEMENT_PRIVATE_KEY = JSON.stringify(privateKey.export({ format: 'jwk' }));
process.env.DODO_API_KEY = 'stubbed-provider-key';
process.env.TTDAF_LOG_CORRELATION_SECRET = 'provider-contract-test';
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;

const { inspectLicenseBinding } = await import('../api/_dodo.mjs');
const { issueEntitlement } = await import('../api/_entitlement.mjs');
const validateHandler = (await import('../api/license-validate.mjs')).default;
const refreshHandler = (await import('../api/license-refresh.mjs')).default;
const deactivateHandler = (await import('../api/license-deactivate.mjs')).default;
const activateHandler = (await import('../api/license-activate.mjs')).default;
const checkoutHandler = (await import('../api/checkout.mjs')).default;

const PRODUCT = 'pdt_0Nk4Gw67usedtjPoO6hX2';
const KEY = 'QA-PROVIDER-CONTRACT-KEY';
const LICENCE = 'lic_contract_1';
const INSTANCE = 'lki_contract_1';
const INSTALLATION = '11111111-1111-4111-8111-111111111111';
const EXPIRY = new Date(Date.now() + 7 * 86400_000).toISOString();

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockProvider(t, { paymentStatus = 'succeeded', currency = 'INR', paymentId = 'pay_contract_1', keyStatus = 'active', expiry = EXPIRY, validation = true, missingInstance = false, wrongProduct = false, wrongPaymentId = false } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: options.method || 'GET' });
    if (path === '/licenses/validate') return json({ valid: validation });
    if (path === '/license_key_instances/' + INSTANCE) {
      return missingInstance ? json({ code: 'NOT_FOUND' }, 404) : json({ id: INSTANCE, license_key_id: LICENCE, created_at: new Date().toISOString() });
    }
    if (path === '/license_keys/' + LICENCE) return json({
      id: LICENCE, key: KEY, product_id: wrongProduct ? 'pdt_other' : PRODUCT,
      payment_id: paymentId, status: keyStatus, activations_limit: 1, expires_at: expiry
    });
    if (path === '/payments/' + paymentId) return json({ payment_id: wrongPaymentId ? 'pay_wrong' : paymentId, status: paymentStatus, currency });
    if (path === '/licenses/deactivate') return json({});
    throw new Error('Unexpected provider call: ' + path);
  });
  return calls;
}

function request(body) {
  return {
    method: 'POST', body,
    headers: { origin: 'https://ttd-info.vercel.app', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(JSON.stringify(body))) }
  };
}

function response() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; }
  };
}

function token() {
  return issueEntitlement({
    productId: PRODUCT, licenseKeyId: LICENCE, installationUuid: INSTALLATION,
    activationInstanceId: INSTANCE, providerExpiry: EXPIRY
  }).token;
}

for (const [name, options, expected] of [
  ['domestic succeeded payment', {}, { valid: true, reason: null }],
  ['foreign succeeded payment without cart or checkout', { currency: 'GBP' }, { valid: true, reason: null }],
  ['processing payment', { paymentStatus: 'processing' }, { valid: false, reason: 'payment_not_succeeded' }],
  ['failed payment', { paymentStatus: 'failed' }, { valid: false, reason: 'payment_not_succeeded' }],
  ['refunded payment', { paymentStatus: 'refunded' }, { valid: false, reason: 'payment_not_succeeded' }],
  ['wrong payment identity', { wrongPaymentId: true }, { valid: false, reason: 'payment_not_succeeded' }],
  ['manual key without a payment', { paymentId: null }, { valid: true, reason: null }],
  ['disabled key', { keyStatus: 'disabled' }, { valid: false, reason: 'licence_disabled' }],
  ['expired key', { expiry: new Date(Date.now() - 86400_000).toISOString() }, { valid: false, reason: 'licence_expired' }],
  ['expired key when Dodo validation is false', { expiry: new Date(Date.now() - 86400_000).toISOString(), validation: false }, { valid: false, reason: 'licence_expired' }],
  ['disabled key when Dodo validation is false', { keyStatus: 'disabled', validation: false }, { valid: false, reason: 'licence_disabled' }],
  ['wrong product', { wrongProduct: true }, { valid: false, reason: 'product_not_accepted' }],
  ['provider validation false', { validation: false }, { valid: false, reason: 'provider_validation_failed' }]
]) {
  test('binding contract: ' + name, async (t) => {
    const calls = mockProvider(t, options);
    t.mock.method(console, 'log', () => {});
    const state = await inspectLicenseBinding({ licenseKey: KEY, licenseKeyId: LICENCE, instanceId: INSTANCE, expectedProductId: PRODUCT });
    assert.equal(state.valid, expected.valid);
    assert.equal(state.reason, expected.reason);
    const readsPayment = options.paymentId !== null &&
      !['licence_disabled', 'licence_expired', 'product_not_accepted', 'provider_validation_failed'].includes(expected.reason);
    assert.equal(calls.some((call) => call.path.startsWith('/payments/')), readsPayment);
  });
}

test('validate reports a deactivated provider instance as invalid, not an outage', async (t) => {
  mockProvider(t, { missingInstance: true });
  const res = response();
  await validateHandler(request({ license_key: KEY, instance_id: INSTANCE, entitlement_token: token() }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, valid: false });
});

test('refresh treats a missing instance as a terminal licence state', async (t) => {
  mockProvider(t, { missingInstance: true });
  const auth = { license_key: KEY, instance_id: INSTANCE, entitlement_token: token() };
  const res = response();
  await refreshHandler(request({ ...auth, installation_uuid: INSTALLATION }), res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { ok: false, error: 'licence_invalid', provider_status: 'invalid' });
});

test('a stolen token cannot refresh a different installation or deactivate another instance', async (t) => {
  const calls = mockProvider(t);
  const auth = { license_key: KEY, instance_id: INSTANCE, entitlement_token: token() };
  const refreshRes = response();
  await refreshHandler(request({ ...auth, installation_uuid: '99999999-9999-4999-8999-999999999999' }), refreshRes);
  assert.equal(refreshRes.statusCode, 401);
  assert.equal(refreshRes.body.error, 'invalid_entitlement');
  const deactivateRes = response();
  await deactivateHandler(request({ ...auth, instance_id: 'lki_other' }), deactivateRes);
  assert.equal(deactivateRes.statusCode, 401);
  assert.equal(deactivateRes.body.error, 'invalid_entitlement');
  assert.equal(calls.length, 0);
});

test('unknown and inactive provider activation errors stay distinct', async (t) => {
  for (const [status, expected] of [[403, 'licence_inactive'], [404, 'licence_invalid']]) {
    t.mock.method(globalThis, 'fetch', async () => json({ code: 'NOT_FOUND' }, status));
    const res = response();
    await activateHandler(request({ license_key: KEY, installation_uuid: INSTALLATION }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, expected);
    t.mock.restoreAll();
  }
});

test('an expired key that Dodo briefly activates is labelled expired and its slot is released', async (t) => {
  const calls = [];
  const past = new Date(Date.now() - 86400_000).toISOString();
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === '/licenses/activate') return json({ id: INSTANCE, license_key_id: LICENCE, product: { product_id: PRODUCT } }, 201);
    if (path === '/licenses/validate') return json({ valid: false });
    if (path === '/license_key_instances/' + INSTANCE) return json({ id: INSTANCE, license_key_id: LICENCE, created_at: new Date().toISOString() });
    if (path === '/license_keys/' + LICENCE) return json({
      id: LICENCE, key: KEY, product_id: PRODUCT, payment_id: null,
      status: 'active', activations_limit: 1, expires_at: past
    });
    if (path === '/licenses/deactivate') return json({});
    throw new Error('Unexpected provider call: ' + path);
  });
  const res = response();
  await activateHandler(request({ license_key: KEY, installation_uuid: INSTALLATION }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'licence_expired');
  assert.equal(calls.filter((path) => path === '/licenses/deactivate').length, 1);
});

test('90-day checkout selects the right product, duration, return URL, and idempotency key', async (t) => {
  process.env.PASS_SALES_ENABLED = 'true';
  const calls = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, options });
    if (path === '/products/pdt_0NkvjEr1l8rhSF6Ibxlj3') return json({
      product_id: 'pdt_0NkvjEr1l8rhSF6Ibxlj3', is_recurring: false,
      price: { currency: 'INR', price: 69900, discount: 0, pay_what_you_want: false },
      entitlements: [{ entitlement_id: 'ent_0NkvjEqEgOtu4zXZbpSnR' }]
    });
    if (path === '/entitlements/ent_0NkvjEqEgOtu4zXZbpSnR') return json({
      id: 'ent_0NkvjEqEgOtu4zXZbpSnR', is_active: true, integration_type: 'license_key',
      integration_config: { fulfillment_mode: 'auto', duration_count: 90, duration_interval: 'Day', activations_limit: 1 }
    });
    if (path === '/checkouts') return json({ checkout_url: 'https://checkout.dodopayments.com/session/qa90' });
    throw new Error('Unexpected provider call: ' + path);
  });
  const res = response();
  await checkoutHandler(request({ plan: '90d', request_id: INSTALLATION, activate: false }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.checkout_url, 'https://checkout.dodopayments.com/session/qa90');
  const create = calls.find((call) => call.path === '/checkouts');
  assert.ok(create);
  const payload = JSON.parse(create.options.body);
  assert.deepEqual(payload.product_cart, [{ product_id: 'pdt_0NkvjEr1l8rhSF6Ibxlj3', quantity: 1 }]);
  assert.equal(payload.return_url, 'https://ttd-info.vercel.app/pass/success?plan=90d');
  assert.match(create.options.headers['Idempotency-Key'], /^pass-checkout-[0-9a-f]{64}$/);
});

test('checkout sales-off switch and untrusted provider redirect both fail closed', async (t) => {
  process.env.PASS_SALES_ENABLED = 'false';
  const calls = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(String(url)); throw new Error('Provider should not be called'); });
  const body = { plan: '7d', request_id: INSTALLATION, activate: false };
  const off = response();
  await checkoutHandler(request(body), off);
  assert.equal(off.statusCode, 503);
  assert.equal(off.body.error, 'sales_disabled');
  assert.equal(calls.length, 0);

  process.env.PASS_SALES_ENABLED = 'true';
  t.mock.restoreAll();
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith('/products/')) return json({
      product_id: PRODUCT, is_recurring: false,
      price: { currency: 'INR', price: 19800, discount: 50, pay_what_you_want: false },
      entitlements: [{ entitlement_id: 'ent_0Nk4GugPIsPbnFf5dYYqC' }]
    });
    if (path.startsWith('/entitlements/')) return json({
      id: 'ent_0Nk4GugPIsPbnFf5dYYqC', is_active: true, integration_type: 'license_key',
      integration_config: { fulfillment_mode: 'auto', duration_count: 7, duration_interval: 'Day', activations_limit: 1 }
    });
    return json({ checkout_url: 'https://attacker.example/pay' });
  });
  const unsafe = response();
  await checkoutHandler(request(body), unsafe);
  assert.equal(unsafe.statusCode, 503);
  assert.equal(unsafe.body.error, 'checkout_unavailable');
  assert.equal('checkout_url' in unsafe.body, false);
});
