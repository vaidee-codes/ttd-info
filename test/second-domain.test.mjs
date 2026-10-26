import assert from 'node:assert/strict';
import test from 'node:test';

delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
delete process.env.VERCEL_PROJECT_PRODUCTION_URL;

const { allowedOrigins, siteOriginFor, CANONICAL_ORIGIN } = await import('../api/_http.mjs');

const req = (origin) => ({ headers: origin === undefined ? {} : { origin } });

test('both site domains are allowed origins', () => {
  const allowed = allowedOrigins();
  assert.ok(allowed.has('https://ttd-info.vercel.app'));
  assert.ok(allowed.has('https://ttd-autofill.com'));
  assert.equal(allowed.has('https://www.ttd-autofill.com'), false);
  assert.equal(allowed.has('https://ttd-autofill.com.evil.example'), false);
});

test('checkout returns buyers to the site domain they came from', () => {
  assert.equal(siteOriginFor(req('https://ttd-autofill.com')), 'https://ttd-autofill.com');
  assert.equal(siteOriginFor(req('https://ttd-info.vercel.app')), 'https://ttd-info.vercel.app');
});

test('anything else falls back to the canonical origin', () => {
  assert.equal(siteOriginFor(req('https://evil.example')), CANONICAL_ORIGIN);
  assert.equal(siteOriginFor(req('chrome-extension://piiegkjdfbbakjmjdckgdjbbohfjfolg')), CANONICAL_ORIGIN);
  assert.equal(siteOriginFor(req()), CANONICAL_ORIGIN);
});
