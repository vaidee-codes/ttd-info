import assert from 'node:assert/strict';
import test from 'node:test';

import { diagnosticRef, logProviderFailure, logRateLimitTriggered } from '../api/_diagnostics.mjs';
import { enforceHashedKeyRateLimit } from '../api/_rate-limit.mjs';

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
    }
  };
}

function request() {
  return {
    headers: {
      host: 'ttd-info.vercel.app',
      'x-forwarded-for': '203.0.113.10',
      'x-real-ip': '203.0.113.10'
    }
  };
}

test('diagnostic references are stable HMACs and never contain raw identifiers', () => {
  process.env.TTDAF_LOG_CORRELATION_SECRET = 'test-correlation-secret';
  const first = diagnosticRef('dodo_license_id', 'lic_private_123');
  const second = diagnosticRef('dodo_license_id', 'lic_private_123');
  const otherKind = diagnosticRef('dodo_instance_id', 'lic_private_123');
  assert.match(first, /^[0-9a-f]{20}$/);
  assert.equal(first, second);
  assert.notEqual(first, otherKind);
  assert.doesNotMatch(first, /lic_private/);
});

test('provider failure logs contain correlation references but no raw customer data', (t) => {
  process.env.TTDAF_LOG_CORRELATION_SECRET = 'test-correlation-secret';
  const messages = [];
  t.mock.method(console, 'error', (message) => messages.push(String(message)));
  logProviderFailure('license_refresh', { status: 429, code: 'TOO_MANY_REQUESTS' }, {
    licenseKeyId: 'lic_private_123',
    instanceId: 'lki_private_456',
    installationUuid: '22222222-2222-4222-8222-222222222222',
    customerEmail: 'private@example.com'
  });
  const entry = JSON.parse(messages.at(-1));
  assert.equal(entry.event, 'provider_failure');
  assert.equal(entry.operation, 'license_refresh');
  assert.equal(entry.status, 429);
  assert.match(entry.license_ref, /^[0-9a-f]{20}$/);
  assert.match(entry.instance_ref, /^[0-9a-f]{20}$/);
  assert.match(entry.installation_ref, /^[0-9a-f]{20}$/);
  assert.equal(entry.correlation_configured, true);
  assert.doesNotMatch(messages.at(-1), /lic_private|lki_private|22222222|private@example/);
});

test('rate-limit logs are emitted only on rejection and contain no raw licence key', (t) => {
  process.env.TTDAF_LOG_CORRELATION_SECRET = 'test-correlation-secret';
  const messages = [];
  t.mock.method(console, 'warn', (message) => messages.push(String(message)));
  logRateLimitTriggered('LICENCE-SECRET-123');
  const entry = JSON.parse(messages.at(-1));
  assert.equal(entry.event, 'rate_limit_triggered');
  assert.equal(entry.scope, 'hashed_license_key');
  assert.match(entry.license_key_ref, /^[0-9a-f]{20}$/);
  assert.doesNotMatch(messages.at(-1), /LICENCE-SECRET-123/);
});

test('missing Vercel rate-limit configuration fails closed', async (t) => {
  process.env.VERCEL = '1';
  process.env.NODE_ENV = 'production';
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  const res = response();
  const allowed = await enforceHashedKeyRateLimit(request(), res, 'LICENCE-SECRET-123');
  assert.equal(allowed, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'temporarily_unavailable');
});

test('configured Vercel rate limit allows normal traffic and rejects excess traffic', async (t) => {
  process.env.VERCEL = '1';
  process.env.NODE_ENV = 'production';
  t.mock.method(console, 'error', () => {});
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(String(message)));
  const responses = [204, 429];
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: responses.shift() }));

  const normal = response();
  assert.equal(await enforceHashedKeyRateLimit(request(), normal, 'LICENCE-SECRET-123'), true);
  assert.equal(normal.statusCode, 200);

  const limited = response();
  assert.equal(await enforceHashedKeyRateLimit(request(), limited, 'LICENCE-SECRET-123'), false);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal(limited.body.error, 'rate_limited');
  assert.equal(JSON.parse(warnings.at(-1)).event, 'rate_limit_triggered');
});
