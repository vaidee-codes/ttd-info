import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../pass/success.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'success page inline activation script exists');
const EXTENSION = 'piiegkjdfbbakjmjdckgdjbbohfjfolg';

async function runSuccessPage(query, replies = [], { extensionPresent = true } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      id, style: {}, textContent: '', className: '', listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }
    });
    return elements.get(id);
  };
  const sends = [];
  const replaced = [];
  const runtime = extensionPresent ? {
    lastError: null,
    sendMessage(id, message, callback) {
      sends.push({ id, message });
      callback(replies[sends.length - 1] || { ok: false, error: 'extension_unreachable' });
    }
  } : null;
  const location = { search: query, pathname: '/pass/success', hash: '', href: 'https://ttd-info.vercel.app/pass/success' + query };
  const context = {
    URLSearchParams, location,
    history: { replaceState(_state, _title, url) { replaced.push(url); } },
    document: { getElementById: element },
    window: { chrome: runtime ? { runtime } : undefined },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: (fn) => { fn(); return 1; },
    Promise
  };
  vm.runInNewContext(script, context, { filename: 'pass/success.html' });
  for (let index = 0; index < 20; index++) await Promise.resolve();
  return { element, sends, replaced };
}

test('successful payment hands a key to the extension and clears the redirect query', async () => {
  const page = await runSuccessPage('?status=succeeded&license_key=QA-KEY&extension_id=' + EXTENSION + '&plan=7d', [{ ok: true }]);
  assert.equal(page.element('heading').textContent, 'Your pass is ready');
  assert.equal(page.element('license-card').style.display, 'block');
  assert.equal(page.element('pass-duration').textContent, '7 days');
  assert.equal(page.sends.length, 1);
  assert.equal(page.sends[0].id, EXTENSION);
  assert.deepEqual(JSON.parse(JSON.stringify(page.sends[0].message)), { type: 'TTDAF_LICENSE', license_key: 'QA-KEY' });
  assert.match(page.element('activation-status').textContent, /Activated on this browser/);
  assert.deepEqual(page.replaced, ['/pass/success']);
});

test('pending payment and missing key never hand off a key', async () => {
  for (const [query, heading, card] of [
    ['?status=processing&license_key=QA-KEY', 'Payment not confirmed', 'error-card'],
    ['?status=succeeded', 'Payment received', 'waiting-card']
  ]) {
    const page = await runSuccessPage(query);
    assert.equal(page.element('heading').textContent, heading);
    assert.equal(page.element(card).style.display, 'block');
    assert.equal(page.sends.length, 0);
  }
});

test('missing extension offers manual copy; transient handoff retries', async () => {
  const absent = await runSuccessPage('?status=succeeded&license_key=QA-KEY', [], { extensionPresent: false });
  assert.match(absent.element('activation-status').textContent, /copy your key/i);
  assert.equal(absent.sends.length, 0);

  const recovered = await runSuccessPage('?status=succeeded&license_key=QA-KEY', [
    { ok: false, error: 'extension_unreachable' }, { ok: true }
  ]);
  assert.equal(recovered.sends.length, 2);
  assert.match(recovered.element('activation-status').textContent, /Activated on this browser/);
});

test('a spent slot is final and directs the customer to support without retrying', async () => {
  const page = await runSuccessPage('?status=succeeded&license_key=QA-KEY', [
    { ok: false, error: 'activation_in_use' }
  ]);
  assert.equal(page.sends.length, 1);
  assert.match(page.element('activation-status').textContent, /already activated in another browser/i);
  assert.match(page.element('activation-status').textContent, /Email ttdautofill@gmail.com/);
});

test('a provider explanation is shown when activation fails', async () => {
  const page = await runSuccessPage('?status=succeeded&license_key=QA-KEY', [
    { ok: false, error: 'licence_inactive', message: 'Use the key from your latest purchase.' }
  ]);
  assert.equal(page.sends.length, 1);
  assert.match(page.element('activation-status').textContent, /latest purchase/);
});
