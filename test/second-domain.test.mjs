import assert from 'node:assert/strict';
import test from 'node:test';

delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
delete process.env.VERCEL_PROJECT_PRODUCTION_URL;

const { allowedOrigins, beginRequest, originAllowed, siteOriginFor, CANONICAL_ORIGIN } = await import('../api/_http.mjs');

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

test('a Firefox install origin is allowed and lookalikes are not', () => {
  const firefox = 'moz-extension://3e4f5a6b-1111-4222-8333-abcdefabcdef';
  assert.equal(originAllowed(firefox), true);
  assert.equal(originAllowed('chrome-extension://piiegkjdfbbakjmjdckgdjbbohfjfolg'), true);
  assert.equal(originAllowed('moz-extension://not-a-uuid'), false);
  assert.equal(originAllowed('moz-extension://3e4f5a6b-1111-4222-8333-abcdefabcdef.evil.example'), false);
  assert.equal(originAllowed('chrome-extension://someoneelse'), false);

  const headers = {};
  const res = {
    setHeader(name, value) { headers[name] = value; },
    status() { return this; },
    json() { return this; },
    end() { return this; }
  };
  assert.equal(beginRequest({ method: 'POST', headers: { origin: firefox } }, res, ['POST']), true);
  assert.equal(headers['Access-Control-Allow-Origin'], firefox);
});

test('anything else falls back to the canonical origin', () => {
  assert.equal(siteOriginFor(req('https://evil.example')), CANONICAL_ORIGIN);
  assert.equal(siteOriginFor(req('chrome-extension://piiegkjdfbbakjmjdckgdjbbohfjfolg')), CANONICAL_ORIGIN);
  assert.equal(siteOriginFor(req()), CANONICAL_ORIGIN);
});
