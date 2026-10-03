import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
process.env.TTDAF_ENTITLEMENT_PRIVATE_KEY = JSON.stringify(privateKey.export({ format: 'jwk' }));
process.env.DODO_API_KEY = 'test-credential';
process.env.TTDAF_LOG_CORRELATION_SECRET = 'test-correlation-secret';
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;

const activateHandler = (await import('../api/license-activate.mjs')).default;
const { ACTIVATION_TIMEOUT_MS, INSTANCE_REF_PREFIX } = await import('../api/_dodo.mjs');
const { diagnosticRef } = await import('../api/_diagnostics.mjs');

const PRODUCT_ID = 'pdt_0Nk4Gw67usedtjPoO6hX2';
const INSTALLATION = '11111111-1111-4111-8111-111111111111';

function request(body) {
  return {
    method: 'POST',
    body,
    headers: {
      origin: 'https://ttd-info.vercel.app',
      host: 'ttd-info.vercel.app',
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
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function licenseRecord({ key, licenseKeyId, overrides = {} }) {
  return {
    id: licenseKeyId,
    key,
    product_id: PRODUCT_ID,
    payment_id: 'pay_1',
    status: 'active',
    activations_limit: 1,
    expires_at: new Date(Date.now() + 5 * 86400_000).toISOString(),
    ...overrides
  };
}

// Provider stub for the reads that follow a successful activation/reclaim.
function happyReads({ key, licenseKeyId, instanceId, license }) {
  return (path) => {
    if (path === '/licenses/validate') return jsonResponse({ valid: true });
    if (path === '/license_key_instances/' + instanceId) return jsonResponse({ id: instanceId, license_key_id: licenseKeyId });
    if (path === '/license_keys/' + licenseKeyId) return jsonResponse(license);
    if (path === '/payments/pay_1') return jsonResponse({ payment_id: 'pay_1', status: 'succeeded', currency: 'INR' });
    if (path === '/licenses/deactivate') return jsonResponse({});
    if (path === '/license_keys') return jsonResponse({ items: [license] });
    if (path === '/license_key_instances') return jsonResponse({ items: [{ id: instanceId, license_key_id: licenseKeyId, name: 'TTD Autofill - Test', created_at: new Date().toISOString() }] });
    throw new Error('unexpected request ' + path + ' for ' + key);
  };
}

test('the provider activation timeout outlives the client wait that consumes the slot', () => {
  // A shorter provider timeout abandons a paid single-activation key: the slot
  // is reserved at the provider but no entitlement reaches the browser.
  assert.ok(ACTIVATION_TIMEOUT_MS >= 20000, `activation timeout too short: ${ACTIVATION_TIMEOUT_MS}`);
});

test('a used slot owned by this installation is reclaimed instead of refusing the paid key', async (t) => {
  const key = 'RECLAIM-KEY-123456';
  const licenseKeyId = 'lic_reclaim_1';
  const instanceId = 'lki_reclaim_1';
  const license = licenseRecord({ key, licenseKeyId });
  const reads = happyReads({ key, licenseKeyId, instanceId, license });
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    if (path === '/licenses/activate') {
      const body = JSON.parse(options.body);
      // The instance name carries this installation's marker so a later
      // recovery can prove the slot belongs to this browser.
      assert.match(body.name, new RegExp(INSTANCE_REF_PREFIX + diagnosticRef('installation_uuid', INSTALLATION)));
      return jsonResponse({ code: 'LICENSE_KEY_LIMIT_REACHED' }, 409);
    }
    if (path === '/license_keys') return jsonResponse({ items: [license] });
    if (path === '/license_key_instances') {
      return jsonResponse({
        items: [{
          id: instanceId,
          license_key_id: licenseKeyId,
          name: `TTD Autofill - Test ${INSTANCE_REF_PREFIX}${diagnosticRef('installation_uuid', INSTALLATION)}`,
          created_at: new Date(Date.now() - 90_000).toISOString()
        }]
      });
    }
    return reads(path);
  });

  const res = response();
  await activateHandler(request({ license_key: key, installation_uuid: INSTALLATION, device_label: 'TTD Autofill - Test' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.instance_id, instanceId);
  assert.match(res.body.entitlement_token, /^[^.]+\.[^.]+\.[^.]+$/);
});

test('a slot owned by another browser is never taken', async (t) => {
  const key = 'OTHER-BROWSER-KEY-123';
  const licenseKeyId = 'lic_other_1';
  const instanceId = 'lki_other_1';
  const license = licenseRecord({ key, licenseKeyId });
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/licenses/activate') return jsonResponse({ code: 'LICENSE_KEY_LIMIT_REACHED' }, 409);
    if (path === '/license_keys') return jsonResponse({ items: [license] });
    if (path === '/license_key_instances') {
      return jsonResponse({
        items: [{
          id: instanceId,
          license_key_id: licenseKeyId,
          name: `TTD Autofill - Win32 ${INSTANCE_REF_PREFIX}${diagnosticRef('installation_uuid', '99999999-9999-4999-8999-999999999999')}`,
          created_at: new Date(Date.now() - 3600_000).toISOString()
        }]
      });
    }
    if (path === '/licenses/deactivate') throw new Error('another browser\'s activation must not be released');
    throw new Error('unexpected request ' + path);
  });

  const res = response();
  await activateHandler(request({ license_key: key, installation_uuid: INSTALLATION, device_label: 'TTD Autofill - Test' }), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'activation_in_use');
  assert.match(res.body.message, /already activated in another browser/i);
  assert.match(res.body.message, /support/i);
});

test('an activation abandoned seconds ago on the same device label is reclaimed for pre-marker builds', async (t) => {
  const key = 'LEGACY-RECLAIM-KEY-1';
  const licenseKeyId = 'lic_legacy_1';
  const instanceId = 'lki_legacy_1';
  const license = licenseRecord({ key, licenseKeyId });
  const reads = happyReads({ key, licenseKeyId, instanceId, license });
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/licenses/activate') return jsonResponse({ code: 'LICENSE_KEY_LIMIT_REACHED' }, 409);
    if (path === '/license_keys') return jsonResponse({ items: [license] });
    if (path === '/license_key_instances') {
      return jsonResponse({
        items: [{
          id: instanceId,
          license_key_id: licenseKeyId,
          // 7.5.0-era activation: no installation marker, only the device label.
          name: 'TTD Autofill - Test',
          created_at: new Date(Date.now() - 30_000).toISOString()
        }]
      });
    }
    return reads(path);
  });

  const res = response();
  await activateHandler(request({ license_key: key, installation_uuid: INSTALLATION, device_label: 'TTD Autofill - Test' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.instance_id, instanceId);
});

test('an old activation on another device is not reclaimed', async (t) => {
  const key = 'LEGACY-STALE-KEY-1';
  const licenseKeyId = 'lic_legacy_2';
  const license = licenseRecord({ key, licenseKeyId });
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/licenses/activate') return jsonResponse({ code: 'LICENSE_KEY_LIMIT_REACHED' }, 409);
    if (path === '/license_keys') return jsonResponse({ items: [license] });
    if (path === '/license_key_instances') {
      return jsonResponse({
        items: [{
          id: 'lki_legacy_2',
          license_key_id: licenseKeyId,
          name: 'TTD Autofill - Test',
          created_at: new Date(Date.now() - 6 * 3600_000).toISOString()
        }]
      });
    }
    throw new Error('unexpected request ' + path);
  });

  const res = response();
  await activateHandler(request({ license_key: key, installation_uuid: INSTALLATION, device_label: 'TTD Autofill - Test' }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'activation_in_use');
});

test('a timed-out activation re-attaches to the slot it already reserved', async (t) => {
  const key = 'TIMEOUT-KEY-123456';
  const licenseKeyId = 'lic_timeout_1';
  const instanceId = 'lki_timeout_1';
  const license = licenseRecord({ key, licenseKeyId });
  const reads = happyReads({ key, licenseKeyId, instanceId, license });
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/licenses/activate') throw new Error('aborted');
    if (path === '/license_keys') return jsonResponse({ items: [license] });
    if (path === '/license_key_instances') {
      return jsonResponse({
        items: [{
          id: instanceId,
          license_key_id: licenseKeyId,
          name: `TTD Autofill - Test ${INSTANCE_REF_PREFIX}${diagnosticRef('installation_uuid', INSTALLATION)}`,
          created_at: new Date(Date.now() - 5_000).toISOString()
        }]
      });
    }
    return reads(path);
  });

  const res = response();
  await activateHandler(request({ license_key: key, installation_uuid: INSTALLATION, device_label: 'TTD Autofill - Test' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.instance_id, instanceId);
});

test('an expired pass is reported as expired, not as an invalid key', async (t) => {
  const key = 'EXPIRED-KEY-123456';
  const licenseKeyId = 'lic_expired_1';
  const instanceId = 'lki_expired_1';
  const license = licenseRecord({
    key,
    licenseKeyId,
    overrides: { expires_at: new Date(Date.now() - 86400_000).toISOString() }
  });
  const reads = happyReads({ key, licenseKeyId, instanceId, license });
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/licenses/activate') return jsonResponse({ id: instanceId, license_key_id: licenseKeyId, product: { product_id: PRODUCT_ID } }, 201);
    return reads(path);
  });

  const res = response();
  await activateHandler(request({ license_key: key, installation_uuid: INSTALLATION, device_label: 'TTD Autofill - Test' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'licence_expired');
  assert.match(res.body.message, /expired/i);
});

test('a disabled key is reported as disabled, not as an invalid key', async (t) => {
  const key = 'DISABLED-KEY-123456';
  const licenseKeyId = 'lic_disabled_1';
  const instanceId = 'lki_disabled_1';
  const license = licenseRecord({ key, licenseKeyId, overrides: { status: 'disabled' } });
  const reads = happyReads({ key, licenseKeyId, instanceId, license });
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/licenses/activate') return jsonResponse({ id: instanceId, license_key_id: licenseKeyId, product: { product_id: PRODUCT_ID } }, 201);
    return reads(path);
  });

  const res = response();
  await activateHandler(request({ license_key: key, installation_uuid: INSTALLATION, device_label: 'TTD Autofill - Test' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'licence_disabled');
});

test('a used slot on a key whose payment never completed says so, not "another browser"', async (t) => {
  const key = 'UNPAID-SLOT-KEY-1234';
  const licenseKeyId = 'lic_unpaid_1';
  const instanceId = 'lki_unpaid_1';
  const license = licenseRecord({ key, licenseKeyId });
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/licenses/activate') return jsonResponse({ code: 'LICENSE_KEY_LIMIT_REACHED' }, 409);
    if (path === '/license_keys') return jsonResponse({ items: [license] });
    if (path === '/license_key_instances') {
      return jsonResponse({
        items: [{
          id: instanceId,
          license_key_id: licenseKeyId,
          name: `TTD Autofill - Test ${INSTANCE_REF_PREFIX}${diagnosticRef('installation_uuid', INSTALLATION)}`,
          created_at: new Date(Date.now() - 120_000).toISOString()
        }]
      });
    }
    if (path === '/licenses/validate') return jsonResponse({ valid: true });
    if (path === '/license_key_instances/' + instanceId) return jsonResponse({ id: instanceId, license_key_id: licenseKeyId });
    if (path === '/license_keys/' + licenseKeyId) return jsonResponse(license);
    // The slot exists but the payment behind the key never settled.
    if (path === '/payments/pay_1') return jsonResponse({ payment_id: 'pay_1', status: 'processing' });
    throw new Error('unexpected request ' + path);
  });

  const res = response();
  await activateHandler(request({ license_key: key, installation_uuid: INSTALLATION, device_label: 'TTD Autofill - Test' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'payment_not_completed');
  assert.match(res.body.message, /did not complete/i);
  assert.match(res.body.message, /charged/i);
});

test('a used slot on an expired pass points at a new pass', async (t) => {
  const key = 'EXPIRED-SLOT-KEY-1234';
  const licenseKeyId = 'lic_expired_slot';
  const instanceId = 'lki_expired_slot';
  const license = licenseRecord({
    key,
    licenseKeyId,
    overrides: { expires_at: new Date(Date.now() - 2 * 86400_000).toISOString() }
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/licenses/activate') return jsonResponse({ code: 'LICENSE_KEY_LIMIT_REACHED' }, 409);
    if (path === '/license_keys') return jsonResponse({ items: [license] });
    if (path === '/license_key_instances') {
      return jsonResponse({
        items: [{
          id: instanceId,
          license_key_id: licenseKeyId,
          name: `TTD Autofill - Test ${INSTANCE_REF_PREFIX}${diagnosticRef('installation_uuid', INSTALLATION)}`,
          created_at: new Date(Date.now() - 9 * 86400_000).toISOString()
        }]
      });
    }
    if (path === '/licenses/validate') return jsonResponse({ valid: true });
    if (path === '/license_key_instances/' + instanceId) return jsonResponse({ id: instanceId, license_key_id: licenseKeyId });
    if (path === '/license_keys/' + licenseKeyId) return jsonResponse(license);
    throw new Error('unexpected request ' + path);
  });

  const res = response();
  await activateHandler(request({ license_key: key, installation_uuid: INSTALLATION, device_label: 'TTD Autofill - Test' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'licence_expired');
  assert.match(res.body.message, /expired/i);
});
