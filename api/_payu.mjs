import { createHash, timingSafeEqual } from 'node:crypto';
import { ProviderConfigurationError, ProviderError } from './_dodo.mjs';

const REQUEST_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 64 * 1024;
const HOSTS = {
  test: { pay: 'https://test.payu.in/_payment', api: 'https://test.payu.in/merchant/postservice.php?form=2', bolt: 'https://jssdk-uat.payu.in/bolt/bolt.min.js' },
  production: { pay: 'https://secure.payu.in/_payment', api: 'https://info.payu.in/merchant/postservice.php?form=2', bolt: 'https://jssdk.payu.in/bolt/bolt.min.js' }
};

// Test unless PAYU_MODE is exactly "production": a test key can never be
// pointed at production by accident, and the reverse needs an explicit switch.
export function payuConfig() {
  const key = String(process.env.PAYU_MERCHANT_KEY || '').trim();
  const salt = String(process.env.PAYU_MERCHANT_SALT || '').trim();
  if (!key || !salt) throw new ProviderConfigurationError();
  const live = String(process.env.PAYU_MODE || '').trim().toLowerCase() === 'production';
  return { key, salt, live, hosts: live ? HOSTS.production : HOSTS.test };
}

function sha512(value) {
  return createHash('sha512').update(value, 'utf8').digest('hex');
}

// PayU takes rupees with two decimals; we store paise.
export function payuAmount(amountPaise) {
  return (Number(amountPaise) / 100).toFixed(2);
}

// Request hash: sha512(key|txnid|amount|productinfo|firstname|email|udf1..udf5||||||SALT).
export function payuRequestHash(fields, salt) {
  const udf = [1, 2, 3, 4, 5].map((n) => fields['udf' + n] || '');
  return sha512([fields.key, fields.txnid, fields.amount, fields.productinfo, fields.firstname, fields.email, ...udf, '', '', '', '', '', salt].join('|'));
}

// Response (redirect/webhook) hash, the request fields in reverse with the status:
// sha512([additionalCharges|]SALT|status||||||udf5..udf1|email|firstname|productinfo|amount|txnid|key).
export function payuResponseHash(fields, salt) {
  const udf = [5, 4, 3, 2, 1].map((n) => fields['udf' + n] || '');
  const parts = [salt, fields.status, '', '', '', '', '', ...udf, fields.email, fields.firstname, fields.productinfo, fields.amount, fields.txnid, fields.key];
  if (fields.additionalCharges) parts.unshift(fields.additionalCharges);
  return sha512(parts.map((p) => p == null ? '' : String(p)).join('|'));
}

// The hosted-checkout form the pass page posts to PayU. The same signed fields
// open PayU's in-page checkout (Checkout Plus, bolt.launch) from the `bolt`
// script. The salt never leaves the server; the hash only proves these exact
// fields came from us.
export function payuCheckoutForm({ txnid, amountPaise, productinfo, email, phone, surl, furl }) {
  const { key, salt, hosts } = payuConfig();
  const fields = { key, txnid, amount: payuAmount(amountPaise), productinfo, firstname: 'Customer', email, phone, surl, furl };
  return { action: hosts.pay, bolt: hosts.bolt, fields: { ...fields, hash: payuRequestHash(fields, salt) } };
}

export function verifyPayUResponse(fields) {
  if (!fields || !fields.hash) return false;
  let salt;
  let key;
  try {
    ({ key, salt } = payuConfig());
  } catch {
    return false;
  }
  if (String(fields.key || '') !== key) return false;
  const a = Buffer.from(payuResponseHash(fields, salt), 'utf8');
  const b = Buffer.from(String(fields.hash).trim().toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// verify_payment for one or more txnids ("a|b|c"), keyed by txnid in the reply.
// A txnid PayU has never seen comes back with status "Not Found".
export async function verifyPayUTransactions(txnids) {
  const { key, salt, hosts } = payuConfig();
  const var1 = txnids.join('|');
  const command = 'verify_payment';
  let response;
  try {
    response = await fetch(hosts.api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ key, command, var1, hash: sha512([key, command, var1, salt].join('|')) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new ProviderError(503);
  }
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new ProviderError(response.status, 'PAYU_VERIFY');
  // A cut-off body is "try again", not "unpaid".
  if (!json || typeof json !== 'object') throw new ProviderError(502, 'INVALID_RESPONSE');
  return json.transaction_details && typeof json.transaction_details === 'object' ? json.transaction_details : {};
}

// A payment counts only when PayU's verify API reports it a success for this
// exact amount. The browser redirect and the webhook are never proof of payment.
export function payuTransactionMatches(txn, order) {
  return !!txn && String(txn.status).toLowerCase() === 'success'
    && Math.round(Number(txn.amt || txn.transaction_amount) * 100) === Number(order.amount_paise);
}

const PAYU_METHODS = { UPI: 'UPI', CC: 'Card', DC: 'Card', NB: 'Netbanking', CASH: 'Wallet', EMI: 'EMI', BNPL: 'Pay later' };
export function payuMethodLabel(txn) {
  return PAYU_METHODS[String(txn && txn.mode || '').toUpperCase()] || null;
}

// PayU posts application/x-www-form-urlencoded. Vercel usually parses it into
// an object already; a raw body or stream is parsed here.
export async function payuFormBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw;
  if (Buffer.isBuffer(req.body)) raw = req.body;
  else if (typeof req.body === 'string') raw = Buffer.from(req.body, 'utf8');
  else {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error('too large'), { status: 413 });
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks);
  }
  return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
}
