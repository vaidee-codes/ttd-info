import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../pass/success.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'success page inline activation script exists');
const EXTENSION = 'piiegkjdfbbakjmjdckgdjbbohfjfolg';

async function runSuccessPage(query, replies = [], { extensionPresent = true, session = null, fetch = undefined } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      id, style: {}, textContent: '', className: '', listeners: {}, hidden: id === 'survey-detail' || id === 'survey-done', elements: {},
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
    sessionStorage: session ? { getItem: (k) => session[k] ?? null, setItem: (k, v) => { session[k] = String(v); }, removeItem: (k) => { delete session[k]; } } : undefined,
    fetch,
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
  const absent = await runSuccessPage('?status=succeeded&license_key=QA-KEY&extension_id=' + EXTENSION, [], { extensionPresent: false });
  assert.match(absent.element('activation-status').textContent, /copy your key/i);
  assert.equal(absent.sends.length, 0);

  const recovered = await runSuccessPage('?status=succeeded&license_key=QA-KEY&extension_id=' + EXTENSION, [
    { ok: false, error: 'extension_unreachable' }, { ok: true }
  ]);
  assert.equal(recovered.sends.length, 2);
  assert.match(recovered.element('activation-status').textContent, /Activated on this browser/);
});

test('a spent slot is final and directs the customer to support without retrying', async () => {
  const page = await runSuccessPage('?status=succeeded&license_key=QA-KEY&extension_id=' + EXTENSION, [
    { ok: false, error: 'activation_in_use' }
  ]);
  assert.equal(page.sends.length, 1);
  assert.match(page.element('activation-status').textContent, /already activated in another browser/i);
  assert.match(page.element('activation-status').textContent, /Email ttdautofill@gmail.com/);
});

test('a provider explanation is shown when activation fails', async () => {
  const page = await runSuccessPage('?status=succeeded&license_key=QA-KEY&extension_id=' + EXTENSION, [
    { ok: false, error: 'licence_inactive', message: 'Use the key from your latest purchase.' }
  ]);
  assert.equal(page.sends.length, 1);
  assert.match(page.element('activation-status').textContent, /latest purchase/);
});

test('activation not requested (checkbox unticked): the key is shown but never sent to the extension', async () => {
  const page = await runSuccessPage('?status=succeeded&license_key=QA-KEY&plan=30d', [{ ok: true }]);
  assert.equal(page.element('heading').textContent, 'Your pass is ready');
  assert.equal(page.element('license-card').style.display, 'block');
  assert.equal(page.sends.length, 0, 'nothing sent to the extension');
  assert.match(page.element('activation-status').textContent, /paste it into the extension/);
});

test('optional questions appear only for a purchase this tab paid for, and post with its token', async () => {
  const plain = await runSuccessPage('?status=succeeded&license_key=QA-KEY');
  assert.notEqual(plain.element('survey-card').style.display, 'block', 'no token: no questions');

  const session = { ttdafPurchase: JSON.stringify({ status: 'succeeded', license_key: 'QA-KEY', plan: '7d', razorpay_order_id: 'ttd_abc', purchase_token: 'T'.repeat(43) }) };
  const posts = [];
  const page = await runSuccessPage('', [], { session, fetch: async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ ok: true }) }; } });
  assert.equal(page.element('survey-card').style.display, 'block');

  const form = page.element('survey-form');
  form.elements = { other_temple: { value: '  Srisailam  ' }, heard_from: { value: 'other' } };
  form.listeners.change();
  assert.equal(page.element('survey-detail').hidden, false, 'Other shows the detail box');
  page.element('survey-detail').value = 'Temple forum';

  // Nothing answered: a gentle note, nothing sent.
  form.elements.other_temple.value = '';
  form.elements.heard_from.value = '';
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(posts.length, 0);
  assert.equal(page.element('survey-error').hidden, false);

  form.elements.other_temple.value = '  Srisailam  ';
  form.elements.heard_from.value = 'other';
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/purchase-feedback');
  assert.deepEqual(posts[0].body, { razorpay_order_id: 'ttd_abc', purchase_token: 'T'.repeat(43), other_temple: 'Srisailam', heard_from: 'other', heard_from_detail: 'Temple forum' });
  assert.equal(page.element('survey-form').hidden, true);
  assert.equal(page.element('survey-done').hidden, false);
  assert.equal(session['ttdafFeedback:ttd_abc'], '1');

  const again = await runSuccessPage('', [], { session });
  assert.notEqual(again.element('survey-card').style.display, 'block', 'answered once per order per tab');
});
