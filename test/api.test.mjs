import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
process.env.TTDAF_ENTITLEMENT_PRIVATE_KEY = JSON.stringify(privateKey.export({ format: 'jwk' }));
process.env.DODO_API_KEY = 'test-credential';
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;

const checkoutHandler = (await import('../api/checkout.mjs')).default;
const activateHandler = (await import('../api/license-activate.mjs')).default;
const configHandler = (await import('../api/config.mjs')).default;
const { isAcceptedProduct, assertPlanConfiguration } = await import('../api/_dodo.mjs');

function request({ method = 'POST', body = {}, origin = 'https://ttd-info.vercel.app', host = 'evil.example' } = {}) {
  return {
    method,
    body,
    headers: {
      origin,
      host,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(JSON.stringify(body)))
    }
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {
      return this;
    }
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('config uses exact CORS/security headers and is edge-cacheable', async () => {
  process.env.PASS_SALES_ENABLED = 'true';
  process.env.PASS_GATE_ENABLED = 'false';
  const res = response();
  await configHandler(request({ method: 'GET', body: undefined, origin: 'chrome-extension://piiegkjdfbbakjmjdckgdjbbohfjfolg' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], 'chrome-extension://piiegkjdfbbakjmjdckgdjbbohfjfolg');
  // Public gate flags only — intentionally cacheable at the edge so a 50k
  // simultaneous open does not become 50k origin invocations. `Vary: Origin`
  // keeps allowed origins on separate cache entries.
  assert.equal(res.headers['cache-control'], 'public, s-maxage=60, stale-while-revalidate=300');
  assert.equal(res.headers['vary'], 'Origin');
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.body.plan.amount, 9900);
  assert.equal(res.body.plan.billing, 'one_time');
  assert.equal(res.body.plan.duration_days, 7);
  assert.equal(res.body.plan.activation_limit, 1);
});

test('unapproved origins are rejected without a CORS grant', async () => {
  const res = response();
  await configHandler(request({ method: 'GET', body: undefined, origin: 'https://attacker.example' }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('test origins are accepted only in Preview', async () => {
  process.env.PASS_PREVIEW_ORIGINS = 'http://localhost:5173';
  process.env.VERCEL_ENV = 'production';
  const production = response();
  await configHandler(request({ method: 'GET', body: undefined, origin: 'http://localhost:5173' }), production);
  assert.equal(production.statusCode, 403);

  process.env.VERCEL_ENV = 'preview';
  const preview = response();
  await configHandler(request({ method: 'GET', body: undefined, origin: 'http://localhost:5173' }), preview);
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.headers['access-control-allow-origin'], 'http://localhost:5173');
  delete process.env.VERCEL_ENV;
  delete process.env.PASS_PREVIEW_ORIGINS;
});

test('checkout rejects unknown plans and enforces the body limit', async () => {
  process.env.PASS_SALES_ENABLED = 'true';
  // 7d, 30d, and 90d are the only accepted plans; anything else is rejected
  // before any provider call.
  const wrong = response();
  await checkoutHandler(request({ body: { plan: '365d' } }), wrong);
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.body.error, 'invalid_plan');

  const missing = response();
  await checkoutHandler(request({ body: {} }), missing);
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.error, 'invalid_plan');

  const largeReq = request({ body: { plan: '7d', padding: 'x'.repeat(5000) } });
  const large = response();
  await checkoutHandler(largeReq, large);
  assert.equal(large.statusCode, 413);
});

test('authorization keeps legacy pass and supporter products compatible', () => {
  assert.equal(isAcceptedProduct('pdt_0Nk4Gw67usedtjPoO6hX2'), true);
  assert.equal(isAcceptedProduct('pdt_0NkvjEpCQNkDuaCT65cFV'), true);
  assert.equal(isAcceptedProduct('pdt_0NkvjEr1l8rhSF6Ibxlj3'), true);
  assert.equal(isAcceptedProduct('pdt_0NjbdVzVqfSrrofI36ENV'), true);
  assert.equal(isAcceptedProduct('pdt_unrelated'), false);
});

test('checkout verifies provider configuration and sends hardened creation options', async (t) => {
  process.env.PASS_SALES_ENABLED = 'true';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/products/')) {
      return jsonResponse({
        product_id: 'pdt_0Nk4Gw67usedtjPoO6hX2',
        is_recurring: false,
        price: { currency: 'INR', price: 9900, pay_what_you_want: false },
        entitlements: [{ entitlement_id: 'ent_0Nk4GugPIsPbnFf5dYYqC' }]
      });
    }
    if (String(url).includes('/entitlements/')) {
      return jsonResponse({
        id: 'ent_0Nk4GugPIsPbnFf5dYYqC',
        is_active: true,
        integration_type: 'license_key',
        integration_config: {
          fulfillment_mode: 'auto',
          duration_count: 7,
          duration_interval: 'Day',
          activations_limit: 1
        }
      });
    }
    return jsonResponse({ checkout_url: 'https://checkout.dodopayments.com/session/abc', session_id: 'cks_private' });
  });

  const res = response();
  await checkoutHandler(request({
    host: 'attacker.example',
    body: {
      plan: '7d',
      request_id: '11111111-1111-4111-8111-111111111111',
      activate: true,
      extension_id: 'piiegkjdfbbakjmjdckgdjbbohfjfolg'
    }
  }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, checkout_url: 'https://checkout.dodopayments.com/session/abc' });
  const create = calls.at(-1);
  const providerBody = JSON.parse(create.options.body);
  assert.equal(providerBody.return_url, 'https://ttd-info.vercel.app/pass/success?extension_id=piiegkjdfbbakjmjdckgdjbbohfjfolg&activate=1');
  assert.equal(providerBody.feature_flags.allow_discount_code, false);
  assert.deepEqual(providerBody.product_cart, [{ product_id: 'pdt_0Nk4Gw67usedtjPoO6hX2', quantity: 1 }]);
  assert.match(create.options.headers['Idempotency-Key'], /^pass-checkout-[0-9a-f]{64}$/);
  assert.equal('session_id' in res.body, false);
});

test('checkout creates a 30-day session against the 30-day product', async (t) => {
  process.env.PASS_SALES_ENABLED = 'true';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push({ url: String(url) });
    if (String(url).includes('/products/')) {
      return jsonResponse({
        product_id: 'pdt_0NkvjEpCQNkDuaCT65cFV',
        is_recurring: false,
        price: { currency: 'INR', price: 29900, discount: 0, pay_what_you_want: false },
        entitlements: [{ entitlement_id: 'ent_0NkvjEit63fF12KazuaN1' }]
      });
    }
    if (String(url).includes('/entitlements/')) {
      return jsonResponse({
        id: 'ent_0NkvjEit63fF12KazuaN1',
        is_active: true,
        integration_type: 'license_key',
        integration_config: { fulfillment_mode: 'auto', duration_count: 30, duration_interval: 'Day', activations_limit: 1 }
      });
    }
    return jsonResponse({ checkout_url: 'https://checkout.dodopayments.com/session/d30' });
  });

  const res = response();
  await checkoutHandler(request({ body: { plan: '30d', request_id: '22222222-2222-4222-8222-222222222222', activate: false } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.checkout_url, 'https://checkout.dodopayments.com/session/d30');
  const createCall = calls.find((c) => c.url.endsWith('/checkouts'));
  assert.ok(createCall, 'a checkout session was created against the 30-day product');
});

test('weekly config guard accepts the live list price minus its discount', async (t) => {
  // The live 7-day product is ₹198 with a 50% discount = ₹99 net. The guard
  // must accept that, not require a flat 9900 list price.
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/products/')) {
      return jsonResponse({
        product_id: 'pdt_0Nk4Gw67usedtjPoO6hX2',
        is_recurring: false,
        price: { currency: 'INR', price: 19800, discount: 50, pay_what_you_want: false },
        entitlements: [{ entitlement_id: 'ent_0Nk4GugPIsPbnFf5dYYqC' }]
      });
    }
    return jsonResponse({
      id: 'ent_0Nk4GugPIsPbnFf5dYYqC',
      is_active: true,
      integration_type: 'license_key',
      integration_config: { fulfillment_mode: 'auto', duration_count: 7, duration_interval: 'Day', activations_limit: 1 }
    });
  });
  await assert.doesNotReject(assertPlanConfiguration('7d'));
});

test('activation projects only a signed browser-bound entitlement', async (t) => {
  const key = '7DAY-LICENCE-KEY-123456';
  const instanceId = 'lki_instance_123';
  const licenseKeyId = 'lic_key_123';
  const expiresAt = new Date(Date.now() + 6 * 86400_000).toISOString();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push(String(url));
    const path = new URL(String(url)).pathname;
    if (path === '/licenses/activate') return jsonResponse({
      id: instanceId,
      license_key_id: licenseKeyId,
      product: { product_id: 'pdt_0Nk4Gw67usedtjPoO6hX2' },
      customer: { email: 'private@example.com', customer_id: 'cus_private' }
    }, 201);
    if (path === '/licenses/validate') return jsonResponse({ valid: true });
    if (path === '/license_key_instances/' + instanceId) return jsonResponse({ id: instanceId, license_key_id: licenseKeyId });
    if (path === '/license_keys/' + licenseKeyId) return jsonResponse({
      id: licenseKeyId,
      key,
      product_id: 'pdt_0Nk4Gw67usedtjPoO6hX2',
      payment_id: 'pay_123',
      status: 'active',
      activations_limit: 1,
      expires_at: expiresAt,
      customer_id: 'cus_private'
    });
    if (path === '/payments/pay_123') return jsonResponse({
      payment_id: 'pay_123',
      status: 'succeeded',
      currency: 'INR',
      checkout_session_id: 'cks_123',
      customer: { email: 'private@example.com' },
      product_cart: [{ product_id: 'pdt_0Nk4Gw67usedtjPoO6hX2', quantity: 1 }]
    });
    if (path === '/checkouts/cks_123') return jsonResponse({ id: 'cks_123', payment_id: 'pay_123', payment_status: 'succeeded' });
    throw new Error('unexpected request ' + path);
  });

  const res = response();
  await activateHandler(request({ body: {
    license_key: key,
    installation_uuid: '22222222-2222-4222-8222-222222222222',
    device_label: 'TTD Autofill - Test'
  } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.instance_id, instanceId);
  assert.match(res.body.entitlement_token, /^[^.]+\.[^.]+\.[^.]+$/);
  const serialized = JSON.stringify(res.body);
  assert.doesNotMatch(serialized, /private@example|cus_private|7DAY-LICENCE/);
  assert.equal(calls.some((url) => /license_keys\?(|.*page)/.test(url)), false);
  assert.equal(calls.some((url) => /customers/.test(url)), false);
});

test('a valid no-expiry supporter key receives only a short-lived token', async (t) => {
  const key = 'SUPPORTER-LICENCE-KEY-123456';
  const instanceId = 'lki_supporter_123';
  const licenseKeyId = 'lic_supporter_123';
  const productId = 'pdt_0NjbdVzVqfSrrofI36ENV';
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/licenses/activate') return jsonResponse({
      id: instanceId,
      license_key_id: licenseKeyId,
      product: { product_id: productId }
    }, 201);
    if (path === '/licenses/validate') return jsonResponse({ valid: true });
    if (path === '/license_key_instances/' + instanceId) return jsonResponse({ id: instanceId, license_key_id: licenseKeyId });
    if (path === '/license_keys/' + licenseKeyId) return jsonResponse({
      id: licenseKeyId,
      key,
      product_id: productId,
      subscription_id: 'sub_supporter_123',
      status: 'active',
      activations_limit: 1,
      expires_at: null
    });
    throw new Error('unexpected request ' + path);
  });

  const res = response();
  await activateHandler(request({ body: {
    license_key: key,
    installation_uuid: '44444444-4444-4444-8444-444444444444',
    device_label: 'TTD Autofill - Supporter Test'
  } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.provider_expires_at, null);
  const payload = JSON.parse(Buffer.from(res.body.entitlement_token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.product_id, productId);
  assert.equal(payload.provider_expiry, null);
  assert.equal(payload.exp - payload.iat, 8 * 3600);
});

test('a complimentary pass-tier key expires its tier length from activation', async (t) => {
  const key = 'DONOR-30DAY-KEY-0000001';
  const instanceId = 'lki_donor_30';
  const licenseKeyId = 'lic_donor_30';
  const productId = 'pdt_0NkvjEpCQNkDuaCT65cFV'; // 30-day pass
  const activatedAt = new Date().toISOString();
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/licenses/activate') return jsonResponse({ id: instanceId, license_key_id: licenseKeyId, product: { product_id: productId } }, 201);
    if (path === '/licenses/validate') return jsonResponse({ valid: true });
    // Donor key: created with NO expiry; activation timestamp drives expiry.
    if (path === '/license_key_instances/' + instanceId) return jsonResponse({ id: instanceId, license_key_id: licenseKeyId, created_at: activatedAt });
    if (path === '/license_keys/' + licenseKeyId) return jsonResponse({ id: licenseKeyId, key, product_id: productId, status: 'active', activations_limit: 1, expires_at: null });
    throw new Error('unexpected request ' + path);
  });

  const res = response();
  await activateHandler(request({ body: {
    license_key: key,
    installation_uuid: '55555555-5555-4555-8555-555555555555',
    device_label: 'TTD Autofill - Donor'
  } }), res);
  assert.equal(res.statusCode, 200);
  const providerExpiry = Date.parse(res.body.provider_expires_at);
  const expected = Date.parse(activatedAt) + 30 * 86400000;
  assert.ok(Math.abs(providerExpiry - expected) < 5000, 'provider expiry ~= activation + 30 days');
  // The signed token still carries the 30-day provider expiry as its cap.
  const payload = JSON.parse(Buffer.from(res.body.entitlement_token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.provider_expiry, res.body.provider_expires_at);
});

test('activation requires checkout payment_status to be exactly succeeded', async (t) => {
  const key = '7DAY-LICENCE-KEY-654321';
  const instanceId = 'lki_instance_456';
  const licenseKeyId = 'lic_key_456';
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/licenses/activate') return jsonResponse({ id: instanceId, license_key_id: licenseKeyId, product: { product_id: 'pdt_0Nk4Gw67usedtjPoO6hX2' } }, 201);
    if (path === '/licenses/validate') return jsonResponse({ valid: true });
    if (path === '/license_key_instances/' + instanceId) return jsonResponse({ id: instanceId, license_key_id: licenseKeyId });
    if (path === '/license_keys/' + licenseKeyId) return jsonResponse({ id: licenseKeyId, key, product_id: 'pdt_0Nk4Gw67usedtjPoO6hX2', payment_id: 'pay_456', status: 'active', activations_limit: 1, expires_at: new Date(Date.now() + 86400_000).toISOString() });
    if (path === '/payments/pay_456') return jsonResponse({ payment_id: 'pay_456', status: 'succeeded', currency: 'INR', checkout_session_id: 'cks_456', product_cart: [{ product_id: 'pdt_0Nk4Gw67usedtjPoO6hX2', quantity: 1 }] });
    if (path === '/checkouts/cks_456') return jsonResponse({ id: 'cks_456', payment_id: 'pay_456', payment_status: 'processing' });
    if (path === '/licenses/deactivate') return jsonResponse({});
    throw new Error('unexpected request ' + path);
  });
  const res = response();
  await activateHandler(request({ body: {
    license_key: key,
    installation_uuid: '33333333-3333-4333-8333-333333333333',
    device_label: 'TTD Autofill - Test'
  } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'licence_invalid');
});

test('provider failures never expose provider bodies or customer data', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    code: 'UPSTREAM_FAILURE',
    detail: 'private@example.com 7DAY-SECRET-LICENCE customer_record'
  }, 500));
  const res = response();
  await activateHandler(request({ body: {
    license_key: '7DAY-SECRET-LICENCE',
    installation_uuid: '55555555-5555-4555-8555-555555555555',
    device_label: 'TTD Autofill - Test'
  } }), res);
  assert.equal(res.statusCode, 502);
  const serialized = JSON.stringify(res.body);
  assert.doesNotMatch(serialized, /private@example|7DAY-SECRET|customer_record|UPSTREAM_FAILURE/);
  assert.equal(res.body.error, 'provider_unavailable');
});

test('removed discovery routes and enumeration code are absent', () => {
  for (const file of ['license-key.mjs', 'license-lookup.mjs', 'session.mjs']) {
    assert.equal(existsSync(new URL('../api/' + file, import.meta.url)), false);
  }
  const dodoSource = readFileSync(new URL('../api/_dodo.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(dodoSource, /\/customers\?|license_keys\?page|resolveLicenseForCustomer|resolveLicenseForEmail/);
});
